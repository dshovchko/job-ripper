/**
 * @packageDocumentation
 *
 * CLI entry point for `job-ripper` (`jori`).
 *
 * Parses command-line arguments, resolves file sources (glob patterns or
 * stdin), and dispatches parallel processing via the {@link processFiles}
 * pipeline.
 */
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {cpus} from 'node:os';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import * as fs from 'node:fs/promises';
import {processFiles} from './index.js';

/** High-resolution timestamp captured at module load, used to measure total wall-clock time. */
const GLOBAL_START = performance.now();

/** Options passed to {@link runProcessing} that control the processing pipeline. */
interface RunOptions {
  /** Async iterable that yields file paths to process. */
  filesStream: AsyncIterable<string>;
  /** Path to the worker script (will be resolved to an absolute path). */
  workerFile: string;
  /** Maximum number of concurrent worker threads. When omitted, the default from {@link processFiles} is used. */
  concurrency?: number;
  /** When `true`, matched files are printed but no workers are spawned. */
  dryRun: boolean;
  /** When `true`, enables per-file status output and detailed statistics. */
  verbose: boolean;
  /** Extra arguments forwarded to every worker (everything after `--`). */
  workerArgs: string[];
  /** Whether to print summary statistics after processing completes. */
  shouldShowStats: boolean;
  /** Whether to print each successfully processed file path to stdout. */
  shouldPrintFiles: boolean;
}

/**
 * Reads non-empty lines from stdin and yields them one at a time.
 *
 * Lines are yielded without trimming so that file paths with intentional
 * leading/trailing whitespace remain valid.
 *
 * @returns An async generator that yields each non-empty line read from stdin.
 */
async function* readLinesFromStdin(): AsyncGenerator<string> {
  const {createInterface} = await import('node:readline');
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  try {
    for await (const line of rl) {
      if (line !== '') {
        // Yielding raw lines without .trim() ensures paths with trailing/leading spaces stay valid
        yield line;
      }
    }
  } catch (err: any) {
    // Ignore internal readline error caused by stream closing while event loop was paused
    if (err.code !== 'ERR_USE_AFTER_CLOSE') throw err;
  }
}

/**
 * Parses a concurrency value from a CLI string.
 *
 * Accepts either an absolute integer (`"4"`) or a CPU-percentage (`"75%"`).
 * Percentages are resolved against the number of available CPU cores and
 * clamped to a minimum of 1.
 *
 * @param val - The raw string value from the `--concurrency` flag.
 * @returns The resolved number of concurrent workers.
 * @throws If `val` is not a valid positive integer or percentage.
 */
function parseConcurrency(val: string): number {
  if (/^\d+%$/.test(val)) {
    const percent = Number.parseInt(val.slice(0, -1), 10);
    if (percent < 1) {
      throw new Error(`Invalid concurrency value: ${val}. Percentage must be greater than 0.`);
    }
    return Math.max(1, Math.floor(cpus().length * (percent / 100)));
  }

  if (/^\d+$/.test(val)) {
    const concurrency = Number.parseInt(val, 10);
    if (concurrency < 1) {
      throw new Error(`Invalid concurrency value: ${val}. Concurrency must be greater than 0.`);
    }
    return concurrency;
  }

  throw new Error(`Invalid concurrency value: ${val}. Expected a positive integer or percentage like "50%".`);
}

/**
 * Yields absolute file paths matching the given glob pattern.
 *
 * If `pattern` points to an existing regular file it is yielded directly
 * without invoking the glob engine. Otherwise, `fs.glob` (Node 22+) is
 * used to expand the pattern.
 *
 * @param pattern - A file path or glob pattern.
 * @returns An async generator that yields absolute paths of matched files.
 */
async function* collectFiles(pattern: string): AsyncGenerator<string> {
  // Check if pattern is a direct file path and avoid globbing if it exists as a file
  try {
    const st = await fs.stat(pattern);
    if (st.isFile()) {
      yield resolve(pattern);
      return;
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
    // ignore missing path and continue to glob
  }

  try {
    // node 22+ fs.glob
    for await (const f of fs.glob(pattern)) {
      yield f;
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/**
 * Prints the CLI usage/help text to stderr and exits with code 1.
 */
function showUsage(): void {
  console.error(`job-ripper (jori) - Rips through CPU-heavy jobs using Node.js worker_threads.

Usage:
  jori <glob> -w <worker> [options] [-- worker_args...]
  <command> | jori -w <worker> [options] [-- worker_args...]

Arguments:
  <glob>                 File glob pattern or path to a single file

Options:
  -w, --worker <path>    Path to the worker script (required)
  -c, --concurrency <N>  Number of workers or CPU percentage (e.g., 4 or 50%, default: 75%)
  -v, --verbose          Print each processed file and detailed statistics
  -s, --silent           Suppress all output except errors
  --dry-run              Print matched files without running workers
  -h, --help             Show this help message

Worker Contract:
  export default async function(filePath) { ... }
  Full docs: https://github.com/dshovchko/job-ripper#worker-contract

Examples:
  # Pipeline — chain workers like Unix pipes
  $ find . -name "*.md" | jori -w compress.js | jori -w upload.js -c 4

  # Glob with CPU-based concurrency
  $ jori "src/**/*.ts" -w compile.js -c 75%

  # Pass arguments to the worker
  $ jori "data/*.json" -w parser.js -c 4 -- --mode=fast --verbose

  # Preview matched files before processing
  $ jori "logs/**/*.log" -w analyze.js --dry-run
`);
  process.exit(1);
}

/**
 * Low-level wrapper around `node:util` {@link parseArgs}.
 *
 * Splits `process.argv` on `--` to separate CLI flags from worker
 * arguments, then parses the CLI portion.
 *
 * @returns An object containing the parsed flags/positionals and the
 *          pass-through `workerArgs`.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function parseCliArgs() {
  const dashDashIndex = process.argv.indexOf('--');
  let cliArgs = process.argv.slice(2);
  let workerArgs: string[] = [];

  if (dashDashIndex !== -1) {
    cliArgs = process.argv.slice(2, dashDashIndex);
    workerArgs = process.argv.slice(dashDashIndex + 1);
  }

  const parsed = parseArgs({
    args: cliArgs,
    options: {
      worker: {
        type: 'string',
        short: 'w'
      },
      concurrency: {
        type: 'string',
        short: 'c'
      },
      verbose: {
        type: 'boolean',
        short: 'v'
      },
      silent: {
        type: 'boolean',
        short: 's'
      },
      help: {
        type: 'boolean',
        short: 'h'
      },
      'dry-run': {
        type: 'boolean'
      }
    },
    allowPositionals: true
  });

  return {parsed, workerArgs};
}

/**
 * Extracts and normalises all CLI arguments into a single options object.
 *
 * Handles backward-compatible positional syntax (e.g. `jori <glob> <worker>`)
 * as well as the flag-based form (`jori <glob> -w <worker>`).
 * Determines whether file input should be drawn from stdin based on TTY
 * status and the presence of positional arguments.
 *
 * @returns Fully resolved CLI arguments ready for consumption by {@link main}.
 */
function extractArguments(): {
  pattern: string; workerFile: string; concurrency: number | undefined;
  isDrawnFromStdin: boolean; dryRun: boolean; verbose: boolean; silent: boolean; workerArgs: string[]; showHelp: boolean;
} {
  const {parsed: {values, positionals}, workerArgs} = parseCliArgs();

  let pattern = positionals[0] || '';
  let workerFile = values.worker! || '';
  let isDrawnFromStdin = !process.stdin.isTTY;

  // Backward compatibility support for positional worker-file
  if (!workerFile) {
    if (positionals.length >= 2) {
      isDrawnFromStdin = false;
      pattern = positionals[0];
      workerFile = positionals[1];
    } else if (isDrawnFromStdin && positionals.length === 1) {
      workerFile = positionals[0];
      pattern = ''; // Stdin stream
    } else {
      isDrawnFromStdin = false;
      pattern = positionals[0] || '';
      workerFile = positionals[1] || '';
    }
  } else {
    // If worker file provided via flag and a pattern is given, don't use stdin for input files
    if (positionals.length > 0) {
      isDrawnFromStdin = false;
      pattern = positionals[0];
    }
  }

  let concurrency;
  if (values.concurrency) {
    concurrency = parseConcurrency(values.concurrency);
  }

  return {
    pattern,
    workerFile,
    concurrency,
    isDrawnFromStdin,
    dryRun: !!values['dry-run'],
    verbose: !!values.verbose,
    silent: !!values.silent,
    workerArgs,
    showHelp: !!values.help
  };
}

/**
 * Prints a summary of the processing run to stderr.
 *
 * @param result - Aggregated counters and timing information:
 *   `total` – number of files processed,
 *   `success` – files processed successfully,
 *   `failed` – files that failed,
 *   `durationMs` – wall-clock duration in milliseconds,
 *   `concurrency` – number of concurrent workers used.
 */
function printStatistics(result: {
  total: number; success: number; failed: number; durationMs: number; concurrency: number;
}): void {
  console.error(`\nUsing concurrency: ${result.concurrency}`);
  console.error('\n--- Processing Complete ---');
  console.error(`Total files: ${result.total}`);
  console.error(`Success:     ${result.success}`);
  console.error(`Failed:      ${result.failed}`);
  console.error(`Time:        ${(result.durationMs / 1000).toFixed(2)}s`);
}

/**
 * Flushes both stdout and stderr before exiting the process.
 *
 * Prevents data loss when output is piped to another process that may
 * close the pipe before Node has finished writing.
 *
 * @param code - The exit code to pass to `process.exit`.
 */
function safeExit(code: number): void {
  process.stdout.write('', () => {
    process.stderr.write('', () => {
      process.exit(code);
    });
  });
}

/**
 * Orchestrates the file-processing pipeline.
 *
 * Delegates to {@link processFiles}, prints per-file results and
 * summary statistics according to the provided options, then exits
 * the process.
 *
 * @param opts - Processing options (see {@link RunOptions}).
 */
async function runProcessing(opts: RunOptions): Promise<void> {
  const result = await processFiles({
    files: opts.filesStream,
    workerPath: resolve(opts.workerFile),
    concurrency: opts.concurrency,
    dryRun: opts.dryRun,
    workerArgs: opts.workerArgs,
    onSuccess: (filePath): void => {
      if (opts.shouldPrintFiles) console.log(filePath);
    },
    onTaskError: opts.verbose ? (filePath, error): void => {
      console.error(`[FAIL] ${filePath}: ${error.message}`);
    } : undefined
  });

  if (opts.shouldShowStats && result.total > 0) {
    result.durationMs = performance.now() - GLOBAL_START;
    printStatistics(result);
  } else if (opts.shouldShowStats && result.total === 0) {
    console.error('No files found to process.');
  }

  safeExit(0);
}

/**
 * Main entry point of the CLI.
 *
 * Parses arguments, validates required inputs, resolves the file source
 * (glob or stdin), and kicks off {@link runProcessing}. Handles fatal
 * errors by printing a user-friendly message and exiting with a non-zero
 * code.
 */
async function main(): Promise<void> {
  const {pattern, workerFile, concurrency, isDrawnFromStdin, dryRun, verbose, silent, workerArgs, showHelp} = extractArguments();

  if (showHelp || !workerFile || (!pattern && !isDrawnFromStdin)) {
    showUsage();
  }

  const isOutputPiped = !process.stdout.isTTY;
  const shouldShowStats = !silent && (verbose || !isOutputPiped);
  const shouldPrintFiles = !silent && (isOutputPiped || verbose);

  const filesStream = isDrawnFromStdin
    ? readLinesFromStdin()
    : collectFiles(pattern);

  try {
    await runProcessing({filesStream, workerFile, concurrency, dryRun, verbose, workerArgs, shouldShowStats, shouldPrintFiles});
  } catch (err: any) {
    if (err && err.isConfigError) {
      console.error(`\n[Fatal Error]: ${err.message}`);
    } else {
      console.error('\n[Fatal Error]:', err);
    }
    safeExit(10);
  }
}

/**
 * Guard: only run when the module is executed directly from the CLI
 * (not when imported as a library).
 */
const executedFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
const isDirectRun = import.meta.url === executedFile ||
  ['job-ripper', 'job-ripper.mjs', 'jori'].some((bin) => process.argv[1]?.endsWith(bin));

if (isDirectRun) {
  main().catch((err: any) => {
    if (err?.code?.startsWith('ERR_PARSE_ARGS_')) {
      console.error(`\n[CLI Error]: ${err.message}\nRun 'jori --help' for usage info.`);
    } else if (err instanceof Error && err.message.startsWith('Invalid concurrency')) {
      console.error(`\n[CLI Error]: ${err.message}`);
    } else {
      console.error('\n[Fatal CLI Error]:', err);
    }
    safeExit(1);
  });
}

export {main};
