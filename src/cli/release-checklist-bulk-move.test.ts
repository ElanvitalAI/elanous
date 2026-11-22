import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { listChecklist } from '../release-loop/checklist.js';
import { registerReleaseCommands as registerReleaseCommandsImpl } from './release-cli.js';

// RELEASE-CHECKLIST-BULK-MOVE (0.3.33): `release checklist move <ids...>` moves many cells in one process and
// one all-or-nothing transaction. Expectations below are literals, not built from product constants.

let dir = '';
let oldTrack: string | undefined;
let lines: string[] = [];
let output: ReturnType<typeof spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'release-bulk-move-'));
  setElanousConfigDir(dir);
  oldTrack = process.env.ELANOUS_TRACK;
  process.env.ELANOUS_TRACK = 'OP';
  lines = [];
  output = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(String(line)); });
});
afterEach(() => {
  output.mockRestore();
  resetElanousConfigDir();
  if (oldTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = oldTrack;
  rmSync(dir, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<void> {
  const cmd = new Command();
  cmd.exitOverride();
  registerReleaseCommandsImpl(cmd, { assertCliCurrent: () => {} }, {}, {}, {}, {}, {}, undefined, { listOpenPullRequests: () => [] });
  await cmd.parseAsync(['release', 'checklist', ...args], { from: 'user' });
}

/** Seed a version through its legacy checklist.json (imported on first read) so 300 cells cost one import. */
function seed(version: string, ids: string[]): void {
  const folder = join(dir, 'release', version);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'checklist.json'), JSON.stringify({ version, released: '0.2.6', dev: '0.2.10-dev.1',
    items: ids.map((id) => ({ id, title: `cell ${id}`, status: 'yellow', owner: 'OP', updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'OP' })),
    history: [] }));
  listChecklist(version);
}

function moveEventCount(): number {
  const db = new Database(join(dir, 'release', 'features.sqlite'), { readonly: true });
  try { return (db.query("SELECT COUNT(*) AS n FROM events WHERE field = 'move'").get() as { n: number }).n; }
  finally { db.close(); }
}
const idsOf = (version: string) => listChecklist(version).items.map((item) => item.id).sort();

test('(a) three ids move together and write three move events', async () => {
  seed('0.2.9', ['A1', 'A2', 'A3', 'KEEP']);
  await run('move', 'A1', 'A2', 'A3', '--from', '0.2.9', '--to', '0.2.10', '--reason', 'bulk carry');
  expect(idsOf('0.2.9')).toEqual(['KEEP']);
  expect(idsOf('0.2.10')).toEqual(['A1', 'A2', 'A3']);
  expect(moveEventCount()).toBe(3);
  expect(lines).toEqual(['✅ A1 0.2.9 → 0.2.10', '✅ A2 0.2.9 → 0.2.10', '✅ A3 0.2.9 → 0.2.10', '✅ 합계 3칸 0.2.9 → 0.2.10']);
  const history = listChecklist('0.2.10').history.filter((entry) => entry.field === 'move');
  expect(history.map((entry) => [entry.id, entry.from, entry.to, entry.reason])).toEqual([
    ['A1', '0.2.9', '0.2.10', 'bulk carry'], ['A2', '0.2.9', '0.2.10', 'bulk carry'], ['A3', '0.2.9', '0.2.10', 'bulk carry'],
  ]);
});

test('(b) one missing id moves nothing and the error names it', async () => {
  seed('0.2.9', ['B1', 'B2']);
  await expect(run('move', 'B1', 'GHOST', 'B2', '--from', '0.2.9', '--to', '0.2.10', '--reason', 'bulk carry')).rejects.toThrow('GHOST');
  expect(idsOf('0.2.9')).toEqual(['B1', 'B2']);
  expect(idsOf('0.2.10')).toEqual([]);
  expect(moveEventCount()).toBe(0);
  expect(lines).toEqual([]);
});

test('(b2) one id already in --to moves nothing and the error names it', async () => {
  seed('0.2.9', ['C1', 'C2']);
  seed('0.2.10', ['C2']);
  await expect(run('move', 'C1', 'C2', '--from', '0.2.9', '--to', '0.2.10', '--reason', 'bulk carry')).rejects.toThrow('이미 있는 칸: C2 — 0.2.10');
  expect(idsOf('0.2.9')).toEqual(['C1', 'C2']);
  expect(idsOf('0.2.10')).toEqual(['C2']);
  expect(moveEventCount()).toBe(0);
});

test('(c) a single id behaves as before: one line, one move event', async () => {
  seed('0.2.9', ['K1', 'OTHER']);
  await run('move', 'K1', '--from', '0.2.9', '--to', '0.2.10', '--reason', 'next cut');
  expect(lines).toEqual(['✅ K1 0.2.9 → 0.2.10']);
  expect(idsOf('0.2.9')).toEqual(['OTHER']);
  expect(idsOf('0.2.10')).toEqual(['K1']);
  expect(moveEventCount()).toBe(1);
  await expect(run('move', 'NOPE', '--from', '0.2.9', '--to', '0.2.10', '--reason', 'x')).rejects.toThrow('없는 칸: NOPE');
  await run('move', 'OTHER', '--from', '0.2.9', '--to', '0.2.10', '--reason', 'x', '--json');
  expect(JSON.parse(lines.at(-1)!).items.map((item: { id: string }) => item.id)).toEqual(['K1', 'OTHER']);
});

test('(d) 300 cells move in under 5 s in one call', async () => {
  const ids = Array.from({ length: 300 }, (_, i) => `T${String(i).padStart(3, '0')}`);
  seed('0.2.9', ids);
  const started = performance.now();
  await run('move', ...ids, '--from', '0.2.9', '--to', '0.2.10', '--reason', 'bulk carry');
  const elapsedMs = performance.now() - started;
  console.error(`bulk-move 300 cells: ${elapsedMs.toFixed(0)} ms`);
  expect(elapsedMs).toBeLessThan(5000);
  expect(listChecklist('0.2.10').items.length).toBe(300);
  expect(listChecklist('0.2.9').items.length).toBe(0);
  expect(moveEventCount()).toBe(300);
  expect(lines.at(-1)).toBe('✅ 합계 300칸 0.2.9 → 0.2.10');
});

test('ledger has indexes on events(version, seq) and evidence(feature_id, version)', async () => {
  seed('0.2.9', ['I1']);
  const db = new Database(join(dir, 'release', 'features.sqlite'), { readonly: true });
  try {
    const plan = (sql: string) => (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((row) => row.detail).join(' | ');
    expect(plan("SELECT * FROM events WHERE version = '0.2.9' ORDER BY seq")).toContain('USING INDEX');
    expect(plan("SELECT ref FROM evidence WHERE feature_id = 'I1' AND version = '0.2.9'")).toContain('USING INDEX');
  } finally { db.close(); }
});
