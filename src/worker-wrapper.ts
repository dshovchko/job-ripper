/**
 * @packageDocumentation
 *
 * Worker-side wrapper executed inside every `worker_threads` thread.
 *
 * Dynamically imports the user-supplied worker script, validates that
 * it exports a default function, then listens for `'task'` messages
 * from the parent {@link ThreadPool} and invokes the handler for each
 * file path received.
 */
import {parentPort, workerData} from 'node:worker_threads';
import {pathToFileURL} from 'node:url';
import {isAbsolute, resolve} from 'node:path';

/**
 * Script path and optional extra arguments supplied by the parent
 * thread via `workerData`.
 */
const {scriptPath, workerArgs = []} = workerData as {scriptPath: string, workerArgs?: string[]};

/**
 * Sends a `'fatal'` message to the parent port and closes the
 * communication channel.
 *
 * The error is serialised into a plain object so that non-cloneable
 * values do not trigger a `DataCloneError`.
 *
 * @param port - The parent message port.
 * @param err - The error to report.
 */
function reportFatalError(port: NonNullable<typeof parentPort>, err: any): void {
  const safeError = err instanceof Error
    ? {name: err.name, message: err.message, stack: err.stack, isConfigError: (err as any).isConfigError}
    : {name: 'Error', message: String(err)};
  port.postMessage({type: 'fatal', error: safeError});
  process.exitCode = 1;
  port.close();
}

/**
 * Dynamically imports and validates the user-supplied worker script.
 *
 * The script must expose a default function export. If the module
 * cannot be found or the export is invalid, a fatal error is reported
 * to the parent and `null` is returned.
 *
 * @param port - The parent message port used for error reporting.
 * @returns The handler function, or `null` if loading failed.
 */
async function loadUserHandler(port: NonNullable<typeof parentPort>): Promise<((...args: any[]) => any) | null> {
  const absolutePath = isAbsolute(scriptPath) ? scriptPath : resolve(scriptPath);
  const url = pathToFileURL(absolutePath).href;
  let userModule;

  try {
    userModule = await import(url);
  } catch (err: any) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
      err.message = `Cannot find module '${scriptPath}'`;
      err.isConfigError = true;
    }
    reportFatalError(port, err);
    return null;
  }

  const handler = 'default' in userModule ? userModule.default : userModule;

  if (typeof handler !== 'function') {
    let foundMsg = '';
    if (!('default' in userModule) && typeof userModule !== 'function') {
      foundMsg = `module has no default export in "${scriptPath}"`;
    } else {
      const type = 'default' in userModule ? typeof userModule.default : typeof userModule;
      foundMsg = `default export is of type '${type}' in "${scriptPath}"`;
    }

    const err = new Error(`Worker must export a default function.\nFound: ${foundMsg}`);
    (err as any).isConfigError = true;
    reportFatalError(port, err);
    return null;
  }

  return handler;
}

/**
 * Bootstraps the worker thread.
 *
 * Loads the user handler, registers a `'message'` listener that
 * dispatches incoming tasks, and posts a `'ready'` signal back to
 * the parent once initialisation is complete.
 */
async function init(): Promise<void> {
  if (!parentPort) {
    throw new Error('This script must be run within a worker thread');
  }

  const handler = await loadUserHandler(parentPort);
  if (!handler) return;

  // Handle incoming tasks
  parentPort.on('message', async (message) => {
    if (message.type === 'task') {
      const {taskId, filePath} = message;
      try {
        await handler(filePath, workerArgs);
        parentPort!.postMessage({type: 'task_done', taskId, filePath});
      } catch (err: any) {
        // Serialize the error to avoid DataCloneError if user throws a non-cloneable object
        const safeError = err instanceof Error
          ? {name: err.name, message: err.message, stack: err.stack}
          : {name: 'Error', message: String(err)};
        parentPort!.postMessage({type: 'task_error', taskId, error: safeError});
      }
    } else if (message.type === 'close') {
      process.exit(0);
    }
  });

  // Signal that worker is ready
  parentPort.postMessage({type: 'ready'});
}

init();
