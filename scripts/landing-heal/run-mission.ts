#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { githubAutomationToken } from '../../src/auth/github-app-token.js';
import { debug } from '../../src/debug/log.js';
import { emitDecision } from '../../src/live/detail-switch.js';
import { parse } from '../../src/agent-substrate/pr-comment-meta.js';
import { classifyReviewRounds, matchMustFix, type MustFixVerdict } from './must-fix-match.js';

interface PullRequest {
  number: number;
  title: string;
  state: string;
  mergedAt: string | null;
  headRefName: string;
  files: Array<{ path: string }>;
}
interface Match { pr: number; text: string; verdict: MustFixVerdict | 'rereviewed' | 'open'; run?: string; round?: number; resolvedIn?: number[] }
interface GraphContext { runId?: string; input?: { windowMinutes?: number; mustFixByPr?: Record<string, string[]> }; outputs?: Record<string, unknown>; decision?: typeof emitDecision }
export type RunCommand = (args: string[]) => string;
// 상주 루프(30분마다)는 사람 계정 한도를 쓰지 않는다 — 부른 쪽이 GH_TOKEN 을 주지 않았으면 GitHub App 설치 토큰으로(09-29 한도 소진).
// 발급 함수마다 한 번(프로세스 전역 한 칸이면 앞선 호출의 진짜 토큰이 주입한 가짜를 이긴다 — 09-29 시험 실패 출력에 토큰이 찍혔다).
const minted = new WeakMap<() => string | null, string | null>();
export function ghEnv(env: NodeJS.ProcessEnv = process.env, mint: () => string | null = githubAutomationToken): NodeJS.ProcessEnv {
  if (Object.hasOwn(env, 'GH_TOKEN')) return env;
  if (!minted.has(mint)) minted.set(mint, mint());
  const appToken = minted.get(mint);
  debug.log('landing-heal', 'gh-token', { source: appToken ? 'github-app' : 'caller' });
  return appToken ? { ...env, GH_TOKEN: appToken } : env;
}
// 상주 루프는 설치본 폴더(git 저장소 아님)에서 돈다 — `gh` 가 저장소를 추론 못 해 첫 cron 바퀴가 collect 에서 죽었다(09-29 21:00).
// 부른 쪽이 GH_REPO 를 주지 않았고 cwd 가 git 저장소가 아니면, App 설치의 저장소가 «정확히 하나»일 때 그것을 쓴다(모르면 멈춘다).
export async function ghRepoEnv(env: NodeJS.ProcessEnv, cwd: string, list: (token: string) => Promise<string[]> = installationRepos): Promise<NodeJS.ProcessEnv> {
  if (Object.hasOwn(env, 'GH_REPO') || insideGitCheckout(cwd)) return env;
  const token = env.GH_TOKEN;
  if (!token) throw new Error('GitHub repository unknown outside a git checkout — set GH_REPO');
  const repos = await list(token);
  if (repos.length !== 1) throw new Error(`GitHub repository unknown outside a git checkout — App installation has ${repos.length} repositories; set GH_REPO`);
  debug.log('landing-heal', 'gh-repo', { source: 'github-app-installation', repo: repos[0] });
  return { ...env, GH_REPO: repos[0] };
}
function insideGitCheckout(cwd: string): boolean {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return true;
    if (dirname(dir) === dir) return false;
  }
}
async function installationRepos(token: string): Promise<string[]> {
  const response = await fetch('https://api.github.com/installation/repositories?per_page=2', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`GitHub App installation repositories: HTTP ${response.status}`);
  const body = await response.json() as { repositories?: Array<{ full_name?: string }> };
  return (body.repositories ?? []).flatMap((repo) => repo.full_name ? [repo.full_name] : []);
}
let resolvedEnv: NodeJS.ProcessEnv | undefined;
const gh: RunCommand = (args) => {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: resolvedEnv ?? ghEnv() });
  if (result.error || result.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${result.stderr || String(result.error)}`);
  return result.stdout;
};

function context(): GraphContext {
  const path = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!path) throw new Error('ELANOUS_GRAPH_CONTEXT required');
  return JSON.parse(readFileSync(path, 'utf8')) as GraphContext;
}

function output(ctx: GraphContext, node: string): Record<string, unknown> {
  const value = ctx.outputs?.[node];
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    const line = value.trim().split('\n').at(-1);
    if (line) return JSON.parse(line) as Record<string, unknown>;
  }
  throw new Error(`missing ${node} output`);
}

function pullRequests(ctx: GraphContext): PullRequest[] {
  const value = output(ctx, 'collect').prs;
  if (!Array.isArray(value)) throw new Error('missing collected PRs');
  return value as PullRequest[];
}

/** 착지 뒤 검증 표식 — 코멘트 «첫 줄»이 `landing-verified:` 로 시작하고 뒤에 무엇이든 한 글자는 있어야 한다(빈 표식은 표식이 아니다). */
export function isLandingVerified(body: string | undefined): boolean {
  return /^landing-verified:\s*\S/.test((body ?? '').trimStart().split('\n')[0] ?? '');
}

/** 코멘트 «첫 줄»이 `must-fix resolved in #N[, #M]` 이면 그 PR 번호들. */
export function resolvedInPrs(body: string | undefined): number[] {
  const first = (body ?? '').trimStart().split('\n')[0] ?? '';
  const match = /^must[-\s]?fix resolved in (#\d+(?:\s*,\s*#\d+)*)/i.exec(first);
  return match ? [...match[1]!.matchAll(/#(\d+)/g)].map((m) => Number(m[1])) : [];
}

export function runMission(mission: string, ctx: GraphContext, run: RunCommand = gh, now = new Date()): Record<string, unknown> {
  switch (mission) {
    case 'collect': {
      const minutes = ctx.input?.windowMinutes ?? 60;
      if (!Number.isSafeInteger(minutes) || minutes < 1) throw new Error('windowMinutes must be a positive integer');
      const since = new Date(now.getTime() - minutes * 60_000);
      const rows = JSON.parse(run(['pr', 'list', '--state', 'all', '--search', `updated:>=${since.toISOString()}`, '--limit', '200', '--json', 'number,title,state,mergedAt,headRefName,files'])) as PullRequest[];
      if (!Array.isArray(rows)) throw new Error('gh pr list did not return an array');
      const prs = rows.filter((pr) => /^(?:self-impl\/|self-implement\/)/.test(pr.headRefName ?? '') &&
        (pr.state === 'OPEN' || (pr.state === 'MERGED' && !!pr.mergedAt && Date.parse(pr.mergedAt) >= since.getTime())));
      return { outcome: 'ok', prs, since: since.toISOString() };
    }
    case 'must-fix-match': {
      const matches: Match[] = [];
      for (const pr of pullRequests(ctx)) {
        const details = JSON.parse(run(['pr', 'view', String(pr.number), '--json', 'reviews,comments'])) as {
          reviews?: Array<{ body?: string }>;
          comments?: Array<{ body?: string }>;
        };
        const pages = JSON.parse(run(['api', `repos/{owner}/{repo}/pulls/${pr.number}/comments`, '--paginate', '--slurp'])) as Array<Array<{ body?: string }>>;
        if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error(`invalid review comments for PR #${pr.number}`);
        const inline = pages.flat();
        const comments = [...(details.reviews ?? []), ...(details.comments ?? []), ...inline];
        const reviewRounds = comments.filter(({ body }) => {
          const meta = body ? parse(body) : null;
          return meta?.role === 'reviewer' && !!meta.run && meta.round !== undefined;
        });
        // 뒤 PR 로 고친 must-fix 는 원래 PR 에 첫 줄 `must-fix resolved in #N` 코멘트를 남긴다(🅞·🅣 09-29 합의) — 그 PR 의 «열린» 항목을 풀고, 그 코멘트 자체는 must-fix 로 세지 않는다.
        const resolvedNotes = comments.filter(({ body }) => resolvedInPrs(body).length > 0);
        const resolvedIn = [...new Set(resolvedNotes.flatMap(({ body }) => resolvedInPrs(body)))].sort((a, b) => a - b);
        const classified = classifyReviewRounds(reviewRounds).map((item) => item.verdict === 'open' && resolvedIn.length
          ? { ...item, verdict: 'resolved' as const, resolvedIn } : item);
        const mustFixes = [...(ctx.input?.mustFixByPr?.[String(pr.number)] ?? []),
          ...comments.filter((comment) => !reviewRounds.includes(comment) && !resolvedNotes.includes(comment))
            .flatMap(({ body }) => body && /must[-\s]?fix/i.test(body) ? [body] : [])];
        const diff = mustFixes.length ? run(['pr', 'diff', String(pr.number), '--patch']) : '';
        const prMatches: Match[] = [
          ...classified.map((item) => ({ pr: pr.number, ...item })),
          ...mustFixes.map((text) => ({ pr: pr.number, text, verdict: matchMustFix(text, diff) })),
        ];
        matches.push(...prMatches);
        debug.log('landing-heal', 'must-fix-classified', {
          pr: pr.number,
          rereviewed: prMatches.filter((item) => item.verdict === 'rereviewed').length,
          open: prMatches.filter((item) => item.verdict === 'open').length,
          unknown: prMatches.filter((item) => item.verdict === 'unknown').length,
        });
      }
      return { outcome: 'ok', matches };
    }
    case 'verify-needed': {
      const candidates = pullRequests(ctx)
        .filter((pr) => pr.state === 'MERGED' && pr.files.some((file) => file.path.startsWith('apps/pwa/') || file.path.startsWith('src/')));
      // 착지 뒤 검증을 끝낸 쪽은 PR 코멘트 첫 줄 `landing-verified: <sha> · <무엇을 쟀나>` 를 남긴다(🅞·🅣 09-29 합의) — 그 PR 은 뺀다.
      const verified: number[] = [];
      const verifyNeeded = candidates.filter((pr) => {
        const { comments } = JSON.parse(run(['pr', 'view', String(pr.number), '--json', 'comments'])) as { comments?: Array<{ body?: string }> };
        const done = (comments ?? []).some((comment) => isLandingVerified(comment.body));
        if (done) verified.push(pr.number);
        return !done;
      }).map((pr) => pr.number);
      return { outcome: 'ok', verifyNeeded, verified };
    }
    case 'report': {
      const collected = pullRequests(ctx);
      const prs = collected.length;
      const matches = output(ctx, 'must-fix-match').matches as Match[];
      const mustFixOpen = matches.filter((item) => item.verdict === 'open' || item.verdict === 'unresolved').length;
      const mustFixUnknown = matches.filter((item) => item.verdict === 'unknown').length;
      const mustFixRereviewed = matches.filter((item) => item.verdict === 'rereviewed').length;
      const mustFixUnresolved = mustFixOpen + mustFixUnknown;
      const verifyNeeded = output(ctx, 'verify-needed').verifyNeeded as number[];
      const mergedPrs = new Set(collected.filter((pr) => pr.state === 'MERGED').map((pr) => pr.number));
      const landedOpen = matches.filter((item) => item.verdict === 'open' && mergedPrs.has(item.pr));
      const unresolved = matches.filter((item) => item.verdict === 'unresolved').length;
      const openPrs = [...new Set(landedOpen.map((item) => item.pr))].sort((a, b) => a - b);
      const open = landedOpen.length;
      debug.log('landing-heal', 'tick', { prs, mustFixUnresolved, mustFixOpen, mustFixUnknown, mustFixRereviewed, verifyNeeded });
      (ctx.decision ?? emitDecision)({
        kind: 'VERIFY',
        what: `착지·치유 관측: PR ${prs}건${open ? ` — 열린 must-fix ${open}건(PR ${openPrs.map((pr) => `#${pr}`).join(', ')})` : ''}`,
        reason: `열린 채 착지 ${open}건 · 미해결 ${unresolved}건 · 미상 ${mustFixUnknown}건 · 다시 봄 ${mustFixRereviewed}건 · 착지 뒤 검증 필요 ${verifyNeeded.length}건`,
        purpose: '착지 후속 작업 관측', target: 'landing-heal', ...(ctx.runId ? { runId: ctx.runId } : {}),
      });
      return { outcome: 'ok', prs, mustFixUnresolved, mustFixOpen, mustFixUnknown, mustFixRereviewed, verifyNeeded };
    }
    default: throw new Error(`unknown landing-heal mission: ${mission}`);
  }
}

if (import.meta.main) {
  try {
    resolvedEnv = await ghRepoEnv(ghEnv(), process.cwd());
    process.stdout.write(`${JSON.stringify(runMission(process.argv[2] ?? '', context()))}\n`);
  }
  catch (error) {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  }
}
