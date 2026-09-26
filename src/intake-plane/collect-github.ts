// 흡수 입력원 I3 — GitHub star 급상승 저장소를 읽기만 해 흡수 원장에 넣는다.
// 네트워크(`gh api search/repositories`)는 주입 함수 하나로 감싼다. 시험은 그 함수를 가짜로 바꾼다.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { debug } from '../debug/log.js';
import { ingestIntakeItems, intakeLedgerDir, type IngestResult, type RawIntakeItem } from './items.js';

/** 한 판에 열 번 안쪽 — 검색 API 비율 제한(인증 시 분당 30회)을 시험 밖에서 상수로 묶는다. */
export const GITHUB_STAR_QUERIES = [
  'topic:ai-agents',
  'topic:llm-agent',
  'topic:coding-agent',
  'topic:mcp',
  'topic:video-generation',
  '"ai agent" in:name,description',
] as const;

/** `--days` 기본. 최근 이 일수 안에 만들어졌거나 푸시된 저장소만 받는다. */
export const DEFAULT_GITHUB_STAR_DAYS = 30;

/**
 * `--per-query` 기본. 질의마다 별 순 상위 이 개수만 받는다.
 * 검색 API 한 페이지(최대 100)보다 작게 잡아 한 판의 응답을 한 호출로 끝낸다.
 */
export const DEFAULT_GITHUB_STAR_PER_QUERY = 20;

export interface GithubStarRepo {
  fullName: string;
  url: string;
  description: string;
  stars: number;
  createdAt: string;
  pushedAt: string;
}

/** 질의 하나 → 저장소 목록. 실제 구현은 `gh api` · 시험은 가짜. */
export type SearchGithubRepos = (query: string, perQuery: number) => Promise<GithubStarRepo[]>;

export interface StarSnapshot { day: string; repo: string; stars: number }

export interface GithubStarSignals {
  stars: number;
  starsDelta?: number;
  starsPerDay?: number;
}

export interface CollectGithubQueryCount { query: string; received: number }

export interface CollectGithubRepoRow {
  repo: string;
  url: string;
  title: string;
  text: string;
  stars: number;
  starsDelta?: number;
  starsPerDay?: number;
}

export interface CollectGithubResult {
  day: string;
  days: number;
  perQuery: number;
  dryRun: boolean;
  queries: CollectGithubQueryCount[];
  repos: CollectGithubRepoRow[];
  raws: number;
  ingest?: IngestResult;
}

export function githubStarsFile(root: string): string {
  return join(intakeLedgerDir(root), 'github-stars.jsonl');
}

export function readStarSnapshots(root: string): StarSnapshot[] {
  try {
    const text = readFileSync(githubStarsFile(root), 'utf8');
    const out: StarSnapshot[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as StarSnapshot;
        if (o && typeof o.repo === 'string' && typeof o.day === 'string' && Number.isFinite(o.stars)) out.push(o);
      } catch { /* 깨진 줄은 건너뛴다 */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** 같은 저장소의 직전 스냅숏 — 오늘보다 앞선 날 중 가장 최근. 없으면 undefined. */
export function precedingSnapshot(snaps: readonly StarSnapshot[], repo: string, day: string): StarSnapshot | undefined {
  let best: StarSnapshot | undefined;
  for (const s of snaps) {
    if (s.repo !== repo || s.day >= day) continue;
    if (!best || s.day > best.day) best = s;
  }
  return best;
}

function utcDay(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toISOString().slice(0, 10);
}

function daysBetween(earlierDay: string, laterDay: string): number {
  const a = Date.parse(`${earlierDay}T00:00:00.000Z`);
  const b = Date.parse(`${laterDay}T00:00:00.000Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** 최근 `days` 일 안에 만들어졌거나 푸시됐으면 참. 날짜를 못 읽으면 버린다. */
export function isRecentRepo(repo: Pick<GithubStarRepo, 'createdAt' | 'pushedAt'>, day: string, days: number): boolean {
  const windowStart = new Date(Date.parse(`${day}T00:00:00.000Z`) - days * 86_400_000).toISOString().slice(0, 10);
  const created = utcDay(repo.createdAt);
  const pushed = utcDay(repo.pushedAt);
  return (created !== '' && created >= windowStart) || (pushed !== '' && pushed >= windowStart);
}

/**
 * 직전 스냅숏이 있으면 증가량과 하루당 증가를 싣는다. 없으면 두 칸을 두지 않는다(0 으로 채우지 않는다).
 * 같은 날이면 분모는 1 로 둔다 — 0 으로 나누지 않는다.
 */
export function signalsFromSnapshot(stars: number, prev: StarSnapshot | undefined, day: string): GithubStarSignals {
  if (!prev) return { stars };
  const span = Math.max(1, daysBetween(prev.day, day));
  const starsDelta = stars - prev.stars;
  return { stars, starsDelta, starsPerDay: starsDelta / span };
}

function appendSnapshots(root: string, rows: StarSnapshot[]): void {
  if (!rows.length) return;
  mkdirSync(intakeLedgerDir(root), { recursive: true });
  appendFileSync(githubStarsFile(root), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function dedupeRepos(found: readonly GithubStarRepo[]): GithubStarRepo[] {
  const byName = new Map<string, GithubStarRepo>();
  for (const repo of found) {
    const key = repo.fullName.toLowerCase();
    if (!key || byName.has(key)) continue;
    byName.set(key, repo);
  }
  return [...byName.values()];
}

export interface CollectGithubOpts {
  days?: number;
  perQuery?: number;
  dryRun?: boolean;
  /** 스냅숏·비교의 «오늘». 생략하면 UTC 날짜. */
  day?: string;
  now?: () => Date;
}

/**
 * 관심 주제 질의마다 별 순 검색을 부르고, 최근 창 안의 저장소만 남긴 뒤 질의 사이에서 중복을 없앤다.
 * 저장소마다 오늘 별 수 스냅숏을 덧붙이고, 직전 스냅숏과 비교한 신호를 원장에 넣는다.
 * dryRun 이면 스냅숏·원장을 바꾸지 않는다.
 */
export async function collectGithubStars(
  root: string,
  search: SearchGithubRepos,
  opts: CollectGithubOpts = {},
): Promise<CollectGithubResult> {
  const days = Math.max(1, opts.days ?? DEFAULT_GITHUB_STAR_DAYS);
  const perQuery = Math.max(1, opts.perQuery ?? DEFAULT_GITHUB_STAR_PER_QUERY);
  const day = opts.day ?? (opts.now ?? (() => new Date()))().toISOString().slice(0, 10);
  const queries: CollectGithubQueryCount[] = [];
  const found: GithubStarRepo[] = [];
  // «급상승»은 최근에 생긴 저장소 중 별 순이다 — 전체 기간 별 순이면 활발한 거대 저장소가 매일 같은 목록으로 나온다(2026-09-26 검토).
  const windowStart = new Date(Date.parse(`${day}T00:00:00.000Z`) - days * 86_400_000).toISOString().slice(0, 10);
  for (const query of GITHUB_STAR_QUERIES) {
    const rows = await search(`${query} created:>=${windowStart}`, perQuery);
    const recent = rows.filter((r) => isRecentRepo(r, day, days));
    queries.push({ query, received: recent.length });
    found.push(...recent);
  }
  const unique = dedupeRepos(found);
  const prior = readStarSnapshots(root);
  const repos: CollectGithubRepoRow[] = unique.map((repo) => {
    const prev = precedingSnapshot(prior, repo.fullName, day);
    const signals = signalsFromSnapshot(repo.stars, prev, day);
    return {
      repo: repo.fullName,
      url: repo.url,
      title: repo.fullName,
      text: repo.description,
      stars: signals.stars,
      ...(signals.starsDelta !== undefined ? { starsDelta: signals.starsDelta } : {}),
      ...(signals.starsPerDay !== undefined ? { starsPerDay: signals.starsPerDay } : {}),
    };
  });
  const raws: RawIntakeItem[] = repos.map((row) => ({
    url: row.url,
    title: row.title,
    text: row.text,
    signals: {
      stars: row.stars,
      ...(row.starsDelta !== undefined ? { starsDelta: row.starsDelta } : {}),
      ...(row.starsPerDay !== undefined ? { starsPerDay: row.starsPerDay } : {}),
    },
  }));
  const result: CollectGithubResult = {
    day, days, perQuery, dryRun: !!opts.dryRun, queries, repos, raws: raws.length,
  };
  if (!opts.dryRun) {
    appendSnapshots(root, repos.map((row) => ({ day, repo: row.repo, stars: row.stars })));
    result.ingest = ingestIntakeItems(root, 'github', raws);
  }
  debug.log('intake.collect', 'github-stars', {
    day, days, perQuery, queries: queries.length, repos: repos.length, dryRun: !!opts.dryRun,
  });
  return result;
}

interface GhSearchItem {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  stargazers_count?: number;
  created_at?: string;
  pushed_at?: string;
}

/** `gh api search/repositories` 를 `sort=stars` 로 한 번 부른다. */
export const ghApiSearchRepos: SearchGithubRepos = async (query, perQuery) => {
  const perPage = Math.min(100, Math.max(1, perQuery));
  const q = `${query} sort:stars`;
  const out = execFileSync('gh', [
    'api',
    '-X', 'GET',
    'search/repositories',
    '-f', `q=${q}`,
    '-f', 'sort=stars',
    '-f', 'order=desc',
    '-f', `per_page=${perPage}`,
    '--jq', '.items',
  ], { encoding: 'utf8', timeout: 30_000 });
  const items = JSON.parse(out) as GhSearchItem[];
  if (!Array.isArray(items)) return [];
  const repos: GithubStarRepo[] = [];
  for (const item of items) {
    if (!item.full_name || !item.html_url) continue;
    repos.push({
      fullName: item.full_name,
      url: item.html_url,
      description: item.description ?? '',
      stars: Number(item.stargazers_count ?? 0),
      createdAt: item.created_at ?? '',
      pushedAt: item.pushed_at ?? '',
    });
  }
  return repos.slice(0, perQuery);
};
