// 두 대표 합의 체제 시험 — 칸 판정선: 합의 원장 한 주 N건(집계 기전만) · 대표 카드는 불합의·임계 범주만 · 2왕복 상한 · 제안 카드 필드.

import { describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  CROWN_MARK, CROWN_THRESHOLD_CATEGORIES, CONSENSUS_CATEGORIES, ConsensusEngine, MAX_REVIEW_ROUND_TRIPS,
  categoryLabel, representativeLabel, type ConsensusCategory, type ConsensusOptions, type ConsensusRepresentative, type ProposalCard,
} from './consensus.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { registerDecisionsCommands } from '../cli/decisions-cli.js';

const stateRoot = () => mkdtempSync(join(tmpdir(), 'consensus-'));
const noVersion = () => ({ released: null, dev: null, codename: null });
const engine = (stateDir: string, options: Partial<ConsensusOptions> = {}): ConsensusEngine =>
  new ConsensusEngine({ stateDir, resolveVersion: noVersion, ...options });
const proposeInput = {
  by: 'coordinator' as const,
  category: 'spawn-retire' as const,
  title: '야간 루프 스폰',
  factId: 'obs-1042',
  cost: '크레딧 5만',
  undo: 'crontab 제거로 즉시 철회',
};

describe('제안 카드 — 사실 id·비용·되돌리기', () => {
  test('제안 카드는 사실 id·비용·되돌리기·범주·제안자를 담는다', () => {
    const stateDir = stateRoot();
    try {
      const proposal = engine(stateDir).propose(proposeInput);
      expect(proposal.id).toMatch(/^C-\d{8}-01$/);
      expect(proposal.factId).toBe('obs-1042');
      expect(proposal.cost).toBe('크레딧 5만');
      expect(proposal.undo).toBe('crontab 제거로 즉시 철회');
      expect(proposal.category).toBe('spawn-retire');
      expect(categoryLabel(proposal.category)).toBe('①스폰·은퇴');
      expect(proposal.proposedBy).toBe('coordinator');
      expect(representativeLabel('coordinator')).toBe('조율자(일의 흐름)');
      expect(representativeLabel('guardian')).toBe('수호자(몸)');
      expect(proposal.status).toBe('open');
      expect(proposal.roundTrips).toBe(0);
      expect(proposal.reviews).toEqual([]);
      expect(proposal.thresholds).toEqual([]);
      expect(proposal.proposedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  test('다섯 범주를 받고 범주 밖·임계 밖·대표 밖 값은 거절한다', () => {
    const stateDir = stateRoot();
    try {
      expect(CONSENSUS_CATEGORIES).toHaveLength(5);
      expect(CROWN_THRESHOLD_CATEGORIES).toEqual(['money', 'security', 'irreversible']);
      const consensus = engine(stateDir);
      for (const category of CONSENSUS_CATEGORIES) {
        expect(consensus.propose({ ...proposeInput, category }).category).toBe(category);
      }
      expect(() => consensus.propose({ ...proposeInput, category: 'deploy' as ConsensusCategory })).toThrow('invalid consensus category');
      expect(() => consensus.propose({ ...proposeInput, thresholds: ['scope'] })).toThrow('invalid threshold');
      expect(consensus.propose({ ...proposeInput, thresholds: ['money', 'money'] }).thresholds).toEqual(['money']);
      expect(() => consensus.propose({ ...proposeInput, by: 'owner' as ConsensusRepresentative })).toThrow('invalid representative');
      expect(() => consensus.propose({ ...proposeInput, title: ' ' })).toThrow('title is required');
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });
});

describe('상대 검토 — 최대 2왕복', () => {
  test('두 번째 왕복은 결론으로 끝내야 하고 결론 뒤에는 검토가 없다', () => {
    const stateDir = stateRoot();
    try {
      const consensus = engine(stateDir);
      const proposal = consensus.propose(proposeInput);
      const first = consensus.review(proposal.id, { by: 'guardian', claim: '비용 산정 근거를 보강하라' });
      expect(first.roundTrips).toBe(1);
      expect(first.reviews[0]).toMatchObject({ by: 'guardian', verdict: 'revise', roundTrip: 1, claim: '비용 산정 근거를 보강하라' });
      expect(() => consensus.review(proposal.id, { by: 'guardian', claim: '한 번 더 본다' })).toThrow(`최대 ${MAX_REVIEW_ROUND_TRIPS}왕복`);
      const agreed = consensus.agree(proposal.id, { by: 'guardian', claim: '근거가 보강됐다' });
      expect(agreed.proposal.roundTrips).toBe(2);
      expect(agreed.proposal.status).toBe('agreed');
      expect(() => consensus.review(proposal.id, { by: 'guardian', claim: '다시' })).toThrow('결론');
      expect(() => consensus.agree(proposal.id, { by: 'guardian', claim: '다시' })).toThrow('결론');
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  test('제안자는 자기 제안을 검토하지 못한다 — 합의·불합의는 한 왕복으로도 즉시 가능', () => {
    const stateDir = stateRoot();
    try {
      const consensus = engine(stateDir);
      const byGuardian = consensus.propose({ ...proposeInput, by: 'guardian' });
      expect(() => consensus.review(byGuardian.id, { by: 'guardian', claim: '셀프 검토' })).toThrow('메아리');
      const agreed = consensus.agree(byGuardian.id, { by: 'coordinator' });
      expect(agreed.proposal.roundTrips).toBe(1);
      expect(agreed.proposal.status).toBe('agreed');
      expect(agreed.crownCard).toBeUndefined();
      const opposed = consensus.propose({ ...proposeInput, title: '예산 이관' });
      const disagreed = consensus.disagree(opposed.id, { by: 'guardian', claim: '야간 예산은 위험하다' });
      expect(disagreed.proposal.roundTrips).toBe(1);
      expect(disagreed.proposal.status).toBe('disagreed');
      expect(disagreed.crownCard.reason).toBe('disagreement');
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });
});

describe('합의 — 실행·원장 기록', () => {
  test('합의 시 실행 훅이 한 번 돌고 합의 원장(JSONL)에 agreed 이벤트가 남는다', () => {
    const stateDir = stateRoot();
    const executed: string[] = [];
    try {
      const consensus = engine(stateDir, { execute: (proposal: ProposalCard) => { executed.push(proposal.id); } });
      const proposal = consensus.propose(proposeInput);
      consensus.agree(proposal.id, { by: 'guardian', claim: '실행 동의' });
      expect(executed).toEqual([proposal.id]);
      const ledger = readFileSync(join(stateDir, 'consensus', 'consensus.jsonl'), 'utf8');
      expect(ledger).toContain('"type":"agreed"');
      expect(ledger).toContain('"agreedBy":"guardian"');
      expect(consensus.crownCards()).toEqual([]);
      expect(consensus.list()).toHaveLength(1);
      expect(consensus.show(proposal.id).reviews[0]!.verdict).toBe('agree');
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });
});

describe(`불합의 → 양쪽 주장 나란히 ${CROWN_MARK} 결정 카드`, () => {
  test(`불합의 시 ${CROWN_MARK} 카드에 양쪽 주장이 나란히 오르고 결정 원장에 미러된다`, () => {
    const stateDir = stateRoot();
    try {
      const consensus = engine(stateDir);
      const proposal = consensus.propose(proposeInput);
      const { crownCard } = consensus.disagree(proposal.id, { by: 'guardian', claim: '야간 예산이 몸에 무겁다' });
      expect(crownCard.id).toMatch(/^K-\d{8}-01$/);
      expect(crownCard.reason).toBe('disagreement');
      expect(crownCard.coordinatorClaim).toContain('야간 루프 스폰');
      expect(crownCard.coordinatorClaim).toContain('obs-1042');
      expect(crownCard.coordinatorClaim).toContain('크레딧 5만');
      expect(crownCard.guardianClaim).toBe('야간 예산이 몸에 무겁다');
      const decisions = new DecisionLedger({ stateDir, resolveVersion: noVersion }).list({ status: 'all' });
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ id: crownCard.decisionId, category: 'other', status: 'open' });
      expect(crownCard.decisionId).toMatch(/^D-\d{8}-01$/);
      expect(decisions[0]!.options.map(option => option.key)).toEqual(['a', 'b']);
      expect(decisions[0]!.options[0]).toMatchObject({ label: '조율자', consequence: crownCard.coordinatorClaim });
      expect(decisions[0]!.options[1]).toMatchObject({ label: '수호자', consequence: crownCard.guardianClaim });
      expect(consensus.crownCards().map(card => card.id)).toEqual([crownCard.id]);
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  test('수호자가 제안하면 주장 자리가 바뀌어도 나란히 오른다', () => {
    const stateDir = stateRoot();
    try {
      const consensus = engine(stateDir);
      const proposal = consensus.propose({ ...proposeInput, by: 'guardian' });
      const { crownCard } = consensus.disagree(proposal.id, { by: 'coordinator', claim: '흐름이 이미 가득하다' });
      expect(crownCard.guardianClaim).toContain('야간 루프 스폰');
      expect(crownCard.guardianClaim).toContain('obs-1042');
      expect(crownCard.coordinatorClaim).toBe('흐름이 이미 가득하다');
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  test(`합의+임계 범주도 ${CROWN_MARK} 카드를 만든다 — 결정 원장 범주는 그 임계`, () => {
    const stateDir = stateRoot();
    try {
      const consensus = engine(stateDir);
      const proposal = consensus.propose({ ...proposeInput, category: 'period-budget', thresholds: ['money'] });
      const agreed = consensus.agree(proposal.id, { by: 'guardian', claim: '예산 내에서라면 동의' });
      expect(agreed.crownCard?.reason).toBe('threshold');
      expect(agreed.crownCard?.thresholds).toEqual(['money']);
      const decisions = new DecisionLedger({ stateDir, resolveVersion: noVersion }).list({ status: 'all' });
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ id: agreed.crownCard!.decisionId, category: 'money' });
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  test(`${CROWN_MARK} 카드는 불합의·임계 범주에만 만들어진다`, () => {
    const stateDir = stateRoot();
    try {
      const consensus = engine(stateDir);
      const plain = consensus.propose(proposeInput);
      consensus.agree(plain.id, { by: 'guardian' });
      expect(consensus.crownCards()).toEqual([]);
      const revised = consensus.propose({ ...proposeInput, title: '왕복만 남은 제안' });
      consensus.review(revised.id, { by: 'guardian', claim: '왕복 기록' });
      expect(consensus.crownCards()).toEqual([]);
      const money = consensus.propose({ ...proposeInput, title: '유료 API', thresholds: ['money'] });
      consensus.agree(money.id, { by: 'guardian' });
      const clashed = consensus.propose({ ...proposeInput, title: '갈린 제안' });
      consensus.disagree(clashed.id, { by: 'guardian', claim: '반대' });
      const cards = consensus.crownCards();
      expect(cards).toHaveLength(2);
      expect(new Set(cards.map(card => card.reason))).toEqual(new Set(['threshold', 'disagreement']));
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });
});

describe('판정선 — 합의 원장 한 주 N건 (주 단위 집계 기전)', () => {
  test('agreed 이벤트를 ISO 주로 세고 불합의는 세지 않는다', () => {
    const stateDir = stateRoot();
    let at = new Date('2026-10-12T09:00:00Z');
    const consensus = engine(stateDir, { now: () => at });
    try {
      const monday = consensus.propose(proposeInput);
      consensus.agree(monday.id, { by: 'guardian' });
      at = new Date('2026-10-15T09:00:00Z');
      const thursday = consensus.propose({ ...proposeInput, title: '주 중 합의' });
      consensus.agree(thursday.id, { by: 'guardian' });
      const clashed = consensus.propose({ ...proposeInput, title: '주 중 불합의' });
      consensus.disagree(clashed.id, { by: 'guardian', claim: '반대' });
      at = new Date('2026-10-19T09:00:00Z');
      const nextMonday = consensus.propose({ ...proposeInput, title: '다음 주 합의' });
      consensus.agree(nextMonday.id, { by: 'guardian' });
      expect(consensus.weeklyAgreementCounts()).toEqual([
        { week: '2026-W42', count: 2 },
        { week: '2026-W43', count: 1 },
      ]);
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });
});

describe('메아리 방지 — 렌즈(입력 원장) 분리 ⊕ 다른 LLM 제공자', () => {
  test('제안·검토는 행위자의 렌즈에만 남고 제공자 표식을 찍는다', () => {
    const stateDir = stateRoot();
    try {
      const consensus = engine(stateDir, { providers: { coordinator: 'claude', guardian: 'codex' } });
      const proposal = consensus.propose({ ...proposeInput, provider: 'claude' });
      const coordinatorLens = readFileSync(consensus.lensPath('coordinator'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(coordinatorLens).toEqual([{ action: 'proposed', proposalId: proposal.id, at: proposal.proposedAt, provider: 'claude' }]);
      expect(existsSync(consensus.lensPath('guardian'))).toBe(false);
      consensus.review(proposal.id, { by: 'guardian', claim: '근거 보강 요청' });
      const guardianLens = readFileSync(consensus.lensPath('guardian'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(guardianLens).toHaveLength(1);
      expect(guardianLens[0]).toMatchObject({ action: 'reviewed', proposalId: proposal.id, verdict: 'revise', provider: 'codex' });
      expect(readFileSync(consensus.lensPath('coordinator'), 'utf8').trim().split('\n')).toHaveLength(1);
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });
});

describe('decisions CLI 연결 — consensus 하위 명령 (호출자: registerDecisionsCommands)', () => {
  test('propose/review/agree/disagree/crown 이 되고 기존 decisions 명령·원장은 그대로다', () => {
    const stateDir = stateRoot();
    const lines: string[] = [];
    const program = new Command();
    registerDecisionsCommands(program, { stateDir, now: () => new Date('2026-10-16T00:00:00Z'), resolveVersion: noVersion }, { log: (line: string) => { lines.push(line); } });
    const run = (...args: string[]) => { lines.length = 0; program.parse(['decisions', ...args], { from: 'user' }); return lines[0]!; };
    try {
      const proposal = JSON.parse(run('consensus', 'propose', '--by', 'coordinator', '--category', 'spawn-retire',
        '--title', '야간 루프 스폰', '--fact-id', 'obs-1042', '--cost', '크레딧 5만', '--undo', 'crontab 제거로 철회', '--json'));
      expect(proposal.id).toMatch(/^C-\d{8}-01$/);
      expect(proposal.factId).toBe('obs-1042');
      const reviewed = JSON.parse(run('consensus', 'review', proposal.id, '--by', 'guardian', '--claim', '근거 보강', '--json'));
      expect(reviewed.roundTrips).toBe(1);
      const agreed = JSON.parse(run('consensus', 'agree', proposal.id, '--by', 'guardian', '--json'));
      expect(agreed.proposal.status).toBe('agreed');
      expect(agreed.crownCard).toBeUndefined();
      expect(run('consensus', 'crown')).toBe(`${CROWN_MARK} 결정 카드 0건`);
      expect(run('list')).toBe('결정 0건');
      const opposed = JSON.parse(run('consensus', 'propose', '--by', 'guardian', '--category', 'period-budget',
        '--title', '예산 이관', '--fact-id', 'obs-1043', '--cost', '크레딧 10만', '--undo', '되돌림 불가', '--json'));
      const disagreed = JSON.parse(run('consensus', 'disagree', opposed.id, '--by', 'coordinator', '--claim', '흐름 예산이 이미 묶였다', '--json'));
      expect(disagreed.crownCard.decisionId).toMatch(/^D-\d{8}-01$/);
      const crownList = run('consensus', 'crown');
      expect(crownList).toContain('조율자 주장: 흐름 예산이 이미 묶였다');
      expect(crownList).toContain('수호자 주장: 제안 예산 이관');
      expect(run('list')).toContain(`${CROWN_MARK} 합의 불합의`);
      expect(() => run('consensus', 'agree', proposal.id, '--by', 'guardian', '--json')).toThrow('decisions: 합의가 이미 결론났다');
      expect(() => run('consensus', 'propose', '--by', 'owner', '--category', 'spawn-retire',
        '--title', 'x', '--fact-id', 'f', '--cost', 'c', '--undo', 'u', '--json')).toThrow('decisions: invalid representative');
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });
});
