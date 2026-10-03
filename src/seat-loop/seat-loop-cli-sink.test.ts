// V3 F5 — `seat loop` must land its judgment lines in the log store. Entry-point change ⇒ verified by a real spawn
// (an in-process import can't tell whether the CLI path registers the sink).
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writePersonaTodos } from '../persona/persona-todo.js';

const cli = resolve(import.meta.dir, '../../bin/elanous.mjs');

test('seat loop CLI keeps its seat result while an opt-in shadows two personas; off writes none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seat-persona-cli-'));
  try {
    const personas = join(dir, 'personas');
    mkdirSync(personas);
    for (const id of ['alice', 'bob']) {
      writeFileSync(join(personas, `${id}.yaml`), `personaId: ${id}\ndisplayName: ${id}\nsystemPrompt: You are ${id}.\n`);
      writePersonaTodos(personas, id, [{ id: `${id}-work`, title: `${id} work`, status: 'open', createdAt: '2026-10-01T00:00:00Z' }]);
    }
    const { NODE_ENV: _testEnv, ...parentEnv } = process.env;
    const env = { ...parentEnv, ELANOUS_STATE_DIR: dir, ELANOUS_CONFIG_DIR: dir };
    const run = () => spawnSync('bun', [cli, `--test=${dir}`, 'seat', 'loop', '--seat', 'TC', '--once', '--json'], { encoding: 'utf8', env, timeout: 180_000 });
    const config = (enabled: boolean) => writeFileSync(join(dir, 'config.json'), JSON.stringify({ loops: { seat: { mode: 'off' }, persona: { enabled } } }));
    config(false);
    const off = run();
    expect(off.status).toBe(0);
    expect(JSON.parse(off.stdout)).toEqual({ seat: 'TC', status: 'skipped-off' });
    expect(existsSync(join(dir, 'persona-loop'))).toBe(false);
    config(true);
    const on = run();
    expect(on.status).toBe(0);
    expect(JSON.parse(on.stdout)).toEqual(JSON.parse(off.stdout));
    for (const id of ['alice', 'bob']) {
      const path = join(dir, 'persona-loop', id);
      const files = readdirSync(path);
      expect(files).toHaveLength(1);
      expect(readFileSync(join(path, files[0]!), 'utf8').trim().split('\n').map((line) => JSON.parse(line)))
        .toMatchObject([{ personaId: id, status: 'shadow', todo: { id: `${id}-work` } }]);
    }
    expect(existsSync(join(dir, 'seat-loop'))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 300_000);

test('seat loop --once writes seat.loop lines that `logs --category seat.loop` can read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seat-loop-sink-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ loops: { seat: { mode: 'shadow', seats: ['TC'] } } }));
    // NODE_ENV=test (bun test) turns the log sink off — the child must run like cron does.
    const { NODE_ENV: _testEnv, ...parentEnv } = process.env;
    const env = { ...parentEnv, ELANOUS_STATE_DIR: dir, ELANOUS_CONFIG_DIR: dir };
    const run = spawnSync('bun', [cli, `--test=${dir}`, 'seat', 'loop', '--seat', 'TC', '--once', '--json'], { encoding: 'utf8', env, timeout: 180_000 });
    expect(run.status).toBe(0);
    const logs = spawnSync('bun', [cli, `--test=${dir}`, 'logs', '--config-dir', dir, '--category', 'seat.loop', '--event', 'shadow', '--since', '1h', '--json'], { encoding: 'utf8', env, timeout: 120_000 });
    expect(logs.status).toBe(0);
    expect(logs.stdout).toContain('"category":"seat.loop"');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ loops: { seat: { mode: 'shadow', seats: ['OP'] } } }));
    const op = spawnSync('bun', [cli, `--test=${dir}`, 'seat', 'loop', '--seat', 'OP', '--once', '--json'], { encoding: 'utf8', env, timeout: 180_000 });
    expect(op.status).toBe(0);
    const judgments = spawnSync('bun', [cli, `--test=${dir}`, 'logs', '--config-dir', dir, '--category', 'seat.loop', '--event', 'op-judgment-shadow', '--since', '1h', '--json'], { encoding: 'utf8', env, timeout: 120_000 });
    expect(judgments.status).toBe(0);
    expect(judgments.stdout).toContain('"category":"seat.loop"');
    expect(judgments.stdout).toContain('op-judgment-shadow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 300_000);
