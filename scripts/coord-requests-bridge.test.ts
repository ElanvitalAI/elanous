import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogStore } from '../src/mss/logging/log-store.js';
import { gatherSeatInputs } from '../src/seat-loop/seat-loop.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const time = '2026-10-03T09:00:00Z';
const comment = (id: number, body: string, created_at = time) => ({ id, body, created_at, html_url: `https://github.com/example/repo/pull/23032#issuecomment-${id}` });

function logSnapshot(dir: string): Map<string, string> {
  return new Map(existsSync(dir) ? readdirSync(dir)
    .filter((name) => /^debug-.*\.log$/.test(name))
    .map((name): [string, string] => [realpathSync(join(dir, name)), readFileSync(join(dir, name), 'utf8')]) : []);
}

function newLogEntries(latest: string, before: Map<string, string>): string {
  const path = realpathSync(latest);
  const content = readFileSync(path, 'utf8');
  const previous = before.get(path) ?? '';
  expect(content.startsWith(previous)).toBe(true);
  return content.slice(previous.length);
}

function fixture(comments: ReturnType<typeof comment>[]) {
  const home = mkdtempSync(join(tmpdir(), 'coord-requests-bridge-'));
  roots.push(home);
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(home, 'comments.json'), comments.map((item) => JSON.stringify(item)).join('\n') + '\n');
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$GH_CALLS"\nif [ -f "$GH_SWITCH_FILE" ]; then ln -sfn "$(cat "$GH_SWITCH_FILE")" "$GH_LOG_LATEST"; readlink "$GH_LOG_LATEST" > "$GH_SWITCH_FILE.done"; fi\ncat "$GH_COMMENTS"\n`);
  chmodSync(gh, 0o755);
  const root = join(home, 'instance');
  const path = join(root, 'seat-requests', 'requests.jsonl');
  const calls = join(home, 'calls.txt');
  const runSeat = (seat: string, ...args: string[]) => Bun.spawnSync(['bun', join(import.meta.dir, 'coord-requests-bridge.ts'), '--seat', seat, ...args], {
    cwd: home, env: { ...process.env, NODE_ENV: 'development', HOME: home, PATH: `${bin}:${process.env.PATH}`,
      GH_COMMENTS: join(home, 'comments.json'), GH_CALLS: calls, GH_SWITCH_FILE: join(home, 'switch-target'),
      GH_LOG_LATEST: join(home, '.elanous', 'debug', 'latest'), ELANOUS_STATE_DIR: root, TZ: 'UTC' }, stdout: 'pipe', stderr: 'pipe',
  });
  const run = (...args: string[]) => runSeat('MK', ...args);
  const output = (result: ReturnType<typeof run>) => new TextDecoder().decode(result.stdout).trim();
  const entries = () => readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  return { home, root, path, calls, run, runSeat, output, entries };
}

test('독립 CLI 성공과 gh 실패가 격리 로그 스토어에 수와 사유만 남긴다', () => {
  const body = '비공개 본문 alice@example.com token-secret';
  const f = fixture([
    comment(501, `**[OP]** 10:00 → MK · 요청 · K6\n${body}`),
    comment(502, '**[OP]** 10:01 → TC · 요청 · K7\n다른 자리'),
  ]);
  const success = f.run('--json');
  expect(success.exitCode).toBe(0);
  const counts = JSON.parse(f.output(success));
  expect(counts).toEqual({ seat: 'MK', read: 2, picked: 1, added: 1, existing: 0 });

  const gh = join(f.home, 'bin', 'gh');
  writeFileSync(gh, '#!/bin/sh\necho "gh token-secret alice@example.com" >&2\nexit 1\n');
  chmodSync(gh, 0o755);
  const failure = f.run('--json');
  expect(failure.exitCode).not.toBe(0);

  const store = LogStore.openReadOnly(join(f.root, 'logs', 'logs.db'));
  try {
    const rows = store.query({ exactCategories: ['coord.requests-bridge'] });
    const runs = rows.filter((row) => row.event === 'run');
    const failed = rows.filter((row) => row.event === 'failed');
    expect(runs).toHaveLength(1);
    const { seat, read, picked, added, existing } = JSON.parse(runs[0]!.data!);
    expect({ seat, read, picked, added, existing }).toEqual(counts);
    expect(runs[0]!.surface).toBe('coord-requests-bridge');
    expect(failed).toHaveLength(1);
    expect(JSON.parse(failed[0]!.data!)).toMatchObject({ seat: 'MK', reason: 'gh' });
    expect(JSON.stringify(rows)).not.toContain(body);
    expect(JSON.stringify(rows)).not.toContain('alice@example.com');
    expect(JSON.stringify(rows)).not.toContain('token-secret');
  } finally { store.close(); }
}, 60_000);

test('원장 쓰기 실패도 내용 없이 ledger 사유로 스토어에 남긴다', () => {
  const f = fixture([comment(503, '**[OP]** 10:00 → MK · 요청 · K6\n원장 비공개 본문')]);
  mkdirSync(f.path, { recursive: true });
  const result = f.run('--json');
  expect(result.exitCode).not.toBe(0);
  const store = LogStore.openReadOnly(join(f.root, 'logs', 'logs.db'));
  try {
    const rows = store.query({ exactCategories: ['coord.requests-bridge'] });
    expect(rows.filter((row) => row.event === 'run')).toHaveLength(0);
    const failed = rows.filter((row) => row.event === 'failed');
    expect(failed).toHaveLength(1);
    expect(JSON.parse(failed[0]!.data!)).toMatchObject({ seat: 'MK', reason: 'ledger' });
    expect(JSON.stringify(rows)).not.toContain('원장 비공개 본문');
  } finally { store.close(); }
}, 60_000);

test('다섯 댓글에서 MK 요청·결정 둘만 원장에 덧붙이고 재실행은 멱등이며 자리 루프가 집는다', async () => {
  const f = fixture([
    comment(101, '**[OP]** 10:00 → MK · 요청 · K6 · 기한 18:00\nK6 원고를 확인해 주세요'),
    comment(102, '**[OP]** 10:01 → MK · TC · 결정 · GK3\nGK3 결정을 검토해 주세요'),
    comment(103, '**[OP]** 10:02 → 전원 · 사고 · K6\n사고'),
    comment(104, '**[TC]** 10:03 → OP · 보고 · K6\n보고'),
    comment(105, '**[MK]** 10:04 → OP · 요청 · K6\n내 요청'),
  ]);
  const logDir = join(f.home, '.elanous', 'debug');
  const latest = join(logDir, 'latest');
  const logsBefore = logSnapshot(logDir);
  const first = f.run('--channel', '23032', '--json');
  expect(first.exitCode).toBe(0);
  const appended = newLogEntries(latest, logsBefore);
  const events = appended.split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
    category: string; event: string; data?: Record<string, unknown>;
  });
  expect(events.filter((entry) => entry.category === 'coord.requests-bridge' && entry.event === 'run')
    .map((entry) => entry.data)).toMatchObject([{ seat: 'MK', read: 5, picked: 2, added: 2, existing: 0 }]);
  expect(appended).not.toContain('원고를 확인해 주세요');
  expect(JSON.parse(f.output(first))).toEqual({ seat: 'MK', read: 5, picked: 2, added: 2, existing: 0 });
  expect(f.entries()).toEqual([
    { key: 'coord:101:MK', seat: 'MK', text: 'K6 원고를 확인해 주세요', status: 'queued', queuedAt: time,
      source: 'coord', cell: 'K6', dueAt: '18:00', url: 'https://github.com/example/repo/pull/23032#issuecomment-101' },
    { key: 'coord:102:MK', seat: 'MK', text: 'GK3 결정을 검토해 주세요', status: 'queued', queuedAt: time,
      source: 'coord', cell: 'GK3', url: 'https://github.com/example/repo/pull/23032#issuecomment-102' },
  ]);
  const before = readFileSync(f.path, 'utf8');
  const second = f.run('--json');
  expect(second.exitCode).toBe(0);
  expect(JSON.parse(f.output(second))).toEqual({ seat: 'MK', read: 5, picked: 2, added: 0, existing: 2 });
  expect(readFileSync(f.path, 'utf8')).toBe(before);
  const inputs = await gatherSeatInputs('MK', { root: f.root, repo: f.home, versions: () => [], schedules: () => [] });
  expect(inputs.requests).toMatchObject([
    { id: 'coord:101:MK', source: 'request', text: 'K6 원고를 확인해 주세요' },
    { id: 'coord:102:MK', source: 'request', text: 'GK3 결정을 검토해 주세요' },
  ]);
  expect(readFileSync(f.calls, 'utf8').trim().split('\n')).toEqual([
    'api repos/{owner}/{repo}/issues/23032/comments --paginate --jq .[]',
    'api repos/{owner}/{repo}/issues/23032/comments --paginate --jq .[]',
  ]);
}, 60_000);

test('한 줄 요청의 봉투 뒤 본문과 여러 줄 본문 및 빈 봉투의 대체 문구를 원장에 남긴다', () => {
  const f = fixture([
    comment(401, '**[TC]** 2026-10-03 15:39 KST → MK · 요청 · E3 ② — MK 가 저작해 쏴 주세요.'),
    comment(402, '**[TC]** 15:40 → MK · 요청 · E3 ③\n둘째 줄 본문\n추가 설명'),
    comment(403, '**[TC]** 15:41 → MK · 요청 · E3 ④ · 기한 18:00'),
    comment(404, '**[TC]** 15:42 → MK · 요청 · E3 ⑤ - 하이픈 본문\n둘째 줄'),
    comment(405, '**[TC]** 15:43 → MK · 요청 · E3 ⑥: 콜론 본문'),
    comment(406, '**[TC]** 15:44 → MK · 요청 · E3 ⑦ · 기한 19:00 — 기한 뒤 본문'),
    comment(407, '**[TC]** 15:45 → MK · 요청 · E3 ② · 제목'),
    comment(408, '**[TC]** 15:46 → MK · 요청 · E3 ⑧ · 기한 20:00 · 마감 다음 제목'),
    comment(409, '**[TC]** 15:47 → MK · 요청 · E3 ② · 제목 · 기한 18:00 — 상세'),
  ]);
  const result = f.run('--json');
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(f.output(result))).toMatchObject({ seat: 'MK', read: 9, picked: 9, added: 9 });
  const rows = f.entries();
  expect(rows.map((row: { key: string }) => row.key)).toEqual([401, 402, 403, 404, 405, 406, 407, 408, 409].map((id) => `coord:${id}:MK`));
  expect(rows[0]).toMatchObject({ cell: 'E3 ②', text: 'MK 가 저작해 쏴 주세요.' });
  expect(rows[1]).toMatchObject({ cell: 'E3 ③', text: '둘째 줄 본문\n추가 설명' });
  expect(rows[2]).toMatchObject({ cell: 'E3 ④', dueAt: '18:00', text: '(본문 없음 — 채널 글 링크 참조)' });
  expect(rows[3]).toMatchObject({ cell: 'E3 ⑤', text: '하이픈 본문\n둘째 줄' });
  expect(rows[4]).toMatchObject({ cell: 'E3 ⑥', text: '콜론 본문' });
  expect(rows[5]).toMatchObject({ cell: 'E3 ⑦', dueAt: '19:00', text: '기한 뒤 본문' });
  expect(rows[6]).toMatchObject({ cell: 'E3 ②', text: '제목' });
  expect(rows[7]).toMatchObject({ cell: 'E3 ⑧', dueAt: '20:00', text: '마감 다음 제목' });
  expect(rows[8]).toMatchObject({ cell: 'E3 ②', dueAt: '18:00', text: '제목\n상세' });
  expect(rows.every((row: { text: string }) => row.text.length > 0)).toBe(true);
}, 60_000);

test('latest 대상이 다른 기존 로그로 바뀌어도 이번 호출에서 추가한 로그만 센다', () => {
  const f = fixture([comment(301, '**[OP]** 10:00 → MK · 요청 · K6\n신규 요청')]);
  const dir = join(f.home, '.elanous', 'debug');
  mkdirSync(dir, { recursive: true });
  const oldPath = join(dir, 'debug-old.log');
  const now = new Date();
  const stamp = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((part, i) => String(part).padStart(i === 0 ? 4 : 2, '0')).join('');
  const target = join(dir, `debug-${stamp}.log`);
  const oldEvent = `${JSON.stringify({ category: 'coord.requests-bridge', event: 'run', data: { seat: 'MK', read: 100 } })}\n`;
  writeFileSync(oldPath, oldEvent);
  writeFileSync(target, oldEvent);
  symlinkSync(oldPath, join(dir, 'latest'));
  const before = logSnapshot(dir);
  writeFileSync(join(f.home, 'switch-target'), target);
  const result = f.run('--json');
  expect(result.exitCode).toBe(0);
  const latest = join(dir, 'latest');
  expect(readFileSync(join(f.home, 'switch-target.done'), 'utf8').trim()).toBe(target);
  expect(realpathSync(latest)).toBe(realpathSync(target));
  const appended = newLogEntries(latest, before);
  const events = appended.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { category: string; event: string; data: Record<string, unknown> });
  expect(events.filter((entry) => entry.category === 'coord.requests-bridge' && entry.event === 'run')
    .map((entry) => entry.data)).toMatchObject([{ seat: 'MK', read: 1, picked: 1, added: 1, existing: 0 }]);
  expect(appended).not.toContain('신규 요청');
}, 60_000);

test('dry-run 은 원장을 만들지 않고 since 는 오래된 글을 제외하며 원문 본문은 200자로 제한한다', () => {
  const f = fixture([
    comment(1, '**[OP]** 10:00 → MK · 요청 · K5\n과거', '2026-10-02T09:00:00Z'),
    comment(2, '**[OP]** 10:01 → MK · 요청 · K6\n' + '가'.repeat(210)),
  ]);
  const preview = f.run('--since', '2026-10-03T00:00:00Z', '--dry-run', '--json');
  expect(preview.exitCode).toBe(0);
  expect(JSON.parse(f.output(preview))).toMatchObject({ read: 2, picked: 1, added: 1, existing: 0 });
  expect(existsSync(f.path)).toBe(false);
  const written = f.run('--since', '2026-10-03T00:00:00Z', '--json');
  expect(written.exitCode).toBe(0);
  expect(f.entries()).toMatchObject([{ key: 'coord:2:MK', text: '가'.repeat(200) }]);
  expect(f.output(f.run('--since', '2026-10-03T00:00:00Z'))).toBe('읽은 글 2 · 고른 수 1 · 새로 넣은 수 0 · 이미 있던 수 1');
}, 60_000);

test('기존 요청 줄은 보존하며 자기 발신·종류 오인·전원은 거부한다', () => {
  const f = fixture([
    comment(3, '**[MK]** 10:00 → MK · 요청 · K6\n자기 요청'),
    comment(4, '**[OP]** 10:01 → MK · 보고 · 요청\n보고'),
    comment(5, '**[OP]** 10:02 → 전원 · 요청 · K6\n전원 요청'),
    comment(6, '**[OP]** 10:03 → TC · MK · 요청 · -\n직접 요청'),
    comment(7, '**[OP]** 10:04 → OP, MK · 결정 · G7\n콤마 주소'),
    comment(8, '**[OP]** 10:05 → 전원 · MK · 요청 · K8\n전원 주소'),
    comment(9, '**[OP]** 10:06 → MK · 요청 · 기한 19:00\n칸 없는 요청'),
  ]);
  mkdirSync(join(f.root, 'seat-requests'), { recursive: true });
  const original = '{"key":"old","seat":"MK","text":"기존","status":"pending","queuedAt":"2026-10-01"}\n';
  writeFileSync(f.path, original);
  const result = f.run('--json');
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(f.output(result))).toMatchObject({ picked: 3, added: 3 });
  expect(readFileSync(f.path, 'utf8').startsWith(original)).toBe(true);
  expect(f.entries()[1]).toMatchObject({ key: 'coord:6:MK', text: '직접 요청' });
  expect(f.entries()[1]).not.toHaveProperty('cell');
  expect(f.entries()[2]).toMatchObject({ key: 'coord:7:MK', cell: 'G7', text: '콤마 주소' });
  expect(f.entries().map((row: { key: string }) => row.key)).not.toContain('coord:8:MK');
  expect(f.entries()[3]).toMatchObject({ key: 'coord:9:MK', dueAt: '19:00', text: '칸 없는 요청' });
  expect(f.entries()[3]).not.toHaveProperty('cell');
}, 60_000);

test('두 자리에게 온 글은 실제 CLI 로 자리마다 넣고 두 자리 루프가 각자 집는다', async () => {
  const f = fixture([comment(201, '**[OP]** 10:00 → MK · TC · 요청 · K6\n두 자리에 요청')]);
  const tc = f.runSeat('TC', '--json');
  expect(tc.exitCode).toBe(0);
  expect(JSON.parse(f.output(tc))).toMatchObject({ seat: 'TC', picked: 1, added: 1, existing: 0 });
  const mk = f.runSeat('MK', '--json');
  expect(mk.exitCode).toBe(0);
  expect(JSON.parse(f.output(mk))).toMatchObject({ seat: 'MK', picked: 1, added: 1, existing: 0 });
  expect(f.entries().map((row: { key: string; seat: string }) => [row.key, row.seat])).toEqual([['coord:201:TC', 'TC'], ['coord:201:MK', 'MK']]);
  const again = f.runSeat('MK', '--json');
  expect(JSON.parse(f.output(again))).toMatchObject({ seat: 'MK', added: 0, existing: 1 });
  const opts = { root: f.root, repo: f.home, versions: () => [], schedules: () => [] };
  expect((await gatherSeatInputs('MK', opts)).requests).toMatchObject([{ id: 'coord:201:MK', source: 'request', text: '두 자리에 요청' }]);
  expect((await gatherSeatInputs('TC', opts)).requests).toMatchObject([{ id: 'coord:201:TC', source: 'request', text: '두 자리에 요청' }]);
}, 60_000);

test('옛 꼴 키(coord:<id>)가 다른 자리 줄로 있어도 이 자리 요청을 막지 않고, 같은 자리 옛 줄은 이미 있음으로 센다', async () => {
  const f = fixture([comment(202, '**[OP]** 10:00 → MK · TC · 요청 · K7\n옛 키 요청')]);
  mkdirSync(join(f.root, 'seat-requests'), { recursive: true });
  const original = `${JSON.stringify({ key: 'coord:202', seat: 'TC', text: '옛 키 요청', status: 'queued', queuedAt: time })}\n`;
  writeFileSync(f.path, original);
  const tc = f.runSeat('TC', '--json');
  expect(JSON.parse(f.output(tc))).toMatchObject({ seat: 'TC', added: 0, existing: 1 });
  const mk = f.runSeat('MK', '--json');
  expect(JSON.parse(f.output(mk))).toMatchObject({ seat: 'MK', added: 1, existing: 0 });
  expect(readFileSync(f.path, 'utf8').startsWith(original)).toBe(true);
  const opts = { root: f.root, repo: f.home, versions: () => [], schedules: () => [] };
  expect((await gatherSeatInputs('MK', opts)).requests).toMatchObject([{ id: 'coord:202:MK', text: '옛 키 요청' }]);
  expect((await gatherSeatInputs('TC', opts)).requests).toMatchObject([{ id: 'coord:202', text: '옛 키 요청' }]);
}, 60_000);
