import fg from 'fast-glob';
import worker from './worker.mjs';
// Read pattern from argv, typically "node_modules/**/*.js"
const pattern = process.argv[2];
// Use fast-glob stream iterator to process sequentially
const stream = fg.stream([pattern]);
for await (const file of stream) {
  try {
    await worker(file.toString());
  } catch (error) {
    console.error(error);
  }
}
