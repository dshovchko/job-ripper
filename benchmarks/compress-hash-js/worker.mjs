import {readFileSync} from 'node:fs';
import {brotliCompressSync, constants} from 'node:zlib';
import {pbkdf2Sync} from 'node:crypto';

export default async function(file) {
  const data = readFileSync(file);
  // CPU intensive: Brotli compression (level 8 to keep benchmark time reasonable on thousands files)
  const compressed = brotliCompressSync(data, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 8,
    }
  });
  // CPU intensive: PBKDF2 hashing with 10k iterations
  const iterations = 10000;
  pbkdf2Sync(compressed, 'benchmarks-salt-string', iterations, 32, 'sha256');
}
