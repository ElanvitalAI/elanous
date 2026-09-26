import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectGithubStars,
  DEFAULT_GITHUB_STAR_DAYS,
  DEFAULT_GITHUB_STAR_PER_QUERY,
  GITHUB_STAR_QUERIES,
  githubStarsFile,
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
  expect(item?.text).toBe('acme/agent desc');
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

test('기본 days 는 30 · 기본 per-query 는 20 · 질의는 열 개 미만이다', async () => {
  const r = root();
  const f = fake({});
  const res = await collectGithubStars(r, f, { day: DAY, dryRun: true });
  expect(res.days).toBe(DEFAULT_GITHUB_STAR_DAYS);
  expect(DEFAULT_GITHUB_STAR_DAYS).toBe(30);
  expect(res.perQuery).toBe(DEFAULT_GITHUB_STAR_PER_QUERY);
  expect(GITHUB_STAR_QUERIES.length).toBeLessThan(10);
  expect(f.calls).toHaveLength(GITHUB_STAR_QUERIES.length);
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
