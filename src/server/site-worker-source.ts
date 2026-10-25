/** Standalone worker. This and its dependencies are the entire unprivileged root filesystem. */
export const SITE_WORKER_SOURCE = `
import { createInterface } from 'node:readline';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
const lines = createInterface({ input: process.stdin });
const pending = new Map();
let nextId = 0;
let started = false;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
lines.on('line', async line => {
  const message = JSON.parse(line);
  if (started) {
    const call = pending.get(message.id);
    if (!call) process.exit(2);
    pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error));
    else call.resolve(message.value);
    return;
  }
  started = true;
  let exited;
  const sandbox = new CodemodeSandbox({
    timeoutMs: 60000,
    memoryLimitBytes: 32 * 1024 * 1024,
    onWorkerStarted(value) { exited = value; },
    tools: [
      { name: 'input', execute: async () => message.input },
      { name: 'request', execute: async args => new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        send({ type: 'request', id, args });
      }) },
    ],
  });
  try {
    const result = await sandbox.execute(message.code);
    send(result.ok ? { type: 'done', value: result.value ?? null } : { type: 'failed' });
  } catch {
    send({ type: 'failed' });
  } finally {
    await sandbox.close();
    await exited;
    process.exit(0);
  }
});
`;
