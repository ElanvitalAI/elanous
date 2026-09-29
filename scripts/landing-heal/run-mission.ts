#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { debug } from '../../src/debug/log.js';
import { emitDecision } from '../../src/live/detail-switch.js';
import { matchMustFix, type MustFixVerdict } from './must-fix-match.js';

interface PullRequest {
  number: number;
  title: string;
  state: string;
  mergedAt: string | null;
  headRefName: string;
  files: Array<{ path: string }>;
}
interface Match { pr: number; text: string; verdict: MustFixVerdict }
interface GraphContext { runId?: string; input?: { windowMinutes?: number; mustFixByPr?: Record<string, string[]> }; outputs?: Record<string, unknown> }
export type RunCommand = (args: string[]) => string;
const gh: RunCommand = (args) => {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
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
        const mustFixes = [...(ctx.input?.mustFixByPr?.[String(pr.number)] ?? []),
          ...[...(details.reviews ?? []), ...(details.comments ?? []), ...inline]
            .flatMap((review) => review.body && /must[-\s]?fix/i.test(review.body) ? [review.body] : [])];
        if (!mustFixes.length) continue;
        const diff = run(['pr', 'diff', String(pr.number), '--patch']);
        for (const text of mustFixes) matches.push({ pr: pr.number, text, verdict: matchMustFix(text, diff) });
      }
      return { outcome: 'ok', matches };
    }
    case 'verify-needed':
      return { outcome: 'ok', verifyNeeded: pullRequests(ctx)
        .filter((pr) => pr.state === 'MERGED' && pr.files.some((file) => file.path.startsWith('apps/pwa/') || file.path.startsWith('src/')))
        .map((pr) => pr.number) };
    case 'report': {
      const prs = pullRequests(ctx).length;
      const matches = output(ctx, 'must-fix-match').matches as Match[];
      const mustFixUnresolved = matches.filter((item) => item.verdict === 'unresolved' || item.verdict === 'unknown').length;
      const verifyNeeded = output(ctx, 'verify-needed').verifyNeeded as number[];
      debug.log('landing-heal', 'tick', { prs, mustFixUnresolved, verifyNeeded });
      emitDecision({ kind: 'VERIFY', what: `착지·치유 관측: PR ${prs}건`, reason: `must-fix 미해결/미상 ${mustFixUnresolved}건 · 착지 뒤 검증 필요 ${verifyNeeded.length}건`, purpose: '착지 후속 작업 관측', target: 'landing-heal', ...(ctx.runId ? { runId: ctx.runId } : {}) });
      return { outcome: 'ok', prs, mustFixUnresolved, verifyNeeded };
    }
    default: throw new Error(`unknown landing-heal mission: ${mission}`);
  }
}

if (import.meta.main) {
  try { process.stdout.write(`${JSON.stringify(runMission(process.argv[2] ?? '', context()))}\n`); }
  catch (error) {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  }
}
