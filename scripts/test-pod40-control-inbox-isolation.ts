import { existsSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = join(import.meta.dir, '..');
const testDir = join(root, 'test');
const target = '../src/dashboard/slash-runtime/dashboard-handlers.test.ts';
const staleAlias = /^z-dashboard-handlers-(\d+)-[0-9a-f-]+\.test\.ts$/;

// A SIGKILL cannot run finally; remove only our known temporary symlinks whose owner is gone.
for (const name of readdirSync(testDir)) {
  const match = staleAlias.exec(name);
  if (!match || readlinkSync(join(testDir, name), { encoding: 'utf8' }) !== target) continue;
  const ownerPid = Number(match[1]);
  let ownerAlive = true;
  try { process.kill(ownerPid, 0); } catch (error) {
    ownerAlive = (error as NodeJS.ErrnoException).code === 'EPERM';
  }
  if (!ownerAlive) rmSync(join(testDir, name));
}

const alias = join(testDir, `z-dashboard-handlers-${process.pid}-${randomUUID()}.test.ts`);
if (existsSync(alias)) throw new Error(`refusing to replace existing path: ${alias}`);

let createdAlias = false;
try {
  symlinkSync(target, alias);
  createdAlias = true;
  const run = spawnSync('bun', [
    'test', '--no-isolate', '--parallel=1',
    'test/core-turn-goal-loop.test.ts',
    relative(root, alias),
  ], { cwd: root, stdio: 'inherit' });
  if (run.error) throw run.error;
  process.exitCode = run.status ?? 1;
} finally {
  if (createdAlias) rmSync(alias);
}
