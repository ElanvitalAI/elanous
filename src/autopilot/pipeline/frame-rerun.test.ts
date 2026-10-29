// P4 — planRerun 순수 계획 검증(모델 폴백·effort 정규화·append 프롬프트 보강).
import { lookupLlmTierSpec } from '../../model-tier/index.js';
import { describe, it, expect } from 'bun:test';
import { planRerun, normalizeEffort } from './frame-rerun.js';

describe('normalizeEffort', () => {
  it('허용값(low/high)은 통과, 그 외는 medium', () => {
    expect(normalizeEffort('low')).toBe('low');
    expect(normalizeEffort('high')).toBe('high');
    expect(normalizeEffort('medium')).toBe('medium');
    expect(normalizeEffort('xhigh')).toBe('medium');
    expect(normalizeEffort(undefined)).toBe('medium');
  });
});

describe('planRerun (순수)', () => {
  it('모델 미지정이면 저장 모델 사용', () => {
    const p = planRerun({ prompt: 'P', model: 'gpt-5.6-sol' });
    expect(p.model).toBe('gpt-5.6-sol');
    expect(p.prompt).toBe('P');
    expect(p.appended).toBe(false);
    expect(p.effort).toBe('medium');
  });

  it('opts.model 이 저장 모델을 이긴다', () => {
    const p = planRerun({ prompt: 'P', model: 'gpt-5.6-sol' }, { model: 'gpt-5.6-terra' });
    expect(p.model).toBe('gpt-5.6-terra');
  });

  it('저장 모델도 opts 도 없으면 codex 사다리 balanced 기본을 쓴다', () => {
    expect(planRerun({ prompt: 'P' }).model).toBe(lookupLlmTierSpec('openai-codex', 'balanced').model);
    expect(planRerun({ prompt: 'P' }).model).not.toMatch(/gpt-5\.6/);
  });

  it('append 는 프롬프트 끝에 추가 지시 섹션으로 덧붙는다', () => {
    const p = planRerun({ prompt: 'BASE' }, { append: '이 지시를 반영하라' });
    expect(p.appended).toBe(true);
    expect(p.prompt).toContain('BASE');
    expect(p.prompt).toContain('## 추가 지시(rerun 튜닝)');
    expect(p.prompt).toContain('이 지시를 반영하라');
    // 원문이 앞, 추가지시가 뒤(순서 보존).
    expect(p.prompt.indexOf('BASE')).toBeLessThan(p.prompt.indexOf('이 지시를 반영하라'));
  });

  it('빈 append 는 무시(appended=false·원문 그대로)', () => {
    const p = planRerun({ prompt: 'BASE' }, { append: '   ' });
    expect(p.appended).toBe(false);
    expect(p.prompt).toBe('BASE');
  });

  it('effort 정규화 적용', () => {
    expect(planRerun({ prompt: 'P' }, { effort: 'high' }).effort).toBe('high');
    expect(planRerun({ prompt: 'P' }, { effort: 'bogus' }).effort).toBe('medium');
  });
});
