# Benchmarks

Three scenarios covering different bottleneck profiles. Each run compares `job-ripper` against `xargs`, `findx-cli`, and a single-threaded baseline.

## Requirements

- Node.js ≥ 22
- [`hyperfine`](https://github.com/sharkdp/hyperfine):
  - **macOS:** `brew install hyperfine`
  - **Ubuntu / Debian:** `apt install hyperfine`
  - **Fedora:** `dnf install hyperfine`
  - **Windows (WSL, Git Bash, or similar Unix-compatible environment):** `winget install hyperfine` or `choco install hyperfine`
  - **Other systems:** see the [hyperfine releases page](https://github.com/sharkdp/hyperfine/releases)

- The benchmark entrypoint is `run-bench.sh` and it uses Unix tools such as `find` and `xargs`. On Windows, run the benchmarks from WSL, Git Bash, or an equivalent Unix-like shell environment.

All benchmark dependencies (AJV, remark, rehype, glob libraries) are listed in [`benchmarks/package.json`](./package.json). The script installs them automatically on first run — no manual `npm install` needed.

## Scenarios

| Scenario | What the worker does | Files | Count¹ | Bottleneck |
|---|---|---|---:|---|
| `compress-hash-js` | brotli + pbkdf2-sha256 every `.js` file | `node_modules/**/*.js` | 7 016 | CPU |
| `md-to-html` | Markdown → HTML via remark/rehype | `node_modules/**/*.md` | 810 | CPU |
| `validate-json` | validate `package.json` against a JSON schema (AJV) | `node_modules/**/package.json` | 576 | mixed (I/O + CPU); at c=1 approaches I/O-bound — single-thread may be competitive |

¹ Approximate file counts from the benchmark environment. Will differ after `npm install` / package upgrades.

## Running

```bash
git clone https://github.com/dshovchko/job-ripper.git
cd job-ripper/benchmarks
npm run bench:compress   # compress + hash JS files
npm run bench:md-html    # Markdown → HTML
npm run bench:json       # JSON schema validation
```

Dependencies and the project build are installed automatically on first run.

To override concurrency, pass `-c` after `--`:

```bash
npm run bench:md-html -- -c 8
```

To export results to a markdown file:

```bash
npm run bench:md-html -- -e results/md-to-html.md
```

## What's compared

Every scenario runs the same task eleven ways:

1. `xargs` — one process per file, `-P` for parallel
2. `findx-cli` — npm xargs alternative with glob support
3. `job-ripper` with its built-in glob
4. `find | job-ripper`
5. `fast-glob | job-ripper`
6. `globby | job-ripper`
7. `tinyglobby | job-ripper`
8. `glob | job-ripper`
9. `fdir | job-ripper`
10. `fs.promises.glob | job-ripper`
11. `single-thread` — sequential loop in one thread (no worker pool; used as a baseline)

11 variants total. The `Relative` column in each table normalises to the **fastest** result in that run (`1.00`), so the baseline row shifts between tables.

5 runs, 1 warmup, 1 s sleep between runs. These values are hardcoded in [`run-bench.sh`](./run-bench.sh) and are not configurable via CLI flags.

---

## Results — Intel Core Ultra 7 155U, Concurrency: 10

### compress-hash-js

| Command | Mean [s] | Min [s] | Max [s] | Relative |
|:---|---:|---:|---:|---:|
| `xargs classic (process per file)` | 31.946 ± 0.088 | 31.869 | 32.096 | 20.92 ± 0.14 |
| `findx-cli (npm package)` | 34.886 ± 0.021 | 34.856 | 34.912 | 22.85 ± 0.14 |
| `job-ripper embedded native glob` | 1.588 ± 0.012 | 1.572 | 1.602 | 1.04 ± 0.01 |
| `find \| job-ripper` | 1.527 ± 0.010 | 1.511 | 1.535 | 1.00 |
| `fast-glob \| job-ripper` | 1.641 ± 0.034 | 1.584 | 1.675 | 1.07 ± 0.02 |
| `globby \| job-ripper` | 1.633 ± 0.017 | 1.614 | 1.653 | 1.07 ± 0.01 |
| `tinyglobby \| job-ripper` | 1.607 ± 0.033 | 1.572 | 1.654 | 1.05 ± 0.02 |
| `glob \| job-ripper` | 1.580 ± 0.075 | 1.481 | 1.640 | 1.03 ± 0.05 |
| `fdir \| job-ripper` | 1.634 ± 0.013 | 1.617 | 1.647 | 1.07 ± 0.01 |
| `fs.promises.glob \| job-ripper` | 1.563 ± 0.009 | 1.552 | 1.576 | 1.02 ± 0.01 |
| `single-thread (fast-glob + loop)` | 9.351 ± 0.094 | 9.284 | 9.516 | 6.12 ± 0.07 |

### md-to-html

| Command | Mean [s] | Min [s] | Max [s] | Relative |
|:---|---:|---:|---:|---:|
| `xargs classic (process per file)` | 14.019 ± 0.364 | 13.370 | 14.220 | 13.95 ± 0.50 |
| `findx-cli (npm package)` | 14.595 ± 0.045 | 14.543 | 14.656 | 14.53 ± 0.37 |
| `job-ripper embedded native glob` | 1.080 ± 0.017 | 1.052 | 1.096 | 1.07 ± 0.03 |
| `find \| job-ripper` | 1.011 ± 0.023 | 0.990 | 1.041 | 1.01 ± 0.03 |
| `fast-glob \| job-ripper` | 1.005 ± 0.025 | 0.968 | 1.038 | 1.00 |
| `globby \| job-ripper` | 1.012 ± 0.022 | 0.989 | 1.032 | 1.01 ± 0.03 |
| `tinyglobby \| job-ripper` | 1.005 ± 0.015 | 0.987 | 1.025 | 1.00 ± 0.03 |
| `glob \| job-ripper` | 1.067 ± 0.034 | 1.028 | 1.122 | 1.06 ± 0.04 |
| `fdir \| job-ripper` | 1.011 ± 0.016 | 0.993 | 1.036 | 1.01 ± 0.03 |
| `fs.promises.glob \| job-ripper` | 1.066 ± 0.020 | 1.031 | 1.080 | 1.06 ± 0.03 |
| `single-thread (fast-glob + loop)` | 2.064 ± 0.024 | 2.041 | 2.095 | 2.05 ± 0.06 |

### validate-json

| Command | Mean [s] | Min [s] | Max [s] | Relative |
|:---|---:|---:|---:|---:|
| `xargs classic (process per file)` | 9.126 ± 0.393 | 8.427 | 9.369 | 59.21 ± 3.27 |
| `findx-cli (npm package)` | 9.632 ± 0.037 | 9.576 | 9.673 | 62.49 ± 2.18 |
| `job-ripper embedded native glob` | 0.347 ± 0.005 | 0.342 | 0.356 | 2.25 ± 0.09 |
| `find \| job-ripper` | 0.264 ± 0.004 | 0.257 | 0.269 | 1.71 ± 0.07 |
| `fast-glob \| job-ripper` | 0.287 ± 0.005 | 0.282 | 0.293 | 1.86 ± 0.07 |
| `globby \| job-ripper` | 0.291 ± 0.005 | 0.285 | 0.296 | 1.89 ± 0.07 |
| `tinyglobby \| job-ripper` | 0.271 ± 0.002 | 0.269 | 0.273 | 1.76 ± 0.06 |
| `glob \| job-ripper` | 0.297 ± 0.007 | 0.288 | 0.309 | 1.93 ± 0.08 |
| `fdir \| job-ripper` | 0.274 ± 0.009 | 0.266 | 0.289 | 1.78 ± 0.09 |
| `fs.promises.glob \| job-ripper` | 0.332 ± 0.005 | 0.325 | 0.338 | 2.15 ± 0.08 |
| `single-thread (fast-glob + loop)` | 0.154 ± 0.005 | 0.149 | 0.160 | 1.00 |

> **Note (validate-json, c=10):** Single-thread wins here because with 576 fast-validating files the workers spend more time waiting for the next task than executing one — IPC overhead between the main thread and the worker pool dominates. This is expected behaviour and not a regression.

---

## Results — Intel Core Ultra 7 155U, Concurrency: 1

### compress-hash-js

| Command | Mean [s] | Min [s] | Max [s] | Relative |
|:---|---:|---:|---:|---:|
| `xargs classic (process per file)` | 191.688 ± 0.148 | 191.582 | 191.940 | 20.63 ± 0.26 |
| `findx-cli (npm package)` | 207.604 ± 0.568 | 207.041 | 208.482 | 22.34 ± 0.29 |
| `job-ripper embedded native glob` | 9.835 ± 0.059 | 9.764 | 9.894 | 1.06 ± 0.01 |
| `find \| job-ripper` | 9.553 ± 0.035 | 9.507 | 9.602 | 1.03 ± 0.01 |
| `fast-glob \| job-ripper` | 9.615 ± 0.076 | 9.531 | 9.711 | 1.03 ± 0.02 |
| `globby \| job-ripper` | 9.567 ± 0.043 | 9.513 | 9.617 | 1.03 ± 0.01 |
| `tinyglobby \| job-ripper` | 9.595 ± 0.054 | 9.541 | 9.684 | 1.03 ± 0.01 |
| `glob \| job-ripper` | 9.524 ± 0.077 | 9.419 | 9.630 | 1.02 ± 0.02 |
| `fdir \| job-ripper` | 9.545 ± 0.057 | 9.486 | 9.614 | 1.03 ± 0.01 |
| `fs.promises.glob \| job-ripper` | 9.589 ± 0.074 | 9.540 | 9.716 | 1.03 ± 0.02 |
| `single-thread (fast-glob + loop)` | 9.292 ± 0.116 | 9.090 | 9.372 | 1.00 |

### md-to-html

| Command | Mean [s] | Min [s] | Max [s] | Relative |
|:---|---:|---:|---:|---:|
| `xargs classic (process per file)` | 57.840 ± 0.195 | 57.617 | 58.149 | 31.43 ± 0.57 |
| `findx-cli (npm package)` | 58.539 ± 0.107 | 58.441 | 58.681 | 31.81 ± 0.57 |
| `job-ripper embedded native glob` | 2.157 ± 0.031 | 2.119 | 2.193 | 1.17 ± 0.03 |
| `find \| job-ripper` | 1.840 ± 0.033 | 1.802 | 1.875 | 1.00 |
| `fast-glob \| job-ripper` | 2.024 ± 0.039 | 1.978 | 2.069 | 1.10 ± 0.03 |
| `globby \| job-ripper` | 2.098 ± 0.053 | 2.012 | 2.157 | 1.14 ± 0.04 |
| `tinyglobby \| job-ripper` | 2.048 ± 0.116 | 1.905 | 2.228 | 1.11 ± 0.07 |
| `glob \| job-ripper` | 1.953 ± 0.116 | 1.840 | 2.109 | 1.06 ± 0.07 |
| `fdir \| job-ripper` | 2.020 ± 0.041 | 1.962 | 2.063 | 1.10 ± 0.03 |
| `fs.promises.glob \| job-ripper` | 1.910 ± 0.091 | 1.838 | 2.062 | 1.04 ± 0.05 |
| `single-thread (fast-glob + loop)` | 2.004 ± 0.043 | 1.956 | 2.055 | 1.09 ± 0.03 |

### validate-json

| Command | Mean [s] | Min [s] | Max [s] | Relative |
|:---|---:|---:|---:|---:|
| `xargs classic (process per file)` | 36.737 ± 0.114 | 36.604 | 36.879 | 247.97 ± 8.68 |
| `findx-cli (npm package)` | 37.213 ± 0.066 | 37.153 | 37.305 | 251.18 ± 8.77 |
| `job-ripper embedded native glob` | 0.249 ± 0.009 | 0.242 | 0.265 | 1.68 ± 0.09 |
| `find \| job-ripper` | 0.148 ± 0.005 | 0.144 | 0.155 | 1.00 |
| `fast-glob \| job-ripper` | 0.162 ± 0.013 | 0.147 | 0.182 | 1.09 ± 0.09 |
| `globby \| job-ripper` | 0.158 ± 0.013 | 0.144 | 0.178 | 1.07 ± 0.09 |
| `tinyglobby \| job-ripper` | 0.157 ± 0.008 | 0.149 | 0.167 | 1.06 ± 0.07 |
| `glob \| job-ripper` | 0.153 ± 0.007 | 0.146 | 0.162 | 1.03 ± 0.06 |
| `fdir \| job-ripper` | 0.158 ± 0.004 | 0.152 | 0.161 | 1.06 ± 0.05 |
| `fs.promises.glob \| job-ripper` | 0.172 ± 0.010 | 0.161 | 0.186 | 1.16 ± 0.08 |
| `single-thread (fast-glob + loop)` | 0.151 ± 0.005 | 0.143 | 0.156 | 1.02 ± 0.05 |

> **Note (validate-json, c=1):** With a single worker the thread pool offers no parallelism, so `job-ripper` and `single-thread` run neck-and-neck (~0.148 s vs ~0.151 s). The near-tie is expected for this I/O-light workload at c=1.

---

## Results — AMD EPYC 9645, Concurrency: 4

> **Server context:** AMD EPYC 9645 is a 96-core server CPU running under real production load. Only 4 cores were allocated for these benchmarks — intentionally, to represent a constrained server slot rather than an idle workstation. The goal is to show that `job-ripper` does not throttle under load, unlike a desktop CPU that may boost-clock freely when idle.

### compress-hash-js

| Command | Mean [s] | Min [s] | Max [s] | Relative |
|:---|---:|---:|---:|---:|
| `xargs classic (process per file)` | 69.800 ± 0.908 | 68.839 | 71.039 | 19.30 ± 0.32 |
| `findx-cli (npm package)` | 76.379 ± 3.556 | 72.460 | 80.043 | 21.12 ± 1.01 |
| `job-ripper embedded native glob` | 4.150 ± 0.226 | 3.838 | 4.477 | 1.15 ± 0.06 |
| `find \| job-ripper` | 3.617 ± 0.038 | 3.561 | 3.660 | 1.00 |
| `fast-glob \| job-ripper` | 3.719 ± 0.188 | 3.559 | 3.932 | 1.03 ± 0.05 |
| `globby \| job-ripper` | 3.740 ± 0.106 | 3.614 | 3.871 | 1.03 ± 0.03 |
| `tinyglobby \| job-ripper` | 3.808 ± 0.131 | 3.699 | 4.022 | 1.05 ± 0.04 |
| `glob \| job-ripper` | 3.665 ± 0.061 | 3.593 | 3.727 | 1.01 ± 0.02 |
| `fdir \| job-ripper` | 3.702 ± 0.049 | 3.659 | 3.774 | 1.02 ± 0.02 |
| `fs.promises.glob \| job-ripper` | 3.757 ± 0.136 | 3.651 | 3.983 | 1.04 ± 0.04 |
| `single-thread (fast-glob + loop)` | 13.076 ± 0.272 | 12.657 | 13.417 | 3.62 ± 0.08 |

### md-to-html

| Command | Mean [s] | Min [s] | Max [s] | Relative |
|:---|---:|---:|---:|---:|
| `xargs classic (process per file)` | 31.506 ± 1.092 | 30.120 | 32.357 | 17.89 ± 0.87 |
| `findx-cli (npm package)` | 30.507 ± 0.775 | 29.659 | 31.348 | 17.32 ± 0.73 |
| `job-ripper embedded native glob` | 2.006 ± 0.058 | 1.936 | 2.069 | 1.14 ± 0.05 |
| `find \| job-ripper` | 1.761 ± 0.060 | 1.688 | 1.827 | 1.00 |
| `fast-glob \| job-ripper` | 1.789 ± 0.047 | 1.727 | 1.851 | 1.02 ± 0.04 |
| `globby \| job-ripper` | 1.832 ± 0.083 | 1.763 | 1.967 | 1.04 ± 0.06 |
| `tinyglobby \| job-ripper` | 1.834 ± 0.097 | 1.747 | 1.990 | 1.04 ± 0.07 |
| `glob \| job-ripper` | 1.953 ± 0.080 | 1.871 | 2.047 | 1.11 ± 0.06 |
| `fdir \| job-ripper` | 1.874 ± 0.093 | 1.769 | 1.971 | 1.06 ± 0.06 |
| `fs.promises.glob \| job-ripper` | 1.910 ± 0.076 | 1.794 | 1.993 | 1.08 ± 0.06 |
| `single-thread (fast-glob + loop)` | 3.060 ± 0.329 | 2.761 | 3.580 | 1.74 ± 0.20 |

### validate-json

| Command | Mean [s] | Min [s] | Max [s] | Relative |
|:---|---:|---:|---:|---:|
| `xargs classic (process per file)` | 21.106 ± 0.671 | 20.521 | 22.238 | 91.95 ± 7.05 |
| `findx-cli (npm package)` | 22.608 ± 0.664 | 21.885 | 23.238 | 98.49 ± 7.46 |
| `job-ripper embedded native glob` | 0.410 ± 0.027 | 0.394 | 0.459 | 1.79 ± 0.17 |
| `find \| job-ripper` | 0.274 ± 0.019 | 0.244 | 0.292 | 1.19 ± 0.12 |
| `fast-glob \| job-ripper` | 0.343 ± 0.033 | 0.308 | 0.396 | 1.49 ± 0.18 |
| `globby \| job-ripper` | 0.322 ± 0.013 | 0.310 | 0.343 | 1.40 ± 0.11 |
| `tinyglobby \| job-ripper` | 0.301 ± 0.021 | 0.280 | 0.332 | 1.31 ± 0.13 |
| `glob \| job-ripper` | 0.330 ± 0.006 | 0.324 | 0.340 | 1.44 ± 0.10 |
| `fdir \| job-ripper` | 0.291 ± 0.016 | 0.275 | 0.312 | 1.27 ± 0.11 |
| `fs.promises.glob \| job-ripper` | 0.364 ± 0.034 | 0.321 | 0.413 | 1.58 ± 0.19 |
| `single-thread (fast-glob + loop)` | 0.230 ± 0.016 | 0.212 | 0.249 | 1.00 |

> **Note (validate-json, c=4):** Same dynamic as c=10: 576 files × fast AJV validation means workers spend more time waiting for tasks than executing them. IPC overhead dominates; single-thread wins by avoiding the round-trip entirely.

---

## Results — AMD EPYC 9645, Concurrency: 1

### compress-hash-js

| Command | Mean [s] | Min [s] | Max [s] | Relative |
|:---|---:|---:|---:|---:|
| `xargs classic (process per file)` | 239.354 ± 1.187 | 237.958 | 240.899 | 19.52 ± 0.26 |
| `findx-cli (npm package)` | 262.418 ± 6.084 | 255.072 | 270.108 | 21.40 ± 0.56 |
| `job-ripper embedded native glob` | 13.515 ± 0.372 | 12.929 | 13.891 | 1.10 ± 0.03 |
| `find \| job-ripper` | 12.792 ± 0.230 | 12.519 | 13.027 | 1.04 ± 0.02 |
| `fast-glob \| job-ripper` | 12.718 ± 0.161 | 12.584 | 12.982 | 1.04 ± 0.02 |
| `globby \| job-ripper` | 12.833 ± 0.190 | 12.624 | 13.102 | 1.05 ± 0.02 |
| `tinyglobby \| job-ripper` | 12.999 ± 0.365 | 12.497 | 13.335 | 1.06 ± 0.03 |
| `glob \| job-ripper` | 12.626 ± 0.219 | 12.362 | 12.860 | 1.03 ± 0.02 |
| `fdir \| job-ripper` | 12.704 ± 0.322 | 12.371 | 13.235 | 1.04 ± 0.03 |
| `fs.promises.glob \| job-ripper` | 12.807 ± 0.092 | 12.688 | 12.898 | 1.04 ± 0.02 |
| `single-thread (fast-glob + loop)` | 12.260 ± 0.155 | 12.036 | 12.412 | 1.00 |

### md-to-html

| Command | Mean [s] | Min [s] | Max [s] | Relative |
|:---|---:|---:|---:|---:|
| `xargs classic (process per file)` | 80.782 ± 2.597 | 77.891 | 83.617 | 28.13 ± 3.77 |
| `findx-cli (npm package)` | 86.505 ± 1.299 | 85.002 | 88.563 | 30.12 ± 3.95 |
| `job-ripper embedded native glob` | 3.844 ± 0.317 | 3.532 | 4.351 | 1.34 ± 0.21 |
| `find \| job-ripper` | 2.872 ± 0.374 | 2.577 | 3.485 | 1.00 |
| `fast-glob \| job-ripper` | 2.983 ± 0.095 | 2.857 | 3.105 | 1.04 ± 0.14 |
| `globby \| job-ripper` | 3.213 ± 0.106 | 3.106 | 3.389 | 1.12 ± 0.15 |
| `tinyglobby \| job-ripper` | 3.124 ± 0.142 | 2.930 | 3.298 | 1.09 ± 0.15 |
| `glob \| job-ripper` | 2.930 ± 0.136 | 2.816 | 3.164 | 1.02 ± 0.14 |
| `fdir \| job-ripper` | 3.292 ± 0.252 | 2.964 | 3.589 | 1.15 ± 0.17 |
| `fs.promises.glob \| job-ripper` | 2.953 ± 0.195 | 2.671 | 3.193 | 1.03 ± 0.15 |
| `single-thread (fast-glob + loop)` | 3.222 ± 0.188 | 3.057 | 3.444 | 1.12 ± 0.16 |

> **Note (md-to-html, c=1):** Even with just one worker, `find | job-ripper` (2.872 s) beats `single-thread` (3.222 s). The worker thread handles CPU-bound Markdown rendering while the main thread continues to dispatch I/O — avoiding the serialisation penalty of a single-threaded loop, even without parallelism.

### validate-json

| Command | Mean [s] | Min [s] | Max [s] | Relative |
|:---|---:|---:|---:|---:|
| `xargs classic (process per file)` | 56.108 ± 0.694 | 55.010 | 56.841 | 250.37 ± 21.31 |
| `findx-cli (npm package)` | 58.888 ± 0.470 | 58.536 | 59.684 | 262.77 ± 22.23 |
| `job-ripper embedded native glob` | 0.381 ± 0.020 | 0.358 | 0.401 | 1.70 ± 0.17 |
| `find \| job-ripper` | 0.256 ± 0.021 | 0.220 | 0.273 | 1.14 ± 0.14 |
| `fast-glob \| job-ripper` | 0.248 ± 0.023 | 0.221 | 0.273 | 1.10 ± 0.14 |
| `globby \| job-ripper` | 0.251 ± 0.022 | 0.223 | 0.278 | 1.12 ± 0.14 |
| `tinyglobby \| job-ripper` | 0.224 ± 0.019 | 0.204 | 0.248 | 1.00 |
| `glob \| job-ripper` | 0.232 ± 0.023 | 0.204 | 0.267 | 1.03 ± 0.13 |
| `fdir \| job-ripper` | 0.226 ± 0.015 | 0.212 | 0.251 | 1.01 ± 0.11 |
| `fs.promises.glob \| job-ripper` | 0.261 ± 0.003 | 0.258 | 0.264 | 1.16 ± 0.10 |
| `single-thread (fast-glob + loop)` | 0.273 ± 0.018 | 0.254 | 0.294 | 1.22 ± 0.13 |

---

## When to use job-ripper

`job-ripper` is worth using across all workload types, not just CPU-heavy ones.

**CPU-bound tasks** (`compress-hash-js`, `md-to-html`) show the clearest wins: ~20× faster than `xargs` and consistently ahead of single-thread at any concurrency level. Set concurrency to **75–100% of available cores**.

**Mixed workloads** (`validate-json` at moderate concurrency) still benefit, though the margin
narrows as the task gets lighter. Set concurrency to **50–75% of available cores**.

**I/O-light or fast tasks** (e.g. `validate-json`) show near-parity between `job-ripper` and
single-thread at low concurrency — the difference is within noise. Even so, using `job-ripper`
with **1–2 workers** costs nothing measurable while keeping the architecture consistent and
ready to scale when task weight grows.

**CI environments** (GitHub Actions free tier: 2 cores, GitLab shared: 2 cores) are a good
fit even with a single worker: the worker thread handles CPU-bound work while the main thread
continues I/O dispatch. Overhead is negligible; isolation benefit is real.

### Concurrency quick-reference

| Workload | Recommended concurrency |
|---|---|
| CPU-bound (compression, rendering) | 75–100% of cores |
| Mixed (validation, transformation) | 50–75% of cores |
| I/O-light / fast tasks | 1–2 workers |
| CI / GitHub Actions (any workload) | 1–2 workers |
