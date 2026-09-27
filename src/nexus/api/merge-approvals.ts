import { debug } from '../../debug/log.js';
import { runGhCliWithResult } from '../../git-fs/gh-cli.js';
import { getUserConfig } from '../../user-config.js';
import { jsonResponse } from './json-response.js';
import { APPROVALS_MERGES_PATH } from './rest-route-paths.js';

export const IDEA_APPROVAL_LABEL = 'elanous:idea-approval';

type GhResult = { ok: boolean; stdout: string | Buffer; stderr: string | Buffer; code: number };
export interface MergeApprovalsDeps {
  gh?: (args: string[]) => GhResult | Promise<GhResult>;
  repo?: () => string | undefined;
  now?: () => Date;
  authorize?: (request: Request) => boolean;
}

type RawPr = {
  number: number; title: string; url: string; headRefOid: string; baseRefName: string;
  isDraft: boolean; mergeable: string; additions: number; deletions: number;
  changedFiles: number; files?: Array<{ path: string }>;
  body: string; createdAt: string; state: string; labels?: Array<{ name: string }>;
  statusCheckRollup?: Array<{ conclusion?: string | null; status?: string | null; state?: string | null; __typename?: string }>;
};

const VIEW_FIELDS = 'number,title,url,headRefOid,baseRefName,isDraft,mergeable,additions,deletions,changedFiles,files,body,createdAt,state,labels,statusCheckRollup';
// gh pr list does not support the `files` field; fetch each PR's full details with pr view.
const LIST_FIELDS = 'number,title,url,headRefOid,baseRefName,isDraft,mergeable,additions,deletions,changedFiles,body,createdAt,statusCheckRollup';

function asItem(pr: RawPr) {
  const checks = { success: 0, failure: 0, pending: 0 };
  for (const check of pr.statusCheckRollup ?? []) {
    const value = (check.conclusion || check.state || check.status || '').toUpperCase();
    const status = (check.status || check.state || '').toUpperCase();
    if (['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'CANCELLED'].includes(value)) checks.failure++;
    else if (value === 'SUCCESS' && (
      check.__typename === 'CheckRun' ? status === 'COMPLETED' : !status || ['COMPLETED', 'SUCCESS'].includes(status)
    )) checks.success++;
    else checks.pending++;
  }
  const oneLine = pr.body?.match(/^\s*-\s*한 줄:\s*(.*)$/m)?.[1]?.trim();
  const firstParagraph = pr.body?.trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ').trim() ?? '';
  return {
    number: pr.number, title: pr.title, url: pr.url, headSha: pr.headRefOid,
    base: pr.baseRefName, draft: pr.isDraft, mergeable: pr.mergeable,
    additions: pr.additions, deletions: pr.deletions, changedFiles: pr.changedFiles,
    files: (pr.files ?? []).slice(0, 20).map((file) => file.path), checks,
    summary: (oneLine || firstParagraph).slice(0, 600), createdAt: pr.createdAt,
    state: pr.state, approvalPath: `/approvals?pr=${pr.number}`,
  };
}

export async function handleMergeApprovals(req: Request, deps: MergeApprovalsDeps = {}): Promise<Response> {
  const path = new URL(req.url).pathname;
  const suffix = path.slice(APPROVALS_MERGES_PATH.length);
  const match = /^\/(\d+)(?:\/(merge))?$/.exec(suffix);
  if (!path.startsWith(APPROVALS_MERGES_PATH) || (suffix && !match)) return jsonResponse({ error: 'not-found' }, 404);
  const method = req.method.toUpperCase();
  if (method !== (match?.[2] ? 'POST' : 'GET')) return jsonResponse({ error: 'method-not-allowed' }, 405);
  if (!deps.authorize?.(req)) {
    debug.log('approvals.merge', 'refused', { number: match ? Number(match[1]) : undefined, reason: 'unauthorized' });
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const gh = deps.gh ?? ((args: string[]): GhResult => {
    const r = runGhCliWithResult(args);
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, code: r.exitCode };
  });
  const run = async (args: string[]): Promise<{ value?: string; error?: Response }> => {
    try {
      const result = await gh(args);
      if (result.ok) return { value: String(result.stdout) };
      debug.log('approvals.merge', 'failed', { number: match ? Number(match[1]) : undefined, reason: 'gh-failed' });
      return { error: jsonResponse({ error: 'gh-failed', reason: String(result.stderr).slice(0, 300) }, 502) };
    } catch (err) {
      debug.log('approvals.merge', 'failed', { number: match ? Number(match[1]) : undefined, reason: 'gh-failed' });
      return { error: jsonResponse({ error: 'gh-failed', reason: String(err).slice(0, 300) }, 502) };
    }
  };
  const configured = deps.repo ? deps.repo() : getUserConfig().intake.approvals?.repo;
  let repo = configured?.trim();
  if (!repo) {
    const found = await run(['repo', 'view', '--json', 'nameWithOwner']);
    if (found.error) return jsonResponse({ error: 'approvals-repo-unknown' }, 503);
    try { repo = (JSON.parse(found.value!) as { nameWithOwner?: string }).nameWithOwner; } catch { /* unknown repository */ }
  }
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return jsonResponse({ error: 'approvals-repo-unknown' }, 503);

  const view = async (number: number): Promise<{ pr?: RawPr; error?: Response }> => {
    const result = await run(['pr', 'view', String(number), '--repo', repo, '--json', VIEW_FIELDS]);
    if (result.error) return { error: result.error };
    try { return { pr: JSON.parse(result.value!) as RawPr }; }
    catch { return { error: jsonResponse({ error: 'gh-invalid-response' }, 502) }; }
  };
  if (!match) {
    let rows: RawPr[];
    let limit = 100;
    while (true) {
      const result = await run(['pr', 'list', '--repo', repo, '--label', IDEA_APPROVAL_LABEL, '--state', 'open', '--limit', String(limit), '--json', LIST_FIELDS]);
      if (result.error) return result.error;
      try { rows = JSON.parse(result.value!) as RawPr[]; if (!Array.isArray(rows)) throw Error('not array'); }
      catch { return jsonResponse({ error: 'gh-invalid-response' }, 502); }
      if (rows.length < limit) break;
      limit *= 2;
    }
    const items = [];
    for (const row of rows) {
      const detail = await view(row.number);
      if (detail.error) return detail.error;
      if (detail.pr?.state === 'OPEN' && detail.pr.labels?.some((label) => label.name === IDEA_APPROVAL_LABEL)) items.push(asItem(detail.pr));
    }
    debug.log('approvals.merge', 'listed', { count: items.length });
    return jsonResponse({ items });
  }

  const number = Number(match[1]);
  if (!Number.isSafeInteger(number) || number < 1) return jsonResponse({ error: 'not-found' }, 404);
  const detail = await view(number);
  if (detail.error) return detail.error;
  const pr = detail.pr!;
  if (!pr.labels?.some((label) => label.name === IDEA_APPROVAL_LABEL)) {
    debug.log('approvals.merge', 'refused', { number, reason: 'label-missing' });
    return jsonResponse({ error: 'label-missing', reason: '아이디어 승인 라벨이 없습니다.' }, match[2] ? 403 : 404);
  }
  if (!match[2]) return jsonResponse(asItem(pr));
  const refuse = (error: string, reason: string) => {
    debug.log('approvals.merge', 'refused', { number, reason: error });
    return jsonResponse({ error, reason }, 409);
  };
  let body: unknown;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'head-sha-required' }, 400); }
  const headSha = body && typeof body === 'object' && 'headSha' in body ? body.headSha : undefined;
  if (typeof headSha !== 'string' || !/^[a-f\d]{3,40}$/i.test(headSha)) return jsonResponse({ error: 'head-sha-required' }, 400);
  if (pr.state !== 'OPEN') return refuse('not-open', '열린 PR 이 아닙니다.');
  if (pr.baseRefName !== 'main') return refuse('base-not-main', '대상 브랜치가 main 이 아닙니다.');
  if (headSha !== pr.headRefOid) return refuse('head-changed', '본 뒤에 PR 머리가 바뀌었습니다. 새로고침하세요.');
  const checks = asItem(pr).checks;
  if (checks.failure > 0) return refuse('checks-failed', '실패한 검사가 있습니다.');
  // 검사가 «하나도 없는» PR 은 막지 않는다 — 이 저장소의 게이트는 하니스가 로컬에서 돌리고(PR 본문 Gate 절) GitHub 검사를 달지 않는다.
  //   막으면 승인 버튼이 영영 눌리지 않는다(2026-09-27 실측: 열린 PR 의 statusCheckRollup 이 전부 0개). 있는데 끝나지 않은 것만 막는다.
  if (checks.pending > 0) return refuse('checks-pending', '검사가 아직 끝나지 않았습니다.');
  if (pr.mergeable === 'CONFLICTING') return refuse('conflicting', '머지 충돌이 있습니다.');
  if (pr.mergeable !== 'MERGEABLE') return refuse('mergeability-pending', '머지 가능 여부가 아직 확인되지 않았습니다.');
  if (pr.isDraft) return refuse('draft', '초안 PR 은 머지할 수 없습니다. GitHub에서 초안을 해제한 뒤 다시 확인하세요.');
  const merged = await run(['pr', 'merge', String(number), '--repo', repo, '--squash', '--delete-branch', '--match-head-commit', headSha]);
  if (merged.error) return merged.error;
  debug.log('approvals.merge', 'merged', { number, at: (deps.now ?? (() => new Date()))().toISOString() });
  return jsonResponse({ merged: true, number });
}
