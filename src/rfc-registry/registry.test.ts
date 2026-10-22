import { afterEach, expect, test } from 'bun:test';
import { checklistGate } from '../release-loop/checklist.js';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { addItem, listChecklist } from '../release-loop/checklist.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRfcRegistry, listRfcs, showRfc } from './registry.js';

const roots: string[] = [];
function fixture(): string { const root = mkdtempSync(join(tmpdir(), 'rfc-registry-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const at = '2026-10-13T00:00:00.000Z';
const repo = join(import.meta.dir, '..', '..');
function cli(root: string, ...args: string[]) {
  const result = Bun.spawnSync(['bun', 'bin/elanous.mjs', '--test', '--config-dir', root, ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

test('empty DB creates the four RFC tables and immutable identifiers; event history only appends', () => {
  const root = fixture();
  const db = openRfcRegistry(root);
  try {
    expect((db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('rfc','rfc_item','rfc_item_link','rfc_event') ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name))
      .toEqual(['rfc', 'rfc_event', 'rfc_item', 'rfc_item_link']);
    expect(statSync(join(root, 'rfc/registry.sqlite')).mode & 0o777).toBe(0o600);
    expect(() => db.query('INSERT INTO rfc (id,title,status,created_at) VALUES (?,?,?,?)').run('RFC-1', 'bad', 'draft', at)).toThrow();
    db.query('INSERT INTO rfc (id,title,status,created_at) VALUES (?,?,?,?)').run('RFC-0001', 'Protocol', 'draft', at);
    expect(() => db.query('UPDATE rfc SET id = ? WHERE id = ?').run('RFC-0002', 'RFC-0001')).toThrow('immutable');
    expect(() => db.query('DELETE FROM rfc WHERE id = ?').run('RFC-0001')).toThrow('immutable');
    expect(() => db.query('INSERT INTO rfc_item (id,rfc_id,title,status,created_at) VALUES (?,?,?,?,?)').run('RFC-0002.I01', 'RFC-0001', 'wrong parent', 'open', at)).toThrow();
    expect(() => db.query('INSERT INTO rfc_item (id,rfc_id,title,status,created_at) VALUES (?,?,?,?,?)').run('RFC-0001.I1', 'RFC-0001', 'bad', 'open', at)).toThrow();
    db.query('INSERT INTO rfc_item (id,rfc_id,title,status,created_at) VALUES (?,?,?,?,?)').run('RFC-0001.I01', 'RFC-0001', 'First', 'open', at);
    expect(() => db.query('UPDATE rfc_item SET id = ? WHERE id = ?').run('RFC-0001.I02', 'RFC-0001.I01')).toThrow('immutable');
    expect(() => db.query('UPDATE rfc_item SET rfc_id = ? WHERE id = ?').run('RFC-0002', 'RFC-0001.I01')).toThrow('immutable');
    expect(() => db.query('DELETE FROM rfc_item WHERE id = ?').run('RFC-0001.I01')).toThrow('immutable');
    db.query('INSERT INTO rfc (id,title,status,created_at) VALUES (?,?,?,?)').run('RFC-0002', 'Other', 'draft', at);
    expect(() => db.query('INSERT INTO rfc_event (rfc_id,item_id,at,actor,event) VALUES (?,?,?,?,?)').run('RFC-0002', 'RFC-0001.I01', at, 'OP', 'wrong')).toThrow('belongs to another RFC');
    db.query('INSERT INTO rfc_event (rfc_id,item_id,at,actor,event,payload) VALUES (?,?,?,?,?,?)').run('RFC-0001', 'RFC-0001.I01', at, 'OP', 'created', null);
    db.query('INSERT INTO rfc_event (rfc_id,item_id,at,actor,event,payload) VALUES (?,?,?,?,?,?)').run('RFC-0001', 'RFC-0001.I01', at, 'OP', 'noted', '{}');
    expect(() => db.query('UPDATE rfc_event SET event = ? WHERE seq = 1').run('rewritten')).toThrow('append-only');
    expect(() => db.query('DELETE FROM rfc_event WHERE seq = 1').run()).toThrow('append-only');
    expect(db.query('SELECT seq,event FROM rfc_event ORDER BY seq').all()).toEqual([{ seq: 1, event: 'created' }, { seq: 2, event: 'noted' }]);
  } finally { db.close(); }
  expect(listRfcs(root)).toMatchObject([{ id: 'RFC-0001', title: 'Protocol' }, { id: 'RFC-0002', title: 'Other' }]);
});

test('CLI list/show reads the same fixture RFC and items, without changing checklist ledger', () => {
  const root = fixture();
  const db = openRfcRegistry(root);
  try {
    db.query('INSERT INTO rfc (id,title,status,doc_path,created_at) VALUES (?,?,?,?,?)').run('RFC-0001', 'Protocol', 'draft', 'docs/RFC-protocol.md', at);
    for (const [id, title] of [['RFC-0001.I01', 'First'], ['RFC-0001.I02', 'Second']])
      db.query('INSERT INTO rfc_item (id,rfc_id,title,status,created_at) VALUES (?,?,?,?,?)').run(id, 'RFC-0001', title, 'open', at);
    db.query('INSERT INTO rfc_item_link (item_id,target_item_id) VALUES (?,?)').run('RFC-0001.I01', 'RFC-0001.I02');
  } finally { db.close(); }
  const rows = listRfcs(root);
  const detail = showRfc('RFC-0001', root);
  expect(rows).toEqual([{ id: 'RFC-0001', title: 'Protocol', status: 'draft', doc_path: 'docs/RFC-protocol.md', created_at: at }]);
  expect(detail).toMatchObject({ ...rows[0], items: [
    { id: 'RFC-0001.I01', rfc_id: 'RFC-0001', title: 'First', links: [{ item_id: 'RFC-0001.I01', target_item_id: 'RFC-0001.I02' }] },
    { id: 'RFC-0001.I02', rfc_id: 'RFC-0001', title: 'Second', links: [] },
  ] });
  expect(showRfc('RFC-9999', root)).toBeNull();
  expect(cli(root, 'rfc', '--help')).toMatchObject({ code: 0, out: expect.stringContaining('show [options] <id>') });
  const listed = cli(root, 'rfc', 'list', '--json');
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.out)).toEqual(rows);
  const shown = cli(root, 'rfc', 'show', 'RFC-0001', '--json');
  expect(shown.code).toBe(0);
  expect(JSON.parse(shown.out)).toEqual(detail);
  expect(cli(root, 'rfc', 'show', 'RFC-9999').code).not.toBe(0);
  expect(existsSync(join(root, 'release/features.sqlite'))).toBe(false);
}, 120_000); // 📏 10-21: 실물 CLI spawn 셋 — 기본 5초는 부하 아래 넘친다(#29963 SKIP)

test('existing checklist rows and gate remain unchanged by RFC reads', () => {
  const root = fixture();
  setElanousConfigDir(root);
  try {
    addItem('9.9.9', { id: 'K1', title: 'original' });
    const before = listChecklist('9.9.9');
    const gateBefore = checklistGate('9.9.9');
    const result = cli(root, 'rfc', 'list', '--json');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual([]);
    expect(listChecklist('9.9.9')).toEqual(before);
    expect(checklistGate('9.9.9')).toEqual(gateBefore);
    const checklist = cli(root, 'release', 'checklist', 'list', '--version', '9.9.9', '--json');
    expect(checklist.code).toBe(0);
    expect(JSON.parse(checklist.out).items).toMatchObject([{ id: 'K1', title: 'original', status: 'yellow' }]);
  } finally { resetElanousConfigDir(); }
});
