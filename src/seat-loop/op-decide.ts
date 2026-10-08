// OP-LOOP-DECIDE — the OP seat loop filters open decision cards instead of a Claude OP session doing it by hand.
// Delegation = 대표 10-06 COO card filtering rule (feedback_coo_filters_decision_cards) ⊕ 10-07 scope-card default b.
// Config `loops.seat.opDecide.mode` = shadow (default · record only) | live (decide / route).
import { debug } from '../debug/log.js';
import type { DecisionEntry, DecisionLedger } from '../decisions/decision-ledger.js';
import type { SeatId } from '../seat-dispatch/seat-questions.js';
import { releasePathHold } from '../self-dev/release-path-guard.js';

export type OpDecideMode = 'shadow' | 'live';
export type OpDecideRule = 'repeat-stop' | 'scope-expand' | 'scope-sensitive' | 'scope-release-path' | 'scope-unknown' | 'run-blocking' | 'forbidden';
export type OpDecideVerdict =
  | { verdict: 'auto'; rule: OpDecideRule; choice: string; reason: string }
  | { verdict: 'route'; rule: OpDecideRule; to: SeatId | 'CEO'; reason: string };
export type OpDecideCandidate = { kind: 'decision-filter'; id: string; mode: OpDecideMode } & OpDecideVerdict;

export const OP_DECIDE_AGENT = 'seat-loop:OP';
export const OP_DECIDE_DELEGATION = '대표 10-06 COO 카드 거르기 규칙 · 10-07 범위 카드 기본 b(돈·보안·비밀·공개 경로만 유지)';

/** Categories that must reach the CEO whatever the recommendation says (rule 3). */
const FORBIDDEN_CATEGORIES: ReadonlySet<DecisionEntry['category']> = new Set(['money', 'security', 'secret', 'publish']);
const FORBIDDEN_WORDS = /특허|patent|외부\s*계약|계약서|contract/i;

/** Path segments that keep a scope card open — money · security · secret · public (rule 2 exception). */
const SENSITIVE_PATH: ReadonlyArray<{ kind: 'money' | 'security' | 'secret' | 'public'; pattern: RegExp }> = [
  { kind: 'secret', pattern: /(^|[/._-])(secrets?|credentials?|\.env|keychain|apns|backup-key)([/._-]|$)|\.(pem|p8|p12|key)$/i },
  { kind: 'security', pattern: /(^|[/._-])(auth|oauth|security|sandbox|permissions?|acl|csp|tokens?|crypto)([/._-]|$)/i },
  { kind: 'money', pattern: /(^|[/._-])(money|finance|billing|payments?|payouts?|refunds?|revenue|pricing|stripe|invoices?|checkout|wallet|trad(e|ing)|broker|budget|quota)([/._-]|$)/i },
  { kind: 'public', pattern: /(^|\/)(README|CHANGELOG|LICENSE|NOTICE)(\.[a-z]+)?$|(^|[/._-])(publish|public|homepage|site|npm)([/._-]|$)|^\.github\/workflows\/|^scripts\/release-loop\/release-publish/i },
];

export function sensitivePathKind(file: string): 'money' | 'security' | 'secret' | 'public' | undefined {
  return SENSITIVE_PATH.find(({ pattern }) => pattern.test(file))?.kind;
}

const SCOPE_QUESTION = /outside the authored target paths/i;

/** Outside-file names listed on a harness scope card; undefined when the card carries no complete list. */
export function scopeOutsideFiles(card: Pick<DecisionEntry, 'pendingQuestion'>): string[] | undefined {
  const text = card.pendingQuestion ?? '';
  const at = text.indexOf('Outside files:');
  if (at < 0) return undefined;
  // «… N more outside file(s) not shown» anywhere after the list header — a hidden file cannot be vetted.
  if (/more outside file/i.test(text.slice(at))) return undefined;
  const lines = text.slice(at + 'Outside files:'.length).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const files: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('- ')) break;
    // «… N more outside file(s) not shown» — a hidden file cannot be vetted.
    if (/more outside file/i.test(line)) return undefined;
    const name = line.slice(2).replace(/\s+\(declared-path sibling test: [a-z]+\)$/, '').trim();
    if (name) files.push(name);
  }
  return files.length ? files : undefined;
}

function optionKey(card: DecisionEntry, label: RegExp): string | undefined {
  return card.options.find((option) => label.test(option.label))?.key;
}

export function isRepeatStopCard(card: DecisionEntry): boolean {
  return card.raisedBy.agent === 'seat-loop' && / 반복 착지 0$/.test(card.title);
}

export function isScopeCard(card: DecisionEntry): boolean {
  return card.raisedBy.agent === 'harness' && (card.category === 'scope' || card.category === 'irreversible')
    && SCOPE_QUESTION.test(`${card.title}\n${card.pendingQuestion ?? ''}`) && !!card.resume;
}

/** Judge one open card. undefined = not this filter's card (left alone). */
export function judgeOpDecision(card: DecisionEntry, runOwner: (runId: string) => SeatId | undefined = () => undefined): OpDecideVerdict | undefined {
  if (card.status !== 'open') return undefined;
  const repeat = isRepeatStopCard(card);
  const scope = isScopeCard(card);
  const runId = card.resume?.runId;
  if (!repeat && !scope && !runId) return undefined;
  if (FORBIDDEN_CATEGORIES.has(card.category) || FORBIDDEN_WORDS.test(`${card.title}\n${card.scqa.s}`)) {
    return { verdict: 'route', rule: 'forbidden', to: 'CEO', reason: `${card.category} 범주·금지 낱말 — 자동 결정 금지, 대표 카드로 남김` };
  }
  if (repeat) {
    const stop = optionKey(card, /^멈춘다$/);
    const recommended = 'option' in card.recommendation ? card.recommendation.option : undefined;
    if (stop && recommended === stop) {
      return { verdict: 'auto', rule: 'repeat-stop', choice: stop, reason: `반복 착지 0 — 권고 ${stop}(멈춘다) · 그냥 둔 것과 같은 결과` };
    }
    return { verdict: 'route', rule: 'repeat-stop', to: 'CEO', reason: '반복 정지 카드인데 권고가 «멈춘다»가 아님 — 확신 없음' };
  }
  if (scope) {
    const expand = optionKey(card, /^Expand scope$/i);
    const files = scopeOutsideFiles(card);
    const owner = runId ? runOwner(runId) : undefined;
    const route = (rule: OpDecideRule, reason: string): OpDecideVerdict =>
      ({ verdict: 'route', rule, to: owner && owner !== 'OP' ? owner : 'CEO', reason });
    if (!expand) return route('scope-unknown', '범위 카드에 «Expand scope» 선택지가 없음');
    if (!files) return route('scope-unknown', '바깥 파일 목록이 없거나 일부만 보임 — 경로를 확인 못 함');
    const sensitive = files.map((file) => ({ file, kind: sensitivePathKind(file) })).filter((row) => row.kind);
    if (sensitive.length) {
      return { verdict: 'route', rule: 'scope-sensitive', to: 'CEO',
        reason: `바깥 파일 중 ${sensitive[0]!.kind} 경로(${sensitive[0]!.file}${sensitive.length > 1 ? ` 외 ${sensitive.length - 1}` : ''}) — 유지 여부는 대표 판단` };
    }
    // Release/gate paths follow the release-path SSOT (src/self-dev/release-path-guard.ts) — never auto-widen; TC owns the gate.
    // TODO(0.2.21 RELEASE-PATH-GUARD-GATE): src/task-orchestrator/surfaces/pod-command-job.ts and src/release-loop/gate-shards.ts
    //   are gate paths not yet in RELEASE_PATH_PREFIXES; they become covered here once that list grows.
    const release = releasePathHold(files);
    if (release) {
      return { verdict: 'route', rule: 'scope-release-path', to: 'TC',
        reason: `바깥 파일 중 발행·게이트 경로(${release}) — 게이트 주인 TC 판단` };
    }
    return { verdict: 'auto', rule: 'scope-expand', choice: expand,
      reason: `범위 넓힘 b — 바깥 ${files.length}개 모두 돈·보안·비밀·공개 경로 아님 · 게이트·리뷰가 가린다` };
  }
  const owner = runOwner(runId!);
  return { verdict: 'route', rule: 'run-blocking', to: owner && owner !== 'OP' ? owner : 'CEO',
    reason: owner && owner !== 'OP' ? `런 ${runId} 을 막는 카드 — 런 주인 ${owner} 자리로` : `런 ${runId} 을 막는 카드 — 주인 자리 모름, 대표 카드로 남김` };
}

export type OpDecideDeps = {
  mode: OpDecideMode;
  ledger: Pick<DecisionLedger, 'list' | 'decide'>;
  runOwner?: (runId: string) => SeatId | undefined;
  /** Route a run-blocking card to its owner seat (live only); returns false when delivery failed. */
  routeToSeat?: (to: SeatId, card: DecisionEntry, reason: string) => boolean;
  /** Candidates already recorded for this card (dedup across ticks). */
  recorded?: (id: string) => readonly OpDecideCandidate[];
  record: (candidate: OpDecideCandidate) => void;
};

/** One filtering pass over open cards. Never throws for a single card; returns what it recorded. */
export function runOpDecide(deps: OpDecideDeps): OpDecideCandidate[] {
  const out: OpDecideCandidate[] = [];
  let cards: DecisionEntry[];
  try { cards = deps.ledger.list({ status: 'open' }); }
  catch (error) {
    observeOpDecide({ event: 'ledger-unreadable', error: String(error).slice(0, 200) });
    return out;
  }
  for (const card of cards) {
    let judged: OpDecideVerdict | undefined;
    try { judged = judgeOpDecision(card, deps.runOwner); }
    catch (error) {
      observeOpDecide({ event: 'judge-failed', id: card.id, error: String(error).slice(0, 200) });
      continue;
    }
    if (!judged) continue;
    const candidate: OpDecideCandidate = { kind: 'decision-filter', id: card.id, mode: deps.mode, ...judged };
    const same = (row: OpDecideCandidate) => row.mode === candidate.mode && row.verdict === candidate.verdict && row.rule === candidate.rule
      && ('to' in row ? row.to : row.choice) === ('to' in candidate ? candidate.to : candidate.choice);
    if ((deps.recorded?.(card.id) ?? []).some(same)) continue;
    if (deps.mode === 'live' && candidate.verdict === 'auto') {
      try {
        deps.ledger.decide(card.id, candidate.choice,
          { kind: 'auto', agent: OP_DECIDE_AGENT, track: 'OP', delegation: OP_DECIDE_DELEGATION }, candidate.reason);
      } catch (error) {
        observeOpDecide({ event: 'decide-failed', id: card.id, rule: candidate.rule, error: String(error).slice(0, 200) });
        continue;
      }
    }
    if (deps.mode === 'live' && candidate.verdict === 'route' && candidate.to !== 'CEO' && deps.routeToSeat) {
      let delivered = false;
      try { delivered = deps.routeToSeat(candidate.to, card, candidate.reason); }
      catch (error) { observeOpDecide({ event: 'route-failed', id: card.id, to: candidate.to, error: String(error).slice(0, 200) }); }
      if (!delivered) continue;
    }
    deps.record(candidate);
    out.push(candidate);
    observeOpDecide({ event: 'op-decide', id: card.id, mode: candidate.mode, verdict: candidate.verdict, rule: candidate.rule,
      ...(candidate.verdict === 'auto' ? { choice: candidate.choice } : { to: candidate.to }), category: card.category, reason: candidate.reason });
  }
  return out;
}

function observeOpDecide(data: Record<string, unknown>): void {
  try { debug.log('seat.loop', 'op-decide', data); } catch { /* observation cannot change a decision */ }
}
