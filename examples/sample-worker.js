import {readFileSync} from 'node:fs';

/**
 * Example worker — counts lines in a file (sync CPU-bound work).
 *
 * The signature is `async` per the worker contract, but the body is
 * intentionally synchronous to illustrate a typical CPU-heavy task
 * that benefits from being distributed across threads.
 *
 * @param {string} filePath — absolute path supplied by job-ripper.
 */
export default async function worker(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').length;

  // Use console.error (stderr) for diagnostics — stdout is reserved
  // for the pipeline, so anything printed to stdout will be piped
  // to the next command (e.g. `jori ... | jori -w next.js`).
  console.error(`${filePath}: ${lines} lines`);
}
