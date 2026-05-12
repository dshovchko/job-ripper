import {fdir} from 'fdir';
import picomatch from 'picomatch';

try {
  const pattern = process.argv[2];
  const isMatch = picomatch(pattern);
  const dir = pattern.split('/')[0] || '.';
  const files = await new fdir()
    .withRelativePaths()
    .filter((path) => isMatch(dir + '/' + path))
    .crawl(dir)
    .withPromise();
  for (const p of files) {
    console.log(dir + '/' + p);
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
