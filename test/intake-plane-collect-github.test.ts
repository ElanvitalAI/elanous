import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectGithubStars as collectGithubStarsWithReadme,
  type CollectGithubOpts,
  DEFAULT_GITHUB_STAR_DAYS,
  DEFAULT_GITHUB_STAR_PER_QUERY,
  GITHUB_STAR_QUERIES,
  githubStarsFile,
  reposFromGhSearchItems,
  type GithubStarRepo,
  type SearchGithubRepos,
} from '../src/intake-plane/collect-github.js';
import { listIntakeItems } from '../src/intake-plane/items.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const root = () => { const r = mkdtempSync(join(tmpdir(), 'intake-gh-')); roots.push(r); return r; };

const repo = (fullName: string, stars: number, extra: Partial<GithubStarRepo> = {}): GithubStarRepo => ({
  fullName,
  url: `https://github.com/${fullName}`,
  description: `${fullName} desc`,
  stars,
  createdAt: '2026-09-20T00:00:00.000Z',
  pushedAt: '2026-09-25T00:00:00.000Z',
  ...extra,
});

function fake(byQuery: Record<string, GithubStarRepo[]>): SearchGithubRepos & { calls: { query: string; perQuery: number }[] } {
  const calls: { query: string; perQuery: number }[] = [];
  const f = (async (query: string, perQuery: number) => {
    calls.push({ query, perQuery });
    // 수집기는 질의 뒤에 생성일 창(`created:>=…`)을 붙인다 — 가짜는 주제 질의로 찾는다.
    return (byQuery[query.replace(/ created:>=\S+$/, '')] ?? []).slice(0, perQuery);
  }) as SearchGithubRepos & { calls: { query: string; perQuery: number }[] };
  f.calls = calls;
  return f;
}

const DAY = '2026-09-26';

// 기존 수집 계약 검증은 네트워크 대신 README 주입을 고정한다.
const collectGithubStars = (r: string, search: SearchGithubRepos, opts: CollectGithubOpts = {}) =>
  collectGithubStarsWithReadme(r, search, { fetchReadme: async () => 'test README', ...opts });

test('같은 저장소가 두 질의에서 나와도 원장·수집 결과는 하나다', async () => {
  const r = root();
  const shared = repo('acme/agent', 160);
  const f = fake({
    [GITHUB_STAR_QUERIES[0]]: [shared],
    [GITHUB_STAR_QUERIES[1]]: [shared, repo('other/tool', 10)],
  });
  const res = await collectGithubStars(r, f, { day: DAY, days: 30, perQuery: 20 });
  expect(res.repos).toHaveLength(2);
  expect(res.repos.filter((row) => row.repo === 'acme/agent')).toHaveLength(1);
  expect(listIntakeItems(r, { source: 'github' }).filter((i) => i.url === 'https://github.com/acme/agent')).toHaveLength(1);
  expect(f.calls.map((c) => c.query.replace(/ created:>=\S+$/, ''))).toEqual([...GITHUB_STAR_QUERIES]);
  expect(f.calls.every((c) => c.perQuery === 20)).toBe(true);
});

test('어제 별 100 · 오늘 별 160 이면 github.starsDelta 는 60 이다', async () => {
  const r = root();
  mkdirSync(join(r, 'intake'), { recursive: true });
  writeFileSync(githubStarsFile(r), JSON.stringify({ day: '2026-09-25', repo: 'acme/agent', stars: 100 }) + '\n');
  const res = await collectGithubStars(r, fake({ [GITHUB_STAR_QUERIES[0]]: [repo('acme/agent', 160)] }), { day: DAY });
  const item = listIntakeItems(r).find((i) => i.title === 'acme/agent');
  expect(item?.signals['github.starsDelta']).toBe(60);
  expect(item?.signals['github.starsPerDay']).toBe(60);
  expect(item?.signals['github.stars']).toBe(160);
  expect(item?.url).toBe('https://github.com/acme/agent');
  expect(item?.text).toBe('라이선스: 미상\nREADME:\ntest README\nacme/agent desc');
  expect(res.repos[0]).toMatchObject({ starsDelta: 60, starsPerDay: 60 });
  const lines = readFileSync(githubStarsFile(r), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(lines.at(-1)).toEqual({ day: DAY, repo: 'acme/agent', stars: 160 });
});

test('직전 스냅숏이 없으면 github.starsDelta 칸을 싣지 않는다', async () => {
  const r = root();
  const res = await collectGithubStars(r, fake({ [GITHUB_STAR_QUERIES[0]]: [repo('acme/agent', 160)] }), { day: DAY });
  const item = listIntakeItems(r)[0];
  expect(item?.signals['github.stars']).toBe(160);
  expect(Object.prototype.hasOwnProperty.call(item?.signals ?? {}, 'github.starsDelta')).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(item?.signals ?? {}, 'github.starsPerDay')).toBe(false);
  expect(res.repos[0]?.starsDelta).toBeUndefined();
  expect(res.repos[0]?.starsPerDay).toBeUndefined();
});

test('dry-run 은 원장·스냅숏을 바꾸지 않고 질의별 받은 수와 저장소 목록을 낸다', async () => {
  const r = root();
  const res = await collectGithubStars(r, fake({
    [GITHUB_STAR_QUERIES[0]]: [repo('acme/agent', 10), repo('old/one', 9, { createdAt: '2020-01-01T00:00:00.000Z', pushedAt: '2020-01-02T00:00:00.000Z' })],
    [GITHUB_STAR_QUERIES[2]]: [repo('video/gen', 4)],
  }), { day: DAY, dryRun: true });
  expect(res.dryRun).toBe(true);
  expect(res.ingest).toBeUndefined();
  expect(res.queries.find((q) => q.query === GITHUB_STAR_QUERIES[0])?.received).toBe(1);
  expect(res.queries.find((q) => q.query === GITHUB_STAR_QUERIES[2])?.received).toBe(1);
  expect(res.repos.map((row) => row.repo).sort()).toEqual(['acme/agent', 'video/gen']);
  expect(listIntakeItems(r)).toHaveLength(0);
  expect(() => readFileSync(githubStarsFile(r), 'utf8')).toThrow();
});

test('기본 days 는 30 · 기본 per-query 는 20 · 질의는 열 개 이하다', async () => {
  const r = root();
  const f = fake({});
  const res = await collectGithubStars(r, f, { day: DAY, dryRun: true });
  expect(res.days).toBe(DEFAULT_GITHUB_STAR_DAYS);
  expect(DEFAULT_GITHUB_STAR_DAYS).toBe(30);
  expect(res.perQuery).toBe(DEFAULT_GITHUB_STAR_PER_QUERY);
  expect(GITHUB_STAR_QUERIES.length).toBeLessThanOrEqual(10);
  for (const topic of ['agent-framework', 'computer-use', 'local-llm', 'claude-code', 'codex', 'agent-memory']) {
    expect(GITHUB_STAR_QUERIES).toContain(`topic:${topic}` as (typeof GITHUB_STAR_QUERIES)[number]);
  }
  expect(f.calls).toHaveLength(GITHUB_STAR_QUERIES.length);
  expect(f.calls.length).toBeLessThanOrEqual(10);
});

test('7일 이전 가장 가까운 스냅숏으로 급등률을 계산하고 별 순보다 앞세운다', async () => {
  const r = root();
  mkdirSync(join(r, 'intake'), { recursive: true });
  writeFileSync(githubStarsFile(r), [
    { day: '2026-09-16', repo: 'acme/surge', stars: 100 },
    { day: '2026-09-19', repo: 'acme/surge', stars: 200 },
    { day: '2026-09-25', repo: 'acme/surge', stars: 690 },
    { day: '2026-09-19', repo: 'other/large', stars: 1000 },
  ].map((s) => JSON.stringify(s)).join('\n') + '\n');
  const res = await collectGithubStars(r, fake({
    [GITHUB_STAR_QUERIES[0]]: [repo('other/large', 1070), repo('acme/surge', 700, { license: 'MIT' }), repo('new/top', 2000)],
  }), { day: DAY });
  expect(res.repos.map((row) => row.repo)).toEqual(['acme/surge', 'other/large', 'new/top']);
  expect(res.repos[0]).toMatchObject({ starsDelta: 10, starsPerDay: 500 / 7, baselineDays: 7, license: 'MIT' });
  expect(res.repos[1]).toMatchObject({ starsPerDay: 10, baselineDays: 7 });
  expect(res.repos[2]?.starsPerDay).toBeUndefined();
  expect(listIntakeItems(r).find((i) => i.title === 'acme/surge')?.text).toBe('라이선스: MIT\nREADME:\ntest README\nacme/surge desc');
  expect(readFileSync(githubStarsFile(r), 'utf8').trim().split('\n').at(-1)).toBe(JSON.stringify({ day: DAY, repo: 'new/top', stars: 2000 }));
});

test('README 는 별 총합이 아니라 starsPerDay 상위 3개만 받으며 라이선스 다음에 1,500자만 싣는다', async () => {
  const r = root();
  mkdirSync(join(r, 'intake'), { recursive: true });
  writeFileSync(githubStarsFile(r), [
    { day: '2026-09-25', repo: 'acme/fast', stars: 10 },
    { day: '2026-09-25', repo: 'acme/second', stars: 20 },
    { day: '2026-09-25', repo: 'acme/third', stars: 30 },
    { day: '2026-09-25', repo: 'acme/slow', stars: 9990 },
  ].map((snapshot) => JSON.stringify(snapshot)).join('\n') + '\n');
  const calls: string[] = [];
  const res = await collectGithubStars(r, fake({ [GITHUB_STAR_QUERIES[0]]: [
    repo('acme/slow', 9991), repo('acme/third', 33), repo('acme/fast', 110, { license: 'MIT' }),
    repo('acme/second', 30),
  ] }), { day: DAY, fetchReadme: async (name) => { calls.push(name); return 'X'.repeat(1501); } });
  expect(res.repos.map((row) => row.repo)).toEqual(['acme/fast', 'acme/second', 'acme/third', 'acme/slow']);
  expect(calls).toEqual(['acme/fast', 'acme/second', 'acme/third']);
  expect(listIntakeItems(r).find((item) => item.title === 'acme/fast')?.text)
    .toBe(`라이선스: MIT\nREADME:\n${'X'.repeat(1500)}\nacme/fast desc`);
  expect(listIntakeItems(r).find((item) => item.title === 'acme/slow')?.text)
    .toBe('라이선스: 미상\nacme/slow desc');
  expect(readFileSync(githubStarsFile(r), 'utf8').trim().split('\n').at(-1))
    .toBe(JSON.stringify({ day: DAY, repo: 'acme/slow', stars: 9991 }));
});

test('dry-run 은 README 조회 없이 기존 저장소 결과만 돌려준다', async () => {
  const r = root();
  const calls: string[] = [];
  const res = await collectGithubStarsWithReadme(r, fake({ [GITHUB_STAR_QUERIES[0]]: [
    repo('acme/first', 30), repo('acme/second', 20), repo('acme/third', 10),
  ] }), { day: DAY, dryRun: true, fetchReadme: async (name) => {
    calls.push(name);
    throw new Error('dry-run must not fetch README');
  } });
  expect(calls).toEqual([]);
  expect(res.repos.map((row) => row.repo)).toEqual(['acme/first', 'acme/second', 'acme/third']);
  expect(res.raws).toBe(3);
  expect(res.ingest).toBeUndefined();
  expect(listIntakeItems(r)).toHaveLength(0);
  expect(() => readFileSync(githubStarsFile(r), 'utf8')).toThrow();
});

test('README 받기 실패는 그 저장소에만 미상 한 줄을 남기고 나머지는 계속 수집한다', async () => {
  const r = root();
  const calls: string[] = [];
  const res = await collectGithubStars(r, fake({ [GITHUB_STAR_QUERIES[0]]: [
    repo('acme/first', 30), repo('acme/second', 20), repo('acme/third', 10),
  ] }), { day: DAY, fetchReadme: async (name) => {
    calls.push(name);
    if (name === 'acme/first') throw new Error('HTTP 404');
    return `body ${name}`;
  } });
  expect(calls).toEqual(['acme/first', 'acme/second', 'acme/third']);
  expect(res.raws).toBe(3);
  expect(res.ingest?.added).toBe(3);
  const items = listIntakeItems(r);
  expect(items.find((item) => item.title === 'acme/first')?.text)
    .toBe('라이선스: 미상\nREADME 미상\nacme/first desc');
  expect(items.find((item) => item.title === 'acme/second')?.text)
    .toBe('라이선스: 미상\nREADME:\nbody acme/second\nacme/second desc');
});

test('7일 이전 스냅숏이 없으면 직전 스냅숏으로 계산한다', async () => {
  const r = root();
  mkdirSync(join(r, 'intake'), { recursive: true });
  writeFileSync(githubStarsFile(r), JSON.stringify({ day: '2026-09-25', repo: 'acme/agent', stars: 690 }) + '\n');
  const res = await collectGithubStars(r, fake({ [GITHUB_STAR_QUERIES[0]]: [repo('acme/agent', 700)] }), { day: DAY, dryRun: true });
  expect(res.repos[0]).toMatchObject({ starsDelta: 10, starsPerDay: 10, baselineDays: 1 });
});

test('원장 본문 첫 줄은 언제나 라이선스 — SPDX ID · 확인된 부재는 없음 · 알려 주지 않으면 미상', async () => {
  const r = root();
  const source = [
    { full_name: 'acme/licensed', html_url: 'https://github.com/acme/licensed', description: 'MIT project', stargazers_count: 12, created_at: '2026-09-20T00:00:00Z', pushed_at: '2026-09-25T00:00:00Z', license: { spdx_id: 'MIT' } },
    { full_name: 'acme/unlicensed', html_url: 'https://github.com/acme/unlicensed', description: 'no license', stargazers_count: 11, created_at: '2026-09-20T00:00:00Z', pushed_at: '2026-09-25T00:00:00Z', license: null },
    { full_name: 'acme/unknown', html_url: 'https://github.com/acme/unknown', description: 'unchecked', stargazers_count: 10, created_at: '2026-09-20T00:00:00Z', pushed_at: '2026-09-25T00:00:00Z' },
    { full_name: 'acme/unverified', html_url: 'https://github.com/acme/unverified', description: 'spdx not reported', stargazers_count: 9, created_at: '2026-09-20T00:00:00Z', pushed_at: '2026-09-25T00:00:00Z', license: { spdx_id: null } },
  ];
  const parsed = reposFromGhSearchItems(source, 20);
  expect(parsed.map((row) => row.license)).toEqual(['MIT', '없음', undefined, undefined]);
  const result = await collectGithubStars(r, fake({ [GITHUB_STAR_QUERIES[0]]: parsed }), { day: DAY });
  expect(result.repos.map((row) => row.license)).toEqual(['MIT', '없음', undefined, undefined]);
  const byTitle = (name: string) => listIntakeItems(r).find((i) => i.title === `acme/${name}`)?.text;
  expect(byTitle('licensed')).toBe('라이선스: MIT\nREADME:\ntest README\nMIT project');
  expect(byTitle('unlicensed')).toBe('라이선스: 없음\nREADME:\ntest README\nno license');
  expect(byTitle('unknown')).toBe('라이선스: 미상\nREADME:\ntest README\nunchecked');
  expect(byTitle('unverified')).toBe('라이선스: 미상\nspdx not reported');
});

test('최근 창 밖(생성·푸시 모두 오래됨)은 받지 않는다', async () => {
  const r = root();
  const res = await collectGithubStars(r, fake({
    [GITHUB_STAR_QUERIES[0]]: [repo('stale/repo', 999, { createdAt: '2024-01-01T00:00:00.000Z', pushedAt: '2024-06-01T00:00:00.000Z' })],
  }), { day: DAY, days: 30 });
  expect(res.repos).toHaveLength(0);
  expect(listIntakeItems(r)).toHaveLength(0);
});

test('검색 질의는 최근 창의 생성일로 좁힌다 — 급상승은 새 저장소 중 별 순', async () => {
  const { collectGithubStars } = await import('../src/intake-plane/collect-github.js');
  const seen: string[] = [];
  await collectGithubStars(mkdtempSync(join(tmpdir(), 'gh-q-')), async (q) => { seen.push(q); return []; }, { day: '2026-09-26', days: 30, dryRun: true });
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((q) => q.endsWith('created:>=2026-08-27'))).toBe(true);
});
