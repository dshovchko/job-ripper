import fg from 'fast-glob';
try {
  const stream = fg.stream([process.argv[2]]);
  for await (const file of stream) {
    console.log(file.toString());
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
