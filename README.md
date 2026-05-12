# job-ripper (jori)

> Zero-dependency CLI that rips through CPU-heavy jobs using Node.js `worker_threads`.

[![npm](https://img.shields.io/npm/v/job-ripper)](https://www.npmjs.com/package/job-ripper)
[![node](https://img.shields.io/node/v/job-ripper)](https://nodejs.org/)
[![license](https://img.shields.io/npm/l/job-ripper)](./LICENSE)

Feed it a file list. Give it a worker script. Chain workers like Unix pipes. It saturates all your CPU cores in parallel — no config, no boilerplate, no dependencies.

---

## Benchmarks

Benchmark scenario: convert 1 000 Markdown files to HTML (parse → AST manipulation → render). Run on Apple M3 Pro, 11 cores, Node.js 22.

| Approach | Time (median) | vs. single-thread |
|---|---|---|
| Single-threaded loop | 18.4 s | 1× (baseline) |
| `node:cluster` (manual) | 4.1 s | 4.5× |
| **job-ripper** `-c 75%` | **2.3 s** | **8×** |

> Results vary by machine and task weight. Run your own baseline:

```bash
# Requires hyperfine: brew install hyperfine
./benchmarks/run-bench.sh \
  -s md-to-html \
  -p "node_modules/**/*.md" \
  -f "*.md" \
  -c 8
```

---

## When to use

**✅ CPU-bound work — this is what jori is for:**
- Transpiling / compiling files (TS → JS, SCSS → CSS)
- Image / video encoding and resizing
- Markdown → HTML, PDF generation
- Hash computation, encryption, compression
- JSON schema validation (large files or schemas), data transformation
- Static analysis, linting, code formatting

**❌ I/O-bound work — use streams instead:**

Spawning 8 workers to read 8 files simultaneously won't help if your bottleneck is disk throughput or a remote API rate limit. In those cases, plain `Promise.all` with a concurrency limiter (e.g. `p-limit`) is simpler and equally fast.

---

## Install

```bash
npm install -g job-ripper          # global CLI
# or
npm install job-ripper             # local, for programmatic use (see API section)
```

Requires **Node.js ≥ 22**.

---

## Quick Start

**1. Write a worker** (`compress.mjs`):

```js
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

export default async function(filePath) {
  const data = readFileSync(filePath);
  const compressed = gzipSync(data);
  writeFileSync(filePath + '.gz', compressed);
}
```

**2. Run it:**

```bash
$ jori "src/**/*.js" -w compress.mjs -c 50%

Using concurrency: 8

--- Processing Complete ---
Total files: 312
Success:     312
Failed:      0
Time:        2.41s
```

That's it. No config files, no `require()` wrappers, no callbacks.

---

## How it works

```
                        main thread
                    ┌───────────────┐
   glob / stdin ──► │  file queue   │
                    │               │
                    │  backpressure │ ◄── maxQueue limit
                    └──────┬────────┘
                           │ dispatch
            ┌──────────────┼──────────────┐
            ▼              ▼              ▼
      ┌──────────┐   ┌──────────┐   ┌──────────┐
      │ worker 1 │   │ worker 2 │   │ worker N │  ← N = -c value (default: cpus × 0.75)
      │ (your fn)│   │ (your fn)│   │ (your fn)│
      └────┬─────┘   └────┬─────┘   └────┬─────┘
           └──────────────┼──────────────┘
                          ▼
                  result / error ──► logged to stderr + exit code
```

**Architecture notes:**

- Workers are pre-spawned once at startup (warm pool — no per-file overhead).
- The main thread reads files and dispatches tasks; it never runs user code.
- An internal queue with backpressure prevents the in-memory task list from growing unbounded on slow workers.
- **Task-level errors** (`throw` inside your function) are counted as failures but processing continues for remaining files.
- **Fatal errors** (worker crash, module not found, missing default export) halt the entire run immediately with a clear message.

---

## Usage

### CLI

```
Usage:
  jori <glob> -w <worker> [options] [-- worker_args...]
  <command> | jori -w <worker> [options] [-- worker_args...]

Arguments:
  <glob>                 File glob pattern or path to a single file

Options:
  -w, --worker <path>    Path to the worker script (required)
  -c, --concurrency <N>  Number of workers or CPU percentage (e.g., 4 or 75%, default: 75%)
  -v, --verbose          Print each processed file and detailed statistics
  -s, --silent           Suppress all output except errors
  --dry-run              Print matched files without running workers
  -h, --help             Show this help message
```

**Concurrency formats:**

| Value | Meaning |
|---|---|
| `4` | Exactly 4 workers |
| `75%` | 75 % of logical CPU cores (rounded down, min 1) |
| _(omitted)_ | Same as `75%` |

### Glob mode

```bash
jori "src/**/*.ts" -w build.mjs
jori "images/**/*.png" -w resize.mjs -c 8
```

### Stdin / pipeline mode

When no `<glob>` argument is given, `jori` reads file paths from stdin (one per line). This enables Unix-style pipelines:

```bash
find . -name "*.log" -mtime -7 | jori -w analyze.mjs
cat file-list.txt              | jori -w process.mjs -c 4
```

---

## Worker Contract

A worker is any ESM module that exports a `default` function:

```ts
export default async function(filePath: string, args: string[]): Promise<void> {
  // filePath — absolute path to the file to process
  // args     — forwarded from CLI: jori ... -- --flag value
}
```

The signature is `async` — jori correctly `await`s the result, so both sync and async bodies work. However:

> **Prefer sync APIs inside the body.** Each worker runs in its own dedicated thread — blocking it is intentional and expected. `readFileSync`, `gzipSync`, `createHash` etc. avoid unnecessary Promise/microtask overhead. Reserve `async` for cases where you genuinely need it (e.g. calling an external HTTP API).

**Minimal example:**

```js
// transform.mjs
import { readFileSync, writeFileSync } from 'node:fs';

export default async function(filePath) {
  const src = readFileSync(filePath, 'utf8');
  writeFileSync(filePath, src.toUpperCase());
}
```

**Error handling:**

| What you do | What jori does |
|---|---|
| `throw new Error(...)` | Counts as **failed**, logged to stderr in verbose mode (`-v`), continues with remaining files |
| Return normally | Counts as **success** |
| Module has no default export | Fatal error — run stops immediately with a clear message |
| Module file not found | Fatal error — run stops immediately |

---

## Examples

### Pipeline chain (Unix pipes)

After processing each file, `jori` echoes the file path to stdout — so the next stage receives the same paths as the current stage. The worker scripts decide what to write to disk.

```bash
find . -name "*.md" \
  | jori -w render.mjs  -c 4 \   # stage 1: md → html   (writes .html files)
  | jori -w minify.mjs  -c 4 \   # stage 2: minify html (overwrites .html)
  | jori -w upload.mjs  -c 2     # stage 3: upload       (I/O-limited)
```

### With `find`, `fdir`, or `fast-glob`

```bash
# find
find ./src -name "*.ts" -not -path "*/node_modules/*" \
  | jori -w compile.mjs

# fdir (fastest directory crawler)
node --input-type=module << 'EOF' | jori -w compile.mjs
import { fdir } from 'fdir';
const files = new fdir().glob('**/*.ts').crawl('./src').sync();
process.stdout.write(files.join('\n'));
EOF

# fast-glob
node --input-type=module << 'EOF' | jori -w compile.mjs -c 75%
import fg from 'fast-glob';
for (const f of await fg('src/**/*.ts')) console.log(f);
EOF
```

### Dry-run before a destructive operation

```bash
# Step 1: preview matched files
jori "logs/**/*.log" -w archive.mjs --dry-run

# Step 2: run for real
jori "logs/**/*.log" -w archive.mjs
```

### Pass arguments to the worker

```bash
jori "data/*.json" -w transform.mjs -- --format=pretty --locale=uk
```

Inside the worker, `args` is the array of strings after `--`:

```js
export default async function(filePath, args) {
  const isPretty = args.includes('--format=pretty');
  // ...
}
```

---

## Programmatic API

```ts
import { processFiles } from 'job-ripper';

const result = await processFiles({
  files: ['a.ts', 'b.ts'],        // string[] | Iterable | AsyncIterable
  workerPath: './compile.mjs',    // path to worker module
  concurrency: 4,                 // optional, default: cpus × 0.75
  workerArgs: ['--strict'],       // forwarded to worker as args[]
  dryRun: false,                  // skip actual processing
  onSuccess: (f) => console.log('✓', f),
  onTaskError: (f, err) => console.error('✗', f, err.message),
});

console.log(result);
// { total: 2, success: 2, failed: 0, durationMs: 310, concurrency: 4 }
```

The `files` parameter accepts **any iterable or async iterable** — arrays, generators, `fast-glob` streams, `fdir` crawlers, database cursors, etc.

**Error handling:** There is no `onError` callback. Task-level errors (throws inside your worker function) are swallowed, counted, and reflected in `result.failed`. Check that field after the call and decide what to do:

```ts
const result = await processFiles({
  // ...
  onTaskError: (filePath, error) => {
    console.error(`Failed: ${filePath} — ${error.message}`);
  },
});
if (result.failed > 0) {
  console.error(`${result.failed} files failed`);
  process.exit(1);
}
```

---

## Performance Tips

### Prefer sync APIs inside worker bodies

The worker signature is `async`, but the code **inside** should be sync whenever possible. `worker_threads` gives your function its own OS thread — blocking it is intentional. Sync `fs`, `zlib`, and `crypto` calls avoid Promise/microtask overhead:

```js
// ✅ preferred — sync body inside an async worker
export default async function(filePath) {
  const data = readFileSync(filePath);
  writeFileSync(filePath + '.gz', gzipSync(data));
}

// ❌ unnecessary async overhead — the thread is already dedicated to you
export default async function(filePath) {
  const data = await readFile(filePath);
  await writeFile(filePath + '.gz', await gzip(data));
}
```

### Pick concurrency for your task weight

| Task weight | Computation per file | Recommended `-c` |
|---|---|---|
| **Light** | < 10 ms (JSON parse, regex) | `25%` — tasks finish faster than IPC overhead; extra workers mostly idle |
| **Medium** | 10–200 ms (transpile, lint) | `50–75%` *(default 75%)* |
| **Heavy** | > 200 ms (image encode, PDF) | `75–100%` — long tasks justify saturating every core |
| **I/O-bound** | network / disk limited | use `p-limit`, not jori |

> **Why does lighter work need fewer workers?** When each task completes in < 10 ms the bottleneck shifts from CPU to the IPC round-trip between the main thread and workers. Spawning more workers than tasks can be dispatched adds synchronization noise without adding throughput. For heavy tasks the opposite is true — each thread stays busy for hundreds of milliseconds, so every extra core translates directly into lower wall time.

### Keep the main thread free

Your worker does the CPU work. The main thread only dispatches tasks. Avoid heavy computation inside `onSuccess` callbacks — those run on the main thread and will create a bottleneck.

### Pipeline tuning

Each stage in a pipeline has its own concurrency budget. Tune them to match the weight of each step:

```bash
# Render is CPU-heavy, upload is I/O-limited — different concurrency per stage
find . -name "*.md" | jori -w render.mjs -c 75% | jori -w upload.mjs -c 2
```

### Always preview with `--dry-run`

Before running a worker that modifies or deletes files, verify what files would be matched:

```bash
jori "**/*.png" -w resize.mjs --dry-run | wc -l   # count matched files
```

---

## License

[MIT](./LICENSE)
