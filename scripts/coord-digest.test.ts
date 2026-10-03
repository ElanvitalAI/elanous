import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { devVersion, statusChangesSince, type ChecklistHistory } from '../src/release-loop/checklist.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(version = devVersion().replace(/-dev\.\d+$/, '')) {
  const home = mkdtempSync(join(tmpdir(), 'coord-digest-'));
  roots.push(home);
  const coord = join(home, '.elanous', 'coord');
  const release = join(home, '.elanous', 'release', version);
  mkdirSync(coord, { recursive: true });
  mkdirSync(release, { recursive: true });
  const now = Date.now();
  const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const history = [
    { at: at(60), by: 'OP', id: 'K6', field: 'status', from: 'yellow', to: 'green', released: '', dev: version },
    { at: at(45), by: 'OP', id: 'K7', field: 'evidence', from: null, to: '#123', released: '', dev: version },
    { at: at(180), by: 'OP', id: 'K8', field: 'status', from: 'red', to: 'green', released: '', dev: version },
  ];
  writeFileSync(join(release, 'checklist.json'), JSON.stringify({ version, released: '', dev: version, items: [], history }));
  const report = (id: number, minutes: number, login: string, first: string) => ({ id, created_at: at(minutes), login, body: `${first}\n원문은 요약하지 않는다` });
  writeFileSync(join(coord, 'MK-reports.jsonl'), [
    report(1, 55, 'tc-login', '**[TC]** 10:05 → OP · 보고 · K6 · 결정은 본문에'),
    report(2, 50, 'tc-login', '**[TC]** 10:10 → OP · 보고 · K6'),
    report(3, 30, 'ux-login', '**[UX]** 10:20 → OP · 보고 · K6'),
    report(4, 10, 'tc-login', '**[TC]** 10:30 → OP · 보고 · -'),
    report(5, 180, 'tc-login', '**[TC]** 09:00 → OP · 보고 · K9'),
  ].map((item) => JSON.stringify(item)).join('\n') + '\n');
  return { home, coord, history, at };
}

function run(home: string, ...args: string[]) {
  return Bun.spawnSync(['bun', join(import.meta.dir, 'coord-digest.ts'), '--track', 'MK', ...args], {
    cwd: home, env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe',
  });
}

function output(result: ReturnType<typeof run>) { return new TextDecoder().decode(result.stdout); }

describe('coord digest', () => {
  test('판정 신호의 네 보고: K6 둘·칸 없음 하나·창 밖 하나와 status 만 읽는다', () => {
    const { home, coord, at } = fixture();
    writeFileSync(join(coord, 'MK-reports.jsonl'), [
      { id: 1, created_at: at(55), login: 'tc-login', body: '**[TC]** 10:05 → OP · 보고 · K6' },
      { id: 2, created_at: at(50), login: 'ux-login', body: '**[UX]** 10:10 → OP · 보고 · K6' },
      { id: 3, created_at: at(10), login: 'tc-login', body: '**[TC]** 10:30 → OP · 보고 · -' },
      { id: 4, created_at: at(180), login: 'tc-login', body: '**[TC]** 09:00 → OP · 보고 · K9' },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const first = run(home, '--since', '2h', '--json');
    expect(first.exitCode).toBe(0);
    const digest = JSON.parse(output(first));
    expect(digest.totals).toEqual({ reports: 3, cells: 2, statusChanges: 1 });
    expect(digest.cells.find((cell: { id: string }) => cell.id === 'K6')).toMatchObject({
      reports: 2, bySender: { TC: 1, UX: 1 }, statusChanges: [{ from: 'yellow', to: 'green' }],
    });
    expect(digest.cells.find((cell: { id: string }) => cell.id === '칸 없음')).toMatchObject({ reports: 1, statusChanges: [] });
    expect(digest.cells.map((cell: { id: string }) => cell.id)).not.toContain('K7');
    expect(digest.cells.map((cell: { id: string }) => cell.id)).not.toContain('K9');
    expect(JSON.parse(output(run(home, '--since', '2h', '--json'))).totals.reports).toBe(3);
    expect(JSON.parse(output(run(home, '--json'))).totals.reports).toBe(0);
  });

  test('두 시간 창의 보고를 칸별로 세고 status 원장 차이만 더하며 재실행에는 커서가 이긴다', () => {
    const { home, coord } = fixture();
    const first = run(home, '--since', '2h', '--json');
    expect(new TextDecoder().decode(first.stderr)).toBe('');
    expect(first.exitCode).toBe(0);
    const digest = JSON.parse(output(first)) as {
      cells: Array<{ id: string; reports: number; bySender: Record<string, number>; last: string | null; statusChanges: Array<{ from: string; to: string }> }>;
      totals: { reports: number; cells: number; statusChanges: number };
    };
    expect(digest.totals).toEqual({ reports: 4, cells: 2, statusChanges: 1 });
    expect(digest.cells.find((cell) => cell.id === 'K6')).toMatchObject({
      reports: 3, bySender: { TC: 2, UX: 1 }, statusChanges: [{ from: 'yellow', to: 'green' }],
      last: '**[UX]** 10:20 → OP · 보고 · K6',
    });
    expect(digest.cells.find((cell) => cell.id === '칸 없음')).toMatchObject({ reports: 1, bySender: { TC: 1 }, statusChanges: [] });
    expect(digest.cells.map((cell) => cell.id)).not.toContain('K7');
    expect(digest.cells.map((cell) => cell.id)).not.toContain('K9');
    expect(JSON.parse(readFileSync(join(coord, 'MK-digest-cursor'), 'utf8'))).toEqual(['1', '2', '3', '4']);
    const second = run(home, '--json');
    expect(second.exitCode).toBe(0);
    const next = JSON.parse(output(second));
    expect(next.totals).toEqual({ reports: 0, cells: 1, statusChanges: 1 });
    expect(next.cells).toMatchObject([{ id: 'K6', reports: 0, statusChanges: [{ from: 'yellow', to: 'green' }] }]);
    const replay = run(home, '--since', '2h', '--json');
    expect(replay.exitCode).toBe(0);
    expect(JSON.parse(output(replay)).totals.reports).toBe(4);
  });

  test('손상된 커서를 보존·복구하고 --since 재조회도 막지 않으며 교체 후 커서는 다시 읽힌다', () => {
    const { home, coord } = fixture();
    const cursor = join(coord, 'MK-digest-cursor');
    const broken = '["1",';
    writeFileSync(cursor, broken);
    const first = run(home, '--since', '2h', '--json');
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(output(first)).totals.reports).toBe(4);
    const backups = readdirSync(coord).filter((name) => name.startsWith('MK-digest-cursor.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(coord, backups[0]!), 'utf8')).toBe(broken);
    expect(new TextDecoder().decode(first.stderr)).toContain('손상된 커서를');
    expect(readdirSync(coord).filter((name) => name.startsWith('MK-digest-cursor.tmp-'))).toEqual([]);
    expect(JSON.parse(readFileSync(cursor, 'utf8'))).toEqual(['1', '2', '3', '4']);
    const second = run(home, '--json');
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(output(second)).totals.reports).toBe(0);
  });

  test('빈 커서도 보존한 뒤 기본 요약을 계속하고 새 커서로 다음 실행을 건너뛴다', () => {
    const { home, coord } = fixture();
    const cursor = join(coord, 'MK-digest-cursor');
    writeFileSync(cursor, '');
    const first = run(home, '--json');
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(output(first)).totals.reports).toBe(4);
    const backups = readdirSync(coord).filter((name) => name.startsWith('MK-digest-cursor.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(coord, backups[0]!), 'utf8')).toBe('');
    expect(JSON.parse(readFileSync(cursor, 'utf8'))).toEqual(['1', '2', '3', '4']);
    const second = run(home, '--json');
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(output(second)).totals.reports).toBe(0);
  });

  test('쓰기 중 잘린 JSONL 줄과 손상된 줄을 기록·건너뛰고 유효한 보고와 상태 변화는 유지한다', () => {
    const { home, coord, at } = fixture();
    const valid = JSON.stringify({ id: 6, created_at: at(5), login: 'tc-login', body: '**[TC]** 10:40 → OP · 보고 · K6' });
    writeFileSync(join(coord, 'MK-reports.jsonl'), `{"id":7,"body":\n${valid}\n{"id":8,"created_at":"${at(4)}","login":"tc-login","body":null}\n`);
    const first = run(home, '--json');
    expect(first.exitCode).toBe(0);
    const parsed = JSON.parse(output(first));
    expect(parsed.totals).toEqual({ reports: 1, cells: 1, statusChanges: 1 });
    expect(parsed.cells[0]).toMatchObject({ id: 'K6', reports: 1, statusChanges: [{ from: 'yellow', to: 'green' }] });
    const errors = new TextDecoder().decode(first.stderr);
    expect(errors).toContain('MK-reports.jsonl:1: 잘못된 보고 줄 건너뜀:');
    expect(errors).toContain('MK-reports.jsonl:3: 잘못된 보고 줄 건너뜀: invalid report fields');
    expect(JSON.parse(readFileSync(join(coord, 'MK-digest-cursor'), 'utf8'))).toEqual(['6']);
    const second = run(home, '--json');
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(output(second)).totals.reports).toBe(0);
  });

  test('일반 출력은 상태 아이콘·발신자별 글 수·합계를 한 줄씩 보여주고 어떤 채널에도 발신하지 않는다', () => {
    const { home } = fixture();
    const result = run(home, '--since', '2h');
    expect(result.exitCode).toBe(0);
    expect(output(result)).toContain('K6 · 🟡→🟢 · 보고 3(TC 2 · UX 1) · 마지막: **[UX]** 10:20 → OP · 보고 · K6');
    expect(output(result)).toContain('칸 없음 · - · 보고 1(TC 1)');
    expect(output(result)).toContain('합계 · 글 4 · 칸 2 · 상태 바뀐 칸 1');
    expect(output(result)).not.toContain('원문은 요약하지 않는다');
  });

  test('반복 --version 은 해당 판들을 함께 읽고 기본 판 대신 지정 판을 읽는다', () => {
    const { home, at } = fixture('9.9.8');
    const release = join(home, '.elanous', 'release', '9.9.9');
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, 'checklist.json'), JSON.stringify({ version: '9.9.9', released: '', dev: '9.9.9', items: [], history: [
      { at: at(20), by: 'MK', id: 'K10', field: 'status', from: 'green', to: 'red', released: '', dev: '9.9.9' },
    ] }));
    const result = run(home, '--since', '2h', '--version', '9.9.8', '--version', '9.9.9', '--json');
    expect(new TextDecoder().decode(result.stderr)).toBe('');
    expect(result.exitCode).toBe(0);
    const digest = JSON.parse(output(result));
    expect(digest.versions).toEqual(['9.9.8', '9.9.9']);
    expect(digest.cells.find((cell: { id: string }) => cell.id === 'K10').statusChanges).toMatchObject([{ from: 'green', to: 'red', version: '9.9.9' }]);
    expect(digest.totals.statusChanges).toBe(2);
  });

  test('statusChangesSince 는 원본을 건드리지 않고 창 안 status 만 반환한다', () => {
    const { history, at } = fixture();
    const before = JSON.stringify(history);
    const filtered = statusChangesSince(history as ChecklistHistory[], at(120));
    expect(filtered).toMatchObject([{ id: 'K6', field: 'status', from: 'yellow', to: 'green' }]);
    expect(JSON.stringify(history)).toBe(before);
    expect(statusChangesSince(history as ChecklistHistory[], at(20))).toEqual([]);
  });

  test('칸 누락·긴 첫 줄·본문의 보고 낱말은 순서대로 구분하며 built 관측을 남긴다', () => {
    const { home, coord, at } = fixture();
    const first = '**[TC]** 10:00 → OP · 보고';
    const long = '**[UX]** 10:02 → OP · 보고 · K11' + '가'.repeat(100);
    writeFileSync(join(coord, 'MK-reports.jsonl'), [
      { id: 8, created_at: at(5), login: 'tc-login', body: first },
      { id: 9, created_at: at(4), login: 'ux-login', body: long },
      { id: 10, created_at: at(3), login: 'tc-login', body: '**[TC]** 10:03 → OP · 요청 · K12\n보고' },
      { id: 11, created_at: at(2), login: 'tc-login', body: '**[TC]** 10:04 → K12 · 보고 · K13' },
      { id: 12, created_at: at(1), login: 'tc-login', body: '**[TC]** 10:05 → OP · 요청 · 보고 · K14' },
      { id: 13, created_at: at(1), login: 'tc-login', body: '**[TC]** 10:06 → OP · K15 · 보고 · K16' },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const result = run(home, '--json');
    expect(result.exitCode).toBe(0);
    const digest = JSON.parse(output(result));
    expect(digest.totals).toEqual({ reports: 2, cells: 3, statusChanges: 1 });
    expect(digest.cells.find((cell: { id: string }) => cell.id === '칸 없음').reports).toBe(1);
    expect(Array.from(digest.cells.find((cell: { id: string }) => cell.id === 'K11' + '가'.repeat(100)).last)).toHaveLength(80);
    expect(digest.cells.map((cell: { id: string }) => cell.id)).not.toContain('K12');
    expect(digest.cells.map((cell: { id: string }) => cell.id)).not.toContain('K13');
    expect(digest.cells.map((cell: { id: string }) => cell.id)).not.toContain('K14');
    expect(digest.cells.map((cell: { id: string }) => cell.id)).not.toContain('K16');
    expect(existsSync(join(coord, 'MK-digest-cursor'))).toBe(true);
    const logs = readFileSync(join(home, '.elanous', 'debug', 'latest'), 'utf8');
    expect(logs.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((row) => row.category === 'coord.digest' && row.event === 'built')?.data).toMatchObject({ track: 'MK', reports: 2, cells: 3, statusChanges: 1 });
  });

  test('같은 자리 요약 둘이 동시에 돌아도 보고를 두 번 세지 않는다 (round 2 must-fix · 실행 간 잠금)', async () => {
    const { home } = fixture();
    const spawn = () => Bun.spawn(['bun', join(import.meta.dir, 'coord-digest.ts'), '--track', 'MK', '--json'], {
      cwd: home, env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe',
    });
    const [a, b] = [spawn(), spawn()];
    const [outA, outB] = await Promise.all([new Response(a.stdout).text(), new Response(b.stdout).text()]);
    expect(await a.exited).toBe(0);
    expect(await b.exited).toBe(0);
    const total = JSON.parse(outA).totals.reports + JSON.parse(outB).totals.reports;
    expect(total).toBe(4);
    const third = run(home, '--json');
    expect(JSON.parse(output(third)).totals.reports).toBe(0);
  });
});
