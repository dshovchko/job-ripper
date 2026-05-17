import {fileURLToPath} from 'node:url';
import {dirname, resolve, join} from 'node:path';
import {writeFile, rm, mkdir} from 'node:fs/promises';
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {ThreadPool} from '../src/thread-pool.js';

interface TestTask {
  id: number;
  filePath: string;
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface ThreadPoolInternals {
  taskQueue: {
    enqueue: (task: TestTask) => void;
    size: number;
  };
  freeWorkers: unknown[];
  activeTasks: number;
  pump: () => void;
}

// eslint-disable-next-line @typescript-eslint/naming-convention
const __filename = fileURLToPath(import.meta.url);
// eslint-disable-next-line @typescript-eslint/naming-convention
const __dirname = dirname(__filename);

describe('ThreadPool', () => {
  const fixturesDir = resolve(__dirname, 'fixtures');
  const dummyWorkerPath = join(fixturesDir, 'dummy-worker.js');

  beforeEach(async () => {
    await mkdir(fixturesDir, {recursive: true});
    await writeFile(dummyWorkerPath, `
      export default async function processFile(filePath) {
        if (filePath.includes('fail')) throw new Error('boom');
        return filePath;
      }
    `);
  });

  afterEach(async () => {
    await rm(fixturesDir, {recursive: true, force: true});
  });

  it('processing using a worker works', async () => {
    const pool = new ThreadPool({userWorkerPath: dummyWorkerPath, concurrency: 2});
    const result1 = await pool.execute(join(fixturesDir, 'test.txt'));
    const result2 = await pool.execute(join(fixturesDir, 'test2.txt'));
    await pool.close();
    expect(result1).toContain('test.txt');
    expect(result2).toContain('test2.txt');
  });

  it('error propagates', async () => {
    const pool = new ThreadPool({userWorkerPath: dummyWorkerPath, concurrency: 1});
    await expect(pool.execute(join(fixturesDir, 'fail.txt'))).rejects.toThrow('boom');
    await pool.close();
  });

  it('validates concurrency strictly', async () => {
    expect(() => new ThreadPool({userWorkerPath: dummyWorkerPath, concurrency: 0})).toThrow(/Invalid concurrency value: 0\. Expected a positive integer\./);
    expect(() => new ThreadPool({userWorkerPath: dummyWorkerPath, concurrency: -5})).toThrow(/Invalid concurrency value: -5\. Expected a positive integer\./);
    expect(() => new ThreadPool({userWorkerPath: dummyWorkerPath, concurrency: 2.5})).toThrow(/Invalid concurrency value: 2.5\. Expected a positive integer\./);

    const defaultPool = new ThreadPool({userWorkerPath: dummyWorkerPath});
    expect(defaultPool.concurrency).toBeGreaterThan(0);

    const customPool = new ThreadPool({userWorkerPath: dummyWorkerPath, concurrency: 4});
    expect(customPool.concurrency).toBe(4);

    await defaultPool.close();
    await customPool.close();
  });

  it('validates maxQueue strictly', async () => {
    expect(() => new ThreadPool({userWorkerPath: dummyWorkerPath, maxQueue: 0})).toThrow(/Invalid maxQueue value: 0\. Expected a positive integer\./);
    expect(() => new ThreadPool({userWorkerPath: dummyWorkerPath, maxQueue: -10})).toThrow(/Invalid maxQueue value: -10\. Expected a positive integer\./);
    expect(() => new ThreadPool({userWorkerPath: dummyWorkerPath, maxQueue: 3.14})).toThrow(/Invalid maxQueue value: 3.14\. Expected a positive integer\./);

    const defaultPool = new ThreadPool({userWorkerPath: dummyWorkerPath});
    expect((defaultPool as any).maxQueueSize).toBeGreaterThan(0);

    const customPool = new ThreadPool({userWorkerPath: dummyWorkerPath, maxQueue: 100});
    expect((customPool as any).maxQueueSize).toBe(100);

    await defaultPool.close();
    await customPool.close();
  });

  it('continues processing queued tasks after a task-level error', async () => {
    const pool = new ThreadPool({userWorkerPath: dummyWorkerPath, concurrency: 1});

    const results = await Promise.allSettled([
      pool.execute(join(fixturesDir, 'fail.txt')),
      pool.execute(join(fixturesDir, 'ok.txt'))
    ]);

    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');

    await pool.close();
  });

  it('dispatches queued tasks to all available workers in a single pump', async () => {
    const pool = new ThreadPool({userWorkerPath: dummyWorkerPath, concurrency: 2});
    const internalPool = pool as unknown as ThreadPoolInternals;

    internalPool.taskQueue.enqueue({id: 1, filePath: 'a.txt', resolve: () => {}, reject: () => {}});
    internalPool.taskQueue.enqueue({id: 2, filePath: 'b.txt', resolve: () => {}, reject: () => {}});

    internalPool.pump();

    expect(internalPool.activeTasks).toBe(2);
    expect(internalPool.taskQueue.size).toBe(0);
    expect(internalPool.freeWorkers.length).toBe(0);

    await pool.close();
  });

  it('applies backpressure when maxQueue is reached and resumes when capacity frees up', async () => {
    const slowWorkerPath = join(__dirname, 'slow-worker.mjs');
    const pool = new ThreadPool({userWorkerPath: slowWorkerPath, concurrency: 1, maxQueue: 1});
    const internalPool = pool as any;

    const p1 = pool.execute('1.txt'); // activeTasks: 1, taskQueue: 0
    const p2 = pool.execute('2.txt'); // activeTasks: 1, taskQueue: 1 (maxQueue hit)
    const p3 = pool.execute('3.txt'); // capacityWaiters: 1

    await new Promise((r) => setImmediate(r)); // yield event loop

    expect(internalPool.capacityWaiters.size).toBe(1); // p3 is waiting
    expect(internalPool.taskQueue.size).toBe(1); // p2 is queued
    expect(internalPool.activeTasks).toBe(1); // p1 is computing

    // Now wait for everything to finish naturally
    await Promise.all([p1, p2, p3]);

    // Fast-verify unblocking occurred
    expect(internalPool.capacityWaiters.size).toBe(0);
    expect(internalPool.taskQueue.size).toBe(0);
    expect(internalPool.activeTasks).toBe(0);

    await pool.close();
  });

  it('rejects awaiting producers when pool is closed', async () => {
    const slowWorkerPath = join(__dirname, 'slow-worker.mjs');
    const pool = new ThreadPool({userWorkerPath: slowWorkerPath, concurrency: 1, maxQueue: 1});
    const internalPool = pool as any;

    const p1 = pool.execute('1.txt'); // to worker
    const p2 = pool.execute('2.txt'); // to queue
    const p3 = pool.execute('3.txt'); // to waiters

    await new Promise((r) => setImmediate(r));

    expect(internalPool.capacityWaiters.size).toBe(1);

    const closePromise = pool.close();

    await expect(p3).rejects.toThrow('ThreadPool closed');
    await expect(p2).rejects.toThrow('ThreadPool closed');

    // p1 might resolve or throw, but that depends on close() killing the worker.
    // since workers are killed, p1 is terminated and should reject.
    await expect(p1).rejects.toThrow();

    await closePromise;
  });


});

