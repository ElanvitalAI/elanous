import { spawnSync } from 'node:child_process';
import { ownerSeatFromPullRequest } from '../../scripts/release-loop/gate-bisect-owner-mail.js';

export interface CellOpenPullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly headRefName: string;
  readonly assignees: readonly string[];
}

export interface ManualSeatClaimDeps {
  readonly listOpenPullRequests?: (cellId: string) => readonly CellOpenPullRequest[];
}

export type OpenPullRequestRunner = (command: string, args: readonly string[], cwd: string) => {
  readonly status: number | null;
  readonly stdout: string;
  readonly error?: Error;
};

const OPEN_PR_ENUMERATION_LIMIT = 1000;

function ownsCell(pr: Pick<CellOpenPullRequest, 'title' | 'body'>, cellId: string): boolean {
  const escaped = cellId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const scopedTitle = new RegExp(`^[a-z][a-z0-9-]*\\(${escaped}\\):`, 'i');
  const bracketTitle = new RegExp(`^\\[${escaped}\\](?:\\s|$)`, 'i');
  const firstBodyLine = pr.body.split(/\r?\n/, 1)[0] ?? '';
  const explicitBodyField = new RegExp(`^Cell ID:[ \\t]*${escaped}[ \\t]*$`, 'i');
  return scopedTitle.test(pr.title) || bracketTitle.test(pr.title) || explicitBodyField.test(firstBodyLine);
}

function parseOpenPullRequests(stdout: string): CellOpenPullRequest[] {
  let rows: unknown;
  try { rows = JSON.parse(stdout); }
  catch { throw new Error('open PR ownership check refused: gh returned invalid JSON'); }
  if (!Array.isArray(rows)) throw new Error('open PR ownership check refused: gh response must be an array');
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object') throw new Error(`open PR ownership check refused: row ${index + 1} is malformed`);
    const value = row as Record<string, unknown>;
    if (!Number.isSafeInteger(value.number) || Number(value.number) < 1
      || typeof value.title !== 'string' || typeof value.body !== 'string' || typeof value.headRefName !== 'string'
      || !Array.isArray(value.assignees) || value.assignees.some((assignee) => typeof assignee !== 'string')) {
      throw new Error(`open PR ownership check refused: row ${index + 1} has invalid fields`);
    }
    return { number: Number(value.number), title: value.title, body: value.body, headRefName: value.headRefName,
      assignees: value.assignees as string[] };
  });
}

export function listOpenCellPullRequests(
  cellId: string,
  cwd = process.cwd(),
  run: OpenPullRequestRunner = (command, args, workdir) => {
    const result = spawnSync(command, [...args], { cwd: workdir, encoding: 'utf8', timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024 });
    return { status: result.status, stdout: result.stdout ?? '', ...(result.error ? { error: result.error } : {}) };
  },
): CellOpenPullRequest[] {
  const origin = run('git', ['remote', 'get-url', 'origin'], cwd);
  if (origin.error || origin.status !== 0) {
    throw new Error(`open PR ownership check refused: could not resolve target repository origin${origin.error ? `: ${origin.error.message}` : ''}`);
  }
  const repo = githubRepositoryFromOrigin(origin.stdout);
  const result = run('gh', ['pr', 'list', '--repo', repo, '--state', 'open',
    '--limit', String(OPEN_PR_ENUMERATION_LIMIT), '--json', 'number,title,body,headRefName,assignees',
    '--jq', '[.[] | {number,title,body,headRefName,assignees:[.assignees[].login]}]'],
  cwd);
  if (result.error || result.status !== 0) {
    throw new Error(`open PR ownership check refused: gh pr list failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}`);
  }
  const rows = parseOpenPullRequests(result.stdout ?? '');
  if (rows.length >= OPEN_PR_ENUMERATION_LIMIT) {
    throw new Error(`open PR ownership check refused: open PR enumeration reached ${OPEN_PR_ENUMERATION_LIMIT} rows and may be truncated`);
  }
  return rows.filter((pr) => ownsCell(pr, cellId));
}

function githubRepositoryFromOrigin(origin: string): string {
  const normalized = origin.trim().replace(/\.git$/i, '');
  const match = /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+)$/i.exec(normalized);
  if (!match?.[1]) throw new Error('open PR ownership check refused: origin is not a supported GitHub repository URL');
  return match[1];
}

/** Returns a refusal reason when another or unverified seat owns a matching open PR. */
export function manualSeatClaimOpenPrRefusal(
  cellId: string,
  claimant: string,
  pullRequests: readonly CellOpenPullRequest[],
): string | null {
  const conflicts = pullRequests.filter((pr) => ownsCell(pr, cellId))
    .map((pr) => ({ pr, owner: ownerSeatFromPullRequest({ headRefName: pr.headRefName, assignees: pr.assignees }) }))
    .filter(({ owner }) => owner !== claimant.toUpperCase());
  if (conflicts.length === 0) return null;
  const detail = conflicts.map(({ pr, owner }) => `#${pr.number} owner=${owner ?? `unresolved (${pr.assignees.join(', ') || 'unassigned'})`}`).join('; ');
  return `claim refused for ${cellId}: open PR ownership must match ${claimant}; ${detail}`;
}

export function assertManualSeatClaimOpenPrOwner(
  cellId: string,
  claimant: string,
  deps: ManualSeatClaimDeps = {},
): void {
  const pullRequests = deps.listOpenPullRequests?.(cellId) ?? listOpenCellPullRequests(cellId);
  const refusal = manualSeatClaimOpenPrRefusal(cellId, claimant, pullRequests);
  if (refusal) throw new Error(refusal);
}
