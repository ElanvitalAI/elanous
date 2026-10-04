import { debug } from '../../debug/log.js';
import { runGhCliWithResult } from '../../git-fs/gh-cli.js';
import { runHostRegate, type HostRegateInput, type HostRegateResult } from '../../self-implement/host-regate.js';

export type ApprovalGateStatus = 'none' | 'running' | 'passed' | 'failed' | 'unmeasured';
export interface ApprovalGateState {
  status: ApprovalGateStatus;
  failures: string[];
  startedAt?: string;
  finishedAt?: string;
  os?: string;
  baseSha?: string;
}
export type ApprovalGateInput = { prNumber: number; headSha: string; repoRoot: string; repo: string; baseSha: string };
export type ApprovalGateDeps = {
  runHostRegate?: (input: HostRegateInput) => Promise<HostRegateResult>;
  readPr?: (input: ApprovalGateInput) => Promise<{ headSha: string; baseSha: string }>;
  now?: () => Date;
};

const states = new Map<string, ApprovalGateState>();
const key = (prNumber: number, headSha: string, repo: string, repoRoot: string) => JSON.stringify([repo.toLowerCase(), repoRoot, prNumber, headSha]);
const none = (): ApprovalGateState => ({ status: 'none', failures: [] });

/** 같은 PR·머리의 최근 판정(base 무관) — base 가 움직인 뒤 «겹침만 다시 본다»에 쓴다. */
export function latestApprovalGate(prNumber: number, headSha: string, repo: string, repoRoot?: string): ApprovalGateState {
  if (!repoRoot) return none();
  return states.get(key(prNumber, headSha, repo, repoRoot)) ?? none();
}

export function getApprovalGate(prNumber: number, headSha: string, repo: string, baseSha?: string, repoRoot?: string): ApprovalGateState {
  if (!repoRoot) return none();
  const state = states.get(key(prNumber, headSha, repo, repoRoot));
  return state && state.baseSha === baseSha ? state : none();
}

async function readPr(input: ApprovalGateInput): Promise<{ headSha: string; baseSha: string }> {
  const result = runGhCliWithResult(['pr', 'view', String(input.prNumber), '--repo', input.repo, '--json', 'headRefOid,baseRefOid']);
  if (!result.ok) throw new Error(`PR view unavailable: ${String(result.stderr).slice(0, 200)}`);
  const pr = JSON.parse(String(result.stdout)) as { headRefOid?: string; baseRefOid?: string };
  return { headSha: pr.headRefOid ?? '', baseSha: pr.baseRefOid ?? '' };
}

export function startApprovalGate(input: ApprovalGateInput, deps: ApprovalGateDeps = {}): ApprovalGateState {
  const id = key(input.prNumber, input.headSha, input.repo, input.repoRoot);
  const existing = states.get(id);
  if (existing?.baseSha === input.baseSha && (existing.status === 'running' || existing.status === 'passed')) return existing;
  const now = deps.now ?? (() => new Date());
  const state: ApprovalGateState = { status: 'running', failures: [], baseSha: input.baseSha, startedAt: now().toISOString() };
  states.set(id, state);
  debug.log('approvals.merge', 'gate-started', { number: input.prNumber, headSha: input.headSha, status: state.status });
  setTimeout(() => {
    void Promise.resolve().then(() => (deps.runHostRegate ?? runHostRegate)({
      prNumber: input.prNumber, headCommit: input.headSha, repoRoot: input.repoRoot, verifyOnly: true,
    })).then(async (result) => {
      let status: ApprovalGateStatus = result.status === 'frozen' ? 'unmeasured' : result.status ?? (result.passed ? 'passed' : 'failed');
      let failures = result.failures.map(({ step, detail }) => `${step} — ${detail.replace(/\s+/g, ' ')}`.slice(0, 800));
      if (status === 'passed') {
        const current = await (deps.readPr ?? readPr)(input);
        // base 는 비교하지 않는다 — 검사는 main 의 지금 끝에 얹어 쟀고(result.baseCommit), main 이 움직인 것은 머지 때 «겹침»으로 본다.
        if (current.headSha !== input.headSha) {
          status = 'unmeasured';
          failures = ['pr-base-changed — PR head or base changed during host regate; rerun against the new base'];
        }
      }
      if (result.baseCommit) state.baseSha = result.baseCommit;
      state.failures = failures;
      state.os = result.os;
      state.status = status;
    }).catch((error: unknown) => {
      state.failures = [`host-regate — ${String(error).replace(/\s+/g, ' ')}`.slice(0, 800)];
      state.status = 'unmeasured';
    }).finally(() => {
      state.finishedAt = now().toISOString();
      debug.log('approvals.merge', 'gate-finished', { number: input.prNumber, headSha: input.headSha, status: state.status });
    });
  }, 0);
  return state;
}
