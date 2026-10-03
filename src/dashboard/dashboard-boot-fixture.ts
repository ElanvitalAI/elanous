import { showDashboard } from './index.js';

const expected = process.env.DASHBOARD_BOOT_SUGGESTION;
if (!expected) throw new Error('DASHBOARD_BOOT_SUGGESTION is required');

const originalWrite = process.stdout.write.bind(process.stdout);
let screen = '';
process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
  screen += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  if (screen.includes(expected)) {
    originalWrite(`FIRST_SCREEN_SUGGESTION=${expected}\n`);
    process.exit(0);
  }
  return true;
}) as typeof process.stdout.write;

setTimeout(() => {
  originalWrite(`FIRST_SCREEN_TIMEOUT=${screen.slice(-2000)}\n`);
  process.exit(1);
}, 20_000).unref();

await showDashboard();
throw new Error('dashboard exited before suggestion appeared');
