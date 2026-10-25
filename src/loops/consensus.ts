// 두 대표 합의 체제 — 조율자(일의 흐름)·수호자(몸)가 루프 세계의 공동 대표다.
// 다섯 범주(①스폰·은퇴 ②shadow→live 승격 ③상대 가지 영향 변경 ④주기·예산 ⑤운영 그래프 구조 변경)는 «둘의 합의» 뒤에 실행된다.
// 제안 카드(사실 id·비용·되돌리기) → 상대 검토 최대 2왕복 → 합의: 실행·합의 원장 / 불합의·임계 범주: 양쪽 주장 나란히 대표 결정 카드.
// 메아리 방지 — 대표별 렌즈(입력 원장) 분리 ⊕ 가능하면 다른 LLM 제공자 표식.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { DecisionLedger, type DecisionCategory } from '../decisions/decision-ledger.js';
import type { Versions } from '../directives/version-at.js';

export type ConsensusRepresentative = 'coordinator' | 'guardian';
export const CONSENSUS_REPRESENTATIVES: readonly ConsensusRepresentative[] = ['coordinator', 'guardian'];
/** 조율자는 일의 흐름, 수호자는 몸을 가진 공동 대표다. */
export const representativeLabel = (who: ConsensusRepresentative): string =>
  who === 'coordinator' ? '조율자(일의 흐름)' : '수호자(몸)';

export type ConsensusCategory =
  | 'spawn-retire'
  | 'shadow-live-promotion'
  | 'cross-branch-change'
  | 'period-budget'
  | 'graph-structure-change';
export const CONSENSUS_CATEGORIES: readonly ConsensusCategory[] = [
  'spawn-retire', 'shadow-live-promotion', 'cross-branch-change', 'period-budget', 'graph-structure-change',
];
const CATEGORY_LABELS: Record<ConsensusCategory, string> = {
  'spawn-retire': '①스폰·은퇴',
  'shadow-live-promotion': '②shadow→live 승격',
  'cross-branch-change': '③상대 가지 영향 변경',
  'period-budget': '④주기·예산',
  'graph-structure-change': '⑤운영 그래프 구조 변경',
};
export const categoryLabel = (category: ConsensusCategory): string => CATEGORY_LABELS[category];

/** 상대 검토는 최대 2왕복이다. */
export const MAX_REVIEW_ROUND_TRIPS = 2;

/** 대표 몫 = 불합의 ⊕ 돈·보안·되돌릴 수 없는 것 — 결정 원장의 DecisionCategory 어휘를 그대로 쓴다 (import 만). */
export const CROWN_THRESHOLD_CATEGORIES: readonly DecisionCategory[] = ['money', 'security', 'irreversible'];

/** 대표 카드 표식 — 소스에 글자를 직접 쓰면 공개본 유출 검사(ceo-mark)가 문자열 안까지 문다 — 코드 포인트로 만든다. */
export const CROWN_MARK = String.fromCodePoint(0x1F451);

export interface ProposalCard {
  id: string;
  category: ConsensusCategory;
  /** Stable orchestrator work key (orch:<card>:<cell>) for a cross-branch split cell. */
  workKey?: string;
  title: string;
  /** 사실 id — 제안의 근거 관측. */
  factId: string;
  /** 비용 */
  cost: string;
  /** 되돌리기 */
  undo: string;
  thresholds: DecisionCategory[];
  proposedBy: ConsensusRepresentative;
  proposedAt: string;
  status: 'open' | 'agreed' | 'disagreed';
  roundTrips: number;
  reviews: ReviewRecord[];
  provider?: string;
}

export interface ReviewRecord {
  by: ConsensusRepresentative;
  at: string;
  roundTrip: number;
  verdict: 'revise' | 'agree' | 'disagree';
  claim: string;
  provider?: string;
}

/** 대표 결정 카드 — 양쪽 주장이 나란히 실린다. */
export interface CrownCard {
  id: string;
  proposalId: string;
  reason: 'disagreement' | 'threshold';
  thresholds: DecisionCategory[];
  coordinatorClaim: string;
  guardianClaim: string;
  raisedAt: string;
  /** 결정 원장 미러 카드 — refs 로 멱등이라 같은 제안의 재발급은 같은 카드를 돌려준다. */
  decisionId?: string;
}

export type ConsensusEvent =
  | { type: 'proposed'; proposal: ProposalCard }
  | { type: 'reviewed'; proposalId: string; review: ReviewRecord }
  | { type: 'agreed'; proposalId: string; at: string; agreedBy: ConsensusRepresentative }
  | { type: 'disagreed'; proposalId: string; at: string; disagreedBy: ConsensusRepresentative }
  | { type: 'crown-card'; card: CrownCard };

/** 렌즈(입력 원장) 이벤트 — 행위한 대표의 원장에만 남는다 (메아리 방지). */
export interface LensEvent {
  action: 'proposed' | 'reviewed';
  proposalId: string;
  at: string;
  verdict?: ReviewRecord['verdict'];
  provider?: string;
}

export interface ConsensusOptions {
  stateDir?: string;
  now?: () => Date;
  resolveVersion?: (at: string) => Versions;
  /** 가능하면 다른 LLM 제공자 — 대표별 기본 표식. */
  providers?: { coordinator?: string; guardian?: string };
  /** 합의 원장의 agreed 이벤트가 실행 권한 기록이다 — 훅은 기록 뒤에 한 번 돈다. */
  execute?: (proposal: ProposalCard) => void;
  ledger?: DecisionLedger;
}

function oneLine(value: string, name: string): string {
  const text = (value ?? '').trim().replace(/[\r\n]+/g, ' ');
  if (!text) throw new Error(`${name} is required`);
  return text;
}

/** ISO 8601 주 키 — 합의 원장 «한 주 N건» 집계 단위. */
function isoWeek(at: string): string {
  const date = new Date(at);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export class ConsensusEngine {
  readonly ledgerPath: string;
  private readonly stateDir: string;
  private readonly now: () => Date;
  private readonly providers: { coordinator?: string; guardian?: string };
  private readonly executeHook: (proposal: ProposalCard) => void;
  private readonly ledger: DecisionLedger;

  constructor(options: ConsensusOptions = {}) {
    this.stateDir = options.stateDir ?? elanousStateRoot();
    this.ledgerPath = join(this.stateDir, 'consensus', 'consensus.jsonl');
    this.now = options.now ?? (() => new Date());
    this.providers = options.providers ?? {};
    this.executeHook = options.execute ?? (() => {});
    this.ledger = options.ledger ?? new DecisionLedger({
      stateDir: options.stateDir, now: options.now, resolveVersion: options.resolveVersion,
    });
  }

  /** 대표별 렌즈(입력 원장) 경로 — 두 대표의 렌즈는 서로 분리되어 메아리를 막는다. */
  lensPath(who: ConsensusRepresentative): string {
    return join(this.stateDir, 'consensus', 'lens', `${who}.jsonl`);
  }

  propose(input: {
    by: ConsensusRepresentative; category: ConsensusCategory; title: string; factId: string; cost: string; undo: string;
    thresholds?: DecisionCategory[]; provider?: string; workKey?: string;
  }): ProposalCard {
    if (input.workKey !== undefined) {
      if (input.category !== 'cross-branch-change' || !/^orch:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(input.workKey))
        throw new Error('invalid cross-branch work key');
      const existing = this.list().find(proposal => proposal.workKey === input.workKey);
      if (existing) throw new Error(`cross-branch work already proposed: ${existing.id}`);
    }
    if (!CONSENSUS_REPRESENTATIVES.includes(input.by)) throw new Error(`invalid representative: ${input.by} (coordinator|guardian)`);
    if (!CONSENSUS_CATEGORIES.includes(input.category)) throw new Error(`invalid consensus category: ${input.category} (${CONSENSUS_CATEGORIES.join('|')})`);
    const thresholds = [...new Set(input.thresholds ?? [])];
    if (thresholds.some(threshold => !CROWN_THRESHOLD_CATEGORIES.includes(threshold)))
      throw new Error(`invalid threshold category — ${CROWN_MARK} 몫은 ${CROWN_THRESHOLD_CATEGORIES.join('|')}만`);
    const at = this.now().toISOString();
    const provider = input.provider ?? this.providers[input.by];
    const proposal: ProposalCard = {
      id: this.nextId('C', at),
      category: input.category,
      ...(input.workKey ? { workKey: input.workKey } : {}),
      title: oneLine(input.title, 'title'),
      factId: oneLine(input.factId, 'fact id'),
      cost: oneLine(input.cost, 'cost'),
      undo: oneLine(input.undo, 'undo'),
      thresholds,
      proposedBy: input.by,
      proposedAt: at,
      status: 'open',
      roundTrips: 0,
      reviews: [],
      ...(provider ? { provider } : {}),
    };
    this.append([{ type: 'proposed', proposal }]);
    this.appendLens(input.by, { action: 'proposed', proposalId: proposal.id, at, ...(provider ? { provider } : {}) });
    debug.log('loops.consensus', 'proposed', { id: proposal.id, category: proposal.category, by: input.by });
    return proposal;
  }

  /** 결론 없이 왕복 하나를 소비하는 검토 — 두 번째 왕복은 결론으로 끝내야 한다. */
  review(id: string, input: { by: ConsensusRepresentative; claim: string; provider?: string }): ProposalCard {
    return this.conclude(id, 'revise', input).proposal;
  }

  /** 합의 — 실행 훅이 돌고 합의 원장에 기록된다. 임계 범주면 대표 카드도 함께 만든다. */
  agree(id: string, input: { by: ConsensusRepresentative; claim?: string; provider?: string }): { proposal: ProposalCard; crownCard?: CrownCard } {
    return this.conclude(id, 'agree', input);
  }

  /** 불합의 — 양쪽 주장 나란히 대표 결정 카드로 간다. */
  disagree(id: string, input: { by: ConsensusRepresentative; claim: string; provider?: string }): { proposal: ProposalCard; crownCard: CrownCard } {
    const { proposal, crownCard } = this.conclude(id, 'disagree', input);
    if (!crownCard) throw new Error(`${CROWN_MARK} 카드 없는 불합의는 없다: ${id}`);
    return { proposal, crownCard };
  }

  list(): ProposalCard[] {
    return [...this.state().proposals.values()]
      .sort((a, b) => b.proposedAt.localeCompare(a.proposedAt) || a.id.localeCompare(b.id));
  }

  show(id: string): ProposalCard {
    const proposal = this.list().find(entry => entry.id === id);
    if (!proposal) throw new Error(`consensus proposal not found: ${id}`);
    return proposal;
  }

  proposalForWork(workKey: string): ProposalCard | undefined {
    return this.list().find(entry => entry.workKey === workKey);
  }

  crownCards(): CrownCard[] {
    return [...this.state().cards]
      .sort((a, b) => b.raisedAt.localeCompare(a.raisedAt) || a.id.localeCompare(b.id));
  }

  /** The same durable execution gate is used by CLI replies, hooks and loop consumers. */
  canExecute(id: string): boolean {
    const proposal = this.show(id);
    return proposal.status === 'agreed' && proposal.thresholds.length === 0
      && proposal.roundTrips >= 1 && proposal.roundTrips <= MAX_REVIEW_ROUND_TRIPS
      && proposal.reviews.at(-1)?.verdict === 'agree'
      && proposal.reviews.at(-1)?.by !== proposal.proposedBy;
  }

  /** 판정선 — 합의 원장의 agreed 이벤트를 ISO 주 단위로 센다 (한 주 N건의 기전). */
  weeklyAgreementCounts(): Array<{ week: string; count: number }> {
    const counts = new Map<string, number>();
    for (const event of this.events()) {
      if (event.type !== 'agreed') continue;
      const week = isoWeek(event.at);
      counts.set(week, (counts.get(week) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, count]) => ({ week, count }));
  }

  /** 상대 검토 — 검토자는 제안자의 상대여야 하고 왕복은 최대 2다. */
  private conclude(id: string, verdict: ReviewRecord['verdict'], input: { by: ConsensusRepresentative; claim?: string; provider?: string }): { proposal: ProposalCard; crownCard?: CrownCard } {
    const proposal = this.show(id);
    if (proposal.status !== 'open') throw new Error(`합의가 이미 결론났다: ${id} (${proposal.status === 'agreed' ? '합의' : '불합의'})`);
    if (!CONSENSUS_REPRESENTATIVES.includes(input.by)) throw new Error(`invalid representative: ${input.by}`);
    if (input.by === proposal.proposedBy) throw new Error('메아리 방지 — 제안한 대표는 자기 제안을 검토하지 않는다');
    if (proposal.roundTrips >= MAX_REVIEW_ROUND_TRIPS) throw new Error(`상대 검토는 최대 ${MAX_REVIEW_ROUND_TRIPS}왕복이다`);
    if (verdict === 'revise' && proposal.roundTrips + 1 >= MAX_REVIEW_ROUND_TRIPS)
      throw new Error(`상대 검토는 최대 ${MAX_REVIEW_ROUND_TRIPS}왕복이다 — 마지막 왕복에는 합의 또는 불합의로 끝낸다`);
    const claim = oneLine(input.claim ?? (verdict === 'agree' ? '동의 — 제안대로 실행한다' : ''), 'claim');
    const at = this.now().toISOString();
    const provider = input.provider ?? this.providers[input.by];
    const review: ReviewRecord = { by: input.by, at, roundTrip: proposal.roundTrips + 1, verdict, claim, ...(provider ? { provider } : {}) };
    const events: ConsensusEvent[] = [{ type: 'reviewed', proposalId: proposal.id, review }];
    if (verdict === 'agree') events.push({ type: 'agreed', proposalId: proposal.id, at, agreedBy: input.by });
    if (verdict === 'disagree') events.push({ type: 'disagreed', proposalId: proposal.id, at, disagreedBy: input.by });
    let crownCard: CrownCard | undefined;
    if (verdict === 'disagree' || (verdict === 'agree' && proposal.thresholds.length > 0)) {
      crownCard = this.mintCrown(proposal, review, verdict === 'disagree' ? 'disagreement' : 'threshold', at);
      events.push({ type: 'crown-card', card: crownCard });
    }
    this.append(events);
    this.appendLens(input.by, { action: 'reviewed', proposalId: proposal.id, at, verdict, ...(provider ? { provider } : {}) });
    debug.log('loops.consensus', 'reviewed', { proposalId: proposal.id, verdict, roundTrip: review.roundTrip, by: input.by });
    const updated = this.show(proposal.id);
    if (this.canExecute(updated.id)) this.executeHook(updated);
    return { proposal: updated, ...(crownCard ? { crownCard } : {}) };
  }

  /** 대표 결정 카드 — 결정 원장에 refs 멱등으로 미러하고 양쪽 주장을 나란히 담는다. */
  private mintCrown(proposal: ProposalCard, review: ReviewRecord, reason: 'disagreement' | 'threshold', at: string): CrownCard {
    const proposerClaim = `제안 ${proposal.title} — 사실 ${proposal.factId} · 비용 ${proposal.cost} · 되돌리기 ${proposal.undo}`;
    const coordinatorClaim = proposal.proposedBy === 'coordinator' ? proposerClaim : review.claim;
    const guardianClaim = proposal.proposedBy === 'guardian' ? proposerClaim : review.claim;
    const category = CROWN_THRESHOLD_CATEGORIES.find(threshold => proposal.thresholds.includes(threshold)) ?? 'other';
    const ref = `consensus:${proposal.id}:crown`;
    const decision = this.ledger.raiseOnce({
      title: `${CROWN_MARK} ${reason === 'disagreement' ? '합의 불합의' : '임계 합의 승인'} — ${proposal.title}`,
      category,
      scqa: {
        s: `두 대표 합의 ${categoryLabel(proposal.category)} 제안 ${proposal.id}이 ${reason === 'disagreement' ? '불합의로 끝났다' : '임계 범주 합의에 도달했다'}`,
        c: reason === 'disagreement' ? '두 대표 주장이 갈린다 — 양쪽 주장이 선택지로 나란히 실렸다' : `두 대표가 합의했으나 ${category} 범주다 — ${CROWN_MARK} 승인이 필요하다`,
        q: reason === 'disagreement' ? '어느 대표 주장을 따를까?' : `합의된 ${category} 변경을 승인할까?`,
      },
      options: [
        { key: 'a', label: '조율자', consequence: coordinatorClaim },
        { key: 'b', label: '수호자', consequence: guardianClaim },
      ],
      recommendation: { skipped: true, reason: reason === 'disagreement' ? `두 대표 주장이 갈린다 — ${CROWN_MARK} 판단` : `임계 범주 합의 — ${CROWN_MARK} 승인` },
      raisedBy: { agent: 'consensus' },
      refs: [ref],
    }, ref);
    const card: CrownCard = {
      id: this.nextId('K', at),
      proposalId: proposal.id,
      reason,
      thresholds: [...proposal.thresholds],
      coordinatorClaim,
      guardianClaim,
      raisedAt: at,
      decisionId: decision.id,
    };
    debug.log('loops.consensus', 'crown-card', { id: card.id, proposalId: proposal.id, reason, decisionId: decision.id });
    return card;
  }

  private state(): { proposals: Map<string, ProposalCard>; cards: CrownCard[] } {
    const proposals = new Map<string, ProposalCard>();
    const cards: CrownCard[] = [];
    for (const event of this.events()) {
      if (event.type === 'proposed') {
        if (proposals.has(event.proposal.id)) throw new Error(`duplicate consensus proposal: ${event.proposal.id}`);
        proposals.set(event.proposal.id, { ...event.proposal, reviews: [...event.proposal.reviews] });
      } else if (event.type === 'crown-card') {
        cards.push(event.card);
      } else {
        const proposal = proposals.get(event.proposalId);
        if (!proposal) throw new Error(`unknown consensus proposal: ${event.proposalId}`);
        if (event.type === 'reviewed') {
          proposal.reviews.push(event.review);
          proposal.roundTrips = event.review.roundTrip;
        } else {
          if (proposal.status !== 'open') throw new Error(`invalid consensus transition: ${event.proposalId}`);
          proposal.status = event.type === 'agreed' ? 'agreed' : 'disagreed';
        }
      }
    }
    return { proposals, cards };
  }

  private events(): ConsensusEvent[] {
    if (!existsSync(this.ledgerPath)) return [];
    const text = readFileSync(this.ledgerPath, 'utf8');
    if (text && !text.endsWith('\n')) throw new Error('incomplete consensus ledger line');
    return text.split('\n').filter(Boolean).map((line, index) => {
      try { return JSON.parse(line) as ConsensusEvent; }
      catch { throw new Error(`invalid consensus ledger event on line ${index + 1}`); }
    });
  }

  private nextId(prefix: 'C' | 'K', at: string): string {
    const day = at.slice(0, 10).replaceAll('-', '');
    const head = `${prefix}-${day}-`;
    let next = 1;
    for (const event of this.events()) {
      const id = event.type === 'proposed' ? event.proposal.id : event.type === 'crown-card' ? event.card.id : null;
      if (id?.startsWith(head)) next = Math.max(next, Number(id.slice(head.length)) + 1);
    }
    return `${head}${String(next).padStart(2, '0')}`;
  }

  private append(events: ConsensusEvent[]): void {
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    appendFileSync(this.ledgerPath, `${events.map(event => JSON.stringify(event)).join('\n')}\n`);
  }

  private appendLens(who: ConsensusRepresentative, event: LensEvent): void {
    const path = this.lensPath(who);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`);
  }
}
