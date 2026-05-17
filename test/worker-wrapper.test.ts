import {Worker} from 'node:worker_threads';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// eslint-disable-next-line @typescript-eslint/naming-convention
const __filename = fileURLToPath(import.meta.url);
// eslint-disable-next-line @typescript-eslint/naming-convention
const __dirname = dirname(__filename);

const wrapperUrl = new URL('../dist/worker-wrapper.js', import.meta.url);
const fixturesDir = join(__dirname, 'fixtures-wrapper');
const validWorker = join(fixturesDir, 'valid.mjs');
const noDefaultWorker = join(fixturesDir, 'no-default.mjs');
const returningWorker = join(fixturesDir, 'returning.mjs');
const voidWorker = join(fixturesDir, 'void.mjs');

function runWrapper(scriptPath: string): {worker: Worker, messages: any[], errors: any[]} {
  const worker = new Worker(wrapperUrl, {
    workerData: {scriptPath, workerArgs: []}
  });

  const messages: any[] = [];
  const errors: any[] = [];

  worker.on('message', (m) => messages.push(m));
  worker.on('error', (e) => errors.push(e));

  return {worker, messages, errors};
}

// A helper to wait for the next message from the worker
async function waitForMessage(worker: Worker, messagesArr: any[]): Promise<any> {
  if (messagesArr.length > 0) {
    return messagesArr.shift();
  }
  return new Promise((resolve, reject) => {
    const onMessage = (msg: any) => {
      cleanup();
      // Remove from messagesArr since runWrapper also pushes it there
      const idx = messagesArr.indexOf(msg);
      if (idx !== -1) messagesArr.splice(idx, 1);
      resolve(msg);
    };
    const onError = (err: any) => {
      cleanup();
      reject(err);
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`Worker exited with code ${code} before sending a message`));
    };

    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };

    worker.once('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
  });
}

async function waitForExit(worker: Worker): Promise<number> {
  return new Promise((resolve) => {
    worker.once('exit', resolve);
  });
}

describe('Worker Wrapper', () => {
  it('1. should emit "ready" when loaded with a valid script', async () => {
    const {worker, messages} = runWrapper(validWorker);

    const msg = await waitForMessage(worker, messages);
    expect(msg).toEqual({type: 'ready'});

    await worker.terminate();
  });

  it('2. should process a task successfully', async () => {
    const {worker, messages} = runWrapper(validWorker);
    await waitForMessage(worker, messages); // wait for ready

    worker.postMessage({type: 'task', taskId: 1, filePath: 'test.txt'});

    const finishMsg = await waitForMessage(worker, messages);
    expect(finishMsg).toEqual({
      type: 'task_done',
      taskId: 1,
      filePath: 'test.txt',
      result: 'ok'
    });

    await worker.terminate();
  });

  it('3. should emit "fatal" if the user script does not exist', async () => {
    const {worker, messages} = runWrapper(join(fixturesDir, 'does-not-exist.mjs'));

    const failMsg = await waitForMessage(worker, messages);
    expect(failMsg.type).toBe('fatal');
    // Error object passed through postMessage loses code property in some environments
    // or when not explicitly copied. Let's check the message instead.
    expect(failMsg.error.message).toMatch(/Cannot find (module|package)/i);
    expect(await waitForExit(worker)).toBe(1);
  });

  it('4. should emit "fatal" if the user script does not export a default function', async () => {
    const {worker, messages} = runWrapper(noDefaultWorker);

    const failMsg = await waitForMessage(worker, messages);
    expect(failMsg.type).toBe('fatal');
    expect(failMsg.error.message).toContain('must export a default function');
    expect(await waitForExit(worker)).toBe(1);
  });

  it('5. should include worker return value in task_done message', async () => {
    const {worker, messages} = runWrapper(returningWorker);
    await waitForMessage(worker, messages); // wait for ready

    worker.postMessage({type: 'task', taskId: 1, filePath: 'test.txt'});

    const finishMsg = await waitForMessage(worker, messages);
    expect(finishMsg.type).toBe('task_done');
    expect(finishMsg.taskId).toBe(1);
    expect(finishMsg.filePath).toBe('test.txt');
    expect(finishMsg.result).toEqual({transformed: 'test.txt', size: 42});

    await worker.terminate();
  });

  it('6. should include undefined result when worker returns nothing', async () => {
    const {worker, messages} = runWrapper(voidWorker);
    await waitForMessage(worker, messages); // wait for ready

    worker.postMessage({type: 'task', taskId: 1, filePath: 'test.txt'});

    const finishMsg = await waitForMessage(worker, messages);
    expect(finishMsg.type).toBe('task_done');
    expect(finishMsg.result).toBeUndefined();

    await worker.terminate();
  });
});
