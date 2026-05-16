/**
 * @packageDocumentation
 *
 * Thread pool implementation that manages a fixed number of
 * `worker_threads` and dispatches file-processing tasks to them
 * with back-pressure and graceful shutdown support.
 */
import {Worker} from 'node:worker_threads';
import {EventEmitter} from 'node:events';
import {cpus} from 'node:os';
import {FastQueue} from './fast-queue.js';

/**
 * Configuration for creating a {@link ThreadPool}.
 */
export interface PoolOptions {
  /** Absolute path to the user-supplied worker script. */
  userWorkerPath: string;
  /** Number of worker threads to spawn (defaults to 75 % of available CPUs). */
  concurrency?: number;
  /** Maximum number of tasks allowed in the internal queue before back-pressure is applied (default: 50 000). */
  maxQueue?: number;
  /** Extra arguments forwarded to every worker thread via `workerData`. */
  workerArgs?: string[];
}

/**
 * Internal representation of a queued work item.
 */
interface Task {
  /** Monotonically increasing task identifier. */
  id: number;
  /** Absolute path of the file to be processed by the worker. */
  filePath: string;
  /** Settles the caller's promise on success, optionally with the worker's return value. */
  resolve: (result?: unknown) => void;
  /** Settles the caller's promise on failure. */
  reject: (err: any) => void;
}

/**
 * Resolves a concurrency value.
 *
 * If `val` is provided it is validated as a positive integer and
 * returned as-is. Otherwise the default (75 % of available CPUs,
 * minimum 1) is used.
 *
 * @param val - An explicit concurrency override, or `undefined` for the default.
 * @returns The validated concurrency number.
 * @throws If `val` is not a positive integer.
 */
export function calcConcurrency(val?: number): number {
  if (val !== undefined) {
    if (typeof val !== 'number' || val <= 0 || !Number.isInteger(val)) {
      throw new Error(`Invalid concurrency value: ${val}. Expected a positive integer.`);
    }
    return val;
  }
  return Math.max(1, Math.floor(cpus().length * 0.75));
}

/**
 * A fixed-size pool of `worker_threads` that processes file paths
 * in parallel.
 *
 * Workers are spawned eagerly at construction time. Tasks are
 * dispatched via {@link ThreadPool.execute} and the pool applies
 * back-pressure when the internal queue reaches
 * {@link PoolOptions.maxQueue}.
 *
 * Emits:
 * - `'error'` — when a fatal (non-recoverable) worker error occurs.
 * - `'drained'` — after each task is dispatched to a worker and during shutdown.
 */
export class ThreadPool extends EventEmitter {
  /** Effective concurrency (number of workers). */
  public readonly concurrency: number;

  private workers: Worker[] = [];
  private freeWorkers: Worker[] = [];
  private taskQueue = new FastQueue<Task>();
  private activeTasks = 0;
  private nextTaskId = 0;
  private isDestroyed = false;

  private maxQueueSize: number;
  private userWorkerPath: string;
  private workerArgs: string[];

  private capacityWaiters = new FastQueue<{resolve: () => void, reject: (err: Error) => void}>();
  private pendingEnqueues = 0;
  private terminationPromise: Promise<void> | null = null;

  /**
   * Creates a new thread pool and spawns the worker threads.
   *
   * @param options - Pool configuration (see {@link PoolOptions}).
   */
  constructor(options: PoolOptions) {
    super();
    this.userWorkerPath = options.userWorkerPath;
    this.concurrency = calcConcurrency(options.concurrency);
    this.maxQueueSize = this.calcMaxQueueSize(options.maxQueue);
    this.workerArgs = options.workerArgs || [];

    // Use current file URL's directory to locate the bundled worker-wrapper
    const isTs = import.meta.url.endsWith('.ts');
    const url = new URL(isTs ? './worker-wrapper.ts' : './worker-wrapper.js', import.meta.url);
    // When running from TS source, ensure worker threads can strip type annotations
    const execArgv = isTs && !process.execArgv.includes('--experimental-strip-types')
      ? [...process.execArgv, '--experimental-strip-types']
      : undefined;

    for (let i = 0; i < this.concurrency; i++) {
      const worker = new Worker(url, {
        workerData: {scriptPath: this.userWorkerPath, workerArgs: this.workerArgs},
        ...(execArgv ? {execArgv} : {})
      });

      worker.on('message', (msg) => this.handleMessage(worker, msg));
      worker.on('error', (err: Error) => this.handleError(err));
      worker.on('exit', (code) => {
        if (code !== 0 && !this.isDestroyed) {
          this.handleError(new Error(`Worker stopped with exit code ${code}`));
        }
      });

      this.workers.push(worker);
      this.freeWorkers.push(worker);
    }
  }

  /**
   * Validates and returns the maximum queue size.
   *
   * @param val - An explicit limit, or `undefined` for the default (50 000).
   * @returns The resolved queue limit.
   * @throws If `val` is not a positive integer.
   */
  private calcMaxQueueSize(val?: number): number {
    if (val !== undefined) {
      if (typeof val !== 'number' || val <= 0 || !Number.isInteger(val)) {
        throw new Error(`Invalid maxQueue value: ${val}. Expected a positive integer.`);
      }
      return val;
    }
    return 50000;
  }

  /**
   * Submits a file for processing by a worker thread.
   *
   * The returned promise settles when the worker finishes (resolves)
   * or fails (rejects). If the internal queue is full the call
   * awaits until capacity is available (back-pressure).
   *
   * @param filePath - Absolute path of the file to process.
   * @returns A promise that resolves with the worker's return value, or `undefined` if the worker does not return a value, when the task completes.
   * @throws If the pool has already been destroyed.
   */
  async execute(filePath: string): Promise<unknown> {
    if (this.isDestroyed) throw new Error('ThreadPool closed');

    if (this.taskQueue.size + this.pendingEnqueues >= this.maxQueueSize) {
      let granted = false;
      try {
        await this.waitForQueueCapacity();
        granted = true;
      } finally {
        if (granted) this.pendingEnqueues--;
      }
      if (this.isDestroyed) throw new Error('ThreadPool closed');
    }

    return new Promise<unknown>((resolve, reject) => {
      const task: Task = {id: this.nextTaskId++, filePath, resolve, reject};
      this.taskQueue.enqueue(task);
      this.pump();
    });
  }

  /**
   * Returns a promise that resolves once a slot opens in the task queue.
   *
   * Callers are unblocked one-at-a-time inside {@link pump} to avoid
   * a "thundering herd" when many producers wait simultaneously.
   */
  private async waitForQueueCapacity(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isDestroyed) {
        return reject(new Error('ThreadPool closed'));
      }
      this.capacityWaiters.enqueue({resolve, reject});
    });
  }

  /**
   * Drains the task queue by assigning pending tasks to free workers.
   *
   * Also wakes up producers that are blocked on queue capacity and
   * emits `'drained'` after every dispatch.
   */
  private pump(): void {
    while (!this.isDestroyed && this.freeWorkers.length > 0 && this.taskQueue.size > 0) {
      const worker = this.freeWorkers.pop()!;
      const task = this.taskQueue.dequeue()!;
      this.activeTasks++;

      // Store resolve/reject context mapping per worker
      (worker as any).currentTask = task;

      worker.postMessage({type: 'task', taskId: task.id, filePath: task.filePath});

      // Notify external systems observing drained state
      this.emit('drained');

      // Unblock waiting producers sequentially to prevent "thundering herd"
      let availableSlots = this.maxQueueSize - this.taskQueue.size - this.pendingEnqueues;
      while (this.capacityWaiters.size > 0 && availableSlots > 0) {
        this.pendingEnqueues++;
        this.capacityWaiters.dequeue()!.resolve();
        availableSlots--;
      }
    }
  }

  /**
   * Reconstructs an `Error` object from a serialised worker message.
   *
   * @param msg - The raw message received from the worker.
   * @param defaultMessage - Fallback message if the payload lacks one.
   * @returns A hydrated `Error` with the original name / stack when available.
   */
  private parseWorkerError(msg: any, defaultMessage: string): Error {
    const err = new Error(msg.error?.message || defaultMessage);
    err.name = msg.error?.name || 'Error';
    if (msg.error?.stack) err.stack = msg.error.stack;
    if (msg.error?.isConfigError) (err as any).isConfigError = msg.error.isConfigError;
    return err;
  }

  /**
   * Dispatches incoming worker messages to the appropriate handler.
   *
   * @param worker - The worker that sent the message.
   * @param msg - The structured message payload.
   */
  private handleMessage(worker: Worker, msg: any): void {
    switch (msg.type) {
      case 'ready':
        // Worker ready, pump if we have tasks
        this.pump();
        break;

      case 'fatal': {
        this.handleError(this.parseWorkerError(msg, 'Fatal worker error'));
        break;
      }

      case 'task_done': {
        this.finishTask(worker, (task) => task.resolve(msg.result));
        break;
      }

      case 'task_error': {
        this.finishTask(worker, (task) => task.reject(this.parseWorkerError(msg, 'Task failed')));
        break;
      }
    }
  }

  /**
   * Completes a task, frees its worker, and re-enters the pump loop.
   *
   * @param worker - The worker that finished the task.
   * @param resolver - Callback that settles the task's promise (resolve or reject).
   */
  private finishTask(worker: Worker, resolver: (task: Task) => void): void {
    const task = (worker as any).currentTask as Task;
    (worker as any).currentTask = undefined;
    resolver(task);
    this.activeTasks--;
    this.freeWorkers.push(worker);
    this.pump();
  }

  /**
   * Handles a fatal pool-level error.
   *
   * Marks the pool as destroyed, rejects all queued and in-flight
   * tasks, terminates every worker, and emits `'error'` if there
   * are listeners.
   *
   * @param err - The fatal error.
   */
  private handleError(err: Error): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.emit('drained');

    // Reject anyone waiting for capacity
    while (this.capacityWaiters.size > 0) {
      this.capacityWaiters.dequeue()?.reject(err);
    }

    // Reject any queued tasks
    while (this.taskQueue.size > 0) {
      const t = this.taskQueue.dequeue();
      t?.reject(err);
    }
    // Reject any tasks currently running and terminate workers
    const promises = this.workers.map((w) => {
      const task = (w as any).currentTask as Task | undefined;
      if (task) task.reject(err);
      return w.terminate();
    });
    this.terminationPromise = Promise.all(promises).then(() => {});
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  }

  /**
   * Gracefully shuts down the pool.
   *
   * Rejects all pending and in-flight tasks with a
   * `"ThreadPool closed"` error, terminates every worker, and
   * waits until all workers have exited.
   *
   * Safe to call multiple times — subsequent calls await the
   * same termination promise.
   */
  async close(): Promise<void> {
    if (this.isDestroyed) {
      await this.terminationPromise;
      return;
    }
    this.isDestroyed = true;
    this.emit('drained');

    const error = new Error('ThreadPool closed');

    // Reject anyone waiting for capacity
    while (this.capacityWaiters.size > 0) {
      this.capacityWaiters.dequeue()?.reject(error);
    }

    // Reject any queued tasks
    while (this.taskQueue.size > 0) {
      const t = this.taskQueue.dequeue();
      t?.reject(error);
    }

    // Reject and terminate all workers
    const promises = this.workers.map((w) => {
      const task = (w as any).currentTask;
      if (task) {
        task.reject(error);
      }
      return w.terminate();
    });

    this.terminationPromise = Promise.all(promises).then(() => {});
    await this.terminationPromise;
  }
}
