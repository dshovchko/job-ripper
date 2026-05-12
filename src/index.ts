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
  /** Called when a worker finishes a file successfully. */
  onSuccess: (filePath: string) => void;
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
  /** Called after a file is processed successfully. */
  onSuccess?: (filePath: string) => void;
  /** Called when a worker fails to process a file. */
  onTaskError?: (filePath: string, error: Error) => void;
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
    () => {
      handlers.onSuccess(filePath);
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
 * Adds a task promise to the in-flight set and arranges for it to
 * be removed automatically when it settles.
 *
 * @param inFlightTasks - The set of currently running task promises.
 * @param task - The task promise to track.
 */
function trackTask(inFlightTasks: Set<Promise<void>>, task: Promise<void>): void {
  const trackedTask = task.finally(() => {
    inFlightTasks.delete(trackedTask);
  });
  inFlightTasks.add(trackedTask);
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
    if (options.onSuccess) options.onSuccess(resolve(file));
  }
  return {total, success: total, failed: 0, durationMs: Date.now() - startTime, concurrency: calcConcurrency(options.concurrency)};
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
    onSuccess: (filePath: string): void => {
      state.success++;
      if (options.onSuccess) options.onSuccess(filePath);
    },
    onTaskError: (filePath: string, error: Error): void => {
      state.failed++;
      if (options.onTaskError) options.onTaskError(filePath, error);
    }
  };
}

/**
 * Normalises a sync or async iterable of strings into an async generator.
 *
 * @param files - The file source to normalise.
 * @returns An async generator yielding each file path.
 */
async function* toAsyncIterator(files: Iterable<string> | AsyncIterable<string>): AsyncGenerator<string, void, unknown> {
  for await (const x of files) yield x;
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

  let total = 0;
  const pool = new ThreadPool({userWorkerPath: resolve(options.workerPath), concurrency: options.concurrency, workerArgs: options.workerArgs});
  const inFlightTasks = new Set<Promise<void>>();
  const fatalErr: FatalPoolErrorState = {};
  const poolErr = createPoolErrorPromise(pool, (err) => {
    fatalErr.current = err;
  });
  poolErr.catch(() => {}); // Prevent UnhandledRejection

  try {
    const stats = {success: 0, failed: 0};
    const handlers = getTaskHandlers(options, stats);
    const iterator = toAsyncIterator(options.files)[Symbol.asyncIterator]();

    try {
      while (true) {
        const nextPromise = iterator.next();
        const result = await Promise.race([nextPromise, poolErr]);
        if (fatalErr.current) throw fatalErr.current;
        if (result.done) break;

        if (!result.value) continue;

        trackTask(inFlightTasks, createTaskPromise(pool, resolve(result.value), handlers, fatalErr));
        total++;

        if (inFlightTasks.size >= pool.concurrency) {
          await Promise.race([Promise.race(inFlightTasks), poolErr]);
        }
      }

      if (inFlightTasks.size > 0) {
        await Promise.race([Promise.all(inFlightTasks), poolErr]);
      }
    } finally {
      if (typeof iterator.return === 'function') await iterator.return(undefined);
    }

    return {
      total,
      success: stats.success,
      failed: stats.failed,
      durationMs: Date.now() - startTime,
      concurrency: pool.concurrency
    };
  } finally {
    await pool.close();
  }
}
