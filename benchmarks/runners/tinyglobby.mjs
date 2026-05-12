import {glob} from 'tinyglobby';
try {
  const files = await glob([process.argv[2]]);
  for (const file of files) {
    console.log(file);
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
