import { copyFileSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { debug } from '../debug/log.js';
import { judgeNextMove } from './judge.js';
import { checkCompletionEvidence } from './completion-evidence.js';

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
  mustFix?: string[];
  cwd?: string;
  risk?: 'money' | 'security' | 'irreversible-publication';
  delivery?: { kind: DeliveryKind; worktreePath: string; projectTarget: string; files: string[] };
}
export interface ActionDeps {
  command(args: string[]): Promise<{ status: number; stdout: string; stderr?: string }>;
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
  observe(event: 'task-agent.action', data: { taskId: string; kind: NextActionKind; result: string; reason: string }): void;
}

/** 실패 셈 키. 갈래가 있으면 갈래별로 센다(G2 — «다른 수»의 실패가 같은 칸에 쌓이지 않게). 없으면 종전 키 그대로. */
export function failureKey(action: Pick<NextAction, 'taskId' | 'kind' | 'variant'>): string {
  return JSON.stringify(action.variant ? [action.taskId, action.kind, action.variant] : [action.taskId, action.kind]);
}

const RETRY_HINT: Record<Exclude<RetryVariant, 'wait'>, (action: NextAction) => string> = {
  narrow: action => `Narrow relaunch: previous run ${action.runId} made no progress. Halve the scope; keep the same acceptance line.`,
  salvage: action => `Salvage relaunch: continue from the salvage branch ${action.salvageBranch ?? `of run ${action.runId}`} — take its diff, do not restart from scratch.`,
  alternative: () => 'Alternative approach: the same move already failed twice. Choose a different approach than the previous runs.',
};

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
  if (deps.mode !== 'live') {
    const destination = action.delivery && action.kind === 'deliver'
      ? ` → ${join(action.delivery.projectTarget, 'elanous-out', action.taskId)}/${action.delivery.files.join(', ')}` : '';
    return record('shadow', `would ${action.kind}${action.variant ? `:${action.variant}` : ''}: ${action.rationale}${destination}`);
  }
  const card = async (reason: string) => {
    const evidence = JSON.stringify({ runId: action.runId, pr: action.pr, mustFix: action.mustFix ?? [], history: action.history ?? [], selected: action.kind, reason });
    const result = await deps.command(['decisions', 'raise', '--title', `${action.taskId}: ${reason}`, '--category', action.risk === 'money' ? 'money' : action.risk === 'security' ? 'security' : action.risk === 'irreversible-publication' ? 'publish' : 'other', '--s', `Task ${action.taskId} needs a decision.`, '--c', reason, '--ref', evidence, '--q', 'Which action should be taken?', '--option', 'h=Keep on hold:no automatic execution', '--option', 'p=Approve action:execute after approval', '--skip-recommend', 'requires human decision', '--no-xcheck', 'automated escalation']);
    return record(result.status === 0 ? 'decision' : 'failed', reason);
  };
  if (action.risk) return card(`risk: ${action.risk}`);
  if ((deps.failureCounts?.[failureKey(action)] ?? deps.failures ?? 0) >= 2) return card('same task/action failed twice');
  if (action.kind === 'land') {
    if (!action.cwd) return card('landing worktree unknown');
    const view = await deps.command(['gh', 'pr', 'view', String(action.pr), '--json', 'labels']);
    if (view.status !== 0) return card('PR labels unavailable');
    let labels: unknown;
    try { labels = (JSON.parse(view.stdout) as { labels?: unknown }).labels; }
    catch { return card('PR labels unavailable'); }
    if (!Array.isArray(labels) || !labels.every(label => label && typeof label === 'object' && typeof label.name === 'string')) return card('PR labels unavailable');
    if (labels.some(label => label.name === 'elanous:release-path')) return card('release-path');
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
  if (action.kind === 'green') return card('green requires a verified landing in this execution');
  // G1 — 기다림은 발사가 아니다: 대기 표지만 남기고 다음 틱이 다시 판단한다(카드로 올리지 않는다).
  if (action.kind === 'retry' && action.variant === 'wait') return record('waiting', `wait marker: ${action.rationale}`);
  // must-fix 없는 재발사가 카드로 가는 것은 갈래 없는(종전) retry 뿐이다 — narrow·salvage·alternative 는 갈래 문면으로 간다.
  if (action.kind === 'retry' && !action.variant && !action.mustFix?.length) return card('must-fix missing; cannot narrow retry');
  if (action.kind === 'review') {
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
    if (parsed.verdict === 'pass') { record('done', 'review pass'); return executeNextAction({ ...action, kind: 'land', history: [...(action.history ?? []), 'review pass'] }, deps); }
    if (parsed.verdict === 'fail' && Array.isArray(parsed.mustFix) && parsed.mustFix.length > 0 && parsed.mustFix.every(fix => typeof fix === 'string' && fix.trim())) { record('done', 'review fail'); return executeNextAction({ ...action, kind: 'retry', mustFix: parsed.mustFix, history: [...(action.history ?? []), 'review fail'] }, deps); }
    return card('review verdict or must-fix unavailable');
  }
  // 여기 닿는 종류는 land · retry 둘뿐이다(green·decision·review 는 위에서 끝난다).
  const args = action.kind === 'land' ? ['pr', 'land', '--cwd', action.cwd!] : ['harness', 'say', retryText(action)];
  const day = deps.landingDay ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  const outcome = await deps.command(args);
  if (outcome.status !== 0) {
    if (action.kind === 'land') deps.releaseLanding?.(day);
    return record('failed', `${action.kind} command failed: ${outcome.stderr ?? ''}`);
  }
  if (action.kind === 'land') {
    const merged = await deps.command(['gh', 'pr', 'view', String(action.pr), '--json', 'state,mergeCommit']);
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

/** 재발사 문면 — 원문은 고치지 않고 앞에 둔다 · 갈래 문면 · must-fix · 직전 런 순서. */
export function retryText(action: NextAction): string {
  const sections = [action.original];
  if (action.variant && action.variant !== 'wait') sections.push(RETRY_HINT[action.variant](action));
  if (action.mustFix?.length) sections.push(`Must-fix:\n${action.mustFix.join('\n')}`);
  sections.push(`Previous run: ${action.runId}`);
  return sections.join('\n\n');
}
