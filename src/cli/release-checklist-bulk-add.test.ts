import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { listChecklist } from '../release-loop/checklist.js';
import { registerReleaseCommands as registerReleaseCommandsImpl } from './release-cli.js';

// CHECKLIST-BULK-ADD: `add` carries body / done criterion / source, `add-bulk --file` adds many cells in one
// all-or-nothing transaction, `set` updates the content fields. Expectations are literals, not product constants.

let dir = '';
let oldTrack: string | undefined;
let out: string[] = [];
let err: string[] = [];
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'release-bulk-add-'));
  setElanousConfigDir(dir);
  oldTrack = process.env.ELANOUS_TRACK;
  process.env.ELANOUS_TRACK = 'OP';
  out = []; err = [];
  logSpy = spyOn(console, 'log').mockImplementation((line: string) => { out.push(String(line)); });
  errSpy = spyOn(console, 'error').mockImplementation((line: string) => { err.push(String(line)); });
  process.exitCode = 0;
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  process.exitCode = 0;
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

function addEventCount(): number {
  try {
    const db = new Database(join(dir, 'release', 'features.sqlite'), { readonly: true });
    try { return (db.query("SELECT COUNT(*) AS n FROM events WHERE field = 'add'").get() as { n: number }).n; }
    finally { db.close(); }
  } catch { return 0; }
}
function file(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}
const idsOf = (version: string) => listChecklist(version).items.map((item) => item.id).sort();

test('add with --body/--done/--source round-trips through list --json, and set updates and clears them', async () => {
  await run('add', 'BODY-1', 'Bulk add for cells', '--version', '0.3.40', '--body', 'Why: owners add ten cells at once', '--done', 'add-bulk of 3 rows writes 3 add events', '--source', 'msg #4242 «피처 add 도 벌크»');
  const cell = listChecklist('0.3.40').items.find((item) => item.id === 'BODY-1')!;
  expect(cell.body).toBe('Why: owners add ten cells at once');
  expect(cell.doneCriterion).toBe('add-bulk of 3 rows writes 3 add events');
  expect(cell.source).toBe('msg #4242 «피처 add 도 벌크»');

  await run('set', 'BODY-1', '--version', '0.3.40', '--done', 'criterion two', '--source', '');
  const after = listChecklist('0.3.40').items.find((item) => item.id === 'BODY-1')!;
  expect(after.doneCriterion).toBe('criterion two');
  expect(after.body).toBe('Why: owners add ten cells at once');
  expect(after.source).toBeUndefined();
});

test('add-bulk JSONL: three rows are added in one transaction with content fields', async () => {
  const path = file('cells.jsonl', [
    JSON.stringify({ id: 'BULK-A', title: 'first cell', priority: 'P0', owner: 'TC', body: 'body A', done: 'done A', source: 'quote A', refs: ['AGENTS.md'], 'deadline-version': '0.3.41', accelerator: true }),
    '',
    JSON.stringify({ id: 'BULK-B', title: 'second cell', priority: 'P1', owner: 'UX', body: 'body B' }),
    JSON.stringify({ id: 'BULK-C', title: 'third cell', predecessors: ['BULK-A'] }),
  ].join('\n'));
  await run('add-bulk', '--file', path, '--version', '0.3.40');
  expect(err).toEqual([]);
  expect(idsOf('0.3.40')).toEqual(['BULK-A', 'BULK-B', 'BULK-C']);
  expect(addEventCount()).toBe(3);
  const a = listChecklist('0.3.40').items.find((item) => item.id === 'BULK-A')!;
  expect(a.priority).toBe('P0');
  expect(a.owner).toBe('TC');
  expect(a.body).toBe('body A');
  expect(a.doneCriterion).toBe('done A');
  expect(a.source).toBe('quote A');
  expect(a.refs).toEqual(['AGENTS.md']);
  expect(a.deadlineVersion).toBe('0.3.41');
  expect(a.accelerator).toBe(true);
  expect(a.status).toBe('yellow');
  expect(out.at(-1)).toBe('✅ 합계 3칸 0.3.40 추가');
});

test('add-bulk: one bad row (and an existing id) → zero written, every bad row listed', async () => {
  await run('add', 'TAKEN', 'already here', '--version', '0.3.40');
  const before = addEventCount();
  const path = file('bad.jsonl', [
    JSON.stringify({ id: 'OK-1', title: 'fine' }),
    JSON.stringify({ id: 'BAD-P', title: 'bad priority', priority: 'P9' }),
    JSON.stringify({ id: 'TAKEN', title: 'duplicate of existing' }),
  ].join('\n'));
  await run('add-bulk', '--file', path, '--version', '0.3.40', '--json');
  const result = JSON.parse(out.at(-1)!) as { ok: boolean; added: unknown[]; errors: Array<{ row: number; id: string; errors: string[] }> };
  expect(result.ok).toBe(false);
  expect(result.added).toEqual([]);
  expect(result.errors.map((row) => [row.row, row.id])).toEqual([[2, 'BAD-P'], [3, 'TAKEN']]);
  expect(result.errors[0]!.errors[0]).toBe('잘못된 우선순위: P9');
  expect(result.errors[1]!.errors[0]).toBe('이미 있는 칸: TAKEN — set <id> 로 고친다');
  expect(process.exitCode).toBe(1);
  expect(addEventCount()).toBe(before);
  expect(idsOf('0.3.40')).toEqual(['TAKEN']);
});

test('add-bulk: duplicate id inside the same file is rejected', async () => {
  const path = file('dup.jsonl', [
    JSON.stringify({ id: 'SAME', title: 'one' }),
    JSON.stringify({ id: 'SAME', title: 'two' }),
  ].join('\n'));
  await run('add-bulk', '--file', path, '--version', '0.3.40');
  expect(err).toContain('⛔ 행 2 SAME: 같은 파일에 이미 있는 id: SAME (행 1)');
  expect(addEventCount()).toBe(0);
});

test('add-bulk --dry-run prints the plan and writes nothing', async () => {
  const path = file('plan.jsonl', [
    JSON.stringify({ id: 'DRY-1', title: 'plan one', priority: 'P2', owner: 'MK' }),
    JSON.stringify({ id: 'DRY-2', title: 'plan two' }),
  ].join('\n'));
  await run('add-bulk', '--file', path, '--version', '0.3.40', '--dry-run');
  expect(out).toEqual(['· 드라이런 DRY-1 P2 MK · plan one', '· 드라이런 DRY-2 - - · plan two', '· 드라이런 2칸 → 0.3.40 (쓰지 않음)']);
  expect(addEventCount()).toBe(0);
  expect(idsOf('0.3.40')).toEqual([]);
});

test('add-bulk parses a Markdown table (escaped pipe, <br>, comma refs, accelerator yes)', async () => {
  const path = file('cells.md', [
    '# cells to add',
    '',
    '| id | title | priority | owner | body | done | source | refs | deadline-version | accelerator |',
    '| --- | --- | :---: | --- | --- | --- | --- | --- | --- | --- |',
    '| MD-1 | table cell one | P1 | TC | line one<br>line two | rc 0 \\| exit 0 | owner said so | AGENTS.md, README.md | 0.3.41 | yes |',
    '| MD-2 | table cell two |  |  |  |  |  |  |  |  |',
  ].join('\n'));
  await run('add-bulk', '--file', path, '--version', '0.3.40');
  const items = listChecklist('0.3.40').items;
  const one = items.find((item) => item.id === 'MD-1')!;
  expect(one.title).toBe('table cell one');
  expect(one.priority).toBe('P1');
  expect(one.body).toBe('line one\nline two');
  expect(one.doneCriterion).toBe('rc 0 | exit 0');
  expect(one.source).toBe('owner said so');
  expect(one.refs).toEqual(['AGENTS.md', 'README.md']);
  expect(one.accelerator).toBe(true);
  const two = items.find((item) => item.id === 'MD-2')!;
  expect(two.priority).toBeUndefined();
  expect(two.body).toBeUndefined();
  expect(addEventCount()).toBe(2);
});
