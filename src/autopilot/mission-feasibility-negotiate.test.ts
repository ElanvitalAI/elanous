import { describe, it, expect, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as llm from '../llm.js';
import { debug } from '../debug/log.js';
import { setUserConfigOverlay } from '../user-config.js';
import {
  feasibilityBudget, parseScopeNegotiation, proposeScopeNegotiation, formatNegotiationCard, defaultJudge,
  type NegotiateInput,
} from './mission-feasibility-negotiate.js';

function input(p: Partial<NegotiateInput>): NegotiateInput {
  return { phaseTitle: '관측 품질 원인을 구별해 보존하라', phasePrompt: 'p', acceptance: ['freshness', '단위 정합'], diagnosis: '단위 결손을 abstain 처리 안 함·의미론 결함', ...p };
}

describe('feasibilityBudget (config-first)', () => {
  it('기본 2/2', () => {
    const b = feasibilityBudget();
    expect(b.maxStalls).toBeGreaterThanOrEqual(1);
    expect(b.maxReplans).toBeGreaterThanOrEqual(1);
  });
});

describe('parseScopeNegotiation (순수)', () => {
  it('scope_cut — 축소 acceptance + deferred', () => {
    const n = parseScopeNegotiation('{"rootCause":"품질검증 과다","kind":"scope_cut","narrowedAcceptance":["결손 시 abstain"],"deferred":"정밀 freshness 후속","rationale":"지금 닫을 계약"}');
    expect(n.kind).toBe('scope_cut');
    expect(n.narrowedAcceptance).toEqual(['결손 시 abstain']);
    expect(n.deferred).toContain('freshness');
    expect(n.needsHitl).toBe(true);
  });

  it('replan / 파싱 실패 → 보수적 replan', () => {
    expect(parseScopeNegotiation('{"kind":"replan","replanHint":"접근 교정"}').kind).toBe('replan');
    expect(parseScopeNegotiation('텍스트').kind).toBe('replan');
  });
});

describe('proposeScopeNegotiation (judge 주입·fail-soft)', () => {
  it('judge 주입 scope_cut', async () => {
    const n = await proposeScopeNegotiation(input({}), {
      judge: async () => '{"rootCause":"품질 의미론 과다","kind":"scope_cut","narrowedAcceptance":["결손=abstain"],"deferred":"정밀검증 후속","rationale":"achievable 축소"}',
    });
    expect(n.kind).toBe('scope_cut');
    expect(n.narrowedAcceptance).toContain('결손=abstain');
  });

  it('judge 오류 → fail-soft replan', async () => {
    const n = await proposeScopeNegotiation(input({}), { judge: async () => { throw new Error('down'); } });
    expect(n.kind).toBe('replan');
    expect(n.needsHitl).toBe(true);
  });

  it('역할 provider 해석 실패도 needsHitl 협상으로 끝난다', async () => {
    const saved = llm.PROVIDERS.gemini;
    try {
      setUserConfigOverlay(config => ({ ...config, roleLlm: { ...config.roleLlm, planning: { provider: 'gemini', model: 'planning-fixture' } } }));
      delete llm.PROVIDERS.gemini;
      const result = await proposeScopeNegotiation(input({}), { judge: defaultJudge });
      expect(result).toMatchObject({ kind: 'replan', needsHitl: true });
      expect(result.rationale).toContain('fail-soft');
    } finally { llm.PROVIDERS.gemini = saved!; setUserConfigOverlay(null); }
  });

  it('judge 미주입(test) → replan 폴백', async () => {
    const n = await proposeScopeNegotiation(input({}));
    expect(n.kind).toBe('replan');
  });
});

describe('defaultJudge role pin', () => {
  it('기본 하드코딩 모델 없이 planning overlay 를 쓰고 env 가 우선한다', async () => {
    const oldNegotiate = process.env.ELANOUS_NEGOTIATE_MODEL;
    const oldDecompose = process.env.ELANOUS_DECOMPOSE_MODEL;
    const stream = spyOn(llm, 'streamLLM').mockResolvedValue('{"kind":"replan"}');
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      delete process.env.ELANOUS_NEGOTIATE_MODEL;
      delete process.env.ELANOUS_DECOMPOSE_MODEL;
      for (const path of ['mission-feasibility-negotiate.ts', 'system-lookback-run.ts']) {
        expect(readFileSync(new URL(path, import.meta.url), 'utf8')).not.toContain('claude-opus-4-8');
      }
      setUserConfigOverlay(config => ({ ...config, roleLlm: { ...config.roleLlm, planning: { provider: 'gemini', model: 'planning-fixture' } } }));
      await defaultJudge('test');
      expect(stream.mock.calls[0]?.[2]).toMatchObject({ model: 'planning-fixture', provider: llm.PROVIDERS.gemini, usageRole: 'planning', reasoningEffort: 'medium' });
      process.env.ELANOUS_NEGOTIATE_MODEL = 'claude-env-fixture';
      await defaultJudge('test');
      expect(stream.mock.calls[1]?.[2]).toMatchObject({ model: 'claude-env-fixture', provider: llm.PROVIDERS.anthropic, usageRole: 'planning' });
      delete process.env.ELANOUS_NEGOTIATE_MODEL;
      process.env.ELANOUS_DECOMPOSE_MODEL = 'claude-decompose-fixture';
      await defaultJudge('test');
      expect(stream.mock.calls[2]?.[2]).toMatchObject({ model: 'claude-decompose-fixture', provider: llm.PROVIDERS.anthropic, usageRole: 'planning' });
      const pins = log.mock.calls.filter(([category, event]) => category === 'llm.role-pin' && event === 'resolved');
      expect(pins.map(([, , data]) => data)).toEqual([
        expect.objectContaining({ site: 'feasibility-negotiate', role: 'planning', model: 'planning-fixture', provider: 'gemini', source: 'config-role' }),
        expect.objectContaining({ site: 'feasibility-negotiate', role: 'planning', model: 'claude-env-fixture', provider: 'anthropic', source: 'env' }),
        expect.objectContaining({ site: 'feasibility-negotiate', role: 'planning', model: 'claude-decompose-fixture', provider: 'anthropic', source: 'env' }),
      ]);
    } finally {
      log.mockRestore();
      stream.mockRestore();
      setUserConfigOverlay(null);
      if (oldNegotiate === undefined) delete process.env.ELANOUS_NEGOTIATE_MODEL;
      else process.env.ELANOUS_NEGOTIATE_MODEL = oldNegotiate;
      if (oldDecompose === undefined) delete process.env.ELANOUS_DECOMPOSE_MODEL;
      else process.env.ELANOUS_DECOMPOSE_MODEL = oldDecompose;
    }
  });
});

describe('formatNegotiationCard', () => {
  it('scope_cut 카드 — 축소·defer·HITL 명시', () => {
    const card = formatNegotiationCard(
      { rootCause: '품질 과다', kind: 'scope_cut', narrowedAcceptance: ['결손=abstain'], deferred: '정밀 후속', rationale: 'achievable', needsHitl: true },
      '관측 품질',
    );
    expect(card).toContain('스코프컷 제안');
    expect(card).toContain('결손=abstain');
    expect(card).toContain('defer');
    expect(card).toContain('사람 승인');
  });
});
