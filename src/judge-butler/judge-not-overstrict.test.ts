// JUDGE-NOT-OVERSTRICT (11-28) — the doneCriterion gate of #40661 keeps its one legitimate power (refuse a must that the evidence
// contradicts, cited) and loses the rest (refuse on doubt). 대표 OPS-RULES §판정·증거 (11-22) «같은 head 영수 + focused exit 0 충분 ·
// 미재현 추론 = FU» ⊕ §33·§35 (11-21). Literal expectations (rule 11) · the LLM is the only fake.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyBoardRequirements, judgeLlmRoute, readJudgeLlmPolicy } from '../kit/requirement-judge/index.js';
import { assessCriterionForSign, citedMustGap, loadJudgingSignPolicy } from '../kit/requirement-judge/sign-decision.js';
import { simWorldScenarios } from '../ux-sim/sim-world/supervisors/judge-criterion.js';
import { simWorldScenarios as simScenes } from '../ux-sim/sim-world/supervisors/judge-sim-receipt.js';
import { assessSimEvidence, loadSimEvidencePolicy, scenesNamed, simSceneIndex } from '../kit/requirement-judge/sim-evidence.js';
import { receiptNameBindsPrHead } from '../land-graph/pr-binding.js';
import type { SimWorldScenarioContext } from '../ux-sim/sim-world/types.js';
import type { UserConfig } from '../user-config.js';

setDefaultTimeout(60_000);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (tag: string) => { const d = mkdtempSync(join(tmpdir(), `jno-${tag}-`)); dirs.push(d); return d; };
const policyFile = (yaml: string) => { const p = join(tmp('policy'), 'judging.yaml'); writeFileSync(p, yaml); return p; };

describe('judge LLM routing — explicit · ≥ terra class · never GLM', () => {
  const cfg = (provider: string) => ({ roleLlm: { audit: { provider } } }) as unknown as UserConfig;
  test('the shipped policy: role audit · tier better (min better) · reasoning medium', () => {
    expect(readJudgeLlmPolicy()).toEqual({ role: 'audit', tier: 'better', minTier: 'better', reasoning: 'medium', timeoutMs: 90000, forbid: ['glm', 'zai', 'z-ai', 'zhipu'] });
  });
  test('codex → gpt-6.1-terra (was: classify = budget = gpt-6-luna reasoning off)', () => {
    expect(judgeLlmRoute(readJudgeLlmPolicy(), cfg('openai-codex'))).toEqual({ ok: true, provider: 'openai-codex', model: 'gpt-6.1-terra', tier: 'better', reasoning: 'medium' });
  });
  test('GLM provider → refused before any call (→ the fallback, never a GLM judgment)', () => {
    expect(judgeLlmRoute(readJudgeLlmPolicy(), cfg('glm'))).toEqual({ ok: false, why: 'judge LLM routed to forbidden glm/glm-5.3 («glm» · 리뷰·판정 GLM 금지)' });
  });
  test('a policy asking for a lower tier is clamped to min_tier (openrouter balanced = z-ai/glm-5.3 never reached)', () => {
    const p = readJudgeLlmPolicy(policyFile('version: 1\njudge_llm:\n  role: audit\n  tier: balanced\n  min_tier: better\n  forbid: []\n'));
    expect(p.tier).toBe('better'); expect(p.forbid).toEqual(['glm', 'zai', 'z-ai', 'zhipu']); // the GLM ban cannot be dropped by data
    expect(judgeLlmRoute(p, cfg('openrouter'))).toEqual({ ok: true, provider: 'openrouter', model: 'openrouter/qwen/qwen3.8-max-0902', tier: 'better', reasoning: 'medium' });
    const glmOnOr = readJudgeLlmPolicy(policyFile('version: 1\njudge_llm:\n  role: audit\n  tier: balanced\n  min_tier: balanced\n'));
    expect(judgeLlmRoute(glmOnOr, cfg('openrouter'))).toEqual({ ok: false, why: 'judge LLM routed to forbidden openrouter/openrouter/z-ai/glm-5.3 («glm» · 리뷰·판정 GLM 금지)' });
  });
});

describe('sign decision — the kit (graphs/policies/judging.yaml)', () => {
  const ev = [{ id: 'PR-40436', text: '{"pr":40436,"files":["src/def/lint.ts"]}' }];
  const decompose = async () => ({ trusted: true as const, requirements: [{ id: 'R1', text: 'lint rejects unknown keys with file:line', classification: 'must' as const }, { id: 'R2', text: 'pretty colours', classification: 'edge' as const }] });
  const judgeWith = (rows: unknown[]) => (input: Parameters<typeof classifyBoardRequirements>[0]) => classifyBoardRequirements(input, { callLLM: async () => JSON.stringify({ requirements: rows }) });
  test('the refusal bar: gap contradicted ⊕ verbatim clause ⊕ a real evidence id', () => {
    const req = { id: 'R1', text: 'lint rejects unknown keys with file:line' };
    const row = { id: 'R1', classification: 'must' as const, fulfilled: false, evidenceIds: ['PR-40436'], reason: 'r', gap: 'contradicted' as const, clause: 'rejects unknown keys' };
    expect(citedMustGap(row, req, ev)).toBe(true);
    expect(citedMustGap({ ...row, gap: 'not-shown' }, req, ev)).toBe(false);
    expect(citedMustGap({ ...row, clause: 'rejects unknown hosts' }, req, ev)).toBe(false);
    expect(citedMustGap({ ...row, evidenceIds: [] }, req, ev)).toBe(false);
    expect(citedMustGap({ ...row, evidenceIds: ['PR-1'] }, req, ev)).toBe(false);
    expect(citedMustGap({ ...row, classification: 'edge' }, req, ev)).toBe(false);
  });
  test('cited contradiction → refuse (the #40661 power kept)', async () => {
    const d = await assessCriterionForSign({ cellId: 'YAML-DEF-LOADER', criterion: 'x', evidence: ev }, { decompose, judge: judgeWith([
      { id: 'R1', classification: 'must', fulfilled: false, evidenceIds: ['PR-40436'], reason: 'files show only docs', gap: 'contradicted', clause: 'rejects unknown keys' },
      { id: 'R2', classification: 'edge', fulfilled: false, evidenceIds: [], reason: 'n/a', gap: 'not-shown', clause: '' }]) });
    expect(d).toEqual({ sign: false, why: '필수 미충족 — «rejects unknown keys» · 반대 근거 PR-40436: files show only docs', cited: [{ clause: 'rejects unknown keys', evidenceIds: ['PR-40436'], reason: 'files show only docs' }] });
  });
  test('trusted split, must met → sign · each unmet edge = its own «<cell>-FU-<hash>»', async () => {
    const d = await assessCriterionForSign({ cellId: 'C9', criterion: 'x', evidence: ev }, { decompose, judge: judgeWith([
      { id: 'R1', classification: 'must', fulfilled: true, evidenceIds: ['PR-40436'], reason: 'ok', gap: 'none', clause: '' },
      { id: 'R2', classification: 'edge', fulfilled: false, evidenceIds: [], reason: 'n/a', gap: 'not-shown', clause: '' }]) });
    expect(d).toEqual({ sign: true, basis: 'criterion', policyVersion: '1', note: 'doneCriterion 필수 1 충족 · 엣지 FU 1', semantic: 'doneCriterion policy 1: R1=PR-40436',
      followUps: [{ id: 'C9-FU-25CEA72C', title: 'C9 — pretty colours', reason: 'edge', mode: 'cell' }] });
  });
  test('YAML decides: fallback «refuse» for a kind makes that doubt a refusal again (no TS change)', async () => {
    const strict = loadJudgingSignPolicy(policyFile('version: 1\nfallback:\n  empty_criterion: refuse\n'));
    expect({ cap: strict.followUp.maxNewPerTick, fold: strict.followUp.foldIntoE4 }).toEqual({ cap: 3, fold: ['must_unmet_uncited', 'decomposition_uncertain'] }); // defaults when the YAML omits them
    expect(loadJudgingSignPolicy().followUp.maxNewPerTick).toBe(3); // the shipped judging.yaml
    expect(strict.fallback).toEqual({ empty_criterion: 'refuse', judge_unavailable: 'sign-with-fu', decomposition_uncertain: 'sign-with-fu', judgment_untrusted: 'sign-with-fu', must_unmet_uncited: 'sign-with-fu' });
    expect(await assessCriterionForSign({ cellId: 'C1', criterion: '', evidence: ev }, { decompose, judge: judgeWith([]), policy: strict })).toEqual({ sign: false, why: 'doneCriterion 비어 있음', cited: [] });
    expect(loadJudgingSignPolicy('/no/such/judging.yaml').fallback.decomposition_uncertain).toBe('sign-with-fu'); // unreadable policy = the 대표 rule
  });
});

describe('sim world — supervisors/JB-CRIT-* (5 seeds · legacy + graph)', () => {
  const ids = ['JB-CRIT-UNCERTAIN', 'JB-CRIT-LLM-DOWN', 'JB-CRIT-MUST-UNMET', 'JB-CRIT-EMPTY', 'JB-CRIT-RESIGN-NO-FU'];
  const ctxOf = (id: string, engine: 'legacy' | 'graph', events: Array<{ kind: string; data: unknown }>): SimWorldScenarioContext => ({
    world: 'supervisors', scenarioId: id, seed: 1, engine, universeRoot: tmp(`${id}-${engine}`),
    recorder: { event: (kind: string, data: unknown) => { events.push({ kind, data }); } },
    random: () => 0.5, device: () => { throw new Error('no device'); },
  }) as unknown as SimWorldScenarioContext;
  test('scenes registered', () => { expect(simWorldScenarios.map(s => s.id)).toEqual(ids); });
  for (const id of ids) for (const engine of ['legacy', 'graph'] as const) {
    test(`${id} · ${engine}`, async () => {
      const events: Array<{ kind: string; data: unknown }> = [];
      expect(await simWorldScenarios.find(s => s.id === id)!.run(ctxOf(id, engine, events))).toEqual({ ok: true });
      expect(events.filter(e => e.kind === 'judge-criterion:scene').length).toBe(1);
      expect(events.filter(e => e.kind.startsWith('judge-criterion:') && e.kind !== 'judge-criterion:scene').length).toBe(5);
    });
  }
});

// JUDGE-SIM-RECEIPT (대표 11-28 15:2x «시뮬레이션 및 우주 합성 이벤트도 초록의 조건으로»)
describe('sim / synthetic-event receipts — the kit (judging.yaml sim_evidence)', () => {
  const H = 'ab'.repeat(20);
  const rec = (scenario: string, engine: 'legacy' | 'graph', seed: number, verdict = 'pass') => ({ world: 'supervisors', scenario, engine, seed, expected: 'green', actual: 'pass', verdict, diffFirstLine: null, observedReason: null, dir: 'd', wallMs: 1 });
  const all = (scenario: string) => [1, 2, 3, 4, 5].map(seed => ({ runId: `40700-${H.slice(0, 12)}-s${seed}`, summary: { scenarios: [rec(scenario, 'legacy', seed), rec(scenario, 'graph', seed)] } })) as never;
  const index = new Map([['JB-CRIT-EMPTY', 'supervisors'], ['JB-DECLARED', 'supervisors']]);
  test('the shipped policy', () => {
    expect(loadSimEvidencePolicy()).toEqual({ roots: ['~/.elanous-test', '~/elanous-hq/repo.git/.elanous-test', '~/elanous-hq/seat-state/RES/evidence/SIM-WORLD'], runIdBinding: '{pr}-{head12}', minSeeds: 5,
      engines: ['legacy', 'graph'], passVerdicts: ['pass', 'promoted'], markers: ['시뮬', '시험 우주', '합성 사건', '합성 이벤트', '합성 주입', 'sim world', 'synthetic event'],
      request: { scene: 'eln --test sim world run {world} --seed {seed} --engine both --only {scene} --run-id {pr}-{head12}-s{seed}-{scene}', e4: 'eln release checklist evidence run {cell}' },
      publish: { root: loadSimEvidencePolicy().roots.at(-1) ?? null, host: 'hq' } });
  });
  test('receipt name ↔ PR head (pr-binding kit)', () => {
    expect(receiptNameBindsPrHead(`40700-${H.slice(0, 12)}-s1`, 40700, H)).toBe(true);
    expect(receiptNameBindsPrHead(`40700-${H.slice(0, 12)}`, 40700, H)).toBe(true);
    expect(receiptNameBindsPrHead(`407001-${H.slice(0, 12)}-s1`, 40700, H)).toBe(false);
    expect(receiptNameBindsPrHead(`40700-${'cd'.repeat(6)}-s1`, 40700, H)).toBe(false);
    expect(receiptNameBindsPrHead(`40700-${H.slice(0, 12)}-s1`, 40700, null)).toBe(false);
  });
  test('scene ids are registry tokens, not substrings', () => {
    expect(scenesNamed('JB-CRIT-EMPTY · JB-DECLARED-X · xJB-DECLARED', index)).toEqual(['JB-CRIT-EMPTY']);
    expect(simSceneIndex().get('JB-CRIT-EMPTY')).toBe('supervisors'); // the real packs
  });
  const prs = [{ pr: 40700, head: H, scenes: [] }];
  test('named scene: met · regression · missing · request line', () => {
    expect(assessSimEvidence({ cellId: 'C', criterion: 'JB-CRIT-EMPTY green', e4Line: null, prs }, { summaries: all('JB-CRIT-EMPTY'), index }))
      .toEqual({ need: 'met', note: 'sim JB-CRIT-EMPTY 시드 5·graph+legacy·regression 0', rows: [{ id: 'SIM-JB-CRIT-EMPTY', text: JSON.stringify({ scene: 'JB-CRIT-EMPTY', world: 'supervisors', seeds: [1, 2, 3, 4, 5], engines: ['graph', 'legacy'], regression: 0,
        runs: [1, 2, 3, 4, 5].map(s => `40700-${H.slice(0, 12)}-s${s}`) }) }] });
    expect(assessSimEvidence({ cellId: 'C', criterion: 'JB-CRIT-EMPTY green', e4Line: null, prs }, { summaries: all('JB-DECLARED'), index })).toEqual({ need: 'missing',
      why: '시뮬 영수 미충족 — 장면 JB-CRIT-EMPTY 영수 없음(같은 PR head 의 sim world summary)', request: `eln --test sim world run supervisors --seed 1..5 --engine both --only JB-CRIT-EMPTY --run-id 40700-${H.slice(0, 12)}-s1..5-JB-CRIT-EMPTY`,
      runs: { pr: 40700, head: H, scenes: [{ world: 'supervisors', scene: 'JB-CRIT-EMPTY' }] } });
  });
  test('marker criterion without scene: E4 line or not green · plain criterion: none', () => {
    expect(assessSimEvidence({ cellId: 'C', criterion: '합성 이벤트 주입 시 1회', e4Line: null, prs }, { summaries: [], index })).toEqual({ need: 'missing',
      why: '완료조건이 시뮬/합성 사건 꼴(«합성 이벤트») — 같은 칸 E4 실행 영수 또는 장면 id 를 적은 sim world 영수 없음', request: 'eln release checklist evidence run C' });
    expect(assessSimEvidence({ cellId: 'C', criterion: '합성 이벤트 주입 시 1회', e4Line: 'E4 test 층 — runId r9 · 칸 C · rc 0', prs }, { summaries: [], index }))
      .toEqual({ need: 'met', note: 'E4 합성 사건 영수 (r9 rc 0)', rows: [{ id: 'E4-RUN', text: 'E4 test 층 — runId r9 · 칸 C · rc 0' }] });
    expect(assessSimEvidence({ cellId: 'C', criterion: 'lint rejects unknown keys', e4Line: null, prs }, { summaries: all('JB-CRIT-EMPTY'), index })).toEqual({ need: 'none' });
  });
});

describe('sim world — supervisors/JB-SIM-* (5 seeds · legacy + graph)', () => {
  const ids = ['JB-SIM-GREEN', 'JB-SIM-SCENE-MISMATCH', 'JB-SIM-REGRESSION', 'JB-SIM-E4'];
  const ctxOf = (id: string, engine: 'legacy' | 'graph', events: Array<{ kind: string; data: unknown }>): SimWorldScenarioContext => ({
    world: 'supervisors', scenarioId: id, seed: 1, engine, universeRoot: tmp(`${id}-${engine}`),
    recorder: { event: (kind: string, data: unknown) => { events.push({ kind, data }); } },
    random: () => 0.5, device: () => { throw new Error('no device'); },
  }) as unknown as SimWorldScenarioContext;
  test('scenes registered', () => { expect(simScenes.map(s => s.id)).toEqual(ids); });
  for (const id of ids) for (const engine of ['legacy', 'graph'] as const) {
    test(`${id} · ${engine}`, async () => {
      const events: Array<{ kind: string; data: unknown }> = [];
      expect(await simScenes.find(s => s.id === id)!.run(ctxOf(id, engine, events))).toEqual({ ok: true });
      expect(events.filter(e => e.kind === 'judge-sim:scene').length).toBe(1);
      expect(events.filter(e => e.kind.startsWith('judge-sim:') && e.kind !== 'judge-sim:scene').length).toBe(5);
    });
  }
});
