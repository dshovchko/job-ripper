import {glob} from 'node:fs/promises';
try {
  const pattern = process.argv[2];
  for await (const file of glob(pattern)) { console.log(file); }
} catch (error) {
  console.error(error);
  process.exit(1);
}
