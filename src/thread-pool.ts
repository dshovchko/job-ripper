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

import type {EventLoopUtilization} from 'node:perf_hooks';

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
 */
export class ThreadPool extends EventEmitter {
  /** Effective concurrency (number of workers). */
  public readonly concurrency: number;

  private workers: Worker[] = [];
  /** Stack of indices into {@link workers} that are currently idle. */
  private freeWorkers: number[] = [];
  /** Task currently running on each worker, indexed by worker index (`undefined` when idle). */
  private currentTasks: (Task | undefined)[] = [];
  private taskQueue = new FastQueue<Task>();
  private isDestroyed = false;

  private maxQueueSize: number;
  private userWorkerPath: string;
  private workerArgs: string[];

  private capacityWaiters = new FastQueue<{resolve: () => void, reject: (err: Error) => void}>();
  private pendingEnqueues = 0;
  private terminationPromise: Promise<void> | null = null;

  /** ELU baseline snapshots captured at pool creation (one per worker). */
  private eluBaselines: EventLoopUtilization[];

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

      worker.on('message', (msg) => this.handleMessage(i, msg));
      worker.on('error', (err: Error) => this.handleError(err));
      worker.on('exit', (code) => {
        if (code !== 0 && !this.isDestroyed) {
          this.handleError(new Error(`Worker stopped with exit code ${code}`));
        }
      });

      this.workers.push(worker);
      this.freeWorkers.push(i);
      this.currentTasks.push(undefined);
    }

    // Capture ELU baselines after all workers are spawned
    this.eluBaselines = this.workers.map((w) => w.performance.eventLoopUtilization());
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
      const task: Task = {filePath, resolve, reject};
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
   * Also wakes up producers that are blocked on queue capacity.
   */
  private pump(): void {
    while (!this.isDestroyed && this.freeWorkers.length > 0 && this.taskQueue.size > 0) {
      const index = this.freeWorkers.pop()!;
      const task = this.taskQueue.dequeue()!;

      this.currentTasks[index] = task;
      this.workers[index].postMessage({type: 'task', filePath: task.filePath});

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
   * @param index - Index of the worker that sent the message.
   * @param msg - The structured message payload.
   */
  private handleMessage(index: number, msg: any): void {
    switch (msg.type) {
      case 'task_done': {
        this.finishTask(index, (task) => task.resolve(msg.result));
        break;
      }

      case 'task_error': {
        this.finishTask(index, (task) => task.reject(this.parseWorkerError(msg, 'Task failed')));
        break;
      }

      case 'ready':
        // Worker ready, pump if we have tasks
        this.pump();
        break;

      case 'fatal': {
        this.handleError(this.parseWorkerError(msg, 'Fatal worker error'));
        break;
      }
    }
  }

  /**
   * Completes a task, frees its worker, and re-enters the pump loop.
   *
   * @param index - Index of the worker that finished the task.
   * @param resolver - Callback that settles the task's promise (resolve or reject).
   */
  private finishTask(index: number, resolver: (task: Task) => void): void {
    const task = this.currentTasks[index]!;
    this.currentTasks[index] = undefined;
    this.freeWorkers.push(index);

    // Feed the just-freed worker before settling the completed promise so the
    // worker thread never idles while main-thread continuations run.
    this.pump();
    resolver(task);
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
    const promises = this.workers.map((w, i) => {
      const task = this.currentTasks[i];
      if (task) task.reject(err);
      return w.terminate();
    });
    this.terminationPromise = Promise.all(promises).then(() => {});
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  }

  /**
   * Collects worker utilization metrics.
   *
   * Must be called **before** `close()` — once workers are terminated
   * their performance data is no longer accessible.
   *
   * @returns Per-worker metrics and summary.
   */
  collectMetrics(): {
    workers: {utilization: number}[];
    summary: {avgUtilization: number, minUtilization: number, maxUtilization: number, spread: number};
  } {
    const workerMetrics = this.workers.map((w, i) => {
      const elu = w.performance.eventLoopUtilization(this.eluBaselines[i]);
      return {utilization: elu.utilization};
    });

    const utils = workerMetrics.map((m) => m.utilization);
    const minUtilization = Math.min(...utils);
    const maxUtilization = Math.max(...utils);

    return {
      workers: workerMetrics,
      summary: {
        avgUtilization: utils.reduce((a, b) => a + b, 0) / utils.length,
        minUtilization,
        maxUtilization,
        spread: maxUtilization - minUtilization
      }
    };
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
    const promises = this.workers.map((w, i) => {
      const task = this.currentTasks[i];
      if (task) {
        task.reject(error);
      }
      return w.terminate();
    });

    this.terminationPromise = Promise.all(promises).then(() => {});
    await this.terminationPromise;
  }
}
