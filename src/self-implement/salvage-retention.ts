/**
 * SALVAGE-RETENTION (RFC-draft-pr-accumulation-root-fix R1 다음 조각) — 원격 `salvage/*` 가지의 보존 규칙.
 *
 * S: DRAFT-NOT-ARCHIVE 로 멈춘 런은 PR 대신 수확 가지를 남긴다. 가지는 이미 1,000개를 넘었다.
 * C: 가지가 지워지지 않고 쌓이면 draft 재고가 «수확 가지 재고»로 옮겨 갈 뿐이다.
 * Q: 어느 가지를 지워도 되나?
 * A: 14일보다 오래됐고, 열린 PR 도(head·본문) 카드도(런 키·본문) 가리키지 않는 가지. 지금은 «그림자»로 수만 낸다.
 *    `tools.selfImplement.salvageRetention.mode` = 'shadow'(기본) | 'live'. ⛔ 이 조각은 live 여도 지우지 않는다(다음 조각).
 *
 * 순수 판정 + 주입된 조회. ⛔ 나이를 못 읽은 가지는 «오래됨»으로 세지 않는다(`unknownAge`).
 */
import { execFileSync } from 'node:child_process';
import { branchMatchesRun, runSuffixKey } from './salvage-branches.js';

export type SalvageRetentionMode = 'shadow' | 'live';
export const SALVAGE_RETENTION_MAX_AGE_DAYS = 14;

export interface DatedSalvageRef {
  readonly branch: string;
  readonly committedAt: string | null;
}

export interface SalvageReferenceSources {
  /** 열린 PR — head 가지 ⊕ 본문(본문에 가지 이름이 적혀 있으면 참조로 센다). */
  readonly openPrs: ReadonlyArray<{ number: number; headRefName: string; body?: string | null }>;
  /** 과제 카드 — 런 id(가지의 `-r<6hex>` 와 맞추기) ⊕ 카드 직렬화 본문. */
  readonly cards: ReadonlyArray<{ id: string; runId?: string; text: string }>;
}

export interface SalvageRetentionReport {
  readonly mode: SalvageRetentionMode;
  readonly maxAgeDays: number;
  readonly total: number;
  readonly older: number;
  readonly unknownAge: number;
  readonly referenced: number;
  /** 지울 후보 — 오래됐고 참조 0. 그림자에서는 수만 보고한다. */
  readonly candidates: number;
  readonly sample: readonly string[];
  readonly deleted: 0;
}

/** 가지를 가리키는 것이 있나 — 열린 PR head/본문 · 카드 런 키/본문. */
export function salvageBranchReferenced(branch: string, sources: SalvageReferenceSources): boolean {
  if (sources.openPrs.some((pr) => pr.headRefName === branch || (pr.body ?? '').includes(branch))) return true;
  return sources.cards.some((card) => {
    if (card.text.includes(branch)) return true;
    const key = card.runId ? runSuffixKey(card.runId) : null;
    return key !== null && branchMatchesRun(branch, key);
  });
}

export function classifySalvageRetention(input: {
  refs: readonly DatedSalvageRef[];
  sources: SalvageReferenceSources;
  now: Date;
  mode: SalvageRetentionMode;
  maxAgeDays?: number;
}): SalvageRetentionReport {
  const maxAgeDays = input.maxAgeDays ?? SALVAGE_RETENTION_MAX_AGE_DAYS;
  const cutoff = input.now.getTime() - maxAgeDays * 86_400_000;
  let older = 0;
  let unknownAge = 0;
  let referenced = 0;
  const candidates: string[] = [];
  for (const ref of input.refs) {
    const at = ref.committedAt ? Date.parse(ref.committedAt) : NaN;
    if (!Number.isFinite(at)) { unknownAge += 1; continue; }
    if (at >= cutoff) continue;
    older += 1;
    if (salvageBranchReferenced(ref.branch, input.sources)) { referenced += 1; continue; }
    candidates.push(ref.branch);
  }
  return { mode: input.mode, maxAgeDays, total: input.refs.length, older, unknownAge, referenced, candidates: candidates.length, sample: candidates.slice(0, 5), deleted: 0 };
}

export function formatSalvageRetention(report: SalvageRetentionReport): string {
  return `수확 가지 보존(${report.mode}): 전체 ${report.total} · ${report.maxAgeDays}일 초과 ${report.older} · 그중 참조 있음 ${report.referenced} · 지울 후보(참조 0) ${report.candidates}`
    + `${report.unknownAge ? ` · 나이 모름 ${report.unknownAge}` : ''} · 지운 것 0${report.mode === 'live' ? '(live 삭제는 다음 조각)' : ''}`;
}

type GhExecute = (args: string[]) => string;
const executeGh: GhExecute = (args) => execFileSync('gh', args, {
  encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
});

const REFS_QUERY = `query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){refs(refPrefix:"refs/heads/salvage/",first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{name target{... on Commit{committedDate}}}}}}`;

/** GitHub GraphQL 로 `salvage/*` 가지 ⊕ 마지막 커밋 시각(100개씩). ⛔ 페이지가 깨지면 던진다(부분 목록을 «전체»로 읽지 않는다). */
export function listDatedSalvageRefs(repository: string, execute: GhExecute = executeGh): DatedSalvageRef[] {
  const [owner, name] = repository.split('/');
  if (!owner || !name) throw new Error(`repository must be owner/name: ${repository}`);
  const refs: DatedSalvageRef[] = [];
  let after: string | null = null;
  for (let page = 0; page < 200; page++) {
    const args = ['api', 'graphql', '-f', `query=${REFS_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, ...(after ? ['-F', `after=${after}`] : [])];
    const parsed = JSON.parse(execute(args)) as { data?: { repository?: { refs?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: Array<{ name?: unknown; target?: { committedDate?: unknown } | null }> } } } };
    const block = parsed.data?.repository?.refs;
    if (!block || !Array.isArray(block.nodes) || !block.pageInfo) throw new Error('incomplete salvage ref listing');
    for (const node of block.nodes) {
      if (typeof node.name !== 'string') throw new Error('incomplete salvage ref listing');
      refs.push({ branch: `salvage/${node.name}`, committedAt: typeof node.target?.committedDate === 'string' ? node.target.committedDate : null });
    }
    if (!block.pageInfo.hasNextPage) return refs;
    after = block.pageInfo.endCursor ?? null;
    if (!after) throw new Error('incomplete salvage ref listing');
  }
  throw new Error('salvage ref listing exceeded pagination limit');
}

const OPEN_PR_LIMIT = 5000;

/** 열린 PR(head ⊕ 본문). ⛔ 상한에 닿으면 «전부 읽었다»를 증명 못 하므로 던진다(참조 있는 가지를 후보로 세지 않는다). */
export function listOpenPrRefs(repository: string, execute: GhExecute = executeGh): SalvageReferenceSources['openPrs'] {
  const rows = JSON.parse(execute(['pr', 'list', '--repo', repository, '--state', 'open', '--limit', String(OPEN_PR_LIMIT), '--json', 'number,headRefName,body'])) as unknown;
  if (!Array.isArray(rows)) throw new Error('incomplete open PR listing');
  if (rows.length >= OPEN_PR_LIMIT) throw new Error(`incomplete open PR listing: reached the ${OPEN_PR_LIMIT} limit`);
  return rows.map((row) => {
    const pr = row as { number?: unknown; headRefName?: unknown; body?: unknown };
    if (typeof pr.number !== 'number' || typeof pr.headRefName !== 'string') throw new Error('incomplete open PR listing');
    return { number: pr.number, headRefName: pr.headRefName, body: typeof pr.body === 'string' ? pr.body : null };
  });
}
