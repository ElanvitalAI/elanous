import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { debug } from '../debug/log.js';
import { addItem, devVersion, listChecklist, removeItem, seedFromRoadmap, setItem, summarize, summarizeChecklist } from './checklist.js';

const roots: string[] = [];
function root(): string { const dir = mkdtempSync(join(tmpdir(), 'release-checklist-')); roots.push(dir); setElanousConfigDir(dir); return dir; }
afterEach(() => { resetElanousConfigDir(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('release checklist ledger', () => {
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
    expect(statSync(join(dir, 'release/0.2.5/checklist.json')).mode & 0o777).toBe(0o600);
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
    expect(statSync(join(dir, 'release/9.9.9/checklist.json.mutex.sqlite')).mode & 0o777).toBe(0o600);
  });

  test('살아 있는 작성자의 잠금이 같은 판의 addItem을 막고 종료 뒤 해제된다', async () => {
    const dir = root();
    const cwd = join(import.meta.dir, '..', '..');
    const lockScript = `import { Database } from 'bun:sqlite'; import { join } from 'node:path'; const db = new Database(join(process.argv[1], 'release/9.9.9/checklist.json.mutex.sqlite'), { create: true }); db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked\\n'); setInterval(() => { if (!db.inTransaction) throw new Error('lock lost'); }, 1000);`;
    const writeScript = `import { setElanousConfigDir } from './src/elanous-config-dir.ts'; import { addItem } from './src/release-loop/checklist.ts'; setElanousConfigDir(process.argv[1]); addItem('9.9.9', { id: 'K1', title: 'recover' }); process.stdout.write('written\\n');`;
    mkdirSync(join(dir, 'release/9.9.9'), { recursive: true });
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
      expect(listChecklist('9.9.9').items).toHaveLength(0);
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

  test('특수 담당자 이름도 독립적으로 집계한다', () => {
    root();
    for (const name of ['toString', '__proto__', 'constructor']) addItem('9.9.9', { id: name, title: name, owner: name });
    const counts = summarize('9.9.9').byOwner;
    expect(Object.getPrototypeOf(counts)).toBeNull();
    expect(counts['toString']).toBe(1);
    expect(counts['__proto__']).toBe(1);
    expect(counts['constructor']).toBe(1);
    expect(JSON.parse(JSON.stringify(counts))).toEqual(JSON.parse('{"toString":1,"__proto__":1,"constructor":1}'));
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
      addItem('9.9.9', { id: 'K1', title: '첫 칸', owner: 'T' });
      expect(() => addItem('9.9.9', { id: 'K1', title: '중복' })).toThrow('이미 있는 칸');
      setItem('9.9.9', 'K1', { status: 'red', evidence: 'issue', owner: 'S' }, 'T');
      expect(summarize('9.9.9')).toEqual({ green: 0, yellow: 0, red: 1, done: 0, blocked: ['K1'], byOwner: { S: 1 } });
      const data = listChecklist('9.9.9');
      expect(data).toMatchObject({ released: '0.10.0', dev: devVersion() });
      expect(data.history.map((h) => h.field)).toEqual(['add', 'evidence', 'owner', 'status']);
      expect(data.history.every((h) => h.released === '0.10.0' && h.dev === devVersion())).toBe(true);
      mkdirSync(join(dir, 'release/1.0.0'), { recursive: true });
      writeFileSync(join(dir, 'release/1.0.0/release.json'), JSON.stringify({ version: '1.0.0', publishedAt: 'now' }));
      expect(listChecklist('9.9.9').released).toBe('1.0.0');
      expect(listChecklist('9.9.9').history[0]?.released).toBe('0.10.0');
      expect(seen).toContainEqual({ version: '9.9.9', id: 'K1', field: 'status', from: 'yellow', to: 'red', by: 'T' });
      expect(statSync(join(dir, 'release/9.9.9/checklist.json')).mode & 0o777).toBe(0o600);
      removeItem('9.9.9', 'K1', 'S');
      expect(listChecklist('9.9.9').history.at(-1)).toMatchObject({ id: 'K1', field: 'remove', by: 'S', released: '1.0.0', dev: devVersion() });
      expect(listChecklist('9.9.9').items).toEqual([]);
    } finally { spy.mockRestore(); }
  });
});
