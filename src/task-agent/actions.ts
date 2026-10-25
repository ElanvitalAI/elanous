import { copyFileSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { runGitCommand } from '../git-fs/runner.js';
import { debug } from '../debug/log.js';
import { judgeNextMove, retryMoveOf, SAME_MOVE_FAILURE_LIMIT } from './judge.js';
import { checkCompletionEvidence } from './completion-evidence.js';
import { appendGreenSweepEvidence, decideGreenSweep, greenSweepCandidates, observeGreenSweep, type GreenSweepPr, type GreenSweepVerdict } from './green-sweep.js';
import type { TaskCard } from './task-hand.js';
import type { ChecklistItem } from '../release-loop/checklist.js';

export type DeliveryKind = 'research-report' | 'artifact' | 'content';
export interface DeliveryEvidence { ok: boolean; files: string[]; reason: string }

/**
 * DEFAULT-HANDS-a: 판독은 복사된 최종 산출물에서만 하고, 규칙은 `completion-evidence.ts` 의
 * `checkCompletionEvidence` 하나를 쓴다(종류별 규칙을 여기서 다시 짓지 않는다).
 * 후보 중 하나라도 그 종류의 증거를 다 갖추면 ok — 후보 목록엔 곁 파일(미리보기 등)도 섞인다.
 */
export function readDeliveryEvidence(kind: DeliveryKind, outputDir: string, files: readonly string[]): DeliveryEvidence {
  if (!files.length) return { ok: false, files: [], reason: '전달 후보 없음' };
  const missing = new Set<string>();
  for (const file of files) {
    const verdict = checkCompletionEvidence(kind, { dir: outputDir, ref: relative(outputDir, file) });
    if (verdict.ok) return { ok: true, files: [...files], reason: `전달 산출물 확인: ${verdict.ref}` };
    for (const item of verdict.missing) missing.add(item);
  }
  return { ok: false, files: [...files], reason: `전달 증거 부족: ${[...missing].join(', ')}` };
}

export type NextActionKind = 'review' | 'land' | 'retry' | 'green' | 'decision' | 'deliver';
/**
 * `retry` 의 갈래(RFC §A9 G1·G2). 없으면 종전 그대로 «must-fix 로 좁힌 재발사»다(must-fix 가 없으면 카드).
 * - narrow: 범위를 좁혀 한 번 재발사(must-fix 없이도 간다 — no-progress)
 * - wait: 기다렸다 재시도 — 실행부는 발사하지 않고 «대기 표지»만 남긴다(provider-exhausted · step-timeout)
 * - salvage: 수확 가지에서 이어 발사(handed-off-to-salvage)
 * - alternative: 같은 수 2회 실패 뒤 «다른 수»
 */
export type RetryVariant = 'narrow' | 'wait' | 'salvage' | 'alternative';
export interface NextAction {
  kind: NextActionKind;
  variant?: RetryVariant;
  /** salvage 갈래에서 이어 받을 수확 가지(모르면 비운다). */
  salvageBranch?: string;
  taskId: string;
  rationale: string;
  pr: number;
  runId: string;
  original: string;
  checklistId: string;
  history?: string[];
  /** Only a producer bound to this PR may mark its owner worktree commit as harvesting. */
  harvestState?: { pr: number; source: 'owner-worktree-commit'; head: string };
  mustFix?: string[];
  cwd?: string;
  risk?: 'money' | 'security' | 'irreversible-publication';
  delivery?: { kind: DeliveryKind; worktreePath: string; projectTarget: string; files: string[] };
  /** NEXTMOVE-GENERAL-RELAUNCH-MOVEID — 이 재발사를 고른 next-move 결정의 수 id(결정 순간 한 번 · 다시 만들지 않는다). 있으면 `harness say --move-id` 로 싣는다. */
  moveId?: string;
}
export interface ActionDeps {
  command(args: string[], cwd?: string): Promise<{ status: number; stdout: string; stderr?: string }>;
  mode?: string;
  landingsToday?: number;
  landingDay?: string;
  saveState?(): void;
  dailyLimit?: number;
  failures?: number;
  failureCounts?: Record<string, number>;
  /** 하루 착지 칸을 잠금 안에서 먼저 확보한다 — 다른 프로세스와 같은 잔여 칸을 두 번 쓰지 않게. 없으면 메모리 셈. */
  reserveLanding?(day: string, limit: number): boolean;
  /** 병합이 확인되지 않으면 확보한 칸을 돌려준다. */
  releaseLanding?(day: string): void;
  /** 실패 한 번을 잠금 안에서 디스크에 더한다(다른 프로세스의 실패를 덮지 않게) · 더한 뒤의 값을 돌려준다. */
  incrementFailure?(key: string): number;
  observe(event: 'task-agent.action' | 'task-agent.entrance-denominator', data: ActionObservation): void;
  /** 사다리 R4 — 실제로 할 재발사 수의 허용 목록(`taskAgent.liveMoves` 어휘). 없으면 종전 그대로(재발사에 목록 검사 없음) · 목록에 없는 수는 shadow. */
  liveMoves?: ReadonlySet<string>;
  /** 한 판단 회차의 발사 칸 — 호출부가 회차마다 새로 준다. 없으면 회당 상한 없음(종전). 발사를 시도할 때마다 `count` 가 오른다. */
  retryLaunches?: { count: number };
  /** mbp 부하 관문(OP 신호 `loadMax`) — 지금 1분 부하가 `loadMax` 이상이거나 못 읽으면 발사하지 않고 shadow. 없으면 관문 없음(종전). */
  loadGate?: { loadMax: number; load1(): number | null };
  /** GREEN-FROM-LEDGER-FU — green live 쓰기 문맥(관측 probe ⊕ 칸 원문·판본·과제 카드). 실행부 green 경로가 소비자
   *  `consumeGreenSweepForGreenWrite`를 지나 원문 대조가 모두 일치할 때만 checklist green 쓰기를 1회 한다.
   *  없으면 종전 그대로 검증 안내 카드(fail-closed) — 문맥 없이 green 은 쓰지 않는다. */
  greenSweep?: { probe: GreenSweepProbe; item: ChecklistItem; version: string; cards: readonly TaskCard[] };
  /** Checklist green writes are a separate OP-authorized capability; default is observation only. */
  greenWriteLive?: boolean;
  /** Read-only owner checkout probe for review harvest verification. */
  harvestGit?: (cwd: string, args: string[]) => { status: number | null; stdout: string };
}

/** 재발사는 한 판단 회차에 한 건만 발사한다. */
export const RETRY_LAUNCHES_PER_CYCLE = 1;

export interface ActionObservation {
  taskId: string;
  kind: NextActionKind | 'entrance-tick';
  result: string;
  reason: string;
  reviewed?: number;
  allowed?: number;
  refused?: number;
  reasons?: Record<string, number>;
}

export interface EntranceCandidateReview {
  taskId: string;
  kind: NextActionKind;
  refusal?: string;
}

export interface EntranceTickCandidate {
  action: NextAction;
  refusal?: string;
}

export interface EntranceRefusalDenominator {
  reviewed: number;
  allowed: number;
  refused: number;
  reasons: Record<string, number>;
}

/** Count a tick's candidate refusals without confusing special object keys with prototypes. */
export function buildEntranceRefusalDenominator(reviews: readonly EntranceCandidateReview[]): EntranceRefusalDenominator {
  const reasonCounts = new Map<string, number>();
  let refused = 0;
  for (const review of reviews) {
    const reason = typeof review.refusal === 'string' ? review.refusal.trim() : '';
    if (!reason) continue;
    refused += 1;
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  const reasons = Object.fromEntries(reasonCounts) as Record<string, number>;
  return { reviewed: reviews.length, allowed: reviews.length - refused, refused, reasons };
}

/** live 인데도 shadow 로 내릴 사유 — 없으면 발사해도 된다(재발사 아닌 수는 늘 없다). 기다림(wait)은 발사가 아니라 부하·회당 상한을 보지 않는다. */
function retryShadowReason(action: NextAction, deps: ActionDeps): string | undefined {
  if (action.kind !== 'retry') return undefined;
  const move = retryMoveOf(action.variant);
  if (deps.liveMoves && !deps.liveMoves.has(move)) return `${move} not in live allow-list`;
  if (action.variant === 'wait') return undefined;
  if (deps.loadGate) {
    const load = deps.loadGate.load1();
    if (load === null || !Number.isFinite(load)) return `load gate: load unreadable (loadMax ${deps.loadGate.loadMax})`;
    if (load >= deps.loadGate.loadMax) return `load gate: load ${load} >= loadMax ${deps.loadGate.loadMax}`;
  }
  if (deps.retryLaunches && deps.retryLaunches.count >= RETRY_LAUNCHES_PER_CYCLE) return `one relaunch per cycle already used (${move})`;
  return undefined;
}

/** 결정 카드가 «근거»로 쓰는 세 칸 — 막힌 과제의 서명 · 막힌 화면 · 리뷰 must-fix. */
export interface DecisionCardEvidence { signature?: string; screen?: string; mustFix?: readonly string[] }

/** 비지 않은 근거 칸 이름들 — 비어 있으면 카드를 올리지 않는다(근거 없는 카드 0). */
export function decisionCardGrounds(evidence: DecisionCardEvidence | undefined): Array<'signature' | 'screen' | 'must-fix'> {
  const grounds: Array<'signature' | 'screen' | 'must-fix'> = [];
  if (evidence?.signature?.trim()) grounds.push('signature');
  if (evidence?.screen?.trim()) grounds.push('screen');
  if (evidence?.mustFix?.some(fix => typeof fix === 'string' && fix.trim())) grounds.push('must-fix');
  return grounds;
}

/** `decisions raise` 인자 — 종전 실행부(`executeNextAction`)와 live 수(`executeLiveDecisionCard`)가 같은 카드 모양을 쓴다. */
export function decisionRaiseArgs(input: { taskId: string; reason: string; risk?: NextAction['risk']; evidence: string }): string[] {
  const category = input.risk === 'money' ? 'money' : input.risk === 'security' ? 'security' : input.risk === 'irreversible-publication' ? 'publish' : 'other';
  return ['decisions', 'raise', '--title', `${input.taskId}: ${input.reason}`, '--category', category, '--s', `Task ${input.taskId} needs a decision.`, '--c', input.reason, '--ref', input.evidence, '--q', 'Which action should be taken?', '--option', 'h=Keep on hold:no automatic execution', '--option', 'p=Approve action:execute after approval', '--skip-recommend', 'requires human decision', '--no-xcheck', 'automated escalation'];
}

/** 실패 셈 키. 갈래가 있으면 갈래별로 센다(G2 — «다른 수»의 실패가 같은 칸에 쌓이지 않게). 없으면 종전 키 그대로. */
export function failureKey(action: Pick<NextAction, 'taskId' | 'kind' | 'variant'>): string {
  return JSON.stringify(action.variant ? [action.taskId, action.kind, action.variant] : [action.taskId, action.kind]);
}

/**
 * 같은 «수»의 실패 수 — 상한 판정용. 셈 키(`failureKey`)는 종전 그대로 두되, 갈래 없는 재발사와 `narrow` 갈래는
 * 같은 수(`narrow-relaunch` · `retryMoveOf`)라 두 키를 합쳐 본다(TA-LIVE-RETRY: 같은 과제·같은 수 3회 반복 0).
 */
export function sameMoveFailures(action: Pick<NextAction, 'taskId' | 'kind' | 'variant'>, deps: Pick<ActionDeps, 'failureCounts' | 'failures'>): number {
  if (!deps.failureCounts) return deps.failures ?? 0;
  if (action.kind !== 'retry' || retryMoveOf(action.variant) !== 'narrow-relaunch') return deps.failureCounts[failureKey(action)] ?? deps.failures ?? 0;
  const bare = deps.failureCounts[failureKey({ taskId: action.taskId, kind: 'retry' })];
  const narrow = deps.failureCounts[failureKey({ taskId: action.taskId, kind: 'retry', variant: 'narrow' })];
  if (bare === undefined && narrow === undefined) return deps.failures ?? 0;
  return (bare ?? 0) + (narrow ?? 0);
}

const RETRY_HINT: Record<Exclude<RetryVariant, 'wait'>, (action: NextAction) => string> = {
  narrow: action => `Narrow relaunch: previous run ${action.runId} made no progress. Halve the scope; keep the same acceptance line.`,
  salvage: action => `Salvage relaunch: continue from the salvage branch ${action.salvageBranch ?? `of run ${action.runId}`} — take its diff, do not restart from scratch.`,
  alternative: () => 'Alternative approach: the same move already failed twice. Choose a different approach than the previous runs.',
};

export function ownerWorktreeHarvestState(input: { pr: number; cwd: string; head: string; branch: string; state: string },
  gitRun?: (cwd: string, args: string[]) => { status: number | null; stdout: string }): NextAction['harvestState'] {
  if (!Number.isSafeInteger(input.pr) || input.pr < 1 || input.state !== 'OPEN' || !/^[a-f0-9]{40}$/i.test(input.head)) return undefined;
  const git = gitRun ?? ((cwd: string, args: string[]) => {
    const result = runGitCommand(cwd, args, { encoding: 'utf-8' });
    return { status: result.status, stdout: String(result.stdout ?? '') };
  });
  try {
    const cwd = realpathSync(input.cwd);
    const [branch, local, registry] = [git(cwd, ['branch', '--show-current']), git(cwd, ['rev-parse', 'HEAD']), git(cwd, ['worktree', 'list', '--porcelain'])];
    const name = branch.stdout.trim();
    const commit = local.stdout.trim();
    if (branch.status !== 0 || !name || local.status !== 0 || !/^[a-f0-9]{40}$/i.test(commit) || registry.status !== 0) return undefined;
    const owners = registry.stdout.trim().split(/\n\s*\n/).filter(entry => entry.split('\n').includes(`branch refs/heads/${name}`));
    const ownerPath = owners[0]?.split('\n').find(line => line.startsWith('worktree '))?.slice('worktree '.length);
    if (owners.length !== 1 || !ownerPath || realpathSync(ownerPath) !== cwd) return undefined;
    if (input.branch !== name || input.head.toLowerCase() === commit.toLowerCase()) return undefined;
    if (git(cwd, ['merge-base', '--is-ancestor', input.head, commit]).status !== 0) return undefined;
    return { pr: input.pr, source: 'owner-worktree-commit', head: commit };
  } catch { return undefined; }
}

export async function executeNextAction(action: NextAction, deps: ActionDeps): Promise<string> {
  const record = (result: string, reason: string) => {
    if (result === 'failed' && (deps.failureCounts || deps.incrementFailure)) {
      const key = failureKey(action);
      const next = deps.incrementFailure ? deps.incrementFailure(key) : (deps.failureCounts![key] ?? 0) + 1;
      if (deps.failureCounts) deps.failureCounts[key] = next;
      if (!deps.incrementFailure) deps.saveState?.();
    }
    deps.observe('task-agent.action', { taskId: action.taskId, kind: action.kind, result, reason });
    return result;
  };
  const shadowReason = deps.mode === 'live' ? retryShadowReason(action, deps) : undefined;
  if (deps.mode !== 'live' || shadowReason) {
    if (action.kind === 'green' && deps.greenSweep) {
      const outcome = await consumeGreenSweepForGreenWrite({ deps, probe: deps.greenSweep.probe,
        item: deps.greenSweep.item, version: deps.greenSweep.version, cards: deps.greenSweep.cards, writeLive: false });
      return record(outcome.verdict === 'green' ? 'would-green' : 'refused', outcome.reason);
    }
    const destination = action.delivery && action.kind === 'deliver'
      ? ` → ${join(action.delivery.projectTarget, 'elanous-out', action.taskId)}/${action.delivery.files.join(', ')}` : '';
    return record('shadow', `would ${action.kind}${action.variant ? `:${action.variant}` : ''}: ${action.rationale}${destination}${shadowReason ? ` · shadow: ${shadowReason}` : ''}`);
  }
  const gh = (args: string[]) => deps.command(args, action.cwd);
  const card = async (reason: string) => {
    const evidence = JSON.stringify({ runId: action.runId, pr: action.pr, mustFix: action.mustFix ?? [], history: action.history ?? [], selected: action.kind, reason });
    const result = await deps.command(decisionRaiseArgs({ taskId: action.taskId, reason, ...(action.risk ? { risk: action.risk } : {}), evidence }));
    return record(result.status === 0 ? 'decision' : 'failed', reason);
  };
  if (action.risk) return card(`risk: ${action.risk}`);
  if (sameMoveFailures(action, deps) >= SAME_MOVE_FAILURE_LIMIT) return card('same task/action failed twice');
  if (action.kind === 'land') {
    if (!action.cwd) return card('landing worktree unknown');
    const view = await gh(['gh', 'pr', 'view', String(action.pr), '--json', 'labels']);
    if (view.status !== 0) return card('PR labels unavailable');
    let labels: unknown;
    try { labels = (JSON.parse(view.stdout) as { labels?: unknown }).labels; }
    catch { return card('PR labels unavailable'); }
    if (!Array.isArray(labels) || !labels.every(label => label && typeof label === 'object' && typeof label.name === 'string')) return card('PR labels unavailable');
    if (labels.some(label => label.name === 'elanous:release-path')) return card('release-path');
    if (labels.some(label => label.name === 'elanous:keep')) return card('elanous:keep');
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    if (deps.landingDay && deps.landingDay !== day) deps.landingsToday = 0;
    deps.landingDay = day;
    const limit = deps.dailyLimit ?? 5;
    if (deps.reserveLanding ? !deps.reserveLanding(day, limit) : (deps.landingsToday ?? 0) >= limit) return card('daily landing limit');
  }
  if (action.kind === 'decision') return card(action.rationale);
  if (action.kind === 'deliver') {
    const delivery = action.delivery;
    if (!delivery?.files.length) return record('waiting', '전달 후보 없음');
    if (!/^[a-zA-Z0-9_-]+$/.test(action.taskId)) return record('failed', 'invalid delivery taskId');
    const output = join(delivery.projectTarget, 'elanous-out', action.taskId);
    const copied: string[] = [];
    try {
      mkdirSync(output, { recursive: true });
      // 경로 비교는 «실경로끼리» 한다 — macOS 의 /var→/private/var 처럼 조상 링크가 있으면 resolve() 와 realpath 가 늘 갈린다.
      const outputReal = realpathSync(output);
      if (outputReal !== join(realpathSync(delivery.projectTarget), 'elanous-out', action.taskId)) throw new Error('delivery output points outside target');
      const root = realpathSync(delivery.worktreePath) + sep;
      for (const name of delivery.files) {
        const source = resolve(root, name);
        if (!source.startsWith(root) || !lstatSync(source).isFile() || !realpathSync(source).startsWith(root)) throw new Error(`invalid delivery file: ${name}`);
        const destination = resolve(output, name);
        if (!destination.startsWith(resolve(output) + sep)) throw new Error(`invalid destination: ${name}`);
        mkdirSync(join(destination, '..'), { recursive: true });
        const parent = realpathSync(join(destination, '..'));
        if (parent !== outputReal && !parent.startsWith(outputReal + sep)) throw new Error(`invalid destination parent: ${name}`);
        try { if (!lstatSync(destination).isFile()) throw new Error(`invalid destination: ${name}`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        copyFileSync(source, destination);
        copied.push(destination);
      }
    } catch (error) { return record('failed', `delivery copy failed: ${String(error)}`); }
    const evidence = readDeliveryEvidence(delivery.kind, resolve(output), copied);
    debug.log('task-agent', 'deliver', { taskId: action.taskId, kind: delivery.kind, files: copied, evidenceOk: evidence.ok });
    const judgement = judgeNextMove({ deliveryEvidence: evidence });
    return record(judgement.move === 'propose-green' ? 'done' : 'waiting', `${judgement.move}: ${judgement.reason}`);
  }
  if (action.kind === 'green') {
    // GREEN-FROM-LEDGER-FU 배선(shard 2) — 생산 진입점이 소비자를 지나 dry-run 판정 ⊕ 원문 대조 후 쓰기를 지킨다:
    // 대조가 모두 일치하면 checklist green 명령 1회, 거부·unknown·mismatch 는 쓰기 0회 + 칸 상태 불변(fail-closed).
    // 문맥(deps.greenSweep)이 없으면 종전 그대로 검증 안내 카드 — 호출부가 문맥을 안 싣는 동안 green 은 쓰지 않는다.
    const greenSweep = deps.greenSweep;
    if (!greenSweep) return card('green requires a verified landing in this execution');
    const writeLive = deps.greenWriteLive === true;
    const outcome = await consumeGreenSweepForGreenWrite({ deps, probe: greenSweep.probe, item: greenSweep.item,
      version: greenSweep.version, cards: greenSweep.cards, writeLive });
    return record(outcome.written ? 'done' : outcome.verdict === 'green-command-failed' ? 'failed'
      : outcome.verdict === 'green' ? 'would-green' : 'refused', outcome.reason);
  }
  // G1 — 기다림은 발사가 아니다: 대기 표지만 남기고 다음 틱이 다시 판단한다(카드로 올리지 않는다).
  if (action.kind === 'retry' && action.variant === 'wait') return record('waiting', `wait marker: ${action.rationale}`);
  // must-fix 없는 재발사가 카드로 가는 것은 갈래 없는(종전) retry 뿐이다 — narrow·salvage·alternative 는 갈래 문면으로 간다.
  if (action.kind === 'retry' && !action.variant && !action.mustFix?.length) return card('must-fix missing; cannot narrow retry');
  if (action.kind === 'review') {
    let harvestState: NextAction['harvestState'];
    if (action.harvestState?.source === 'owner-worktree-commit' && action.harvestState.pr === action.pr && action.cwd
      && /^[a-f0-9]{40}$/i.test(action.harvestState.head)) {
      try {
        const response = await gh(['gh', 'pr', 'view', String(action.pr), '--json', 'state,headRefOid,headRefName']);
        if (response.status === 0) {
          const pr = JSON.parse(response.stdout) as { state?: unknown; headRefOid?: unknown; headRefName?: unknown };
          if (typeof pr.headRefOid === 'string' && typeof pr.headRefName === 'string' && typeof pr.state === 'string') {
            const current = ownerWorktreeHarvestState({ pr: action.pr, cwd: action.cwd, head: pr.headRefOid,
              branch: pr.headRefName, state: pr.state }, deps.harvestGit);
            if (current?.head.toLowerCase() === action.harvestState.head.toLowerCase()) harvestState = current;
          }
        }
      } catch { /* Unverified caller signal preserves the review command. */ }
    }
    if (harvestState) {
      action.harvestState = harvestState;
      const reason = `review skipped: owner-worktree-commit PR #${action.pr} ${harvestState.head}`;
      (action.history ??= []).push('review skipped: owner-worktree-commit');
      record('skipped', reason);
      return record('waiting', `${reason} · next: wait for exact-head review evidence`);
    }
    const review = await deps.command(['self', 'review', String(action.pr), '--json']);
    if (review.status !== 0) return record('failed', 'review command failed');
    let parsed: { verdict?: string; mustFix?: string[]; reviewed?: boolean };
    try {
      const payload: unknown = JSON.parse(review.stdout);
      const item = Array.isArray(payload) ? payload.find((entry: unknown) => entry && typeof entry === 'object' && 'pr' in entry && Number(entry.pr) === action.pr) : payload;
      if (!item || typeof item !== 'object' || Array.isArray(item)) return record('failed', 'invalid review JSON');
      parsed = item as typeof parsed;
    } catch { return record('failed', 'invalid review JSON'); }
    if (parsed.reviewed !== true) return record('failed', 'review was not performed');
    // TA-LAND-MUSTFIX-ZERO — «pass» 라도 must-fix 가 남았거나 수를 못 읽으면 land 로 가지 않는다(#25941 `canAuto` 와 같은 축).
    //   `self review --json` 은 mustFix 배열을 «항상» 싣는다 — 배열이 아니면 «0» 이 아니라 «모름»으로 읽는다(fail-closed).
    if (parsed.verdict === 'pass' && (!Array.isArray(parsed.mustFix) || !parsed.mustFix.every(fix => typeof fix === 'string'))) return card('review-must-fix-unknown: pass verdict without a readable must-fix list');
    if (parsed.verdict === 'pass' && parsed.mustFix!.length > 0) return card(`review-warn-with-must-fix: pass verdict carries ${parsed.mustFix!.length} must-fix`);
    if (parsed.verdict === 'pass') { record('done', 'review pass'); return executeNextAction({ ...action, kind: 'land', history: [...(action.history ?? []), 'review pass'] }, deps); }
    if (parsed.verdict === 'fail' && Array.isArray(parsed.mustFix) && parsed.mustFix.length > 0 && parsed.mustFix.every(fix => typeof fix === 'string' && fix.trim())) { record('done', 'review fail'); return executeNextAction({ ...action, kind: 'retry', mustFix: parsed.mustFix, history: [...(action.history ?? []), 'review fail'] }, deps); }
    return card('review verdict or must-fix unavailable');
  }
  // 여기 닿는 종류는 land · retry 둘뿐이다(green·decision·review 는 위에서 끝난다).
  const args = action.kind === 'land' ? ['pr', 'land', '--cwd', action.cwd!] : ['harness', 'say', retryText(action), ...(action.moveId ? ['--move-id', action.moveId] : [])];
  const day = deps.landingDay ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  if (action.kind === 'retry' && deps.retryLaunches) deps.retryLaunches.count++;
  const outcome = await deps.command(args);
  if (outcome.status !== 0) {
    if (action.kind === 'land') deps.releaseLanding?.(day);
    return record('failed', `${action.kind} command failed: ${outcome.stderr ?? ''}`);
  }
  if (action.kind === 'land') {
    const merged = await gh(['gh', 'pr', 'view', String(action.pr), '--json', 'state,mergeCommit']);
    let sha: string | undefined;
    let notMerged = false;
    try {
      const value = JSON.parse(merged.stdout) as { state?: string; mergeCommit?: { oid?: string } };
      if (merged.status === 0 && value.state === 'MERGED' && /^[a-f0-9]{40}$/i.test(value.mergeCommit?.oid ?? '')) sha = value.mergeCommit?.oid;
      else if (merged.status === 0 && typeof value.state === 'string' && value.state !== 'MERGED') notMerged = true;
    } catch { /* unknown merge state is never green */ }
    if (!sha) {
      // «열림»으로 확인됐을 때만 칸을 돌려준다. 상태를 못 읽었으면 병합됐을 수 있으니 칸은 쓴 것으로 둔다(상한을 넘지 않게).
      if (notMerged) deps.releaseLanding?.(day);
      return card('landing commit unknown; checklist remains unchanged');
    }
    record('done', action.rationale);
    if (!deps.reserveLanding) deps.landingsToday = (deps.landingsToday ?? 0) + 1;
    deps.saveState?.();
    const green = await deps.command(['release', 'checklist', 'set', action.checklistId, '--status', 'green', '--evidence', `${action.pr}·${sha}`]);
    // 체크리스트 실패는 이 과제·land 의 실패로 센다(두 번이면 다음엔 카드).
    if (green.status !== 0) return record('failed', `green command failed: ${green.stderr ?? ''}`);
    deps.observe('task-agent.action', { taskId: action.taskId, kind: 'green', result: 'done', reason: action.rationale });
    return 'done';
  }
  return record('done', action.rationale);
}

/**
 * GREEN-FROM-LEDGER-FU — green live 쓰기 소비자: `green-sweep.ts`(순수 판정 · checklist/card 쓰기 0)의
 * dry-run 결정을 소비해 실제 checklist green 쓰기를 수행하는 유닛. 쓰기 책임은 전부 이 소비자가 진다.
 * 판정이 green 이고 후보의 OP 원문 대조가 모두 일치할 때만 `release checklist set --status green`
 * (executeNextAction 의 착지 green 쓰기와 같은 명령면)을 deps.command 로 수행한다.
 * 판정 거부 · 원문 대조 불일치 · 명령 실패는 전부 쓰기 0 — 거짓 green 을 쓰지 않는다(fail-closed).
 * 원문 대조는 세 다리다: ① observeGreenSweep 표준 출력이 판정과 정확히 같은가 ② plannedEvidence 가
 * 판정 원문(existingEvidence + evidence 행)과 정확히 같은가 ③ 쓰기 직전 칸 원문이 판정이 본 것과 같은가.
 * ③ 은 칸 원문 재독기(cellEvidence)가 실제 일치를 확인했을 때만 'cell ok' 로 남는다 — 미제공·재독 불가는
 * 자기 자신(item.evidence)과의 공전 대조를 하지 않고 unknown 상태로 보존해 쓰기를 거부한다.
 * 결과는 deps.observe('task-agent.action', { kind: 'green', … }) 로 관측면에 남긴다.
 */
export interface GreenSweepProbe {
  /** 후보 PR 관측(gh pr view 상당). null = 못 읽었다(pr-unreadable). */
  pr(pr: number): Promise<GreenSweepPr | null>;
  /** 후보 merge sha 가 origin/main 조상인가. null = 못 읽었다. */
  ancestor(sha: string): Promise<boolean | null>;
  /** 트래픽 hold 여부. null = 못 읽었다. */
  hold(): Promise<boolean | null>;
  /** 후보 PR 이 이 칸의 저장소에 속하는가. 주지 않으면 판정이 record-only 로 거부한다. */
  repositoryMatches?(pr: number): Promise<boolean | null>;
  /** 다른 칸이 같은 PR 을 주장하나(ambiguousAcrossCells). */
  ambiguousAcrossCells?(pr: number): boolean | null;
  /** 칸 원문 재독기 — 판정이 본 증거(evidence)와 쓰기 직전 칸 원문이 같은지 대조한다. 못 읽으면 undefined(대조 불가 → 쓰기 거부).
   *  필수 멤버다 — 미제공이면 소비자는 자기 자신(item.evidence)과의 공전 대조를 하지 않고 unknown 상태로 쓰기를 거부한다. */
  cellEvidence(cell: string): Promise<string | undefined>;
}

export interface GreenSweepWriteOutcome {
  cell: string;
  pr: number | null;
  /** true = `release checklist set --status green` 명령까지 성공했다. 그 외는 전부 쓰기 0. */
  written: boolean;
  /** green = 쓰기 성공 · evidence-unknown = 원문 대조를 수행할 수 없었다(칸 원문 미제공·재독 불가) · 그 외 판정·대조·명령 사유. */
  verdict: GreenSweepVerdict | 'no-candidates' | 'evidence-mismatch' | 'evidence-unknown' | 'green-command-failed';
  reason: string;
}

export async function consumeGreenSweepForGreenWrite(input: {
  deps: Pick<ActionDeps, 'command' | 'observe'>;
  probe: GreenSweepProbe;
  item: ChecklistItem;
  version: string;
  cards: readonly TaskCard[];
  writeLive?: boolean;
}): Promise<GreenSweepWriteOutcome> {
  const { deps, probe, item, version, cards, writeLive = false } = input;
  const candidates = greenSweepCandidates(item, version, cards);
  const record = (outcome: GreenSweepWriteOutcome): GreenSweepWriteOutcome => {
    deps.observe('task-agent.action', {
      taskId: item.id, kind: 'green', result: outcome.written ? 'done'
        : outcome.verdict === 'green-command-failed' ? 'failed'
          : outcome.verdict === 'green' && !writeLive ? 'would-green' : 'refused', reason: outcome.reason,
    });
    return outcome;
  };
  if (!candidates.length) {
    return record({ cell: item.id, pr: null, written: false, verdict: 'no-candidates', reason: 'GREEN-FROM-LEDGER-FU: dry-run 후보 없음' });
  }
  let last: GreenSweepWriteOutcome | undefined;
  for (const candidate of candidates) {
    const pr = await probe.pr(candidate.pr);
    const mergeSha = pr?.mergeSha && /^[a-f0-9]{40}$/i.test(pr.mergeSha) ? pr.mergeSha : null;
    const [ancestor, hold, repositoryMatches] = await Promise.all([
      probe.ancestor(mergeSha ?? ''),
      probe.hold(),
      probe.repositoryMatches ? probe.repositoryMatches(candidate.pr) : Promise.resolve(null),
    ]);
    const decision = decideGreenSweep({
      item, candidate, candidateCount: candidates.length, pr, ancestor, hold,
      ...(repositoryMatches === null ? {} : { repositoryMatches }),
      ...(probe.ambiguousAcrossCells ? { ambiguousAcrossCells: probe.ambiguousAcrossCells(candidate.pr) ?? undefined } : {}),
    });
    // 원문 대조 ① — observeGreenSweep 표준 출력(«OP 원문» 관측)이 판정과 정확히 같은가.
    let observed: { category: string; event: string; data?: unknown } | undefined;
    observeGreenSweep(decision, (category, event, data) => { observed = { category, event, data }; });
    const emitted = observed?.data as { cell?: unknown; pr?: unknown; mergeSha?: unknown; reason?: unknown } | undefined;
    const emissionMatches = observed?.category === 'task-agent.green-sweep'
      && observed.event === decision.verdict
      && emitted?.cell === decision.cell
      && emitted?.pr === decision.pr
      && emitted?.mergeSha === decision.mergeSha
      && emitted?.reason === decision.reason;
    // 원문 대조 ② — plannedEvidence 가 판정 원문(existingEvidence + evidence 행)과 정확히 같은가.
    const plannedMatches = decision.plannedEvidence === appendGreenSweepEvidence(decision.existingEvidence, decision.evidence);
    if (decision.verdict !== 'green') {
      last = record({
        cell: item.id, pr: candidate.pr, written: false, verdict: decision.verdict,
        reason: `GREEN-FROM-LEDGER-FU: 판정 거부 — ${decision.evidence}`,
      });
      continue;
    }
    // 원문 대조 ③ — 쓰기 직전 칸 원문이 판정이 본 것과 같은가(판정 중 칸 변경 방지). green 판정에만 재독한다.
    // cellEvidence 미제공·재독 불가는 자기 자신(item.evidence)과 대조하지 않는다 — 그 대조는 공전이므로
    // unknown 상태로 보존해 쓰기를 거부한다(fail-closed). 'cell ok' 는 실제 재독 ⊕ 일치 확인에만 나온다.
    const cellProbe = probe.cellEvidence;
    const currentEvidence = typeof cellProbe === 'function' ? await cellProbe(item.id) : undefined;
    const cellState: 'ok' | 'mismatch' | 'unreadable' | 'unprovided'
      = typeof cellProbe !== 'function' ? 'unprovided'
      : typeof currentEvidence !== 'string' ? 'unreadable'
      : currentEvidence === decision.existingEvidence ? 'ok' : 'mismatch';
    if (!emissionMatches || !plannedMatches || cellState !== 'ok') {
      const mismatched = !emissionMatches || !plannedMatches || cellState === 'mismatch';
      return record({
        cell: item.id, pr: candidate.pr, written: false,
        verdict: mismatched ? 'evidence-mismatch' : 'evidence-unknown',
        reason: `GREEN-FROM-LEDGER-FU: ${mismatched ? '원문 대조 불일치' : '원문 대조 불가(칸 원문 unknown)'} — emission ${emissionMatches ? 'ok' : 'mismatch'} · planned ${plannedMatches ? 'ok' : 'mismatch'} · cell ${cellState}`,
      });
    }
    if (!writeLive) return record({ cell: item.id, pr: candidate.pr, written: false, verdict: 'green',
      reason: `would-green: ${decision.evidence} · live write disabled` });
    const green = await deps.command(['release', 'checklist', 'set', item.id, '--status', 'green', '--evidence', decision.evidence]);
    if (green.status !== 0) {
      return record({ cell: item.id, pr: candidate.pr, written: false, verdict: 'green-command-failed', reason: `green command failed: ${green.stderr ?? ''}` });
    }
    return record({ cell: item.id, pr: candidate.pr, written: true, verdict: 'green', reason: decision.evidence });
  }
  return last ?? record({ cell: item.id, pr: null, written: false, verdict: 'no-candidates', reason: 'GREEN-FROM-LEDGER-FU: dry-run 후보 없음' });
}

/** Execute the allowed candidates in a caller-supplied tick and emit one isolated denominator event. */
export async function executeEntranceTick(candidates: readonly EntranceTickCandidate[], deps: ActionDeps): Promise<string[]> {
  const denominator = buildEntranceRefusalDenominator(candidates.map(({ action, refusal }) => ({
    taskId: action.taskId,
    kind: action.kind,
    ...(typeof refusal === 'string' ? { refusal } : {}),
  })));
  const observeDenominator = (result: string) => {
    try {
      deps.observe('task-agent.entrance-denominator', {
        taskId: candidates[0]?.action.taskId ?? 'entrance-tick',
        kind: 'entrance-tick', result, reason: 'entrance refusal denominator', ...denominator,
      });
    } catch { /* Logging must not change the actions selected for this tick. */ }
  };
  const results: string[] = [];
  for (const { action, refusal } of candidates) {
    if (typeof refusal === 'string' && refusal.trim()) continue;
    try { results.push(await executeNextAction(action, deps)); }
    catch (error) { observeDenominator('failed'); throw error; }
  }
  observeDenominator(results.at(-1) ?? 'refused-all');
  return results;
}

/** 재발사 문면 — 원문은 고치지 않고 앞에 둔다 · 갈래 문면 · must-fix · 직전 런 순서. */
export function retryText(action: NextAction): string {
  const sections = [action.original];
  if (action.variant && action.variant !== 'wait') sections.push(RETRY_HINT[action.variant](action));
  if (action.mustFix?.length) sections.push(`Must-fix:\n${action.mustFix.join('\n')}`);
  sections.push(`Previous run: ${action.runId}`);
  return sections.join('\n\n');
}
