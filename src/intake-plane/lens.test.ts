import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { annotateIntakeLens, type LensJudgeInput } from './lens.js';

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
