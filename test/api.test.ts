import {resolve, join, dirname} from 'node:path';
import {writeFile, rm, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {processFiles} from '../src/index.js';

// eslint-disable-next-line @typescript-eslint/naming-convention
const __filename = fileURLToPath(import.meta.url);
// eslint-disable-next-line @typescript-eslint/naming-convention
const __dirname = dirname(__filename);

describe('Programmatic API', () => {
  const fixturesDir = resolve(__dirname, 'fixtures2');
  const dummyWorkerPath = join(fixturesDir, 'api-worker.js');
  const failingWorkerPath = join(fixturesDir, 'failing-worker.js');
  const delayedWorkerPath = join(fixturesDir, 'delayed-worker.js');
  const resultLogPath = join(fixturesDir, 'result-log.json');

  beforeEach(async () => {
    await mkdir(fixturesDir, {recursive: true});
    await writeFile(dummyWorkerPath, `
      import { appendFile } from 'node:fs/promises';
      export default async function processFile(filePath, userArgs) {
        // Log it to a file so we can assert it later
        await appendFile('${resultLogPath.replace(/\\/g, '\\\\')}', JSON.stringify({ filePath, userArgs }) + '\\n');
        return true;
      }
    `);
    await writeFile(failingWorkerPath, `
      export default async function processFile(filePath) {
        if (filePath.includes('fail')) {
          throw new Error('boom');
        }
        return true;
      }
    `);
    await writeFile(delayedWorkerPath, `
      export default async function processFile() {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return true;
      }
    `);

    // reset log
    await writeFile(resultLogPath, '');
  });

  afterEach(async () => {
    await rm(fixturesDir, {recursive: true, force: true});
  });

  it('dryRun does not execute worker but returns success', async () => {
    const files = [join(fixturesDir, 'test.css')];
    let callbackFired = false;

    const res = await processFiles({
      files,
      workerPath: dummyWorkerPath,
      dryRun: true,
      onSuccess: (f) => { callbackFired = true; }
    });

    expect(res.total).toBe(1);
    expect(res.success).toBe(1);
    expect(callbackFired).toBe(true);

    const logContent = await import('node:fs/promises').then((fs) => fs.readFile(resultLogPath, 'utf8'));
    expect(logContent.trim()).toBe(''); // Worker shouldn't have fired
  });

  it('passes workerArgs to the worker successfully', async () => {
    const files = [join(fixturesDir, 'test2.css')];
    const workerArgs = ['--source-maps', 'true'];

    const res = await processFiles({
      files,
      workerPath: dummyWorkerPath,
      workerArgs,
    });

    expect(res.total).toBe(1);
    expect(res.success).toBe(1);

    const logContent = await import('node:fs/promises').then((fs) => fs.readFile(resultLogPath, 'utf8'));
    const parsed = JSON.parse(logContent.trim());
    expect(parsed.userArgs).toEqual(workerArgs);
    expect(parsed.filePath).toContain('test2.css');
  });

  it('supports AsyncIterable / async generators for files input (IoC)', async () => {
    const workerArgs = ['async-test'];

    // Create an async generator that yields paths one by one
    async function* myCustomGenerator() {
      yield join(fixturesDir, 'async1.js');
      await new Promise((r) => setTimeout(r, 10)); // Simulated async loading, e.g., from DB/fs
      yield join(fixturesDir, 'async2.js');
    }

    const res = await processFiles({
      files: myCustomGenerator(), // Pass a generator instead of an array!
      workerPath: dummyWorkerPath,
      workerArgs,
      concurrency: 2
    });

    expect(res.total).toBe(2);
    expect(res.success).toBe(2);

    const logContent = await import('node:fs/promises').then((fs) => fs.readFile(resultLogPath, 'utf8'));
    const lines = logContent.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

    expect(lines.length).toBe(2);
    // Since execution is somewhat concurrent via Worker pool, order of logging may vary
    const filePaths = lines.map((l) => l.filePath);
    expect(filePaths.some((p) => p.includes('async1.js'))).toBe(true);
    expect(filePaths.some((p) => p.includes('async2.js'))).toBe(true);
  });

  it('returns failed count for task-level worker errors without terminating the process', async () => {
    const res = await processFiles({
      files: [join(fixturesDir, 'ok.txt'), join(fixturesDir, 'fail.txt')],
      workerPath: failingWorkerPath,
      concurrency: 1
    });

    expect(res.total).toBe(2);
    expect(res.success).toBe(1);
    expect(res.failed).toBe(1);
  });

  it('applies backpressure to async file sources', async () => {
    const yieldedFiles: string[] = [];

    async function* files() {
      yieldedFiles.push('first');
      yield join(fixturesDir, 'first.txt');
      yieldedFiles.push('second');
      yield join(fixturesDir, 'second.txt');
      yieldedFiles.push('third');
      yield join(fixturesDir, 'third.txt');
    }

    const processingPromise = processFiles({
      files: files(),
      workerPath: delayedWorkerPath,
      concurrency: 1
    });

    await new Promise((done) => setTimeout(done, 50));
    expect(yieldedFiles).toEqual(['first']);

    const res = await processingPromise;

    expect(yieldedFiles).toEqual(['first', 'second', 'third']);
    expect(res.total).toBe(3);
    expect(res.success).toBe(3);
    expect(res.failed).toBe(0);
  });

  it('rejects on fatal worker initialization errors', async () => {
    await expect(processFiles({
      files: [join(fixturesDir, 'ok.txt')],
      workerPath: join(fixturesDir, 'missing-worker.js'),
      concurrency: 1
    })).rejects.toThrow('Cannot find module');
  });

  it('passes worker return value to onSuccess callback', async () => {
    const returningWorkerPath = join(fixturesDir, 'returning-worker.js');
    await writeFile(returningWorkerPath, `
      export default async function processFile(filePath) {
        return { hash: 'abc123', bytes: filePath.length };
      }
    `);

    const results: {filePath: string, result: unknown}[] = [];

    const res = await processFiles({
      files: [join(fixturesDir, 'file1.txt'), join(fixturesDir, 'file2.txt')],
      workerPath: returningWorkerPath,
      concurrency: 1,
      onSuccess: (filePath, result) => {
        results.push({filePath, result});
      }
    });

    expect(res.total).toBe(2);
    expect(res.success).toBe(2);
    expect(results.length).toBe(2);
    expect(results[0].result).toEqual({hash: 'abc123', bytes: results[0].filePath.length});
    expect(results[1].result).toEqual({hash: 'abc123', bytes: results[1].filePath.length});
  });

  it('passes undefined result to onSuccess when worker returns nothing', async () => {
    const voidWorkerPath = join(fixturesDir, 'void-worker.js');
    await writeFile(voidWorkerPath, `
      export default async function processFile(filePath) {
        // no return
      }
    `);

    const results: {filePath: string, result: unknown}[] = [];

    const res = await processFiles({
      files: [join(fixturesDir, 'test.txt')],
      workerPath: voidWorkerPath,
      concurrency: 1,
      onSuccess: (filePath, result) => {
        results.push({filePath, result});
      }
    });

    expect(res.total).toBe(1);
    expect(res.success).toBe(1);
    expect(results.length).toBe(1);
    expect(results[0].result).toBeUndefined();
  });
});
