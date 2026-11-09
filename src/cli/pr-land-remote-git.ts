/** Run pinned PR Git phases on a worker. HQ validates each phase before dispatching the next. */
import { randomBytes } from 'node:crypto';
import { realGateRemoteRunner, type GateRemoteRunner } from '../self-implement/gate-remote.js';
import { sanitizeCredentialText, type CmdRunner } from '../autopilot/pr-manager.js';
import { PR_LAND_GIT_REMOTE_HOSTS, validatePrLandRemoteGitReceipt,
  type PrLandRemoteGitRequest, type PrLandRemoteGitReceipt, type PrLandGitPhase } from './pr-land-heavy-remote.js';

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const phases: readonly PrLandGitPhase[] = ['fetch', 'worktree', 'rebase', 'push'];
export interface PrLandRemoteGitInput {
  pr: number; repository: string; baseRepository: string; headRef: string; head: string; main: string; host: string; cwd: string;
}
export interface PrLandRemoteGitDeps {
  ssh?: GateRemoteRunner['ssh']; run?: CmdRunner;
  observe?: (event: string, data: Record<string, unknown>) => void;
}
export type PrLandRemoteGitResult = { ok: true; resultHead: string; host: string }
  | { ok: false; reason: string; host?: string };

function phaseScript(input: PrLandRemoteGitInput, phase: PrLandGitPhase, root: string): string {
  const identity = { schema: 2, pr: input.pr, repository: input.repository,
    baseRepository: input.baseRepository, headRef: input.headRef, head: input.head, main: input.main, host: input.host, phase, ok: true };
  const prefix = JSON.stringify(identity).slice(0, -1);
  const common = `set -eu
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=10'
R=${quote(root)}
url=${quote(`git@github.com:${input.repository}.git`)}
base_url=${quote(`https://github.com/${input.baseRepository}.git`)}
ref=${quote(input.headRef)}
head=${quote(input.head)}
main=${quote(input.main)}
emit() { printf '%s,"resultHead":"%s","mergeSha":"%s"}\\n' ${quote(prefix)} "$1" "$main"; }
`;
  if (phase === 'fetch') return `${common}
mkdir -m 700 "$R"
git init --bare "$R/repo" >/dev/null 2>&1
git -C "$R/repo" remote add origin "$url"
git -C "$R/repo" fetch --quiet --no-tags "$url" "$ref:refs/elanous/pr-head"
git -C "$R/repo" -c 'credential.helper=!gh auth git-credential' fetch --quiet --no-tags "$base_url" refs/heads/main:refs/elanous/main
test "$(git -C "$R/repo" rev-parse refs/elanous/pr-head)" = "$head"
test "$(git -C "$R/repo" rev-parse refs/elanous/main)" = "$main"
emit "$head"
`;
  if (phase === 'worktree') return `${common}
git -C "$R/repo" worktree add --detach "$R/worktree" "$head" >/dev/null 2>&1
test "$(git -C "$R/worktree" rev-parse HEAD)" = "$head"
emit "$head"
`;
  if (phase === 'rebase') return `${common}
git -C "$R/worktree" -c user.name=elanous-land -c user.email=land@localhost -c commit.gpgsign=false rebase "$main" >/dev/null 2>&1
result=$(git -C "$R/worktree" rev-parse HEAD)
emit "$result"
`;
  return `${common}
test "$(git -C "$R/worktree" rev-parse HEAD)" = "$head"
actual=$(git -C "$R/repo" ls-remote --heads origin "$ref")
test "$actual" = "$(printf '%s\\t%s' "$head" "$ref")"
git -C "$R/worktree" push --quiet --force-with-lease="$ref:$head" origin "$head:$ref"
emit "$head"
`;
}

/** Missing or mismatched receipts and transport failures stop before any later phase. */
export function runPrLandRemoteGit(input: PrLandRemoteGitInput, deps: PrLandRemoteGitDeps = {}): PrLandRemoteGitResult {
  const request = (phase: PrLandGitPhase): PrLandRemoteGitRequest => ({ schema: 2, pr: input.pr,
    repository: input.repository, baseRepository: input.baseRepository,
    headRef: input.headRef, head: input.head, main: input.main,
    phase, host: input.host as PrLandRemoteGitRequest['host'] });
  const identity = validatePrLandRemoteGitReceipt(request('fetch'), null);
  if (identity.ok || identity.reason !== 'receipt-unmeasured' || !PR_LAND_GIT_REMOTE_HOSTS.some((host) => host === input.host)) {
    return { ok: false, reason: 'invalid-request-identity' };
  }
  const ssh = deps.ssh ?? realGateRemoteRunner.ssh;
  const observe = deps.observe ?? (() => {});
  const root = `/tmp/elanous-pr-land-git-${randomBytes(16).toString('hex')}`;
  let result: PrLandRemoteGitResult = { ok: false, reason: 'remote-git-unmeasured', host: input.host };
  try {
    for (const phase of phases) {
      const execution = ssh(input.host, phaseScript(input, phase, root), 180_000);
      if (execution.rc !== 0 || execution.error) {
        const detail = sanitizeCredentialText(Buffer.from(execution.stderr).toString('utf8')).trim().slice(-180);
        const cause = sanitizeCredentialText(execution.error ?? `ssh-rc-${execution.rc}`).slice(0, 180);
        result = { ok: false, reason: `remote-git-${phase}-failed:${detail || cause}`, host: input.host };
        break;
      }
      let receipt: PrLandRemoteGitReceipt;
      try { receipt = JSON.parse(Buffer.from(execution.stdout).toString('utf8').trim()) as PrLandRemoteGitReceipt; }
      catch { result = { ok: false, reason: `remote-git-${phase}-receipt-unreadable`, host: input.host }; break; }
      let observedHead: string | undefined;
      if (phase === 'push') {
        const ref = input.headRef.replace(/^refs\//u, '').split('/').map(encodeURIComponent).join('/');
        const observed = deps.run?.('gh', ['api', 'repos/' + input.repository + '/git/ref/' + ref, '--jq', '.object.sha'], { cwd: input.cwd });
        const sha = observed?.ok ? observed.out.trim() : '';
        observedHead = /^[a-f0-9]{40}$/iu.test(sha) ? sha : undefined;
      }
      const verdict = validatePrLandRemoteGitReceipt(request(phase), receipt, observedHead);
      if (!verdict.ok) { result = { ok: false, reason: verdict.reason, host: input.host }; break; }
      if (verdict.resultHead.toLowerCase() !== input.head.toLowerCase()) {
        result = { ok: false, reason: phase === 'rebase' ? 'remote-git-rebase-changed-reviewed-head' : `remote-git-${phase}-head-mismatch`, host: input.host };
        break;
      }
      observe('remote-git-phase', { pr: input.pr, phase, host: input.host, head: verdict.resultHead });
      if (phase === 'push') result = { ok: true, resultHead: verdict.resultHead, host: input.host };
    }
  } catch (error) {
    result = { ok: false, reason: `remote-git-exception:${sanitizeCredentialText(String(error)).slice(0, 180)}`, host: input.host };
  } finally {
    if (!result.ok) {
      try { observe('remote-git-failed', { pr: input.pr, host: input.host, reason: result.reason }); }
      catch { /* Observation cannot replace a refusal. */ }
    }
    let cleanupOk = false;
    try {
      const cleaned = ssh(input.host, `set -eu\nR=${quote(root)}\nif test -d "$R/repo"; then git -C "$R/repo" worktree remove --force "$R/worktree" >/dev/null 2>&1 || :; fi\nrm -rf -- "$R"\ntest ! -e "$R"\n`, 30_000);
      cleanupOk = cleaned.rc === 0 && !cleaned.error;
    } catch { /* A failed cleanup is observable and never promotes a phase to success. */ }
    if (!cleanupOk) {
      try { observe('remote-git-cleanup-failed', { pr: input.pr, host: input.host }); }
      catch { /* Cleanup failure remains a refusal. */ }
      result = { ok: false, reason: 'remote-git-cleanup-unmeasured', host: input.host };
    }
  }
  return result;
}
