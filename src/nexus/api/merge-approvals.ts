import { debug } from '../../debug/log.js';
import { PR_LABELS } from '../../github/pr-labels.js';
import { runGhCliWithResultAsync } from '../../git-fs/gh-cli.js';
import { runGitCommand } from '../../git-fs/runner.js';
import { getUserConfig } from '../../user-config.js';
import { installMetadataSource } from '../../version/code-revision.js';
import { getApprovalGate, latestApprovalGate, startApprovalGate, type ApprovalGateInput, type ApprovalGateState } from './merge-approvals-gate.js';
import { jsonResponse } from './json-response.js';
import { APPROVALS_MERGES_PATH } from './rest-route-paths.js';

// 라벨 이름은 레지스트리(src/github/pr-labels.ts)가 SSOT 다.
export const IDEA_APPROVAL_LABEL = PR_LABELS.find((label) => label.axis === 'state' && label.name.endsWith(':idea-approval'))!.name;

type GhResult = { ok: boolean; stdout: string | Buffer; stderr: string | Buffer; code: number };
export interface MergeApprovalsDeps {
  gh?: (args: string[]) => GhResult | Promise<GhResult>;
  repo?: () => string | undefined;
  installSource?: () => string | undefined;
  gitRemote?: (source: string) => string | undefined;
  now?: () => Date;
  authorize?: (request: Request) => boolean;
  gate?: {
    start: (input: ApprovalGateInput) => ApprovalGateState;
    get: (prNumber: number, headSha: string, repo: string, baseSha?: string, repoRoot?: string) => ApprovalGateState;
    latest?: (prNumber: number, headSha: string, repo: string, repoRoot?: string) => ApprovalGateState;
  };
  /** base 가지의 지금 끝 SHA — 기본은 GitHub `git/ref/heads/<base>`. 못 읽으면 null. */
  baseTip?: (repo: string, baseRefName: string) => Promise<string | null>;
  /** base 가 움직였을 때 그사이 main 에서 바뀐 파일 — 기본은 GitHub compare API. 못 읽으면 null. */
  compareFiles?: (repo: string, fromSha: string, toSha: string) => Promise<string[] | null>;
  /** Read-only gh calls (list · view) are shared for this long — default 15s with the real gh, 0 with an injected one. */
  readCacheMs?: number;
}

type RawPr = {
  number: number; title: string; url: string; headRefOid: string; baseRefName: string; baseRefOid?: string;
  isDraft: boolean; mergeable: string; additions: number; deletions: number;
  changedFiles: number; files?: Array<{ path: string }>;
  body: string; createdAt: string; state: string; labels?: Array<{ name: string }>; mergedAt?: string | null;
  statusCheckRollup?: Array<{ conclusion?: string | null; status?: string | null; state?: string | null; __typename?: string }>;
};

const VIEW_FIELDS = 'number,title,url,headRefOid,baseRefName,baseRefOid,isDraft,mergeable,additions,deletions,changedFiles,files,body,createdAt,state,labels,statusCheckRollup,mergedAt';
// gh pr list does not support the `files` field; fetch each PR's full details with pr view.
const LIST_FIELDS = 'number,title,url,headRefOid,baseRefName,isDraft,mergeable,additions,deletions,changedFiles,body,createdAt,statusCheckRollup';
// 완료(머지된) 목록 — 파일 목록 없이 한 번에 읽는다(카드마다 pr view 를 부르지 않는다).
const MERGED_LIST_FIELDS = 'number,title,url,headRefOid,baseRefName,isDraft,mergeable,additions,deletions,changedFiles,body,createdAt,state,labels,mergedAt';
export const MERGED_LIST_LIMIT = 30;
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

function repoFromOrigin(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  const match = /^(?:git@github\.com:|(?:https|ssh):\/\/(?:git@)?github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match?.[1];
}

function originRemote(source: string): string | undefined {
  const result = runGitCommand(source, ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function extractApprovalBrief(body: string): string | null {
  const lines = body.split(/\r?\n/);
  // 닫는 `#`(`## 승인 요약 ##`)도 같은 제목이다(CommonMark ATX).
  const start = lines.findIndex((line) => /^ {0,3}##[ \t]+승인 요약(?:[ \t]+#+)?[ \t]*$/.test(line));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && (/^ {0,3}##(?:[ \t]|$)/.test(line) || /^---\s*$/.test(line.trim())));
  const brief = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
  return brief ? (brief.length > 8_000 ? `${brief.slice(0, 7_999)}…` : brief) : null;
}

export function extractLineage(body: string): string | null {
  return /^아이디어:\s*(.+)\s*$/.exec(body.split(/\r?\n/, 1)[0] ?? '')?.[1]?.trim() || null;
}

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
    summary: (oneLine || firstParagraph).slice(0, 600),
    brief: extractApprovalBrief(pr.body ?? ''), lineage: extractLineage(pr.body ?? ''), createdAt: pr.createdAt,
    state: pr.state, mergedAt: pr.mergedAt ?? null, approvalPath: `/approvals?pr=${pr.number}`,
  };
}

// A page load fires the list twice (the daemon client settles) and polls cards — identical reads share one gh call.
// Failures are shared too: during a GitHub rate-limit window a retry per request only deepens the limit (GIT-S83).
const readCache = new Map<string, { at: number; value: Promise<GhResult> }>();
export function clearApprovalsReadCache(): void { readCache.clear(); }
function cachedRead(args: string[], ttlMs: number, now: number, call: () => Promise<GhResult>): Promise<GhResult> {
  const key = args.join('\u0000');
  const hit = readCache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = call();
  readCache.set(key, { at: now, value });
  return value;
}

async function defaultBaseTip(repo: string, baseRefName: string): Promise<string | null> {
  const r = await runGhCliWithResultAsync(['api', `repos/${repo}/git/ref/heads/${baseRefName}`, '--jq', '.object.sha']);
  const sha = r.ok ? String(r.stdout).trim() : '';
  return /^[a-f\d]{40}$/i.test(sha) ? sha : null;
}

async function defaultCompareFiles(repo: string, fromSha: string, toSha: string): Promise<string[] | null> {
  const r = await runGhCliWithResultAsync(['api', `repos/${repo}/compare/${fromSha}...${toSha}`, '--jq', '[.files[].filename]']);
  if (!r.ok) return null;
  try {
    const files: unknown = JSON.parse(String(r.stdout));
    return Array.isArray(files) && files.every((f) => typeof f === 'string') ? files as string[] : null;
  } catch { return null; }
}

export async function handleMergeApprovals(req: Request, deps: MergeApprovalsDeps = {}): Promise<Response> {
  const path = new URL(req.url).pathname;
  const suffix = path.slice(APPROVALS_MERGES_PATH.length);
  const match = /^\/(\d+)(?:\/(merge|check))?$/.exec(suffix);
  if (!path.startsWith(APPROVALS_MERGES_PATH) || (suffix && !match)) return jsonResponse({ error: 'not-found' }, 404);
  const method = req.method.toUpperCase();
  if (method !== (match?.[2] ? 'POST' : 'GET')) return jsonResponse({ error: 'method-not-allowed' }, 405);
  const gate = deps.gate ?? { start: startApprovalGate, get: getApprovalGate, latest: latestApprovalGate };
  if (!deps.authorize?.(req)) {
    debug.log('approvals.merge', 'refused', { number: match ? Number(match[1]) : undefined, reason: 'unauthorized' });
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const rawGh = deps.gh ?? (async (args: string[]): Promise<GhResult> => {
    const r = await runGhCliWithResultAsync(args);
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, code: r.exitCode };
  });
  const readCacheMs = deps.readCacheMs ?? (deps.gh ? 0 : 15_000);
  const isRead = (args: string[]) => (args[0] === 'pr' && (args[1] === 'list' || args[1] === 'view')) || (args[0] === 'repo' && args[1] === 'view');
  // Anything that changes a PR (check · merge) drops the shared reads so the next card is fresh.
  if (match?.[2]) readCache.clear();
  const gh = (args: string[]): Promise<GhResult> => readCacheMs > 0 && isRead(args)
    ? cachedRead(args, readCacheMs, (deps.now?.() ?? new Date()).getTime(), async () => rawGh(args))
    : Promise.resolve(rawGh(args));
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
  const validRepo = (candidate: string | undefined): string | undefined => {
    const name = candidate?.trim();
    return name && REPO_NAME.test(name) ? name : undefined;
  };
  let repo = validRepo(deps.repo?.());
  if (!repo) repo = validRepo(getUserConfig().intake.approvals?.repo);
  if (!repo) {
    try {
      const found = await gh(['repo', 'view', '--json', 'nameWithOwner']);
      if (found.ok) {
        const parsed: unknown = JSON.parse(String(found.stdout));
        if (parsed && typeof parsed === 'object' && 'nameWithOwner' in parsed
          && typeof parsed.nameWithOwner === 'string') repo = validRepo(parsed.nameWithOwner);
      }
    } catch { /* Try the install source. */ }
  }
  if (!repo) {
    const source = (deps.installSource ?? installMetadataSource)();
    if (source) repo = validRepo(repoFromOrigin((deps.gitRemote ?? originRemote)(source)));
  }
  if (!repo) return jsonResponse({ error: 'approvals-repo-unknown' }, 503);
  const gateRepoRoot = (): string | undefined => {
    try { return (deps.installSource ?? installMetadataSource)(); }
    catch { return undefined; }
  };
  // PR 의 baseRefOid 는 «PR 에 기록된 base»라 main 의 지금 끝보다 늙는다 — 검사·판정은 base 가지의 지금 끝으로 한다.
  const tips = new Map<string, Promise<string | null>>();
  const tipOf = (baseRefName: string) => {
    if (!tips.has(baseRefName)) tips.set(baseRefName, (deps.baseTip ?? defaultBaseTip)(repo!, baseRefName).catch(() => null));
    return tips.get(baseRefName)!;
  };
  const asCard = async (pr: RawPr) => {
    const root = gateRepoRoot();
    const exact = gate.get(pr.number, pr.headRefOid, repo, (await tipOf(pr.baseRefName)) ?? pr.baseRefOid, root);
    // main 이 움직인 뒤에도 같은 머리의 통과는 보여 준다 — 머지 때 서버가 «겹침»을 다시 본다(아래 merge 분기).
    const prior = exact.status === 'none' ? gate.latest?.(pr.number, pr.headRefOid, repo, root) : undefined;
    return { ...asItem(pr), gate: prior && prior.status !== 'none' ? { ...prior, baseDrifted: true } : exact };
  };

  const view = async (number: number): Promise<{ pr?: RawPr; error?: Response }> => {
    const result = await run(['pr', 'view', String(number), '--repo', repo, '--json', VIEW_FIELDS]);
    if (result.error) return { error: result.error };
    try { return { pr: JSON.parse(result.value!) as RawPr }; }
    catch { return { error: jsonResponse({ error: 'gh-invalid-response' }, 502) }; }
  };
  if (!match && new URL(req.url).searchParams.get('state') === 'merged') {
    const result = await run(['pr', 'list', '--repo', repo, '--label', IDEA_APPROVAL_LABEL, '--state', 'merged', '--limit', String(MERGED_LIST_LIMIT), '--json', MERGED_LIST_FIELDS]);
    if (result.error) return result.error;
    let rows: RawPr[];
    try { rows = JSON.parse(result.value!) as RawPr[]; if (!Array.isArray(rows)) throw Error('not array'); }
    catch { return jsonResponse({ error: 'gh-invalid-response' }, 502); }
    const items = (await Promise.all(rows
      .filter((row) => row.state === 'MERGED' && row.labels?.some((label) => label.name === IDEA_APPROVAL_LABEL))
      .map((row) => asCard(row))))
      .sort((a, b) => String(b.mergedAt ?? '').localeCompare(String(a.mergedAt ?? '')));
    debug.log('approvals.merge', 'listed', { count: items.length, state: 'merged' });
    return jsonResponse({ items });
  }
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
    const details = await Promise.all(rows.map((row) => view(row.number)));
    const failed = details.find((detail) => detail.error);
    if (failed) return failed.error!;
    const items = await Promise.all(details
      .filter((detail) => detail.pr?.state === 'OPEN' && detail.pr.labels?.some((label) => label.name === IDEA_APPROVAL_LABEL))
      .map((detail) => asCard(detail.pr!)));
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
  if (!match[2]) return jsonResponse(await asCard(pr));
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
  // GitHub 검사가 0개인 PR 도 허용한다. 호스트 재게이트 통과는 아래에서 별도로 요구한다.
  if (checks.pending > 0) return refuse('checks-pending', '검사가 아직 끝나지 않았습니다.');
  if (pr.mergeable === 'CONFLICTING') return refuse('conflicting', '머지 충돌이 있습니다.');
  if (pr.mergeable !== 'MERGEABLE') return refuse('mergeability-pending', '머지 가능 여부가 아직 확인되지 않았습니다.');
  if (pr.isDraft) return refuse('draft', '초안 PR 은 머지할 수 없습니다. GitHub에서 초안을 해제한 뒤 다시 확인하세요.');
  if (match[2] === 'check') {
    const repoRoot = gateRepoRoot();
    const tip = await tipOf(pr.baseRefName);
    if (!repoRoot || !tip) return jsonResponse({ error: 'gate-repo-unknown' }, 503);
    // host-regate resolves the PR in repoRoot; never certify a different --repo PR.
    if (!deps.gate && repoFromOrigin((deps.gitRemote ?? originRemote)(repoRoot))?.toLowerCase() !== repo.toLowerCase()) {
      return jsonResponse({ error: 'gate-repo-unknown' }, 503);
    }
    return jsonResponse({ gate: gate.start({ prNumber: number, headSha, repoRoot, repo, baseSha: tip }) }, 202);
  }
  const repoRoot = gateRepoRoot();
  if (!deps.gate && (!repoRoot || repoFromOrigin((deps.gitRemote ?? originRemote)(repoRoot))?.toLowerCase() !== repo.toLowerCase())) {
    return refuse('gate-not-passed', 'repo-changed — 검사를 먼저 돌리세요');
  }
  // 머지 직전 PR 을 다시 읽는다 — 머리는 --match-head-commit 이 고정하고, base 는 아래 «겹침» 규칙으로 본다.
  const latest = await view(number);
  if (latest.error) return latest.error;
  if (latest.pr?.headRefOid !== headSha) return refuse('head-changed', '본 뒤에 PR 머리가 바뀌었습니다. 새로고침하세요.');
  tips.clear();
  const currentBase = (await tipOf(latest.pr?.baseRefName ?? pr.baseRefName)) ?? undefined;
  const exact = gate.get(number, headSha, repo, currentBase, repoRoot);
  if (exact.status !== 'passed') {
    // main 은 시간당 수십 번 움직이고 검사는 몇 분 걸린다 — base 가 움직였다고 매번 다시 재면 승인이 막힌다.
    //   ⇒ 검사한 base 이후 main 에서 바뀐 파일이 이 PR 의 파일과 «겹칠 때만» 다시 재게 한다. 못 재면 거절.
    const prior = gate.latest?.(number, headSha, repo, repoRoot);
    if (!prior || prior.status !== 'passed' || !prior.baseSha || !currentBase) return refuse('gate-not-passed', `${exact.status} — 검사를 먼저 돌리세요`);
    const changed = await (deps.compareFiles ?? defaultCompareFiles)(repo, prior.baseSha, currentBase);
    if (!changed) return refuse('gate-not-passed', 'unmeasured — 검사 뒤 main 변경분을 못 읽었습니다. 검사를 다시 돌리세요');
    const mine = new Set((latest.pr?.files ?? pr.files ?? []).map((file) => file.path));
    const overlap = changed.filter((file) => mine.has(file));
    debug.log('approvals.merge', 'gate-base-drift', { number, fromBase: prior.baseSha, toBase: currentBase, changed: changed.length, overlap: overlap.length });
    if (overlap.length) return refuse('gate-stale', `검사 뒤 main 에서 같은 파일이 바뀌었습니다(${overlap.slice(0, 5).join(', ')}) — 검사를 다시 돌리세요`);
  }
  const merged = await run(['pr', 'merge', String(number), '--repo', repo, '--squash', '--delete-branch', '--match-head-commit', headSha]);
  if (merged.error) return merged.error;
  debug.log('approvals.merge', 'merged', { number, at: (deps.now ?? (() => new Date()))().toISOString() });
  return jsonResponse({ merged: true, number });
}
