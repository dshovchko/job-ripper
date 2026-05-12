#!/usr/bin/env bash

# Switch to project root so paths like ./node_modules resolve correctly
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

# Ensure dependencies and dist are built
echo "Checking dependencies and building project for benchmarks..."
if [ ! -d "node_modules" ]; then
  npm install > /dev/null
fi
if [ ! -d "benchmarks/node_modules" ]; then
  npm install --prefix benchmarks > /dev/null
fi
npm run build > /dev/null

# Detect default concurrency (75% of cores, at least 1)
CORES=$(node -e "const os = require('os'); console.log(Math.max(1, Math.floor(os.cpus().length * 0.75)))")
CONCURRENCY=$CORES
SCENARIO=""
PATTERN=""
FIND_NAME=""
EXPORT_FILE=""

# Parse arguments
while [[ "$#" -gt 0 ]]; do
  case $1 in
    -c|--concurrency) CONCURRENCY="$2"; shift ;;
    -c=*) CONCURRENCY="${1#*=}" ;;
    -s|--scenario) SCENARIO="$2"; shift ;;
    -s=*) SCENARIO="${1#*=}" ;;
    -p|--pattern) PATTERN="$2"; shift ;;
    -p=*) PATTERN="${1#*=}" ;;
    -f|--find-name) FIND_NAME="$2"; shift ;;
    -f=*) FIND_NAME="${1#*=}" ;;
    -e|--export) EXPORT_FILE="$2"; shift ;;
    -e=*) EXPORT_FILE="${1#*=}" ;;
    *) ;;
  esac
  shift
done

if [[ -z "$SCENARIO" || -z "$PATTERN" || -z "$FIND_NAME" ]]; then
   echo "Usage: ./benchmarks/run-bench.sh -s <scenario_dir> -p <glob_pattern> -f <find_name> [-e export.md]"
   exit 1
fi

echo "=========================================================="
echo "Benchmarking scenario: $SCENARIO"
echo "Target glob pattern:   $PATTERN"
echo "Target find name:      $FIND_NAME"
echo "Concurrency:           $CONCURRENCY"
if [[ -n "$EXPORT_FILE" ]]; then
echo "Exporting results to:  $EXPORT_FILE"
fi
echo "=========================================================="

HYPERFINE_OPTS=(
  --prepare 'sleep 1'
  --warmup 1
  --runs 5
)

if [[ -n "$EXPORT_FILE" ]]; then
  # Ensure the directory exists
  EXPORT_DIR=$(dirname "$EXPORT_FILE")
  if [[ "$EXPORT_DIR" != "." ]]; then
    mkdir -p "$EXPORT_DIR"
  fi
  HYPERFINE_OPTS+=(--export-markdown "$EXPORT_FILE")
fi

JORI_OPTS="-w ./benchmarks/$SCENARIO/worker.mjs -c $CONCURRENCY --silent"

hyperfine "${HYPERFINE_OPTS[@]}" \
  -n 'xargs classic (process per file)' "find ./node_modules -type f -name \"$FIND_NAME\" | xargs -P $CONCURRENCY -I {} node ./benchmarks/$SCENARIO/runner.mjs {}" \
  -n 'findx-cli (npm package)' "npx --no-install --prefix benchmarks findx \"$PATTERN\" -C $CONCURRENCY -- node ./benchmarks/$SCENARIO/runner.mjs \"{{path}}\"" \
  -n 'job-ripper embedded native glob' "node ./bin/job-ripper.mjs \"$PATTERN\" $JORI_OPTS" \
  -n 'find | job-ripper' "find ./node_modules -type f -name \"$FIND_NAME\" | node ./bin/job-ripper.mjs $JORI_OPTS" \
  -n 'fast-glob | job-ripper' "node ./benchmarks/runners/fast-glob.mjs \"$PATTERN\" | node ./bin/job-ripper.mjs $JORI_OPTS" \
  -n 'globby | job-ripper' "node ./benchmarks/runners/globby.mjs \"$PATTERN\" | node ./bin/job-ripper.mjs $JORI_OPTS" \
  -n 'tinyglobby | job-ripper' "node ./benchmarks/runners/tinyglobby.mjs \"$PATTERN\" | node ./bin/job-ripper.mjs $JORI_OPTS" \
  -n 'glob | job-ripper' "node ./benchmarks/runners/glob.mjs \"$PATTERN\" | node ./bin/job-ripper.mjs $JORI_OPTS" \
  -n 'fdir | job-ripper' "node ./benchmarks/runners/fdir.mjs \"$PATTERN\" | node ./bin/job-ripper.mjs $JORI_OPTS" \
  -n 'fs.promises.glob | job-ripper' "node ./benchmarks/runners/native.mjs \"$PATTERN\" | node ./bin/job-ripper.mjs $JORI_OPTS" \
  -n 'single-thread (fast-glob + loop)' "node ./benchmarks/$SCENARIO/single-thread.mjs \"$PATTERN\""
