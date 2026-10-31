// execHarnessSkill — H3 실행형(allowlist·격리·강한 게이트) 테스트

import { describe, test, expect } from 'bun:test';
import { execHarnessSkill, HARNESS_EXEC_ALLOWLIST, resolveHarnessExecAllowlist } from './skill-exec.js';
import type { SkillIndexEntry } from '../skills/index.js';

function entry(over: Partial<SkillIndexEntry>): SkillIndexEntry {
  return { name: 'x', description: 'd', triggers: [], extractedTriggers: [], autoTrigger: false, category: 'c', skillDir: '/x', ...over } as SkillIndexEntry;
}

// OP-approved research skills are allowlisted / stochastic-multi-agent-consensus stays blocked.
const index = [
  entry({ name: 'omni-digest', description: 'URL 요약', triggers: ['요약', 'digest', 'summarize'] }),
  entry({ name: 'stochastic-multi-agent-consensus', description: 'N 에이전트', triggers: ['consensus', 'poll agents'] }),
];

describe('execHarnessSkill', () => {
  test('allowlist skill 강하게 트리거 + invoke ok → 실행 결과', async () => {
    let called: { obj: string; skill: string } | null = null;
    const r = await execHarnessSkill(
      '이 문서를 요약하고 digest 로 정리해줘', index,
      async (obj, skill) => { called = { obj, skill }; return { ok: true, output: '요약 결과 텍스트' }; },
    );
    expect(r).toEqual({ skill: 'omni-digest', output: '요약 결과 텍스트' });
    expect(called!.skill).toBe('omni-digest');
  });

  test('allowlist 밖 skill 트리거 → null(실행 안 함·invoke 미호출)', async () => {
    let called = false;
    const r = await execHarnessSkill(
      'consensus 로 poll agents 해줘', index,
      async () => { called = true; return { ok: true, output: 'x' }; },
    );
    expect(r).toBeNull();
    expect(called).toBe(false);   // 배치-spawn skill 은 실행 안 함(안전)
  });

  test('약한 신호(단일 트리거·score<2.0) → null', async () => {
    let called = false;
    const r = await execHarnessSkill('요약 좀', index, async () => { called = true; return { ok: true, output: 'x' }; });
    expect(r).toBeNull();
    expect(called).toBe(false);
  });

  test('invoke not ok / 빈 출력 → null', async () => {
    expect(await execHarnessSkill('요약하고 digest', index, async () => ({ ok: false, output: 'x' }))).toBeNull();
    expect(await execHarnessSkill('요약하고 digest', index, async () => ({ ok: true, output: '   ' }))).toBeNull();
  });

  test('invoke throw → null(fail-soft)', async () => {
    const r = await execHarnessSkill('요약하고 digest', index, async () => { throw new Error('skill down'); });
    expect(r).toBeNull();
  });

  test('allowlist has OP-approved research skills while keeping stochastic batches excluded', () => {
    expect(HARNESS_EXEC_ALLOWLIST.has('omni-digest')).toBe(true);
    for (const skill of ['omni-crawl', 'asset-attractiveness', 'social-pulse', 'attractiveness-panel', 'factor-backtest']) {
      expect(HARNESS_EXEC_ALLOWLIST.has(skill)).toBe(true);
    }
    expect(HARNESS_EXEC_ALLOWLIST.has('stochastic-multi-agent-consensus')).toBe(false);
  });
});

describe('resolveHarnessExecAllowlist — S2 config 확장(config-first·안전 블록리스트)', () => {
  test('미설정/빈 배열 → 승인 기본 목록 그대로(무회귀·동일 참조)', () => {
    expect(resolveHarnessExecAllowlist()).toBe(HARNESS_EXEC_ALLOWLIST);
    expect(resolveHarnessExecAllowlist([])).toBe(HARNESS_EXEC_ALLOWLIST);
  });

  test('config 추가 skill 은 기본에 병합', () => {
    const r = resolveHarnessExecAllowlist(['apify-x-asset-sentiment', 'psd-korea-trader']);
    expect(r.has('omni-digest')).toBe(true);        // 기본 유지
    expect(r.has('apify-x-asset-sentiment')).toBe(true);  // 추가됨
    expect(r.has('psd-korea-trader')).toBe(true);
  });

  test('OP-approved attractiveness-panel exception is consistent for config resolution', () => {
    const rejected: string[] = [];
    const r = resolveHarnessExecAllowlist(['attractiveness-panel'], skill => rejected.push(skill));
    expect(r.has('attractiveness-panel')).toBe(true);
    expect(rejected).toEqual([]);
  });

  test('위험 패턴(stochastic/-panel/consensus)은 config 에 있어도 강제 제외 + onReject 관측', () => {
    const rejected: Array<{ skill: string; reason: string }> = [];
    const r = resolveHarnessExecAllowlist(
      ['stochastic-multi-agent-consensus', 'generic-panel', 'safe-skill'],
      (skill, reason) => rejected.push({ skill, reason }),
    );
    expect(r.has('stochastic-multi-agent-consensus')).toBe(false);
    expect(r.has('generic-panel')).toBe(false);   // -panel
    expect(r.has('safe-skill')).toBe(true);
    expect(rejected.map((x) => x.skill).sort()).toEqual(['generic-panel', 'stochastic-multi-agent-consensus']);
    for (const { reason } of rejected) {
      expect(reason).toContain('자동 실행 대상 아님');
      expect(reason).toContain('Agent 배치·고비용 자동실행 금지');
      expect(reason).toContain('skill-hint');
      expect(reason).toContain('skillRouter.harnessExecAllowlist');
      expect(reason).toContain('HARNESS_EXEC_BLOCK_PATTERNS');
    }
  });

  test('빈/공백 문자열 무시', () => {
    const r = resolveHarnessExecAllowlist(['', '  ', 'ok-skill']);
    expect(r.has('ok-skill')).toBe(true);
    expect(r.size).toBe(HARNESS_EXEC_ALLOWLIST.size + 1);
  });

  test('선언 안전 인덱스 항목만 편입하고 블록 패턴은 관측과 함께 거부', () => {
    const rejected: string[] = [];
    const r = resolveHarnessExecAllowlist(
      undefined,
      (skill) => rejected.push(skill),
      [
        entry({ name: 'declared-safe', sideEffects: 'none', cost: 'light' }),
        entry({ name: 'declared-write', sideEffects: 'write', cost: 'light' }),
        entry({ name: 'declared-heavy', sideEffects: 'none', cost: 'heavy' }),
        entry({ name: 'declared-consensus', sideEffects: 'none', cost: 'light' }),
      ],
    );
    expect(r.has('declared-safe')).toBe(true);
    expect(r.has('declared-write')).toBe(false);
    expect(r.has('declared-heavy')).toBe(false);
    expect(r.has('declared-consensus')).toBe(false);
    expect(rejected).toEqual(['declared-consensus']);
  });
});
