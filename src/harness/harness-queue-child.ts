import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';

/** Only a confirmed terminal observation allows reconciliation to release an uncertain launch. */
export function writeHarnessQueueReceipt(receiptPath: string, state: 'started' | 'finished' | 'not-started'): void {
  const temp = `${receiptPath}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify({ state, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  renameSync(temp, receiptPath);
}

export async function runHarnessQueueChild(
  receiptPath: string, command: string, args: string[],
  start: typeof spawn = spawn,
): Promise<number> {
  const record = (state: 'started' | 'finished' | 'not-started') => writeHarnessQueueReceipt(receiptPath, state);
  let child: ReturnType<typeof spawn>;
  try { child = start(process.execPath, [command, ...args], { stdio: 'inherit', env: process.env }); }
  catch { record('not-started'); return 1; }
  return await new Promise<number>((done) => {
    let started = false;
    child.once('spawn', () => {
      started = true;
      record('started');
      child.once('exit', (code) => { record('finished'); done(code ?? 1); });
    });
    child.once('error', () => {
      if (!started) { record('not-started'); done(1); }
    });
  });
}

if (import.meta.main) {
  const [receiptPath, command, ...args] = process.argv.slice(2);
  if (!receiptPath || !command) throw new Error('queue child requires receipt path and command');
  process.exitCode = await runHarnessQueueChild(receiptPath, command, args);
}
