// 두 대표 합의 체제 시험 — 칸 판정선: 합의 원장 한 주 N건(집계 기전만) · 대표 카드는 불합의·임계 범주만 · 2왕복 상한 · 제안 카드 필드.

import { describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import {
  CROWN_MARK, CROWN_THRESHOLD_CATEGORIES, CONSENSUS_CATEGORIES, ConsensusEngine, MAX_REVIEW_ROUND_TRIPS,
  categoryLabel, representativeLabel, type ConsensusCategory, type ConsensusOptions, type ConsensusRepresentative, type ProposalCard,
} from './consensus.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { registerDecisionsCommands } from '../cli/decisions-cli.js';
import { runOrchestratorNode, type TickDeps } from './orchestrator/tick.js';
import { splitCard } from '../flow-loop/split.js';
import { CardStore } from '../task-cards/card-store.js';

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

describe('DUAL-ROOT-CONSENSUS — CLI 제안·응답과 tick 실행 전 관문', () => {
  test('실제 splitter의 교차 영향 작업은 CLI의 작업 키와 같은 제안 ID로 연결되고 불합의면 배치·위임·실행 0', async () => {
    const root = stateRoot();
    const store = new CardStore(root);
    const cli = (...args: string[]) => {
      const child = spawnSync('bun', ['bin/elanous.mjs', `--test=${root}`, 'decisions', 'consensus', ...args, '--json'],
        { cwd: join(import.meta.dir, '..', '..'), encoding: 'utf8', timeout: 120_000 });
      expect(child.status, child.stderr).toBe(0);
      return JSON.parse(child.stdout.trim());
    };
    const observed: string[] = [];
    let placements = 0;
    let hands = 0;
    let turns = 0;
    try {
      const card = store.createCard({ goalId: 'wish:cross-1', title: '수호자 야간 작업' });
      store.appendSection(card.id, { key: 'intake:wish:cross-1', owner: 'steward', content: JSON.stringify({ kind: 'cross-branch-change', text: '[MK] 수호자 야간 작업' }) });
      const output = splitCard(store.getCard(card.id)!);
      expect(output).toMatchObject([{ id: `${card.id}-1`, title: '수호자 야간 작업', seat: 'MK', kind: 'cross-branch-change' }]);
      const workKey = `orch:${card.id}:${output[0]!.id}`;
      const observe: NonNullable<TickDeps['observe']> = (event, data) => {
        if (event === 'consensus-blocked') observed.push(data.reason);
      };
      const deps = { root, runId: 'real-split', window: '08' as const, mode: 'live' as const, now: new Date('2026-10-16T00:00:00Z'),
        split: splitCard, gridHosts: [], coordinatorInbox: () => ({ replied: 0, acknowledged: 0 }),
        placeCell: () => { placements++; return { version: '0.2.32' }; },
        handToTaskAgent: 'live' as const, handTask: async () => { hands++; throw new Error('unexpected hand'); },
        seatTurn: async () => { turns++; return { status: 'queued' }; },
        launchProcesses: () => ({ status: 'ok' as const, records: [] }),
        observe };
      await runOrchestratorNode('intake', deps);
      const missing = await runOrchestratorNode('split', deps);
      expect(missing.cells[0]?.consensusProposalId).toBeUndefined();
      await runOrchestratorNode('place', deps);
      expect(placements).toBe(0);
      const noIdDelegated = await runOrchestratorNode('delegate', deps);
      const noIdLaunched = await runOrchestratorNode('launch', deps);
      expect({ delegated: noIdDelegated.delegated, hands, turns, launched: noIdLaunched.launched?.length }).toEqual({ delegated: 0, hands: 0, turns: 0, launched: 0 });
      const proposed = cli('propose', '--by', 'coordinator', '--category', 'cross-branch-change', '--title', output[0]!.title,
        '--fact-id', 'obs-cross-real', '--cost', '야간 부하', '--undo', '작업 취소', '--work-key', workKey);
      expect(() => engine(root).propose({ ...proposeInput, category: 'cross-branch-change', workKey })).toThrow('already proposed');
      expect(() => engine(root).propose({ ...proposeInput, workKey })).toThrow('invalid cross-branch work key');
      const reviewed = cli('review', proposed.id, '--by', 'guardian', '--claim', '회복 근거 부족');
      const opposed = cli('disagree', proposed.id, '--by', 'guardian', '--claim', '회복 시간 침해');
      expect(reviewed.roundTrips).toBe(1);
      expect(opposed.proposal).toMatchObject({ id: proposed.id, roundTrips: 2, status: 'disagreed' });
      expect(opposed.crownCard).toMatchObject({ proposalId: proposed.id, guardianClaim: '회복 시간 침해' });
      expect(opposed.crownCard.coordinatorClaim).toContain('obs-cross-real');
      const linkedDeps = { ...deps, runId: 'linked-split', cards: () => [{ ...store.getCard(card.id)!, sections: store.getCard(card.id)!.sections.filter(section => section.key !== 'orch:split') }] };
      await runOrchestratorNode('intake', linkedDeps);
      const linked = await runOrchestratorNode('split', linkedDeps);
      expect(linked.cells[0]?.consensusProposalId).toBe(proposed.id);
      const linkedPath = join(root, 'loop', 'orchestrator', 'linked-split.json');
      linked.cells[0]!.consensusProposalId = 'C-wrong';
      writeFileSync(linkedPath, JSON.stringify(linked));
      await runOrchestratorNode('place', linkedDeps);
      expect(placements).toBe(0);
      linked.cells[0]!.consensusProposalId = proposed.id;
      delete linked.nodes.place;
      writeFileSync(linkedPath, JSON.stringify(linked));
      await runOrchestratorNode('place', linkedDeps);
      const state = await runOrchestratorNode('delegate', linkedDeps);
      expect(state.cells[0]?.consensusProposalId).toBe(proposed.id);
      const launched = await runOrchestratorNode('launch', linkedDeps);
      expect({ placements, hands, turns, delegated: launched.delegated, launched: launched.launched?.length }).toEqual({ placements: 0, hands: 0, turns: 0, delegated: 0, launched: 0 });
      expect(observed).toEqual(['', '', 'C-wrong', proposed.id, proposed.id]);
      expect(existsSync(join(root, 'seat-requests', 'requests.jsonl'))).toBe(false);
      const raw = readFileSync(join(root, 'consensus', 'consensus.jsonl'), 'utf8').trim().split('\n');
      expect(raw.map(line => JSON.parse(line).type)).toEqual(['proposed', 'reviewed', 'reviewed', 'disagreed', 'crown-card']);
      console.info(`SPLITTER ${JSON.stringify(output)} WORK KEY ${workKey}`);
      console.info(`CLI PROPOSE ${JSON.stringify(proposed)}`);
      console.info(`CLI REVIEW ${JSON.stringify(reviewed)}`);
      console.info(`CLI RESPONSE ${JSON.stringify(opposed)}`);
      for (const line of raw) console.info(`CONSENSUS LEDGER ${line}`);
      console.info(`TICK ${JSON.stringify({ cell: state.cells[0], placements, hands, turns, delegated: launched.delegated, launched: launched.launched, blocked: observed })}`);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
  test('교차 영향 불합의는 두 왕복, 같은 ID의 양쪽 주장 한 카드, 실행 0건으로 남고 tick도 막는다', async () => {
    const stateDir = stateRoot();
    const lines: string[] = [];
    const executed: string[] = [];
    const program = new Command();
    registerDecisionsCommands(program, { stateDir, now: () => new Date('2026-10-16T00:00:00Z'), resolveVersion: noVersion },
      { log: line => { lines.push(line); } });
    const run = (...args: string[]) => { lines.length = 0; program.parse(['decisions', ...args], { from: 'user' }); return JSON.parse(lines[0]!); };
    try {
      const proposed = run('consensus', 'propose', '--by', 'coordinator', '--category', 'cross-branch-change',
        '--title', '수호자 가지에 야간 작업 배정', '--fact-id', 'obs-cross-1', '--cost', '야간 부하', '--undo', '배정 취소', '--json');
      const revised = run('consensus', 'review', proposed.id, '--by', 'guardian', '--claim', '야간 부하 근거 부족', '--json');
      expect(revised.roundTrips).toBe(1);
      const opposed = run('consensus', 'disagree', proposed.id, '--by', 'guardian', '--claim', '회복 시간 침해', '--json');
      expect(opposed.proposal).toMatchObject({ id: proposed.id, status: 'disagreed', roundTrips: 2 });
      expect(opposed.crownCard).toMatchObject({ proposalId: proposed.id, reason: 'disagreement', guardianClaim: '회복 시간 침해' });
      expect(opposed.crownCard.coordinatorClaim).toContain('obs-cross-1');
      expect(run('consensus', 'crown', '--json')).toEqual([opposed.crownCard]);
      expect(() => run('consensus', 'agree', proposed.id, '--by', 'guardian', '--json')).toThrow('결론났다');
      const ledger = readFileSync(join(stateDir, 'consensus', 'consensus.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(ledger.map(row => row.type)).toEqual(['proposed', 'reviewed', 'reviewed', 'disagreed', 'crown-card']);
      expect(ledger[0].proposal.id).toBe(proposed.id);
      expect(ledger[1].review.claim).toBe('야간 부하 근거 부족');
      expect(ledger[2].review.claim).toBe('회복 시간 침해');
      expect(ledger[3].proposalId).toBe(proposed.id);
      expect(ledger[4].card).toEqual(opposed.crownCard);
      const engineWithHook = engine(stateDir, { execute: proposal => { executed.push(proposal.id); } });
      expect(engineWithHook.canExecute(proposed.id)).toBe(false);
      const root = stateDir;
      const path = join(root, 'loop', 'orchestrator', 'consensus-run.json');
      mkdirSync(join(root, 'loop', 'orchestrator'), { recursive: true });
      writeFileSync(path, JSON.stringify({ runId: 'consensus-run', window: '08', mode: 'live', day: '2026-10-16', cards: [], skippedCards: [],
        cells: [{ cardId: 'card', id: 'cell', title: '야간 작업', origin: 'flow1a', seat: 'MK', consensusProposalId: proposed.id }],
        placed: 0, delegated: 0, wouldDelegate: 0, reconciled: { reached: 0, progressing: 0, blocked: 0, unknown: 0 },
        steps: [], nodes: { split: 'ok' }, missing: [] }));
      let placements = 0;
      const deps = { root, runId: 'consensus-run', window: '08' as const, mode: 'live' as const,
        now: new Date('2026-10-16T00:00:00Z'), gridHosts: [], placeCell: () => { placements++; return { version: '0.2.32' }; },
        loadAdapter: async () => undefined, coordinatorInbox: () => ({ replied: 0, acknowledged: 0 }) };
      await runOrchestratorNode('place', deps);
      await runOrchestratorNode('delegate', deps);
      expect(placements).toBe(0);
      expect((await runOrchestratorNode('launch', { ...deps, launchProcesses: () => ({ status: 'ok' as const, records: [] }),
        seatTurn: async () => { executed.push('seat-turn'); return { status: 'queued' }; } })).launched).toEqual([]);
      expect(executed).toEqual([]);
      expect(existsSync(join(root, 'seat-requests', 'requests.jsonl'))).toBe(false);
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  }, 30_000);

  test('tick은 동일한 합의 원장의 open·unknown을 막고 합의 후에만 배치·위임한다', async () => {
    const root = stateRoot();
    try {
      const consensus = engine(root);
      const proposal = consensus.propose({ ...proposeInput, category: 'cross-branch-change' });
      const statePath = join(root, 'loop', 'orchestrator', 'shared.json');
      mkdirSync(join(root, 'loop', 'orchestrator'), { recursive: true });
      const makeState = (id: string) => writeFileSync(statePath, JSON.stringify({ runId: 'shared', window: '08', mode: 'live', day: '2026-10-16', cards: [], skippedCards: [],
        cells: [{ cardId: 'card', id: 'cell', title: '공유 칸', origin: 'flow1a', seat: 'MK', consensusProposalId: id }],
        placed: 0, delegated: 0, wouldDelegate: 0, reconciled: { reached: 0, progressing: 0, blocked: 0, unknown: 0 },
        steps: [], nodes: { split: 'ok' }, missing: [] }));
      let placements = 0;
      const deps = { root, runId: 'shared', window: '08' as const, mode: 'live' as const, now: new Date('2026-10-16T00:00:00Z'),
        gridHosts: [], placeCell: () => { placements++; return { version: '0.2.32' }; },
        loadAdapter: async () => undefined, coordinatorInbox: () => ({ replied: 0, acknowledged: 0 }), handToTaskAgent: 'off' as const };
      makeState('C-unknown');
      await runOrchestratorNode('place', deps);
      expect(placements).toBe(0);
      makeState(proposal.id);
      await runOrchestratorNode('place', deps);
      expect(placements).toBe(0);
      expect(consensus.canExecute(proposal.id)).toBe(false);
      consensus.agree(proposal.id, { by: 'guardian', claim: '야간 작업 허용' });
      expect(consensus.canExecute(proposal.id)).toBe(true);
      makeState(proposal.id);
      const placed = await runOrchestratorNode('place', deps);
      expect(placements).toBe(1);
      expect(placed.cells[0]!.version).toBe('0.2.32');
      const delegated = await runOrchestratorNode('delegate', deps);
      expect(delegated.delegated).toBe(1);
      expect(readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8')).toContain(`orch:card:cell`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  test('실물 CLI stdout ↔ 격리 원장: 같은 교차 영향 ID의 제안·두 응답·불합의 카드·실행 0건', () => {
    const stateDir = stateRoot();
    const run = (...args: string[]) => {
      const child = spawnSync('bun', ['bin/elanous.mjs', `--test=${stateDir}`, 'decisions', 'consensus', ...args, '--json'],
        { cwd: join(import.meta.dir, '..', '..'), encoding: 'utf8', timeout: 120_000 });
      expect(child.status, child.stderr).toBe(0);
      return JSON.parse(child.stdout.trim());
    };
    try {
      const proposed = run('propose', '--by', 'coordinator', '--category', 'cross-branch-change', '--title', '수호자 야간 배정',
        '--fact-id', 'obs-live-cross', '--cost', '야간 부하', '--undo', '배정 철회');
      const revised = run('review', proposed.id, '--by', 'guardian', '--claim', '회복 시간 근거 요청');
      const response = run('disagree', proposed.id, '--by', 'guardian', '--claim', '야간 작업 반대');
      const cards = run('crown');
      const raw = readFileSync(join(stateDir, 'consensus', 'consensus.jsonl'), 'utf8').trim().split('\n');
      expect(revised).toMatchObject({ id: proposed.id, roundTrips: 1 });
      expect(response.proposal).toMatchObject({ id: proposed.id, roundTrips: 2, status: 'disagreed' });
      expect(cards).toEqual([response.crownCard]);
      expect(response.crownCard.coordinatorClaim).toBe('제안 수호자 야간 배정 — 사실 obs-live-cross · 비용 야간 부하 · 되돌리기 배정 철회');
      expect(response.crownCard).toMatchObject({ proposalId: proposed.id, guardianClaim: '야간 작업 반대' });
      expect(raw.map(line => JSON.parse(line).type)).toEqual(['proposed', 'reviewed', 'reviewed', 'disagreed', 'crown-card']);
      expect(raw.every(line => line.includes(proposed.id))).toBe(true);
      expect(raw.some(line => line.includes('"type":"agreed"'))).toBe(false);
      expect(new DecisionLedger({ stateDir, resolveVersion: noVersion }).show(response.crownCard.decisionId).status).toBe('open');
      console.info(`CLI PROPOSE ${JSON.stringify(proposed)}`);
      console.info(`CLI REVIEW ${JSON.stringify(revised)}`);
      console.info(`CLI RESPONSE ${JSON.stringify(response)}`);
      for (const line of raw) console.info(`CONSENSUS LEDGER ${line}`);
      console.info(`CROWN CARD ${JSON.stringify(cards[0])}`);
      console.info('EXECUTION 0 (no agreed event; decision remains open)');
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  }, 120_000);

  test('임계 합의는 결정 카드로만 가며 승인 전 훅 실행은 0건이다', () => {
    const stateDir = stateRoot();
    const executed: string[] = [];
    try {
      const consensus = engine(stateDir, { execute: proposal => { executed.push(proposal.id); } });
      const proposal = consensus.propose({ ...proposeInput, thresholds: ['money'] });
      const result = consensus.agree(proposal.id, { by: 'guardian', claim: '합의하되 비용 승인 필요' });
      expect(result.crownCard?.reason).toBe('threshold');
      expect(consensus.canExecute(proposal.id)).toBe(false);
      expect(executed).toEqual([]);
      expect(new DecisionLedger({ stateDir, resolveVersion: noVersion }).show(result.crownCard!.decisionId!).status).toBe('open');
      expect(readFileSync(consensus.ledgerPath, 'utf8')).not.toContain('"type":"disagreed"');
      expect(consensus.crownCards()).toHaveLength(1);
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
