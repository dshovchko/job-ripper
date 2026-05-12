import fg from 'fast-glob';
import worker from './worker.mjs';

const pattern = process.argv[2];
const stream = fg.stream([pattern]);
for await (const file of stream) {
  try {
    await worker(file.toString());
  } catch (error) {
    // Ignore individual file errors to continue benchmarking
  }
}
