import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { simSqliteBusy, renderSqliteBusy } from './fault-sqlite-busy.js';

test('real SQLite lock retains the failed batch and recovers it on the next write', () => {
  const observed = simSqliteBusy();
  expect(observed).toMatchObject({ busy: true, beforeRelease: 0, afterRelease: 2 });
  expect(observed.events).toEqual(['recovered', 'locked']);
  expect(renderSqliteBusy(observed).join('\n')).toContain('SQLite busy=true');
}, 20_000);

test('CLI --fault sqlite-busy renders the lock and recovery scenario', () => {
  const script = join(import.meta.dir, '..', '..', 'scripts', 'ux-sim.ts');
  const run = spawnSync(process.execPath, [script, '--fault', 'sqlite-busy'], { encoding: 'utf8', timeout: 20_000 });
  expect(run.status).toBe(0);
  expect(run.stdout).toContain('SQLite busy=true');
  expect(run.stdout).toContain('복구된 이벤트=recovered, locked');
}, 25_000);
