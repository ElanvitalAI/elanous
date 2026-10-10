import { resetFrontVisitCountsForTesting } from './graph-front-nodes.js';
import { setDefaultTimeout, describe, it, expect, spyOn, beforeAll, afterAll } from 'bun:test';
import * as devCli from './dev-cli.js';

// 발사 시험은 실시간 `elanous usage`(grok 잔량·주간 사용률)를 부르지 않는다.
beforeAll(() => { devCli.setLaunchGrokQuotaReaderForTesting(() => 'unknown'); devCli.setLaunchGrokWeeklyReaderForTesting(() => undefined); });
afterAll(() => { devCli.setLaunchGrokQuotaReaderForTesting(undefined); devCli.setLaunchGrokWeeklyReaderForTesting(undefined); });
import { debug } from '../debug/log.js';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import * as logsCli from '../cli/logs-cli.js';
import { LogStore } from '../mss/logging/log-store.js';
import { spawnSync } from 'node:child_process';
import { spawnRealCli } from '../testing/real-cli-spawn.js';
import { buildChildLlmSelection, buildDevCliSpec, buildDevCommandInput, buildDevEvidence, CHILD_LLM_PROVIDER_ALIASES, DEV_PLAN_REPLACEMENT, formatChildLlmInterpretationLine, formatDevPlanOptionHelp, normalizeChildLlmProvider, parsePositiveInt, parseActivityGraceSec, readChildLlmConfigFromUserConfig, resolveImplementationChildModel, selectDevAuthorInput, shouldSuppressDevJsonWrapper, type DevCliExecutor, defaultChildLlmModel } from './dev-cli.js';
import { devResultOk, planDevPipeline, runDevPipeline, toSelfImplementOptions, buildSelfOrchestrateDevSpec, buildSelfImplementPlanDevSpec } from './dev-pipeline.js';
import { EVIDENCE_LOCATION_REQUIREMENT } from '../self-implement/goal-author.js';
import type { ResolvedDevPlan } from './dev-pipeline.js';
import { formatAutoMergeSuccessMessage, runSelfImplement, type SelfImplementOptions, type SelfImplementResult, type SelfImplementSeams } from '../self-implement/orchestrator.js';
import { defaultSeams } from '../self-implement/seams.js';
import type { AcpRunResult } from './dev-pipeline.js';
import type { AgentMissionResult } from '../agent-mission/driver.js';
import type { SelfDevJobResult } from './orchestrate.js';
import { buildUserConfig, parseChildLlmPreference, resetUserConfig, setUserConfigOverlay, type UserConfig } from '../user-config.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { readHarnessScreen } from '../harness/harness-screen.js';
import { queryRunningRuns } from '../self-implement/running-runs.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

/** 오버레이가 raw 만 바꿔도 파싱된 childLlm 을 같이 싣는다. 발사 경로는 raw 를 다시 읽지 않는다. */
function withParsedChildLlm(config: UserConfig, rawChildLlm: unknown): UserConfig {
  const parsed = parseChildLlmPreference(rawChildLlm);
  return {
    ...config,
    tools: {
      ...config.tools,
      selfImplement: {
        ...config.tools.selfImplement,
        ...(parsed ? { childLlm: parsed } : {}),
      },
    },
  };
}

const IN = { text: '기능' };
const SELF: DevCliExecutor = { kind: 'self' };
const PTY: DevCliExecutor = { kind: 'external', backend: 'codex', transport: 'pty' };
const ACP: DevCliExecutor = { kind: 'external', backend: 'claude', transport: 'acp' };

/**
 * Classification: this supervisor rerun reaches runDevPipeline's default self-implement
 * seam, which resolves the review model before using injected runSelfImplement. It has
 * the same cause as dev-pipeline.test.ts; the local endpoint is never contacted here.
 */
async function withNonExecutingReviewProvider<T>(run: () => Promise<T>): Promise<T> {
  setUserConfigOverlay((config) => ({
    ...config,
    llm: { ...config.llm, provider: 'local', baseUrl: 'http://review.invalid/v1', model: 'test-review-model' },
  }));
  try {
    return await run();
  } finally {
    setUserConfigOverlay(null);
  }
}

describe('buildDevCliSpec — 옵션 축 라우팅(T7)', () => {
  // ⛔⭐⭐ 2026-09-12 정정 — 이 둘이 «방향이 뒤집힌 채» 서 있었다.
  //   종전: `harness ask`(권장 문)로 들어오면 *"권장: cli-dev-ask"* 라 말하고,
  //         `dev --ask`(옛 문)로 들어오면 «아무 말도 안 했다».
  //   CLAUDE.md 가 「터미널이면 `harness say`」라고 말하므로 CLI 표면의 권장은 `cli-harness-say` 다.
  // OLD-DOOR-CLOSE(#24330): `cli-dev-ask` 는 이제 «닫힌» 문이다 — 바깥 호출은 CLI 입구에서 안내와 함께 거부되고
  //   (아래 «dev 은퇴 옵션 실물»), 하니스 안 호출만 여기까지 온다. 닫힌 문은 권장 문 안내를 내지 않는다(live 문만 안내).
  it('옛 문(dev --ask)은 닫혔으므로 권장 문 안내를 내지 않고 하니스 안 구동은 그대로다', () => {
    const spec = buildDevCliSpec(IN, SELF, {});

    expect(spec.notice).toBeUndefined();
    expect(planDevPipeline(spec).dispatch).toBe('self-mission');
  });

  it('권장 문(cli-harness-say)으로 들어오면 조용하다', () => {
    const spec = buildDevCliSpec(IN, SELF, {}, undefined, 'cli-harness-say');

    expect(spec.notice).toBeUndefined();
    expect(planDevPipeline(spec).dispatch).toBe('self-mission');
  });

  it('발사를 «차단하지 않는다» — 권장이 아닌 문도 spec 을 낸다', () => {
    const spec = buildDevCliSpec(IN, SELF, {}, undefined, 'cli-harness-ask');

    expect(spec.notice).toBe('[ask] ℹ️ 권장 발사 입구: cli-harness-say');
    expect(planDevPipeline(spec).dispatch).toBe('self-mission');
  });

  it('--plan의 기존 명시적 거부를 보존한다', () => {
    expect(() => buildDevCliSpec(IN, SELF, { plan: true }))
      .toThrow(`--plan 은 은퇴했고 명시적으로 거부됨 · 대응 문: ${DEV_PLAN_REPLACEMENT}`);
  });

  it('self + --open-pr → 기본 auto-merge · self?(draft/maxWait) · dispatch self-mission', () => {
    const spec = buildDevCliSpec(IN, SELF, { openPr: true, draft: false, maxWait: '900' });
    expect(spec.completion).toBe('auto-merge');
    expect(spec.self).toEqual({ draft: false, maxWaitSec: 900 });
    expect(planDevPipeline(spec).dispatch).toBe('self-mission');
  });

  it('네 completion 모드를 SelfImplementOptions에 보존하고 auto-merge만 legacy autoMerge도 켠다', () => {
    for (const completion of ['worktree-only', 'pr', 'auto-merge', 'unmanned'] as const) {
      const options = toSelfImplementOptions('기능', planDevPipeline({ input: IN, executor: SELF, completion }), {} as SelfImplementSeams);
      expect(options.completion).toBe(completion);
      expect(options.autoMerge).toBe(completion === 'auto-merge' ? true : undefined);
    }
  });

  it('activity grace flag omitted preserves the driver default by leaving self.activityGraceSec absent', () => {
    expect(buildDevCliSpec(IN, SELF, {}).self).toBeUndefined();
  });

  it('activity grace upper bound remains private to the parser module', () => {
    expect('MAX_ACTIVITY_GRACE_SEC' in devCli).toBe(false);
  });

  it('activity grace invalid values are rejected with the valid range and never silently fall back to default', () => {
    for (const raw of ['0', '-1', 'nope', '3601']) {
      expect(() => buildDevCliSpec(IN, SELF, { activityGrace: raw })).toThrow(/1~3600초.*받음/);
    }
    expect(() => parseActivityGraceSec('0')).toThrow(/1~3600초/);
  });

  it('activity grace flag parses caller value into the self-mission spec', () => {
    expect(buildDevCliSpec(IN, SELF, { activityGrace: '600' }).self).toEqual({ activityGraceSec: 600 });
  });

  it('child LLM provider를 정규화해 CLI→plan→SelfImplementOptions로 전달하고 미지정 시 생략한다', () => {
    const selected = { provider: 'grok', model: ' grok-4.6 ', source: 'flag' as const };
    const spec = buildDevCliSpec(IN, SELF, { childLlmProvider: ' grok ', childLlmModel: selected.model });

    expect(spec.self).toEqual({ childLlm: selected });
    expect(toSelfImplementOptions('기능', planDevPipeline(spec), {} as SelfImplementSeams).childLlm).toEqual(selected);
    expect(buildDevCliSpec(IN, SELF, {}).self).toBeUndefined();
  });

  it('별칭 표의 모든 provider를 자식 경계 전에 정규화한다', () => {
    for (const [alias, provider] of Object.entries(CHILD_LLM_PROVIDER_ALIASES)) {
      expect(normalizeChildLlmProvider(alias)).toBe(provider);
      expect(buildChildLlmSelection({ childLlmProvider: alias, childLlmModel: defaultChildLlmModel(provider) }))
        .toEqual({ provider, model: defaultChildLlmModel(provider), source: 'flag' });
    }
  });

  it('정식 provider는 정규화해도 자식 선택에서 변하지 않는다', () => {
    expect(buildChildLlmSelection({ childLlmProvider: 'openai-codex', childLlmModel: 'gpt-5.6-terra' }))
      .toEqual({ provider: 'openai-codex', model: 'gpt-5.6-terra', source: 'flag' });
  });

  it('알 수 없는 provider는 정규화 뒤에도 기존 관문에서 거부한다', () => {
    expect(() => buildChildLlmSelection({ childLlmProvider: 'nonsense', childLlmModel: 'gpt-5.6-terra' }))
      .toThrow(/--child-llm-provider 알 수 없음: nonsense/);
  });

  it.each(['constructor', '__proto__'])('상속 속성 %s도 기존 unknown-provider 오류로 거부한다', (provider) => {
    expect(() => buildChildLlmSelection({ childLlmProvider: provider, childLlmModel: 'gpt-5.6-terra' }))
      .toThrow(`--child-llm-provider 알 수 없음: ${provider}`);
  });

  it('correlation을 self-mission→SelfImplementOptions로 보존하고 생략 시 키를 만들지 않는다', () => {
    const correlated = toSelfImplementOptions('기능', planDevPipeline(buildDevCliSpec(IN, SELF, { correlation: 'request-zzz' })), {} as SelfImplementSeams);
    const uncorrelated = toSelfImplementOptions('기능', planDevPipeline(buildDevCliSpec(IN, SELF, {})), {} as SelfImplementSeams);

    expect(correlated.correlationId).toBe('request-zzz');
    expect(uncorrelated).not.toHaveProperty('correlationId');
  });

  it('self-mission은 그래프 권위 옵션을 생성하지 않는다', () => {
    const spec = buildDevCliSpec(IN, SELF, {});
    expect(spec.self).not.toHaveProperty('graphAuthoritative');
    expect(toSelfImplementOptions('기능', planDevPipeline(spec), {} as SelfImplementSeams))
      .not.toHaveProperty('graphAuthoritative');
  });

  // ⭐ 2026-09-02 (대표) — provider «만» 줘도 그 provider 의 기본 모델이 채워진다.
  //   ⛔ 종전 계약은 「둘 다 안 주면 던진다」였다. 그 문면을 무는 두 줄을 «갱신»한다.
  it('child LLM provider 만 주면 그 provider 의 «기본 모델»이 채워진다', () => {
    const spec = buildDevCliSpec(IN, SELF, { childLlmProvider: 'grok' });
    expect(spec.self?.childLlm?.provider).toBe('grok');
    expect(spec.self?.childLlm?.model).toBe(defaultChildLlmModel('grok'));
    // ⛔ 모델 이름을 여기 박지 않는다 — tier 사다리가 canonical 이라 provider 가 바뀌면 같이 바뀐다.
    expect(defaultChildLlmModel('grok')).toMatch(/^grok-/);
    expect(defaultChildLlmModel('openai-codex')).toMatch(/^gpt-/);
  });

  it('공백뿐인 model 도 «생략»으로 읽어 기본 모델을 채운다', () => {
    const spec = buildDevCliSpec(IN, SELF, { childLlmProvider: 'anthropic', childLlmModel: '  ' });
    expect(spec.self?.childLlm?.model).toBe(defaultChildLlmModel('anthropic'));
  });

  it('★ 음성 — model 만 주거나 provider 가 공백뿐이면 여전히 거부한다', () => {
    expect(() => buildDevCliSpec(IN, SELF, { childLlmModel: 'claude-sonnet' })).toThrow(/--child-llm-provider 필요/);
    expect(() => buildDevCliSpec(IN, SELF, { childLlmProvider: '  ', childLlmModel: 'claude-sonnet' })).toThrow(/--child-llm-provider 필요/);
  });

  it('★ 음성 — 모르는 provider 는 «이름을 대고» 거부한다(기본 모델을 지어내지 않는다)', () => {
    expect(() => buildDevCliSpec(IN, SELF, { childLlmProvider: 'nope-llm' })).toThrow(/--child-llm-provider 알 수 없음: nope-llm/);
  });

  it('canonical child model id resolves against the selected provider catalog', () => {
    // ⛔ 추천 모델 이름을 박지 않는다 — 기본(=추천)은 tier 사다리가 정한다(08-18 뒤 grok-4.6 → 4.7 로 늙었다).
    const recommendedGrok = defaultChildLlmModel('grok');
    expect(resolveImplementationChildModel('grok', recommendedGrok)).toEqual({
      entered: recommendedGrok,
      resolvedId: recommendedGrok,
      tier: 'flagship',
      supportsThinking: true,
      recommended: true,
    });
  });

  it('valid child model alias resolves to the catalog canonical id', () => {
    expect(resolveImplementationChildModel('anthropic', 'sonnet')).toMatchObject({
      entered: 'sonnet',
      resolvedId: 'claude-sonnet-5',
    });
  });

  it('resolved child model metadata includes tier, thinking support, and recommendation', () => {
    const cheap = resolveImplementationChildModel('grok', 'grok-build-0.1');
    expect(cheap).toMatchObject({
      entered: 'grok-build-0.1',
      resolvedId: 'grok-build-0.1',
      tier: 'cheap',
      supportsThinking: false,
      recommended: false,
    });
    expect(resolveImplementationChildModel('grok', defaultChildLlmModel('grok')).recommended).toBe(true);
  });

  it('unresolved provider or model names are rejected with the supplied value', () => {
    expect(() => resolveImplementationChildModel('not-a-provider', 'grok-4.6'))
      .toThrow(/--child-llm-provider 알 수 없음: not-a-provider/);
    expect(() => resolveImplementationChildModel('grok', 'not-a-real-model'))
      .toThrow(/--child-llm-model 알 수 없음: not-a-real-model/);
    expect(() => resolveImplementationChildModel('grok', 'not-a-real-model'))
      .toThrow(/후보:.*grok-4\.6/);
  });

  function captureChildLlmAnnouncement(run: () => void): string {
    const chunks: string[] = [];
    const write = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
    try {
      run();
      return chunks.join('');
    } finally {
      write.mockRestore();
    }
  }

  it('non-thinking child model choice is visible on the [dev] interpretation line', () => {
    const out = captureChildLlmAnnouncement(() => {
      buildDevCliSpec(IN, SELF, { childLlmProvider: 'grok', childLlmModel: 'grok-build-0.1' });
    });
    expect(out).toContain('[dev] child-llm:');
    expect(out).toContain('entered=grok-build-0.1');
    expect(out).toContain('resolved=grok-build-0.1');
    expect(out).toContain('tier=cheap');
    expect(out).toContain('thinking=false');
  });

  it('alias input and canonical id are both visible on the [dev] interpretation line', () => {
    const out = captureChildLlmAnnouncement(() => {
      buildDevCliSpec(IN, SELF, { childLlmProvider: 'anthropic', childLlmModel: 'sonnet' });
    });
    expect(out).toContain('entered=sonnet');
    expect(out).toContain('resolved=claude-sonnet-5');
  });

  it('unresolved child model name stops launch and names the supplied value', () => {
    expect(() => buildDevCliSpec(IN, SELF, { childLlmProvider: 'grok', childLlmModel: 'not-a-real-model' }))
      .toThrow(/--child-llm-model 알 수 없음: not-a-real-model/);
    expect(() => buildDevCliSpec(IN, SELF, { childLlmProvider: 'grok', childLlmModel: 'not-a-real-model' }))
      .toThrow(/후보:.*grok-4\.6/);
  });

  it('valid alias is not rejected as an unknown model', () => {
    expect(() => buildDevCliSpec(IN, SELF, { childLlmProvider: 'anthropic', childLlmModel: 'sonnet' }))
      .not.toThrow();
    expect(buildDevCliSpec(IN, SELF, { childLlmProvider: 'anthropic', childLlmModel: 'sonnet' }).self)
      .toEqual({ childLlm: { provider: 'anthropic', model: 'sonnet', source: 'flag' } });
  });

  it('recommended child model interpretation line has no warning markers', () => {
    const out = captureChildLlmAnnouncement(() => {
      buildDevCliSpec(IN, SELF, { childLlmProvider: 'grok', childLlmModel: 'grok-4.6' });
    });
    expect(out).toContain('[dev] child-llm:');
    expect(out).toContain('entered=grok-4.6');
    expect(out).toContain('resolved=grok-4.6');
    expect(out).not.toMatch(/warn|⚠️|!/i);
    expect(formatChildLlmInterpretationLine(resolveImplementationChildModel('grok', 'grok-4.6')))
      .not.toMatch(/warn|⚠️|!/i);
  });

  it('absent child LLM flags emit no new interpretation line and keep prior output', () => {
    const out = captureChildLlmAnnouncement(() => {
      expect(buildDevCliSpec(IN, SELF, {}).self).toBeUndefined();
    });
    expect(out).not.toContain('[dev] child-llm:');
  });

  it('self 외 경로의 child LLM 옵션은 조용히 폐기하지 않고 거부한다', () => {
    expect(() => buildDevCliSpec(IN, PTY, { branch: 'wt/x', childLlmProvider: 'anthropic', childLlmModel: 'claude-sonnet' }))
      .toThrow(/무효한 옵션.*--child-llm-provider.*--child-llm-model/);
  });

  it('Commander cli 출처만 canonical option 이름으로 수집해 기본값과 별칭 표기를 검사하지 않는다', () => {
    const command = {
      options: [
        { attributeName: () => 'roleLlm' },
        { attributeName: () => 'openPr' },
        { attributeName: () => 'childLlmProvider' },
      ],
      getOptionValueSource: (name: string) => name === 'roleLlm' || name === 'childLlmProvider' ? 'cli' : 'default',
    };
    expect(devCli.explicitDevOptionNames(command)).toEqual(['roleLlm', 'childLlmProvider']);
  });

  it('CLI --no-auto-merge remains an explicit remote-dependent completion', () => {
    const command = {
      options: [{ attributeName: () => 'autoMerge' }],
      getOptionValueSource: () => 'cli',
      getOptionValue: () => false,
    };
    const explicit = devCli.explicitDevOptionNames(command);
    expect(explicit).toEqual(['autoMerge']);
    expect(buildDevCliSpec(IN, SELF, { autoMerge: false }, explicit).completionSource).toBe('request');
  });

  it('self-mission의 명시 --role-llm은 자식에 전달되지 않음을 이름과 child LLM 대안으로 거부한다', () => {
    expect(() => buildDevCliSpec(IN, SELF, { roleLlm: ['implement=grok/best'] }, ['roleLlm']))
      .toThrow(/--role-llm.*--child-llm-provider.*--child-llm-model/);
  });

  it('명시 --role-llm은 self-mission 외 기존 유효 경로에서 통과한다', () => {
    const spec = buildDevCliSpec(IN, PTY, { branch: 'wt/x', roleLlm: ['implement=grok/best'] }, ['branch', 'roleLlm']);
    expect(planDevPipeline(spec).dispatch).toBe('agent-mission-pty');
  });

  it('직접 seam의 생략된 명시 옵션은 undefined를 기존처럼 검사하지 않고 명시 false는 검사한다', () => {
    const omitted = buildDevCliSpec(IN, SELF, { roleLlm: undefined, branch: undefined });
    expect(omitted.completion).toBeUndefined();
    expect(planDevPipeline(omitted)).toMatchObject({ completion: 'auto-merge', completionSource: 'default' });
    expect(() => buildDevCliSpec(IN, PTY, { branch: 'wt/x', ground: false }))
      .toThrow(/무효한 옵션.*ground/);
  });

  // ⛔⭐⭐ 이 셋이 «UNCONVERGEABLE 을 낳은 그 자리»다(2026-08-18 · 3라운드 반복 must-fix).
  //   fallback 을 `value !== undefined` 로 두면 ***비활성 false 가 「명시된 옵션」으로 오인***되어
  //   종전에 통과하던 호출이 거부된다. 「모집단을 넓힌다」가 「판정을 엄하게 한다」로 새는 자리라 회귀로 못 박는다.
  it('직접 seam에서 비활성 openPr:false 는 명시 옵션이 아니므로 무효 판정에 걸리지 않는다', () => {
    expect(() => buildDevCliSpec(IN, PTY, { branch: 'wt/x', openPr: false })).not.toThrow();
  });

  it('직접 seam에서 비활성 autoMerge/autoReview false 도 명시 옵션으로 오인하지 않는다', () => {
    expect(() => buildDevCliSpec(IN, PTY, { branch: 'wt/x', autoMerge: false, autoReview: false })).not.toThrow();
  });

  it('drive alias 도 Commander 출처를 받아 같은 입력을 dev 와 같게 판정한다', () => {
    expect(() => devCli.buildDriveAliasDevSpec('echo hi', { goal: 'g', branch: 'wt/x' }, ['goal', 'branch']))
      .toThrow(/무효한 옵션.*branch/);
    expect(() => devCli.buildDriveAliasDevSpec('echo hi', { goal: 'g', openPr: false }, ['goal']))
      .not.toThrow();
  });

  it('drive alias 는 공유 무인 완결 기본을 물려받지 않고 shell-drive 가 이행하는 값만 고정한다', () => {
    const spec = devCli.buildDriveAliasDevSpec('echo hi', { goal: 'g' }, ['goal']);
    expect(spec.drive).toMatchObject({ command: 'echo hi', goal: 'g' });
    expect(spec.completion).toBe('worktree-only');
    expect(spec.autoReview).toBe(false);
    expect(spec.entrance).toBe('cli-drive');
    expect(planDevPipeline(spec)).toMatchObject({
      dispatch: 'shell-drive',
      completion: 'worktree-only',
      autoReview: false,
    });
    expect(buildDevCliSpec(IN, SELF, {}).entrance).toBe('cli-dev-ask');
    expect(buildDevCliSpec(IN, SELF, {}).completion).toBeUndefined();
    expect(planDevPipeline(buildDevCliSpec(IN, SELF, {}))).toMatchObject({
      dispatch: 'self-mission',
      completion: 'auto-merge',
      autoReview: true,
    });
  });

  it('명시 옵션 모집단에 새 키가 추가되어도 허용 표를 손으로 갱신하지 않으면 self-mission에서 거부한다', () => {
    expect(() => buildDevCliSpec(IN, SELF, {}, ['futureDevOption']))
      .toThrow(/--future-dev-option/);
  });

  it('self-mission은 --observe-only를 조용히 무시하지 않고 거부한다', () => {
    expect(() => buildDevCliSpec(IN, SELF, { observeOnly: true }, ['observeOnly']))
      .toThrow(/무효한 옵션/);
  });

  it('self-mission의 --observe-only 거부는 제거할 플래그 이름을 알린다', () => {
    expect(() => buildDevCliSpec(IN, SELF, { observeOnly: true }, ['observeOnly']))
      .toThrow(/--observe-only/);
  });

  it('elanous-tui는 지원하는 --observe-only를 기존처럼 수락한다', () => {
    expect(buildDevCliSpec(IN, SELF, { elanous: true, goal: 'child goal', observeOnly: true }, ['elanous', 'goal', 'observeOnly']))
      .toMatchObject({ elanous: { goal: 'child goal', observeOnly: true } });
  });

  it('self-mission의 허용된 명시 경로·출력 옵션은 기존처럼 통과한다', () => {
    expect(buildDevCliSpec(IN, SELF, { childLlmProvider: 'anthropic', childLlmModel: 'claude-sonnet-4-6', openPr: true }, ['childLlmProvider', 'childLlmModel', 'openPr']))
      .toMatchObject({ completion: 'auto-merge', self: { childLlm: { provider: 'anthropic', model: 'claude-sonnet-4-6' } } });
  });

  it('self + --plan은 dispatch 해석 전에 은퇴 사유와 대응 문으로 거부한다', () => {
    expect(() => buildDevCliSpec(IN, SELF, { plan: true }))
      .toThrow(new RegExp(`은퇴.*${DEV_PLAN_REPLACEMENT}`));
  });

  it('--plan refusal and help literally direct callers to live harness say, never the retired harness plan door', () => {
    const refusal = () => buildDevCliSpec(IN, SELF, { plan: true });
    expect(refusal).toThrow(/elanous harness say/);
    expect(refusal).toThrow(/--plan 은 은퇴했고 명시적으로 거부됨/);
    expect(refusal).not.toThrow(/elanous harness plan/);
    const help = formatDevPlanOptionHelp();
    expect(help).toContain('elanous harness say');
    expect(help).not.toContain('elanous harness plan');
  });

  it('self + --elanous → 격리 TUI namespace로 매핑하고 completion을 주입하지 않는다', () => {
    const spec = buildDevCliSpec(IN, SELF, { elanous: true, goal: 'child goal', maxSteps: '4', pollMs: '0', model: 'brain', isolatedRoot: '/iso', cwd: '/work', readyTimeoutMs: '180000' });
    expect(spec.elanous).toEqual({ goal: 'child goal', maxSteps: 4, pollMs: 0, model: 'brain', isolatedRoot: '/iso', cwd: '/work', readyTimeoutMs: 180000 });
    expect(spec.completion).toBeUndefined();
    expect(planDevPipeline(spec).dispatch).toBe('elanous-tui');
  });

  it('elanous hold readiness timeout rejects zero, negative, and nonnumeric values by flag name', () => {
    for (const value of ['0', '-1', 'nope']) {
      expect(() => buildDevCliSpec(IN, SELF, { elanous: true, hold: true, readyTimeoutMs: value }, ['elanous', 'hold', 'readyTimeoutMs']))
        .toThrow(/--ready-timeout-ms/);
    }
  });

  it('--implement는 위치 프롬프트를 기존 interactive chat dispatch와 headless 구현 옵션으로 매핑한다', () => {
    const spec = buildDevCliSpec({ text: '두 더하기 두는 얼마인가' }, SELF, { implement: true });
    expect(spec).toEqual({
      input: { text: '두 더하기 두는 얼마인가' },
      executor: SELF,
      context: 'interactive',
      entranceUnstamped: 'interactive-dispatch',
      chat: { forceNew: true, enableTools: true, goalLoop: true },
    });
    expect(spec).not.toHaveProperty('entrance');
    expect(planDevPipeline(spec)).toMatchObject({ dispatch: 'interactive', entranceUnstamped: 'interactive-dispatch' });
    expect(planDevPipeline(spec).entrance).toBeUndefined();
  });

  it('--implement 없이 self dev의 기존 self-mission 경로를 보존한다', () => {
    expect(planDevPipeline(buildDevCliSpec(IN, SELF, {})).dispatch).toBe('self-mission');
  });

  it('--implement + --plan도 조합 검증보다 은퇴 사유를 우선한다', () => {
    expect(() => buildDevCliSpec(IN, SELF, { implement: true, plan: true }))
      .toThrow(new RegExp(`은퇴.*${DEV_PLAN_REPLACEMENT}`));
    expect(() => buildDevCliSpec(IN, SELF, { implement: true, elanous: true, goal: 'child goal' }))
      .toThrow(/--implement 와 --elanous 는 동시 사용 불가/);
  });

  it('--worktree는 elanous/drive 경로에서만 허용하며 명시 cwd와 함께면 거부한다', () => {
    expect(buildDevCliSpec(IN, SELF, { elanous: true, goal: 'child goal', worktree: true }).elanous).toEqual({ goal: 'child goal' });
    expect(buildDevCliSpec(IN, SELF, { goal: 'drive goal', worktree: true }).drive).toMatchObject({ goal: 'drive goal' });
    expect(() => buildDevCliSpec(IN, SELF, { elanous: true, goal: 'child goal', worktree: true, cwd: '/work' })).toThrow(/--worktree 와 --cwd/);
    expect(() => buildDevCliSpec(IN, SELF, { worktree: true })).toThrow(/무효한 옵션.*worktree/);
  });

  it('executeDevChild는 주입된 child 예외를 worktree provenance가 든 구조화 실패로 보존한다', async () => {
    const autoWorktree = {
      environment: { cwd: '/repo', repoRoot: '/repo', isPrimary: true, branch: 'main', commit: 'a'.repeat(40) },
      worktree: {
        path: '/repo.worktrees/dev-run-42', branch: 'dev/run-42', base: 'HEAD', resolvedBase: 'a'.repeat(40),
        baseFreshness: 'head' as const, owner: 'dev:run-42', command: 'dev', createdAt: '2026-08-04T12:00:00.000Z',
      },
    };
    const executed = await devCli.executeDevChild(async () => { throw new Error('injected child dispatch failure'); }, autoWorktree);
    expect(executed.ok).toBe(false);
    if (executed.ok) throw new Error('injected child failure must not succeed');
    const failureJson = JSON.parse(JSON.stringify(executed.failure));
    expect(failureJson).toEqual({ error: 'injected child dispatch failure', autoWorktree });
  });

  it('executeDevChild는 주입된 child가 성공하면 결과를 그대로 돌려준다', async () => {
    expect(await devCli.executeDevChild(async () => ({ exitCode: 0 }))).toEqual({ ok: true, result: { exitCode: 0 } });
  });

  const selfResult = (overrides: Partial<SelfImplementResult> = {}): SelfImplementResult => ({
    runId: 'run-dev-supervision', ok: true, stage: 'pr-declined', node: 'complete' as never, outcome: 'completed' as never, ...overrides,
  });

  const promotedConvergedOptions = (pressParentSignals?: (goalFile: string) => unknown) => ({
    rounds: 2,
    executePiece: async () => selfResult({ stage: 'merged', merged: true }),
    readProposals: () => ({
      proposals: new Map([['run-dev-supervision', { shardId: 'run-dev-supervision', pieces: [
        { id: 'part-a', feature: 'part a', dependsOn: [] },
        { id: 'part-b', feature: 'part b', dependsOn: [] },
      ] }]]),
      goalPlanRevisions: new Map(), scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
    }),
    ...(pressParentSignals ? { pressParentSignals: pressParentSignals as never } : {}),
  });

  const parentSignalResult = (green: number, red: number) => ({
    classification: { kinds: {}, observations: {} },
    pressedGreen: Array.from({ length: green }, () => ({ signal: 'green', command: 'bun test x', exitCode: 0, stdout: '', durationMs: 0 })),
    pressedRed: Array.from({ length: red }, () => ({ signal: 'red', command: 'bun test x', exitCode: 1, stdout: '', durationMs: 0 })),
    pressedBaselineOnly: [],
    unpressed: [], pressedCount: green + red,
  });

  it('승격 분해가 converged면 부모 신호의 빨강을 supervisor stop reason으로 올린다', async () => {
    const goalFile = join(mkdtempSync(join(tmpdir(), 'parent-signal-goal-')), 'goal.md');
    writeFileSync(goalFile, '# goal');
    try {
      const executed = await devCli.executeDevSelfRun(goalFile, async () => selfResult(), promotedConvergedOptions(() => parentSignalResult(0, 1)));
      expect(executed.supervisorStopReason).toBe('parent-signals-red');
    } finally { rmSync(resolve(goalFile, '..'), { recursive: true, force: true }); }
  });

  it('승격 분해가 converged면 부모 신호 초록 수를 관측하고 converged를 보존한다', async () => {
    const goalFile = join(mkdtempSync(join(tmpdir(), 'parent-signal-goal-')), 'goal.md');
    writeFileSync(goalFile, '# goal');
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => { logs.push({ event, data: data as Record<string, unknown> }); });
    try {
      const executed = await devCli.executeDevSelfRun(goalFile, async () => selfResult(), promotedConvergedOptions(() => parentSignalResult(2, 0)));
      expect(executed.supervisorStopReason).toBe('converged');
      expect(logs).toContainEqual(expect.objectContaining({ event: 'parent-signal-press', data: expect.objectContaining({ runId: 'run-dev-supervision', pressedGreen: 2, pressedRed: 0, unpressed: 'none' }) }));
    } finally { log.mockRestore(); rmSync(resolve(goalFile, '..'), { recursive: true, force: true }); }
  });

  it('부모 신호가 없으면 converged를 보존하고 명시적 미검증 이유와 결과 runId를 관측한다', async () => {
    const goalFile = join(mkdtempSync(join(tmpdir(), 'parent-signal-goal-')), 'goal.md');
    writeFileSync(goalFile, '# goal');
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => { logs.push({ event, data: data as Record<string, unknown> }); });
    try {
      const executed = await devCli.executeDevSelfRun(goalFile, async () => selfResult(), promotedConvergedOptions(() => parentSignalResult(0, 0)));
      expect(executed.supervisorStopReason).toBe('converged');
      expect(logs).toContainEqual(expect.objectContaining({ event: 'parent-signal-press', data: expect.objectContaining({ runId: 'run-dev-supervision', unpressed: 'no-parent-decision-signals' }) }));
    } finally { log.mockRestore(); rmSync(resolve(goalFile, '..'), { recursive: true, force: true }); }
  });

  it('분해를 승격하지 않으면 converged여도 부모 신호를 누르지 않는다', async () => {
    let calls = 0;
    const goalFile = join(mkdtempSync(join(tmpdir(), 'parent-signal-goal-')), 'goal.md');
    writeFileSync(goalFile, '# goal');
    try {
      await devCli.executeDevSelfRun(goalFile, async () => selfResult({ stage: 'merged', merged: true }), { rounds: 1, pressParentSignals: () => { calls += 1; return parentSignalResult(0, 1); } });
      expect(calls).toBe(0);
    } finally { rmSync(resolve(goalFile, '..'), { recursive: true, force: true }); }
  });

  it('부모 신호 seam이 실패하면 converged를 보존하고 unpressed 이유를 관측한다', async () => {
    const goalFile = join(mkdtempSync(join(tmpdir(), 'parent-signal-goal-')), 'goal.md');
    writeFileSync(goalFile, '# goal');
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => { logs.push({ event, data: data as Record<string, unknown> }); });
    try {
      const executed = await devCli.executeDevSelfRun(goalFile, async () => selfResult(), promotedConvergedOptions(() => { throw new Error('press failed'); }));
      expect(executed.supervisorStopReason).toBe('converged');
      expect(logs).toContainEqual(expect.objectContaining({ event: 'parent-signal-press', data: expect.objectContaining({ unpressed: 'press failed' }) }));
    } finally { log.mockRestore(); rmSync(resolve(goalFile, '..'), { recursive: true, force: true }); }
  });

  // ⛔ 대표 2026-08-22: 슈퍼바이저가 «기본 ON» — 종전 계약(「함께만 유효」)은 뜻을 잃었다.
  //   남는 참인 계약 둘: ***끈 채로 상한을 못 준다*** ⊕ 상한은 양의 정수다.
  it('--supervise-rounds 는 «끈 채로» 거부하고 0 또는 음수도 실행 전에 거부한다', () => {
    expect(() => buildDevCliSpec(IN, SELF, { supervise: false, superviseRounds: '2' }))
      .toThrow('--supervise-rounds 는 --no-supervise 와 함께 쓸 수 없다');
    expect(() => buildDevCliSpec(IN, SELF, { superviseRounds: '0' })).toThrow('--supervise-rounds 는 양의 정수여야');
    expect(() => buildDevCliSpec(IN, SELF, { superviseRounds: '-1' })).toThrow('--supervise-rounds 는 양의 정수여야');
  });

  it('⭐ 기본이 «켜짐»이라 --supervise-rounds 만 줘도 통과한다(대표 2026-08-22 · 반대 방향)', () => {
    expect(() => buildDevCliSpec(IN, SELF, { superviseRounds: '2' })).not.toThrow();
  });

  it('review-blocked 수확 자식이 시작되면 감독기는 재발사 없이 인계하고, 수확 신호가 없으면 재발사한다', async () => {
    for (const salvage of ['launched', undefined] as const) {
      const calls: Array<boolean | undefined> = [];
      const executed = await devCli.executeDevSelfRun('same goal', async (relaunch) => {
        calls.push(relaunch);
        return selfResult({ ok: false, stage: 'review-blocked', ...(salvage ? { salvage } : {}) });
      }, { rounds: 1, printDecision: () => {} });
      if (salvage === 'launched') {
        expect(calls).toEqual([undefined]);
        expect(executed.supervisorStopReason).toBe('handed-off-to-salvage');
      } else {
        expect(calls).toContain(true);
        expect(calls.length).toBeGreaterThan(1);
        expect(executed.supervisorStopReason).not.toBe('handed-off-to-salvage');
      }
    }
  });

  it('감독이 꺼지면 주입 실행 심을 정확히 한 번 호출한다', async () => {
    let calls = 0;
    const executed = await devCli.executeDevSelfRun('same goal', async () => {
      calls += 1;
      return selfResult();
    });
    expect(calls).toBe(1);
    expect(executed.supervisorStopReason).toBeUndefined();
  });

  it('재실행과 승격 조각 실행 직전에 시작 시각 기준 supervisor frame을 현재 공간 또는 이전 worktree key로 쓴다', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'dev-cli-supervisor-screen-'));
    const previous = {
      stateDir: process.env.ELANOUS_STATE_DIR,
      space: process.env.ELANOUS_HARNESS_SPACE,
      spaceId: process.env.ELANOUS_HARNESS_SPACE_ID,
    };
    process.env.ELANOUS_STATE_DIR = stateDir;
    delete process.env.ELANOUS_HARNESS_SPACE;
    delete process.env.ELANOUS_HARNESS_SPACE_ID;
    try {
      let executions = 0;
      await devCli.executeDevSelfRun('relaunch frame', async () => {
        executions += 1;
        return selfResult({ worktreePath: '/tmp/previous result' });
      }, { rounds: 2 });
      expect(executions).toBe(3);
      expect(readHarnessScreen('previous-result')).toMatch(/^\[supervisor\] relaunch after \d+ms$/);

      process.env.ELANOUS_HARNESS_SPACE = 'self-implement';
      process.env.ELANOUS_HARNESS_SPACE_ID = 'current-space';
      await devCli.executeDevSelfRun('piece frame', async () => selfResult({ worktreePath: '/tmp/ignored-result' }), promotedConvergedOptions());
      expect(readHarnessScreen('current-space')).toMatch(/^\[supervisor\] promoted-piece after \d+ms$/);
    } finally {
      if (previous.stateDir === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previous.stateDir;
      if (previous.space === undefined) delete process.env.ELANOUS_HARNESS_SPACE; else process.env.ELANOUS_HARNESS_SPACE = previous.space;
      if (previous.spaceId === undefined) delete process.env.ELANOUS_HARNESS_SPACE_ID; else process.env.ELANOUS_HARNESS_SPACE_ID = previous.spaceId;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('시작 뒤 soft stop은 relaunch를 막고 human-stopped로 끝낸다', async () => {
    let executions = 0;
    const executed = await devCli.executeDevSelfRun('soft stop relaunch', async () => {
      executions += 1;
      return selfResult({ worktreePath: '/tmp/soft-stop-relaunch' });
    }, {
      rounds: 1,
      readSoftStopRequest: () => ({ version: 1, requestedAt: new Date().toISOString() }),
    });
    expect(executions).toBe(1);
    expect(executed.supervisorStopReason).toBe('human-stopped');
  });

  it('시작 뒤 soft stop은 승격 조각 실행을 막고 skipped piece를 관측한다', async () => {
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => { logs.push({ event, data: data as Record<string, unknown> }); });
    let pieces = 0;
    try {
      const executed = await devCli.executeDevSelfRun('soft stop piece', async () => selfResult({ worktreePath: '/tmp/soft-stop-piece' }), {
        ...promotedConvergedOptions(),
        executePiece: async () => { pieces += 1; return selfResult({ stage: 'merged', merged: true }); },
        readSoftStopRequest: () => ({ version: 1, requestedAt: new Date().toISOString() }),
      });
      expect(pieces).toBe(0);
      expect(executed.supervisorStopReason).toBe('human-stopped');
      expect(logs).toContainEqual(expect.objectContaining({ event: 'human-stop-honored', data: expect.objectContaining({ skipped: 'piece' }) }));
    } finally { log.mockRestore(); }
  });

  // 🅕 관측 2026-09-25: 정지를 첫 런 «도중»에 보냈는데 슈퍼바이저가 4초 뒤 새 라운드를 걸었다.
  //   호출부(index.ts)가 첫 런을 먼저 돌리고 initialResult 로 넘기므로, 기준 시각을 함수 진입으로 잡으면
  //   첫 런 도중의 정지가 «옛 요청»이 된다.
  it('첫 런 도중의 soft stop(initialResult 로 넘어온 판)도 relaunch를 막는다', async () => {
    const invocationStartedAtMs = Date.now() - 60_000;
    const stopDuringInitialRun = new Date(Date.now() - 30_000).toISOString();
    let executions = 0;
    const executed = await devCli.executeDevSelfRun('stop during initial run', async () => {
      executions += 1;
      return selfResult({ worktreePath: '/tmp/stop-during-initial' });
    }, {
      rounds: 1,
      invocationStartedAtMs,
      readSoftStopRequest: () => ({ version: 1, requestedAt: stopDuringInitialRun }),
    }, selfResult({ worktreePath: '/tmp/stop-during-initial' }));
    expect(executions).toBe(0);
    expect(executed.supervisorStopReason).toBe('human-stopped');
  });

  it('호출 시작보다 이른 정지는 여전히 옛 요청이다', async () => {
    let executions = 0;
    await devCli.executeDevSelfRun('stale before invocation', async () => {
      executions += 1;
      return selfResult({ worktreePath: '/tmp/stale-before-invocation' });
    }, {
      rounds: 1,
      invocationStartedAtMs: Date.now() - 1_000,
      readSoftStopRequest: () => ({ version: 1, requestedAt: new Date(Date.now() - 60_000).toISOString() }),
    }, selfResult({ worktreePath: '/tmp/stale-before-invocation' }));
    expect(executions).toBe(1);
  });

  it('시작 전 soft stop은 무시하고 relaunch를 보존한다', async () => {
    let executions = 0;
    await devCli.executeDevSelfRun('stale soft stop', async () => {
      executions += 1;
      return selfResult({ worktreePath: '/tmp/stale-soft-stop' });
    }, {
      rounds: 1,
      readSoftStopRequest: () => ({ version: 1, requestedAt: '2000-01-01T00:00:00.000Z' }),
    });
    expect(executions).toBe(2);
  });

  it('공간을 풀 수 없으면 실행을 보존하고 human-stop-unchecked를 관측한다', async () => {
    const previous = { space: process.env.ELANOUS_HARNESS_SPACE, spaceId: process.env.ELANOUS_HARNESS_SPACE_ID };
    delete process.env.ELANOUS_HARNESS_SPACE;
    delete process.env.ELANOUS_HARNESS_SPACE_ID;
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => { logs.push({ event, data: data as Record<string, unknown> }); });
    let executions = 0;
    try {
      await devCli.executeDevSelfRun('unresolved soft stop', async () => {
        executions += 1;
        return selfResult();
      }, { rounds: 1, readSoftStopRequest: () => ({ version: 1, requestedAt: new Date().toISOString() }) });
      expect(executions).toBe(2);
      expect(logs).toContainEqual(expect.objectContaining({ event: 'human-stop-unchecked', data: expect.objectContaining({ reason: 'space-unresolved', skipped: 'relaunch' }) }));
    } finally {
      log.mockRestore();
      if (previous.space === undefined) delete process.env.ELANOUS_HARNESS_SPACE; else process.env.ELANOUS_HARNESS_SPACE = previous.space;
      if (previous.spaceId === undefined) delete process.env.ELANOUS_HARNESS_SPACE_ID; else process.env.ELANOUS_HARNESS_SPACE_ID = previous.spaceId;
    }
  });

  type RunEvent = { category: string; event: string; data?: Record<string, unknown> };

  const observeRunExit = async (name: string, run: () => Promise<void>): Promise<RunEvent[]> => {
    const events: RunEvent[] = [];
    const unregister = debug.registerSink({
      name: `dev-cli-${name}-run-terminal-test`,
      emit: (record) => events.push({
        category: record.category,
        event: record.event,
        ...(record.data && typeof record.data === 'object' ? { data: record.data as Record<string, unknown> } : {}),
      }),
    });
    try {
      await run();
    } finally {
      unregister();
    }
    return events.filter(({ category }) => category === 'self-implement');
  };

  const expectTerminalWithoutFinalStatus = (events: readonly RunEvent[], terminalData: Record<string, unknown>) => {
    const terminals = events.filter(({ event }) => event === 'run-terminal');
    expect(terminals).toHaveLength(1);
    expect(events.filter(({ event }) => event === 'run-status')).toHaveLength(0);
    expect(terminals[0]).toEqual(expect.objectContaining({ data: expect.objectContaining(terminalData) }));
  };

  const openDraft = (): { isDraft: boolean; state: string } => ({ isDraft: true, state: 'OPEN' });
  const pr = (n: number): string => `https://github.com/acme/elanous/pull/${n}`;
  const lineageDraft = (url: string) => ({ ...openDraft(), headRefName: `self-impl/draft-triage-abcdef12-r${Number(url.split('/').at(-1)!).toString(16).padStart(6, '0')}` });
  const executeAfterStartDraftTriage = async (
    feature: string,
    execute: (relaunch?: boolean) => Promise<import('../self-implement/orchestrator.js').SelfImplementResult>,
    supervise?: import('./dev-cli.js').DevSelfRunSuperviseOptions,
    initialResult?: import('../self-implement/orchestrator.js').SelfImplementResult,
  ) => {
    devCli.startDraftTriage(supervise?.runId, supervise);
    return devCli.executeDevSelfRun(feature, execute, supervise, initialResult);
  };

  it('runId 기반 후보 회전은 재현 가능하고 집합·자명한 입력을 보존한다', () => {
    const candidates = ['one', 'two', 'three', 'four'];
    const firstRunId = 'run-alpha';
    const secondRunId = 'current';
    const first = devCli.rotateDraftTriageRuns(candidates, firstRunId);
    const repeated = devCli.rotateDraftTriageRuns(candidates, firstRunId);
    const second = devCli.rotateDraftTriageRuns(candidates, secondRunId);

    expect(first).toEqual(repeated);
    expect(first[0]).not.toBe(second[0]);
    expect([...first].sort()).toEqual([...candidates].sort());
    expect(devCli.rotateDraftTriageRuns([], firstRunId)).toEqual([]);
    expect(devCli.rotateDraftTriageRuns(['only'], firstRunId)).toEqual(['only']);
    expect(devCli.rotateDraftTriageRuns(candidates, undefined)).toEqual(candidates);
  });

  it('12개 초안의 완료·중지·실행 런을 각각 판정하고 브랜치를 보존한다', async () => {
    const now = 40 * 3_600_000;
    const closed: number[] = [];
    const drafts = Array.from({ length: 12 }, (_, i) => ({
      runId: ['completed', 'stopped', 'running'][Math.floor(i / 4)],
      number: i + 1, url: pr(i + 1), openedAtMs: now - 30 * 3_600_000,
      branch: `self-impl/run-${i}`, title: `draft-${i}`,
    }));
    const events = await observeRunExit('triage-12-decisions', async () => {
      devCli.startDraftTriage('current', {
        nowMs: () => now,
        queryAbandonedDraftPrs: () => drafts as never,
        queryDraftPrInventory: () => ({ open: drafts as never, merged: [], complete: true }),
        queryRunningRuns: () => ({ entries: ['completed', 'stopped', 'running'].map((runId) => ({ runId, status: runId })) }) as never,
        queryTerminalRunStatuses: () => ({ completed: 'completed', stopped: 'stopped' }),
        viewDraftPr: openDraft,
        closeDraftPr: (url) => { closed.push(Number(url.split('/').at(-1))); return true; },
      });
    });
    expect(closed.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(devCli.draftPrCommandArgs(pr(1), 'close', 'stale-ended-run')).not.toContain('--delete-branch');
    expect(events).toContainEqual(expect.objectContaining({ event: 'draft-triage-start', data: expect.objectContaining({ decisions: expect.objectContaining({ live: 4, staleEndedRun: 8 }) }) }));
    const event = events.find(({ event }) => event === 'draft-triage-start')!;
    expect(Object.values((event.data as { decisions: Record<string, number> }).decisions).reduce((sum, value) => sum + value, 0)).toBe(12);
  });

  it('병합 제목·골 계보는 1시간 된 초안도 닫고 승인 라벨과 실제 live branch는 보존한다', async () => {
    const now = 40 * 3_600_000;
    const closed: Array<{ url: string; reason: string }> = [];
    const drafts = [
      { runId: 'finished', number: 21, url: pr(21), branch: 'self-impl/a-goalid-aabc1234-old', title: 'a', openedAtMs: now - 3_600_000 },
      { runId: 'finished', number: 22, url: pr(22), branch: 'self-impl/b-goalid-bbcd1234-old', title: 'b', openedAtMs: now - 3_600_000 },
      { runId: 'finished', number: 23, url: pr(23), branch: 'self-impl/c-goalid-ccde1234-old', title: 'c', openedAtMs: now - 40 * 3_600_000, labels: ['elanous:idea-approval'] },
      { runId: 'running', number: 24, url: pr(24), branch: 'self-impl/live', title: 'd', openedAtMs: 0 },
      { runId: 'finished', number: 25, url: pr(25), branch: 'self-impl/live', title: 'e', openedAtMs: 0 },
    ];
    const events = await observeRunExit('triage-merged-twins', async () => devCli.startDraftTriage('current', {
      nowMs: () => now,
      queryAbandonedDraftPrs: () => drafts as never,
      queryDraftPrInventory: () => ({ open: drafts, merged: [
        { number: 50, title: 'a', branch: 'self-impl/a-goalid-aabc1234-new' },
        { number: 51, title: 'different', branch: 'self-impl/b-goalid-bbcd1234-next' },
      ], complete: true }),
      queryRunningRuns: () => ({ entries: [{ runId: 'finished', status: 'unknown' }, { runId: 'running', status: 'running' }] }) as never,
      queryTerminalRunStatuses: () => ({ finished: 'completed' }),
      viewDraftPr: openDraft,
      closeDraftPr: (url, reason) => { closed.push({ url, reason }); return true; },
    }));
    expect(closed).toEqual([
      { url: pr(21), reason: '하니스 시작 트리아지: superseded-by #50' },
      { url: pr(22), reason: '하니스 시작 트리아지: superseded-by #51' },
    ]);
    expect(events).toContainEqual(expect.objectContaining({ event: 'draft-triage-start', data: expect.objectContaining({
      // DRAFT3 ③(#23421): a finished run's draft on a still-live branch is not «live» — kept as recent, branch untouched.
      decisions: { live: 1, superseded: 2, staleEndedRun: 0, recent: 1, humanApproval: 1 },
      statusesObserved: expect.objectContaining({ completed: 4, running: 1 }),
    }) }));
  });

  it('시작 트리아지는 launch runId로 회전한 후보 순서를 배치 조회와 처리에 사용한다', async () => {
    const launchRunId = 'run-alpha';
    const runIds = ['one', 'two', 'three', 'four'];
    const expectedOrder = devCli.rotateDraftTriageRuns(runIds, launchRunId);
    const batchCalls: string[][] = [];
    const events = await observeRunExit('start-draft-triage-rotated-order', async () => {
      devCli.startDraftTriage(launchRunId, {
        startDraftTriageBudgetMs: 100,
        nowMs: () => 0,
        queryAbandonedDraftPrs: () => runIds.map((runId, index) => ({ runId, number: index + 1, url: pr(index + 1), openedAtMs: index + 1 })) as never,
        queryRunningRuns: () => ({ entries: runIds.map((runId) => ({ runId, status: 'ended-unclosed' })) }) as never,
        queryTerminalDraftTriages: (ids) => { batchCalls.push([...ids]); return new Set(); },
        viewDraftPr: openDraft,
      });
    });

    expect(batchCalls).toEqual([expectedOrder]);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'draft-triage-start',
      data: expect.objectContaining({ considered: expectedOrder, budgetUnprocessed: 0, budgetExhausted: false }),
    }));
  });

  it('시작 트리아지는 execute 전에 끝난 런의 24시간 지난 draft를 모두 닫고 live draft는 보존한다', async () => {
    const calls: string[] = [];
    const closed: Array<{ url: string; comment: string }> = [];
    const comments: Array<{ url: string; comment: string }> = [];
    const events = await observeRunExit('start-draft-triage', async () => {
      await executeAfterStartDraftTriage('start draft triage', async () => {
        calls.push('execute');
        return selfResult();
      }, {
        runId: 'current',
        queryAbandonedDraftPrs: () => [
          { runId: 'ended', number: 1, url: pr(1), openedAtMs: 1 },
          { runId: 'ended', number: 2, url: pr(2), openedAtMs: 2 },
          { runId: 'live', number: 3, url: pr(3), openedAtMs: 3 },
          { runId: null, number: 4, url: pr(4), openedAtMs: 4 },
        ] as never,
        queryRunningRuns: () => ({ entries: [
          { runId: 'ended', status: 'ended-unclosed' },
          { runId: 'live', status: 'running' },
        ] }) as never,
        queryTerminalDraftTriages: () => new Set(),
        viewDraftPr: (url) => { calls.push(`view:${url}`); return openDraft(); },
        closeDraftPr: (url, comment) => { calls.push(`close:${url}`); closed.push({ url, comment }); return true; },
        commentDraftPr: (url, comment) => { comments.push({ url, comment }); return true; },
      });
    });
    expect(calls.indexOf('execute')).toBeGreaterThan(calls.indexOf(`close:${pr(1)}`));
    expect(closed).toEqual([{ url: pr(1), comment: '하니스 시작 트리아지: stale-ended-run' }, { url: pr(2), comment: '하니스 시작 트리아지: stale-ended-run' }]);
    expect(comments).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ event: 'draft-triage-start', data: expect.objectContaining({ runId: 'current', considered: ['ended'], closed: [1, 2], kept: [], closeFailed: [], decisions: expect.objectContaining({ live: 1, staleEndedRun: 2 }) }) }));
  });

  it('startDraftTriage를 독립 launch-start operation으로 export하며 주입 seam·현재 런 제외·event fields를 보존한다', async () => {
    const closed: string[] = [];
    const comments: string[] = [];
    const events = await observeRunExit('exported-start-draft-triage', async () => {
      devCli.startDraftTriage('current', {
        queryAbandonedDraftPrs: () => [
          { runId: 'current', number: 1, url: pr(1), openedAtMs: 1 },
          { runId: 'ended', number: 2, url: pr(2), openedAtMs: 2 },
          { runId: 'ended', number: 3, url: pr(3), openedAtMs: 3 },
        ] as never,
        queryRunningRuns: () => ({ entries: [{ runId: 'ended', status: 'ended-unclosed' }] }) as never,
        queryTerminalDraftTriages: () => new Set(),
        viewDraftPr: openDraft,
        closeDraftPr: (url) => { closed.push(url); return true; },
        commentDraftPr: (url) => { comments.push(url); return true; },
      });
    });

    expect(closed).toEqual([pr(2), pr(3)]);
    expect(comments).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'draft-triage-start',
      data: expect.objectContaining({
        runId: 'current', considered: ['ended'], closed: [2, 3], kept: [], closeFailed: [],
        runningRunsQueried: true,
      }),
    }));
  });

  it('export된 시작 트리아지는 실행기 없이 주입 조회를 쓰고 자기 run draft를 제외하며 사건을 한 번 남긴다', async () => {
    const queried: string[] = [];
    const events = await observeRunExit('start-draft-triage-direct-export', async () => {
      devCli.startDraftTriage('run-current', {
        queryAbandonedDraftPrs: () => {
          queried.push('drafts');
          return [
            { runId: 'run-current', number: 1, url: pr(1), openedAtMs: 1 },
            { runId: 'run-ended', number: 2, url: pr(2), openedAtMs: 2 },
          ] as never;
        },
        queryRunningRuns: () => {
          queried.push('running');
          return { entries: [{ runId: 'run-ended', status: 'ended-unclosed' }] } as never;
        },
        queryTerminalDraftTriages: () => new Set(),
        viewDraftPr: openDraft,
      });
    });

    expect(queried).toEqual(['drafts', 'running']);
    expect(events.filter(({ event }) => event === 'draft-triage-start')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ runId: 'run-current', considered: ['run-ended'], closed: [], kept: [], closeFailed: [2] }) }),
    ]);
  });

  it('시작 트리아지는 네 단계별 소요와 계상되지 않은 시간을 기존 사건 칸과 함께 기록한다', async () => {
    let now = 0;
    const events = await observeRunExit('start-draft-triage-stage-durations', async () => {
      devCli.startDraftTriage('current', {
        startDraftTriageBudgetMs: 1_000,
        nowMs: () => now,
        queryAbandonedDraftPrs: () => {
          now += 11;
          return [
            { runId: 'ended', number: 1, url: pr(1), openedAtMs: 1 },
            { runId: 'ended', number: 2, url: pr(2), openedAtMs: 2 },
          ] as never;
        },
        queryTerminalDraftTriages: () => {
          now += 13;
          return new Set();
        },
        queryRunningRuns: () => {
          now += 17;
          return { entries: [{ runId: 'ended', status: 'ended-unclosed' }] } as never;
        },
        viewDraftPr: () => {
          now += 19;
          return openDraft();
        },
        closeDraftPr: () => {
          now += 23;
          return true;
        },
        commentDraftPr: () => true,
      });
    });

    expect(events).toContainEqual(expect.objectContaining({
      event: 'draft-triage-start',
      data: expect.objectContaining({
        considered: ['ended'], closed: [], kept: [1, 2], closeFailed: [],
        budgetUnprocessed: 0, budgetExhausted: false, runningRunsQueried: true,
        elapsedMs: 79,
        draftListDurationMs: 11,
        terminalTriageDurationMs: 13,
        runningRunsDurationMs: 17,
        draftViewDurationMs: 38,
        unaccountedDurationMs: 0,
      }),
    }));
  });

  it('범위 메타데이터 없는 running-runs seam은 미조회 우주 수를 0으로 접지 않는다', async () => {
    const events = await observeRunExit('start-draft-triage-running-runs-unknown-scope', async () => {
      devCli.startDraftTriage('current', {
        queryAbandonedDraftPrs: () => [{ runId: 'ended', number: 1, url: pr(1), openedAtMs: 1 }] as never,
        queryTerminalDraftTriages: () => new Set(),
        queryRunningRuns: () => ({ entries: [{ runId: 'ended', status: 'ended-unclosed' }] }) as never,
        viewDraftPr: openDraft,
      });
    });
    expect(events).toContainEqual(expect.objectContaining({
      event: 'draft-triage-start',
      data: expect.objectContaining({ runningRunsQueried: true, runningRunsUnqueriedUniverseCount: null }),
    }));
  });

  it('시작 트리아지는 범위를 줄인 running-runs 조회의 미조회 우주 수를 보존하고 격리 live 런을 건너뛴다', async () => {
    const observations: Array<number | null> = [];
    for (const unqueriedUniverseCount of [0, 3, null] as const) {
      let now = 0;
      // ⭐ 조회는 «한 번»이어야 한다 — 후보 선별 앞뒤로 «두 번» 도는 판이 실제로 있었다(#18622 인수 충돌 ⓐ).
      let runningRunsQueries = 0;
      const events = await observeRunExit(`start-draft-triage-scoped-running-runs-${String(unqueriedUniverseCount)}`, async () => {
        devCli.startDraftTriage('current', {
          startDraftTriageBudgetMs: 100,
          nowMs: () => now,
          queryAbandonedDraftPrs: () => [
            { runId: 'isolated-running', number: 1, url: pr(1), openedAtMs: 1 },
            { runId: 'isolated-probable', number: 2, url: pr(2), openedAtMs: 2 },
          ] as never,
          queryTerminalDraftTriages: () => new Set(),
          queryRunningRuns: () => {
            runningRunsQueries += 1;
            now += 10;
            return {
              result: { entries: [
                { runId: 'isolated-running', status: 'running' },
                { runId: 'isolated-probable', status: 'probable-running' },
              ] },
              unqueriedUniverseCount,
            } as never;
          },
        });
      });
      const event = events.find(({ event }) => event === 'draft-triage-start');
      expect(event).toEqual(expect.objectContaining({ data: expect.objectContaining({
        runningRunsQueried: true,
        runningRunsUnqueriedUniverseCount: unqueriedUniverseCount,
        runningRunsDurationMs: 10,
        elapsedMs: 10,
        decisions: expect.objectContaining({ live: 2 }),
      }) }));
      expect(runningRunsQueries).toBe(1);
      observations.push((event!.data as { runningRunsUnqueriedUniverseCount: number | null }).runningRunsUnqueriedUniverseCount);
    }
    expect(observations).toEqual([0, 3, null]);
  });

  it('scoped running-runs 조회는 실제 ledger·PTY 분류기를 통해 제외 우주의 running/probable-running을 보존한다', () => {
    const scopedTarget = { name: 'current', dbPath: '/current/logs.db' };
    const excludedTarget = { name: 'isolated', dbPath: '/isolated/logs.db' };
    const ledgers = (targetName: string) => ({
      entries: targetName === 'current'
        ? [{ runId: 'same-live-run', lifecycle: 'live', ledgerDirectory: '/current/run-ledger', lastActivityTimestamp: '2026-09-17T00:00:00.000Z' }]
        : [
          { runId: 'same-live-run', lifecycle: 'live', ledgerDirectory: '/isolated/run-ledger', lastActivityTimestamp: '2026-09-17T00:00:01.000Z' },
          { runId: 'isolated-only-live', lifecycle: 'live', ledgerDirectory: '/isolated/run-ledger', lastActivityTimestamp: '2026-09-17T00:00:02.000Z' },
        ],
      ledgerDirectories: [`/${targetName}/run-ledger`], goalsDirectory: '/goals', unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0,
      reconciledTerminatedElsewhereCount: 0, scope: 'self-implement-run-ledger-federated', note: 'fixture',
      missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0,
    });
    const classify = ((_: { includeTest?: boolean }, queryDeps: Parameters<typeof queryRunningRuns>[1] = {}) => {
      const targetName = queryDeps.ptyTargets!({})[0]?.name ?? 'current';
      return queryRunningRuns({}, {
        ...queryDeps,
        queryLedgers: () => ledgers(targetName) as never,
        listPtyRefs: () => ({ refs: targetName === 'isolated'
          ? [{ instance: 'isolated', id: 'pty-1', kind: 'codex' as const, alive: true, runId: 'same-live-run' }]
          : [], unreadable: [] }),
        loadRun: () => null,
        isProcessAlive: () => false,
        processStartedAt: () => null,
      });
    }) as never;
    const result = devCli.queryScopedRunningRuns({
      resolveLogTargets: ((options: { all?: boolean }) => options.all
        ? { targets: [scopedTarget, excludedTarget] }
        : { targets: [scopedTarget] }) as never,
      resolveFederatedRunLedgerDirectories: (({ targets }: { targets: readonly { name: string }[] }) => targets.map(({ name }) => `/${name}/run-ledger`)) as never,
      queryFederatedUnfinishedRunLedgers: (() => ({ entries: [], ledgerDirectories: [] })) as never,
      queryRunningRuns: classify,
      collectObservedRunPhases: (() => ({ events: [], targetCount: 0, unreadableTargets: [] })) as never,
    });

    expect(result).toMatchObject({
      unqueriedUniverseCount: 1,
      result: {
        counts: { running: 1, 'probable-running': 1, 'ended-unclosed': 0, unknown: 0 }, total: 2,
        quantities: { running: { value: 2 }, total: { value: 2 }, entries: { value: 2 } },
        entries: [
          expect.objectContaining({ runId: 'same-live-run', status: 'running', reason: 'ledger-live-and-pty-alive' }),
          expect.objectContaining({ runId: 'isolated-only-live', status: 'probable-running', reason: 'ledger-without-live-pty' }),
        ],
      },
    });
  });

  it('scoped running-runs 조회는 우주 inventory를 읽지 못하면 종료 후보를 unknown으로 보류한다', () => {
    const ended = { runId: 'ended', status: 'ended-unclosed' as const };
    const base = {
      entries: [ended], counts: { running: 0, 'probable-running': 0, 'ended-unclosed': 1, unknown: 0 }, total: 1,
      quantities: { counts: { value: { running: 0, 'probable-running': 0, 'ended-unclosed': 1, unknown: 0 } }, total: { value: 1 }, entries: { value: 1 }, running: { value: 0 } },
    } as never;
    let targetCalls = 0;
    const result = devCli.queryScopedRunningRuns({
      resolveLogTargets: (() => {
        targetCalls += 1;
        if (targetCalls === 1) return { targets: [{ name: 'current', dbPath: '/current/logs.db' }] };
        throw new Error('inventory unavailable');
      }) as never,
      resolveFederatedRunLedgerDirectories: (() => []) as never,
      queryFederatedUnfinishedRunLedgers: (() => ({ entries: [], ledgerDirectories: [] })) as never,
      queryRunningRuns: (() => base) as never,
      collectObservedRunPhases: (() => ({ events: [], targetCount: 0, unreadableTargets: [] })) as never,
    });
    expect(result).toMatchObject({
      unqueriedUniverseCount: null,
      result: { counts: { running: 0, 'probable-running': 0, 'ended-unclosed': 0, unknown: 1 }, entries: [expect.objectContaining({ runId: 'ended', status: 'unknown' })] },
    });
  });

  it('시작 트리아지는 비배치 terminal-triage seam의 소요도 terminal 단계에 기록한다', async () => {
    let now = 0;
    const events = await observeRunExit('start-draft-triage-non-batch-terminal-duration', async () => {
      devCli.startDraftTriage('current', {
        startDraftTriageBudgetMs: 1_000,
        nowMs: () => now,
        queryAbandonedDraftPrs: () => {
          now += 11;
          return [{ runId: 'already-triaged', number: 1, url: pr(1), openedAtMs: 1 }] as never;
        },
        queryRunningRuns: () => ({ entries: [{ runId: 'already-triaged', status: 'ended-unclosed' }] }) as never,
        hasTerminalDraftTriage: () => {
          now += 13;
          return true;
        },
      });
    });

    expect(events).toContainEqual(expect.objectContaining({
      event: 'draft-triage-start',
      data: expect.objectContaining({
        decisions: expect.any(Object),
        runningRunsQueried: true,
        draftListDurationMs: 11,
        terminalTriageDurationMs: 13,
        runningRunsDurationMs: 0,
        draftViewDurationMs: 0,
        elapsedMs: 24,
        unaccountedDurationMs: 0,
      }),
    }));
  });

  it('시작 트리아지는 전체 초기 후보를 주입 배치 조회 한 번으로 걸러 런 상태와 draft 검토까지 진행한다', async () => {
    const batchCalls: Array<{ runIds: readonly string[]; timeoutMs: number | undefined }> = [];
    const runningQueries: string[] = [];
    const viewed: string[] = [];
    const drafts = Array.from({ length: 20 }, (_, index) => ({
      runId: `run-${index + 1}`, number: index + 1, url: pr(index + 1), openedAtMs: index + 1,
    }));
    const events = await observeRunExit('start-draft-triage-injected-batch', async () => {
      devCli.startDraftTriage('current', {
        startDraftTriageBudgetMs: 100,
        nowMs: () => 0,
        queryAbandonedDraftPrs: () => drafts as never,
        queryTerminalDraftTriages: (runIds, timeoutMs) => {
          batchCalls.push({ runIds, timeoutMs });
          return new Set(runIds.slice(0, 6));
        },
        queryRunningRuns: () => {
          runningQueries.push('running');
          return { entries: drafts.map(({ runId }) => ({ runId, status: 'ended-unclosed' })) } as never;
        },
        viewDraftPr: (url) => { viewed.push(url); return openDraft(); },
      });
    });

    expect(batchCalls).toEqual([{ runIds: devCli.rotateDraftTriageRuns(drafts.map(({ runId }) => runId), 'current'), timeoutMs: 100 }]);
    expect(runningQueries).toEqual(['running']);
    expect(viewed.length).toBeGreaterThan(0);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'draft-triage-start',
      data: expect.objectContaining({ decisions: expect.objectContaining({ recent: 20 }), runningRunsQueried: true }),
    }));
  });

  it('느린 주입 런 조회 뒤에도 예산 안에서 draft를 검토하고 격리 running 상태를 보존한다', async () => {
    let now = 0;
    const viewed: string[] = [];
    const closed: string[] = [];
    const events = await observeRunExit('start-draft-triage-slow-running-query-boundary', async () => {
      devCli.startDraftTriage('current', {
        startDraftTriageBudgetMs: 100,
        nowMs: () => now,
        queryAbandonedDraftPrs: () => {
          now += 5;
          return [
            { runId: 'running', number: 1, url: pr(1), openedAtMs: 1 },
            { runId: 'probable', number: 2, url: pr(2), openedAtMs: 2 },
            { runId: 'ended', number: 3, url: pr(3), openedAtMs: 3 },
            { runId: 'outside-query-scope', number: 4, url: pr(4), openedAtMs: 4 },
          ] as never;
        },
        queryTerminalDraftTriages: () => {
          now += 5;
          return new Set();
        },
        queryRunningRuns: () => {
          now += 20;
          return { entries: [
            { runId: 'running', status: 'running' },
            { runId: 'probable', status: 'probable-running' },
            { runId: 'ended', status: 'ended-unclosed' },
          ] } as never;
        },
        viewDraftPr: (url) => {
          now += 40;
          viewed.push(url);
          return openDraft();
        },
        closeDraftPr: (url) => { closed.push(url); return true; },
      });
    });

    expect(viewed).toEqual([pr(3), pr(4)]);
    expect(closed).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'draft-triage-start',
      data: expect.objectContaining({
        considered: ['ended', 'outside-query-scope'], kept: [3], closed: [], budgetUnprocessed: 1, budgetExhausted: true,
        elapsedMs: 110, runningRunsDurationMs: 20, draftViewDurationMs: 80,
      }),
    }));
  });

  it('시작 트리아지는 가짜 draft r1·r2의 runId를 도는 런 조회에 그대로 넘긴다', async () => {
    const queried: string[][] = [];
    const events = await observeRunExit('start-draft-triage-queried-run-ids', async () => {
      devCli.startDraftTriage('current', {
        queryAbandonedDraftPrs: () => [
          { runId: 'r1', number: 1, url: pr(1), openedAtMs: 1 },
          { runId: 'r2', number: 2, url: pr(2), openedAtMs: 2 },
        ] as never,
        queryRunningRuns: (_timeoutMs, runIds) => {
          queried.push([...(runIds ?? [])]);
          return { entries: [
            { runId: 'r1', status: 'ended-unclosed' },
            { runId: 'r2', status: 'ended-unclosed' },
          ] } as never;
        },
        queryTerminalDraftTriages: () => new Set(),
        viewDraftPr: openDraft,
        closeDraftPr: () => true,
      });
    });

    expect(queried).toEqual([['r1', 'r2']]);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'draft-triage-start',
      data: expect.objectContaining({ runningRunsQueried: true, runningRunsQueriedRunIds: 2 }),
    }));
  });

  it('시작 트리아지는 좁힌 조회에 없는 r2를 닫지 않고 unobserved 상태로 남긴다', async () => {
    const closed: string[] = [];
    const events = await observeRunExit('start-draft-triage-absent-run-stays-unknown', async () => {
      devCli.startDraftTriage('current', {
        queryAbandonedDraftPrs: () => [
          // DRAFT1 closes unobserved drafts older than a day — keep r2 fresh so this case stays «unobserved».
          { runId: 'r1', number: 1, url: pr(1), openedAtMs: Date.now() - 60_000 },
          { runId: 'r2', number: 2, url: pr(2), openedAtMs: Date.now() - 60_000 },
        ] as never,
        queryRunningRuns: () => ({ entries: [{ runId: 'r1', status: 'ended-unclosed' }] }) as never,
        queryTerminalDraftTriages: () => new Set(),
        viewDraftPr: openDraft,
        closeDraftPr: (url) => { closed.push(url); return true; },
      });
    });

    expect(closed).not.toContain(pr(2));
    expect(events).toContainEqual(expect.objectContaining({
      event: 'draft-triage-start',
      data: expect.objectContaining({ statusesObserved: expect.objectContaining({ unobserved: 1 }) }),
    }));
  });

  it('시작 트리아지는 초기 배치 조회 전 예산이 소진되면 런을 미처리로 남기고 즉시 돌아온다', async () => {
    const batchCalls: string[][] = [];
    let now = 0;
    const events = await observeRunExit('start-draft-triage-batch-budget', async () => {
      devCli.startDraftTriage('current', {
        startDraftTriageBudgetMs: 1,
        nowMs: () => now,
        queryAbandonedDraftPrs: () => {
          now = 1;
          return [
            { runId: 'first', number: 1, url: pr(1), openedAtMs: 1 },
            { runId: 'second', number: 2, url: pr(2), openedAtMs: 2 },
          ] as never;
        },
        queryTerminalDraftTriages: (runIds) => { batchCalls.push([...runIds]); return new Set(); },
      });
    });

    expect(batchCalls).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'draft-triage-start',
      data: expect.objectContaining({ budgetUnprocessed: 2, budgetExhausted: true, runningRunsQueried: false }),
    }));
  });

  it('시작 트리아지는 배치 seam이 없으면 기본 배치 경계로 다중 후보의 상태와 draft를 검토한다', async () => {
    const runningQueries: string[] = [];
    const viewed: string[] = [];
    await observeRunExit('start-draft-triage-default-batch', async () => {
      devCli.startDraftTriage('current', {
        startDraftTriageBudgetMs: 5,
        nowMs: () => 0,
        queryAbandonedDraftPrs: () => [
          { runId: 'candidate-a', number: 1, url: pr(1), openedAtMs: 1 },
          { runId: 'candidate-b', number: 2, url: pr(2), openedAtMs: 2 },
        ] as never,
        queryRunningRuns: () => {
          runningQueries.push('running');
          return { entries: [
            { runId: 'candidate-a', status: 'ended-unclosed' },
            { runId: 'candidate-b', status: 'ended-unclosed' },
          ] } as never;
        },
        viewDraftPr: (url) => { viewed.push(url); return openDraft(); },
      });
    });
    expect(runningQueries).toEqual(['running']);
    expect(viewed).toEqual([pr(1), pr(2)]);
  });

  it('시작 트리아지는 단건·배치 seam이 함께 있으면 배치 seam을 우선해 전체 런을 한 번 판정한다', () => {
    const batchCalls: string[][] = [];
    const singleCalls: string[] = [];
    devCli.startDraftTriage('current', {
      startDraftTriageBudgetMs: 5,
      nowMs: () => 0,
      queryAbandonedDraftPrs: () => [
        { runId: 'terminal-run', number: 1, url: pr(1), openedAtMs: 1 },
        { runId: 'candidate-run', number: 2, url: pr(2), openedAtMs: 2 },
      ] as never,
      hasTerminalDraftTriage: (runId) => { singleCalls.push(runId); return false; },
      queryTerminalDraftTriages: (runIds) => {
        batchCalls.push([...runIds]);
        return new Set(['terminal-run']);
      },
      queryRunningRuns: () => ({ entries: [{ runId: 'candidate-run', status: 'ended-unclosed' }] }) as never,
      viewDraftPr: openDraft,
    });
    expect(batchCalls).toEqual([['terminal-run', 'candidate-run']]);
    expect(singleCalls).toEqual([]);
  });

  it('시작 트리아지는 예산보다 오래 막히는 seam 뒤 추가 후보를 시작하지 않고 실제 경과와 미처리를 관측한다', async () => {
    const viewed: string[] = [];
    const budgetMs = 10;
    const events = await observeRunExit('start-draft-triage-budget', async () => {
      const startedAt = Date.now();
      devCli.startDraftTriage('current', {
        startDraftTriageBudgetMs: budgetMs,
        queryAbandonedDraftPrs: () => [
          { runId: 'first', number: 1, url: pr(1), openedAtMs: 1 },
          { runId: 'first', number: 2, url: pr(2), openedAtMs: 2 },
          { runId: 'second', number: 3, url: pr(3), openedAtMs: 3 },
          { runId: 'third', number: 4, url: pr(4), openedAtMs: 4 },
        ] as never,
        queryRunningRuns: () => ({ entries: [
          { runId: 'first', status: 'ended-unclosed' },
          { runId: 'second', status: 'ended-unclosed' },
          { runId: 'third', status: 'ended-unclosed' },
        ] }) as never,
        queryTerminalDraftTriages: () => new Set(),
        viewDraftPr: (url, timeoutMs) => {
          viewed.push(url);
          expect(timeoutMs).toBeGreaterThan(0);
          Bun.sleepSync(budgetMs * 3);
          return openDraft();
        },
      });
      // A synchronous injected seam cannot be preempted; after it returns, triage must not start another candidate.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(budgetMs);
    });

    expect(viewed).toEqual([pr(1)]);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'draft-triage-start',
      data: expect.objectContaining({
        considered: ['first'], budgetUnprocessed: 3, elapsedMs: expect.any(Number),
      }),
    }));
  });

  it('시작 트리아지는 첫 생산 조회 timeout을 빈 결과로 접지 않고 미상 미처리·예산 소진으로 기록한다', async () => {
    const queried: string[] = [];
    const events = await observeRunExit('start-draft-triage-initial-query-timeout', async () => {
      devCli.startDraftTriage('current', {
        startDraftTriageBudgetMs: 10,
        nowMs: () => 10,
        queryAbandonedDraftPrs: (timeoutMs) => {
          queried.push(`drafts:${timeoutMs}`);
          return { kind: 'timeout' };
        },
        queryRunningRuns: () => {
          queried.push('running');
          return { entries: [] } as never;
        },
      });
    });

    expect(queried).toEqual(['drafts:10']);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'draft-triage-start',
      data: expect.objectContaining({
        considered: [], closed: [], kept: [], closeFailed: [], budgetUnprocessed: null,
        budgetExhausted: true, elapsedMs: 0, runningRunsQueried: false,
      }),
    }));
  });

  it('시작 트리아지는 상태 조회를 우선하고 예산으로 생략된 런을 숨기지 않으며 보호된 draft를 건드리지 않는다', async () => {
    const calls: string[] = [];
    const events = await observeRunExit('start-draft-triage-running-query-budget', async () => {
      let now = 0;
      devCli.startDraftTriage('current', {
        startDraftTriageBudgetMs: 10,
        nowMs: () => now,
        queryAbandonedDraftPrs: () => {
          now = 10;
          return [
            { runId: 'running', number: 1, url: pr(1), openedAtMs: 1 },
            { runId: 'probable', number: 2, url: pr(2), openedAtMs: 2 },
          ] as never;
        },
        queryRunningRuns: () => {
          calls.push('running');
          return { entries: [] } as never;
        },
        queryTerminalDraftTriages: () => {
          calls.push('terminal');
          return new Set();
        },
        viewDraftPr: () => {
          calls.push('view');
          return openDraft();
        },
        closeDraftPr: () => {
          calls.push('close');
          return true;
        },
      });
    });

    expect(calls).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'draft-triage-start',
      data: expect.objectContaining({
        considered: [], closed: [], kept: [], runningRunsQueried: false,
        budgetUnprocessed: 2, unobservedRuns: 2,
      }),
    }));
  });

  it('시작 트리아지는 예산 소진 전의 close 성공·실패와 retained를 보존하고 다음 run만 미처리로 센다', async () => {
    let now = 0;
    const events = await observeRunExit('start-draft-triage-partial-budget', async () => {
      devCli.startDraftTriage('current', {
        startDraftTriageBudgetMs: 10,
        nowMs: () => now,
        queryAbandonedDraftPrs: () => [
          { runId: 'first', number: 1, url: pr(1), openedAtMs: 1 },
          { runId: 'first', number: 2, url: pr(2), openedAtMs: 2 },
          { runId: 'first', number: 3, url: pr(3), openedAtMs: 3 },
          { runId: 'second', number: 4, url: pr(4), openedAtMs: 4 },
        ] as never,
        queryRunningRuns: () => ({ entries: [
          { runId: 'first', status: 'ended-unclosed' },
          { runId: 'second', status: 'ended-unclosed' },
        ] }) as never,
        queryTerminalDraftTriages: () => new Set(),
        viewDraftPr: openDraft,
        closeDraftPr: (url) => url === pr(1),
        commentDraftPr: () => { now = 10; return true; },
      });
    });

    expect(events).toContainEqual(expect.objectContaining({
      event: 'draft-triage-start',
      data: expect.objectContaining({
        considered: ['first', 'second'], closed: [], closeFailed: [], kept: [1, 2, 3, 4], budgetUnprocessed: 0,
      }),
    }));
  });

  it('시작 트리아지는 빠른 seam에서 기존 결과를 보존하고 budgetUnprocessed 0을 관측한다', async () => {
    const events = await observeRunExit('start-draft-triage-fast-budget', async () => {
      devCli.startDraftTriage('current', {
        startDraftTriageBudgetMs: 5,
        nowMs: () => 0,
        queryAbandonedDraftPrs: () => [
          { runId: 'ended', number: 1, url: pr(1), openedAtMs: 1 },
          { runId: 'ended', number: 2, url: pr(2), openedAtMs: 2 },
        ] as never,
        queryRunningRuns: () => ({ entries: [{ runId: 'ended', status: 'ended-unclosed' }] }) as never,
        queryTerminalDraftTriages: () => new Set(),
        viewDraftPr: openDraft,
        closeDraftPr: () => true,
        commentDraftPr: () => true,
      });
    });

    expect(events).toContainEqual(expect.objectContaining({
      event: 'draft-triage-start',
      data: expect.objectContaining({ considered: ['ended'], closed: [], kept: [1, 2], closeFailed: [], budgetUnprocessed: 0, elapsedMs: 0 }),
    }));
  });

  it('시작 트리아지는 빠른 경로에서 전체 런의 종결 기록을 한 번만 배치 조회한다', () => {
    const batchChecks: string[][] = [];
    devCli.startDraftTriage('current', {
      startDraftTriageBudgetMs: 5,
      nowMs: () => 0,
      queryAbandonedDraftPrs: () => [
        { runId: 'ended', number: 1, url: pr(1), openedAtMs: 1 },
        { runId: 'ended', number: 2, url: pr(2), openedAtMs: 2 },
      ] as never,
      queryRunningRuns: () => ({ entries: [{ runId: 'ended', status: 'ended-unclosed' }] }) as never,
      queryTerminalDraftTriages: (runIds) => { batchChecks.push([...runIds]); return new Set(); },
      viewDraftPr: openDraft,
      closeDraftPr: () => true,
      commentDraftPr: () => true,
    });
    expect(batchChecks).toEqual([['ended']]);
  });

  it('시작 트리아지 기본 원장 조회는 운영에서 7일·전 우주·test 포함 인자로 부른다', () => {
    const seen: unknown[] = [];
    const rows = devCli.defaultQueryAbandonedDraftPrs((options) => { seen.push(options); return []; }, false);
    expect(rows).toEqual([]);
    expect(seen).toEqual([{ all: true, includeTest: true }]);
    expect(devCli.START_DRAFT_TRIAGE_LEDGER_QUERY).toEqual({ all: true, includeTest: true });
  });

  it('시작 트리아지 기본 원장 조회는 시험 프로세스에서 조회를 부르지 않는다', () => {
    let calls = 0;
    const rows = devCli.defaultQueryAbandonedDraftPrs(() => { calls += 1; return []; }, true);
    expect(rows).toEqual([]);
    expect(calls).toBe(0);
  });

  it('시작 트리아지 기본 원장 조회는 소진된 생산 예산에서 blocking 조회를 시작하지 않는다', () => {
    let calls = 0;
    const rows = devCli.defaultQueryAbandonedDraftPrs(() => { calls += 1; return []; }, false, 0);
    expect(rows).toEqual([]);
    expect(calls).toBe(0);
  });

  it('생산 조회 subprocess는 양수 예산에서 느린 조회를 제한하고 신속히 timeout으로 분류한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'draft-triage-production-timeout-'));
    const modulePath = join(dir, 'slow-query.mjs');
    writeFileSync(modulePath, 'export function slow() { Bun.sleepSync(1_000); return []; }');
    try {
      const budgetMs = 100;
      const startedAt = Date.now();
      const result = devCli.runProductionQuery<readonly unknown[]>(new URL(`file://${modulePath}`).href, 'slow', [], budgetMs);
      const elapsedMs = Date.now() - startedAt;
      expect(result).toEqual({ kind: 'timeout' });
      expect(elapsedMs).toBeLessThan(budgetMs + 250);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('생산 조회 subprocess는 조회 실패와 malformed 출력을 timeout과 구별한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'draft-triage-production-error-'));
    const throwPath = join(dir, 'throws.mjs');
    const malformedPath = join(dir, 'malformed.mjs');
    writeFileSync(throwPath, 'export function query() { throw new Error("ledger unavailable"); }');
    writeFileSync(malformedPath, 'export function query() { return undefined; }');
    try {
      const failure = devCli.runProductionQuery<readonly unknown[]>(new URL(`file://${throwPath}`).href, 'query', [], 1_000);
      const malformed = devCli.runProductionQuery<readonly unknown[]>(new URL(`file://${malformedPath}`).href, 'query', [], 1_000);
      expect(failure).toEqual(expect.objectContaining({ kind: 'error', error: expect.stringContaining('ledger unavailable') }));
      expect(malformed).toEqual(expect.objectContaining({ kind: 'error', error: expect.any(String) }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('시작 트리아지는 중복 원장 draft를 한 번만 보고 여러 런의 retained draft를 모두 기록한다', async () => {
    const closed: string[] = [];
    const comments: string[] = [];
    const events = await observeRunExit('start-draft-triage-dedup-multi', async () => {
      await executeAfterStartDraftTriage('start triage duplicate and multiple', async () => selfResult(), {
        queryAbandonedDraftPrs: () => [
          { runId: 'first', number: 1, url: pr(1), openedAtMs: 1 },
          { runId: 'first', number: 1, url: pr(1), openedAtMs: 1 },
          { runId: 'first', number: 2, url: pr(2), openedAtMs: 2 },
          { runId: 'second', number: 3, url: pr(3), openedAtMs: 3 },
          { runId: 'second', number: 4, url: pr(4), openedAtMs: 4 },
        ] as never,
        queryRunningRuns: () => ({ entries: [
          { runId: 'first', status: 'ended-unclosed' },
          { runId: 'second', status: 'ended-unclosed' },
        ] }) as never,
        queryTerminalDraftTriages: () => new Set(),
        viewDraftPr: openDraft,
        closeDraftPr: (url) => { closed.push(url); return true; },
        commentDraftPr: (url) => { comments.push(url); return true; },
      });
    });
    expect(closed).toEqual([pr(1), pr(2), pr(3), pr(4)]);
    expect(comments).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ event: 'draft-triage-start', data: expect.objectContaining({ considered: ['first', 'second'], kept: [], decisions: expect.objectContaining({ staleEndedRun: 4 }) }) }));
  });

  it('시작 트리아지는 다음 발사에서 이미 닫힌 이전 draft를 다시 닫거나 코멘트하지 않는다', async () => {
    const closed: string[] = [];
    const comments: string[] = [];
    const alreadyClosed = new Set<string>();
    const seams = {
      runId: 'current',
      queryAbandonedDraftPrs: () => [
        { runId: 'ended', number: 1, url: pr(1), openedAtMs: 1 },
        { runId: 'ended', number: 2, url: pr(2), openedAtMs: 2 },
      ] as never,
      queryRunningRuns: () => ({ entries: [{ runId: 'ended', status: 'ended-unclosed' }] }) as never,
      queryTerminalDraftTriages: () => new Set<string>(),
      viewDraftPr: (url: string) => alreadyClosed.has(url) ? { isDraft: true, state: 'CLOSED' } : openDraft(),
      closeDraftPr: (url: string) => { closed.push(url); alreadyClosed.add(url); return true; },
      commentDraftPr: (url: string) => { comments.push(url); return true; },
    };
    await executeAfterStartDraftTriage('start triage repeat', async () => selfResult({ stage: 'merged', merged: true }), seams);
    await executeAfterStartDraftTriage('start triage repeat', async () => selfResult({ stage: 'merged', merged: true }), seams);
    expect(closed).toEqual([pr(1), pr(2)]);
    expect(comments).toEqual([]);
  });

  it('시작 트리아지는 실행과 반환을 보존하며 상태·종결기록·단일 draft를 건너뛴다', async () => {
    let executions = 0;
    const closed: string[] = [];
    const comments: string[] = [];
    let result!: Awaited<ReturnType<typeof devCli.executeDevSelfRun>>;
    const events = await observeRunExit('start-draft-triage-filters', async () => {
    result = await executeAfterStartDraftTriage('start triage filters', async () => {
      executions += 1;
      return selfResult({ stage: 'merged', merged: true });
    }, {
      queryAbandonedDraftPrs: () => [
        { runId: 'probable', number: 1, url: pr(1), openedAtMs: 1 },
        { runId: 'unknown', number: 2, url: pr(2), openedAtMs: 2 },
        { runId: 'triaged', number: 3, url: pr(3), openedAtMs: 3 },
        { runId: 'single', number: 4, url: pr(4), openedAtMs: 4 },
      ] as never,
      queryRunningRuns: () => ({ entries: [
        { runId: 'probable', status: 'probable-running' },
        { runId: 'unknown', status: 'unknown' },
        { runId: 'triaged', status: 'ended-unclosed' },
        { runId: 'single', status: 'ended-unclosed' },
      ] }) as never,
      queryTerminalDraftTriages: (runIds) => new Set([...runIds].filter((runId) => runId === 'triaged')),
      viewDraftPr: openDraft,
      closeDraftPr: (url) => { closed.push(url); return true; },
      commentDraftPr: (url) => { comments.push(url); return true; },
    });
    });
    expect(executions).toBe(1);
    expect(result.result.stage).toBe('merged');
    expect(closed).toEqual([pr(2), pr(3), pr(4)]);
    expect(comments).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ event: 'draft-triage-start', data: expect.objectContaining({ runId: null, closed: [2, 3, 4], decisions: expect.objectContaining({ live: 1, staleEndedRun: 3 }) }) }));
  });

  it('종결 트리아지 조회 실패는 PR 변경 없이 execute를 보존하고 error 사건을 남긴다', async () => {
    const closed: string[] = [];
    let executions = 0;
    const events = await observeRunExit('start-draft-triage-terminal-query-fail-open', async () => {
      await executeAfterStartDraftTriage('start triage terminal query failure', async () => {
        executions += 1;
        return selfResult({ stage: 'merged', merged: true });
      }, {
        queryAbandonedDraftPrs: () => [
          { runId: 'ended', number: 1, url: pr(1), openedAtMs: 1 },
          { runId: 'ended', number: 2, url: pr(2), openedAtMs: 2 },
        ] as never,
        queryRunningRuns: () => ({ entries: [{ runId: 'ended', status: 'ended-unclosed' }] }) as never,
        queryTerminalDraftTriages: () => { throw new Error('terminal store unavailable'); },
        viewDraftPr: openDraft,
        closeDraftPr: (url) => { closed.push(url); return true; },
      });
    });
    expect(executions).toBe(1);
    expect(closed).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ event: 'draft-triage-start', data: expect.objectContaining({ considered: [], error: 'terminal store unavailable' }) }));
  });

  it('시작 트리아지는 이전 draft 닫기가 실패하거나 이미 닫혔으면 retained draft에 코멘트하지 않는다', async () => {
    const comments: string[] = [];
    const failures = await observeRunExit('start-draft-triage-close-failure', async () => {
      await executeAfterStartDraftTriage('start triage close failure', async () => selfResult({ stage: 'merged', merged: true }), {
        queryAbandonedDraftPrs: () => [
          { runId: 'failed-close', number: 1, url: pr(1), openedAtMs: 1 },
          { runId: 'failed-close', number: 2, url: pr(2), openedAtMs: 2 },
        ] as never,
        queryRunningRuns: () => ({ entries: [{ runId: 'failed-close', status: 'ended-unclosed' }] }) as never,
        queryTerminalDraftTriages: () => new Set(),
        viewDraftPr: openDraft,
        closeDraftPr: () => false,
        commentDraftPr: (url: string) => { comments.push(url); return true; },
      });
    });
    expect(comments).toEqual([]);
    expect(failures).toContainEqual(expect.objectContaining({ event: 'draft-triage-start', data: expect.objectContaining({ closeFailed: [1, 2] }) }));

    await executeAfterStartDraftTriage('start triage already closed', async () => selfResult({ stage: 'merged', merged: true }), {
      queryAbandonedDraftPrs: () => [
        { runId: 'already-closed', number: 1, url: pr(1), openedAtMs: 1 },
        { runId: 'already-closed', number: 2, url: pr(2), openedAtMs: 2 },
      ] as never,
      queryRunningRuns: () => ({ entries: [{ runId: 'already-closed', status: 'ended-unclosed' }] }) as never,
      queryTerminalDraftTriages: () => new Set(),
      viewDraftPr: (url: string) => url === pr(1) ? { isDraft: true, state: 'CLOSED' } : openDraft(),
      closeDraftPr: () => { throw new Error('must not close'); },
      commentDraftPr: (url: string) => { comments.push(url); return true; },
    });
    expect(comments).toEqual([]);
  });

  it('batch terminal draft-triage query scans each target once and returns only requested triaged runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'batch-terminal-draft-triage-'));
    const firstDbPath = join(dir, 'first.db');
    const secondDbPath = join(dir, 'second.db');
    const first = new LogStore(firstDbPath);
    const second = new LogStore(secondDbPath);
    const terminal = (runId: string, draftTriage?: unknown) => ({
      rec: {
        ts: new Date().toISOString(), category: 'self-implement' as const, event: 'run-terminal' as const, level: 'info' as const,
        data: { runId, ...(draftTriage === undefined ? {} : { draftTriage }) },
      },
      surface: 'cli' as const,
    });
    first.insertBatch([terminal('triaged-first', {}), terminal('', {}), terminal('untriaged')]);
    second.insertBatch([terminal('triaged-second', {}), terminal('other', {})]);
    first.close();
    second.close();
    const restoreTargets = spyOn(logsCli, 'resolveLogTargets').mockReturnValue({
      targets: [{ name: 'first', dbPath: firstDbPath }, { name: 'second', dbPath: secondDbPath }],
    });
    try {
      expect(devCli.queryTerminalDraftTriages([' '])).toEqual(new Set());
      expect(restoreTargets).not.toHaveBeenCalled();
      expect(devCli.queryTerminalDraftTriages(['triaged-first', ' ', 'untriaged', 'triaged-second', 'missing', 'triaged-first']))
        .toEqual(new Set(['triaged-first', 'triaged-second']));
      expect(devCli.queryTerminalDraftTriageRunIds(['triaged-first', ' ', 'triaged-second', 'missing']))
        .toEqual(['triaged-first', 'triaged-second']);
      expect(devCli.queryTerminalDraftTriages([' '])).toEqual(new Set());
    } finally {
      restoreTargets.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('start triage uses one batch terminal lookup for all default-path candidates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'start-batch-terminal-draft-triage-'));
    const dbPath = join(dir, 'logs.db');
    const store = new LogStore(dbPath);
    store.insertBatch([{
      rec: {
        ts: new Date().toISOString(), category: 'self-implement', event: 'run-terminal', level: 'info',
        data: { runId: 'already-triaged', draftTriage: {} },
      },
      surface: 'cli',
    }]);
    store.close();
    const restoreTargets = spyOn(logsCli, 'resolveLogTargets').mockReturnValue({ targets: [{ name: 'batch', dbPath }] });
    const closed: string[] = [];
    try {
      const events = await observeRunExit('start-triage-batch-terminal-lookup', async () => {
        await executeAfterStartDraftTriage('start triage batch terminal lookup', async () => selfResult({ stage: 'merged', merged: true }), {
          queryAbandonedDraftPrs: () => [
          { runId: 'already-triaged', number: 1, url: pr(1), openedAtMs: 1 },
          { runId: 'eligible', number: 2, url: pr(2), openedAtMs: 2 },
          { runId: 'eligible', number: 3, url: pr(3), openedAtMs: 3 },
        ] as never,
        queryRunningRuns: () => ({ entries: [
          { runId: 'already-triaged', status: 'ended-unclosed' },
          { runId: 'eligible', status: 'ended-unclosed' },
        ] }) as never,
        viewDraftPr: openDraft,
          closeDraftPr: (url: string) => { closed.push(url); return true; },
        });
      });
      expect(closed).toEqual([pr(1), pr(2), pr(3)]);
      expect(events).toContainEqual(expect.objectContaining({
        event: 'draft-triage-start',
        data: expect.objectContaining({
          decisions: expect.any(Object),
          budgetUnprocessed: 0,
        }),
      }));
      expect(restoreTargets).toHaveBeenCalledTimes(0);
    } finally {
      restoreTargets.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('malformed terminal draftTriage lookup fails open without changing a draft', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'start-draft-triage-malformed-'));
    const dbPath = join(dir, 'logs.db');
    const store = new LogStore(dbPath);
    store.insertBatch([{
      rec: {
        ts: new Date().toISOString(),
        category: 'self-implement',
        event: 'run-terminal',
        level: 'info',
        data: { runId: 'ended' },
      },
      surface: 'cli',
    }]);
    store.close();
    new Database(dbPath).run("UPDATE logs SET data = '{ malformed' WHERE event = 'run-terminal'");
    const restoreTargets = spyOn(logsCli, 'resolveLogTargets').mockReturnValue({
      targets: [{ name: 'malformed-terminal', dbPath }],
    });
    const closed: string[] = [];
    let executions = 0;
    try {
      const events = await observeRunExit('start-draft-triage-malformed-terminal', async () => {
        await executeAfterStartDraftTriage('start triage malformed terminal', async () => {
          executions += 1;
          return selfResult({ stage: 'merged', merged: true });
        }, {
          queryAbandonedDraftPrs: () => [
            { runId: 'ended', number: 1, url: pr(1), openedAtMs: 1 },
            { runId: 'ended', number: 2, url: pr(2), openedAtMs: 2 },
          ] as never,
          queryRunningRuns: () => ({ entries: [{ runId: 'ended', status: 'ended-unclosed' }] }) as never,
          viewDraftPr: openDraft,
          closeDraftPr: (url: string) => { closed.push(url); return true; },
        });
      });
      expect(executions).toBe(1);
      expect(closed).toEqual([pr(1), pr(2)]);
      expect(events).toContainEqual(expect.objectContaining({
        event: 'draft-triage-start',
        data: expect.objectContaining({ considered: ['ended'], decisions: expect.objectContaining({ staleEndedRun: 2 }) }),
      }));
    } finally {
      restoreTargets.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('대상이 없어도 시작 트리아지 사건을 정확히 한 번 남긴다', async () => {
    const events = await observeRunExit('start-draft-triage-no-targets', async () => {
      await executeAfterStartDraftTriage('start triage no targets', async () => selfResult(), {
        queryAbandonedDraftPrs: () => [],
      });
    });
    expect(events.filter(({ event }) => event === 'draft-triage-start')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ considered: [], closed: [], kept: [], closeFailed: [], decisions: expect.any(Object), runningRunsQueried: false }) }),
    ]);
  });

  it('주입 없는 시작 트리아지는 빈 후보에서 running-runs 조회 없이 execute를 보존한다', async () => {
    let executions = 0;
    const events = await observeRunExit('start-draft-triage-default-empty', async () => {
      await executeAfterStartDraftTriage('start triage default empty', async () => {
        executions += 1;
        return selfResult({ stage: 'merged', merged: true });
      });
    });
    expect(executions).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'draft-triage-start',
      data: expect.objectContaining({ considered: [], runningRunsQueried: false }),
    }));
  });

  it('시작 트리아지 조회 실패도 execute를 막지 않고 error 사건을 남긴다', async () => {
    let executions = 0;
    const events = await observeRunExit('start-draft-triage-fail-open', async () => {
      await executeAfterStartDraftTriage('start triage failure', async () => {
        executions += 1;
        return selfResult({ stage: 'merged', merged: true });
      }, { queryAbandonedDraftPrs: () => { throw new Error('ledger unavailable'); } });
    });
    expect(executions).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ event: 'draft-triage-start', data: expect.objectContaining({ considered: [], error: 'ledger unavailable' }) }));
  });

  it('종결 트리아지는 첫 실행 draft를 수렴한 조각 병합 번호와 함께 닫고 terminal에 기록한다', async () => {
    const closed: Array<{ url: string; comment: string }> = [];
    const events = await observeRunExit('draft-triage-converged', async () => {
      await devCli.executeDevSelfRun('draft triage', async () => selfResult({ prUrl: pr(1), prNumber: 1 }), {
        ...promotedConvergedOptions(),
        executePiece: async (feature) => selfResult({ stage: 'merged', merged: true, prNumber: feature === 'part a' ? 2 : 3 }),
        viewDraftPr: openDraft,
        closeDraftPr: (url, comment) => { closed.push({ url, comment }); return true; },
      });
    });
    expect(closed).toEqual([{ url: pr(1), comment: expect.stringContaining('#2 #3') }]);
    expectTerminalWithoutFinalStatus(events, { draftTriage: { closed: [1], kept: null, closeFailed: [], skippedNotDraft: [] } });
  });

  it('비수렴 종결은 URL 별 «마지막 관측» 순서로 최신 하나만 남긴다 — A→B→A 면 최신은 A', async () => {
    const closed: Array<{ url: string; comment: string }> = [];
    const kept: Array<{ url: string; comment: string }> = [];
    const events = await observeRunExit('draft-triage-reappearance', async () => {
      const urls = [pr(1), pr(2), pr(1)];
      let turn = 0;
      await devCli.executeDevSelfRun('draft triage', async () => selfResult({ prUrl: urls[Math.min(turn++, urls.length - 1)] }), {
        rounds: 2,
        viewDraftPr: lineageDraft,
        closeDraftPr: (url, comment) => { closed.push({ url, comment }); return true; },
        commentDraftPr: (url, comment) => { kept.push({ url, comment }); return true; },
      });
    });
    expect(closed).toEqual([{ url: pr(2), comment: '하니스 종결 트리아지: 최신 산출 #1 로 대체됨' }]);
    expect(kept.map(({ url }) => url)).toEqual([pr(1)]);
    expect(kept[0]!.comment).toContain('멈춘 사유 max-rounds');
    expect(kept[0]!.comment).toContain('이 draft 가 이 골의 유일한 사람 판단 대상');
    expectTerminalWithoutFinalStatus(events, { draftTriage: { closed: [2], kept: [1], closeFailed: [], skippedNotDraft: [] } });
  });

  it('비수렴 종결은 같은 계보 A만 #B로 대체하고 다른 조각 C와 B를 남긴다', async () => {
    const branches = [
      'self-impl/at-the-existing-pod-job-launch-path-in-s-54a32edd-r9a5cf3',
      'self-impl/at-the-existing-pod-job-launch-path-in-s-54a32edd-r1b2c3d',
      'self-impl/in-the-existing-collectpodartifacts-retu-22aaa333-r9a5cf3',
    ];
    const closed: Array<{ url: string; comment: string }> = [];
    const kept: Array<{ url: string; comment: string }> = [];
    const logs: Array<{ category: string; event: string; data: unknown }> = [];
    const sink = spyOn(debug, 'log').mockImplementation((category, event, data) => { logs.push({ category, event, data }); });
    let turn = 0;
    let terminalTriage: unknown;
    try {
      await devCli.executeDevSelfRun('distinct pieces', async () => selfResult({ prUrl: pr(++turn) }), {
        rounds: 2,
        viewDraftPr: (url) => ({ ...openDraft(), headRefName: branches[Number(url.split('/').at(-1)) - 1] }),
        closeDraftPr: (url, comment) => { closed.push({ url, comment }); return true; },
        commentDraftPr: (url, comment) => { kept.push({ url, comment }); return true; },
      });
      terminalTriage = logs.find(({ category, event }) => category === 'self-implement' && event === 'run-terminal')?.data;
    } finally { sink.mockRestore(); }
    expect(terminalTriage).toEqual(expect.objectContaining({ draftTriage: { closed: [1], kept: [2, 3], closeFailed: [], skippedNotDraft: [] } }));
    expect(closed).toEqual([{ url: pr(1), comment: '하니스 종결 트리아지: 최신 산출 #2 로 대체됨' }]);
    expect(kept.map(({ url }) => url).sort()).toEqual([pr(2), pr(3)]);
    expect(kept.every(({ comment }) => comment.includes('사람 판단 대상') && !comment.includes('유일한'))).toBe(true);
    expect(logs).toContainEqual({ category: 'self-dev.triage', event: 'kept-distinct-piece', data: {
      pr: 2, lineage: 'at-the-existing-pod-job-launch-path-in-s', keptLineage: 'in-the-existing-collectpodartifacts-retu',
    } });
    expect(logs).toContainEqual({ category: 'self-dev.triage', event: 'kept-distinct-piece', data: {
      pr: 3, lineage: 'in-the-existing-collectpodartifacts-retu', keptLineage: 'at-the-existing-pod-job-launch-path-in-s',
    } });
  });

  it('headRefName 을 못 읽은 열린 draft는 다른 계보의 대체 대상으로 닫지 않는다', async () => {
    const closed: string[] = [];
    const kept: string[] = [];
    let turn = 0;
    const events = await observeRunExit('draft-triage-unknown-branch', async () => {
      await devCli.executeDevSelfRun('unknown branch', async () => selfResult({ prUrl: pr(++turn) }), {
        rounds: 1,
        viewDraftPr: (url) => url === pr(1) ? { ...openDraft(), headRefName: null as never } : lineageDraft(url),
        closeDraftPr: (url) => { closed.push(url); return true; },
        commentDraftPr: (url) => { kept.push(url); return true; },
      });
    });
    expect(closed).toEqual([]);
    expect(kept).toEqual([pr(1), pr(2)]);
    expectTerminalWithoutFinalStatus(events, { draftTriage: { closed: [], kept: [1, 2], closeFailed: [], skippedNotDraft: [] } });
  });

  it('collectRunDraftPrUrls 는 나중에 merged 로 다시 온 URL 을 빼고 마지막 관측 순서를 지킨다', () => {
    expect(devCli.collectRunDraftPrUrls([
      { prUrl: pr(1) }, { prUrl: pr(2) }, { prUrl: pr(1), merged: true }, { prUrl: pr(3) }, { prUrl: pr(2) },
    ])).toEqual([pr(3), pr(2)]);
  });

  it('일부 조각만 병합되고 max-rounds 로 멈추면 «수렴 아님» — 전부 닫지 않고 최신 draft 하나를 남긴다', async () => {
    const closed: string[] = [];
    const kept: Array<{ url: string; comment: string }> = [];
    const execution = await devCli.executeDevSelfRun('draft triage', async () => selfResult({ prUrl: pr(1) }), {
      ...promotedConvergedOptions(),
      executePiece: async (feature) => selfResult(feature === 'part a'
        ? { stage: 'merged', merged: true, prUrl: pr(5), prNumber: 5 }
        : { prUrl: pr(4) }),
      viewDraftPr: lineageDraft,
      closeDraftPr: (url) => { closed.push(url); return true; },
      commentDraftPr: (url, comment) => { kept.push({ url, comment }); return true; },
    });
    expect(execution.supervisorStopReason).toBe('max-rounds');
    expect(kept).toHaveLength(1);
    expect(closed).toHaveLength(1);
    expect([...closed, kept[0]!.url].sort()).toEqual([pr(1), pr(4)]);
    expect(kept[0]!.comment).toContain('착지한 조각 PR #5');
  });

  it('닫기 직전 조회가 OPEN draft 가 아니면(일반 PR·조회 실패) 닫지 않고 skippedNotDraft 로 남긴다', async () => {
    const closed: string[] = [];
    const events = await observeRunExit('draft-triage-not-draft', async () => {
      await devCli.executeDevSelfRun('draft triage', async () => selfResult({ prUrl: pr(1), prNumber: 1 }), {
        ...promotedConvergedOptions(),
        executePiece: async (feature) => selfResult(feature === 'part a' ? { prUrl: pr(4) } : { stage: 'merged', merged: true, prNumber: 5 }),
        viewDraftPr: (url) => (url === pr(1) ? { isDraft: false, state: 'OPEN' } : null),
        closeDraftPr: (url) => { closed.push(url); return true; },
      });
    });
    expect(closed).toEqual([]);
    expectTerminalWithoutFinalStatus(events, { draftTriage: expect.objectContaining({ closed: [], kept: null, skippedNotDraft: expect.arrayContaining([1, 4]) }) });
  });

  it('human-stopped 조기 종결은 설정 상한이 아닌 감독 판정 라운드 수를 남긴 draft 코멘트에 적는다', async () => {
    const kept: Array<{ url: string; comment: string }> = [];
    await devCli.executeDevSelfRun('draft triage', async () => selfResult({
      prUrl: pr(1), worktreePath: '/tmp/draft-triage-human-stop',
    }), {
      rounds: 9,
      viewDraftPr: openDraft,
      closeDraftPr: () => true,
      commentDraftPr: (url, comment) => { kept.push({ url, comment }); return true; },
      readSoftStopRequest: () => ({ version: 1, requestedAt: new Date().toISOString() }),
    });
    expect(kept).toEqual([{ url: pr(1), comment: expect.stringContaining('멈춘 사유 human-stopped · 라운드 1') }]);
    expect(kept[0]!.comment).not.toContain('라운드 9');
  });

  it('draft PR 기본 명령은 CWD 대신 URL 저장소와 번호를 --repo로 고정하고 브랜치를 삭제하지 않는다', () => {
    expect(devCli.draftPrCommandArgs(pr(42), 'close', 'replace'))
      .toEqual(['pr', 'close', '42', '--repo', 'acme/elanous', '--comment', 'replace']);
    expect(devCli.draftPrCommandArgs(pr(42), 'comment', 'handoff'))
      .toEqual(['pr', 'comment', '42', '--repo', 'acme/elanous', '--body', 'handoff']);
    expect(devCli.draftPrCommandArgs(pr(42), 'close', 'replace')).not.toContain('--delete-branch');
    expect(devCli.draftPrCommandArgs('https://example.com/acme/elanous/pull/42', 'close', 'replace')).toBeNull();
  });

  it('닫기 실패는 정상 반환을 보존하고, 남긴 draft 코멘트는 «유일» 이라 말하지 않고 닫지 못한 번호를 적는다', async () => {
    const kept: string[] = [];
    const events = await observeRunExit('draft-triage-close-failure', async () => {
      let turn = 0;
      await devCli.executeDevSelfRun('draft triage', async () => {
        turn += 1;
        return selfResult({ prUrl: pr(turn) });
      }, {
        rounds: 1,
        viewDraftPr: lineageDraft,
        closeDraftPr: () => false,
        commentDraftPr: (_url, comment) => { kept.push(comment); return true; },
      });
    });
    expect(kept).toHaveLength(1);
    expect(kept[0]).not.toContain('유일한 사람 판단 대상');
    expect(kept[0]).toContain('닫지 못한 draft 도 남아 있다: #1');
    expectTerminalWithoutFinalStatus(events, { draftTriage: { closed: [], kept: [2], closeFailed: [1], skippedNotDraft: [] } });
  });

  it('draft 를 모은 «뒤» 재발사가 던지면 조회·닫기·코멘트 0회 · draftTriage 없음 · 원래 예외 전파', async () => {
    let calls = 0;
    const failure = new Error('relaunch boom');
    const events = await observeRunExit('draft-triage-exception-after-collect', async () => {
      await expect(devCli.executeDevSelfRun('draft triage', async (relaunch) => {
        if (relaunch) throw failure;
        return selfResult({ prUrl: pr(1) });
      }, {
        rounds: 2,
        viewDraftPr: () => { calls += 1; return openDraft(); },
        closeDraftPr: () => { calls += 1; return true; },
        commentDraftPr: () => { calls += 1; return true; },
      })).rejects.toBe(failure);
    });
    expect(calls).toBe(0);
    expect(events.find(({ event }) => event === 'run-terminal')?.data).not.toHaveProperty('draftTriage');
  });

  it('draft 없는 정상 종료와 감독 없는 실행은 triage 이음매와 terminal draftTriage 를 건드리지 않는다', async () => {
    let calls = 0;
    const seams = { viewDraftPr: () => { calls += 1; return openDraft(); }, closeDraftPr: () => { calls += 1; return true; } };
    const empty = await observeRunExit('draft-triage-empty', async () => {
      await devCli.executeDevSelfRun('draft triage', async () => selfResult(), { rounds: 1, ...seams });
    });
    const unsupervised = await observeRunExit('draft-triage-unsupervised', async () => {
      await devCli.executeDevSelfRun('draft triage', async () => selfResult({ prUrl: pr(1) }));
    });
    expect(calls).toBe(0);
    for (const events of [empty, unsupervised]) expect(events.find(({ event }) => event === 'run-terminal')?.data).not.toHaveProperty('draftTriage');
  });

  it('시험 프로세스에서 기본 이음매는 gh 를 부르지 않는다 — 주입 없이도 닫기 0 · 조회 모름 → skippedNotDraft', async () => {
    expect(process.env.NODE_ENV).toBe('test');
    const events = await observeRunExit('draft-triage-default-seams-in-test', async () => {
      let turn = 0;
      await devCli.executeDevSelfRun('draft triage', async () => { turn += 1; return selfResult({ prUrl: pr(turn) }); }, { rounds: 1 });
    });
    expectTerminalWithoutFinalStatus(events, { draftTriage: { closed: [], kept: null, closeFailed: [], skippedNotDraft: [1, 2] } });
  });

  it('normal exit records one run-terminal without a duplicate final run-status', async () => {
    const events = await observeRunExit('normal', async () => {
      await devCli.executeDevSelfRun('normal', async () => selfResult({ stage: 'merged', merged: true }));
    });

    expectTerminalWithoutFinalStatus(events, { runStatus: 'completed', stage: 'merged', supervised: false });
  });

  it('병합 없이 max-rounds로 멈추면 terminal을 failed로 기록한다', async () => {
    const events = await observeRunExit('supervised-no-merge-max-rounds', async () => {
      await devCli.executeDevSelfRun('supervised', async () => selfResult(), { rounds: 1 });
    });

    expectTerminalWithoutFinalStatus(events, {
      runStatus: 'failed', stage: 'pr-declined', supervised: true, supervisorStopReason: 'max-rounds',
      landedPieces: [], remainingPieces: 1,
    });
  });

  it('병합 조각 뒤 max-rounds terminal은 partial과 남은 조각을 기록하고 반환 병합 계약을 보존한다', async () => {
    let execution: devCli.DevSelfRunExecution | undefined;
    const events = await observeRunExit('merged-max-rounds', async () => {
      execution = await devCli.executeDevSelfRun('merged then stopped', async () => selfResult(), {
        rounds: 2,
        executePiece: async (piece) => piece === 'part a'
          ? selfResult({ runId: 'run-part-a', stage: 'merged', merged: true, mergedBase: 'main', prNumber: 17115 })
          : selfResult({ runId: 'run-part-b', ok: false, stage: 'gate-failed', outcome: 'abandoned' as never, merged: false }),
        readProposals: (input) => ({
          proposals: new Map((input?.runIds ?? []).map((runId) => [runId, {
            shardId: runId,
            pieces: [
              { id: 'part-a', feature: 'part a', dependsOn: [] },
              { id: 'part-b', feature: 'part b', dependsOn: [] },
            ],
          }])),
          goalPlanRevisions: new Map(), scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
        }),
      });
    });

    expectTerminalWithoutFinalStatus(events, {
      runStatus: 'partial', stage: 'gate-failed', supervisorStopReason: 'max-rounds',
      landedPieces: [17115], remainingPieces: 1,
    });
    expect(execution?.result).toMatchObject({ merged: true, prNumber: 17115 });
  });

  it('converged 병합은 실제 마지막 실행의 ok:false와 무관하게 terminal을 completed로 기록하고 반환 병합 계약을 보존한다', async () => {
    let execution: devCli.DevSelfRunExecution | undefined;
    const events = await observeRunExit('converged-merged-unsuccessful', async () => {
      execution = await devCli.executeDevSelfRun('converged merged', async (relaunch) => relaunch
        ? selfResult({ stage: 'merged', merged: true, mergedBase: 'main', prNumber: 17116 })
        : selfResult(), {
        rounds: 3,
        executePiece: async (piece) => piece === 'part a'
          ? selfResult({ runId: 'run-part-a', stage: 'merged', merged: true, mergedBase: 'main', prNumber: 17116 })
          : selfResult({ runId: 'run-part-b', ok: false, stage: 'review-blocked' as never, outcome: 'abandoned' as never, merged: false }),
        readProposals: (input) => ({
          proposals: new Map((input?.runIds ?? []).map((runId) => [runId, {
            shardId: runId,
            pieces: [
              { id: 'part-a', feature: 'part a', dependsOn: [] },
              { id: 'part-b', feature: 'part b', dependsOn: [] },
            ],
          }])),
          goalPlanRevisions: new Map(), scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
        }),
      });
    });

    expectTerminalWithoutFinalStatus(events, { runStatus: 'completed', stage: 'review-blocked', supervisorStopReason: 'converged' });
    expect(execution?.result).toMatchObject({ merged: true, prNumber: 17116 });
  });

  it('parent-signals-red는 병합이 있어도 terminal을 partial로 보존한다', async () => {
    const goalFile = join(mkdtempSync(join(tmpdir(), 'parent-signal-terminal-')), 'goal.md');
    writeFileSync(goalFile, '# goal');
    try {
      const events = await observeRunExit('parent-signals-red-terminal', async () => {
        await devCli.executeDevSelfRun(goalFile, async () => selfResult(), {
          ...promotedConvergedOptions(() => parentSignalResult(0, 1)),
          executePiece: async () => selfResult({ stage: 'merged', merged: true, prNumber: 17117 }),
        });
      });
      expectTerminalWithoutFinalStatus(events, {
        runStatus: 'partial', stage: 'merged', supervisorStopReason: 'parent-signals-red',
        landedPieces: [17117], remainingPieces: 0,
      });
    } finally { rmSync(resolve(goalFile, '..'), { recursive: true, force: true }); }
  });

  it('human-stopped 뒤 관측된 마지막 감독 판정의 remainingPieces를 terminal에 보존한다', async () => {
    const events = await observeRunExit('human-stopped-final-decision', async () => {
      await devCli.executeDevSelfRun('human stopped final decision', async () => selfResult({
        worktreePath: '/tmp/human-stopped-final-decision',
      }), {
        rounds: 1,
        readSoftStopRequest: () => ({ version: 1, requestedAt: new Date().toISOString() }),
      });
    });

    expectTerminalWithoutFinalStatus(events, {
      runStatus: 'failed', stage: 'pr-declined', supervisorStopReason: 'human-stopped',
      landedPieces: [], remainingPieces: 0,
    });
  });

  it('initial exceptional exit records failed status and error in one run-terminal', async () => {
    const failure = new Error('initial execute failure');
    const events = await observeRunExit('initial-exception', async () => {
      await expect(devCli.executeDevSelfRun('exception', async () => { throw failure; })).rejects.toBe(failure);
    });

    expectTerminalWithoutFinalStatus(events, { runStatus: 'failed', error: 'initial execute failure', supervised: false });
  });

  it('supervisor 후속 예외는 최초 결과가 있어도 terminal payload에서 failed 상태와 throw undefined를 보존한다', async () => {
    const events = await observeRunExit('supervisor-post-result-undefined-exception', async () => {
      await expect(devCli.executeDevSelfRun('post-result exception', async (relaunch) => {
        if (relaunch) throw undefined;
        return selfResult();
      }, { rounds: 1 })).rejects.toBeUndefined();
    });

    expectTerminalWithoutFinalStatus(events, { runStatus: 'failed', stage: 'pr-declined', error: 'undefined', supervised: true });
  });

  it('unsuccessful result records failed status and stage in one terminal without an exception', async () => {
    const events = await observeRunExit('unsuccessful-result', async () => {
      await devCli.executeDevSelfRun('unsuccessful', async () => selfResult({ ok: false, stage: 'failed' as never }));
    });

    expectTerminalWithoutFinalStatus(events, { runStatus: 'failed', stage: 'failed', supervised: false });
  });

  it('supervisor 재실행만 execute에 relaunch marker를 전달하고 최초 실행은 보존한다', async () => {
    const relaunches: Array<boolean | undefined> = [];
    await devCli.executeDevSelfRun('same goal', async (relaunch) => {
      relaunches.push(relaunch);
      return relaunch ? selfResult({ stage: 'merged', merged: true }) : selfResult();
    }, { rounds: 1 });
    expect(relaunches).toEqual([undefined, true]);
  });

  it('선언형 dev 산출물은 supervisor 판정 전에 관측해 observed 결과를 남긴다', async () => {
    const decisions: Array<{ deliverableObservation: string }> = [];
    const observedTargets: string[] = [];
    const order: string[] = [];
    const executed = await devCli.executeDevSelfRun(
      'goal',
      async () => selfResult({ stage: 'merged', merged: true }),
      {
        deliverableDocument: '## 산출물을 어떻게 켜나\n\n- Entrypoint: apps/demo/server.ts\n- Port: 31415\n- Environment: DEMO_TOKEN',
        observeDeliverables: async (targets) => {
          order.push('observe');
          observedTargets.push(...targets.map(({ target }) => target));
          return { deployFindings: new Map([['single', { target: targets[0]!.target }]]), unmeasured: [] };
        },
        onDecision: (decision) => {
          order.push(`decision:${decision.deliverableObservation}`);
          decisions.push(decision);
        },
      },
    );

    expect(observedTargets).toEqual(['http://127.0.0.1:31415/']);
    expect(order).toEqual(['observe', 'decision:observed']);
    expect(decisions[0]!.deliverableObservation).toBe('observed');
    expect(executed.supervisorStopReason).toBe('converged');
  });

  it('골 문서 부재는 관측 심을 생략하고 document-missing 사유를 기록한다', async () => {
    const logs: Array<{ category: string; event: string; data: unknown }> = [];
    const log = spyOn(debug, 'log').mockImplementation((category, event, data) => { logs.push({ category, event, data }); });
    let observed = false;
    const decisions: Array<{ deliverableObservation: string }> = [];
    try {
      await devCli.executeDevSelfRun(
        'goal without document',
        async () => selfResult({ stage: 'merged', merged: true }),
        {
          observeDeliverables: async () => {
            observed = true;
            return { deployFindings: new Map(), unmeasured: [] };
          },
          onDecision: (decision) => { decisions.push(decision); },
        },
      );

      expect(observed).toBe(false);
      expect(decisions[0]!.deliverableObservation).toBe('not-attempted');
      expect(logs).toContainEqual({
        category: 'self-dev.supervisor',
        event: 'deliverable-eye.skipped',
        data: { reason: 'document-missing', surface: 'dev' },
      });
    } finally {
      log.mockRestore();
    }
  });

  it('선언 없는 dev 골은 관측 심을 생략하고 no-launch-declaration 사유를 기록한다', async () => {
    const logs: Array<{ category: string; event: string; data: unknown }> = [];
    const log = spyOn(debug, 'log').mockImplementation((category, event, data) => { logs.push({ category, event, data }); });
    let observed = false;
    const decisions: Array<{ deliverableObservation: string }> = [];
    try {
      await devCli.executeDevSelfRun(
        'goal without launch declaration',
        async () => selfResult({ stage: 'merged', merged: true }),
        {
          deliverableDocument: '## Goal\nNo launch declaration',
          observeDeliverables: async () => {
            observed = true;
            return { deployFindings: new Map(), unmeasured: [] };
          },
          onDecision: (decision) => { decisions.push(decision); },
        },
      );

      expect(observed).toBe(false);
      expect(decisions[0]!.deliverableObservation).toBe('not-attempted');
      expect(logs).toContainEqual({
        category: 'self-dev.supervisor',
        event: 'deliverable-eye.skipped',
        data: { reason: 'no-launch-declaration', surface: 'dev' },
      });
      expect(logs).not.toContainEqual(expect.objectContaining({
        event: 'deliverable-eye.skipped',
        data: expect.objectContaining({ reason: 'document-missing' }),
      }));
    } finally {
      log.mockRestore();
    }
  });

  // ⛔⭐⭐ 조각 «배치 뒤» 라운드가 무엇을 하나 — 이 계약에 시험이 «없어서» 내가 틀린 기전을 믿었다.
  //   🩸 2026-09-07: 나는 코드만 읽고 「라운드 2부터 캐시를 돌려주므로 max-rounds 까지 태운다」고
  //   조율 채널에 «발표»했다. 탐침을 치자 5분 만에 반증됐다 — 슈퍼바이저가 r2 에서
  //   `decomposable-no-progress` 로 «스스로» 멎는다. 그래서 그 시퀀스를 여기 못 박는다.
  //   ⛔ 순수 함수 시험(`describeNonPromotableReason` 의 already-promoted)은 이 축을 «안 답한다» —
  //   그것은 「그 문자열을 만드나」이고, 이것은 「라운드가 어떻게 끝나나」다.
  // ⛔⭐ 승격 «못 한» 다조각 런에서도 순서 계산의 간선 수가 원장에 남아야 한다.
  //   🩸 2026-09-07: 그것이 «승격 성공 경로에만» 실려서, 관측된 hotPathEdges 가 승격 2건뿐이었고
  //   「hotPaths 축이 안 돈다」로 읽힐 뻔했다(실제로는 분해 조각쌍 25% 가 겹친다).
  it('승격하지 못해도 순서 계산을 했으면 간선 수를 사유에 싣는다', async () => {
    const decisions: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => {
      if (event === 'decision') decisions.push(data as Record<string, unknown>);
    });
    try {
      await devCli.executeDevSelfRun('dependent-pieces', async () => selfResult(), {
        rounds: 1,
        // ⛔ executePiece 를 «주지 않는다» — 승격이 no-piece-executor 로 막히는 입력이다.
        readProposals: () => ({
          proposals: new Map([['run-dev-supervision', { shardId: 'run-dev-supervision', pieces: [
            { id: 'part-a', feature: 'part a', dependsOn: [], hotPaths: ['src/x.ts'] },
            { id: 'part-b', feature: 'part b', dependsOn: [], hotPaths: ['src/x.ts'] },
          ] }]]), goalPlanRevisions: new Map(),
          scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
        }),
      });
    } finally { log.mockRestore(); }

    // ⛔ 마지막 판정은 `decision-stopped`(상한)다 — «승격을 시도한» 판정을 골라야 한다.
    const reason = String(decisions
      .map((d) => String(d.decomposePromotionReason ?? ''))
      .find((r) => r.startsWith('dev-no-promotable-pieces')) ?? '');
    expect(reason).toContain('dev-no-promotable-pieces');
    // ⭐ 겹치는 hotPaths 가 «간선을 만들었다»는 사실이 승격 실패에도 남는다.
    expect(reason).toContain('hotPathEdges=1');
    expect(reason).toContain('dependsOnEdges=0');
  });

  it('조각 배치 뒤 라운드는 캐시 대신 재실행하고 max-rounds로 멎는다', async () => {
    const pieceCalls: string[] = [];
    const relaunches: Array<boolean | undefined> = [];
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => {
      logs.push({ event, data: data as Record<string, unknown> });
    });
    let executed: devCli.DevSelfRunExecution | undefined;
    try {
      executed = await devCli.executeDevSelfRun('dependent-pieces', async (relaunch) => {
        relaunches.push(relaunch);
        return selfResult();
      }, {
        rounds: 3,
        executePiece: async (piece) => { pieceCalls.push(piece); return selfResult(); },
        readProposals: () => ({
          proposals: new Map([['run-dev-supervision', { shardId: 'run-dev-supervision', pieces: [
            { id: 'part-a', feature: 'part a', dependsOn: [] },
            { id: 'part-b', feature: 'part b', dependsOn: ['part-a'] },
          ] }]]), goalPlanRevisions: new Map(),
          scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
        }),
      });
    } finally { log.mockRestore(); }

    const decisions = logs.filter(({ event }) => event === 'decision').map(({ data }) => data);
    expect(pieceCalls).toEqual(['part a', 'part b']);
    expect(relaunches).toEqual([undefined, true, true]);
    expect(logs).toContainEqual({
      event: 'decompose-shard-results.reexecuted',
      data: { behavior: 're-execution', shardCount: 2, surface: 'dev' },
    });
    expect(decisions.map((d) => d.decomposePromotionReason)).toEqual([
      'dev-piece-execution: 2 piece(s) topologically ordered (dependsOnEdges=1 hotPathEdges=0 dangling=0)',
      'dev-no-promotable-pieces: already-promoted',
      'dev-no-promotable-pieces: already-promoted (dependsOnEdges=1 hotPathEdges=0 dangling=0)',
      'decision-stopped',
    ]);
    expect(decisions.at(-1)).toEqual(expect.objectContaining({
      action: 'stop', stopReason: 'max-rounds',
    }));
    expect(executed).toEqual(expect.objectContaining({
      supervisorStopReason: 'max-rounds',
      shardResults: expect.arrayContaining([
        expect.objectContaining({ feature: 'part a' }),
        expect.objectContaining({ feature: 'part b' }),
      ]),
    }));
  });

  it('감독이 멈춘 뒤에도 확정 병합 조각의 결과와 완료 줄을 보존한다', async () => {
    const executed = await devCli.executeDevSelfRun('merged then stopped', async () => selfResult(), {
      rounds: 2,
      executePiece: async (piece) => piece === 'part a'
        ? selfResult({ runId: 'run-part-a', stage: 'merged', merged: true, mergedBase: 'main', prNumber: 17115 })
        : selfResult({ runId: 'run-part-b', ok: false, stage: 'gate-failed', outcome: 'abandoned' as never, merged: false }),
      readProposals: (input) => ({
        proposals: new Map((input?.runIds ?? []).map((runId) => [runId, {
          shardId: runId,
          pieces: [
            { id: 'part-a', feature: 'part a', dependsOn: [] },
            { id: 'part-b', feature: 'part b', dependsOn: [] },
          ],
        }])),
        goalPlanRevisions: new Map(), scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
      }),
    });

    expect(executed).toMatchObject({ supervisorStopReason: 'max-rounds' });
    expect(executed.result).toMatchObject({ outcome: 'merged', merged: true, mergedBase: 'main', prNumber: 17115 });
    expect(devCli.renderDevCompletionLine({
      kind: 'self', ok: false, runId: executed.result.runId, result: executed.result, supervisorStopReason: executed.supervisorStopReason,
    })).toBe('[dev] self 완료 · ok=false · outcome=merged · supervisor-stop=max-rounds · merged-into=main · merged-pr=#17115 · run=run-part-b');
  });

  it.each([
    ['completed', selfResult({ runId: 'run-part-b', stage: 'pr-declined', outcome: 'completed' as never, merged: false })],
    ['budget-exhausted', selfResult({ runId: 'run-part-b', ok: false, stage: 'gate-failed', outcome: 'budget-exhausted' as never, merged: false })],
  ])('감독 종료 뒤 확정 병합은 마지막 %s outcome에도 보존한다', async (outcome, lastResult) => {
    const executed = await devCli.executeDevSelfRun('merged then stopped', async () => selfResult(), {
      rounds: 2,
      executePiece: async (piece) => piece === 'part a'
        ? selfResult({ runId: 'run-part-a', stage: 'merged', merged: true, mergedBase: 'main', prNumber: 17115 })
        : lastResult,
      readProposals: (input) => ({
        proposals: new Map((input?.runIds ?? []).map((runId) => [runId, {
          shardId: runId,
          pieces: [
            { id: 'part-a', feature: 'part a', dependsOn: [] },
            { id: 'part-b', feature: 'part b', dependsOn: [] },
          ],
        }])),
        goalPlanRevisions: new Map(), scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
      }),
    });

    expect(executed.result).toMatchObject({ outcome, merged: true, mergedBase: 'main', prNumber: 17115 });
    expect(devCli.renderDevCompletionLine({
      kind: 'self', ok: false, runId: executed.result.runId, result: executed.result, supervisorStopReason: executed.supervisorStopReason,
    })).toContain(' · merged-into=main · merged-pr=#17115');
  });

  it('확정 병합에 없는 메타데이터를 마지막 미병합 조각에서 상속하지 않는다', async () => {
    const executed = await devCli.executeDevSelfRun('merged then stopped', async () => selfResult(), {
      rounds: 2,
      executePiece: async (piece) => piece === 'part a'
        ? selfResult({ runId: 'run-part-a', stage: 'merged', merged: true })
        : selfResult({ runId: 'run-part-b', ok: false, stage: 'gate-failed', outcome: 'completed' as never, merged: false, mergedBase: 'wrong-base', prNumber: 99999 }),
      readProposals: (input) => ({
        proposals: new Map((input?.runIds ?? []).map((runId) => [runId, {
          shardId: runId,
          pieces: [
            { id: 'part-a', feature: 'part a', dependsOn: [] },
            { id: 'part-b', feature: 'part b', dependsOn: [] },
          ],
        }])),
        goalPlanRevisions: new Map(), scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
      }),
    });

    expect(executed.result).toMatchObject({ outcome: 'completed', merged: true });
    expect(executed.result).not.toHaveProperty('mergedBase');
    expect(executed.result).not.toHaveProperty('prNumber');
    expect(devCli.renderDevCompletionLine({
      kind: 'self', ok: false, runId: executed.result.runId, result: executed.result, supervisorStopReason: executed.supervisorStopReason,
    })).toBe('[dev] self 완료 · ok=false · outcome=completed · supervisor-stop=max-rounds · merged=true · merged-into=unknown · merged-pr=unconfirmed · run=run-part-b');
  });

  it('병합 메타데이터 없는 확정 병합은 마지막 budget-exhausted outcome에도 병합 사실을 말한다', async () => {
    const executed = await devCli.executeDevSelfRun('merged then stopped', async () => selfResult(), {
      rounds: 2,
      executePiece: async (piece) => piece === 'part a'
        ? selfResult({ runId: 'run-part-a', stage: 'merged', merged: true })
        : selfResult({ runId: 'run-part-b', ok: false, stage: 'gate-failed', outcome: 'budget-exhausted' as never, merged: false }),
      readProposals: (input) => ({
        proposals: new Map((input?.runIds ?? []).map((runId) => [runId, {
          shardId: runId,
          pieces: [
            { id: 'part-a', feature: 'part a', dependsOn: [] },
            { id: 'part-b', feature: 'part b', dependsOn: [] },
          ],
        }])),
        goalPlanRevisions: new Map(), scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
      }),
    });

    expect(executed.result).toMatchObject({ outcome: 'budget-exhausted', merged: true });
    expect(executed.result).not.toHaveProperty('mergedBase');
    expect(executed.result).not.toHaveProperty('prNumber');
    expect(devCli.renderDevCompletionLine({
      kind: 'self', ok: false, runId: executed.result.runId, result: executed.result, supervisorStopReason: executed.supervisorStopReason,
    })).toBe('[dev] self 완료 · ok=false · outcome=budget-exhausted · supervisor-stop=max-rounds · merged=true · merged-into=unknown · merged-pr=unconfirmed · run=run-part-b');
  });

  it('감독이 멈추고 확정 병합 조각이 없으면 abandoned와 병합 없는 완료 줄을 유지한다', async () => {
    const executed = await devCli.executeDevSelfRun('unmerged stopped', async () => selfResult({
      ok: false, stage: 'gate-failed', outcome: 'abandoned' as never, merged: false,
    }), { rounds: 1 });

    expect(executed).toMatchObject({ supervisorStopReason: 'max-rounds' });
    expect(executed.result).toMatchObject({ outcome: 'abandoned', merged: false });
    expect(devCli.renderDevCompletionLine({
      kind: 'self', ok: false, runId: executed.result.runId, result: executed.result, supervisorStopReason: executed.supervisorStopReason,
    })).toBe('[dev] self 완료 · ok=false · outcome=abandoned · supervisor-stop=max-rounds · run=run-dev-supervision');
  });

  it('dev는 승격한 두 조각을 각각 실행하고 실제 마지막 결과만 접어 돌려준다', async () => {
    resetFrontVisitCountsForTesting();
    const logs: Array<{ category: string; event: string; data: unknown }> = [];
    const log = spyOn(debug, 'log').mockImplementation((category, event, data) => { logs.push({ category, event, data }); });
    const calls: string[] = [];
    try {
      const executed = await devCli.executeDevSelfRun('complex goal', async () => selfResult(), {
        rounds: 2,
        runId: 'run-dev-supervision',
        queryAbandonedDraftPrs: () => [],
        executePiece: async (piece) => {
          calls.push(piece);
          return piece === 'part a'
            ? selfResult({ runId: 'run-part-a', stage: 'pr-declined' })
            : selfResult({
              runId: 'run-part-b', ok: false, stage: 'gate-failed', outcome: 'abandoned' as never,
              merged: false, mergedBase: 'main', mergeReason: 'gate failed', detail: 'last piece failure',
            });
        },
        readProposals: (input) => {
          const runIds = input?.runIds ?? [];
          return {
            proposals: new Map(runIds.map((runId) => [runId, { shardId: runId, pieces: [
              { id: 'part-a', feature: 'part a', dependsOn: [] },
              { id: 'part-b', feature: 'part b', dependsOn: [] },
            ] }])),
            goalPlanRevisions: new Map(), scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
          };
        },
      });

      expect(calls).toEqual(['part a', 'part b']);
      expect(executed.shardResults).toHaveLength(2);
      expect(executed.result).toMatchObject({
        runId: 'run-part-b', stage: 'gate-failed', ok: false, outcome: 'abandoned',
        merged: false, mergedBase: 'main', mergeReason: 'gate failed', detail: 'last piece failure',
      });
      expect(executed.result.stage).not.toBe('pr-opened');
      expect(logs.find(({ event }) => event === 'decision')).toEqual(expect.objectContaining({
        category: 'self-dev.supervisor',
        data: expect.objectContaining({
          surface: 'dev', decomposable: 1, decomposePromotionAttempted: true,
          decomposePromotionReason: 'dev-piece-execution: 2 piece(s) topologically ordered (dependsOnEdges=0 hotPathEdges=0 dangling=0)',
        }),
      }));
      const decomposeEntries = logs.filter(({ category, event }) => category === 'self-implement' && event === 'pipeline-node-entry');
      expect(decomposeEntries.map(({ data }) => data)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          node: 'decompose', provenance: 'supervisor-promotion-attempt', runId: 'run-dev-supervision',
        }),
        expect.objectContaining({
          node: 'decompose', provenance: 'supervisor-pre-promotion-decision', runId: 'run-dev-supervision',
        }),
      ]));
      // ⭐ 배선 증거 — 감독기 경로의 decompose 진입 «하나하나»가 같은 런 계수로 판독된다(1 → N).
      //   N 을 손으로 박지 않는다 — 같은 런의 pipeline-node-entry(decompose) 수에서 파생한다.
      const decomposeBudgets = logs
        .filter(({ category, event }) => category === 'self-implement' && event === 'graph-visit-budget')
        .map(({ data }) => data as Record<string, unknown>)
        .filter((data) => data.runId === 'run-dev-supervision' && data.node === 'decompose');
      const decomposeEntryCount = decomposeEntries
        .map(({ data }) => data as Record<string, unknown>)
        .filter((data) => data.runId === 'run-dev-supervision' && data.node === 'decompose').length;
      expect(decomposeEntryCount).toBeGreaterThanOrEqual(2);
      expect(decomposeBudgets.map((data) => data.visits)).toEqual(Array.from({ length: decomposeEntryCount }, (_, i) => i + 1));
      expect(decomposeBudgets.every((data) => data.maxVisits === 12 && data.phase === 'front')).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    ['auto-merge', 'auto-merge'],
    ['completion 미지정', undefined],
  ])('원격 완료 방식(%s)은 두 조각 승격을 보존한다', async (_name, completion) => {
    const calls: string[] = [];
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => {
      logs.push({ event, data: data as Record<string, unknown> });
    });
    try {
      await devCli.executeDevSelfRun('mergeable-pieces', async () => selfResult(), {
        rounds: 1,
        ...(completion === undefined ? {} : { completion }),
        executePiece: async (piece) => { calls.push(piece); return selfResult(); },
        readProposals: () => ({
          proposals: new Map([['run-dev-supervision', { shardId: 'run-dev-supervision', pieces: [
            { id: 'part-a', feature: 'part a', dependsOn: [] },
            { id: 'part-b', feature: 'part b', dependsOn: [] },
          ] }]]), goalPlanRevisions: new Map(),
          scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
        }),
      });
    } finally { log.mockRestore(); }

    expect(calls).toEqual(['part a', 'part b']);
    expect(logs.find(({ event }) => event === 'decision')?.data).toEqual(expect.objectContaining({
      decomposePieceCount: 2,
      decomposePromotionReason: 'dev-piece-execution: 2 piece(s) topologically ordered (dependsOnEdges=0 hotPathEdges=0 dangling=0)',
    }));
  });

  it('worktree-only 완료 방식은 조각마다 base 관측을 남기고 직전 branch를 다음 base로 잇는다', async () => {
    const calls: Array<{ piece: string; opts?: { base?: string } }> = [];
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => {
      logs.push({ event, data: data as Record<string, unknown> });
    });
    try {
      await devCli.executeDevSelfRun('worktree-only-pieces', async () => selfResult(), {
        rounds: 1,
        completion: 'worktree-only',
        executePiece: async (piece, opts) => {
          calls.push({ piece, ...(opts === undefined ? {} : { opts }) });
          return selfResult({ branch: piece === 'part a' ? 'b1' : 'b2' });
        },
        readProposals: () => ({
          proposals: new Map([['run-dev-supervision', { shardId: 'run-dev-supervision', pieces: [
            { id: 'part-a', feature: 'part a', dependsOn: [] },
            { id: 'part-b', feature: 'part b', dependsOn: [] },
          ] }]]), goalPlanRevisions: new Map(),
          scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
        }),
      });
    } finally { log.mockRestore(); }

    expect(calls).toEqual([{ piece: 'part a' }, { piece: 'part b', opts: { base: 'b1' } }]);
    expect(logs.filter(({ event }) => event === 'decompose-piece.executed')).toEqual([
      { event: 'decompose-piece.executed', data: { pieceIndex: 0, surface: 'dev' } },
      { event: 'decompose-piece.executed', data: { pieceIndex: 1, base: 'b1', surface: 'dev' } },
    ]);
    expect(logs.find(({ event }) => event === 'decision')?.data).toEqual(expect.objectContaining({
      decomposePieceCount: 2,
      decomposePromotionReason: 'dev-piece-execution: 2 piece(s) topologically ordered (dependsOnEdges=0 hotPathEdges=0 dangling=0)',
    }));
  });

  it('원격 완료 방식은 승격 조각에 base opts를 전달하지 않는다', async () => {
    const calls: Array<{ piece: string; opts?: { base?: string } }> = [];
    await devCli.executeDevSelfRun('remote-pieces', async () => selfResult(), {
      rounds: 1,
      completion: 'auto-merge',
      executePiece: async (piece, opts) => {
        calls.push({ piece, ...(opts === undefined ? {} : { opts }) });
        return selfResult({ branch: piece === 'part a' ? 'b1' : 'b2' });
      },
      readProposals: () => ({
        proposals: new Map([['run-dev-supervision', { shardId: 'run-dev-supervision', pieces: [
          { id: 'part-a', feature: 'part a', dependsOn: [] }, { id: 'part-b', feature: 'part b', dependsOn: [] },
        ] }]]), goalPlanRevisions: new Map(), scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
      }),
    });
    expect(calls).toEqual([{ piece: 'part a' }, { piece: 'part b' }]);
  });

  it('worktree-only에서 앞 조각 branch가 없으면 다음 조각에 base opts를 전달하지 않는다', async () => {
    const calls: Array<{ piece: string; opts?: { base?: string } }> = [];
    await devCli.executeDevSelfRun('branchless-pieces', async () => selfResult(), {
      rounds: 1,
      completion: 'worktree-only',
      executePiece: async (piece, opts) => {
        calls.push({ piece, ...(opts === undefined ? {} : { opts }) });
        return selfResult();
      },
      readProposals: () => ({
        proposals: new Map([['run-dev-supervision', { shardId: 'run-dev-supervision', pieces: [
          { id: 'part-a', feature: 'part a', dependsOn: [] }, { id: 'part-b', feature: 'part b', dependsOn: [] },
        ] }]]), goalPlanRevisions: new Map(), scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
      }),
    });
    expect(calls).toEqual([{ piece: 'part a' }, { piece: 'part b' }]);
  });

  it('dev는 executePiece 없이 반복된 제안을 승격하지 않고 단일 재실행을 보존한다', async () => {
    const calls: string[] = [];
    const proposal = { shardId: 'run-dev-supervision', pieces: [
      { id: 'part-a', feature: 'part a', dependsOn: [] },
      { id: 'part-b', feature: 'part b', dependsOn: [] },
    ] };
    await devCli.executeDevSelfRun('no-piece-executor', async () => {
      calls.push('single');
      return calls.length === 1 ? selfResult() : selfResult({ stage: 'merged', merged: true });
    }, {
      rounds: 2,
      readProposals: () => ({
        proposals: new Map([['run-dev-supervision', proposal]]), goalPlanRevisions: new Map(),
        scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
      }),
    });
    expect(calls).toEqual(['single', 'single']);
  });

  // ⛔⭐ RUN-T82 (2026-09-06) — 이 시험은 «뒤집힌 것»이다. 옛 문면은
  //   *"dev는 의존 조각 제안을 승격하지 «않고» 단일 재실행을 보존한다"* 였고, 그 계약이
  //   ***승격 가능 0/13 = 0%*** 를 만들었다(분해기는 위상을 만들고 관문이 위상을 거부했다).
  //   ⇒ 이 입력이 «옛 관문과 새 관문을 가르는» 입력이다: 옛 것은 단일 재실행, 새 것은 위상 승격.
  it('dev는 의존이 있는 조각도 승격하고 위상 순서(의존 먼저)로 실행한다', async () => {
    const calls: string[] = [];
    const logs: Array<{ event: string; data: unknown }> = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => { logs.push({ event, data }); });
    try {
      await devCli.executeDevSelfRun('dependent-pieces', async () => selfResult(), {
        rounds: 2,
        executePiece: async (piece) => { calls.push(piece); return selfResult(); },
        readProposals: () => ({
          // ⭐ 의존 조각(part-b)을 배열에서 «먼저» 둔다 — 정렬이 실제로 «순서를 바꾸는지» 재려는 것이다.
          //   배열 순서를 그대로 쓰는 구현이면 이 기대가 깨진다(시험이 정렬을 «문다»).
          proposals: new Map([['run-dev-supervision', { shardId: 'run-dev-supervision', pieces: [
            { id: 'part-b', feature: 'part b', dependsOn: ['part-a'] },
            { id: 'part-a', feature: 'part a', dependsOn: [] },
          ] }]]), goalPlanRevisions: new Map(),
          scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
        }),
      });
      expect(calls).toEqual(['part a', 'part b']);
      expect(logs.find(({ event }) => event === 'decision')?.data).toEqual(expect.objectContaining({
        decomposePromotionAttempted: true,
        decomposePromotionReason: 'dev-piece-execution: 2 piece(s) topologically ordered (dependsOnEdges=1 hotPathEdges=0 dangling=0)',
      }));
    } finally {
      log.mockRestore();
    }
  });

  // ⛔⭐ 2026-09-07 실물: 원장에 «조각 6개» 제안이 있고 backfill 이 `filled:1` 을 냈는데도
  //   이 자리가 `dev-no-promotable-pieces` 를 냈다. 그 한 문자열로는 원인 «넷»을 못 가른다.
  //   ⇒ 이름을 가르되 ***판정은 안 바꾼다***(넷 다 여전히 승격 안 함). 이 시험이 그 둘을 같이 문다.
  it('dev는 실행기가 없으면 «그 사유를 이름으로» 내고 승격하지 않는다', async () => {
    const calls: string[] = [];
    const logs: Array<{ event: string; data: unknown }> = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => { logs.push({ event, data }); });
    try {
      await devCli.executeDevSelfRun('no-executor-named', async () => {
        calls.push('single');
        return calls.length === 1 ? selfResult() : selfResult({ stage: 'merged', merged: true });
      }, {
        rounds: 2,
        // ⛔ executePiece 를 «주지 않는다» — 이것이 이 시험이 가르는 축이다
        readProposals: () => ({
          proposals: new Map([['run-dev-supervision', { shardId: 'run-dev-supervision', pieces: [
            { id: 'part-a', feature: 'part a', dependsOn: [] },
            { id: 'part-b', feature: 'part b', dependsOn: ['part-a'] },
          ] }]]), goalPlanRevisions: new Map(),
          scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
        }),
      });
      // 판정은 그대로 — 단일 재실행이 보존된다
      expect(calls).toEqual(['single', 'single']);
      // 이름은 갈린다 — 「왜 못 했나」가 값으로 나온다
      expect(logs.find(({ event }) => event === 'decision')?.data).toEqual(expect.objectContaining({
        // ⭐ 2026-09-07: 순서 계산을 «했으면» 승격 실패에도 간선 수가 함께 실린다.
        //   그래야 「그 축이 일했나」를 승격 못 한 런에서도 센다(그 전엔 승격 성공 경로에만 있었다).
        decomposePromotionReason:
          'dev-no-promotable-pieces: no-piece-executor (dependsOnEdges=1 hotPathEdges=0 dangling=0)',
      }));
    } finally {
      log.mockRestore();
    }
  });

  // ⭐⭐ 무인 리뷰 지적 ①③ 의 «진짜» 답 — 사유 생성을 순수 함수로 뽑아 ***네 분기를 전부*** 문다.
  //   ⛔ 심 안에 인라인으로 두면 둘은 도달 불가였다(아래 주석의 실측). 뽑으니 넷 다 문다.
  describe('describeNonPromotableReason — 원인 넷이 «다른 이름»으로 갈린다', () => {
    const job = (feature: string, pieces = 0) => ({
      taskId: 't', runId: 'r', feature, status: 'failed' as const, stage: 'gate-failed',
      ...(pieces ? { decomposeProposal: { pieces: Array.from({ length: pieces }, (_, i) => ({ id: String(i), feature: `p${i}`, dependsOn: [] })) } } : {}),
    }) as never;
    const base = {
      alreadyPromoted: false, hasPieceExecutor: true, taskDecomposable: true,
      decomposableCount: 1, previous: [job('goal')], feature: 'goal', pieceCount: 0,
    };

    it('① 이미 승격했으면 already-promoted', () => {
      expect(devCli.describeNonPromotableReason({ ...base, alreadyPromoted: true }))
        .toBe('dev-no-promotable-pieces: already-promoted');
    });

    it('② 조각 실행기가 없으면 no-piece-executor', () => {
      expect(devCli.describeNonPromotableReason({ ...base, hasPieceExecutor: false }))
        .toBe('dev-no-promotable-pieces: no-piece-executor');
    });

    it('③ 트리아지가 이 태스크를 안 골랐으면 task-not-decomposable ⊕ 그 «수»를 낸다', () => {
      expect(devCli.describeNonPromotableReason({ ...base, taskDecomposable: false, decomposableCount: 3 }))
        .toBe('dev-no-promotable-pieces: task-not-decomposable (decomposable=3)');
    });

    it('④ 자격은 있는데 조각이 없으면 «분모 넷»을 낸다', () => {
      expect(devCli.describeNonPromotableReason(base))
        .toBe('dev-no-promotable-pieces: pieces=0 (previous=1 featureMatched=1 withProposal=0 withProposalAnyJob=0)');
    });

    // ⭐⭐ 이것이 무인 리뷰 must-fix ① 이 지적한 «모순»을 무는 시험이다.
    //   두 수를 «다른 모집단»에서 세면 featureMatched=0 인데 withProposal=1 이 나온다.
    it('⭐ featureMatched=0 이면 withProposal 도 «반드시» 0이다 — 두 수가 같은 모집단이다', () => {
      const reason = devCli.describeNonPromotableReason({
        ...base,
        previous: [job('OTHER-GOAL', 5)],   // 제안은 «있는데» feature 가 다르다
        feature: 'goal',
      });
      expect(reason).toContain('featureMatched=0');
      expect(reason).toContain('withProposal=0');
      // ⊕ 그런데 「다른 job 에 제안이 있다」는 «잃지 않는다» — 그것이 진단의 핵심이다
      expect(reason).toContain('withProposalAnyJob=1');
    });

    it('제안이 «맞는 job 에» 있으면 두 수가 같이 1이 된다', () => {
      const reason = devCli.describeNonPromotableReason({ ...base, previous: [job('goal', 4)] });
      expect(reason).toContain('featureMatched=1');
      expect(reason).toContain('withProposal=1');
      expect(reason).toContain('withProposalAnyJob=1');
    });
  });

  // ⛔⭐ **무인 리뷰 지적 ③(분기 넷 중 둘만 시험)에 대한 답 — 「안 했다」가 아니라 «못 한다»다.**
  //   `task-not-decomposable` 과 `already-promoted` 분기를 이 층에서 세우려고 시험을 썼는데,
  //   ***입력이 그 조건을 만들 수 없었다.*** 실측(2026-09-07 · 프로브):
  //     제안을 «주지 않으면» 트리아지가 「분해」로 판정하지 않는다
  //     ⇒ `decision.decomposable.length === 0` ⇒ ***승격 심이 아예 «안 불린다»***
  //     ⇒ 사유는 `no-decomposable-decision`(승격 심 «밖»의 값)이고 내 분기는 밟히지 않는다
  //   🔑 즉 그 두 분기는 ***「제안이 «다른 job 에» 있고 트리아지는 분해라고 말하는」*** 상태를 요구하는데,
  //     그것은 이 seam 위에서 «합성할 수 없다»(트리아지가 같은 결과 배열을 본다).
  //   ⇒ 📌 그래서 그 축은 «시험이 아니라 원장»이 답한다 — 실물 분해 런의 사유 문자열을 읽는다.
  //   ⛔ 다음 사람이 이 자리에 시험을 다시 쓰기 «전»에 위 실측을 먼저 반증하라.

  // ⭐ 아래는 «만들 수 있는» 조건 — 제안이 없으면 트리아지가 분해로 안 보고 심이 안 불린다.
  //   그것도 계약이다: ***「제안 없음」은 승격 «실패»가 아니라 승격 «시도 없음»이다.***
  it('dev는 제안이 «없으면» 승격 심이 아예 불리지 않는다 — 실패가 아니라 시도 없음이다', async () => {
    const logs: Array<{ event: string; data: unknown }> = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => { logs.push({ event, data }); });
    try {
      await devCli.executeDevSelfRun('no-proposal-named', async () => selfResult(), {
        rounds: 2,
        executePiece: async () => selfResult(),
        readProposals: () => ({
          proposals: new Map(), goalPlanRevisions: new Map(),
          scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
        }),
      });
      const decision = logs.find(({ event }) => event === 'decision')?.data as
        { decomposePromotionAttempted?: boolean; decomposePromotionReason?: string } | undefined;
      // ⛔ 「시도했는데 실패」와 「시도조차 안 함」은 «다른 값»이다 — 그 둘을 여기서 못 박는다.
      expect(decision?.decomposePromotionAttempted).toBe(false);
      expect(decision?.decomposePromotionReason).toBe('no-decomposable-decision');
    } finally {
      log.mockRestore();
    }
  });

  // ⛔ 「승격 못 함」을 한 값으로 접지 않는다 — 순환은 «분해기» 결함이라 이름이 달라야 고칠 수 있다.
  it('dev는 순환 의존 제안을 승격하지 않고 순환을 «이름으로» 낸다', async () => {
    const calls: string[] = [];
    const logs: Array<{ event: string; data: unknown }> = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => { logs.push({ event, data }); });
    try {
      await devCli.executeDevSelfRun('cyclic-pieces', async () => {
        calls.push('single');
        return calls.length === 1 ? selfResult() : selfResult({ stage: 'merged', merged: true });
      }, {
        rounds: 2,
        executePiece: async () => selfResult(),
        readProposals: () => ({
          proposals: new Map([['run-dev-supervision', { shardId: 'run-dev-supervision', pieces: [
            { id: 'part-a', feature: 'part a', dependsOn: ['part-b'] },
            { id: 'part-b', feature: 'part b', dependsOn: ['part-a'] },
          ] }]]), goalPlanRevisions: new Map(),
          scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
        }),
      });
      expect(calls).toEqual(['single', 'single']);
      expect(logs.find(({ event }) => event === 'decision')?.data).toEqual(expect.objectContaining({
        decomposePromotionAttempted: true,
        decomposePromotionReason: 'dev-decomposition-cycle: 2 piece(s) in cycle [part-a,part-b]',
      }));
    } finally {
      log.mockRestore();
    }
  });

  it('foldDevShardResults는 마지막 실제 완료 결과를 그대로 보존한다', () => {
    const first = { taskId: 'part-a', feature: 'part a', status: 'done' as const, runId: 'run-a', stage: 'pr-declined' };
    const last = { taskId: 'part-b', feature: 'part b', status: 'failed' as const, runId: 'run-b', stage: 'gate-failed' };
    expect(devCli.foldDevShardResults([first, last])).toBe(last);
    expect(devCli.foldDevShardResults([])).toBeUndefined();
  });

  it('dev 원장 조회는 성공한 0건과 read-failed를 서로 다른 revision 및 표면 관측으로 남긴다', async () => {
    const logs: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation((category, event, data) => { logs.push({ category, event, data: data as Record<string, unknown> }); });
    const preservedRevision = { status: 'read' as const, attempted: 3, applied: 2, failureReasons: ['existing-revision'] };
    const ledgerRevision = { status: 'read' as const, attempted: 1, applied: 1, failureReasons: [] };
    const decisions: Array<{ decomposable: string[] }> = [];
    const ledgerDecisions: Array<{ decomposable: string[] }> = [];
    try {
      const preservedResult = devCli.hydrateDevDecomposeProposals([
        { taskId: 'run-dev-supervision', runId: 'run-dev-supervision', feature: 'no proposal', status: 'failed', goalPlanRevision: preservedRevision },
      ], () => ({
        proposals: new Map(), goalPlanRevisions: new Map([['run-dev-supervision', ledgerRevision]]), scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
      }));
      expect(preservedResult[0]!.goalPlanRevision).toEqual(preservedRevision);
      await devCli.executeDevSelfRun('no proposal', async () => selfResult({ goalPlanRevision: preservedRevision } as never), {
        rounds: 1,
        readProposals: () => ({
          proposals: new Map(), goalPlanRevisions: new Map([['run-dev-supervision', ledgerRevision]]), scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
        }),
        onDecision: (decision) => { decisions.push(decision); },
      });
      expect(logs).toContainEqual(expect.objectContaining({
        category: 'self-dev.supervisor', event: 'decompose-proposal.backfill',
        data: expect.objectContaining({ surface: 'dev', readFailure: undefined, found: 0, attached: 0 }),
      }));

      const ledgerProposal = { shardId: 'run-dev-supervision', pieces: [
        { id: 'part-a', feature: 'part a', dependsOn: [] },
        { id: 'part-b', feature: 'part b', dependsOn: [] },
      ] };
      const injectedResult = devCli.hydrateDevDecomposeProposals([
        { taskId: 'run-dev-supervision', runId: 'run-dev-supervision', feature: 'ledger revision', status: 'failed' },
      ], () => ({
        proposals: new Map([['run-dev-supervision', ledgerProposal]]),
        goalPlanRevisions: new Map([['run-dev-supervision', ledgerRevision]]), scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
      }));
      expect(injectedResult[0]).toMatchObject({ decomposeProposal: { pieces: ledgerProposal.pieces }, goalPlanRevision: ledgerRevision });

      const unknownRevision = devCli.hydrateDevDecomposeProposals([
        { taskId: 'run-dev-supervision', runId: 'run-dev-supervision', feature: 'unknown revision', status: 'failed' },
      ], () => ({
        proposals: new Map(), goalPlanRevisions: new Map(), scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
      }));
      expect(unknownRevision[0]!.goalPlanRevision).toBeUndefined();

      const partialReadRevision = devCli.hydrateDevDecomposeProposals([
        { taskId: 'task-single', runId: 'run-single', feature: 'partial read', status: 'failed' },
      ], () => ({
        proposals: new Map(),
        goalPlanRevisions: new Map([['run-single', ledgerRevision]]),
        readFailure: { status: 'read-failed' as const, reason: 'unreadable-files' as const, scannedFiles: 2, unreadableFiles: 1, ledgerDirectory: '/ledger' },
        scannedFiles: 2, unreadableFiles: 1, directoryMissing: false, ledgerDirectory: '/ledger',
      }));
      expect(partialReadRevision[0]!.goalPlanRevision).toEqual(ledgerRevision);

      await devCli.executeDevSelfRun('ledger revision', async () => selfResult({ ok: false, stage: 'gate-failed' as never } as never), {
        rounds: 1,
        readProposals: () => ({
          proposals: new Map([['run-dev-supervision', ledgerProposal]]),
          goalPlanRevisions: new Map([['run-dev-supervision', ledgerRevision]]), scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
        }),
        onDecision: (decision) => { ledgerDecisions.push(decision); },
      });
      expect(ledgerDecisions[0]!.decomposable).toEqual(['run-dev-supervision']);

      const readFailedResult = devCli.hydrateDevDecomposeProposals([
        { taskId: 'run-dev-supervision', runId: 'run-dev-supervision', feature: 'unreadable ledger', status: 'failed', goalPlanRevision: preservedRevision },
      ], () => ({
        proposals: new Map(), goalPlanRevisions: new Map(),
        readFailure: { status: 'read-failed', reason: 'unreadable-files', scannedFiles: 1, unreadableFiles: 1, ledgerDirectory: '/ledger' },
        scannedFiles: 1, unreadableFiles: 1, directoryMissing: false, ledgerDirectory: '/ledger',
      }));
      expect(readFailedResult[0]!.goalPlanRevision).toEqual(preservedRevision);
      await devCli.executeDevSelfRun('unreadable ledger', async () => selfResult({ goalPlanRevision: preservedRevision } as never), {
        rounds: 1,
        readProposals: () => ({
          proposals: new Map(), goalPlanRevisions: new Map(),
          readFailure: { status: 'read-failed', reason: 'unreadable-files', scannedFiles: 1, unreadableFiles: 1, ledgerDirectory: '/ledger' },
          scannedFiles: 1, unreadableFiles: 1, directoryMissing: false, ledgerDirectory: '/ledger',
        }),
        onDecision: (decision) => { decisions.push(decision); },
      });
      expect(logs).toContainEqual(expect.objectContaining({
        category: 'self-dev.supervisor', event: 'decompose-proposal.backfill',
        data: expect.objectContaining({ surface: 'dev', readFailure: 'unreadable-files', found: 0, attached: 0 }),
      }));
    } finally {
      log.mockRestore();
    }
  });

  it('dev 원장 백필 관측은 찾은 수와 붙인 수를 다른 키로 낸다', () => {
    const logs: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      logs.push({ category, event, data: data as Record<string, unknown> });
    });
    const ledgerProposal = {
      shardId: 'run-dev-supervision',
      pieces: [
        { id: 'part-a', feature: 'part a', dependsOn: [] },
        { id: 'part-b', feature: 'part b', dependsOn: [] },
      ],
    };
    const scan = () => ({
      proposals: new Map([['run-dev-supervision', ledgerProposal]]),
      goalPlanRevisions: new Map(),
      scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
    });
    const childPieces = [{ id: 'child', feature: 'child piece', dependsOn: [] as const }];
    try {
      const skipped = devCli.hydrateDevDecomposeProposals([
        {
          taskId: 'run-dev-supervision', runId: 'run-dev-supervision',
          feature: 'already has proposal', status: 'failed',
          decomposeProposal: { pieces: childPieces },
        },
      ], scan);
      expect(skipped[0]!.decomposeProposal).toEqual({ pieces: childPieces });
      const skippedObs = logs.find(({ event }) => event === 'decompose-proposal.backfill')?.data;
      expect(skippedObs).toEqual(expect.objectContaining({ found: 1, attached: 0 }));
      expect(Object.keys(skippedObs ?? {})).toEqual(expect.arrayContaining(['found', 'attached']));

      logs.length = 0;
      const attached = devCli.hydrateDevDecomposeProposals([
        { taskId: 'run-dev-supervision', runId: 'run-dev-supervision', feature: 'no proposal', status: 'failed' },
      ], scan);
      expect(attached[0]!.decomposeProposal).toEqual({ pieces: ledgerProposal.pieces });
      const attachedObs = logs.find(({ event }) => event === 'decompose-proposal.backfill')?.data;
      expect(attachedObs).toEqual(expect.objectContaining({ found: 1 }));
      expect((attachedObs?.attached as number) >= 1).toBe(true);
      expect(Object.keys(attachedObs ?? {})).toEqual(expect.arrayContaining(['found', 'attached']));
    } finally {
      log.mockRestore();
    }
  });

  it('dev supervisor는 failureClassification 의 골 원인으로 oversized-goal 수리 트리아지를 택하고 없는 원인은 생략한다', async () => {
    const observedDecisions: Array<{ action: string; classifications: Array<{ kind: string; action: string }> }> = [];
    await devCli.executeDevSelfRun('classified-goal-cause', async () => selfResult({
      ok: false,
      stage: 'review-blocked' as never,
      abandonedClassification: {
        classification: 'goal-unconvergeable-candidate',
        classificationBasis: 'supervisor-unconvergeable-goal-candidate',
        worktreeClean: true,
        mustFixReported: false,
      },
    }), {
      rounds: 1,
      onDecision: (decision) => { observedDecisions.push(decision); },
    });
    expect(observedDecisions[0]).toMatchObject({
      action: 'add-repair-task',
      classifications: [{ kind: 'oversized-goal', action: 'add-repair-task' }],
    });

    const unknown = devCli.hydrateDevGoalCauseObserved([
      { taskId: 'missing-classification', feature: 'unknown', status: 'failed' },
      { taskId: 'non-matching', runId: 'non-matching', feature: 'unknown', status: 'failed', failureClassification: 'implementation-deficit' },
    ]);
    expect(unknown[0]).not.toHaveProperty('goalCauseObserved');
    expect(unknown[1]).not.toHaveProperty('goalCauseObserved');
  });

  it('감독 dev 런은 공유 관측 카테고리에 라운드별 행동·사유·종료와 표면 배선을 기록한다', async () => {
    const logs: Array<{ category: string; event: string; data: unknown }> = [];
    const log = spyOn(debug, 'log').mockImplementation((category, event, data) => { logs.push({ category, event, data }); });
    let calls = 0;
    try {
      const executed = await devCli.executeDevSelfRun('same goal', async () => {
        calls += 1;
        return calls === 1 ? selfResult() : selfResult({ stage: 'merged', merged: true });
      }, { rounds: 2 });

      expect(executed.supervisorStopReason).toBe('converged');
      expect(logs.filter(({ event }) => event === 'decision')).toEqual([
        expect.objectContaining({
          category: 'self-dev.supervisor', event: 'decision', data: expect.objectContaining({
            round: 0, action: 'relaunch', stopReason: null, why: expect.any(String), surface: 'dev',
          }),
        }),
        expect.objectContaining({
          category: 'self-dev.supervisor', event: 'decision', data: expect.objectContaining({
            round: 1, action: 'stop', stopReason: 'converged', why: expect.any(String), surface: 'dev',
          }),
        }),
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it('감독 dev 관측 기록이 실패해도 재실행과 종료 판정은 계속된다', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => { throw new Error('observation unavailable'); });
    let calls = 0;
    try {
      const executed = await devCli.executeDevSelfRun('same goal', async () => {
        calls += 1;
        return calls === 1 ? selfResult() : selfResult({ stage: 'merged', merged: true });
      }, { rounds: 2 });

      expect(calls).toBe(2);
      expect(executed.supervisorStopReason).toBe('converged');
    } finally {
      log.mockRestore();
    }
  });

  it('감독이 재작업을 요청하면 실제 dev pipeline의 runSelfImplement 심이 같은 골로 두 번 이상 실행된다', async () => {
    const calls: SelfImplementOptions[] = [];
    const spec = buildDevCliSpec({ text: 'same goal' }, SELF, { openPr: false });
    const execute = async (): Promise<SelfImplementResult> => {
      const dispatched = await runDevPipeline(spec, {
        runSelfImplement: async (input) => {
          calls.push(input);
          return calls.length === 1 ? selfResult() : selfResult({ stage: 'merged', merged: true });
        },
      });
      if (dispatched.kind !== 'self') throw new Error(`expected self dispatch, got ${dispatched.kind}`);
      return dispatched.result;
    };
    const executed = await withNonExecutingReviewProvider(() => devCli.executeDevSelfRun('same goal', execute, { rounds: 2 }));
    expect(calls).toHaveLength(2);
    expect(calls.map(({ feature }) => feature)).toEqual(['same goal', 'same goal']);
    expect(executed.supervisorStopReason).toBe('converged');
  });

  it('재실행할 트리아지가 없으면 감독 종료 사유 converged를 결과에 노출한다', async () => {
    const executed = await devCli.executeDevSelfRun('same goal', async () => selfResult({ stage: 'merged', merged: true }), { rounds: 2 });
    expect(executed.supervisorStopReason).toBe('converged');
  });

  it('감독 완료·관측은 재실행의 최종 runId를 쓰고 비감독은 기존 dev runId를 보존한다', () => {
    const finalResult = selfResult({ runId: 'run-rerun-final' });
    expect(devCli.resolveDevCompletionRunId('run-initial', finalResult, 'converged')).toBe('run-rerun-final');
    expect(devCli.resolveDevCompletionRunId('run-initial', finalResult, undefined)).toBe('run-initial');
  });

  it('자동 병합 성공 문면은 기본 브랜치와 작업 브랜치 목적지를 순수 함수로 구별한다', () => {
    expect(formatAutoMergeSuccessMessage({ prNumber: 11946, mergedBase: 'main', defaultBranch: 'main' }))
      .toBe('✅ 자동 병합 완료 (#11946) → main');
    const workBranchMessage = formatAutoMergeSuccessMessage({ prNumber: 11946, mergedBase: 'self-impl/work-branch', defaultBranch: 'main' });
    expect(workBranchMessage).toContain('self-impl/work-branch');
    expect(workBranchMessage).toContain('main에는 아직 안 감');
  });

  it('자동 병합 성공 문면은 기본 브랜치를 모르면 미착지 단정을 하지 않는다', () => {
    const message = formatAutoMergeSuccessMessage({ prNumber: 11946, mergedBase: 'self-impl/work-branch' });
    expect(message).toBe('✅ 자동 병합 완료 (#11946) → self-impl/work-branch');
    expect(message).not.toContain('아직 안 감');
    expect(message).not.toContain('기본 브랜치에는 아직 안 감');
  });

  it('confirmed-merge seam의 관측 PR base가 요청 센티널 대신 완료 줄까지 전달된다', async () => {
    const progressMessages: string[] = [];
    const seams: SelfImplementSeams = {
      createWorktree: async ({ branch, base }) => ({ path: `/wt/${branch}`, branch, base, resolvedBase: 'resolved-launch-base', invokedHead: 'head' }),
      refreshCodexQuotaSignals: async () => {},
      implement: async () => ({ ok: true, summary: 'impl' }),
      gate: async () => ({ passed: true, log: 'gate' }),
      defaultBranchRef: () => 'origin/main',
      reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review', reviewed: true, diffTruncated: false, diffShownChars: 1, diffTotalChars: 1, diffOmittedFiles: 0 }),
      openPr: async () => ({ url: 'https://pr/9', number: 9 }),
      approvePr: async () => true,
      readPrCommitShas: async () => ({ baseCommit: 'base', headCommit: 'head', baseRefName: 'actual-retargeted-base' }),
      readPrDiff: async () => '',
      readPrFiles: async () => ['src/x.ts'],
      mergePr: async () => ({ merged: true }),
      mergeMain: async () => ({ status: 'up-to-date', resolvedFiles: [] }),
      postMergeCleanup: { enabled: false } as SelfImplementSeams['postMergeCleanup'],
      onProgress: ({ message }) => progressMessages.push(message),
    };
    const result = await runSelfImplement({ feature: 'merge observation', base: 'elanous:default-branch', autoMerge: true, seams });
    expect(result).toMatchObject({ merged: true, mergedBase: 'actual-retargeted-base' });
    expect(progressMessages).toContain('✅ 자동 병합 완료 (#9) → actual-retargeted-base (main에는 아직 안 감)');
    expect(devCli.renderDevCompletionLine({ kind: 'self', ok: true, runId: result.runId, base: 'elanous:default-branch', result })).toContain('merged-into=actual-retargeted-base');
    expect(devCli.renderDevCompletionLine({ kind: 'self', ok: true, runId: result.runId, base: 'elanous:default-branch', result })).toContain('merged-pr=#9');
  });

  it('confirmed-merge seam이 PR base를 관측하지 못하면 완료 줄은 unknown을 표시한다', async () => {
    const seams: SelfImplementSeams = {
      createWorktree: async ({ branch, base }) => ({ path: `/wt/${branch}`, branch, base, resolvedBase: 'resolved-launch-base', invokedHead: 'head' }),
      refreshCodexQuotaSignals: async () => {},
      implement: async () => ({ ok: true, summary: 'impl' }),
      gate: async () => ({ passed: true, log: 'gate' }),
      defaultBranchRef: () => 'origin/main',
      reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review', reviewed: true, diffTruncated: false, diffShownChars: 1, diffTotalChars: 1, diffOmittedFiles: 0 }),
      openPr: async () => ({ url: 'https://pr/9', number: 9 }),
      approvePr: async () => true,
      readPrCommitShas: async () => ({ baseCommit: 'base', headCommit: 'head' }),
      readPrDiff: async () => '',
      readPrFiles: async () => ['src/x.ts'],
      mergePr: async () => ({ merged: true }),
      mergeMain: async () => ({ status: 'up-to-date', resolvedFiles: [] }),
      postMergeCleanup: { enabled: false } as SelfImplementSeams['postMergeCleanup'],
    };
    const result = await runSelfImplement({ feature: 'merge observation unknown', base: 'elanous:default-branch', autoMerge: true, seams });
    expect(result).toMatchObject({ merged: true });
    expect(result).not.toHaveProperty('mergedBase');
    expect(devCli.renderDevCompletionLine({ kind: 'self', ok: true, runId: result.runId, base: 'elanous:default-branch', result })).toContain('merged-into=unknown');
    expect(devCli.renderDevCompletionLine({ kind: 'self', ok: true, runId: result.runId, base: 'elanous:default-branch', result })).toContain('merged-pr=#9');
  });

  it('병합되지 않은 self 완료 줄은 기존 문자열을 유지한다', () => {
    expect(devCli.renderDevCompletionLine({
      kind: 'self', ok: true, runId: 'run-1', result: { outcome: 'completed', merged: false },
    })).toBe('[dev] self 완료 · ok=true · outcome=completed · run=run-1');
  });

  it('병합된 완료 줄은 위층 PR 번호와 병합 대상을 함께 말한다', () => {
    expect(devCli.renderDevCompletionLine({
      kind: 'self',
      ok: true,
      runId: 'run-7e416b21',
      result: { outcome: 'completed', merged: true, mergedBase: 'main', prNumber: 13376 },
      supervisorStopReason: 'converged',
    })).toBe('[dev] self 완료 · ok=true · outcome=completed · supervisor-stop=converged · merged-into=main · merged-pr=#13376 · run=run-7e416b21');
  });

  it('사람이 중단한 supervisor reason을 완료 줄에 그대로 렌더링한다', () => {
    expect(devCli.renderDevCompletionLine({
      kind: 'self',
      ok: false,
      runId: 'run-human-stopped',
      result: { outcome: 'abandoned', merged: false },
      supervisorStopReason: 'human-stopped',
    })).toBe('[dev] self 완료 · ok=false · outcome=abandoned · supervisor-stop=human-stopped · run=run-human-stopped');
  });

  it('병합됐는데 PR 번호가 없으면 미확인을 말하고 비병합과 구별한다', () => {
    const mergedUnconfirmed = devCli.renderDevCompletionLine({
      kind: 'self',
      ok: true,
      runId: 'run-1',
      result: { outcome: 'completed', merged: true, mergedBase: 'main' },
      supervisorStopReason: 'converged',
    });
    const unmerged = devCli.renderDevCompletionLine({
      kind: 'self',
      ok: true,
      runId: 'run-1',
      result: { outcome: 'completed', merged: false },
      supervisorStopReason: 'converged',
    });
    expect(mergedUnconfirmed).toBe('[dev] self 완료 · ok=true · outcome=completed · supervisor-stop=converged · merged-into=main · merged-pr=unconfirmed · run=run-1');
    expect(unmerged).toBe('[dev] self 완료 · ok=true · outcome=completed · supervisor-stop=converged · run=run-1');
    expect(mergedUnconfirmed).not.toBe(unmerged);
    expect(mergedUnconfirmed).toContain('merged-pr=unconfirmed');
    expect(unmerged).not.toContain('merged-pr');
    expect(unmerged).not.toContain('merged-into');
  });

  it('비병합 결과는 위층 PR 번호가 있어도 병합 표기를 붙이지 않는다', () => {
    expect(devCli.renderDevCompletionLine({
      kind: 'self', ok: true, runId: 'run-1', result: { outcome: 'completed', merged: false, prNumber: 13376 },
    })).toBe('[dev] self 완료 · ok=true · outcome=completed · run=run-1');
  });

  it('완료 줄의 ok·outcome·supervisor-stop·run 이름과 순서는 병합 여부와 무관하게 유지된다', () => {
    const prefix = '[dev] self 완료 · ok=true · outcome=completed · supervisor-stop=converged';
    const suffix = ' · run=run-1';
    const merged = devCli.renderDevCompletionLine({
      kind: 'self',
      ok: true,
      runId: 'run-1',
      result: { outcome: 'completed', merged: true, mergedBase: 'main', prNumber: 13376 },
      supervisorStopReason: 'converged',
    });
    const unmerged = devCli.renderDevCompletionLine({
      kind: 'self',
      ok: true,
      runId: 'run-1',
      result: { outcome: 'completed', merged: false },
      supervisorStopReason: 'converged',
    });
    expect(merged.startsWith(prefix)).toBe(true);
    expect(unmerged.startsWith(prefix)).toBe(true);
    expect(merged.endsWith(suffix)).toBe(true);
    expect(unmerged.endsWith(suffix)).toBe(true);
    expect(merged).toBe(`${prefix} · merged-into=main · merged-pr=#13376${suffix}`);
    expect(unmerged).toBe(`${prefix}${suffix}`);
  });

  it('renderDevCompletionLine은 기존 formatDevCompletionLine 호출로 위층 prNumber를 전달하고 gh를 부르지 않는다', () => {
    const src = readFileSync(resolve(import.meta.dir, 'dev-cli.ts'), 'utf8');
    const renderStart = src.indexOf('export function renderDevCompletionLine');
    expect(renderStart).toBeGreaterThan(-1);
    const renderFn = src.slice(renderStart);
    expect(renderFn).toContain('return formatDevCompletionLine({');
    expect(renderFn).toContain('prNumber: isSelf ? input.result?.prNumber : undefined');
    expect(renderFn).not.toMatch(/\bgh\b/);
    expect(src.slice(src.indexOf('export function formatDevCompletionLine'))).not.toMatch(/\bgh\b/);
  });

  it('default merge seam은 merge exit 0 뒤 상태가 OPEN이면 미병합으로 보고 완료 줄과 cleanup을 기존처럼 유지한다', async () => {
    const calls: string[][] = [];
    const run = ((command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      if (args[0] === 'pr' && args[1] === 'view') return { status: 0, stdout: '{"state":"OPEN","baseRefName":"queued-parent"}\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof spawnSync;
    const result = await defaultSeams({ spawnSync: run }).mergePr!({ number: 9, cwd: '/wt', matchHeadCommit: 'checked-head-sha' });

    expect(result).toEqual({ merged: false, detail: 'PR state is OPEN after merge command' });
    expect(devCli.renderDevCompletionLine({ kind: 'self', ok: true, runId: 'run-1', result: { outcome: 'completed', merged: result.merged } }))
      .toBe('[dev] self 완료 · ok=true · outcome=completed · run=run-1');
    expect(calls).toEqual([
      ['gh', 'pr', 'merge', '9', '--squash', '--match-head-commit', 'checked-head-sha'],
      ['gh', 'pr', 'view', '9', '--json', 'state,baseRefName'],
    ]);
  });

  it('default merge seam은 MERGED 상태 조회의 관측 baseRefName을 완료 줄까지 싣는다', async () => {
    const calls: string[][] = [];
    const run = ((command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      if (args[0] === 'pr' && args[1] === 'view') return { status: 0, stdout: '{"state":"MERGED","baseRefName":"actual-parent-branch"}\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof spawnSync;
    const merge = await defaultSeams({ spawnSync: run }).mergePr!({ number: 9, cwd: '/wt', matchHeadCommit: 'checked-head-sha' });
    const result: SelfImplementResult = selfResult({ stage: 'merged', merged: merge.merged, ...(merge.baseRefName ? { mergedBase: merge.baseRefName } : {}) });

    expect(merge).toEqual({ merged: true, baseRefName: 'actual-parent-branch' });
    expect(devCli.renderDevCompletionLine({ kind: 'self', ok: true, runId: result.runId, base: 'elanous:default-branch', result }))
      .toContain('merged-into=actual-parent-branch');
    expect(calls).toEqual([
      ['gh', 'pr', 'merge', '9', '--squash', '--match-head-commit', 'checked-head-sha'],
      ['gh', 'pr', 'view', '9', '--json', 'state,baseRefName'],
      // 병합 뒤 병합 커밋을 읽는다(#20905 · 릴리스 노트 조각의 mergeSha) — 실패해도 병합 결과는 그대로다.
      ['gh', 'pr', 'view', '9', '--json', 'mergeCommit'],
    ]);
  });

  it('--elanous는 self와 goal이 필수이고 plan은 조합 검증보다 은퇴 사유를 우선한다', () => {
    expect(() => buildDevCliSpec(IN, PTY, { elanous: true, goal: 'x', branch: 'wt/x' })).toThrow(/self backend/);
    expect(() => buildDevCliSpec(IN, SELF, { elanous: true })).toThrow(/--goal 필요/);
    expect(() => buildDevCliSpec(IN, SELF, { elanous: true, goal: 'x', plan: true })).toThrow(new RegExp(`은퇴.*${DEV_PLAN_REPLACEMENT}`));
    expect(() => buildDevCliSpec(IN, SELF, { elanous: true, goal: 'x', openPr: true })).toThrow(/무효한 옵션.*openPr/);
  });

  it('dev --elanous --hold --json only suppresses the wrapper JSON after the hold result', () => {
    expect(shouldSuppressDevJsonWrapper({ elanous: true, hold: true, json: true })).toBe(true);
    expect(shouldSuppressDevJsonWrapper({ elanous: true, hold: true, json: false })).toBe(false);
    expect(shouldSuppressDevJsonWrapper({ elanous: true, hold: false, json: true })).toBe(false);
    expect(shouldSuppressDevJsonWrapper({ elanous: false, hold: true, json: true })).toBe(false);
  });

  it('--hold는 --elanous 전용이고 goal 없는 held TUI spec으로 전달하며 goal과의 충돌은 거부한다', () => {
    expect(buildDevCliSpec(IN, SELF, { elanous: true, hold: true }).elanous).toEqual({ hold: true });
    expect(buildDevCliSpec(IN, SELF, { elanous: true, hold: true, json: true }).elanous).toEqual({ hold: true, json: true });
    expect(() => buildDevCliSpec(IN, SELF, { hold: true })).toThrow(/--hold 는 --elanous/);
    expect(() => buildDevCliSpec(IN, SELF, { elanous: true, hold: true, goal: 'x' })).toThrow(/--hold 와 --goal/);
    // ⛔ 경계값 — `trim()` 기준이면 `--goal ''`/공백이 거부를 통과하고 조립부가 falsy 로 버려
    //    **수락 후 조용히 무시**된다(레포 불변식 위반 · 리뷰 must-fix · 2026-07-30).
    expect(() => buildDevCliSpec(IN, SELF, { elanous: true, hold: true, goal: '' })).toThrow(/--hold 와 --goal/);
    expect(() => buildDevCliSpec(IN, SELF, { elanous: true, hold: true, goal: '   ' })).toThrow(/--hold 와 --goal/);
    // ⛔ brain 전용 옵션은 --hold 와 함께 거부(조용히 무시 금지).
    expect(() => buildDevCliSpec(IN, SELF, { elanous: true, hold: true, maxSteps: '5' })).toThrow(/brain 전용 옵션/);
    expect(() => buildDevCliSpec(IN, SELF, { elanous: true, hold: true, pollMs: '0' })).toThrow(/brain 전용 옵션/);
    expect(() => buildDevCliSpec(IN, SELF, { elanous: true, hold: true, model: 'brain' })).toThrow(/brain 전용 옵션/);
    // ⭐ 그리고 비-hold 경로에서 빈 goal 이 spec 에 **남아야** 한다(버리면 하위 계층이 그 사실을 못 본다).
    expect(buildDevCliSpec(IN, SELF, { elanous: true, goal: 'g' }).elanous).toEqual({ goal: 'g' });
  });

  it('--plan은 completion override보다 은퇴 사유를 우선한다', () => {
    expect(() => buildDevCliSpec(IN, SELF, { plan: true, autoMerge: false })).toThrow(new RegExp(`은퇴.*${DEV_PLAN_REPLACEMENT}`));
    expect(() => buildDevCliSpec(IN, SELF, { plan: true, openPr: false })).toThrow(new RegExp(`은퇴.*${DEV_PLAN_REPLACEMENT}`));
    expect(() => buildDevCliSpec(IN, SELF, { plan: true, autoMerge: false, openPr: false })).toThrow(new RegExp(`은퇴.*${DEV_PLAN_REPLACEMENT}`));
  });

  it('self의 명시 --open-pr + --no-auto-merge는 false를 보존해 auto-merge 대신 pr을 선택한다', () => {
    const spec = buildDevCliSpec(IN, SELF, { openPr: true, autoMerge: false });
    expect(spec).toMatchObject({ completion: 'pr', completionSource: 'request' });
    expect(planDevPipeline(spec)).toMatchObject({ completion: 'pr', completionSource: 'request' });
  });

  // UX 15′(2026-09-26 베어 Ubuntu 26.04): 사람이 친 플래그가 아니면 출처는 default — 원격 없는 저장소의 워크트리 자동 강등이 걸려야 한다.
  it('completion 출처는 «사람이 친» --open-pr·--auto-merge 일 때만 request', () => {
    expect(buildDevCliSpec(IN, SELF, { autoMerge: true }, ['file'])).toMatchObject({ completion: 'auto-merge', completionSource: 'default' });
    expect(buildDevCliSpec(IN, SELF, { autoMerge: true }, ['autoMerge'])).toMatchObject({ completion: 'auto-merge', completionSource: 'request' });
    expect(buildDevCliSpec(IN, SELF, { openPr: true, autoMerge: false }, ['openPr'])).toMatchObject({ completion: 'pr', completionSource: 'request' });
    // 목록이 없으면(프로그램 호출) 종전대로 request
    expect(buildDevCliSpec(IN, SELF, { autoMerge: true })).toMatchObject({ completionSource: 'request' });
  });

  it('self + --auto-review(+PR) → autoReview:true', () => {
    expect(buildDevCliSpec(IN, SELF, { autoReview: true, openPr: true }).autoReview).toBe(true);
  });

  it('--no-open-pr 와 명시 PR 전용 옵션 → 거부(PR 개설 필요·completion 의존)', () => {
    expect(() => buildDevCliSpec(IN, SELF, { openPr: false, autoReview: true })).toThrow(/PR 개설.*필요/);
    expect(() => buildDevCliSpec(IN, SELF, { openPr: false, draft: false })).toThrow(/PR 개설.*필요/);
    // PR 개설 있으면 유효
    expect(buildDevCliSpec(IN, SELF, { autoReview: true, openPr: true }).autoReview).toBe(true);
    expect(buildDevCliSpec(IN, SELF, { draft: false, autoMerge: true }).self).toEqual({ draft: false });
  });

  it('self 플래그 무지정은 capability를 생략하고 resolver default provenance로 무인 완결한다', () => {
    const spec = buildDevCliSpec(IN, SELF, {});
    expect(spec.completion).toBeUndefined();
    expect(spec.autoReview).toBeUndefined();
    expect(planDevPipeline(spec)).toMatchObject({ completion: 'auto-merge', completionSource: 'default', autoReview: true, autoReviewSource: 'default' });
  });

  it('--base 생략은 호출자 HEAD 대신 기본 브랜치 표식을 전달하고, HEAD 및 임의 명시는 그대로 보존한다', () => {
    expect(buildDevCliSpec(IN, SELF, {}).base).toBe('elanous:default-branch');
    expect(buildDevCliSpec(IN, SELF, { base: 'HEAD' }).base).toBe('HEAD');
    expect(buildDevCliSpec(IN, SELF, { base: 'stack/base' }).base).toBe('stack/base');
  });

  it('--base DEFAULT_BRANCH_WORKTREE_BASE도 자동 기본값이 아닌 명시 선택으로 계획한다', () => {
    expect(planDevPipeline(buildDevCliSpec({ file: '/goal.txt' }, SELF, { base: 'elanous:default-branch' })).baseSelection)
      .toEqual({ rule: 'explicit', evidence: 'caller --base' });
  });

  it('살아 있는 spread dispatches preserve an explicit default-branch base provenance', () => {
    const cases = [
      buildDevCliSpec(IN, SELF, { elanous: true, goal: 'child goal', base: 'elanous:default-branch' }),
      buildDevCliSpec(IN, SELF, { goal: 'drive goal', base: 'elanous:default-branch' }),
    ];

    for (const spec of cases) {
      expect(planDevPipeline(spec).baseSelection).toEqual({ rule: 'explicit', evidence: 'caller --base' });
    }
  });

  it('--no-open-pr → worktree-only이며 기본 autoReview도 함께 내려간다', () => {
    const spec = buildDevCliSpec(IN, SELF, { openPr: false });
    expect(spec.completion).toBe('worktree-only');
    expect(spec.autoReview).toBeUndefined();
    expect(planDevPipeline(spec).completion).toBe('worktree-only');
  });

  it('--no-open-pr --auto-merge → 충돌을 거부해 PR 생성·병합 계획을 만들지 않는다', () => {
    expect(() => buildDevCliSpec(IN, SELF, { openPr: false, autoMerge: true })).toThrow(/동시 사용 불가/);
  });

  it('--no-auto-merge → PR은 열고 autoReview는 기본 유지한다', () => {
    const spec = buildDevCliSpec(IN, SELF, { autoMerge: false });
    expect(spec.completion).toBe('pr');
    expect(spec.autoReview).toBeUndefined();
    expect(planDevPipeline(spec)).toMatchObject({ autoReview: true, autoReviewSource: 'default' });
  });

  it('--no-auto-review는 명시 false와 request provenance를 resolver까지 보존한다', () => {
    const spec = buildDevCliSpec(IN, SELF, { autoReview: false });
    expect(spec).toMatchObject({ autoReview: false, autoReviewSource: 'request' });
    expect(planDevPipeline(spec)).toMatchObject({ completion: 'auto-merge', autoReview: false, autoReviewSource: 'request' });
  });

  it('--allow-no-evidence는 self 파일 골 preflight 우회 플래그를 spec에 전달한다', () => {
    expect(buildDevCliSpec({ file: '/goal.txt' }, SELF, { allowNoEvidence: true }).allowNoEvidence).toBe(true);
  });

  it('--allow-superseded-goal은 self 파일 골 Superseded-By preflight 우회 플래그를 spec에 전달한다', () => {
    expect(buildDevCliSpec({ file: '/goal.txt' }, SELF, { allowSupersededGoal: true }).allowSupersededGoal).toBe(true);
  });

  it('--allow-goal-lint-errors는 self 파일 골 lint preflight 우회 플래그를 spec에 전달한다', () => {
    expect(buildDevCliSpec({ file: '/goal.txt' }, SELF, { allowGoalLintErrors: true }).allowGoalLintErrors).toBe(true);
  });

  it('배선 스모크 — index.ts 의 dev 명령이 세 명시 preflight 우회를 선언한다', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf-8');
    const start = src.indexOf(".command('dev [text...]')");
    const end = src.indexOf('.action(', start);
    expect(src.slice(start, end)).toContain('--allow-no-evidence');
    expect(src.slice(start, end)).toContain('--allow-superseded-goal');
    expect(src.slice(start, end)).toContain('--allow-goal-lint-errors');
  });

  it('self-mission --target은 pipeline spec에 그대로 전달되고, 미지정 시 기존 spec에 없다', () => {
    expect(buildDevCliSpec(IN, SELF, { target: '/repo/target' }).target).toBe('/repo/target');
    expect(buildDevCliSpec(IN, SELF, {})).not.toHaveProperty('target');
  });

  it('은퇴한 --plan은 --target 조합보다 먼저 은퇴 사유로 거부한다', () => {
    expect(() => buildDevCliSpec(IN, SELF, { plan: true, target: '/repo/target' })).toThrow(/--plan 은 은퇴했고 명시적으로 거부됨.*elanous harness say/);
  });

  it('self-mission 외 경로의 --target은 조용히 폐기하지 않고 거부한다', () => {
    expect(() => buildDevCliSpec(IN, SELF, { implement: true, target: '/repo/target' })).toThrow(/무효한 옵션.*target/);
    expect(() => buildDevCliSpec(IN, PTY, { branch: 'wt/x', target: '/repo/target' })).toThrow(/무효한 옵션.*target/);
    expect(() => buildDevCliSpec(IN, ACP, { target: '/repo/target' })).toThrow(/무효한 옵션.*target/);
  });

  it('self 비-plan + --ground → spec.self.ground:true', () => {
    expect(buildDevCliSpec(IN, SELF, { ground: true }).self?.ground).toBe(true);
  });

  it('ground:false → spec.self 과 정규화된 plan 에 false 전달', () => {
    const spec = buildDevCliSpec(IN, SELF, { ground: false });
    expect(spec.self?.ground).toBe(false);
    expect(planDevPipeline(spec).self?.ground).toBe(false);
  });

  it('--ground 미지정 → spec.self 생략(ground 키 부재)', () => {
    const spec = buildDevCliSpec(IN, SELF, {});
    expect(spec.self).toBeUndefined();
  });

  it('self + --ground + --plan → ground 조합보다 은퇴 거부가 우선한다', () => {
    expect(() => buildDevCliSpec(IN, SELF, { ground: true, plan: true })).toThrow(/--plan 은 은퇴했고 명시적으로 거부됨.*elanous harness say/);
  });

  it('external+pty + --ground → ground 명시 거부', () => {
    expect(() => buildDevCliSpec(IN, PTY, { branch: 'wt/x', ground: true })).toThrow(/무효한 옵션.*ground/);
  });

  it('external+pty + ground:false → 조용히 폐기하지 않고 명시 거부(수락 후 무시 금지)', () => {
    expect(() => buildDevCliSpec(IN, PTY, { branch: 'wt/x', ground: false })).toThrow(/무효한 옵션.*ground/);
  });

  // ★ 배선 스모크(무인 리뷰 should-fix 반영) — 위 테스트들은 순수 seam(buildDevCliSpec)만 덮는다. 상위
  //   Commander 진입점(`src/index.ts` 의 `dev` 명령)이 `--ground` 를 **선언하지 않으면** 옵션이 애초에
  //   파싱되지 않아 seam 이 영원히 undefined 를 받는데, seam 테스트는 그래도 전부 통과한다(옵션명 오타도
  //   무검증 통과). 소스레벨 대조로 그 갭을 닫는다([[feedback_source_level_grep_test_value]] 선례:
  //   schedule-runner.test.ts 가 nexus/index.ts 를 같은 방식으로 검사). Commander 인스턴스를 띄우지
  //   않으므로 index.ts 부팅 부작용(데몬·sink) 없이 배선만 검증한다.
  it('배선 스모크 — index.ts dev --file은 명시 --context가 없을 때만 TRACED PATHS를 기존 loader로 전달한다', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf-8');
    const start = src.indexOf(".command('dev [text...]')");
    const action = src.slice(src.indexOf('.action(', start), src.indexOf('if (devOpts.worktree === true)', start));
    expect(action).toContain("'file' in input");
    expect(action).toContain("!invokedAsDrive && !hasExplicitReviewerContext && 'file' in input");
    expect(action).toContain('tracedPathReferences(readFileSync(input.file, \'utf8\'))');
    expect(action).toContain(".map(({ path }) => ({ kind: 'file' as const, value: path }))");
    expect(action).toContain('hasExplicitReviewerContext ? reviewerContextArgs(argv) : derivedContextOrder');
    expect(action).toContain('loadReviewerContext({ contextOrder }, createRepositoryReferencedFileReader(process.cwd()))');
  });

  it('배선 스모크 — index.ts dev는 은퇴 옵션을 선언하지 않고 기본 파이프라인·비대상 옵션을 보존한다', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf-8');
    const start = src.indexOf(".command('dev [text...]')");
    expect(start).toBeGreaterThan(-1);
    // dev 명령의 옵션 선언 구간 = .command('dev …') 부터 그 .action( 까지.
    const end = src.indexOf('.action(', start);
    expect(end).toBeGreaterThan(start);
    const devBlock = src.slice(start, end);
    for (const retired of [
      '--open-pr', '--auto-merge', '--auto-review', '--enhance', '--no-enhance', '--ground',
      '--activity-grace', '--supervise-rounds', '--live-run-window', '--recent-change-window',
      '--no-launch-decomposition', '--max-wait', '--cols', '--rows',
    ]) expect(devBlock).not.toContain(`.option('${retired}`);
    expect(devBlock).toContain("--no-auto-merge");
    expect(devBlock).toContain("--force-preflight");
    expect(devBlock).toContain("--attach <ref>");
    expect(devBlock).toContain("--base <branch>");
    expect(devBlock).toContain("--context <path>");
    expect(devBlock).toContain("--role-llm <role=provider[/tier]>");
    expect(devBlock).toContain("--child-llm-provider <id>");
    expect(devBlock).toContain("--child-llm-model <id>");
    expect(devBlock).toContain("--backend <id>");
    expect(planDevPipeline(buildDevCliSpec(IN, SELF, {}))).toMatchObject({
      dispatch: 'self-mission', completion: 'auto-merge', autoReview: true,
    });
  });

  it('배선 스모크 — index.ts dev는 은퇴 옵션 오류와 골-구동 harness 안내를 stderr 전용으로 연결한다', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf-8');
    const start = src.indexOf(".command('dev [text...]')");
    const action = src.slice(src.indexOf('.action(', start), src.indexOf('if (devOpts.worktree === true)', start));
    expect(src.slice(start, src.indexOf('.action(', start))).toContain('retiredDevOptionNotice(error)');
    expect(src).toContain("'--open-pr': 'PR 개설 활성'");
    expect(src).toContain("'--activity-grace': '240초'");
    expect(action).toContain('devHarnessRetirementNotice(retirementInput, opts.plan === true)');
    expect(action).toContain('if (!opts.json)');
    expect(src).toContain('elanous harness ask');
    expect(src).toContain('elanous harness say');
    const retirementNotice = src.slice(src.indexOf('function devHarnessRetirementNotice'), src.indexOf('const selfDevCmd'));
    expect(retirementNotice).toContain('`${DEV_PLAN_REPLACEMENT} ${quoteDevHarnessArgument(input.value)}`');
    expect(retirementNotice).not.toContain('elanous harness plan');
  });

  // ⛔⭐⭐⭐ 이 단언은 **`index.ts` 를 보다가 `dev-pipeline.ts` 로 옮겨졌다**(2026-08-03 · `JDG-S21`).
  //   `goalId` 배선의 실제 자리가 `index.ts` 에서 `dev-pipeline.ts` 로 이동했는데 단언은 계속
  //   `index.ts` 문자열을 봤다 ⇒ **`main` 에서 상시 실패**하고 있었고, 아무도 그것을 안 봤다.
  //   ⛔ 그 사이 무인 리뷰가 자율 런에게 *"그 단언을 복원하라"* 를 must-fix 로 냈고 —
  //      **복원하면 실패하는 단언이었다** — 자식이 두 라운드 이행하지 않자 감독이 런을 죽였다.
  //      ⇒ ***자식은 맞았고, 맞았기 때문에 죽었다.***
  //   ⭐ 그래서 여기서는 **배선이 실제로 사는 파일**을 문다. 배선이 또 옮겨지면 이 단언은
  //      **옮긴 사람의 손에서 즉시 빨갛게** 된다(상시 실패로 잠들지 않는다).
  it('배선 스모크 — 파일 골의 goalId 가 dev-pipeline 에서 파싱되어 디스패치로 전파된다', () => {
    const pipeline = readFileSync(join(import.meta.dir, 'dev-pipeline.ts'), 'utf-8');
    expect(pipeline).toContain('parseGoalId');
    // 파일 입력일 때만 파싱한다(텍스트 입력에는 골 메타데이터가 없다).
    expect(pipeline).toMatch(/'file' in plan\.input \? parseGoalId\(/);
    // 있을 때만 실어 보낸다 — 없으면 키 자체가 없어야 조회에서 "미상"과 "없음"이 갈린다.
    expect(pipeline).toContain('...(goalId ? { goalId } : {})');
  });

  it('external+pty + --evidence doc → mission.evidence(doc·기본 dir/glob)·maxRounds·dispatch agent-mission-pty', () => {
    const spec = buildDevCliSpec(IN, PTY, { branch: 'wt/x', evidence: 'doc', maxRounds: '20', commit: false });
    expect(spec.mission?.evidence).toEqual({ kind: 'doc', dirRel: 'docs/plans', glob: /^PLAN-.*\.md$/i });
    expect(spec.mission?.maxRounds).toBe(20);
    expect(spec.mission?.commit).toBe(false);
    expect(planDevPipeline(spec).dispatch).toBe('agent-mission-pty');
  });

  it('external+pty 기본 → completion 기본값을 주입하지 않고 mission.evidence tsc', () => {
    const spec = buildDevCliSpec(IN, PTY, { branch: 'wt/x' });
    expect(spec.completion).toBeUndefined();
    expect(spec.autoReview).toBeUndefined();
    expect(spec.mission?.evidence).toEqual({ kind: 'tsc' });
  });

  it('acp 기본 → completion 기본값을 주입하지 않고 self?/mission? 없음 · dispatch acp', () => {
    const spec = buildDevCliSpec(IN, ACP, {});
    expect(spec.completion).toBeUndefined();
    expect(spec.self).toBeUndefined();
    expect(spec.mission).toBeUndefined();
    expect(planDevPipeline(spec).dispatch).toBe('acp');
  });

  it('external+pty + --open-pr → 거부(agent-mission PR 완결 미배선·조용히 안 버림)', () => {
    expect(() => buildDevCliSpec(IN, PTY, { branch: 'wt/x', openPr: true })).toThrow(/무효한 옵션.*openPr/);
  });

  // ── 배선 — 「그 함수가 있다」가 아니라 「그 줄이 실행 경로로 «나온다»」를 문다 ──────────
  //
  // ⛔ 순수 포매터만 무는 시험은 「형태는 맞는데 실행 경로엔 없다」를 통과시킨다(GOODHART).
  //   그래서 여기서는 실제 `executeDevSelfRun` 을 태워 감독자 결정이 출력기에 «닿는지»를 본다.
  describe('executeDevSelfRun — 감독자 결정이 사람이 보는 자리에 닿는다', () => {
    const supervisedResult = () => selfResult({ stage: 'merged', merged: true });

    it('주입 출력기로 감독자 줄이 «실제로» 나온다', async () => {
      const printed: string[] = [];
      await devCli.executeDevSelfRun(
        'wiring goal',
        async (relaunch) => (relaunch ? supervisedResult() : selfResult()),
        { rounds: 1, printDecision: (line) => { printed.push(line); } },
      );
      expect(printed.length).toBeGreaterThan(0);
      expect(printed.every((line) => line.startsWith('[supervisor] '))).toBe(true);
    });

    it('출력기를 «안 주면» 기본이 stderr 로 낸다 — 배선을 잊어도 경로에 남는다', async () => {
      const seen: string[] = [];
      const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { seen.push(args.map(String).join(' ')); });
      try {
        await devCli.executeDevSelfRun(
          'default printer goal',
          async (relaunch) => (relaunch ? supervisedResult() : selfResult()),
          { rounds: 1 },
        );
      } finally { spy.mockRestore(); }
      expect(seen.some((line) => line.startsWith('[supervisor] '))).toBe(true);
    });

    // ⛔ 「런이 살았다」만 보면 이 회귀를 놓친다 — `superviseRun` 이 루프를 지켜 주므로 런은 «어차피» 산다.
    //   잡아야 할 것은 «출력기 하나가 죽을 때 뒤의 소비자도 같이 사라지는가»다(리뷰가 잡은 실물 회귀).
    it('출력기가 throw 해도 뒤의 onDecision 소비자가 «그대로» 불린다', async () => {
      const consumed: string[] = [];
      const execution = await devCli.executeDevSelfRun(
        'consumer-order goal',
        async (relaunch) => (relaunch ? supervisedResult() : selfResult()),
        {
          rounds: 1,
          printDecision: () => { throw new Error('printer exploded'); },
          onDecision: (decision) => { consumed.push(decision.action); },
        },
      );
      expect(execution.result).toBeDefined();
      expect(consumed.length).toBeGreaterThan(0);   // ⛔ 0 이면 출력 실패가 소비자를 삼킨 것
      // ⛔ 「불렸다」와 「무엇이 전달됐다」는 다른 값 — 빈 결정이 흘러도 위 단언은 통과한다.
      expect(consumed).toContain('relaunch');
    });

    it('출력기가 throw 해도 런이 죽지 않는다', async () => {
      const execution = await devCli.executeDevSelfRun(
        'fail-soft goal',
        async (relaunch) => (relaunch ? supervisedResult() : selfResult()),
        { rounds: 1, printDecision: () => { throw new Error('printer exploded'); } },
      );
      expect(execution.result).toBeDefined();
    });
  });

});

describe('buildDevCliSpec — 경로-무관 옵션 명시 거부(수락 후 무시 금지·리뷰 must-fix #1)', () => {
  it('self 에 mission 옵션(--evidence) → 거부', () => {
    expect(() => buildDevCliSpec(IN, SELF, { evidence: 'doc' })).toThrow(/무효한 옵션.*evidence/);
  });
  it('external+pty 에 self 옵션(--max-wait/--no-draft) → 거부', () => {
    expect(() => buildDevCliSpec(IN, PTY, { branch: 'wt/x', maxWait: '900' })).toThrow(/무효한 옵션.*maxWait/);
    expect(() => buildDevCliSpec(IN, PTY, { branch: 'wt/x', activityGrace: '600' })).toThrow(/무효한 옵션.*activityGrace/);
    expect(() => buildDevCliSpec(IN, PTY, { branch: 'wt/x', draft: false })).toThrow(/무효한 옵션.*draft/);
  });
  it('--plan 은 경로와 조합 옵션보다 은퇴 거부가 우선한다', () => {
    expect(() => buildDevCliSpec(IN, SELF, { plan: true, autoReview: true })).toThrow(/--plan 은 은퇴했고 명시적으로 거부됨.*elanous harness say/);
    expect(() => buildDevCliSpec(IN, SELF, { plan: true, maxWait: '900' })).toThrow(/--plan 은 은퇴했고 명시적으로 거부됨.*elanous harness say/);
    expect(() => buildDevCliSpec(IN, PTY, { branch: 'wt/x', plan: true })).toThrow(/--plan 은 은퇴했고 명시적으로 거부됨.*elanous harness say/);
  });
  it('acp 에 mission·self 옵션 → 거부', () => {
    expect(() => buildDevCliSpec(IN, ACP, { evidence: 'doc' })).toThrow(/무효한 옵션/);
    expect(() => buildDevCliSpec(IN, ACP, { maxWait: '900' })).toThrow(/무효한 옵션/);
  });
});

describe('parsePositiveInt / evidence 검증(오타·비정상값 거부·must-fix #2/#3)', () => {
  it('--evidence 미지원 값 → 거부(tsc 폴백 X)', () => {
    expect(() => buildDevEvidence({ evidence: 'xyz' })).toThrow(/tsc\|doc\|test/);
    expect(() => buildDevCliSpec(IN, PTY, { branch: 'wt/x', evidence: 'xyz' })).toThrow(/tsc\|doc\|test/);
  });
  it('evidence-종속 하위옵션 모드 불일치 → 거부(수락 후 무시 금지·리뷰 must-fix)', () => {
    // tsc(기본)에 doc/test 하위옵션
    expect(() => buildDevEvidence({ docDir: 'x' })).toThrow(/--doc-dir\/--doc-glob 은 --evidence doc/);
    expect(() => buildDevEvidence({ testPath: 'x' })).toThrow(/--test-path 는 --evidence test/);
    // doc 모드에 test-path
    expect(() => buildDevEvidence({ evidence: 'doc', testPath: 'x' })).toThrow(/--test-path 는 --evidence test/);
    // test 모드에 doc-dir
    expect(() => buildDevEvidence({ evidence: 'test', testPath: 'p', docDir: 'x' })).toThrow(/--doc-dir\/--doc-glob 은 --evidence doc/);
    // 통합 — agent-mission-pty 경로에서도 거부
    expect(() => buildDevCliSpec(IN, PTY, { branch: 'wt/x', docGlob: '^R' })).toThrow(/--doc-dir\/--doc-glob 은 --evidence doc/);
  });
  it('--doc-glob 잘못된 정규식 → DevPipelineError(raw SyntaxError 아님·일관된 CLI 에러)', () => {
    expect(() => buildDevEvidence({ evidence: 'doc', docGlob: '[invalid(' })).toThrow(/정규식 오류/);
  });
});

describe('elanous dev --file 수동 골 진입점', () => {
  it('수동 파일을 shared 증거 위치 계약으로 보강한 self-child payload까지 전달한다', async () => {
    const file = '/tmp/hand-authored-goal.txt';
    const manualGoal = `## PROBLEM\n사람이 손으로 작성한 골\n\n## WHAT TO BUILD\n자식 발사 확인\n\n## ACCEPTANCE CRITERIA\n발사한다\n\n## REQUIRED EVIDENCE\n- [launch] 자식 발사 확인\n\n## TRACED PATHS\n- src/self-dev/dev-cli.ts\n\n## SCOPE BOUNDARY\n- 발사 경계만\n\n## 답하지 못하는 것\n- 없다\n\n## 불변식\n- 기존 발사 유지\n\n## 판정 신호\n- 발사됨`;
    let payload: SelfImplementOptions | undefined;

    await runDevPipeline({ input: buildDevCommandInput({ kind: 'file', value: file }) }, {
      readFile: (path) => {
        expect(path).toBe(file);
        return manualGoal;
      },
      buildSelfImplementSeams: () => ({} as SelfImplementSeams),
      runSelfImplement: async (options) => {
        payload = options;
        return { ok: true, stage: 'pr-declined' } as SelfImplementResult;
      },
    });

    expect(payload?.feature).toBe(`${manualGoal}\n\n${EVIDENCE_LOCATION_REQUIREMENT}`);
  });

  it('GoalId PR head를 self dispatch base로 전달하고 legacy base-only spec도 보존한다', async () => {
    const file = '/tmp/rework-goal.txt';
    const goal = `Rework child\n- GoalId: 02622d5108f2aaba\n\n## PROBLEM\nP\n\n## WHAT TO BUILD\nW\n\n## ACCEPTANCE CRITERIA\nA\n\n## REQUIRED EVIDENCE\n- [requested] E\n\n## TRACED PATHS\n- src/self-dev/dev-cli.ts\n\n## SCOPE BOUNDARY\n- B\n\n## 답하지 못하는 것\n- 없다\n\n## 불변식\n- I\n\n## 판정 신호\n- S`;
    const bases: string[] = [];
    const run = async (spec: Parameters<typeof runDevPipeline>[0], runGh: (args: string[]) => string) => {
      await runDevPipeline(spec, {
        readFile: (path) => { expect(path).toBe(file); return goal; },
        runGh,
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async (options) => {
          bases.push(options.base!);
          return { ok: true, stage: 'pr-declined' } as SelfImplementResult;
        },
      });
    };

    await run(buildDevCliSpec({ file }, SELF, {}), (args) => args[1] === 'list'
      ? '[{"number":6944,"updatedAt":"2026-08-04T01:00:00Z","state":"OPEN"}]'
      : '{"headRefName":"self-impl-rework"}');
    await run(buildDevCliSpec({ file }, SELF, { base: 'elanous:default-branch' }), () => {
      throw new Error('explicit default base must not query gh');
    });
    await run({ input: { file }, base: 'legacy-human-base' }, () => { throw new Error('legacy base must not query gh'); });

    expect(bases).toEqual(['self-impl-rework', 'elanous:default-branch', 'legacy-human-base']);
  });

  it('선택 완료된 file/text variant만 파이프라인 입력으로 변환한다', () => {
    expect(buildDevCommandInput({ kind: 'file', value: '/tmp/hand-authored-goal.txt' }))
      .toEqual({ file: '/tmp/hand-authored-goal.txt' });
    expect(buildDevCommandInput({ kind: 'text', value: 'other input' }))
      .toEqual({ text: 'other input' });
  });

  it('--say를 직접 저작 시드로 선택한다', () => {
    expect(selectDevAuthorInput([], { say: '문장 시드' })).toEqual({ kind: 'say', value: '문장 시드' });
  });

  it('ask와 say를 함께 받으면 두 이름을 말하며 저작 전에 거부한다', () => {
    expect(() => selectDevAuthorInput([], { ask: 'ask.md', say: 'say' }))
      .toThrow('--ask, --say 는 동시 사용 불가 — 하나만');
  });

  it('ask/say/file/text 중 둘 이상이면 이름을 모두 말하며 저작 전에 거부한다', () => {
    expect(() => selectDevAuthorInput(['text'], { ask: 'ask.md', say: 'say', file: 'goal.md' }))
      .toThrow('--ask, --say, --file, <text...> 는 동시 사용 불가 — 하나만');
  });

  // ⛔ 「빈 입력」 거부의 «단일 소유자»가 이 seam 이다 — `#8177` 잔여 must-fix 로 index.ts 의
  //   중복 검사를 지웠으므로(`--say` 분기는 죽은 가지였다), 여기가 «유일한 방어»다.
  //   ⚠️ 이 시험이 없으면 그 중복 제거가 조용한 회귀가 된다.
  it.each([
    ['--say', [] as string[], { say: '   ' }],
    ['--ask', [] as string[], { ask: '  ' }],
    ['--file', [] as string[], { file: '\t' }],
    ['<text...>', ['   '], {}],
  ])('%s 가 공백뿐이면 그 이름을 대며 저작 전에 거부한다', (name, textParts, opts) => {
    expect(() => selectDevAuthorInput(textParts, opts)).toThrow(`${name} 입력이 비었다`);
  });
});

describe('통합 — runDevPipeline → devResultOk(실행 배선·parallel/plan-staged)', () => {
  it('parallel: 전 잡 done→ok true·failed 있으면 false', async () => {
    const done = { status: 'done' } as SelfDevJobResult;
    const par = await runDevPipeline(buildSelfOrchestrateDevSpec([{ feature: 'g' }]), { orchestrateSelfDev: async () => [done] });
    expect(devResultOk(par)).toBe(true);
    const parFail = await runDevPipeline(buildSelfOrchestrateDevSpec([{ feature: 'g' }]), { orchestrateSelfDev: async () => [{ status: 'failed' } as SelfDevJobResult] });
    expect(devResultOk(parFail)).toBe(false);
  });
  it('plan-staged: staged output→ok true(순진한 .ok 였으면 false 였을 것)', async () => {
    const ps = await runDevPipeline(buildSelfImplementPlanDevSpec({ feature: 'F' }), { dispatchRunDevHarness: async () => ({ output: 'x' }) });
    expect(devResultOk(ps)).toBe(true);
  });
  it('maxWait/maxRounds 비정상값(0·음수·비숫자·소수·Infinity) → 거부·양의정수만', () => {
    for (const bad of ['0', '-5', 'x', '1.5', 'Infinity']) {
      expect(() => parsePositiveInt(bad, '--max-wait')).toThrow(/양의 정수/);
    }
    expect(parsePositiveInt('900', '--max-wait')).toBe(900);
    expect(() => buildDevCliSpec(IN, SELF, { maxWait: '0' })).toThrow(/양의 정수/);       // self.maxWaitSec
    expect(() => buildDevCliSpec(IN, PTY, { branch: 'wt/x', maxRounds: '-1' })).toThrow(/양의 정수/); // mission.maxRounds
  });
});

describe('buildDevEvidence', () => {
  it('기본 tsc · doc 기본/커스텀 · test 는 --test-path 필수', () => {
    expect(buildDevEvidence({})).toEqual({ kind: 'tsc' });
    expect(buildDevEvidence({ evidence: 'doc', docDir: 'docs', docGlob: '^RFC-' })).toEqual({ kind: 'doc', dirRel: 'docs', glob: /^RFC-/i });
    expect(buildDevEvidence({ evidence: 'test', testPath: 'src/x.test.ts' })).toEqual({ kind: 'test', testPath: 'src/x.test.ts' });
    expect(() => buildDevEvidence({ evidence: 'test' })).toThrow(/--test-path/);
  });
});

describe('devResultOk — kind 별 성공판정(latent 버그 수리)', () => {
  const plan = {} as ResolvedDevPlan;
  it('self/agent-mission/acp → result.ok', () => {
    expect(devResultOk({ plan, kind: 'self', result: { ok: true } as SelfImplementResult })).toBe(true);
    expect(devResultOk({ plan, kind: 'self', result: { ok: false } as SelfImplementResult })).toBe(false);
    expect(devResultOk({ plan, kind: 'agent-mission', result: { ok: true } as AgentMissionResult })).toBe(true);
    expect(devResultOk({ plan, kind: 'agent-mission', result: { ok: false } as AgentMissionResult })).toBe(false);
    expect(devResultOk({ plan, kind: 'acp', result: { ok: true } as AcpRunResult })).toBe(true);
    expect(devResultOk({ plan, kind: 'acp', result: { ok: false } as AcpRunResult })).toBe(false);
  });
  it('parallel → 전 잡 done 여야(빈 배열=false)', () => {
    const done = { status: 'done' } as SelfDevJobResult;
    expect(devResultOk({ plan, kind: 'parallel', result: [done, done] })).toBe(true);
    expect(devResultOk({ plan, kind: 'parallel', result: [done, { status: 'failed' } as SelfDevJobResult] })).toBe(false);
    expect(devResultOk({ plan, kind: 'parallel', result: [] })).toBe(false);
  });
  it('interactive/plan-staged → 완료=성공(true·순진한 .ok 였으면 false 였을 것)', () => {
    expect(devResultOk({ plan, kind: 'interactive', result: null })).toBe(true);
    expect(devResultOk({ plan, kind: 'plan-staged', result: { output: 'x' } })).toBe(true);
  });
});

// ⛔⭐⭐⭐ `drive` 거부 문면은 **길을 같이 준다** (2026-08-03 · `[S]` 제보 `OBS-S26` → `[T]` 수리)
//
// 왜 이 테스트가 있나: `dev` 와 `drive` 는 **한 Commander 명령의 두 이름**이라 도움말이 하나뿐인데
// 계약은 이름마다 갈린다. 그래서 `drive --help` 가 `--elanous` 를 광고하고 실행하면 거부된다 —
// ***자식이 읽을 수 있는 유일한 계약 문서가 도움말인데 그것이 거짓이었다.***
// 실측(2026-08-03): 하니스 자식이 그것을 믿고 `drive` 경로에서 죽었다.
//
// ⛔ 거부 **자체**는 옳다 — RFC-two-command-convergence §6-2 불변식이
//   *"`elanous drive` 에 elanous 자식을 아는 플래그를 다시 넣지 않는다"* 이다(#5668 이 되돌린 그것).
//   그래서 이 테스트는 **거부가 사라지지 않는 것**과 **길이 붙는 것**을 같이 문다.
describe('drive 별칭 거부 — 금지만 있고 길이 없는 형태를 막는다', () => {
  it('거부는 유지된다 (RFC §6-2 불변식 — 계약을 무르지 않는다)', () => {
    expect(() => devCli.assertDriveAliasOptions(['elanous'])).toThrow(/지원하지 않는 옵션/);
    // ⛔⭐ 손으로 적은 수는 «늙는다» — 종전 문면이 「다섯뿐이다」인데 목록은 «일곱»이었다.
    //   실측(2026-08-20 로그 12시간): 이 거부가 85건 났고 그때마다 자식이 «모순된 안내»를 읽었다.
    //   ⇒ 문면의 수와 «실제로 나열한 개수»가 같은지를 시험이 문다.
    try {
      devCli.assertDriveAliasOptions(['elanous']);
      throw new Error('거부가 나야 한다');
    } catch (error) {
      const message = (error as Error).message;
      const claimed = /받는 옵션은 (\d+)개뿐이다: (.+)/.exec(message);
      expect(claimed).not.toBeNull();
      expect(Number(claimed![1])).toBe(claimed![2]!.split(' · ').length);
    }

    expect(() => devCli.assertDriveAliasOptions(['backend'])).toThrow(/--backend/);
  });

  it('거부 문면이 ⓐ허용 목록과 ⓑ대안 명령을 같이 말한다', () => {
    let message = '';
    try { devCli.assertDriveAliasOptions(['elanous']); } catch (e) { message = String((e as Error).message); }
    // ⓐ 다섯 허용 옵션이 전부 문면에 있다 — "그럼 뭘 쓰나"에 답한다.
    for (const flag of ['--goal', '--max-steps', '--poll-ms', '--model', '--cwd', '--attach']) {
      expect(message).toContain(flag);
    }
    // ⓑ 어디서 쓰라는 길이 있다.
    expect(message).toContain('elanous dev');
    // ⓒ ⛔ **왜** 도움말이 거짓으로 보이는지 — 그 인과를 말해야 한다.
    //   ⚠️ 초판은 '도움말' 이라는 **낱말 하나**만 물었다(무인 리뷰 must-fix: Goodhart).
    //     그러면 "도움말을 보라" 같은 정반대 문장도 통과한다. 필수 사실은 **공유**와 **경고**다.
    expect(message).toContain('dev 와 drive');
    expect(message).toMatch(/도움말을 공유/);
    expect(message).toMatch(/계약으로 읽지 마라/);
  });

  it('허용 옵션 아홉은 통과한다 (거부가 넓어지지 않았다 · DRIVE-JAIL --jail-home)', () => {
    expect(() => devCli.assertDriveAliasOptions(['goal', 'maxSteps', 'pollMs', 'model', 'cwd', 'worktree', 'json', 'attach', 'jailHome'])).not.toThrow();
    expect(() => devCli.assertDriveAliasOptions([])).not.toThrow();
  });

  it('attributeName → CLI 플래그 역변환이 맞다 (maxSteps → --max-steps)', () => {
    let message = '';
    try { devCli.assertDriveAliasOptions(['autoDrive']); } catch (e) { message = String((e as Error).message); }
    expect(message).toContain('--auto-drive');
  });
});

describe('dev --plan help names the replacement door', () => {
  async function captureDevHelp(): Promise<string> {
    const { program } = await import('../index.js');
    const dev = program.commands.find((command) => command.name() === 'dev');
    if (!dev) throw new Error('dev command missing');
    const chunks: string[] = [];
    const write = (chunk: string) => { chunks.push(chunk); };
    const previousExit = (dev as { _exitCallback?: unknown })._exitCallback;
    dev.exitOverride();
    dev.configureOutput({ writeOut: write, writeErr: write });
    try {
      await program.parseAsync(['node', 'elanous', 'dev', '--help']);
    } catch (error) {
      if ((error as { code?: string }).code !== 'commander.helpDisplayed') throw error;
    } finally {
      (dev as { _exitCallback?: unknown })._exitCallback = previousExit;
      dev.configureOutput({
        writeOut: (str) => process.stdout.write(str),
        writeErr: (str) => process.stderr.write(str),
      });
    }
    return chunks.join('');
  }

  it('formatDevPlanOptionHelp interpolates the replacement argument instead of baking a destination literal', () => {
    expect(formatDevPlanOptionHelp(DEV_PLAN_REPLACEMENT)).toContain(DEV_PLAN_REPLACEMENT);
    expect(formatDevPlanOptionHelp(DEV_PLAN_REPLACEMENT)).toContain('대응 문');
    const other = 'elanous harness OTHER-DOOR';
    const composedOther = formatDevPlanOptionHelp(other);
    expect(composedOther).toContain(other);
    expect(composedOther).not.toContain(DEV_PLAN_REPLACEMENT);
  });

  it('parseAsync dev --help renders the notice composed from DEV_PLAN_REPLACEMENT without mutating Commander', async () => {
    const { program } = await import('../index.js');
    const plan = program.commands.find((command) => command.name() === 'dev')
      ?.options.find((option) => option.long === '--plan');
    const composed = formatDevPlanOptionHelp(DEV_PLAN_REPLACEMENT);
    expect(plan?.description).toBe(composed);

    const help = await captureDevHelp();
    const flat = help.replace(/\s+/g, ' ');
    expect(flat).toContain('--plan');
    expect(flat).toContain(DEV_PLAN_REPLACEMENT);
    expect(flat).toContain(composed.replace(/\s+/g, ' '));
    expect(flat).toContain('self: headless implementation chat turn(--new·--tools·--goal-loop·interactive dispatch)');
    expect(flat).toContain('self: 격리 bare elanous TUI child를 LLM 제어 루프로 목표까지 구동');
    expect(flat).toContain('--ask <path>');
    expect(flat).toContain('--say <text>');
    expect(flat).toContain('--file <path>');
    expect(flat).toContain('--attach <ref>');

    const original = plan!.description;
    const other = 'elanous harness OTHER-DOOR';
    plan!.description = formatDevPlanOptionHelp(other);
    try {
      const mutated = (await captureDevHelp()).replace(/\s+/g, ' ');
      expect(mutated).toContain(other);
      expect(mutated).not.toContain(DEV_PLAN_REPLACEMENT);
    } finally {
      plan!.description = original;
    }
  }, 60_000);
});

// ⏱️ GATE-SPEED ③ — 아래 세 describe 는 실물 `bin/elanous.mjs` spawn 을 «그대로» 두고 기다리는 방식만
//   비동기 ⊕ 상한 있는 동시성(`describe.concurrent` ⊕ `spawnRealCli`)으로 바꿨다. spawn 타임아웃은 슬롯을 얻은
//   뒤부터 재므로 시험 타임아웃은 대기열 몫까지 넉넉히 둔다.
const REAL_CLI_TEST_TIMEOUT_MS = 600_000;

describe.concurrent('dev 은퇴 옵션 실물', () => {
  const cli = resolve(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
  const repo = resolve(import.meta.dir, '..', '..');
  const retiredDefaults = {
    '--open-pr': 'PR 개설 활성',
    '--auto-merge': '리뷰 clean 시 자동 병합 활성',
    '--auto-review': 'auto-review 활성',
    '--enhance': '입구 정책이 인핸싱 여부 결정',
    '--no-enhance': '입구 정책이 인핸싱 여부 결정',
    '--ground': 'codebase grounding 비활성',
    '--activity-grace': '240초',
    '--supervise-rounds': '3 라운드',
    '--live-run-window': '30분',
    '--recent-change-window': '7일',
    '--no-launch-decomposition': '발사 전 분해 활성',
    '--max-wait': '시스템 대기 상한',
    '--cols': '160',
    '--rows': '40',
  } as const;

  it('Commander에서 A 옵션 14개를 제거하고 각 옵션의 자동 적용 기본값을 고정한다', async () => {
    const src = readFileSync(resolve(import.meta.dir, '../index.ts'), 'utf8');
    const devStart = src.indexOf(".command('dev [text...]')");
    const devEnd = src.indexOf('const DEV_PRIMARY_HELP_OPTIONS', devStart);
    const devBlock = src.slice(devStart, devEnd);
    expect(devStart).toBeGreaterThan(-1);
    expect(devEnd).toBeGreaterThan(devStart);
    for (const [option, defaultValue] of Object.entries(retiredDefaults)) {
      expect(devBlock).not.toContain(`.option('${option}`);
      expect(src).toContain(`'${option}': '${defaultValue}'`);
    }
  });

  it.each(Object.entries(retiredDefaults))('%s는 unknown option과 자동 적용 기본값을 stderr 한 줄로 함께 알린다', async (option, defaultValue) => {
    const result = await spawnRealCli(['bun', cli, '--test', 'dev', option], { cwd: repo, timeoutMs: 60_000 });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`unknown option '${option}'`);
    expect(result.stderr).toContain(`⚠️ ${option} 은퇴; 적용 기본값: ${defaultValue}.`);
    expect(result.stderr.split('\n').filter((line) => line.includes(`${option} 은퇴`))).toHaveLength(1);
  }, REAL_CLI_TEST_TIMEOUT_MS);

  // OLD-DOOR-CLOSE(#24330): 바깥(표지 없는) `dev --ask` 는 은퇴 안내 전에 «닫혔다» 로 거부된다.
  it('바깥에서 부른 dev --ask 는 닫힌 문으로 거부되고 대응 문을 말한다', async () => {
    const env = { ...process.env };
    delete env.ELANOUS_HARNESS_ENTRANCE;
    const result = await spawnRealCli(['bun', cli, '--test', 'dev', '--ask', 'missing goal with spaces.md'], { cwd: repo, env, timeoutMs: 60_000 });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('elanous dev --ask 는 닫혔습니다 — harness say / harness ask 로');
    expect(result.stderr).not.toContain('ENOENT');
  }, REAL_CLI_TEST_TIMEOUT_MS);

  // 하니스 안(ELANOUS_HARNESS_ENTRANCE 표지)에서는 옛 동작 그대로 — 은퇴 안내 ⊕ 기존 하위 오류.
  it.each([
    ['--ask', ['--ask', 'missing goal with spaces.md'], "elanous harness ask 'missing goal with spaces.md'", "ENOENT: no such file or directory, open 'missing goal with spaces.md'"],
    ['--file', ['--file', 'missing file with spaces.md'], "elanous harness ask 'missing file with spaces.md'", "ENOENT: no such file or directory, open 'missing file with spaces.md'"],
    ['--say', ['--say', '   '], "elanous harness say '   '", '--say 입력이 비었다'],
  ] as const)('%s 실행은 대응 명령에 사용자 인자를 보존하고 기존 하위 오류까지 유지한다', async (_kind, args, replacement, existingFailure) => {
    const result = await spawnRealCli(['bun', cli, '--test', 'dev', ...args], { cwd: repo, env: { ...process.env, ELANOUS_HARNESS_ENTRANCE: 'harness-ask' }, timeoutMs: 60_000 });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`이 dev 골-구동 문은 은퇴 예정입니다; 대응 문: ${replacement}`);
    expect(result.stderr).toContain(existingFailure);
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it.each([
    { label: '--plan', commandArgs: ['--plan', 'x'] },
    { label: '--plan --implement', commandArgs: ['--plan', '--implement', 'x'] },
  ])('$label 입력은 조합 검사와 하위 실행보다 먼저 은퇴 사유와 대응 문으로 거부한다', async ({ commandArgs }) => {
    const result = await spawnRealCli(['bun', cli, '--test', 'dev', ...commandArgs], { cwd: repo, timeoutMs: 60_000 });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--plan 은 은퇴했고 명시적으로 거부됨');
    expect(result.stderr).toContain(DEV_PLAN_REPLACEMENT);
    expect(result.stderr).not.toContain('동시 사용 불가');
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('dev --help는 --plan 등록을 남기고 은퇴와 대응 문을 표시한다', async () => {
    const result = await spawnRealCli(['bun', cli, '--test', 'dev', '--help'], { cwd: repo, timeoutMs: 60_000 });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    const planLine = output.split('\n').find((line) => line.includes('--plan'));
    expect(planLine).toContain('은퇴한 staged 하니스 옵션');
    expect(output.replace(/\s+/g, ' ')).toContain(DEV_PLAN_REPLACEMENT);
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('옵션 생략은 기존 capability resolver 기본값을 실제 파이프라인 계획에 유지한다', async () => {
    const plan = planDevPipeline(buildDevCliSpec(IN, SELF, {}));
    expect(plan).toMatchObject({
      dispatch: 'self-mission',
      completion: 'auto-merge',
      completionSource: 'default',
      autoReview: true,
      autoReviewSource: 'default',
    });
  });

  // #25547 (10-09) — `--json` is now allowed with self `--ask/--say` (preflight-stop JSON). Outside the harness the closed
  // `dev --ask` door answers first, so `--ask --json` ends with the closed-door notice as a single JSON document on stdout (exit 1).
  it('--ask --json은 닫힌 문 안내를 stdout 의 JSON 문서 하나로 내고 exit 1 이다', async () => {
    const result = await spawnRealCli(['bun', cli, '--test', 'dev', '--ask', 'missing.json-goal.md', '--json'], { cwd: repo, timeoutMs: 60_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('--json은 --hold 전용입니다');
    expect(JSON.parse(result.stdout.trim())).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining('dev --ask 는 닫혔습니다') }));
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('B/C 옵션은 선언을 유지하고 골 입력이 없으면 은퇴 안내를 내지 않는다', async () => {
    const src = readFileSync(resolve(import.meta.dir, '../index.ts'), 'utf8');
    for (const option of ['--no-auto-merge', '--force-preflight', '--allow-no-evidence', '--base', '--context', '--role-llm', '--child-llm-provider', '--attach', '--elanous', '--backend']) {
      expect(new RegExp(`(?:\\.option|new Option)\\(\\s*['\"]${option}`).test(src)).toBe(true);
    }
    const result = await spawnRealCli(['bun', cli, '--test', 'dev', '--backend', 'self', '--transport', 'acp', 'x'], { cwd: repo, timeoutMs: 60_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--transport 는 external backend 전용');
    expect(result.stderr).not.toContain('은퇴 예정');
  }, REAL_CLI_TEST_TIMEOUT_MS);
});

// ⛔⭐⭐⭐ 실물 도움말 — **계약 갈림을 먼저 말하는가** (무인 리뷰 must-fix ①②)
//
// ⚠️ 위 단언들은 전부 helper 를 **직접 호출**한다. 그런데 이 PR 이 고치려는 결함은
//   *"자식이 **도움말을 읽고** 잘못 믿는다"* 이므로, 검증도 **실제 도움말 출력**을 봐야 한다.
//   ⇒ 그래서 여기서만 실물 `bin/elanous.mjs` 를 spawn 한다(in-process import 로는 못 잰다).
//   ⚠️ spawn 1회 ~7초 — per-test 타임아웃을 명시한다(기본 5초면 타임아웃이 곧 빈 출력이 되어
//     "도움말이 없다" 와 구분이 안 된다 · 2026-08-03 cli-entry.test.ts 와 같은 이유).
describe.concurrent('drive --help 실물 — 계약 갈림이 맨 앞에 온다', () => {
  const CLI = resolve(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
  // ⚠️ 같은 CLI 를 테스트마다 다시 띄우지 않는다(무인 리뷰 should-fix) — describe 당 **이름별 1회**만
  //   띄우고 캐시한다. 출력은 이 프로세스 안에서 불변이므로 캐시가 판정을 바꾸지 않는다.
  //   ⏱️ 동시 실행이므로 «약속»을 캐시한다 — 같은 이름을 두 시험이 동시에 물어도 spawn 은 1회다.
  const cache = new Map<string, Promise<string>>();
  function help(name: 'dev' | 'drive'): Promise<string> {
    const hit = cache.get(name);
    if (hit !== undefined) return hit;
    const pending = spawnRealCli(['bun', CLI, name, '--help'], { timeoutMs: 60_000 }).then((r) => {
      if (r.error) throw new Error(`spawn 실패(결함 아님): ${r.error.message}`);
      if (r.signal) throw new Error(`시그널 종료(타임아웃 의심): ${r.signal}`);
      return `${r.stdout ?? ''}${r.stderr ?? ''}`;
    });
    cache.set(name, pending);
    return pending;
  }

  it('drive --help 의 설명이 **설명의 첫 줄부터** drive 계약을 말한다', async () => {
    const out = await help('drive');
    // ⛔ 상대 순서만 재면(무인 리뷰 should-fix) **다른 문구가 새로 앞에 끼어드는 회귀**를 못 막는다.
    //   ⇒ 설명 블록의 **첫 줄 자체**를 단언한다. Commander 는 `Usage:` → 빈 줄 → 설명 순서로 찍으므로
    //     빈 줄을 걷어낸 뒤 `Usage:` 바로 다음 줄이 설명의 첫 줄이다.
    const lines = out.split('\n');
    const usageAt = lines.findIndex((l) => l.startsWith('Usage:'));
    expect(usageAt).toBeGreaterThan(-1);
    const firstDescriptionLine = lines.slice(usageAt + 1).find((l) => l.trim().length > 0);
    expect(firstDescriptionLine).toBeDefined();
    expect(firstDescriptionLine!).toContain('drive');
    expect(firstDescriptionLine!).toContain('아홉뿐');
    expect(firstDescriptionLine!).toContain('--attach');
    // ⊕ 상대 순서도 함께 유지한다 — 두 토큰의 존재를 먼저 확인해 -1 비교의 허위 통과를 막는다.
    const driveContractAt = out.indexOf('drive` 별칭으로 부르면 옵션은 아홉뿐');
    const unifiedDescriptionAt = out.indexOf('실험 — 통합 self-dev');
    expect(driveContractAt).toBeGreaterThanOrEqual(0);
    expect(unifiedDescriptionAt).toBeGreaterThanOrEqual(0);
    expect(driveContractAt).toBeLessThan(unifiedDescriptionAt);
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('⛔ 그 도움말은 dev 전용 옵션도 **여전히 광고한다** — 그래서 공유 사실을 명시해야 한다', async () => {
    const out = await help('drive');
    // ⛔⭐ Commander 는 설명을 «단말 너비로» 접는다 ⇒ 낱말 사이에 개행이 들어간다.
    //   문면을 그대로 `toContain` 하면 이 테스트는 「문면이 있나」가 아니라 ***「어디서 접혔나」***를 잰다.
    //   (실측: `도움말을 공유` 가 `도움말을\n공유` 로 갈려 실패했다 — 문면은 «있었다».)
    //   ⇒ 공백을 하나로 접은 뒤 단언한다. 첫 줄 계약은 «위 테스트»가 접지 않고 그대로 문다.
    const flat = out.replace(/\s+/g, ' ');
    // 이 PR 은 별칭을 없애지 않는다(RFC §6-2). 따라서 --elanous 는 계속 보인다.
    expect(flat).toContain('--elanous');
    // ⇒ 그렇기 때문에 "도움말을 공유한다 · 아래는 dev 기준" 이 반드시 있어야 한다.
    expect(flat).toContain('도움말을 공유');
    expect(flat).toMatch(/dev` 기준|dev 기준/);
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('dev --help 와 drive --help 는 실제로 같다 (공유가 사실임을 못 박는다)', async () => {
    expect(await help('dev')).toBe(await help('drive'));
  }, REAL_CLI_TEST_TIMEOUT_MS);
});

/**
 * ⛔⭐⭐⭐ **개수 비교를 «경로별 실물 검증»으로 바꿨다**(무인 리뷰 must-fix · `#6976`).
 *
 * 초판은 `src/index.ts` 를 «문자열»로 읽어 `process.exit(` 개수와 `conclude()` 개수가
 * 같은지만 봤다. ⇒ ***한 경로에서 `conclude` 를 지우고 다른 경로에 «중복»으로 넣어도 통과한다.***
 * 개수가 맞는다는 것은 「모든 종료 경로가 결론을 표시한다」를 **뜻하지 않는다**(Goodhart).
 *
 * ⛔⭐⭐⭐ **이 회귀가 «증명하지 못하는» 것**(무인 리뷰가 두 번째로 짚었다 · 과장하지 않는다):
 *   아래 둘은 「미결론 문구의 «부재»」만 본다. ⇒ ***`src/index.ts` 의 가드 설치와 `conclude()` 를
 *   «통째로 지워도» 통과한다.*** 즉 「배선이 있다」를 못 증명한다.
 *   ⚠️ 그런데 「가드가 «발화»하는 실물 경로」가 `elanous dev` CLI 에는 **없다** — 모든 종료 경로가
 *   결론을 내도록 만든 것이 이 착지의 내용이기 때문이다(정상 상태에서 가드는 침묵한다).
 *   ⇒ 🩹 그래서 **양성 대조는 `dev-completion-guard.test.ts` 가 갖는다** — 거기서 진짜 프로세스를 띄워
 *     루프를 비우면 산출이 나오고 종료 코드가 바뀌는 것을 «실물»로 문다.
 *   ⇒ ⭐ 아래 둘의 역할은 «그것과 다르다»: ***정직하게 거부되는 실물 경로에서 오탐이 나지 않는가.***
 *     (앞 판본은 `process.exit(` 개수와 `conclude()` 개수를 비교했는데, 한 경로에서 지우고 다른 데
 *      중복해도 통과하는 Goodhart 였다. 그것을 이걸로 «바꾼» 것이고, 이것도 만능이 아니다.)
 *
 * 둘은 서로 다른 층에서 던진다:
 *   - `--backend self --transport acp` → dev 액션 «초입»에서 거부
 *   - 증거 태그 없는 골 파일        → `runDevPipeline` 안에서 던져 액션 «catch» 로 간다
 *   ⇒ 한쪽에서 `conclude` 를 빼면 그 경로에서만 미결론 줄이 뜬다 = 중복으로 못 속인다.
 */
describe.concurrent('dev completion guard — 실물 거부 경로에서 «오탐이 없다»', () => {
  const REPO = resolve(import.meta.dir, '..', '..');
  const CLI = join(REPO, 'bin', 'elanous.mjs');
  // 완료 줄(`[dev] … 완료`)과 형태가 다른, 가드만 찍는 문면.
  const UNCONCLUDED = '[dev completion guard]';

  // ⛔⭐⭐ 실물 CLI 를 띄우면 그 자식이 **저장소의 standalone 로그 sink 에 진짜로 쓴다**
  //   (무인 리뷰 must-fix). ⇒ state·config 를 «임시 디렉터리»로 격리하고 끝나면 지운다.
  //   ⚠️ 이 저장소 규율상 둘을 «같이» 줘야 한다 — `ELANOUS_STATE_DIR` 만으로는 config-dir 스코프가 안 갈린다.
  async function runCli(args: string[], extraEnv: Record<string, string> = {}, cwd: string = REPO): Promise<{ code: number; stderr: string; stdout: string }> {
    const sandbox = mkdtempSync(join(tmpdir(), 'dev-guard-cli-'));
    try {
      const r = await spawnRealCli(['bun', CLI, '--config-dir', sandbox, ...args], {
        cwd,
        timeoutMs: 120_000,
        env: { ...process.env, ELANOUS_STATE_DIR: sandbox, ...extraEnv },
      });
      return { code: r.status ?? -1, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }

  // ⭐⭐⭐ **양성 대조** — 가드가 «실제로 설치돼 있는가».
  //   ⛔ 아래 두 「부재」 회귀만으로는 «가드를 통째로 지워도» 통과한다(무인 리뷰가 두 번 짚었다).
  //   ⇒ 테스트 전용 seam 으로 「결론 없이 액션이 끝나는」 상황을 «강제»해 양성으로 문다.
  //   ⇒ 이제 `src/index.ts` 에서 가드 설치를 지우면 «이 테스트가 실패한다».
  it('결론 없이 끝나면 — 실물 CLI 가 산출을 남기고 0 이 아닌 코드로 끝난다', async () => {
    const r = await runCli(['dev', 'x'], { ELANOUS_DEV_TEST_UNCONCLUDED_EXIT: '1' });
    expect(r.stderr).toContain('[dev completion guard]');
    expect(r.stderr).toContain('결론 없이 종료');
    // ⛔ 이 한 줄이 B1 의 전부다 — 42차엔 여기가 `0` 이라 «성공처럼» 보였다.
    expect(r.code).not.toBe(0);
    // ⭐ sink 준비 전이면 logs.db 에 «못 남긴다»는 사실도 침묵하지 않는다(`R-GIT11`).
    expect(r.stderr).toContain('관측 sink 준비 전');
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('self-mission의 명시 --role-llm은 실물 dev 진입점에서 child LLM 대안과 함께 거부한다', async () => {
    const r = await runCli(['--test', 'dev', '--file', '/dev/null', '--role-llm', 'implement=grok']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('--role-llm');
    expect(r.stderr).toContain('--child-llm-provider');
    expect(r.stderr).toContain('--child-llm-model');
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('명시 --role-llm은 실물 drive 별칭 진입점에서 거부한다', async () => {
    const r = await runCli(['--test', 'drive', 'echo hi', '--goal', 'g', '--role-llm', 'implement=grok']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('--role-llm');
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('attach advisory points to the existing PTY command without interrupting the existing validation path', async () => {
    const r = await runCli(['dev', '--attach', 'pty-123', 'x']);
    expect(r.stderr).toContain('elanous pty auto');
    expect(r.stderr).toContain("elanous pty auto 'pty-123'");
    expect(r.stderr).toContain('무효한 옵션: attach');
    expect(r.code).not.toBe(0);
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('attach advisory shell-quotes spaces, quotes, and shell metacharacters as one argument', async () => {
    const r = await runCli(['dev', '--attach', "pty ref'; $(unsafe);", 'x']);
    expect(r.stderr).toContain("elanous pty auto 'pty ref'\\''; $(unsafe);'");
    expect(r.stderr).toContain('무효한 옵션: attach');
    expect(r.code).not.toBe(0);
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('external backend advisory points to the existing agent-mission command without interrupting the existing validation path', async () => {
    const r = await runCli(['dev', '--backend', 'codex', '--branch', 'wt/advisory', '--evidence', 'invalid', 'x']);
    expect(r.stderr).toContain('elanous agent-mission mission');
    expect(r.stderr).toContain('elanous agent-mission mission --backend codex');
    expect(r.stderr).toContain('--evidence 는 tsc|doc|test 만');
    expect(r.code).not.toBe(0);
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('default external and observe-only paths remain advisory-free without an explicit backend option', async () => {
    // ⏱️⛔ GATE-SPEED ③ — 옛 첫 케이스 `['dev', 'x']` 는 «거부 경로가 아니었다»: 기본 self-mission 이
    //   ***저장소의 진짜 워크트리(2만여 파일)를 만들고 런을 시작***해 120초 spawn 타임아웃으로만 끝났다
    //   (실측 172초 · 로컬 저장소에 `self-impl/x-2d711642-*` 워크트리·브랜치 26개가 쌓여 있었다).
    //   ⇒ 같은 기본 경로에 «경로가 받지 않는 옵션» 하나를 더해 `buildDevCliSpec` 에서 정직하게 거부시킨다.
    //   ⭐ 그 거부는 advisory 판정(`explicitOptions.includes('backend')`) «뒤»에 있으므로 문는 값은 같고,
    //     아래 `무효한 옵션` 단언이 「advisory 지점을 지나서 거부됐다」를 양성으로 못 박는다.
    for (const args of [
      ['dev', '--evidence', 'invalid', 'x'],
      ['dev', '--observe-only', 'x'],
    ]) {
      const r = await runCli(args);
      expect(r.stderr).not.toContain('elanous agent-mission mission');
      expect(r.stderr).toContain('무효한 옵션');
      expect(r.code).not.toBe(0);
    }
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('JSON mode is rejected outside hold before attach validation', async () => {
    const r = await runCli(['dev', '--json', '--attach', 'pty-123', 'x']);
    expect(r.code).toBe(2);
    // #25547 widened the message (hold · self --target · self --ask/--say); --attach is still rejected before validation.
    expect(r.stderr).toContain('--json은 --hold, self --target 또는 self --ask/--say 전제 검사 중단 전용입니다');
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('elanous hold remains advisory-free on its existing path', async () => {
    // ⭐ TUI-ONE-WORD-LAUNCH — 격리 우주에서 `--cwd`·`--worktree` 가 없으면 이제 워크트리를 «스스로» 만든다.
    //    ⛔ 본 저장소에 진짜 워크트리를 만들지 않도록 git 저장소 «밖» 임시 cwd 에서 돌려 사람 문면을 본다.
    const outside = mkdtempSync(join(tmpdir(), 'dev-hold-no-git-'));
    try {
      const r = await runCli(['dev', '--elanous', '--hold', 'x'], {}, outside);
      expect(r.stderr).not.toContain('elanous pty auto');
      expect(r.stderr).not.toContain('elanous agent-mission mission');
      expect(r.stderr).toContain('작업 디렉토리를 스스로 정하지 못했다');
      expect(r.code).not.toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('초입 거부(self + 비-pty transport)는 정직한 결론이므로 미결론 산출이 없다', async () => {
    const r = await runCli(['dev', '--backend', 'self', '--transport', 'acp', 'x']);
    expect(r.stderr).toContain('--transport 는 external backend 전용');
    expect(r.code).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toContain(UNCONCLUDED);
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('runDevPipeline 안에서 던진 거부(catch 경로)도 미결론 산출이 없다', async () => {
    const goal = join(tmpdir(), `guard-wiring-no-evidence-${process.pid}.txt`);
    // ⛔ 증거 태그가 «없는» 골 — preflightGoalFileEvidence 가 runDevPipeline 안에서 던진다.
    writeFileSync(goal, '이 골은 요구 증거가 없다. 거부되어야 한다.\n', 'utf8');
    try {
      const r = await runCli(['dev', '--file', goal]);
      expect(r.stderr).toContain('요구 증거가 없습니다');
      expect(r.code).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).not.toContain(UNCONCLUDED);
    } finally {
      rmSync(goal, { force: true });
    }
  }, REAL_CLI_TEST_TIMEOUT_MS);
});

// ── 감독자 결정이 «사람이 보는 스트림»에 닿는가 ─────────────────────────────
//
// 🩸 계기(실측 2026-09-02): 같은 골이 감독자 `relaunch` 로 세 번 돌았고, 그 결정은
//   `debug.log('self-dev.supervisor','decision')` 로만 남았다. 진행 스트림에는 `[self-implement:start]`
//   가 세 번 뜰 뿐 「몇 번째인가 · 왜 · 상한 얼마인가」가 없었다 ⇒ 75분을 지켜본 사람이
//   「rework 발산인가」를 그 스트림만으로 답하지 못하고 소스 다섯 개를 읽어야 했다.
// ⛔ 관측(logs.db)과 진행 스트림은 «다른 축»이다 — 한쪽만 채우면 지켜보는 사람은 못 센다.
describe('renderSupervisorDecisionLine', () => {
  it('재발사 결정을 사람이 읽는 한 줄로 낸다 — 「몇 번째/상한」은 why 가 이미 담고 있다', () => {
    const line = devCli.renderSupervisorDecisionLine({
      action: 'relaunch', round: 1, why: '다시 건다 — 그대로 재실행 0 · 재작업 1 · 분해 0 · 수리 0 · 라운드 2/3',
    });
    expect(line.startsWith('[supervisor] ')).toBe(true);
    expect(line).toContain('다시 건다');
    expect(line).toContain('라운드 2/3');   // ⛔ 상한을 이 함수가 «다시 적지» 않는다
  });

  it('멈춤은 stopReason 을 같이 낸다 — 「멈췄다」와 「왜 멈췄나」는 다른 값', () => {
    const line = devCli.renderSupervisorDecisionLine({
      action: 'stop', round: 2, stopReason: 'no-progress', why: '2라운드 연속 제자리',
    });
    expect(line).toContain('[no-progress]');
    expect(line).toContain('2라운드 연속 제자리');
  });

  it('⛔ stopReason 이 «없어도» 이유 칸을 생략하지 않는다 — 「이유 없음」과 「못 받았음」은 다른 값', () => {
    const line = devCli.renderSupervisorDecisionLine({ action: 'stop', round: 2, why: '멈춘 이유는 왔는데 코드가 안 실었다' });
    expect(line).toContain('[unknown]');
  });

  it('수리 조각 붙이기는 재발사와 «다른 낱말»이다 — 둘을 접으면 다시 못 센다', () => {
    const relaunch = devCli.renderSupervisorDecisionLine({ action: 'relaunch', round: 0, why: 'w' });
    const repair = devCli.renderSupervisorDecisionLine({ action: 'add-repair-task', round: 0, why: 'w' });
    expect(relaunch).not.toBe(repair);
  });
});

// ⛔⭐⭐ 대표 2026-09-12 — ***자식 «추론 노력»을 판마다 준다***(`--child-llm-effort`).
//    🔑 위험한 축은 ***「상한을 넘는 값이 «조용히» 통과하는 것」***이다 —
//       모델마다 상한이 다르고, 넘겨 보내면 API 가 거부하거나 조용히 낮춘다.
//    ⛔ 그래서 판정은 `reasoningEffortCeiling(modelId)` SSOT 에 «맡기고» 여기서 다시 쓰지 않는다.
//
// ⭐ 2026-09-23 갱신 — 종전 음성 대조가 `gpt-5.6-terra = high` 를 썼는데 ***그 값이 틀렸다***.
//    각 effort 를 «실제로 먹여» 재니(codex-cli 0.155.1) terra·luna·sol 모두 low~max 를 «전부» 받는다
//    (대조군 bogus 만 거부). ⇒ 카탈로그를 `max` 로 고쳤고(`#19867`), 그래서 ***codex 계열엔
//    「상한이 낮은 모델」이 하나도 없다.*** 음성 대조를 «진짜로 낮은» 모델로 옮긴다.
//    📏 지금 낮은 것: `gpt-4o`·`gpt-4o-mini` = `none` (provider `openai`).
//    ⛔ 음성을 못 살리면 이 describe 는 ***「거부한다」를 한 번도 안 누르는 시험***이 된다.
describe('--child-llm-effort — 상한을 넘으면 «이름을 대고» 거부한다', () => {
  it('📏 상한을 SSOT 에서 읽는다 — codex 계열은 전부 max · 4o 계열은 none', () => {
    for (const m of ['gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(devCli.childLlmEffortCeiling('openai-codex', m)).toBe('max');
    }
    // ⛔ 「전부 max」만 누르면 이 자는 «항상 max 를 돌려주는 함수»도 통과시킨다 — 음성을 같이 둔다.
    expect(devCli.childLlmEffortCeiling('openai', 'gpt-4o')).toBe('none');
  });

  it('✅ 양성 — 상한 «안»이면 통과하고 ceiling 을 같이 낸다', () => {
    expect(devCli.resolveChildLlmEffort('openai-codex', 'gpt-6-astra', 'xhigh'))
      .toEqual({ effort: 'xhigh', ceiling: 'max' });
  });

  it('⛔ 음성 — 상한을 «넘으면» 거부하고 «두 값을 다» 말한다', () => {
    // ⚠️ 대상을 codex 밖으로 옮겼다 — codex 계열엔 더 이상 「낮은 상한」이 없다(머리말 실측).
    expect(() => devCli.resolveChildLlmEffort('grok', 'grok-4.7', 'max'))
      .toThrow(/max.*grok-4\.7.*high/);
    expect(() => devCli.resolveChildLlmEffort('anthropic', 'claude-haiku-4-5', 'high'))
      .toThrow(/high.*claude-haiku-4-5.*low/);
  });

  // ⭐ 2026-09-23 신설 — ***`none` 은 «다른 가지»다.*** 위 시험을 `gpt-4o` 로 옮겼다가 찾았다:
  //    메시지가 *"추론 노력을 «안 받는다»(ceiling=none)"* 라 ***요청값을 안 댄다.***
  //    ⛔ 「두 값을 다 말한다」 계약이 이 가지에선 «절반»이다. 그 사실을 자로 못 박아 둔다.
  it('⛔ 음성 — 상한이 `none` 인 모델은 «다른 문면»으로 거부한다 (요청값을 안 댄다)', () => {
    expect(() => devCli.resolveChildLlmEffort('openai', 'gpt-4o', 'xhigh'))
      .toThrow(/gpt-4o.*none/);
    // 🔲 알려진 간극: 이 가지는 요청값(xhigh)을 문면에 안 넣는다. 넣게 고치면 이 줄을 강화한다.
  });

  it('⛔ 음성 — 사다리에 «없는» 값은 후보를 대고 거부한다', () => {
    expect(() => devCli.resolveChildLlmEffort('openai-codex', 'gpt-6-astra', 'turbo'))
      .toThrow(/후보: minimal, low, medium, high, xhigh, max/);
  });

  it('⛔ 음성 — provider 없이 effort 만 오면 «조용히 무시하지 않는다»', () => {
    expect(() => devCli.buildChildLlmSelection({ childLlmEffort: 'high' }))
      .toThrow(/--child-llm-provider 필요/);
  });

  it('✅ 셋을 다 주면 선택에 effort 가 «실린다»', () => {
    expect(devCli.buildChildLlmSelection({
      childLlmProvider: 'openai-codex', childLlmModel: 'gpt-6-astra', childLlmEffort: 'max',
    })).toEqual({ provider: 'openai-codex', model: 'gpt-6-astra', effort: 'max', source: 'flag' });
  });

  it('⭐ effort 를 «안 주면» 선택에 그 칸이 «없다» — 「medium」으로 채우지 않는다', () => {
    const sel = devCli.buildChildLlmSelection({ childLlmProvider: 'openai-codex', childLlmModel: 'gpt-6-astra' });
    expect(sel).not.toHaveProperty('effort');
  });

  it('🔑 해석 줄이 effort 를 «찍는다» — 「삼켜졌나」를 가르는 자리다', () => {
    const line = devCli.formatChildLlmInterpretationLine(
      devCli.resolveImplementationChildModel('openai-codex', 'gpt-6-astra'),
      { effort: 'xhigh', ceiling: 'max' },
    );
    expect(line).toContain('effort=xhigh(ceiling=max · source=flag)');
  });
});

describe('buildChildLlmSelection — config-backed child LLM when flags are absent', () => {
  it('플래그 없고 주입한 설정이 undefined 면 결과가 undefined', () => {
    expect(buildChildLlmSelection({}, () => undefined)).toBeUndefined();
  });

  it('설정 provider 가 비면 종전대로 undefined', () => {
    expect(buildChildLlmSelection({}, () => ({ provider: '  ', model: 'grok-4.6' }))).toBeUndefined();
    expect(buildChildLlmSelection({}, () => ({ model: 'grok-4.6' }))).toBeUndefined();
  });

  it('주입한 설정이 {provider: grok} 이면 결과가 grok 이고 모델이 채워진다', () => {
    expect(buildChildLlmSelection({}, () => ({ provider: 'grok' }))).toEqual({
      provider: 'grok',
      model: defaultChildLlmModel('grok'),
      source: 'config',
    });
  });

  it('플래그 provider 와 설정 provider 가 다를 때 결과는 플래그 쪽이고 설정 읽기 함수가 호출되지 않는다', () => {
    let reads = 0;
    const selected = buildChildLlmSelection(
      { childLlmProvider: 'anthropic', childLlmModel: 'claude-sonnet-4-6' },
      () => {
        reads += 1;
        return { provider: 'grok', model: 'grok-4.6' };
      },
    );
    expect(selected).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6', source: 'flag' });
    expect(reads).toBe(0);
  });

  it('주입한 설정 provider 가 알 수 없는 이름이면 throw 한다', () => {
    expect(() => buildChildLlmSelection({}, () => ({ provider: 'nonsense', model: 'gpt-5.6-terra' })))
      .toThrow(/--child-llm-provider 알 수 없음: nonsense/);
  });

  it('출처가 값에 남고 해석 줄에 그 낱말이 실린다', () => {
    const selected = buildChildLlmSelection({}, () => ({ provider: 'grok', model: 'grok-4.6' }));
    expect(selected?.source).toBe('config');
    const line = formatChildLlmInterpretationLine(
      resolveImplementationChildModel('grok', 'grok-4.6'),
      { effort: undefined, ceiling: 'high', source: 'unset', selectionSource: 'config' },
    );
    expect(line).toContain('source=unset');
    expect(line).toContain('selection=config');
  });

  it('빈 문자열·공백·model-only·effort-only 플래그가 있으면 설정 리더를 호출하지 않는다', () => {
    const unusedConfig = { provider: 'grok', model: 'grok-4.6' };
    const run = (
      opts: Parameters<typeof buildChildLlmSelection>[0],
      config?: { provider?: string; model?: string },
    ) => {
      let reads = 0;
      const reader = () => {
        reads += 1;
        return config;
      };
      try {
        const result = buildChildLlmSelection(opts, reader);
        return { reads, result, error: undefined };
      } catch (error) {
        return { reads, result: undefined, error };
      }
    };

    const emptyProvider = run({ childLlmProvider: '' }, unusedConfig);
    expect(emptyProvider.reads).toBe(0);
    expect(emptyProvider.result).toBeUndefined();
    expect(emptyProvider.error).toBeUndefined();

    const blankProvider = run({ childLlmProvider: '  ' }, unusedConfig);
    expect(blankProvider.reads).toBe(0);
    expect(blankProvider.result).toBeUndefined();
    expect(blankProvider.error).toBeUndefined();

    const modelOnly = run({ childLlmModel: 'grok-4.6' }, unusedConfig);
    expect(modelOnly.reads).toBe(0);
    expect(modelOnly.error).toBeInstanceOf(Error);
    expect(String(modelOnly.error)).toMatch(/--child-llm-provider 필요\(--child-llm-model과 함께\)/);

    const emptyModel = run({ childLlmModel: '' }, unusedConfig);
    expect(emptyModel.reads).toBe(0);
    expect(emptyModel.error).toBeInstanceOf(Error);
    expect(String(emptyModel.error)).toMatch(/--child-llm-provider 필요\(--child-llm-model과 함께\)/);

    const blankEffort = run({ childLlmEffort: ' ' }, unusedConfig);
    expect(blankEffort.reads).toBe(0);
    expect(blankEffort.result).toBeUndefined();
    expect(blankEffort.error).toBeUndefined();

    const effortOnly = run({ childLlmEffort: 'high' }, unusedConfig);
    expect(effortOnly.reads).toBe(0);
    expect(effortOnly.error).toBeInstanceOf(Error);
    expect(String(effortOnly.error)).toMatch(/--child-llm-provider 필요\(--child-llm-effort와 함께\)/);

    const noFlagsUndefined = run({}, undefined);
    expect(noFlagsUndefined.reads).toBe(1);
    expect(noFlagsUndefined.result).toBeUndefined();
    expect(noFlagsUndefined.error).toBeUndefined();

    const noFlagsConfig = run({}, unusedConfig);
    expect(noFlagsConfig.reads).toBe(1);
    expect(noFlagsConfig.result).toEqual({ provider: 'grok', model: 'grok-4.6', source: 'config' });
    expect(noFlagsConfig.error).toBeUndefined();
  });

  it('기본 리더는 tools.selfImplement.childLlm 을 읽고 없으면 undefined 를 보존한다', () => {
    setUserConfigOverlay((config) => ({
      ...config,
      raw: { ...config.raw, tools: {} },
    }));
    try {
      expect(readChildLlmConfigFromUserConfig()).toBeUndefined();
      expect(buildChildLlmSelection({})).toBeUndefined();
      expect(buildDevCliSpec(IN, SELF, {}).self).toBeUndefined();
    } finally {
      setUserConfigOverlay(null);
    }

    setUserConfigOverlay((config) => withParsedChildLlm({
      ...config,
      raw: {
        ...config.raw,
        tools: { selfImplement: { childLlm: { provider: 'grok' } } },
      },
    }, { provider: 'grok' }));
    try {
      expect(readChildLlmConfigFromUserConfig()).toEqual({ provider: 'grok' });
      expect(buildChildLlmSelection({})).toEqual({
        provider: 'grok',
        model: defaultChildLlmModel('grok'),
        source: 'config',
      });
    } finally {
      setUserConfigOverlay(null);
    }
  });

  it.each(['exhausted', 'usable', 'unknown'] as const)('config grok 잔량 %s: 발사 전 경고는 소진에서만 한 번 내고 dispatch는 계속된다', (quota) => {
    setUserConfigOverlay((config) => withParsedChildLlm({
      ...config,
      raw: { ...config.raw, tools: { selfImplement: { childLlm: { provider: 'grok', model: 'grok-4.7' } } } },
    }, { provider: 'grok', model: 'grok-4.7' }));
    const lines: string[] = [];
    const write = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
    const events: Array<{ category: string; event: string; data: unknown }> = [];
    const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      events.push({ category, event, data });
    });
    let reads = 0;
    try {
      const spec = buildDevCliSpec(IN, SELF, {}, undefined, 'cli-dev-ask', () => { reads += 1; return quota; });
      expect(reads).toBe(1);
      expect(spec.self?.childLlm).toEqual({ provider: 'grok', model: 'grok-4.7', source: 'config' });
      expect(planDevPipeline(spec).dispatch).toBe('self-mission');
      expect(lines.join('')).toContain('selection=config');
      const warnings = lines.join('').split('\n').filter((line) => line.includes('주간 한도 소진'));
      const quotaEvents = events.filter(({ event }) => event === 'child-llm-quota-exhausted');
      if (quota === 'exhausted') {
        expect(warnings).toEqual(['[dev] ⚠️ child-llm grok 주간 한도 소진(elanous usage) — 자식이 응답을 못 받아 도구 0회로 끝날 수 있다 · 바꾸려면 --child-llm-provider openai-codex --child-llm-model <모델>']);
        expect(quotaEvents).toEqual([{ category: 'self-dev', event: 'child-llm-quota-exhausted', data: { provider: 'grok', model: 'grok-4.7', selection: 'config' } }]);
      } else {
        expect(warnings).toEqual([]);
        expect(quotaEvents).toEqual([]);
      }
    } finally {
      log.mockRestore();
      write.mockRestore();
      setUserConfigOverlay(null);
    }
  });

  it('다른 provider는 소진 잔량 리더를 호출하지 않고 기존 선택을 보존한다', () => {
    const spec = buildDevCliSpec(IN, SELF, { childLlmProvider: 'openai-codex' }, undefined, 'cli-dev-ask', () => {
      throw new Error('non-grok quota must not be read');
    });
    expect(spec.self?.childLlm).toEqual({ provider: 'openai-codex', model: defaultChildLlmModel('openai-codex'), source: 'flag' });
  });

  it('설정만 있으면 buildDevCliSpec 이 config 출처 선택을 싣고 해석 줄에 selection=config 를 남긴다', () => {
    setUserConfigOverlay((config) => withParsedChildLlm({
      ...config,
      raw: {
        ...config.raw,
        tools: { selfImplement: { childLlm: { provider: 'grok' } } },
      },
    }, { provider: 'grok' }));
    const chunks: string[] = [];
    const write = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
    try {
      const spec = buildDevCliSpec(IN, SELF, {});
      expect(spec.self?.childLlm).toEqual({
        provider: 'grok',
        model: defaultChildLlmModel('grok'),
        source: 'config',
      });
      expect(chunks.join('')).toContain('selection=config');
    } finally {
      write.mockRestore();
      setUserConfigOverlay(null);
    }
  });

  it('플래그가 있으면 설정 overlay 가 있어도 플래그가 이기고 기본 리더를 타지 않는다', () => {
    setUserConfigOverlay((config) => withParsedChildLlm({
      ...config,
      raw: {
        ...config.raw,
        tools: { selfImplement: { childLlm: { provider: 'grok', model: 'grok-4.6' } } },
      },
    }, { provider: 'grok', model: 'grok-4.6' }));
    try {
      const spec = buildDevCliSpec(IN, SELF, {
        childLlmProvider: 'anthropic',
        childLlmModel: 'claude-sonnet-4-6',
      });
      expect(spec.self?.childLlm).toEqual({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        source: 'flag',
      });
      expect(readChildLlmConfigFromUserConfig()).toEqual({ provider: 'grok', model: 'grok-4.6' });
    } finally {
      setUserConfigOverlay(null);
    }
  });

  it('설정 부재만 undefined 이고 읽기 실패는 거절한다', () => {
    setUserConfigOverlay((config) => ({
      ...config,
      raw: { ...config.raw, tools: { selfImplement: {} } },
    }));
    try {
      expect(readChildLlmConfigFromUserConfig()).toBeUndefined();
      expect(buildChildLlmSelection({})).toBeUndefined();
    } finally {
      setUserConfigOverlay(null);
    }

    setUserConfigOverlay(() => {
      throw new Error('disk unreadable');
    });
    try {
      expect(() => readChildLlmConfigFromUserConfig()).toThrow(/tools.selfImplement.childLlm 읽기 실패: disk unreadable/);
      expect(() => buildChildLlmSelection({})).toThrow(/tools.selfImplement.childLlm 읽기 실패: disk unreadable/);
    } finally {
      setUserConfigOverlay(null);
    }
  });

  it('잘못된 타입의 설정 provider 는 경고 후 버리고 발사를 막지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'child-llm-bad-provider-'));
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({
      tools: { selfImplement: { childLlm: { provider: 42, model: 'grok-4.6' } } },
    }));
    const warnings: string[] = [];
    const write = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      warnings.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
    setElanousConfigDir(dir);
    resetUserConfig();
    try {
      const loaded = buildUserConfig(path);
      expect(loaded.tools.selfImplement.childLlm).toBeUndefined();
      expect(warnings.some((line) => line.includes('provider') && line.includes('42'))).toBe(true);
      expect(() => buildDevCliSpec(IN, SELF, {})).not.toThrow();
      expect(buildDevCliSpec(IN, SELF, {}).self).toBeUndefined();
    } finally {
      write.mockRestore();
      resetElanousConfigDir();
      resetUserConfig();
      rmSync(dir, { recursive: true, force: true });
    }

    setUserConfigOverlay((config) => withParsedChildLlm(config, 'grok'));
    try {
      expect(parseChildLlmPreference('grok')).toBeUndefined();
      expect(readChildLlmConfigFromUserConfig()).toBeUndefined();
      expect(buildChildLlmSelection({})).toBeUndefined();
    } finally {
      setUserConfigOverlay(null);
    }
  });

  it('잘못된 모델 타입은 경고 후 버리고 provider 기본 모델로 진행한다', () => {
    setUserConfigOverlay((config) => withParsedChildLlm(config, { provider: 'grok', model: 42 }));
    try {
      expect(readChildLlmConfigFromUserConfig()).toEqual({ provider: 'grok' });
      expect(buildChildLlmSelection({})).toEqual({
        provider: 'grok',
        model: defaultChildLlmModel('grok'),
        source: 'config',
      });
    } finally {
      setUserConfigOverlay(null);
    }
  });

  it('파서가 버린 provider:123 은 raw 가 남아도 발사를 막지 않고 기본으로 진행한다', () => {
    setUserConfigOverlay((config) => ({
      ...withParsedChildLlm(config, { provider: 123 }),
      raw: {
        ...config.raw,
        tools: { selfImplement: { childLlm: { provider: 123 } } },
      },
    }));
    try {
      expect(readChildLlmConfigFromUserConfig()).toBeUndefined();
      expect(buildChildLlmSelection({})).toBeUndefined();
    } finally {
      setUserConfigOverlay(null);
    }
  });

  it('기존 model-only 설정은 mode 를 auto 로 두고 발사 경계에서만 종전 거절 문면을 낸다', () => {
    const parsed = parseChildLlmPreference({ model: 'grok-4.6' });
    expect(parsed?.mode).toBeUndefined();
    expect(parsed?.provider).toBeUndefined();
    setUserConfigOverlay((config) => withParsedChildLlm(config, { model: 'grok-4.6' }));
    try {
      expect(() => readChildLlmConfigFromUserConfig()).toThrow(/--child-llm-provider 필요\(--child-llm-model과 함께\)/);
      expect(() => buildChildLlmSelection({})).toThrow(/--child-llm-provider 필요\(--child-llm-model과 함께\)/);
      expect(() => buildDevCliSpec(IN, SELF, {})).toThrow(/--child-llm-provider 필요\(--child-llm-model과 함께\)/);
    } finally {
      setUserConfigOverlay(null);
    }
  });

  it('발사 인자 없이 mode auto chain grok 이면 해석된 provider 가 grok 이고 인자가 있으면 인자가 이긴다', () => {
    const events: Array<{ category: string; event: string; data: unknown }> = [];
    const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      events.push({ category, event, data });
    });
    setUserConfigOverlay((config) => withParsedChildLlm({
      ...config,
      llm: { ...config.llm, fallbackChain: ['codex-rotate', 'grok'] },
    }, { mode: 'auto', chain: [{ provider: 'grok' }] }));
    try {
      const fromChain = buildDevCliSpec(IN, SELF, {});
      expect(fromChain.self?.childLlm?.provider).toBe('grok');
      expect(fromChain.self?.childLlm?.source).toBe('config');
      const resolved = events.filter((event) => event.category === 'harness.child-llm-preference' && event.event === 'resolved');
      expect(resolved.length).toBeGreaterThan(0);
      expect(resolved.at(-1)?.data).toMatchObject({
        mode: 'auto',
        chain: ['grok'],
        source: { chain: 'config' },
      });
      const fromFlag = buildDevCliSpec(IN, SELF, {
        childLlmProvider: 'openai-codex',
        childLlmModel: 'gpt-6-sol',
      });
      expect(fromFlag.self?.childLlm).toEqual({
        provider: 'openai-codex',
        model: 'gpt-6-sol',
        source: 'flag',
      });
    } finally {
      log.mockRestore();
      setUserConfigOverlay(null);
    }
  });

  it('플래그가 있으면 기본 리더의 읽기 실패도 부르지 않는다', () => {
    setUserConfigOverlay(() => {
      throw new Error('must not read');
    });
    try {
      expect(buildChildLlmSelection({
        childLlmProvider: 'anthropic',
        childLlmModel: 'claude-sonnet-4-6',
      })).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6', source: 'flag' });
    } finally {
      setUserConfigOverlay(null);
    }
  });
});
