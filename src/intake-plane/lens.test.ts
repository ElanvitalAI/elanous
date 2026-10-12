import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { annotateIntakeLens, fairLensBatch, LENS_DAILY_CAP, type LensJudgeInput } from './lens.js';
import { shapeIntakeItem, type IntakeItem } from './items.js';

const DAY = '2026-10-05';
const SAME = '8877f9f9715ae8a6';
const OTHER = 'bbbbbbbbbbbbbbbb';

const ROW_A = { id: SAME, fact: 'elanous의 `omni-crawl`은 봇 검사가 적용된 웹페이지에서 데이터를 수집하고, 페이지별 통과 여부와 결과를 기록한다.', current: 'omni-crawl catalog/resources.yaml', url: 'https://www.youtube.com/watch?v=-3Kku5BW1Y4' };
const ROW_B = { id: SAME, fact: 'elanous의 `mcp`는 에이전트가 실시간 웹 데이터를 가져오도록 크롤링 도구를 연결한다.', current: 'mcp', url: 'https://www.youtube.com/watch?v=-3Kku5BW1Y4' };
const ROW_C = { id: OTHER, fact: '다른 흡수 항목은 릴리스 노트 문맥만 보탠다.', current: 'release notes', url: 'https://example.test/other' };

function fixture(): { root: string; review: string; reviewText: string } {
  const root = mkdtempSync(join(tmpdir(), 'intake-lens-'));
  const reviewDir = join(root, 'intake', 'outbox', 'review');
  mkdirSync(reviewDir, { recursive: true });
  const review = join(reviewDir, `${DAY}.jsonl`);
  const reviewText = [ROW_A, ROW_B, ROW_C].map((row) => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(review, reviewText);
  return { root, review, reviewText };
}

test('annotateIntakeLens judges each id once, appends lens rows, and leaves the review file untouched', async () => {
  const { root, review, reviewText } = fixture();
  const calls: LensJudgeInput[] = [];
  const judge = async (input: LensJudgeInput) => {
    calls.push(input);
    return input.id === SAME
      ? { lensVerdict: '보강', why: '크롤 통과 기록은 우리 omni-crawl 관측에 보태야 한다.', target: 'omni-crawl' }
      : { lensVerdict: '참고', why: '릴리스 문맥일 뿐 우리 기능을 바꾸지 않는다.', target: 'release notes' };
  };
  try {
    const first = await annotateIntakeLens(root, DAY, { judge, now: () => '2026-10-05T00:00:00.000Z' });
    expect(first).toEqual({ judged: 2, skipped: 0, failed: 0, capped: false });
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.id)).toEqual([SAME, OTHER]);
    expect(calls[0]!.facts).toEqual([
      { fact: ROW_A.fact, current: ROW_A.current },
      { fact: ROW_B.fact, current: ROW_B.current },
    ]);
    expect(calls[0]!.url).toBe(ROW_A.url);
    const lens = join(root, 'intake', 'outbox', 'lens', `${DAY}.jsonl`);
    const rows = readFileSync(lens, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: SAME, at: '2026-10-05T00:00:00.000Z', lensVerdict: '보강', why: '크롤 통과 기록은 우리 omni-crawl 관측에 보태야 한다.', target: 'omni-crawl' });
    expect(rows[1].lensVerdict).toBe('참고');
    expect(rows[1].why).toBeTruthy();
    expect(rows[1].target).toBe('release notes');
    expect(readFileSync(review, 'utf8')).toBe(reviewText);

    const second = await annotateIntakeLens(root, DAY, { judge, now: () => '2026-10-05T01:00:00.000Z' });
    expect(second.judged).toBe(0);
    expect(calls).toHaveLength(2);
    expect(readFileSync(lens, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(readFileSync(review, 'utf8')).toBe(reviewText);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function ledgerRow(source: 'github' | 'x', n: number, at = `${DAY}T04:00:00.000Z`): IntakeItem {
  const url = source === 'github' ? `https://github.com/example/repo-${n}` : `https://x.com/i/status/${100000 + n}`;
  const row = shapeIntakeItem(source, { url, title: `${source} title ${n}`, text: `${source} text ${n}`, observedAt: at }, at);
  if (!row) throw new Error('expected a shaped ledger row');
  return row;
}

test('same-day public GitHub and X ledger items follow E1; title and text are facts and reruns do not rejudge', async () => {
  const { root, review, reviewText } = fixture();
  const github = ledgerRow('github', 1);
  const x = ledgerRow('x', 2);
  const previous = ledgerRow('github', 3, '2026-10-04T14:59:59.000Z');
  const privateX = { ...ledgerRow('x', 4), privacy: 'user-private' as const };
  const discarded = { ...ledgerRow('github', 5), status: 'discarded' as const };
  const alreadyInE1 = { ...ledgerRow('x', 6), id: SAME };
  const ledger = join(root, 'intake', 'items.jsonl');
  const original = [x, github, previous, privateX, discarded, alreadyInE1].map((row) => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(ledger, original);
  const calls: LensJudgeInput[] = [];
  const judge = async (input: LensJudgeInput) => {
    calls.push(input);
    return { lensVerdict: '참고', why: '현재 구현을 바꾸지 않는 비교 근거다.', target: 'intake' };
  };
  try {
    expect(await annotateIntakeLens(root, DAY, { judge })).toEqual({ judged: 4, skipped: 0, failed: 0, capped: false });
    expect(calls.map((call) => call.id)).toEqual([SAME, OTHER, github.id, x.id]);
    expect(calls[2]!.url).toBe(github.url);
    expect(calls[2]!.facts).toEqual([
      { fact: github.title!, current: '' }, { fact: github.text!, current: '' },
    ]);
    expect(calls[3]!.url).toBe(x.url);
    expect(calls[3]!.facts).toEqual([
      { fact: x.title!, current: '' }, { fact: x.text!, current: '' },
    ]);
    expect(await annotateIntakeLens(root, DAY, { judge })).toEqual({ judged: 0, skipped: 4, failed: 0, capped: false });
    expect(calls).toHaveLength(4);
    expect(readFileSync(ledger, 'utf8')).toBe(original);
    expect(readFileSync(review, 'utf8')).toBe(reviewText);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E1 and ledger items share the daily cap; the digest-style cap marker records deferred IDs', async () => {
  const { root } = fixture();
  const rows = Array.from({ length: 21 }, (_, n) => ledgerRow(n % 2 ? 'x' : 'github', n));
  const ordered = [...rows.filter((row) => row.sources.includes('github')), ...rows.filter((row) => row.sources.includes('x'))];
  writeFileSync(join(root, 'intake', 'items.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const calls: string[] = [];
  const caps: Record<string, unknown>[] = [];
  const judge = async (input: LensJudgeInput) => {
    calls.push(input.id);
    return { lensVerdict: '참고', why: '기능 변경과 직접 연결되지 않는다.', target: 'intake' };
  };
  try {
    const deps = { judge, log: (event: string, data: Record<string, unknown>) => { if (event === 'capped') caps.push(data); } };
    expect(await annotateIntakeLens(root, DAY, deps)).toEqual({ judged: 20, skipped: 0, failed: 0, capped: true });
    // 갈래별로 번갈아 채운다 — E1 2 를 다 쓴 뒤 GitHub·X 가 9 씩 나눠 갖는다.
    const gh = rows.filter((row) => row.sources.includes('github'));
    const xs = rows.filter((row) => row.sources.includes('x'));
    expect(calls).toEqual([SAME, OTHER, ...gh.slice(0, 9).map((row) => row.id), ...xs.slice(0, 9).map((row) => row.id)]);
    const skippedIds = [...gh.slice(9), ...xs.slice(9)].map((row) => row.id);
    expect(ordered).toHaveLength(21);
    expect(caps[0]).toEqual({ day: DAY, total: 23, judged: 20, skippedIds,
      pendingByLane: { outbox: 2, github: 11, x: 10 }, judgedByLane: { outbox: 2, github: 9, x: 9 }, doneByLane: {},
      marker: '외 3건 · 원장 `elanous intake items`' });
    expect(await annotateIntakeLens(root, DAY, deps)).toEqual({ judged: 0, skipped: 20, failed: 0, capped: true });
    expect(calls).toHaveLength(20);
    expect(caps[1]).toEqual({ day: DAY, total: 3, judged: 0, skippedIds,
      pendingByLane: { outbox: 0, github: 2, x: 1 }, judgedByLane: { outbox: 0, github: 0, x: 0 }, doneByLane: { outbox: 2, github: 9, x: 9 },
      marker: '외 3건 · 원장 `elanous intake items`' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a full E1 day no longer starves GitHub and X: each lane gets a turn under the cap', async () => {
  const { root, review } = fixture();
  const additional = Array.from({ length: 19 }, (_, n) => ({ id: `e1-${n}`, fact: `E1 fact ${n}`, current: '' }));
  writeFileSync(review, readFileSync(review, 'utf8') + additional.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const github = ledgerRow('github', 30);
  const x = ledgerRow('x', 31);
  writeFileSync(join(root, 'intake', 'items.jsonl'), `${JSON.stringify(github)}\n${JSON.stringify(x)}\n`);
  const calls: string[] = [];
  const caps: Record<string, unknown>[] = [];
  try {
    const result = await annotateIntakeLens(root, DAY, {
      judge: async ({ id }) => { calls.push(id); return { lensVerdict: '참고', why: '지금은 참조만 한다.', target: 'intake' }; },
      log: (event, data) => { if (event === 'capped') caps.push(data); },
    });
    expect(result).toEqual({ judged: 20, skipped: 0, failed: 0, capped: true });
    expect(calls).toEqual([SAME, OTHER, ...additional.slice(0, 16).map((row) => row.id), github.id, x.id]);
    expect(caps[0]).toEqual({ day: DAY, total: 23, judged: 20,
      skippedIds: additional.slice(16).map((row) => row.id),
      pendingByLane: { outbox: 21, github: 1, x: 1 }, judgedByLane: { outbox: 18, github: 1, x: 1 }, doneByLane: {},
      marker: '외 3건 · 원장 `elanous intake items`' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// S1 시뮬(10-12 06:4x): 흡수 10 · GitHub 166 · X 10 이면 옛 순서 채우기는 X 를 0 으로 남겼다(판정 E1 10 · GitHub 10 · X 0).
test('S1: absorbed 10 · GitHub 166 · X 10 → GitHub ≥1 and X ≥1 judged, total ≤ cap', async () => {
  const { root, review } = fixture();
  const e1 = Array.from({ length: 8 }, (_, n) => ({ id: `e1-${n}`, fact: `E1 fact ${n}`, current: '' }));
  writeFileSync(review, readFileSync(review, 'utf8') + e1.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const gh = Array.from({ length: 166 }, (_, n) => ledgerRow('github', n));
  const xs = Array.from({ length: 10 }, (_, n) => ledgerRow('x', 1000 + n));
  writeFileSync(join(root, 'intake', 'items.jsonl'), [...gh, ...xs].map((row) => JSON.stringify(row)).join('\n') + '\n');
  const calls: string[] = [];
  try {
    const result = await annotateIntakeLens(root, DAY, {
      judge: async ({ id }) => { calls.push(id); return { lensVerdict: '참고', why: '지금은 참조만 한다.', target: 'intake' }; },
      log: () => {},
    });
    expect(result.capped).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(LENS_DAILY_CAP);
    const ghIds = new Set(gh.map((row) => row.id));
    const xIds = new Set(xs.map((row) => row.id));
    expect(calls.filter((id) => ghIds.has(id)).length).toBeGreaterThanOrEqual(1);
    expect(calls.filter((id) => xIds.has(id)).length).toBeGreaterThanOrEqual(1);
    // 운영 모양(10-11): 흡수 10 ⊕ 뉴스 6 이 이미 줄을 써 남은 몫이 4 일 때도 GitHub·X 가 나눠 갖는다.
    expect(fairLensBatch(
      [...gh.slice(0, 5).map((row) => ({ id: row.id, lane: 'github' as const })), ...xs.slice(0, 5).map((row) => ({ id: row.id, lane: 'x' as const }))],
      { outbox: 10 }, 4,
    ).map((item) => item.lane)).toEqual(['github', 'github', 'x', 'x']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a schema-invalid lens reply is not recorded and is logged as judge-failed', async () => {
  const { root, review, reviewText } = fixture();
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  try {
    const result = await annotateIntakeLens(root, DAY, {
      judge: async () => ({ lensVerdict: '판단 필요', why: 'paths only src/a.ts src/b.ts', target: '' }),
      log: (event, data) => { logs.push({ event, data }); },
    });
    expect(result).toEqual({ judged: 0, skipped: 0, failed: 2, capped: false });
    expect(logs.filter((row) => row.event === 'judge-failed').map((row) => row.data.id)).toEqual([SAME, OTHER]);
    expect(logs.every((row) => row.data.reason === 'schema')).toBe(true);
    const lens = join(root, 'intake', 'outbox', 'lens', `${DAY}.jsonl`);
    expect(() => readFileSync(lens)).toThrow();
    expect(readFileSync(review, 'utf8')).toBe(reviewText);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a test process with no injected judge does not call the live LLM', async () => {
  const { root } = fixture();
  const previousNode = process.env.NODE_ENV;
  const previousHome = process.env.ELANOUS_TEST_HOME;
  process.env.NODE_ENV = 'test';
  delete process.env.ELANOUS_TEST_HOME;
  const logs: string[] = [];
  try {
    const result = await annotateIntakeLens(root, DAY, { log: (event) => { logs.push(event); } });
    expect(result).toEqual({ judged: 0, skipped: 0, failed: 0, capped: false });
    expect(logs).toEqual(['skipped-test']);
  } finally {
    if (previousNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNode;
    if (previousHome === undefined) delete process.env.ELANOUS_TEST_HOME; else process.env.ELANOUS_TEST_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
