import worker from './worker.mjs';
const file = process.argv[2];
if (file) worker(file).catch(() => {});
