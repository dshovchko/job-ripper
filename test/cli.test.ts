import {exec, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve, join, dirname} from 'node:path';
import {writeFile, rm, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {describe, it, expect, beforeAll, afterAll} from 'vitest';

const execAsync = promisify(exec);
// eslint-disable-next-line @typescript-eslint/naming-convention
const __filename = fileURLToPath(import.meta.url);
// eslint-disable-next-line @typescript-eslint/naming-convention
const __dirname = dirname(__filename);

const cliPath = resolve(__dirname, '../dist/cli.js');

// Helper to reliably test standard input piping
function runCliWithStdin(stdinData: string, args: string[]): Promise<{stdout: string, stderr: string, code: number | null}> {
  return new Promise((resolveReady) => {
    const child = spawn(process.execPath, [cliPath, ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolveReady({stdout, stderr, code}));

    child.stdin.write(stdinData);
    child.stdin.end();
  });
}

describe('CLI Integration', () => {
  const fixturesDir = join(__dirname, 'fixtures-cli-test');
  const workerPath = join(fixturesDir, 'worker.mjs');
  const failWorkerPath = join(fixturesDir, 'fail-worker.mjs');

  beforeAll(async () => {
    await rm(fixturesDir, {recursive: true, force: true}).catch(() => {});
    await mkdir(fixturesDir, {recursive: true});
    await writeFile(join(fixturesDir, '1.txt'), 'one');
    await writeFile(join(fixturesDir, '2.txt'), 'two');
    await writeFile(workerPath, 'export default async function() {}');
    await writeFile(failWorkerPath, 'export default async function() { throw new Error("fail"); }');
  });

  afterAll(async () => {
    await rm(fixturesDir, {recursive: true, force: true}).catch(() => {});
  });

  it('1. shows help with -h', async () => {
    try {
      await execAsync(`node ${cliPath} -h`);
      expect.fail('Should have thrown an error');
    } catch (err: any) {
      if (err.name === 'AssertionError') throw err;
      expect(err.code).toBe(1);
      expect(err.stderr).toContain('job-ripper (jori)');
    }
  });

  it('2. pipe mode: stdout only (silent stderr by default)', async () => {
    const {stdout, stderr} = await runCliWithStdin(join(fixturesDir, '1.txt') + '\n', ['-w', workerPath]);
    expect(stdout).toContain('1.txt');
    expect(stderr).not.toContain('Starting processing files');
  });

  it('3. pipe mode with --verbose: stdout AND stderr', async () => {
    const {stdout, stderr} = await runCliWithStdin(join(fixturesDir, '1.txt') + '\n', ['-w', workerPath, '--verbose']);
    expect(stdout).toContain('1.txt');
    expect(stderr).toMatch(/Using concurrency: \d+/);
    expect(stderr).toContain('Processing Complete');
  });

  it('4. --silent mode: no output at all', async () => {
    const input = join(fixturesDir, '1.txt');
    const {stdout, stderr} = await execAsync(`node ${cliPath} "${input}" -w "${workerPath}" --silent`);
    expect(stdout.trim()).toBe('');
    expect(stderr.trim()).toBe('');
  });

  it('5. interactive-like mode with --verbose', async () => {
    const input = join(fixturesDir, '1.txt');
    const {stdout, stderr} = await execAsync(`node ${cliPath} "${input}" -w "${workerPath}" --verbose`);
    expect(stdout).toContain('1.txt');
    expect(stderr).toMatch(/Using concurrency: \d+/);
  });

  it('6. concurrency reporting', async () => {
    const input = join(fixturesDir, '1.txt');
    const {stderr} = await execAsync(`node ${cliPath} "${input}" -w "${workerPath}" -c 1 --verbose`);
    expect(stderr).toContain('Using concurrency: 1');
  });

  it('7. fatal error visibility even when silent', async () => {
    const input = join(fixturesDir, '1.txt');
    try {
      await execAsync(`node ${cliPath} "${input}" -w "missing.js" --silent`);
      expect.fail('Should have thrown an error');
    } catch (err: any) {
      if (err.name === 'AssertionError') throw err;
      expect(err.stderr).toContain('[Fatal Error]');
      expect(err.code).toBe(10);
    }
  });

  it('8. backward compatibility for positional args', async () => {
    const input = join(fixturesDir, '1.txt');
    const {stdout, stderr} = await execAsync(`node ${cliPath} "${input}" "${workerPath}" --verbose`);
    expect(stdout).toContain('1.txt');
    expect(stderr).toContain('Processing Complete');
  });

  it('9. fails fast on invalid concurrency values without stack trace', async () => {
    const input = join(fixturesDir, '1.txt');
    try {
      await execAsync(`node ${cliPath} "${input}" -w "${workerPath}" -c invalid`);
      expect.fail('Should have thrown an error');
    } catch (err: any) {
      if (err.name === 'AssertionError') throw err;
      expect(err.code).toBe(1);
      expect(err.stderr).toContain('[CLI Error]: Invalid concurrency value: invalid');
      // Ensure no stack trace lines are printed for this user error
      expect(err.stderr).not.toContain('    at parseConcurrency');
    }
  });

  it('10. fails clean on missing option argument without stack trace', async () => {
    const input = join(fixturesDir, '1.txt');
    try {
      await execAsync(`node ${cliPath} "${input}" -w "${workerPath}" -c`);
      expect.fail('Should have thrown an error');
    } catch (err: any) {
      if (err.name === 'AssertionError') throw err;
      expect(err.code).toBe(1);
      expect(err.stderr).toContain('[CLI Error]: Option \'-c, --concurrency <value>\' argument missing');
      expect(err.stderr).toContain('Run \'jori --help\' for usage info.');
      // Ensure no stack trace lines are printed for this user error
      expect(err.stderr).not.toContain('    at checkOptionUsage');
    }
  });
});
