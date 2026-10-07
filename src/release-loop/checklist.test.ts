import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { debug } from '../debug/log.js';
import { CliUserError } from '../cli/cli-user-error.js';
import { addItem, cellsReferencingDoc, claimItem, checklistGate, checklistHistory, devVersion, listChecklist, normalizeRefs, ownerMatches, parseOwner, parityGap, refRoots, removeItem, renderRefsStatus, seedFromRoadmap, setItem, summarize, summarizeChecklist } from './checklist.js';
import * as features from './feature-store.js';

const roots: string[] = [];
function root(): string { const dir = mkdtempSync(join(tmpdir(), 'release-checklist-')); roots.push(dir); setElanousConfigDir(dir); return dir; }
afterEach(() => { resetElanousConfigDir(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('release checklist ledger', () => {
  test('refs: --ref adds real repo documents once, rejects missing paths, and stays absent on cells without refs', () => {
    root();
    addItem('0.2.18', { id: 'R1', title: 'refs cell', refs: ['package.json'] });
    addItem('0.2.18', { id: 'R0', title: 'no refs' });
    setItem('0.2.18', 'R1', { refs: ['package.json', 'src/release-loop/checklist.ts#normalizeRefs', 'src/release-loop/checklist.ts#normalizeRefs'] }, 'MK');
    expect(listChecklist('0.2.18').items.find((item) => item.id === 'R1')?.refs).toEqual(['package.json', 'src/release-loop/checklist.ts#normalizeRefs']);
    expect(listChecklist('0.2.18').history.filter((entry) => entry.id === 'R1' && entry.field === 'refs')).toHaveLength(1);
    const before = JSON.stringify(listChecklist('0.2.18').items.find((item) => item.id === 'R1'));
    expect(() => setItem('0.2.18', 'R1', { refs: ['docs/no-such-doc.md'] }, 'MK')).toThrow(CliUserError);
    expect(() => setItem('0.2.18', 'R1', { refs: ['../outside.md'] }, 'MK')).toThrow(CliUserError);
    expect(() => setItem('0.2.18', 'R1', { refs: ['src/../package.json'] }, 'MK')).toThrow(CliUserError);
    expect(() => setItem('0.2.18', 'R1', { refs: ['src'] }, 'MK')).toThrow(CliUserError);
    expect(JSON.stringify(listChecklist('0.2.18').items.find((item) => item.id === 'R1'))).toBe(before);
    expect(Object.keys(listChecklist('0.2.18').items.find((item) => item.id === 'R0')!)).not.toContain('refs');
  });

  test('cellsReferencingDoc derives one row per citing cell across versions, matches #section exactly, and never writes', () => {
    root();
    addItem('0.2.18', { id: 'A', title: 'a', refs: ['package.json#§1'] });
    addItem('0.2.19', { id: 'B', title: 'b', refs: ['package.json'] });
    addItem('0.2.18', { id: 'C', title: 'c' });
    addItem('0.2.18', { id: 'D', title: 'd', refs: ['src/release-loop/checklist.ts'] });
    const historyBefore = listChecklist('0.2.18').history.length;
    const snapshots = () => [listChecklist('0.2.18'), listChecklist('0.2.19')];
    const keys = (rows: ReturnType<typeof cellsReferencingDoc>) => rows.map(({ version, id, section }) => [version, id, section]);
    const rows = cellsReferencingDoc('package.json', snapshots());
    expect(keys(rows)).toEqual([['0.2.18', 'A', '§1'], ['0.2.19', 'B', null]]);
    expect(rows[0]).toMatchObject({ title: 'a', status: 'yellow', owner: null });
    expect(keys(cellsReferencingDoc('package.json#§1', snapshots()))).toEqual([['0.2.18', 'A', '§1']]);
    expect(cellsReferencingDoc('docs/no-such-doc.md', snapshots())).toEqual([]);
    const lines = renderRefsStatus(rows).split('\n');
    expect(lines[0]).toBe('| 판 | 칸 | 상태 | 절 | 제목 |');
    expect(lines.slice(2)).toEqual(['| 0.2.18 | A | yellow | §1 | a |', '| 0.2.19 | B | yellow | - | b |']);
    expect(listChecklist('0.2.18').history.length).toBe(historyBefore);
  });

  test('cellsReferencingDoc keeps one row per cell when a cell cites several sections of the same document', () => {
    root();
    addItem('0.2.18', { id: 'M', title: 'multi', refs: ['package.json#§1', 'package.json#§2', 'src/release-loop/checklist.ts'] });
    addItem('0.2.18', { id: 'W', title: 'whole', refs: ['package.json#§3', 'package.json'] });
    const rows = cellsReferencingDoc('package.json', [listChecklist('0.2.18')]);
    expect(rows.map(({ id, section }) => [id, section])).toEqual([['M', '§1 · §2'], ['W', null]]);
    expect(cellsReferencingDoc('package.json#§2', [listChecklist('0.2.18')]).map(({ id, section }) => [id, section])).toEqual([['M', '§2']]);
  });

  test('checklistHistory unifies cross-version moves, timestamps and reasons without mixing ids', () => {
    const dir = root();
    expect(checklistHistory('K1')).toEqual([]);
    addItem('0.2.9', { id: 'K1', title: 'carry' });
    addItem('0.2.9', { id: 'OTHER', title: 'unrelated' });
    setItem('0.2.9', 'K1', { evidence: '#first' }, 'TC');
    features.move('K1', '0.2.9', '0.2.10', 'OP', '', '', 'next cut');
    setItem('0.2.10', 'K1', { evidence: '#revised' }, 'TC');
    features.move('K1', '0.2.10', '0.2.11', 'OP', '', '', 'needs more work');
    const entries = checklistHistory('K1');
    expect(entries.map((entry) => [entry.version, entry.field])).toEqual([
      ['0.2.9', 'add'], ['0.2.9', 'evidence'], ['0.2.10', 'move'], ['0.2.10', 'evidence'], ['0.2.11', 'move'],
    ]);
    expect(entries.filter((entry) => entry.field === 'move').map(({ from, to, at, reason }) => ({ from, to, at, reason }))).toEqual([
      { from: '0.2.9', to: '0.2.10', at: expect.any(String), reason: 'next cut' },
      { from: '0.2.10', to: '0.2.11', at: expect.any(String), reason: 'needs more work' },
    ]);
    expect(entries.every((entry) => entry.id === 'K1' && !Number.isNaN(Date.parse(entry.at)))).toBe(true);
    expect(entries.every((entry, index) => index === 0 || entry.at >= entries[index - 1]!.at)).toBe(true);
    expect(listChecklist('0.2.11').history.at(-1)).toMatchObject({ field: 'move', reason: 'needs more work' });
    expect(checklistHistory('OTHER').map((entry) => entry.field)).toEqual(['add']);
    const db = new Database(join(dir, 'release/features.sqlite'));
    try {
      expect(db.query('SELECT reason FROM events WHERE feature_id = ? AND field = ? ORDER BY seq').all('K1', 'move'))
        .toEqual([{ reason: 'next cut' }, { reason: 'needs more work' }]);
    } finally { db.close(); }
    expect(checklistHistory('K1')).toEqual(entries);
  });

  test('짝 판정 문면과 조건을 보존하고 짝 경고만으로 gate ok 를 바꾸지 않는다', () => {
    root();
    const valid = '짝: PWA ✅ · 데스크톱 ✅ · 폴드 ✅ · 아이폰 ✅ · 아이패드 ✅';
    expect(parityGap(undefined)).toBe('근거에 짝: 줄이 없다');
    expect(parityGap('짝: PWA ✅')).toBe('짝: 줄에 다섯 열(PWA · 데스크톱 · 폴드 · 아이폰 · 아이패드)이 다 없다');
    expect(parityGap('짝: PWA ⏳ · 데스크톱 ✅ · 폴드 ✅ · 아이폰 ✅ · 아이패드 ✅')).toBe('⏳ 에 (칸 …) 번호가 없다: PWA');
    expect(parityGap('짝: PWA ⏳ (칸 K2) · 데스크톱 ✅ · 폴드 ✅ · 아이폰 ✅ · 아이패드 ✅')).toBeNull();
    expect(parityGap(valid)).toBeNull();
    addItem('9.9.9', { id: 'K1', title: 'screen', kind: 'screen' });
    setItem('9.9.9', 'K1', { status: 'green' }, 'TC');
    expect(checklistGate('9.9.9')).toMatchObject({ ok: true, parity: [{ id: 'K1', why: '근거에 짝: 줄이 없다' }] });
    setItem('9.9.9', 'K1', { evidence: valid }, 'TC');
    expect(checklistGate('9.9.9')).toMatchObject({ ok: true, parity: [] });
  });

  test('입력 오류 여덟 곳은 문구를 보존하고 이미/없는 칸에만 hint를 제공한다', () => {
    root();
    const expectInputError = (run: () => unknown, message: string, hint?: string) => {
      let caught: unknown;
      try { run(); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(CliUserError);
      expect((caught as CliUserError).message).toBe(message);
      expect((caught as CliUserError).hint).toBe(hint);
    };
    expectInputError(() => listChecklist('bad'), '체크리스트 판이 아니다: bad');
    expectInputError(() => addItem('9.9.9', { id: ' ', title: 'title' }), '칸 id 가 비었다');
    expectInputError(() => addItem('9.9.9', { id: 'K1', title: ' ' }), '칸 제목이 비었다');
    addItem('9.9.9', { id: 'K1', title: 'first' });
    expectInputError(() => addItem('9.9.9', { id: 'K1', title: 'again' }), '이미 있는 칸: K1', 'set <id> 로 고친다');
    expectInputError(() => setItem('9.9.9', 'absent', { status: 'red' }, 'T'), '없는 칸: absent', 'list 로 칸 목록을 본다');
    expectInputError(() => setItem('9.9.9', 'K1', { status: 'invalid' as 'red' }, 'T'), '잘못된 상태: invalid');
    expectInputError(() => setItem('9.9.9', 'K1', { disposition: 'invalid' as 'move' }, 'T'), '잘못된 처분: invalid');
    expectInputError(() => removeItem('9.9.9', 'absent', 'T'), '없는 칸: absent', 'list 로 칸 목록을 본다');
    expect(listChecklist('9.9.9').items.map((item) => item.id)).toEqual(['K1']);
  });

  test('실물 로드맵 씨앗: K 전체·첫 이모지·K4 변경과 재씨앗 불변', () => {
    const dir = root();
    const markdown = readFileSync(join(import.meta.dir, '..', '..', 'docs/ROADMAP-releases-0.2.5-and-0.2.6-2026-09-29.md'), 'utf8');
    // Independent table-cell extraction: do not copy the seeder's K-id regex into the oracle.
    const expected = markdown.split('\n').map((line) => line.split('|').map((cell) => cell.trim()))
      .filter((cells) => cells.length >= 5 && cells[0] === '' && cells[1]?.startsWith('K') && /^K[0-9]/.test(cells[1]))
      .map((cells) => cells[1]!);
    const seeded = seedFromRoadmap('0.2.5', markdown);
    expect(seeded.items.length).toBe(expected.length);
    expect(seeded.items.map((i) => i.id)).toEqual(expected);
    expect(expected).toEqual(expect.arrayContaining(['K1', 'K12', 'K8a', 'K8b', 'K8d′']));
    expect(seeded.items.find((i) => i.id === 'K4')?.status).toBe('red');
    expect(seeded.items.find((i) => i.id === 'K2')?.status).toBe('done');
    expect(seeded.items.find((i) => i.id === 'K3')?.status).toBe('yellow');
    const before = summarize('0.2.5');
    setItem('0.2.5', 'K4', { status: 'green', evidence: '#99999' }, 'T');
    const after = summarize('0.2.5');
    expect(after.green).toBe(before.green + 1);
    expect(after.red).toBe(before.red - 1);
    expect(listChecklist('0.2.5').history.slice(-2)).toMatchObject([
      { by: 'T', id: 'K4', field: 'evidence', to: '#99999' },
      { by: 'T', id: 'K4', field: 'status', from: 'red', to: 'green', dev: devVersion() },
    ]);
    seedFromRoadmap('0.2.5', markdown);
    expect(listChecklist('0.2.5').items.find((i) => i.id === 'K4')).toMatchObject({ status: 'green', evidence: '#99999' });
    expect(statSync(join(dir, 'release/features.sqlite')).mode & 0o777).toBe(0o600);
    expect(seedFromRoadmap('0.2.5', '| K99 | 새 칸 | 🟡 대기 |').released).toBe('');
    expect(seedFromRoadmap('0.2.5', '| K98 | 상태 미상 | 대기 |').items.find((i) => i.id === 'K98')?.status).toBe('yellow');
  });

  test('동시 CLI 작성자가 각자 읽기·수정·쓰기를 원자화해 변경과 history를 모두 보존한다', async () => {
    const dir = root();
    const script = `import { setElanousConfigDir } from './src/elanous-config-dir.ts'; import { addItem } from './src/release-loop/checklist.ts'; setElanousConfigDir(process.argv[1]); for (let n = 0; n < 12; n++) addItem('9.9.9', { id: process.argv[2] + n, title: 'parallel' });`;
    const children = ['A', 'B', 'C', 'D'].map((actor) => Bun.spawn(['bun', '-e', script, dir, actor], { cwd: join(import.meta.dir, '..', '..'), stdout: 'pipe', stderr: 'pipe' }));
    const results = await Promise.all(children.map(async (child) => ({ exit: await child.exited, stderr: await new Response(child.stderr).text() })));
    expect(results).toEqual(Array.from({ length: 4 }, () => ({ exit: 0, stderr: '' })));
    const data = listChecklist('9.9.9');
    expect(data.items.map((item) => item.id).sort()).toEqual(['A', 'B', 'C', 'D'].flatMap((actor) => Array.from({ length: 12 }, (_, n) => `${actor}${n}`)).sort());
    expect(data.history.map((entry) => entry.id).sort()).toEqual(data.items.map((item) => item.id).sort());
    expect(statSync(join(dir, 'release/features.sqlite')).mode & 0o777).toBe(0o600);
  }, 15_000);

  test('옛 JSON을 수입한 판은 다른 프로세스의 BEGIN IMMEDIATE 동안에도 listChecklist가 잠금 해제 전 스냅샷을 준다', async () => {
    const dir = root();
    const version = '9.9.9';
    const path = join(dir, 'release', version);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'checklist.json'), JSON.stringify({ version, released: '', dev: devVersion(), items: [
      { id: 'K1', title: '수입한 칸', status: 'yellow', updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'OP' },
    ], history: [] }));
    expect(listChecklist(version).items[0]?.title).toBe('수입한 칸');
    const lockScript = `import { Database } from 'bun:sqlite'; import { join } from 'node:path'; const db = new Database(join(process.argv[1], 'release/features.sqlite')); db.exec('BEGIN IMMEDIATE'); db.query('UPDATE assignments SET status = ? WHERE feature_id = ? AND version = ?').run('red', 'K1', '9.9.9'); process.stdout.write('locked\\n'); setInterval(() => {}, 1000);`;
    const holder = Bun.spawn(['bun', '-e', lockScript, dir], { cwd: join(import.meta.dir, '..', '..'), stdout: 'pipe', stderr: 'pipe' });
    try {
      const reader = holder.stdout.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value).trim()).toBe('locked');
      reader.releaseLock();
      const snapshot = listChecklist(version);
      expect(holder.exitCode).toBeNull();
      expect(snapshot.items).toMatchObject([{ id: 'K1', status: 'yellow', title: '수입한 칸' }]);
    } finally { holder.kill(); await holder.exited; }
    expect(listChecklist(version).items[0]?.status).toBe('yellow');
  }, 8000);

  test('살아 있는 작성자의 잠금이 같은 판의 addItem을 막고 종료 뒤 해제된다', async () => {
    const dir = root();
    const cwd = join(import.meta.dir, '..', '..');
    const lockScript = `import { Database } from 'bun:sqlite'; import { join } from 'node:path'; const db = new Database(join(process.argv[1], 'release/features.sqlite'), { create: true }); db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked\\n'); setInterval(() => { if (!db.inTransaction) throw new Error('lock lost'); }, 1000);`;
    const writeScript = `import { setElanousConfigDir } from './src/elanous-config-dir.ts'; import { addItem } from './src/release-loop/checklist.ts'; setElanousConfigDir(process.argv[1]); addItem('9.9.9', { id: 'K1', title: 'recover' }); process.stdout.write('written\\n');`;
    listChecklist('9.9.9'); // Initialize the WAL database before the competing writer holds its transaction.
    const holder = Bun.spawn(['bun', '-e', lockScript, dir], { cwd, stdout: 'pipe', stderr: 'pipe' });
    let writer: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const reader = holder.stdout.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value).trim()).toBe('locked');
      reader.releaseLock();
      expect(holder.exitCode).toBeNull();
      writer = Bun.spawn(['bun', '-e', writeScript, dir], { cwd, stdout: 'pipe', stderr: 'pipe' });
      const whileLocked = await Promise.race([writer.exited.then((code) => `exited ${code}`), Bun.sleep(500).then(() => 'waiting')]);
      expect(whileLocked).toBe('waiting');
      expect(listChecklist('9.9.9').items).toEqual([]);
      holder.kill();
      await holder.exited;
      expect(await Promise.race([writer.exited, Bun.sleep(4000).then(() => -1)])).toBe(0);
      expect(writer.stdout instanceof ReadableStream ? await new Response(writer.stdout).text() : '').toBe('written\n');
      expect(listChecklist('9.9.9').items.map((item) => item.id)).toEqual(['K1']);
      expect(listChecklist('9.9.9').history).toHaveLength(1);
    } finally {
      holder.kill();
      await holder.exited;
      if (writer) { writer.kill(); await writer.exited; }
    }
  }, 8000);

  test('집계는 전달된 스냅샷만 사용하고 이후 갱신의 수치를 섞지 않는다', () => {
    root();
    addItem('9.9.9', { id: 'K1', title: '처음' });
    const snapshot = listChecklist('9.9.9');
    setItem('9.9.9', 'K1', { status: 'red' }, 'T');
    expect(summarizeChecklist(snapshot)).toMatchObject({ yellow: 1, red: 0, blocked: [] });
    expect(summarize('9.9.9')).toMatchObject({ yellow: 0, red: 1, blocked: ['K1'] });
  });

  test('옛 담당자 이름도 재검증 없이 독립적으로 집계한다', () => {
    const dir = root();
    const version = '9.9.9';
    mkdirSync(join(dir, 'release', version), { recursive: true });
    writeFileSync(join(dir, 'release', version, 'checklist.json'), JSON.stringify({ version, released: '', dev: devVersion(), items:
      ['toString', '__proto__', 'constructor'].map((name) => ({ id: name, title: name, owner: name, status: 'yellow', updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'OP' })), history: [] }));
    const counts = summarize(version).byOwner;
    expect(Object.getPrototypeOf(counts)).toBeNull();
    expect(counts['toString']).toBe(1);
    expect(counts['__proto__']).toBe(1);
    expect(counts['constructor']).toBe(1);
    expect(JSON.parse(JSON.stringify(counts))).toEqual(JSON.parse('{"toString":1,"__proto__":1,"constructor":1}'));
  });

  test('새 owner 문법만 검사하고 잘못된 add/set 은 원장을 바꾸지 않으며 옛 owner 는 증거 갱신 때 보존한다', () => {
    const dir = root();
    expect(parseOwner('TC')).toEqual({ seat: 'TC' });
    expect(parseOwner('TC/rel')).toEqual({ seat: 'TC', sub: 'rel' });
    expect(parseOwner('ABCDEFGH/' + 'a'.repeat(32))).toEqual({ seat: 'ABCDEFGH', sub: 'a'.repeat(32) });
    for (const invalid of ['tc/Rel', 'TC/', 'T', 'ABCDEFGHI', 'TC/Rel', 'TC/' + 'a'.repeat(33), 'TC\n', 'TC/rel\n']) {
      expect(() => parseOwner(invalid)).toThrow(CliUserError);
      expect(() => addItem('9.9.9', { id: invalid, title: 'bad', owner: invalid })).toThrow(CliUserError);
    }
    expect(listChecklist('9.9.9').items).toEqual([]);
    addItem('9.9.9', { id: 'K1', title: 'valid', owner: 'TC/rel' });
    expect(listChecklist('9.9.9').items[0]?.owner).toBe('TC/rel');
    const before = listChecklist('9.9.9');
    expect(() => setItem('9.9.9', 'K1', { owner: 'TC/' }, 'TC')).toThrow(CliUserError);
    expect(listChecklist('9.9.9')).toEqual(before);
    expect(() => setItem('9.9.9', 'K1', { owner: 'TC/docs', evidence: 'ignored' }, 'TC')).toThrow('지금 주인: TC/rel — --force 로만 바꾼다');
    expect(listChecklist('9.9.9')).toEqual(before);
    mkdirSync(join(dir, 'release', '8.8.8'), { recursive: true });
    writeFileSync(join(dir, 'release', '8.8.8', 'checklist.json'), JSON.stringify({ version: '8.8.8', released: '', dev: devVersion(), items: [
      { id: 'OLD', title: 'legacy', status: 'yellow', owner: 'TC·UX', updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'T' },
    ], history: [] }));
    setItem('8.8.8', 'OLD', { evidence: 'verified' }, 'TC');
    expect(listChecklist('8.8.8').items[0]).toMatchObject({ owner: 'TC·UX', evidence: 'verified' });
  });

  test('옛 잘못된 owner 는 원문 byOwner 에만 남고 자리별 집계·필터에는 들어가지 않는다', () => {
    const dir = root();
    const version = '8.8.8';
    mkdirSync(join(dir, 'release', version), { recursive: true });
    const owners = ['TC', 'TC/rel', 'TC/', 'TC/rel/extra', 'TC\n', 'TC·UX'];
    writeFileSync(join(dir, 'release', version, 'checklist.json'), JSON.stringify({ version, released: '', dev: devVersion(), items:
      owners.map((owner, i) => ({ id: `K${i}`, title: owner, owner, status: 'yellow', updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'OP' })), history: [] }));
    const snapshot = listChecklist(version);
    expect(snapshot.items.map((item) => item.owner)).toEqual(owners);
    expect(summarizeChecklist(snapshot).byOwner).toEqual(Object.fromEntries(owners.map((owner) => [owner, 1])));
    expect(summarizeChecklist(snapshot).bySeat).toEqual({ TC: 2 });
    expect(snapshot.items.filter((item) => ownerMatches(item.owner, 'TC')).map((item) => item.id)).toEqual(['K0', 'K1']);
    expect(snapshot.items.filter((item) => ownerMatches(item.owner, 'TC/rel')).map((item) => item.id)).toEqual(['K1']);
  });

  test('claim 은 무주인·상위 자리만 양도하고 타인 거부는 원자적이며 강제는 이력과 관측에 남긴다', () => {
    root();
    const version = '9.9.9';
    addItem(version, { id: 'A', title: 'parent', owner: 'TC' });
    addItem(version, { id: 'B', title: 'sibling', owner: 'TC/rel' });
    addItem(version, { id: 'C', title: 'other', owner: 'MK' });
    addItem(version, { id: 'D', title: 'unassigned' });
    const logs: unknown[] = [];
    const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category === 'release-loop.checklist' && event === 'claim') logs.push(data);
    });
    try {
      claimItem(version, 'A', 'TC/rel');
      expect(listChecklist(version).history.at(-1)).toMatchObject({ field: 'claim', from: 'TC', to: 'TC/rel' });
      const same = listChecklist(version);
      claimItem(version, 'A', 'TC/rel');
      expect(listChecklist(version)).toEqual(same);
      for (const [id, by, current] of [['B', 'TC/docs', 'TC/rel'], ['C', 'TC/rel', 'MK'], ['A', 'TC', 'TC/rel']] as const) {
        const previous = listChecklist(version);
        expect(() => claimItem(version, id, by)).toThrow(`지금 주인: ${current} — --force 로만 바꾼다`);
        expect(listChecklist(version)).toEqual(previous);
      }
      const forced = claimItem(version, 'C', 'TC/rel', { force: true });
      expect(forced.history.at(-1)).toMatchObject({ field: 'claim', from: 'MK', to: 'TC/rel', force: true });
      expect(listChecklist(version).items.find((item) => item.id === 'C')?.owner).toBe('TC/rel');
      expect(listChecklist(version).history.at(-1)).toMatchObject({ field: 'claim', from: 'MK', to: 'TC/rel', force: true });
      const afterSet = setItem(version, 'C', { evidence: 'verified' }, 'TC');
      expect(afterSet.history.find((entry) => entry.id === 'C' && entry.field === 'claim')).toMatchObject({ to: 'TC/rel', force: true });
      const afterAdd = addItem(version, { id: 'E', title: 'later' });
      expect(afterAdd.history.find((entry) => entry.id === 'C' && entry.field === 'claim')).toMatchObject({ to: 'TC/rel', force: true });
      removeItem(version, 'E', 'TC');
      claimItem(version, 'D', 'UX');
      expect(listChecklist(version).items.find((item) => item.id === 'D')?.owner).toBe('UX');
      expect(listChecklist(version).history.at(-1)).toMatchObject({ field: 'claim', from: null, to: 'UX' });
      expect(summarize(version)).toMatchObject({ byOwner: { 'TC/rel': 3, UX: 1 }, bySeat: { TC: 3, UX: 1 } });
      expect(logs).toContainEqual({ version, id: 'A', from: 'TC', to: 'TC/rel', force: false, outcome: 'claimed' });
      expect(logs).toContainEqual({ version, id: 'A', from: 'TC/rel', to: 'TC/rel', force: false, outcome: 'same' });
      expect(logs).toContainEqual({ version, id: 'B', from: 'TC/rel', to: 'TC/docs', force: false, outcome: 'refused' });
      expect(logs).toContainEqual({ version, id: 'C', from: 'MK', to: 'TC/rel', force: true, outcome: 'claimed' });
    } finally { spy.mockRestore(); }
  });

  test('추가·변경별 역사·삭제, 0600 교체와 공개/개발판 스냅샷', () => {
    const dir = root();
    for (const v of ['0.2.4', '0.10.0', '0.3.0']) {
      mkdirSync(join(dir, 'release', v), { recursive: true });
      writeFileSync(join(dir, 'release', v, 'release.json'), JSON.stringify({ version: v, publishedAt: 'now' }));
    }
    expect(listChecklist('9.9.9').released).toBe('0.10.0');
    const seen: unknown[] = [];
    const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => { if (category === 'release-loop.checklist' && event === 'change') seen.push(data); });
    try {
      addItem('9.9.9', { id: 'K1', title: '첫 칸', owner: 'TC' });
      expect(() => addItem('9.9.9', { id: 'K1', title: '중복' })).toThrow('이미 있는 칸');
      setItem('9.9.9', 'K1', { status: 'red', evidence: 'issue' }, 'T');
      expect(summarize('9.9.9')).toEqual({ green: 0, yellow: 0, red: 1, done: 0, blocked: ['K1'], byOwner: { TC: 1 }, bySeat: { TC: 1 } });
      const data = listChecklist('9.9.9');
      expect(data).toMatchObject({ released: '0.10.0', dev: devVersion() });
      expect(data.history.map((h) => h.field)).toEqual(['add', 'evidence', 'status']);
      expect(data.history.every((h) => h.released === '0.10.0' && h.dev === devVersion())).toBe(true);
      mkdirSync(join(dir, 'release/1.0.0'), { recursive: true });
      writeFileSync(join(dir, 'release/1.0.0/release.json'), JSON.stringify({ version: '1.0.0', publishedAt: 'now' }));
      expect(listChecklist('9.9.9').released).toBe('1.0.0');
      expect(listChecklist('9.9.9').history[0]?.released).toBe('0.10.0');
      expect(seen).toContainEqual({ version: '9.9.9', id: 'K1', field: 'status', from: 'yellow', to: 'red', by: 'T' });
      expect(statSync(join(dir, 'release/features.sqlite')).mode & 0o777).toBe(0o600);
      removeItem('9.9.9', 'K1', 'TC');
      expect(listChecklist('9.9.9').history.at(-1)).toMatchObject({ id: 'K1', field: 'remove', by: 'TC', released: '1.0.0', dev: devVersion() });
      expect(listChecklist('9.9.9').items).toEqual([]);
    } finally { spy.mockRestore(); }
  });
});

// DOC-REFS(10-07): 설치본 트리에는 docs/ 가 없다 — 저장소 안에서 부른 설치본도 저장소 문서를 인용한다.
test('normalizeRefs finds a document in any root, and refRoots adds the git root of the working directory', () => {
  const install = mkdtempSync(join(tmpdir(), 'refs-install-'));
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'refs-repo-')));
  try {
    mkdirSync(join(repo, 'docs', 'sub'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'RFC-x.md'), '# x\n');
    expect(() => normalizeRefs(['docs/RFC-x.md#A5'], [install])).toThrow('없는 문서');
    expect(normalizeRefs(['docs/RFC-x.md#A5'], [install, repo])).toEqual(['docs/RFC-x.md#A5']);
    expect(spawnSync('git', ['init', '-q'], { cwd: repo }).status).toBe(0);
    expect(refRoots(join(repo, 'docs', 'sub'))).toContain(repo);
    expect(refRoots(install).length).toBe(1);
  } finally { rmSync(install, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});
