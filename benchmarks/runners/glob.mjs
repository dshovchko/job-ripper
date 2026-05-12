import {globIterate} from 'glob';
try {
  for await (const file of globIterate(process.argv[2])) {
    console.log(file);
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
