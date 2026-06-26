/**
 * @packageDocumentation
 *
 * Public API of `job-ripper`.
 *
 * Exposes {@link processFiles} — the main function that fans out work
 * across a pool of worker threads and collects results.
 */
import {resolve} from 'node:path';
import {ThreadPool, calcConcurrency} from './thread-pool.js';

/**
 * Mutable holder for a fatal error emitted by the thread pool.
 *
 * Shared by reference so that in-flight task promises can check
 * whether the pool itself has failed.
 */
interface FatalPoolErrorState {
  /** The fatal error, if one has occurred. */
  current?: Error;
}

/** Pair of callbacks invoked after each task settles. */
interface TaskHandlers {
  /** Called when a worker finishes a file successfully, with the worker's return value. */
  onSuccess: (filePath: string, result?: unknown) => void;
  /** Called when a worker fails to process a file. */
  onTaskError: (filePath: string, error: Error) => void;
}

/**
 * Configuration accepted by {@link processFiles}.
 */
export interface ProcessOptions {
  /** File paths to process — an array, sync iterable, or async iterable. */
  files: string[] | AsyncIterable<string> | Iterable<string>;
  /** Absolute or relative path to the worker script. */
  workerPath: string;
  /** Maximum number of concurrent worker threads (defaults to 75 % of CPUs). */
  concurrency?: number;
  /** Extra arguments forwarded to every worker thread. */
  workerArgs?: string[];
  /** When `true`, files are resolved and counted but no workers are spawned. */
  dryRun?: boolean;
  /** Called after a file is processed successfully. Receives the file path and the worker's return value. */
  onSuccess?: (filePath: string, result?: unknown) => void;
  /** Called when a worker fails to process a file. */
  onTaskError?: (filePath: string, error: Error) => void;
}

/**
 * Per-worker utilization metrics.
 */
export interface WorkerMetrics {
  /** Event loop utilization (0–1): fraction of time the worker's event loop was active. */
  utilization: number;
}

/**
 * Aggregated pool metrics collected after the run completes.
 */
export interface PoolMetrics {
  /** Per-worker metrics (indexed by worker spawn order). */
  workers: WorkerMetrics[];
  /** Summary statistics across all workers. */
  summary: {
    avgUtilization: number;
    minUtilization: number;
    maxUtilization: number;
    /** Difference between max and min utilization (0–1). */
    spread: number;
  };
}

/**
 * Summary returned by {@link processFiles} after all work is done.
 */
export interface ProcessResult {
  /** Total number of files that entered the pipeline. */
  total: number;
  /** Number of files processed successfully. */
  success: number;
  /** Number of files whose workers threw an error. */
  failed: number;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: number;
  /** Actual concurrency level that was used. */
  concurrency: number;
  /** Worker utilization metrics. */
  metrics: PoolMetrics;
}

/**
 * Returns a promise that rejects when the pool emits a fatal `'error'` event.
 *
 * Used to race against normal iteration so that a pool-level failure
 * (e.g. worker file not found) is surfaced immediately.
 *
 * @param pool - The thread pool to monitor.
 * @param setFatalPoolError - Callback that stores the error for later checks.
 * @returns A promise that never resolves — it only rejects.
 */
function createPoolErrorPromise(pool: ThreadPool, setFatalPoolError: (err: Error) => void): Promise<never> {
  return new Promise<never>((_, reject) => {
    pool.once('error', (err: Error) => {
      setFatalPoolError(err);
      reject(err);
    });
  });
}

/**
 * Type guard that checks whether `err` is the same object as the
 * recorded fatal pool error, distinguishing pool-level failures
 * from per-task errors.
 *
 * @param err - The caught error.
 * @param fatalPoolError - The stored fatal error, if any.
 * @returns `true` when `err` is the fatal pool error.
 */
function isFatalPoolError(err: unknown, fatalPoolError?: Error): err is Error {
  return Boolean(fatalPoolError && err === fatalPoolError);
}

/**
 * Dispatches a single file to the pool and wires up success/error handlers.
 *
 * If the rejection is a fatal pool error it is re-thrown to abort
 * the entire run; otherwise it is forwarded to {@link TaskHandlers.onTaskError}.
 *
 * @param pool - The thread pool.
 * @param filePath - Absolute path of the file to process.
 * @param handlers - Success/error callbacks.
 * @param fatalPoolErrorState - Shared fatal-error holder.
 * @returns A promise that settles once the task completes or fails.
 */
function createTaskPromise(
  pool: ThreadPool,
  filePath: string,
  handlers: TaskHandlers,
  fatalPoolErrorState: FatalPoolErrorState
): Promise<void> {
  return pool.execute(filePath).then(
    (result: unknown) => {
      handlers.onSuccess(filePath, result);
    },
    (err: unknown) => {
      const fatalPoolError = fatalPoolErrorState.current;
      if (isFatalPoolError(err, fatalPoolError)) {
        throw err;
      }

      handlers.onTaskError(filePath, err instanceof Error ? err : new Error(String(err)));
    }
  );
}

/**
 * Context shared with {@link runDispatchLoop}.
 */
interface DispatchContext {
  /** The thread pool tasks are dispatched to. */
  pool: ThreadPool;
  /** The raw file source (array, sync iterable, or async iterable). */
  files: ProcessOptions['files'];
  /** Success/error callbacks. */
  handlers: TaskHandlers;
  /** Shared fatal-error holder. */
  fatalErr: FatalPoolErrorState;
  /** Promise that rejects on a fatal pool error. */
  poolErr: Promise<never>;
}

/**
 * Per-file operations shared by the sync and async producer loops.
 */
interface DispatchOps {
  /** Promise that rejects on a fatal pool error. */
  poolErr: Promise<never>;
  /** Dispatches one file to the pool and arms its back-pressure release. */
  dispatch: (filePath: string) => void;
  /** Awaits a free slot when the pool is saturated. */
  throttle: () => Promise<void>;
  /** Throws synchronously if the pool has emitted a fatal error. */
  checkFatal: () => void;
}

/**
 * Type guard: `true` when `files` is an async iterable.
 *
 * Lets the producer use the source's native iterator directly instead
 * of re-wrapping every source in an `async function*` (which adds a
 * microtask hop per file — doubling it for sources that are already
 * async iterators).
 *
 * @param files - The file source.
 * @returns `true` if `files` exposes `Symbol.asyncIterator`.
 */
function isAsyncIterable(files: ProcessOptions['files']): files is AsyncIterable<string> {
  return typeof (files as AsyncIterable<string>)[Symbol.asyncIterator] === 'function';
}

/**
 * Back-pressure gate providing O(1) coordination between the producer
 * and the in-flight tasks.
 */
interface BackpressureGate {
  /** Records that a task has been dispatched. */
  add: () => void;
  /** Marks a task as settled; wakes a blocked producer or drain waiter. */
  release: () => void;
  /** Returns a promise that resolves when a slot frees, or `null` if one is already free. */
  acquire: () => Promise<unknown> | null;
  /** Returns a promise that resolves when all tasks drain, or `null` if none are in flight. */
  drain: () => Promise<unknown> | null;
}

/**
 * Creates an {@link BackpressureGate}.
 *
 * Tracks in-flight count with a single counter and a lone reusable
 * "slot freed" / "drained" signal, instead of racing over the whole set
 * of in-flight promises on every file (which scaled with concurrency).
 *
 * @param limit - Maximum number of concurrently in-flight tasks.
 * @param poolErr - Promise that rejects on a fatal pool error.
 * @returns A gate the producer loop uses to apply back-pressure.
 */
function createBackpressureGate(limit: number, poolErr: Promise<never>): BackpressureGate {
  let inFlight = 0;
  let onSlotFree: (() => void) | null = null;
  let onDrained: (() => void) | null = null;

  return {
    add: (): void => {
      inFlight++;
    },
    release: (): void => {
      inFlight--;
      const wake = onSlotFree;
      onSlotFree = null;
      if (wake) wake();
      if (inFlight === 0) {
        const done = onDrained;
        onDrained = null;
        if (done) done();
      }
    },
    acquire: (): Promise<unknown> | null => {
      if (inFlight < limit) return null;
      return Promise.race([new Promise<void>((r) => void (onSlotFree = r)), poolErr]);
    },
    drain: (): Promise<unknown> | null => {
      if (inFlight === 0) return null;
      return Promise.race([new Promise<void>((r) => void (onDrained = r)), poolErr]);
    }
  };
}

/**
 * Producer loop for async file sources.
 *
 * Pulls from the source's native async iterator (racing a fatal pool
 * error so a dead pool wakes a pending pull) and applies back-pressure.
 *
 * @param iterator - The source's native async iterator.
 * @param ops - Shared per-file dispatch operations.
 * @returns The number of files dispatched.
 */
async function pumpAsyncSource(iterator: AsyncIterator<string>, ops: DispatchOps): Promise<number> {
  let total = 0;
  try {
    while (true) {
      const result = await Promise.race([iterator.next(), ops.poolErr]);
      ops.checkFatal();
      if (result.done) break;
      if (!result.value) continue;
      ops.dispatch(result.value);
      total++;
      await ops.throttle();
    }
  } finally {
    if (typeof iterator.return === 'function') await iterator.return(undefined);
  }
  return total;
}

/**
 * Producer loop for synchronous file sources (arrays, sync iterables).
 *
 * Pulls each path synchronously — no per-file promise or race — and only
 * suspends on back-pressure. A fatal pool error surfaces via the
 * synchronous {@link DispatchOps.checkFatal} check, a synchronous throw
 * from a dispatch to a destroyed pool, or the throttled slot wait.
 *
 * @param iterable - The synchronous file source.
 * @param ops - Shared per-file dispatch operations.
 * @returns The number of files dispatched.
 */
async function pumpSyncSource(iterable: Iterable<string>, ops: DispatchOps): Promise<number> {
  let total = 0;
  for (const value of iterable) {
    ops.checkFatal();
    if (!value) continue;
    ops.dispatch(value);
    total++;
    await ops.throttle();
  }
  return total;
}

/**
 * Drives the producer: pulls files from the source's native iterator,
 * dispatches each one to the pool, and applies O(1) back-pressure via a
 * {@link BackpressureGate}.
 *
 * @param ctx - Pool, file source, handlers and fatal-error plumbing.
 * @returns The total number of files dispatched.
 */
async function runDispatchLoop(ctx: DispatchContext): Promise<number> {
  const {pool, files, handlers, fatalErr, poolErr} = ctx;
  const gate = createBackpressureGate(pool.concurrency, poolErr);

  const checkFatal = (): void => {
    const fatal = fatalErr.current;
    if (fatal) throw fatal;
  };
  const ops: DispatchOps = {
    poolErr,
    dispatch: (filePath: string): void => {
      gate.add();
      createTaskPromise(pool, resolve(filePath), handlers, fatalErr).then(gate.release, gate.release);
    },
    throttle: async (): Promise<void> => {
      const slot = gate.acquire();
      if (slot) {
        await slot;
        checkFatal();
      }
    },
    checkFatal
  };

  const total = isAsyncIterable(files)
    ? await pumpAsyncSource(files[Symbol.asyncIterator](), ops)
    : await pumpSyncSource(files as Iterable<string>, ops);

  const draining = gate.drain();
  if (draining) {
    await draining;
    checkFatal();
  }
  return total;
}

/**
 * Handles the `--dry-run` mode: iterates over files, counts them, and
 * invokes `onSuccess` without spawning any workers.
 *
 * @param options - The process options (only `files` and `onSuccess` are used).
 * @param startTime - Epoch timestamp captured at the start of the run.
 * @returns A {@link ProcessResult} with zero failures.
 */
async function handleDryRun(options: ProcessOptions, startTime: number): Promise<ProcessResult> {
  let total = 0;
  for await (const file of options.files) {
    if (!file) continue;
    total++;
    if (options.onSuccess) options.onSuccess(resolve(file), undefined);
  }
  return {
    total, success: total, failed: 0,
    durationMs: Date.now() - startTime, concurrency: calcConcurrency(options.concurrency),
    metrics: {workers: [], summary: {avgUtilization: 0, minUtilization: 0, maxUtilization: 0, spread: 0}}
  };
}

/**
 * Builds {@link TaskHandlers} that update a shared counter object and
 * forward events to the caller-supplied callbacks.
 *
 * @param options - The process options containing optional callback overrides.
 * @param state - Mutable counters incremented on success/failure.
 * @returns A {@link TaskHandlers} object.
 */
function getTaskHandlers(options: ProcessOptions, state: {success: number, failed: number}): TaskHandlers {
  return {
    onSuccess: (filePath: string, result: unknown): void => {
      state.success++;
      if (options.onSuccess) options.onSuccess(filePath, result);
    },
    onTaskError: (filePath: string, error: Error): void => {
      state.failed++;
      if (options.onTaskError) options.onTaskError(filePath, error);
    }
  };
}

/**
 * Processes files in parallel using a pool of worker threads.
 *
 * Creates a {@link ThreadPool}, iterates over the supplied file source,
 * dispatches each file path to a worker, and collects aggregated
 * results.
 *
 * Back-pressure is applied automatically: once the number of in-flight
 * tasks reaches the concurrency limit the iterator pauses until a slot
 * becomes available.
 *
 * @param options - Configuration describing the files, worker, and
 *   concurrency settings (see {@link ProcessOptions}).
 * @returns A {@link ProcessResult} summarising the run.
 */
export async function processFiles(options: ProcessOptions): Promise<ProcessResult> {
  const startTime = Date.now();
  if (options.dryRun) return handleDryRun(options, startTime);

  const pool = new ThreadPool({
    userWorkerPath: resolve(options.workerPath), concurrency: options.concurrency,
    workerArgs: options.workerArgs
  });
  const fatalErr: FatalPoolErrorState = {};
  const poolErr = createPoolErrorPromise(pool, (err) => {
    fatalErr.current = err;
  });
  poolErr.catch(() => {}); // Prevent UnhandledRejection

  try {
    const stats = {success: 0, failed: 0};
    const handlers = getTaskHandlers(options, stats);

    const total = await runDispatchLoop({pool, files: options.files, handlers, fatalErr, poolErr});

    return {
      total, success: stats.success, failed: stats.failed,
      durationMs: Date.now() - startTime, concurrency: pool.concurrency,
      metrics: pool.collectMetrics()
    };
  } finally {
    await pool.close();
  }
}
