// ── 셀프힐 엔진 코어 테스트 (PR1 · 2026-07-13) ─────────────────────────────
// R3 룩백 러너 + 수리 미션 스폰 + phaseGateInputs/systemSuspect 추출. Opus 강제는 se-bridge
// 통합(별도) — 여기선 순수/seam 주입 경계를 검증(실 LLM·실 ~/.elanous·실 spawn 미접촉).

import { describe, expect, it, spyOn } from 'bun:test';
import * as llm from '../llm.js';
import { debug } from '../debug/log.js';
import { setUserConfigOverlay } from '../user-config.js';
import { phaseGateInputs, phaseSystemSuspectSignals, buildPhaseOutcomeFromSummary } from './mission-phase-diagnosis.js';
import { runSystemLookback } from './system-lookback-run.js';
import { buildRepairGoal, spawnSystemRepairMission } from './system-repair-spawn.js';
import type { ContradictionSignal } from './contradiction-detector.js';

const SUSPECT_SIGNAL: ContradictionSignal = {
  kind: 'files-touched-but-empty-diff', systemSuspect: true,
  detail: '변경 파일 3건 있으나 diff 본문 0 — 캡처/전파 결함 의심.',
};

describe('phaseGateInputs / phaseSystemSuspectSignals', () => {
  it('변경파일 있는데 diff 없음 → systemSuspect 신호', () => {
    // diffSummary 파일은 있으나 added+deleted=0 → diffBody='' → files-touched-but-empty-diff.
    const outcome = buildPhaseOutcomeFromSummary({
      phaseId: 'p1', missionId: 'apm_x', title: '급락 관측 어댑터', index: 0, total: 3,
      status: 'failed', summary: 'gate-failed 무결성 실패',
    });
    outcome.diffSummary = { filesTouched: ['a.ts', 'b.ts'], plannedFiles: [], added: 0, deleted: 0 };
    const gi = phaseGateInputs(outcome);
    expect(gi.changedFiles?.length).toBe(2);
    expect(gi.diffBody).toBe('');
    const signals = phaseSystemSuspectSignals(outcome);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0]!.kind).toBe('files-touched-but-empty-diff');
  });

  it('정상 diff 있으면 systemSuspect 없음', () => {
    const outcome = buildPhaseOutcomeFromSummary({
      phaseId: 'p1', missionId: 'apm_x', title: 't', index: 0, total: 1, status: 'failed', summary: 'gate-failed',
    });
    outcome.diffSummary = { filesTouched: ['a.ts'], plannedFiles: [], added: 10, deleted: 2 };
    expect(phaseSystemSuspectSignals(outcome).length).toBe(0);
  });
});

describe('runSystemLookback', () => {
  it('review seam 주입 → Opus 리포트 반환(investigated=true)', async () => {
    let seenPrompt = '';
    const r = await runSystemLookback({
      phaseTitle: '급락 관측 어댑터',
      signals: [SUSPECT_SIGNAL],
      repoRoot: process.cwd(),
      review: async (p) => { seenPrompt = p; return '시스템 결함: 예. nocturnal-deps.ts diff 캡처 누락.'; },
    });
    expect(r.investigated).toBe(true);
    expect(r.report).toContain('시스템 결함');
    // 프롬프트에 모순과 의심 소스가 실려야 한다(READ-ONLY 지시 포함).
    expect(seenPrompt).toContain('READ-ONLY');
    expect(seenPrompt).toContain('files-touched-but-empty-diff');
    // 실제 소스가 읽혔다면 suspectFiles 에 잡힌다(레포 루트 기준·존재 파일만).
    expect(Array.isArray(r.suspectFiles)).toBe(true);
  });

  it('review 실패 → 결정론 폴백 리포트(investigated=false)', async () => {
    const r = await runSystemLookback({
      phaseTitle: 't', signals: [SUSPECT_SIGNAL], repoRoot: process.cwd(),
      review: async () => { throw new Error('opus down'); },
    });
    expect(r.investigated).toBe(false);
    expect(r.report).toContain('폴백');
    expect(r.report).toContain('files-touched-but-empty-diff');
  });
});

describe('runSystemLookback role pin', () => {
  it('audit overlay 를 호출하고 LLM 실패는 결정론 폴백으로 끝난다', async () => {
    const old = process.env.ELANOUS_LOOKBACK_MODEL;
    const stream = spyOn(llm, 'streamLLM').mockResolvedValue('결함 보고');
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      delete process.env.ELANOUS_LOOKBACK_MODEL;
      setUserConfigOverlay(config => ({ ...config, roleLlm: { ...config.roleLlm, audit: { provider: 'gemini', model: 'audit-fixture' } } }));
      const args = { phaseTitle: 't', signals: [SUSPECT_SIGNAL], repoRoot: process.cwd() };
      const result = await runSystemLookback(args);
      expect(result.investigated).toBe(true);
      expect(stream.mock.calls[0]?.[2]).toMatchObject({ model: 'audit-fixture', provider: llm.PROVIDERS.gemini, usageRole: 'audit', maxTokens: 2500 });
      expect(log.mock.calls.find(([category, event]) => category === 'llm.role-pin' && event === 'resolved')?.[2])
        .toMatchObject({ site: 'system-lookback', role: 'audit', model: 'audit-fixture', provider: 'gemini', source: 'config-role' });
      const saved = llm.PROVIDERS.gemini;
      delete llm.PROVIDERS.gemini;
      try {
        const unresolved = await runSystemLookback(args);
        expect(unresolved.investigated).toBe(false);
        expect(unresolved.report).toContain('폴백');
      } finally { llm.PROVIDERS.gemini = saved!; }
      stream.mockImplementation(async () => { throw new Error('unavailable'); });
      const failed = await runSystemLookback(args);
      expect(failed.investigated).toBe(false);
      expect(failed.report).toContain('폴백');
      process.env.ELANOUS_LOOKBACK_MODEL = 'claude-env-lookback';
      stream.mockResolvedValue('env 보고');
      await runSystemLookback(args);
      expect(stream.mock.calls.at(-1)?.[2]).toMatchObject({ model: 'claude-env-lookback', provider: llm.PROVIDERS.anthropic, usageRole: 'audit' });
      expect(log.mock.calls.filter(([category, event]) => category === 'llm.role-pin' && event === 'resolved').at(-1)?.[2])
        .toMatchObject({ site: 'system-lookback', role: 'audit', model: 'claude-env-lookback', provider: 'anthropic', source: 'env' });
    } finally {
      log.mockRestore();
      stream.mockRestore();
      setUserConfigOverlay(null);
      if (old === undefined) delete process.env.ELANOUS_LOOKBACK_MODEL;
      else process.env.ELANOUS_LOOKBACK_MODEL = old;
    }
  });
});

describe('buildRepairGoal', () => {
  it('R2 모순 + R3 리포트 + IMMUTABLE_CORE 금지 명시', () => {
    const goal = buildRepairGoal({
      phaseTitle: '급락 관측 어댑터', signals: [SUSPECT_SIGNAL],
      report: 'nocturnal-deps.ts diff 캡처 누락', suspectFiles: ['src/autopilot/build/nocturnal-deps.ts'],
    });
    expect(goal).toContain('self-heal');
    expect(goal).toContain('files-touched-but-empty-diff');
    expect(goal).toContain('nocturnal-deps.ts');
    expect(goal).toContain('IMMUTABLE_CORE');
    expect(goal).toContain('HITL');
    // ASCII+한글만(특수 en-dash 등 truncation 유발 문자 회피) — 최소 방어.
    expect(goal.includes('—')).toBe(false);
  });
});

describe('spawnSystemRepairMission', () => {
  it('submit+authorize seam → 미션 생성 + system-repair 등재', async () => {
    let authorized = '';
    let submittedGoal = '';
    const r = await spawnSystemRepairMission({
      sourceMissionId: 'apm_src', phaseTitle: 't', signals: [SUSPECT_SIGNAL], report: 'rep',
      submit: async (goal) => { submittedGoal = goal; return { route: 'mission', missionId: 'apm_repair_1' }; },
      authorize: (id) => { authorized = id; },
    });
    expect(r.ok).toBe(true);
    expect(r.missionId).toBe('apm_repair_1');
    expect(authorized).toBe('apm_repair_1');       // 권한 등재됨
    expect(submittedGoal).toContain('self-heal');   // 골이 실려 감
  });

  it('submit 실패(passthrough) → ok=false, authorize 미호출', async () => {
    let authorized = false;
    const r = await spawnSystemRepairMission({
      sourceMissionId: 'apm_src', phaseTitle: 't', signals: [SUSPECT_SIGNAL], report: 'rep',
      submit: async () => ({ route: 'passthrough' }),
      authorize: () => { authorized = true; },
    });
    expect(r.ok).toBe(false);
    expect(authorized).toBe(false);
  });
});
