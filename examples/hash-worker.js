import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {basename} from 'node:path';

/**
 * Example worker — computes a SHA-256 hash and returns metadata.
 *
 * Demonstrates returning a value from a worker. The return value is
 * serialized via structured clone and forwarded to the `onSuccess`
 * callback in the programmatic API:
 *
 *   onSuccess(filePath, result)
 *
 * The CLI ignores return values — use `processFiles()` to collect them.
 *
 * @param {string} filePath — absolute path supplied by job-ripper.
 * @returns {{ name: string, size: number, hash: string }}
 */
export default async function worker(filePath) {
  const content = readFileSync(filePath);
  const hash = createHash('sha256').update(content).digest('hex');

  return {
    name: basename(filePath),
    size: content.length,
    hash,
  };
}

// --- Programmatic usage example ---
//
// import { processFiles } from 'job-ripper';
//
// const results = [];
// await processFiles({
//   files: ['file1.txt', 'file2.txt'],
//   workerPath: './examples/hash-worker.js',
//   onSuccess: (filePath, result) => results.push(result),
// });
//
// console.log(results);
// // [
// //   { name: 'file1.txt', size: 1024, hash: '3e2b...' },
// //   { name: 'file2.txt', size: 2048, hash: 'f1a0...' },
// // ]
