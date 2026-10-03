import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { recordRunExit, type RunExit } from './harness-incidents.js';

const [root, json, mode] = process.argv.slice(2);
if (!root || !json) throw new Error('root and exit are required');
const exit = JSON.parse(json) as RunExit;
if (mode === 'hold') {
  const db = new Database(join(root, '.incident-write-lock.sqlite'));
  db.exec('BEGIN IMMEDIATE');
  process.stdout.write('locked\n');
  // Released by a file, not a signal: SIGUSR2 handlers are not delivered reliably under Bun on macOS.
  const release = join(root, 'release-hold');
  await new Promise<void>((done) => {
    const timer = setInterval(() => { if (existsSync(release)) { clearInterval(timer); done(); } }, 20);
  });
  db.exec('COMMIT');
  db.close();
  recordRunExit(exit, root);
  process.exit(0);
} else {
  recordRunExit(exit, root);
}
