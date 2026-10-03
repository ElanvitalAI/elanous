import { readFileSync } from 'node:fs';
import { describe, it, expect, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  planDevPipeline, runDevPipeline, toSelfImplementOptions, toAgentMissionSpec,
  resolveDevInputText, applyManualGoalEvidenceRequirement, DevPipelineError, WIRED_DISPATCHES, buildDefaultSelfImplementSeams, devResultOk,
  selectUnmannedToolReviewer, unmannedToolReviewerRateFromConfig, DEFAULT_UNMANNED_TOOL_REVIEWER_RATE,
  buildAgentMissionDevSpec, executeAgentMissionReroute, acpBackendName, toAcpAgentArgs, normalizeAcpResult, defaultDispatchAcp,
  buildSelfImplementDevSpec, selfImplementExitCode, executeSelfImplementReroute,
  buildSelfImplementPlanDevSpec, executeSelfImplementPlanReroute,
  buildSelfOrchestrateDevSpec, toOrchestrateOptions, orchestrateExitCode, executeOrchestrateReroute,
  buildChatDevSpec, observeDevSelection, LINEAGE_OPEN_PR_THRESHOLD, observeTargetRemote, resolveTargetRemoteCompletion,
  type DevPipelineSpec, type ResolvedDevPlan, type DevPipelineDeps, type DevChatOpts,
  type DevElanousTuiOpts, type DevDispatch } from './dev-pipeline.js';
import { reviewReasoningEffort } from '../model-tier/review-effort.js';
import type { AgentBackend, AgentMissionResult } from '../agent-mission/driver.js';
import { runSelfImplement, type SelfImplementResult, type SelfImplementSeams, type SelfImplementOptions } from '../self-implement/orchestrator.js';
import type { SelfDevJobResult } from './orchestrate.js';
import type { DevHarnessDispatchArgs } from './dev-pipeline.js';
import { debug } from '../debug/log.js';
import { releasePathHoldComment } from './release-path-guard.js';
import { createRepositoryReferencedFileReader } from '../self-implement/goal-file-reader.js';
import { loadReviewerContext, reviewerContextArgs } from '../agent-substrate/self-review-cli.js';
import { DEFAULT_BRANCH_WORKTREE_BASE } from '../git-fs/worktree.js';
import { loadSelfDevRun, selfDevRunsDir } from './run-store.js';
import { ensureRunIdentity } from '../harness/harness-space.js';
import { ROLE_MODEL_DEFAULTS, clearLaunchRoleLlmOverrides, getLaunchRoleLlmOverrides, resolveRoleModel, setLaunchRoleLlmOverrides, setUserConfigOverlay } from '../user-config.js';
import { lookupLlmTierSpec } from '../model-tier/llm-tier-map.js';
import { formatGoalFileLintFinding, GOAL_FILE_LINT_ORIGINS, type GoalFileLintLevel } from '../self-implement/goal-author.js';

const T = (over: Partial<DevPipelineSpec> = {}): DevPipelineSpec => ({ input: { text: '기능 X' }, ...over });
const presentRemote = () => ({ status: 0, stdout: 'origin\n', stderr: '' });

const nonExecutingReview = async () => 'VERDICT: PASS';

/**
 * Classification: these dispatch-routing callers test seam assembly or tool-reviewer
 * selection, not provider resolution. `buildDefaultSelfImplementSeams` resolves the
 * review model before choosing `deps.llmReview`, so an omitted seam leaks into the
 * credential-stripped gate. A local endpoint is sufficient because every caller below
 * injects a non-executing review implementation; it is never contacted.
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

function expectedGoalFileLintStderrLine<Tag extends keyof typeof GOAL_FILE_LINT_ORIGINS>(
  level: GoalFileLintLevel,
  tag: Tag,
  message: string,
): string {
  return `[dev] goal-file-lint: ${formatGoalFileLintFinding({ level, tag, message })}\n`;
}
const CANONICAL_GOAL_FILE = '## PROBLEM\nproblem\n\n## WHAT TO BUILD\nbuild\n\n## ACCEPTANCE CRITERIA\ncriteria\n\n## REQUIRED EVIDENCE\n- [launch] child launch proof\n\n## TRACED PATHS\npaths\n\n## SCOPE BOUNDARY\nboundary\n\n## 답하지 못하는 것\nlimits\n\n## 불변식\nkeep\n\n## 판정 신호\nsignals';

describe('planDevPipeline — 순수 정규화/검증/디스패치(계약 SSOT)', () => {
  it('reviewer context는 spec에서 resolved plan까지 순서와 라벨을 보존한다', () => {
    const reviewerContext = [
      { label: 'README.md', body: 'file premise' },
      { label: 'inline context 2', body: 'text premise' },
    ];
    const plan = planDevPipeline(T({ reviewerContext }));
    expect(plan.reviewerContext).toEqual(reviewerContext);
  });

  it('무지정 내부 self mission은 안전 resolver 기본과 dispatch를 낸다', () => {
    const p = planDevPipeline(T());
    expect(p.executor).toEqual({ kind: 'self' });
    expect(p.context).toBe('mission');
    expect(p).toMatchObject({ completion: 'worktree-only', completionSource: 'default', autoReview: false, autoReviewSource: 'default', dispatch: 'self-mission', wired: true });
  });

  it('self-mission 디스패치는 그래프 권위 필드를 전달하지 않는다', async () => {
    let received: SelfImplementOptions | undefined;
    await runDevPipeline(T(), {
      buildSelfImplementSeams: () => ({} as SelfImplementSeams),
      runSelfImplement: async (options) => { received = options; return { ok: true } as SelfImplementResult; },
    });
    expect(received).not.toHaveProperty('graphAuthoritative');
  });

  it('relaunch 입력은 absent·false·true를 계획까지 바이트 보존한다', () => {
    expect(planDevPipeline(T()).relaunch).toBeUndefined();
    expect(planDevPipeline(T({ relaunch: false })).relaunch).toBe(false);
    expect(planDevPipeline(T({ relaunch: true })).relaunch).toBe(true);
  });

  it('CLI dev·NL self-implement·자연어·골 파일 provenance는 자율 resolver 기본을 낸다', () => {
    const cliDev = planDevPipeline(T({ entrance: 'cli-dev-ask' }));
    const naturalLanguageEntrance = planDevPipeline(T({ entrance: 'nl-self-implement' }));
    const naturalLanguageDispatch = planDevPipeline(T({ self: { draft: true, naturalLanguageDispatch: true } }));
    const authoredGoalFile = planDevPipeline(T({ self: { draft: true, goalFile: '/tmp/authored-goal.md' } }));
    // ⭐ 대표 결정 2026-08-22 — 하니스 CLI 입구 둘에 무인 권한을 «부여»했다.
    //   ⛔ 이 줄이 없으면 그 입구들은 자기 이름을 정직하게 넘기는 «순간» fail-closed 로 떨어진다
    //     (📏 실측: 각인 수리 전 9발 auto-merge → 수리 후 2발 worktree-only).
    const harnessAsk = planDevPipeline(T({ entrance: 'cli-harness-ask' }));
    const harnessSay = planDevPipeline(T({ entrance: 'cli-harness-say' }));
    const slashPlanAndGoal = planDevPipeline(T({ entrance: 'tui-slash-dev' }));
    const drive = planDevPipeline(T({ entrance: 'cli-drive' }));
    for (const autonomous of [cliDev, naturalLanguageEntrance, naturalLanguageDispatch, authoredGoalFile, harnessAsk, harnessSay, slashPlanAndGoal, drive]) {
      expect(autonomous).toMatchObject({
        completion: 'auto-merge', completionSource: 'default', autoReview: true, autoReviewSource: 'default',
      });
    }
  });

  it('declared-only NL·parallel·elanous 경로는 safe resolver 기본을 유지한다', () => {
    const declaredOnlyNaturalLanguage = planDevPipeline(T({ entrance: 'nl-self-orchestrate' }));
    const parallel = planDevPipeline(T({
      entrance: 'nl-self-implement',
      parallel: { goals: [{ feature: 'a' }] },
    }));
    const elanous = planDevPipeline(T({
      entrance: 'nl-self-implement',
      elanous: { goal: 'child goal' },
    }));
    for (const safe of [declaredOnlyNaturalLanguage, parallel, elanous]) {
      expect(safe).toMatchObject({
        completion: 'worktree-only', completionSource: 'default', autoReview: false, autoReviewSource: 'default',
      });
    }
  });

  it('target remote completion distinguishes absent, unreadable, explicit PR rejection, and present preservation', () => {
    const absent = observeTargetRemote('/target', () => ({ status: 0, stdout: '', stderr: '' }));
    const unreadable = observeTargetRemote('/target', () => ({ status: 1, stdout: '', stderr: 'permission denied' }));
    const present = observeTargetRemote('/target', () => ({ status: 0, stdout: 'origin\n', stderr: '' }));

    expect(absent).toMatchObject({ state: 'remote-absent', repoRoot: '/target' });
    expect(unreadable).toEqual({ state: 'remote-unreadable', repoRoot: '/target', reason: 'permission denied' });
    expect(present).toEqual({ state: 'remote-present', repoRoot: '/target' });
    expect(resolveTargetRemoteCompletion('auto-merge', 'default', absent)).toEqual({
      completion: 'worktree-only', reason: 'target has no git remote; selected worktree-only instead of PR completion',
    });
    expect(resolveTargetRemoteCompletion('auto-merge', 'default', unreadable)).toEqual({ completion: 'auto-merge' });
    expect(resolveTargetRemoteCompletion('auto-merge', 'default', present)).toEqual({ completion: 'auto-merge' });
    expect(() => resolveTargetRemoteCompletion('pr', 'request', absent)).toThrow(/target has no git remote.*completion:pr/);
    // 거부는 «무엇을 하면 되나»를 말한다 — 로컬로 돌리는 길 ⊕ PR 을 얻는 길(2026-09-23 Phase 4 실측)
    expect(() => resolveTargetRemoteCompletion('pr', 'request', absent)).toThrow(/drop the completion flags.*worktree-only.*git remote add/);
    // UX 15(2026-09-26 베어 VM): 자연어 경로(TUI 모델이 채운 인자)는 사람이 친 플래그가 아니다 — 던지지 않고 워크트리로 내린다.
    const nl = resolveTargetRemoteCompletion('pr', 'request', absent, { naturalLanguageDispatch: true });
    expect(nl.completion).toBe('worktree-only');
    expect(nl.reason).toContain('natural-language request');
    expect(resolveTargetRemoteCompletion('pr', 'request', unreadable, { naturalLanguageDispatch: true })).toEqual({ completion: 'pr' });
  });

  it('completion·autoReview는 값과 함께 request/config/default 출처를 한 자리에서 해석한다', () => {
    const defaults = planDevPipeline(T());
    const requested = planDevPipeline(T({ completion: 'pr', autoReview: false }));
    const configured = planDevPipeline(T({
      completion: 'auto-merge', completionSource: 'config',
      autoReview: true, autoReviewSource: 'config',
    }));

    expect(defaults).toMatchObject({ completion: 'worktree-only', completionSource: 'default', autoReview: false, autoReviewSource: 'default' });
    expect(requested).toMatchObject({ completion: 'pr', completionSource: 'request', autoReview: false, autoReviewSource: 'request' });
    expect(configured).toMatchObject({ completion: 'auto-merge', completionSource: 'config', autoReview: true, autoReviewSource: 'config' });
  });

  it('external → transport 기본 pty(§2b) · dispatch agent-mission-pty', () => {
    const p = planDevPipeline(T({ executor: { kind: 'external', backend: 'claude' }, branch: 'wt/x' }));
    expect(p.executor).toEqual({ kind: 'external', backend: 'claude', transport: 'pty' });
    expect(p.dispatch).toBe('agent-mission-pty');
    expect(p.wired).toBe(true);
  });

  it('external+acp → dispatch acp(U6 배선됨)', () => {
    const p = planDevPipeline(T({ executor: { kind: 'external', backend: 'claude', transport: 'acp' }, context: 'mission' }));
    expect(p.dispatch).toBe('acp');
    expect(p.wired).toBe(true);
  });

  it('interactive → dispatch interactive(U4b 배선됨)', () => {
    const p = planDevPipeline(T({ context: 'interactive' }));
    expect(p.dispatch).toBe('interactive');
    expect(p.wired).toBe(true);
  });

  it('parallel(self) → dispatch parallel(U4b 배선됨)·concurrency 미지정 시 undefined 보존(orchestrate cap)', () => {
    const p = planDevPipeline(T({ parallel: { goals: [{ feature: 'a' }, { feature: 'b' }] } }));
    expect(p.dispatch).toBe('parallel');
    expect(p.parallel).toEqual({ goals: [{ feature: 'a' }, { feature: 'b' }], concurrency: undefined }); // ??4 강제 안 함
    expect(p.wired).toBe(true);
  });

  it('parallel concurrency 지정 시 보존', () => {
    const p = planDevPipeline(T({ parallel: { goals: [{ feature: 'a' }], concurrency: 3 } }));
    expect(p.parallel?.concurrency).toBe(3);
  });

  it('WIRED_DISPATCHES = 전 8종(self·elanous-tui·shell-drive·agent-mission-pty·acp·parallel·interactive·plan-staged)', () => {
    expect([...WIRED_DISPATCHES].sort()).toEqual(['acp', 'agent-mission-pty', 'elanous-tui', 'interactive', 'parallel', 'plan-staged', 'self-mission', 'shell-drive']);
  });

  it('새 elanous TUI namespace는 self+mission에서 elanous-tui dispatch를 선택한다', () => {
    const elanous: DevElanousTuiOpts = { goal: '격리 child를 완주', maxSteps: 7, pollMs: 0, model: 'test', isolatedRoot: '/isolated', cwd: '/work' };
    const p = planDevPipeline(T({ executor: { kind: 'self' }, elanous }));
    expect(p.dispatch).toBe('elanous-tui');
    expect(p.elanous).toEqual(elanous);
    expect(p.wired).toBe(true);
  });

  it('elanous TUI dispatch는 hold일 때만 goal 없이 계획하고, 일반 경로의 빈 goal 거부는 유지한다', () => {
    expect(() => planDevPipeline(T({ elanous: { goal: '' } }))).toThrow(/비어 있지 않은 goal/);
    expect(() => planDevPipeline(T({ elanous: { goal: '   ' } }))).toThrow(/비어 있지 않은 goal/);
    expect(planDevPipeline(T({ elanous: { hold: true } })).elanous).toEqual({ hold: true });
    expect(() => planDevPipeline(T({ elanous: { hold: true, goal: '명시 충돌' } }))).toThrow(/hold 는 goal과 동시 사용 불가/);
    expect(planDevPipeline(T({ elanous: { goal: '유효한 child 목표' } })).dispatch).toBe('elanous-tui');
    // ⛔ 경계값 — `trim()` 기준이면 빈/공백 goal 이 **통과해 조용히 무시**된다(리뷰 must-fix · 2026-07-30).
    //    하위 계층(pty-drive-cli)과 같은 계약: goal 의 **존재 자체**를 거부한다.
    expect(() => planDevPipeline(T({ elanous: { hold: true, goal: '' } }))).toThrow(/hold 는 goal과 동시 사용 불가/);
    expect(() => planDevPipeline(T({ elanous: { hold: true, goal: '   ' } }))).toThrow(/hold 는 goal과 동시 사용 불가/);
    // ⛔ brain 전용 옵션은 hold 와 함께 오면 거부한다 — hold 는 brain 을 안 만들므로 조용히 무시됐다.
    expect(() => planDevPipeline(T({ elanous: { hold: true, maxSteps: 5 } }))).toThrow(/brain 전용 옵션과 동시 사용 불가/);
    expect(() => planDevPipeline(T({ elanous: { hold: true, pollMs: 0 } }))).toThrow(/brain 전용 옵션과 동시 사용 불가/);
    expect(() => planDevPipeline(T({ elanous: { hold: true, model: 'x' } }))).toThrow(/brain 전용 옵션과 동시 사용 불가/);
    // ⭐ 스폰 옵션은 hold 에서도 유효하다(거부 대상 아님).
    expect(planDevPipeline(T({ elanous: { hold: true, cwd: '/w', isolatedRoot: '/iso' } })).elanous)
      .toEqual({ hold: true, cwd: '/w', isolatedRoot: '/iso' });
    // ⛔ goal 을 optional 로 바꿨으므로 **hold 도 goal 도 없는 {}** 를 명시적으로 거부해야 한다
    //    (기존 'goal 필수' 계약을 타입이 아니라 런타임으로 고정한다 · 리뷰 must-fix).
    expect(() => planDevPipeline(T({ elanous: {} }))).toThrow(/비어 있지 않은 goal/);
  });

  it('hold forwards an explicit readiness timeout and preserves omission for the PTY drive default', async () => {
    let got: import('../cli/pty-drive-cli.js').PtyDriveOpts | undefined;
    const runPtyDrive = async (opts: import('../cli/pty-drive-cli.js').PtyDriveOpts) => { got = opts; return { exitCode: 0 }; };
    const explicit = await runDevPipeline({ input: { text: '' }, elanous: { hold: true, readyTimeoutMs: 180000 } }, { runPtyDrive });
    expect(explicit.kind).toBe('elanous-tui');
    expect(got).toEqual({ elanous: true, hold: true, readyTimeoutMs: 180000 });
    const defaulted = await runDevPipeline({ input: { text: '' }, elanous: { hold: true } }, { runPtyDrive });
    expect(defaulted.kind).toBe('elanous-tui');
    expect(got).toEqual({ elanous: true, hold: true });
  });

  it('기존 dispatch 선택 순서는 elanous namespace 없이 그대로다', () => {
    const cases: Array<[DevPipelineSpec, DevDispatch]> = [
      [T(), 'self-mission'],
      [T({ executor: { kind: 'external', backend: 'codex' }, branch: 'wt/x' }), 'agent-mission-pty'],
      [T({ executor: { kind: 'external', backend: 'codex', transport: 'acp' } }), 'acp'],
      [T({ parallel: { goals: [{ feature: 'x' }] } }), 'parallel'],
      [T({ context: 'interactive' }), 'interactive'],
      [T({ plan: true }), 'plan-staged'],
    ];
    for (const [spec, dispatch] of cases) expect(planDevPipeline(spec).dispatch).toBe(dispatch);
  });

  it('elanous TUI namespace를 다른 dispatch와 함께 지정하면 dispatch명을 포함해 거부한다', () => {
    expect(() => planDevPipeline(T({ context: 'interactive', elanous: { goal: 'x' } })))
      .toThrow(/elanous TUI 실행 옵션은 elanous-tui dispatch.*interactive/);
  });

  // ── 검증 에러 ──
  it('interactive + completion≠worktree-only → 에러(chat 은 PR 산출 없음)', () => {
    expect(() => planDevPipeline(T({ context: 'interactive', completion: 'pr' }))).toThrow(DevPipelineError);
  });
  it('parallel + external → 에러(팬아웃은 self 만)', () => {
    expect(() => planDevPipeline(T({ parallel: { goals: [{ feature: 'a' }] }, executor: { kind: 'external', backend: 'codex' } }))).toThrow(/self executor/);
  });
  it('parallel 빈 goals → 에러', () => {
    expect(() => planDevPipeline(T({ parallel: { goals: [] } }))).toThrow(/비었다/);
  });
  it('agent-mission-pty + branch 없음 → 에러', () => {
    expect(() => planDevPipeline(T({ executor: { kind: 'external', backend: 'codex' } }))).toThrow(/--branch/);
  });
  it('input 없음 → 에러', () => {
    expect(() => planDevPipeline({ } as unknown as DevPipelineSpec)).toThrow(/input 필요/);
  });
});

describe('어댑터 — 계획 → 기존 성숙 함수 옵션(재발명 0)', () => {
  const fakeSeams = {} as SelfImplementSeams;
  it('toSelfImplementOptions — feature=text·seams·base·enhance 전파', () => {
    const plan = planDevPipeline(T({ base: 'main', enhance: true }));
    const o = toSelfImplementOptions('내 기능', plan, fakeSeams);
    expect(o.feature).toBe('내 기능');
    expect(o.seams).toBe(fakeSeams);
    expect(o.base).toBe('main');
    expect(o.baseSource).toBe('human');
    expect(o.baseSelectionRule).toBe('explicit');
    expect(o.enhance).toBe(true);
  });

  it('toSelfImplementOptions — 네 completion 모드를 그대로 전달하고 auto-merge만 legacy autoMerge를 켠다', () => {
    for (const completion of ['worktree-only', 'pr', 'auto-merge', 'unmanned'] as const) {
      const options = toSelfImplementOptions('내 기능', planDevPipeline(T({ completion })), fakeSeams);
      expect(options.completion).toBe(completion);
      expect(options.autoMerge).toBe(completion === 'auto-merge' ? true : undefined);
    }
  });

  it('toSelfImplementOptions — correlation을 전달하고 미지정 시 키를 생략한다', () => {
    const explicit = toSelfImplementOptions('내 기능', planDevPipeline(T({ self: { correlationId: 'request-zzz' } })), fakeSeams);
    const defaulted = toSelfImplementOptions('내 기능', planDevPipeline(T()), fakeSeams);

    expect(explicit.correlationId).toBe('request-zzz');
    expect(defaulted).not.toHaveProperty('correlationId');
  });

  it('toSelfImplementOptions — child LLM 선택을 변경 없이 전달하고 미지정 시 키를 생략한다', () => {
    const selected = { provider: 'anthropic', model: 'claude-sonnet', source: 'flag' as const };
    const explicit = toSelfImplementOptions('내 기능', planDevPipeline(T({ self: { childLlm: selected } })), fakeSeams);
    const defaulted = toSelfImplementOptions('내 기능', planDevPipeline(T()), fakeSeams);

    expect(explicit.childLlm).toEqual(selected);
    expect(defaulted).not.toHaveProperty('childLlm');
  });

  it('toSelfImplementOptions — file-backed plan preserves the original goalFile for salvage eligibility', () => {
    const plan = planDevPipeline(T({ input: { file: '/goals/GOAL.txt' } }));
    expect(toSelfImplementOptions('골 본문', plan, fakeSeams).goalFile).toBe('/goals/GOAL.txt');
  });

  it('NL self fields reach final options while file input retains priority for the existing goalFile slot', () => {
    const documentReferences = [{ result: { kind: 'inside-repository' } }] as never;
    const nlPlan = planDevPipeline(buildSelfImplementDevSpec({
      feature: 'NL F', draft: true, parentSessionId: 'session-nl', goalFile: '/goals/nl.md', documentReferences, naturalLanguageDispatch: true,
    }));
    const nlOptions = toSelfImplementOptions('NL F', nlPlan, fakeSeams);
    expect(nlOptions).toMatchObject({ parentSessionId: 'session-nl', goalFile: '/goals/nl.md', documentReferences, naturalLanguageDispatch: true });

    const filePlan = planDevPipeline({ ...buildSelfImplementDevSpec({ feature: 'file F', draft: true, goalFile: '/goals/nl.md' }), input: { file: '/goals/authored.md' } });
    expect(toSelfImplementOptions('file F', filePlan, fakeSeams).goalFile).toBe('/goals/authored.md');
  });

  it('toSelfImplementOptions — carries the authored GoalId from a file-backed document', () => {
    const plan = planDevPipeline(T({ input: { file: '/goals/GOAL.txt' } }));
    const document = '# Goal\n- GoalId: 4a92772c23611b64\n\n## PROBLEM\n';

    const first = toSelfImplementOptions(document, plan, fakeSeams);
    const second = toSelfImplementOptions(document, plan, fakeSeams);

    expect(first).toMatchObject({ goalFile: '/goals/GOAL.txt', goalId: '4a92772c23611b64' });
    expect(second.goalId).toBe(first.goalId);
  });

  it('toSelfImplementOptions — omits GoalId for a file without metadata and for text input', () => {
    const documentWithoutId = '# Goal\n\n## PROBLEM\n';
    const filePlan = planDevPipeline(T({ input: { file: '/goals/GOAL.txt' } }));
    const textPlan = planDevPipeline(T({ input: { text: '# Goal\n- GoalId: 4a92772c23611b64\n' } }));

    expect(toSelfImplementOptions(documentWithoutId, filePlan, fakeSeams)).not.toHaveProperty('goalId');
    expect(toSelfImplementOptions('# Goal\n- GoalId: 4a92772c23611b64\n', textPlan, fakeSeams)).not.toHaveProperty('goalId');
  });

  it('toSelfImplementOptions — salvage lineage environment is received as salvageAttempt', () => {
    const previous = process.env.ELANOUS_REWORK_SALVAGE_ATTEMPT;
    process.env.ELANOUS_REWORK_SALVAGE_ATTEMPT = '1';
    try {
      expect(toSelfImplementOptions('골 본문', planDevPipeline(T()), fakeSeams).salvageAttempt).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_REWORK_SALVAGE_ATTEMPT;
      else process.env.ELANOUS_REWORK_SALVAGE_ATTEMPT = previous;
    }
  });

  it('toAgentMissionSpec — mission=text·branch·evidence tsc·backend resolve', () => {
    const plan = planDevPipeline(T({ executor: { kind: 'external', backend: 'gemini' }, branch: 'wt/y' }));
    const fakeBackend: AgentBackend = { name: 'gemini', cmd: 'gemini', args: ['--yolo'] };
    const resolveBackend = (name?: string): AgentBackend => { expect(name).toBe('gemini'); return fakeBackend; };
    const s = toAgentMissionSpec('미션 텍스트', plan, resolveBackend);
    expect(s.mission).toBe('미션 텍스트');
    expect(s.branch).toBe('wt/y');
    expect(s.evidence).toEqual({ kind: 'tsc' });
    expect(s.agent).toBe(fakeBackend);
  });

  it('resolveDevInputText — {text} 그대로 · {file} 은 readFile 로', () => {
    expect(resolveDevInputText({ text: 'abc' }, () => 'X')).toBe('abc');
    expect(resolveDevInputText({ file: '/m.md' }, (p) => { expect(p).toBe('/m.md'); return '파일본문'; })).toBe('파일본문');
  });

  it('수동 골 파일에는 저작기와 같은 증거 위치 계약을 붙이고, 원문은 고쳐 쓰지 않으며 독립 요구줄만 중복하지 않는다', () => {
    const manual = '수동 골 본문';
    const required = 'For every acceptance criterion, state where evidence that it was met appears in the diff or which line of the report shows it. Evidence visible only on an execution screen and left in neither the diff nor the report is not evidence.';
    const supplemented = applyManualGoalEvidenceRequirement({ file: '/manual-goal.txt' }, manual);
    expect(supplemented).toBe(`${manual}\n\n${required}`);
    expect(manual).toBe('수동 골 본문');
    expect(applyManualGoalEvidenceRequirement({ file: '/authored-goal.txt' }, supplemented)).toBe(supplemented);
    expect(applyManualGoalEvidenceRequirement({ file: '/listed-authored-goal.txt' }, `${manual}\n- ${required}`)).toBe(`${manual}\n- ${required}`);
    expect(applyManualGoalEvidenceRequirement({ text: manual }, manual)).toBe(manual);
  });

  it('수동 골이 계약 문구를 인용만 하면 실행 프롬프트에는 독립 요구줄을 붙인다', () => {
    const required = 'For every acceptance criterion, state where evidence that it was met appears in the diff or which line of the report shows it. Evidence visible only on an execution screen and left in neither the diff nor the report is not evidence.';
    const manual = `설계 참고로 \`${required}\` 문구를 비교한다.`;
    expect(applyManualGoalEvidenceRequirement({ file: '/quoted-manual-goal.txt' }, manual)).toBe(`${manual}\n\n${required}`);
  });

  it('수동 --file 골은 실행 직전에 저작기와 동일한 증거 위치 계약을 self child payload에 전달한다', async () => {
    const required = 'For every acceptance criterion, state where evidence that it was met appears in the diff or which line of the report shows it. Evidence visible only on an execution screen and left in neither the diff nor the report is not evidence.';
    const directory = mkdtempSync(join(tmpdir(), 'elanous-manual-goal-'));
    const file = join(directory, 'manual-goal.txt');
    const manual = CANONICAL_GOAL_FILE;
    writeFileSync(file, manual);
    let payload: SelfImplementOptions | undefined;
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      await runDevPipeline({ input: { file } }, {
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async (options) => {
          payload = options;
          return { ok: true, stage: 'pr-declined' } as SelfImplementResult;
        },
      });
      expect(payload?.feature).toBe(`${manual}\n\n${required}`);
      expect(log).toHaveBeenCalledWith('dev-pipeline', 'manual-goal-evidence-requirement', { file, appended: true });
    } finally {
      log.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('U4b — toAgentMissionSpec 이 기존 AgentMissionSpec 을 exact 재구성(무손실·glob 포함)', () => {
    const fakeBackend: AgentBackend = { name: 'claude', cmd: 'claude', args: ['--dangerously-skip-permissions'] };
    const glob = /^PLAN-.*\.md$/i;
    // agent-mission 액션이 빌드하는 형태(--evidence doc --deliverable PPT --screens /s --base main --no-enhance)
    const plan = planDevPipeline({
      input: { text: '미션 본문' },
      executor: { kind: 'external', backend: 'claude' },
      branch: 'wt/a', base: 'main', enhance: false,
      mission: {
        evidence: { kind: 'doc', dirRel: 'docs/plans', glob },
        maxRounds: 16, commit: true, entry: 'elanous-apparatus', deliverableHint: 'PPT', screensDir: '/s',
      },
    });
    const ms = toAgentMissionSpec('미션 본문', plan, () => fakeBackend);
    // exact 비교 — 필드 손실·추가를 모두 탐지(toMatchObject 아님).
    expect(ms).toEqual({
      mission: '미션 본문',
      branch: 'wt/a',
      evidence: { kind: 'doc', dirRel: 'docs/plans', glob },
      agent: fakeBackend,
      base: 'main',
      enhance: false,
      maxRounds: 16,
      commit: true,
      screensDir: '/s',
      deliverableHint: 'PPT',
      entry: 'elanous-apparatus',
    });
    expect((ms.evidence as { glob: RegExp }).glob.source).toBe(glob.source); // glob 무손실 명시
  });

  it('U4b — branch/base 는 공유 플래너에서 trim 정규화(모든 호출자 동일·현실 브랜치명 등가)', () => {
    const plan = planDevPipeline({ input: { text: 'x' }, executor: { kind: 'external', backend: 'codex' }, branch: '  wt/a  ', base: '  main  ' });
    expect(plan.branch).toBe('wt/a'); // trim(git 브랜치명 정규화·기존 계약 유지)
    expect(plan.base).toBe('main');
  });

  it('U4b — commit:false·memory·nickname 도 전달', () => {
    const plan = planDevPipeline({
      input: { text: 'm' }, executor: { kind: 'external', backend: 'codex' }, branch: 'b',
      mission: { commit: false, memory: false, nickname: 'nn' },
    });
    const ms = toAgentMissionSpec('m', plan, () => ({ name: 'codex', cmd: 'codex', args: ['--yolo'] }));
    expect(ms.commit).toBe(false);
    expect(ms.memory).toBe(false);
    expect(ms.nickname).toBe('nn');
  });

  it('U4b — mission 옵션을 non-agent-mission dispatch 에 지정 → 거부(수락 후 무시 금지)', () => {
    expect(() => planDevPipeline({ input: { text: 'x' }, executor: { kind: 'self' }, mission: { maxRounds: 5 } })).toThrow(/agent-mission-pty/);
  });

  it('U6 — acpBackendName: codex→codex-app-server·나머지 동일', () => {
    expect(acpBackendName('codex')).toBe('codex-app-server');
    expect(acpBackendName('claude')).toBe('claude');
    expect(acpBackendName('gemini')).toBe('gemini');
    expect(acpBackendName('grok')).toBe('grok');
  });

  it('U6 — toAcpAgentArgs: backend 매핑·task=text·cwd', () => {
    const plan = planDevPipeline({ input: { text: 'T' }, executor: { kind: 'external', backend: 'codex', transport: 'acp' } });
    expect(toAcpAgentArgs('작업 텍스트', plan, '/work')).toEqual({ backend: 'codex-app-server', task: '작업 텍스트', cwd: '/work' });
  });

  it('U6 — normalizeAcpResult(fail-CLOSED): 실제 성공 shape만 ok·실패 판별자 우선', () => {
    // dispatchDelegateAgent 실제 성공 shape={backend,sessionId,stopReason,output}
    expect(normalizeAcpResult({ backend: 'claude', sessionId: 's1', stopReason: 'end_turn', output: 'ok', truncated: false }))
      .toEqual({ ok: true, backend: 'claude', sessionId: 's1', output: 'ok' });
    // 실패 판별자 — error(문자열/비문자열)·cancelled·명시 실패 마커 모두 우선
    expect(normalizeAcpResult({ error: '실패함', partialOutput: '부분' })).toEqual({ ok: false, error: '실패함', output: '부분' });
    expect(normalizeAcpResult({ error: 123 })).toEqual({ ok: false, error: '123' });          // 비문자열 error 도 실패
    expect(normalizeAcpResult({ cancelled: true, output: '중단' })).toEqual({ ok: false, cancelled: true, output: '중단' });
    expect(normalizeAcpResult({ ok: false, output: 'x' }).ok).toBe(false);                      // {ok:false}+output 도 실패(오판 방지)
    expect(normalizeAcpResult({ success: false, output: 'x' }).ok).toBe(false);
    // fail-closed — null·빈객체·미인식(output 없음)은 성공 오판 금지 → ok false
    expect(normalizeAcpResult(null).ok).toBe(false);
    expect(normalizeAcpResult({}).ok).toBe(false);
    expect(normalizeAcpResult({ backend: 'claude' }).ok).toBe(false);
  });

  it('U6 — 모든 DevBackend 의 acpBackendName 이 DELEGATE_BACKENDS 에 존재(구조 검증·능력≠존재)', async () => {
    const { DELEGATE_BACKENDS } = await import('../boot/daemon-tools/delegate-agent.js');
    for (const b of ['codex', 'claude', 'gemini', 'grok'] as const) {
      expect(DELEGATE_BACKENDS as readonly string[]).toContain(acpBackendName(b));
    }
  });

  it('U6 — defaultDispatchAcp: dispatchDelegateAgent 를 (args, {cwd,signal}) ctx 로 호출(기본 배선)', async () => {
    let gotArgs: unknown, gotCtx: { cwd: string; signal: AbortSignal } | undefined;
    const signal = new AbortController().signal;
    const fakeDelegate = async (a: unknown, ctx: { cwd: string; signal: AbortSignal }): Promise<unknown> => { gotArgs = a; gotCtx = ctx; return { output: 'x' }; };
    await defaultDispatchAcp({ backend: 'codex-app-server', task: 'T', cwd: '/w' }, signal, { dispatchDelegateAgent: fakeDelegate });
    expect(gotArgs).toEqual({ backend: 'codex-app-server', task: 'T', cwd: '/w' });
    expect(gotCtx).toEqual({ cwd: '/w', signal }); // 2번째 인자=최소 ctx{cwd,signal}
  });

  it('U6 — acp + branch/base 지정 → 거부(cwd 세션·worktree 없음)', () => {
    expect(() => planDevPipeline({ input: { text: 'x' }, executor: { kind: 'external', backend: 'claude', transport: 'acp' }, branch: 'wt/a' })).toThrow(/branch\/base/);
    expect(() => planDevPipeline({ input: { text: 'x' }, executor: { kind: 'external', backend: 'claude', transport: 'acp' }, base: 'main' })).toThrow(/branch\/base/);
  });
});

describe('U4b — mission 재라우팅 seam(성공경로·모든 옵션 전달·exit-code)', () => {
  const missionResult = { ok: true, worktree: '/wt', branch: 'b', rounds: 1, evidencePath: null, committed: true, usedOmniCrawl: false, detail: '' } as AgentMissionResult;

  it('buildAgentMissionDevSpec — 모든 CLI 옵션을 spec 으로 매핑(exact)', () => {
    const spec = buildAgentMissionDevSpec({
      mission: 'M', backend: 'claude', branch: 'wt/a', base: 'main', enhanceOff: true,
      evidence: { kind: 'tsc' }, maxRounds: 12, commit: false, deliverableHint: 'PPT', screensDir: '/s',
    });
    expect(spec).toEqual({
      input: { text: 'M' },
      executor: { kind: 'external', backend: 'claude' },
      branch: 'wt/a', base: 'main', enhance: false,
      mission: { evidence: { kind: 'tsc' }, maxRounds: 12, commit: false, entry: 'elanous-apparatus', deliverableHint: 'PPT', screensDir: '/s' },
    });
  });

  it('buildAgentMissionDevSpec — 옵션 없음: base/enhance/deliverable/screens 생략', () => {
    const spec = buildAgentMissionDevSpec({ mission: 'M', backend: 'codex', branch: 'b', evidence: { kind: 'tsc' }, maxRounds: 16, commit: true });
    expect(spec.base).toBeUndefined();
    expect(spec.enhance).toBeUndefined();
    expect(spec.mission).toEqual({ evidence: { kind: 'tsc' }, maxRounds: 16, commit: true, entry: 'elanous-apparatus' });
  });

  it('executeAgentMissionReroute — runDevPipeline 을 spec+주입backend 로 호출·ok→exit 0', async () => {
    const backend: AgentBackend = { name: 'codex', cmd: 'codex', args: ['--yolo'] };
    const spec = buildAgentMissionDevSpec({ mission: 'M', backend: 'codex', branch: 'b', evidence: { kind: 'tsc' }, maxRounds: 16, commit: true });
    let gotSpec: unknown, gotBackend: unknown;
    const fakeRun = (async (s: DevPipelineSpec, d: DevPipelineDeps) => {
      gotSpec = s; gotBackend = d.resolveBackend?.();
      return { plan: {} as ResolvedDevPlan, kind: 'agent-mission' as const, result: missionResult };
    }) as typeof runDevPipeline;
    const { result, exitCode } = await executeAgentMissionReroute(spec, backend, { runDevPipeline: fakeRun });
    expect(gotSpec).toBe(spec);        // spec 그대로 전달(모든 옵션 포함)
    expect(gotBackend).toBe(backend);  // 검증된 backend 주입(재resolve 없음)
    expect(result).toBe(missionResult);
    expect(exitCode).toBe(0);
  });

  it('executeAgentMissionReroute — result.ok=false → exit 2', async () => {
    const spec = buildAgentMissionDevSpec({ mission: 'M', backend: 'codex', branch: 'b', evidence: { kind: 'tsc' }, maxRounds: 16, commit: true });
    const fail = { ...missionResult, ok: false };
    const fakeRun = (async () => ({ plan: {} as ResolvedDevPlan, kind: 'agent-mission' as const, result: fail })) as typeof runDevPipeline;
    const { exitCode } = await executeAgentMissionReroute(spec, { name: 'codex', cmd: 'codex', args: ['--yolo'] }, { runDevPipeline: fakeRun });
    expect(exitCode).toBe(2);
  });
});

describe('U4b — self implement 재라우팅 seam(spec 매핑·exit-code·reroute)', () => {
  const selfResult = (over: Partial<SelfImplementResult> = {}): SelfImplementResult =>
    ({ ok: true, stage: 'pr-opened', ...over } as SelfImplementResult);

  it('buildSelfImplementDevSpec — 모든 CLI 옵션을 spec 으로 매핑(exact·autoMerge→completion·entry external-verbatim)', () => {
    const spec = buildSelfImplementDevSpec({
      feature: '기능 F', base: 'main', enhance: true, draft: false,
      autoMerge: true, autoReview: true, maxWaitSec: 1200, entry: 'external-verbatim',
    });
    expect(spec).toEqual({
      input: { text: '기능 F' },
      executor: { kind: 'self' },
      completion: 'auto-merge',        // autoMerge → completion
      completionSource: 'request',
      base: 'main', enhance: true, autoReview: true,
      self: { draft: false, maxWaitSec: 1200, entry: 'external-verbatim' },
    });
  });

  it('buildSelfImplementDevSpec — openPr(autoMerge 없음)→completion:pr · 옵션 생략', () => {
    const spec = buildSelfImplementDevSpec({ feature: 'F', draft: true, openPr: true, maxWaitSec: 600 });
    expect(spec.completion).toBe('pr');
    expect(spec.base).toBeUndefined();
    expect(spec.enhance).toBeUndefined();
    expect(spec.autoReview).toBeUndefined();
    expect(spec.self).toEqual({ draft: true, maxWaitSec: 600 });
  });

  it('buildSelfImplementDevSpec — PR 플래그 없음은 completion을 생략해 resolver로 보낸다', () => {
    const spec = buildSelfImplementDevSpec({ feature: 'F', draft: true, maxWaitSec: 600 });
    expect(spec.completion).toBeUndefined();
    expect(spec.completionSource).toBeUndefined();
    expect(planDevPipeline(spec)).toMatchObject({ completion: 'worktree-only', completionSource: 'default' });
  });

  it('self implement --plan 무지정은 승인 신호 없이 안전 resolver 기본을 유지한다', () => {
    expect(planDevPipeline(buildSelfImplementPlanDevSpec({ feature: 'F' })))
      .toMatchObject({ dispatch: 'plan-staged', completion: 'worktree-only', completionSource: 'default', autoReview: false, autoReviewSource: 'default' });
  });

  it('buildSelfImplementDevSpec은 autoMerge:false와 openPr:false에서 명시 no-open-pr을 우선한다', () => {
    expect(buildSelfImplementDevSpec({ feature: 'F', draft: true, autoMerge: false, openPr: false }))
      .toMatchObject({ completion: 'worktree-only', completionSource: 'request' });
  });

  it('buildSelfImplementDevSpec preserves explicit false and upstream config provenance for autoReview', () => {
    const explicitFalse = buildSelfImplementDevSpec({ feature: 'F', draft: true, autoReview: false });
    const configured = buildSelfImplementDevSpec({ feature: 'F', draft: true, autoReview: true, autoReviewSource: 'config' });
    expect(explicitFalse).toMatchObject({ autoReview: false });
    expect(planDevPipeline(explicitFalse).autoReviewSource).toBe('request');
    expect(planDevPipeline(configured)).toMatchObject({ autoReview: true, autoReviewSource: 'config' });
  });

  it('spec → toSelfImplementOptions: self 필드(draft·entry·autoMerge·autoReview) 무손실 전달', () => {
    const plan = planDevPipeline(buildSelfImplementDevSpec({
      feature: 'F', draft: false, autoMerge: true, autoReview: true, maxWaitSec: 900, entry: 'external-verbatim',
    }));
    const o = toSelfImplementOptions('F', plan, {} as SelfImplementSeams);
    expect(o.draft).toBe(false);
    expect(o.entry).toBe('external-verbatim');
    expect(o.autoMerge).toBe(true);   // completion:auto-merge → autoMerge
    expect(o.autoReview).toBe(true);
    // maxWaitSec 는 seams(implementMaxWaitSec) 몫 → options 엔 없음
    expect((o as { maxWaitSec?: number }).maxWaitSec).toBeUndefined();
  });

  it('selfImplementExitCode — 실패 stage→1 · pr-declined/성공→0(CLI 규약 보존)', () => {
    for (const s of ['gate-failed', 'review-blocked', 'aborted', 'merge-conflict', 'timed-out'] as const) {
      expect(selfImplementExitCode(s)).toBe(1);
    }
    for (const s of ['merged', 'pr-opened', 'pr-declined'] as const) {
      expect(selfImplementExitCode(s)).toBe(0);
    }
  });

  it('executeSelfImplementReroute — runDevPipeline 을 spec 으로 호출·stage→exit-code 매핑', async () => {
    const spec = buildSelfImplementDevSpec({ feature: 'F', draft: true, maxWaitSec: 600 });
    let gotSpec: unknown;
    const fakeRun = (async (s: DevPipelineSpec) => {
      gotSpec = s;
      return { plan: {} as ResolvedDevPlan, kind: 'self' as const, result: selfResult({ stage: 'gate-failed', ok: false }) };
    }) as typeof runDevPipeline;
    const { result, exitCode } = await executeSelfImplementReroute(spec, { runDevPipeline: fakeRun });
    expect(gotSpec).toBe(spec);
    expect(result.stage).toBe('gate-failed');
    expect(exitCode).toBe(1); // gate-failed → 1
  });

  it('executeSelfImplementReroute — pr-declined → exit 0(의도적 무-PR 성공)', async () => {
    const spec = buildSelfImplementDevSpec({ feature: 'F', draft: true, maxWaitSec: 600 });
    const fakeRun = (async () => ({ plan: {} as ResolvedDevPlan, kind: 'self' as const, result: selfResult({ stage: 'pr-declined' }) })) as typeof runDevPipeline;
    const { exitCode } = await executeSelfImplementReroute(spec, { runDevPipeline: fakeRun });
    expect(exitCode).toBe(0);
  });

  it('executeSelfImplementReroute — 예상 밖 dispatch(kind≠self) → 즉시 표면화(캐스팅 금지)', async () => {
    const spec = buildSelfImplementDevSpec({ feature: 'F', draft: true, maxWaitSec: 600 });
    const fakeRun = (async () => ({ plan: {} as ResolvedDevPlan, kind: 'agent-mission' as const, result: {} as AgentMissionResult })) as typeof runDevPipeline;
    await expect(executeSelfImplementReroute(spec, { runDevPipeline: fakeRun })).rejects.toThrow(/예상 밖 dispatch/);
  });

  it('self 실행 옵션을 non-self dispatch 에 지정 → 거부(수락 후 무시 금지·mission 대칭)', () => {
    expect(() => planDevPipeline({ input: { text: 'x' }, executor: { kind: 'external', backend: 'codex' }, branch: 'b', self: { draft: false } }))
      .toThrow(/self 실행 옵션은 self-mission/);
  });
});

describe('T1 — self implement --plan(plan-staged) 재라우팅 seam', () => {
  it('buildSelfImplementPlanDevSpec — executor:self·plan:true·completion(autoMerge>openPr>worktree-only)·self? 없음', () => {
    expect(buildSelfImplementPlanDevSpec({ feature: 'F', base: 'main', autoMerge: true })).toEqual({
      input: { text: 'F' }, executor: { kind: 'self' }, plan: true, completion: 'auto-merge', completionSource: 'request', base: 'main',
    });
    expect(buildSelfImplementPlanDevSpec({ feature: 'F', openPr: true }).completion).toBe('pr');
    expect(buildSelfImplementPlanDevSpec({ feature: 'F' }).completion).toBeUndefined();
    // self? 옵션 없음(staged 소관) → planDevPipeline 거부 안 함
    expect(buildSelfImplementPlanDevSpec({ feature: 'F' }).self).toBeUndefined();
  });

  it('plan spec → planDevPipeline: dispatch plan-staged·wired', () => {
    const p = planDevPipeline(buildSelfImplementPlanDevSpec({ feature: 'F', openPr: true }));
    expect(p.dispatch).toBe('plan-staged');
    expect(p.wired).toBe(true);
    expect(p.completion).toBe('pr');
  });

  it('executeSelfImplementPlanReroute — completion:pr → auto_drive on·output/exit0', async () => {
    let gotArgs: DevHarnessDispatchArgs | undefined;
    const r = await executeSelfImplementPlanReroute(
      buildSelfImplementPlanDevSpec({ feature: '기능', openPr: true }),
      { pipelineDeps: { dispatchRunDevHarness: async (a) => { gotArgs = a; return { output: 'staged done' }; } } },
    );
    expect(gotArgs?.auto_drive).toBe('on');       // pr → on(원 openPr||autoMerge 등가)
    expect(gotArgs?.objective).toBe('기능');
    expect(r).toEqual({ output: 'staged done', exitCode: 0 }); // staged 하니스 성공 exit 0 고정
  });

  it('executeSelfImplementPlanReroute — 예상 밖 dispatch(kind≠plan-staged) → 즉시 표면화', async () => {
    const fakeRun = (async () => ({ plan: {} as ResolvedDevPlan, kind: 'self' as const, result: {} as SelfImplementResult })) as typeof runDevPipeline;
    await expect(executeSelfImplementPlanReroute(buildSelfImplementPlanDevSpec({ feature: 'F' }), { runDevPipeline: fakeRun })).rejects.toThrow(/예상 밖 dispatch/);
  });

  it('plan-staged + completion:unmanned → 거부(수락 후 무시 금지·조용한 on 변환 차단·리뷰 must-fix)', async () => {
    // buildSelfImplementPlanDevSpec 은 unmanned 를 안 만들지만 runDevPipeline 공개 API 로 직접 오면 거부해야.
    await expect(runDevPipeline({ input: { text: 'F' }, executor: { kind: 'self' }, plan: true, completion: 'unmanned' }, { dispatchRunDevHarness: async () => ({ output: 'x' }) }))
      .rejects.toThrow(/NotYetUnified.*completion:unmanned/);
  });

  it('plan-staged base 전달 + auto-merge→auto_drive on', async () => {
    let gotArgs: DevHarnessDispatchArgs | undefined;
    await runDevPipeline(buildSelfImplementPlanDevSpec({ feature: '골', base: 'release', autoMerge: true }), { dispatchRunDevHarness: async (a) => { gotArgs = a; return { output: 'ok' }; } });
    expect(gotArgs).toEqual({ objective: '골', auto_drive: 'on', target: 'self', base: 'release' }); // base 전달·auto-merge→on
  });

  it('plan-staged는 호출자 runId만 그대로 하니스에 전달하고, 없으면 생략한다', async () => {
    let forwarded: DevHarnessDispatchArgs | undefined;
    const forwardedResult = await runDevPipeline(T({ plan: true, runId: 'run-caller-owned' }), {
      dispatchRunDevHarness: async (args) => { forwarded = args; return { output: 'forwarded' }; },
    });
    expect(forwarded).toMatchObject({ objective: '기능 X', runId: 'run-caller-owned' });
    expect(forwardedResult).toMatchObject({ kind: 'plan-staged', result: { output: 'forwarded' } });

    let absent: DevHarnessDispatchArgs | undefined;
    const absentResult = await runDevPipeline(T({ plan: true }), {
      dispatchRunDevHarness: async (args) => { absent = args; return { output: 'absent' }; },
    });
    expect(absent).toEqual({ objective: '기능 X', auto_drive: 'safe', target: 'self' });
    expect(absentResult).toMatchObject({ kind: 'plan-staged', result: { output: 'absent' } });
  });

  it('runId는 plan-staged가 아닌 dispatch의 실행과 반환을 바꾸지 않는다', async () => {
    const result = await runDevPipeline(T({ runId: 'run-must-not-leak' }), {
      runSelfImplement: async () => ({ ok: true } as SelfImplementResult),
      buildSelfImplementSeams: () => ({} as SelfImplementSeams),
    });
    expect(result).toMatchObject({ kind: 'self', result: { ok: true } });
  });

  it('self-mission 은 spec.runId 를 runSelfImplement 로 흘리고 없으면 생략한다', async () => {
    const received: Array<string | undefined> = [];
    await runDevPipeline(T({ runId: 'run-caller-owned' }), {
      runSelfImplement: async (options) => {
        received.push(options.runId);
        return { ok: true } as SelfImplementResult;
      },
      buildSelfImplementSeams: () => ({} as SelfImplementSeams),
    });
    await runDevPipeline(T(), {
      runSelfImplement: async (options) => {
        received.push(options.runId);
        return { ok: true } as SelfImplementResult;
      },
      buildSelfImplementSeams: () => ({} as SelfImplementSeams),
    });
    expect(received).toEqual(['run-caller-owned', undefined]);
  });

  it('buildSelfImplementDevSpec 은 runId 를 spec 에 싣고 없으면 키를 생략한다', () => {
    expect(buildSelfImplementDevSpec({ feature: 'F', draft: true, runId: 'run-caller-owned' }).runId).toBe('run-caller-owned');
    expect(buildSelfImplementDevSpec({ feature: 'F', draft: true })).not.toHaveProperty('runId');
  });
});

describe('U4b — self orchestrate(parallel) 재라우팅 seam(spec 매핑·exit-code·reroute)', () => {
  const jr = (over: Partial<SelfDevJobResult> = {}): SelfDevJobResult =>
    ({ taskId: 't', feature: 'f', status: 'done', ...over } as SelfDevJobResult);

  it('buildSelfOrchestrateDevSpec — goals(per-goal 데이터)+concurrency → parallel spec(input=goals 요약)', () => {
    const goals = [{ feature: 'g1', openPr: true }, { feature: 'g2', dependsOn: ['0'] }];
    const spec = buildSelfOrchestrateDevSpec(goals, 3);
    expect(spec).toEqual({
      input: { text: 'g1 ;; g2' },
      executor: { kind: 'self' },
      parallel: { goals, concurrency: 3 },
    });
  });

  it('buildSelfOrchestrateDevSpec — concurrency 미지정 → spec 에 없음(orchestrate cap 위임)', () => {
    const spec = buildSelfOrchestrateDevSpec([{ feature: 'g1' }]);
    expect(spec.parallel).toEqual({ goals: [{ feature: 'g1' }] });
    expect(spec.parallel!.concurrency).toBeUndefined();
  });

  it('toOrchestrateOptions — goals/concurrency(spec) + runtime 콜백 병합', () => {
    const plan = planDevPipeline(buildSelfOrchestrateDevSpec([{ feature: 'g1' }], 2));
    let checkpointed = false;
    const opts = toOrchestrateOptions(plan, { checkpoint: () => { checkpointed = true; }, teardown: true });
    expect(opts.goals).toEqual([{ feature: 'g1' }]);
    expect(opts.concurrency).toBe(2);
    expect(opts.teardown).toBe(true);
    opts.checkpoint!([]);
    expect(checkpointed).toBe(true);
  });

  it('orchestrateExitCode — 하나라도 미완(done<total)→1 · 전부 done→0', () => {
    expect(orchestrateExitCode([jr(), jr()])).toBe(0);
    expect(orchestrateExitCode([jr(), jr({ status: 'failed' })])).toBe(1);
    expect(orchestrateExitCode([jr({ status: 'cancelled' })])).toBe(1);
    expect(orchestrateExitCode([])).toBe(0); // 빈 결과는 미완 없음 → 0
  });

  it('executeOrchestrateReroute — runDevPipeline 을 spec+runtime 으로 호출·결과→exit-code', async () => {
    const spec = buildSelfOrchestrateDevSpec([{ feature: 'g1' }], 2);
    const runtime = { teardown: true };
    let gotSpec: unknown, gotRuntime: unknown;
    const fakeRun = (async (s: DevPipelineSpec, d: DevPipelineDeps) => {
      gotSpec = s; gotRuntime = d.orchestrateRuntime;
      return { plan: {} as ResolvedDevPlan, kind: 'parallel' as const, result: [jr(), jr({ status: 'failed' })] };
    }) as typeof runDevPipeline;
    const { results, exitCode } = await executeOrchestrateReroute(spec, runtime, { runDevPipeline: fakeRun });
    expect(gotSpec).toBe(spec);
    expect(gotRuntime).toBe(runtime);          // runtime 을 orchestrateRuntime dep 으로 주입
    expect(results).toHaveLength(2);
    expect(exitCode).toBe(1);                  // 1 failed → 1
  });

  it('executeOrchestrateReroute — 예상 밖 dispatch(kind≠parallel) → 즉시 표면화', async () => {
    const spec = buildSelfOrchestrateDevSpec([{ feature: 'g1' }]);
    const fakeRun = (async () => ({ plan: {} as ResolvedDevPlan, kind: 'self' as const, result: {} as SelfImplementResult })) as typeof runDevPipeline;
    await expect(executeOrchestrateReroute(spec, {}, { runDevPipeline: fakeRun })).rejects.toThrow(/예상 밖 dispatch/);
  });

  it('runDevPipeline parallel → orchestrateSelfDev 주입 호출(goals·concurrency·runtime 배선·kind:parallel)', async () => {
    let gotOpts: import('./orchestrate.js').OrchestrateSelfDevOptions | undefined;
    const spec = buildSelfOrchestrateDevSpec([{ feature: 'g1', openPr: true }], 2);
    const r = await runDevPipeline(spec, {
      orchestrateSelfDev: async (o) => { gotOpts = o; return [jr()]; },
      orchestrateRuntime: { teardown: true },
    });
    expect(r.kind).toBe('parallel');
    expect(gotOpts?.goals).toEqual([{ feature: 'g1', openPr: true }]); // per-goal 데이터 무손실
    expect(gotOpts?.concurrency).toBe(2);
    expect(gotOpts?.teardown).toBe(true);                              // runtime 병합
  });

  it('parallel + top-level completion:pr → 거부(per-goal openPr/autoMerge 로 제어)', async () => {
    await expect(runDevPipeline({ ...buildSelfOrchestrateDevSpec([{ feature: 'g1' }]), completion: 'pr' }, { orchestrateSelfDev: async () => [jr()] }))
      .rejects.toThrow(/NotYetUnified.*completion:pr/);
  });
});

describe('U4b — chat(interactive) 재라우팅(spec 매핑·주입 dispatch)', () => {
  it('buildChatDevSpec — executor:self·context:interactive·chat opts 전달', () => {
    const chat: DevChatOpts = { session: 's1', forceNew: false, json: true, enableTools: true, goalLoop: true };
    const spec = buildChatDevSpec('안녕', chat);
    expect(spec).toEqual({
      input: { text: '안녕' },
      executor: { kind: 'self' },
      context: 'interactive',
      chat,
    });
  });

  it('interactive completion 은 worktree-only 강제(chat 은 PR 산출 없음)', () => {
    const p = planDevPipeline(buildChatDevSpec('t', { forceNew: false }));
    expect(p.completion).toBe('worktree-only');
    expect(p.dispatch).toBe('interactive');
  });

  it('interactive + completion≠worktree-only spec → 에러', () => {
    expect(() => planDevPipeline({ ...buildChatDevSpec('t', {}), completion: 'pr' })).toThrow(DevPipelineError);
  });

  it('runDevPipeline interactive → 주입 runChatTurn 을 text·chat 으로 호출(kind:interactive·result null)', async () => {
    let gotText: string | undefined, gotChat: DevChatOpts | undefined;
    const spec = buildChatDevSpec('무엇을 하지', { session: 's9', forceNew: true, enableTools: true });
    const r = await runDevPipeline(spec, { runChatTurn: async (text, chat) => { gotText = text; gotChat = chat; } });
    expect(r.kind).toBe('interactive');
    if (r.kind === 'interactive') expect(r.result).toBeNull();
    expect(gotText).toBe('무엇을 하지');
    // buildChatDevSpec 은 chat 을 verbatim 전달(정규화는 seam toDevChatOpts 몫) → 넘긴 그대로.
    expect(gotChat).toEqual({ session: 's9', forceNew: true, enableTools: true });
  });

  it('interactive 는 empty-text 도 통과(chat 원 동작 보존·build dispatch 만 비-empty)', async () => {
    let called = false;
    await runDevPipeline(buildChatDevSpec('   ', {}), { runChatTurn: async () => { called = true; } });
    expect(called).toBe(true); // 빈/공백 text 로도 chat 턴 호출(원 chat 액션 무-검사 동형)
  });

  it('chat 실행 옵션을 non-interactive dispatch 에 지정 → 거부(수락 후 무시 금지)', () => {
    expect(() => planDevPipeline({ input: { text: 'x' }, chat: { forceNew: true } }))
      .toThrow(/chat 실행 옵션은 interactive/);
  });
});

describe('runDevPipeline — 디스패치 라우팅(주입·무실행)', () => {
  it('runId만 있으면 기존 resolver로 explicit 출처를 기록한다', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'elanous-dev-pipeline-run-'));
    const previousStateDir = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = stateDir;
    try {
      await runDevPipeline(T({ runId: 'run-dev-pipeline-record' }), {
        runSelfImplement: async () => selfResult,
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
      });
      const run = loadSelfDevRun('run-dev-pipeline-record', selfDevRunsDir(stateDir));
      expect(run).toMatchObject({ runId: 'run-dev-pipeline-record', results: [], pid: process.pid });
      expect(run?.participants).toEqual([{
        id: `process:${process.pid}`,
        kind: 'process',
        transports: [],
        registeredAt: expect.any(Number),
        runIdSource: 'explicit',
      }]);
    } finally {
      if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('최외곽에서 minted한 identity를 받으면 저장 참가자 출처를 minted로 보존한다', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'elanous-dev-pipeline-run-'));
    const previousStateDir = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = stateDir;
    try {
      const identity = ensureRunIdentity({});
      await runDevPipeline(T({ runId: identity.runId, runIdSource: identity.source }), {
        runSelfImplement: async () => selfResult,
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
      });
      expect(loadSelfDevRun(identity.runId, selfDevRunsDir(stateDir))?.participants?.[0]?.runIdSource).toBe('minted');
    } finally {
      if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  const selfResult = { ok: true } as unknown as SelfImplementResult;
  const missionResult = { ok: true, worktree: '/wt', branch: 'b', rounds: 1, evidencePath: null, committed: true, usedOmniCrawl: false, detail: '' } as AgentMissionResult;

  it('self-mission → runSelfImplement 호출(어댑트된 옵션)', async () => {
    let got: string | undefined;
    const deps: DevPipelineDeps = {
      runSelfImplement: async (o) => { got = o.feature; return selfResult; },
      buildSelfImplementSeams: () => ({} as SelfImplementSeams),
    };
    const r = await runDevPipeline(T({ input: { text: '자체구현 골' } }), deps);
    expect(r.kind).toBe('self');
    expect(got).toBe('자체구현 골');
  });

  it('plan front door retains the legacy event and dual-emits harness.launch with the same payload plus its legacy label and entrance', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ category: _category, event, data: data ?? {} });
    }) as never);
    try {
      await runDevPipeline(T({ entrance: 'cli-dev-ask', runId: 'run-dual-emit' }), {
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => selfResult,
      });
    } finally {
      log.mockRestore();
    }

    const legacy = events.find((entry) => entry.category === 'dev-pipeline' && entry.event === 'plan');
    const launch = events.find((entry) => entry.category === 'dev-pipeline' && entry.event === 'harness.launch');
    expect(legacy).toBeDefined();
    expect(launch).toEqual({
      category: 'dev-pipeline',
      event: 'harness.launch',
      data: { ...legacy!.data, legacyEvent: 'plan', entrance: 'cli-dev-ask' },
    });
    expect(events.indexOf(legacy!)).toBeLessThan(events.indexOf(launch!));
  });

  it('pre-dispatch failure still dual-emits the fallback plan observation without inventing a dispatch or entrance', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ category: _category, event, data: data ?? {} });
    }) as never);
    try {
      await expect(runDevPipeline({ input: { text: 'x' }, entrance: 'not-a-registered-entrance' as DevPipelineSpec['entrance'] }))
        .rejects.toThrow(/알 수 없는 입구 id/);
    } finally {
      log.mockRestore();
    }

    const legacy = events.filter((entry) => entry.category === 'dev-pipeline' && entry.event === 'plan');
    const launches = events.filter((entry) => entry.category === 'dev-pipeline' && entry.event === 'harness.launch');
    expect(legacy).toHaveLength(1);
    expect(launches).toEqual([{ category: 'dev-pipeline', event: 'harness.launch', data: { ...legacy[0]!.data, legacyEvent: 'plan' } }]);
    expect(legacy[0]!.data).not.toHaveProperty('dispatch');
    expect(launches[0]!.data).not.toHaveProperty('entrance');
  });

  it('completion과 autoReview 선택은 축별 한 행으로 결정값·출처·요청값·입구를 관측한다', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ category: _category, event, data: data ?? {} });
    }) as never);
    try {
      await runDevPipeline(T({
        completion: 'pr', completionSource: 'request',
        autoReview: false, autoReviewSource: 'config',
        self: { entry: 'external-verbatim' },
        runId: 'run-selection-identity',
      }), {
        runGit: presentRemote,
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => selfResult,
      });
    } finally {
      log.mockRestore();
    }

    expect(events.filter((entry) => entry.category === 'dev-pipeline' && entry.event === 'selection')).toEqual([
      { category: 'dev-pipeline', event: 'selection', data: { axis: 'completion', effectiveValue: 'pr', source: 'request', requestedValue: 'pr', entryRoute: 'external-verbatim', runId: 'run-selection-identity' } },
      { category: 'dev-pipeline', event: 'selection', data: { axis: 'autoReview', effectiveValue: false, source: 'config', requestedValue: undefined, entryRoute: 'external-verbatim', runId: 'run-selection-identity' } },
    ]);
  });

  it('selection observer preserves the shared source vocabulary and one-axis payload', () => {
    const entries: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      entries.push({ category: _category, event, data: data ?? {} });
    }) as never);
    try {
      observeDevSelection('completion', 'worktree-only', 'default', undefined, 'elanous-apparatus', undefined);
      observeDevSelection('autoReview', true, 'config', undefined, 'external-verbatim', undefined);
    } finally {
      log.mockRestore();
    }
    expect(entries).toEqual([
      { category: 'dev-pipeline', event: 'selection', data: { axis: 'completion', effectiveValue: 'worktree-only', source: 'default', requestedValue: undefined, entryRoute: 'elanous-apparatus' } },
      { category: 'dev-pipeline', event: 'selection', data: { axis: 'autoReview', effectiveValue: true, source: 'config', requestedValue: undefined, entryRoute: 'external-verbatim' } },
    ]);
  });

  it('등록된 발사 입구는 planDevPipeline을 지나 관측 payload에 별도 칸으로 실린다', async () => {
    const entries: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      entries.push({ category: _category, event, data: data ?? {} });
    }) as never);
    try {
      await runDevPipeline(T({ entrance: 'cli-dev-ask', self: { entry: 'external-verbatim' } }), {
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => selfResult,
      });
    } finally {
      log.mockRestore();
    }
    const selections = entries.filter((entry) => entry.category === 'dev-pipeline' && entry.event === 'selection');
    expect(selections).toHaveLength(2);
    expect(selections[0]?.data.entrance).toBe('cli-dev-ask');
    expect(selections[0]?.data.entryRoute).toBe('external-verbatim');
    expect(selections[0]?.data).toEqual({
      axis: 'completion',
      effectiveValue: 'auto-merge',
      source: 'default',
      requestedValue: undefined,
      entryRoute: 'external-verbatim',
      entrance: 'cli-dev-ask',
    });
    expect(selections[1]?.data).toEqual({
      axis: 'autoReview',
      effectiveValue: true,
      source: 'default',
      requestedValue: undefined,
      entryRoute: 'external-verbatim',
      entrance: 'cli-dev-ask',
    });
  });

  it('입구 식별자를 안 주면 관측 payload 키는 종전과 같고 entrance 칸이 없다', async () => {
    const entries: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      entries.push({ category: _category, event, data: data ?? {} });
    }) as never);
    try {
      await runDevPipeline(T({ self: { entry: 'external-verbatim' } }), {
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => selfResult,
      });
    } finally {
      log.mockRestore();
    }
    const selections = entries.filter((entry) => entry.category === 'dev-pipeline' && entry.event === 'selection');
    expect(selections).toHaveLength(2);
    expect(Object.keys(selections[0]!.data).sort()).toEqual(['axis', 'effectiveValue', 'entryRoute', 'requestedValue', 'source']);
    expect(Object.hasOwn(selections[0]!.data, 'entrance')).toBe(false);
    expect(selections[0]?.data).toEqual({
      axis: 'completion',
      effectiveValue: 'worktree-only',
      source: 'default',
      requestedValue: undefined,
      entryRoute: 'external-verbatim',
    });
    expect(Object.keys(selections[1]!.data).sort()).toEqual(['axis', 'effectiveValue', 'entryRoute', 'requestedValue', 'source']);
    expect(Object.hasOwn(selections[1]!.data, 'entrance')).toBe(false);
    expect(selections[1]?.data).toEqual({
      axis: 'autoReview',
      effectiveValue: false,
      source: 'default',
      requestedValue: undefined,
      entryRoute: 'external-verbatim',
    });
  });

  it('레지스트리에 없는 입구 식별자는 planDevPipeline이 조용히 통과하지 않는다', () => {
    expect(() => planDevPipeline(T({ entrance: 'not-a-registered-entrance' as DevPipelineSpec['entrance'] })))
      .toThrow(/entrance-registry: 알 수 없는 입구 id — not-a-registered-entrance/);
  });

  it('unsupported completion records requested and effective values before retaining rejection', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ category: _category, event, data: data ?? {} });
    }) as never);
    try {
      await expect(runDevPipeline(T({ completion: 'unmanned', self: { entry: 'external-verbatim' } }))).rejects.toThrow(/unmanned 미배선/);
    } finally {
      log.mockRestore();
    }
    expect(events.filter((entry) => entry.category === 'dev-pipeline' && entry.event === 'selection')[0]).toEqual(
      { category: 'dev-pipeline', event: 'selection', data: { axis: 'completion', effectiveValue: 'unmanned', source: 'request', requestedValue: 'unmanned', entryRoute: 'external-verbatim' } },
    );
  });

  it('observed: run start logs git residue path, kinds, and count', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dev-residue-observed-'));
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    mkdirSync(join(directory, '.git', 'sequencer'), { recursive: true });
    writeFileSync(join(directory, '.git', 'sequencer', 'todo'), 'pick deadbeef subject\n');
    writeFileSync(join(directory, '.git', 'MERGE_HEAD'), 'merge');
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runDevPipeline(T(), {
        cwd: directory,
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => selfResult,
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(directory, { recursive: true, force: true });
    }
    const plan = events.find((entry) => entry.category === 'dev-pipeline' && entry.event === 'plan');
    expect(plan?.data).toMatchObject({
      gitResiduePath: directory,
      gitResidueState: 'observed',
      gitResidues: ['cherry-pick', 'merge'],
      gitResidueCount: 2,
    });
  });

  it('CLI-provided git residue snapshot is logged once with the observed worktree path', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runDevPipeline(T({
        gitResidueSnapshot: { path: '/worktree/observed-once', observation: { state: 'observed', residues: ['cherry-pick'] } },
      }), {
        runSelfImplement: async () => selfResult,
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    const plans = events.filter((entry) => entry.category === 'dev-pipeline' && entry.event === 'plan');
    expect(plans).toHaveLength(1);
    expect(plans[0]?.data).toMatchObject({
      gitResiduePath: '/worktree/observed-once',
      gitResidueState: 'observed',
      gitResidues: ['cherry-pick'],
      gitResidueCount: 1,
    });
  });

  it('file GoalId flows through dev-pipeline plan and self-implement start events across repeated runs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goalid-flow-'));
    const file = join(directory, 'GOAL.txt');
    const goalId = '4a92772c23611b64';
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    // ⛔ `## REQUIRED EVIDENCE` 는 이 테스트의 관심사가 아니지만 **발사 거부 관문**(`preflightGoalFileEvidence`)이
    //    요구 0 인 골 파일을 거부하므로 픽스처가 그것을 만족해야 한다. `--allow-no-evidence` 로 우회하지 않는 이유는
    //    우회하면 그 관문이 실제로 도는지 이 스위트가 더 이상 안 보기 때문이다.
    writeFileSync(file, `# Goal\n- GoalId: ${goalId}\n\n${CANONICAL_GOAL_FILE}`);
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      for (const runId of ['run-goalid-first', 'run-goalid-second']) {
        const result = await runDevPipeline({ input: { file } }, {
          buildSelfImplementSeams: () => ({
            createWorktree: async ({ branch, base }) => ({ path: `/wt/${branch}`, branch, base, resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
            implement: async () => ({ ok: true, summary: 'implemented' }),
            gate: async () => ({ passed: true, log: 'ok' }),
            openPr: async () => ({ url: 'https://pr/goalid', number: 1 }),
            readPrDiff: async () => '',
            readPrCommitShas: async () => ({ baseCommit: 'base', headCommit: 'head' }),
            approvePr: async () => true,
          }),
          // ⛔⭐ 쿼터 갱신 심을 «무동작»으로 — 안 주면 실제 계정 스토어를 읽고 codex 자식을
          //   띄운다(리뷰 must-fix). 이 테스트는 파이프라인 배선을 무는 것이지 쿼터가 아니다.
          runSelfImplement: (options) => runSelfImplement({
            ...options, runId,
            seams: { ...options.seams, refreshCodexQuotaSignals: async () => ({ accounts: [] }) },
          }),
        });
        expect(result.kind).toBe('self');
      }
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(directory, { recursive: true, force: true });
    }
    const plans = events.filter((entry) => entry.category === 'dev-pipeline' && entry.event === 'plan');
    const starts = events.filter((entry) => entry.category === 'self-implement' && entry.event === 'start' && 'feature' in entry.data);
    expect(plans).toHaveLength(2);
    expect(starts).toHaveLength(2);
    expect(plans.map((entry) => entry.data.goalId)).toEqual([goalId, goalId]);
    expect(starts.map((entry) => entry.data.goalId)).toEqual([goalId, goalId]);
    expect(starts.map((entry) => entry.data.runId)).toEqual(['run-goalid-first', 'run-goalid-second']);
  });

  it('omits GoalId from plan events for a file without metadata and for text input', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      for (const [runId, input] of [['run-no-goalid-file', { file: '/without-goalid.txt' }], ['run-no-file', { text: '- GoalId: 4a92772c23611b64' }]] as const) {
        await runDevPipeline({ input }, {
          // ⛔ 메타데이터(`- GoalId:`)는 없어야 하지만 요구 증거는 있어야 한다 — 발사 거부 관문이 별개 축이다.
          readFile: () => CANONICAL_GOAL_FILE,
          buildSelfImplementSeams: () => ({
            createWorktree: async ({ branch, base }) => ({ path: `/wt/${branch}`, branch, base, resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
            implement: async () => ({ ok: true, summary: 'implemented' }),
            gate: async () => ({ passed: true, log: 'ok' }),
            openPr: async () => ({ url: 'https://pr/no-goalid', number: 1 }),
            readPrDiff: async () => '',
            readPrCommitShas: async () => ({ baseCommit: 'base', headCommit: 'head' }),
            approvePr: async () => true,
          }),
          // ⛔⭐ 쿼터 갱신 심을 «무동작»으로 — 안 주면 실제 계정 스토어를 읽고 codex 자식을
          //   띄운다(리뷰 must-fix). 이 테스트는 파이프라인 배선을 무는 것이지 쿼터가 아니다.
          runSelfImplement: (options) => runSelfImplement({
            ...options, runId,
            seams: { ...options.seams, refreshCodexQuotaSignals: async () => ({ accounts: [] }) },
          }),
        });
      }
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    const plans = events.filter((entry) => entry.category === 'dev-pipeline' && entry.event === 'plan');
    const starts = events.filter((entry) => entry.category === 'self-implement' && entry.event === 'start' && 'feature' in entry.data);
    expect(plans).toHaveLength(2);
    expect(starts).toHaveLength(2);
    expect([...plans, ...starts].every((entry) => !('goalId' in entry.data))).toBe(true);
    expect(starts.map((entry) => entry.data.runId)).toEqual(['run-no-goalid-file', 'run-no-file']);
  });

  it('base-selection carries available run and goal identities, omits absent identities, and matches the plan run', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    const run = async (input: DevPipelineSpec['input'], runId?: string) => {
      const start = events.length;
      await runDevPipeline({ input, runId, humanReadableOutput: false }, {
        readFile: (file) => file.includes('no-goalid')
          ? CANONICAL_GOAL_FILE
          : `# Goal\n- GoalId: 4a92772c23611b64\n\n${CANONICAL_GOAL_FILE}`,
        runGh: () => '[]',
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => selfResult,
      });
      const emitted = events.slice(start);
      return {
        baseSelection: emitted.find((entry) => entry.category === 'dev-pipeline' && entry.event === 'base-selection')!.data,
        plan: emitted.find((entry) => entry.category === 'dev-pipeline' && entry.event === 'plan')!.data,
      };
    };
    try {
      const goalId = '4a92772c23611b64';
      const identified = await run({ file: '/goals/identified.txt' }, 'run-base-selection');
      const withoutGoal = await run({ file: '/goals/no-goalid.txt' }, 'run-without-goal');
      const withoutRun = await run({ file: '/goals/no-run.txt' });

      expect(identified.baseSelection).toMatchObject({
        runId: 'run-base-selection', goalId,
        base: DEFAULT_BRANCH_WORKTREE_BASE, rule: 'no-pr',
        evidence: `GoalId ${goalId}; candidates=0; excluded-by-state=0; no open PR; DEFAULT_BRANCH_WORKTREE_BASE`,
      });
      expect(identified.plan.runId).toBe(identified.baseSelection.runId);
      expect(withoutGoal.baseSelection).toMatchObject({
        runId: 'run-without-goal', base: DEFAULT_BRANCH_WORKTREE_BASE,
        rule: 'no-goal-id', evidence: 'goal file has no GoalId; DEFAULT_BRANCH_WORKTREE_BASE',
      });
      expect(withoutGoal.baseSelection).not.toHaveProperty('goalId');
      expect(withoutRun.baseSelection).toMatchObject({
        goalId, base: DEFAULT_BRANCH_WORKTREE_BASE, rule: 'no-pr',
        evidence: `GoalId ${goalId}; candidates=0; excluded-by-state=0; no open PR; DEFAULT_BRANCH_WORKTREE_BASE`,
      });
      expect(withoutRun.baseSelection).not.toHaveProperty('runId');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  it('base-selection observation preserves absent·false·true relaunch without changing selected base', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    const run = (relaunch?: boolean) => runDevPipeline(T({
      input: { file: '/goals/relaunch.txt' },
      ...(relaunch === undefined ? {} : { relaunch }),
    }), {
      readFile: () => `- GoalId: 4a92772c23611b64\n${CANONICAL_GOAL_FILE}`,
      runGh: () => '[]',
      buildSelfImplementSeams: () => ({} as SelfImplementSeams),
      runSelfImplement: async () => selfResult,
    });
    try {
      const absent = await run();
      const disabled = await run(false);
      const enabled = await run(true);
      for (const result of [absent, disabled, enabled]) {
        expect(result.plan).toMatchObject({ base: DEFAULT_BRANCH_WORKTREE_BASE, baseSelection: { rule: 'no-goal-id' } });
      }
      expect(absent.plan).not.toHaveProperty('relaunch');
      expect(disabled.plan).toMatchObject({ relaunch: false });
      expect(enabled.plan).toMatchObject({ relaunch: true });
      const observations = events
        .filter((entry) => entry.category === 'dev-pipeline' && entry.event === 'base-selection')
        .map((entry) => entry.data);
      expect(observations).toHaveLength(3);
      expect(observations[0]).not.toHaveProperty('relaunch');
      expect(observations[1]).toMatchObject({ relaunch: false, base: DEFAULT_BRANCH_WORKTREE_BASE, rule: 'no-goal-id' });
      expect(observations[2]).toMatchObject({ relaunch: true, base: DEFAULT_BRANCH_WORKTREE_BASE, rule: 'no-goal-id' });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  describe('file GoalId PR base selection failures', () => {
    const EXISTING_BASE_SELECTION_RULES = [
      'explicit', 'default', 'no-goal-id', 'no-pr', 'no-open-pr', 'missing-pr-head', 'pr-lookup-failed', 'single-pr', 'latest-pr',
    ] as const;
    const RELAUNCH_SKIP_OPEN_PR_RULE = 'relaunch-skip-open-pr';
    const runFileGoal = async (
      goal: string,
      runGh: (args: string[]) => string,
      humanReadableOutput = true,
      over: Partial<Pick<DevPipelineSpec, 'relaunch' | 'base' | 'input'>> = {},
    ) => {
      const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
      const announcements: string[] = [];
      const original = debug.log;
      const originalConsoleLog = console.log;
      (debug as { log: typeof debug.log }).log = ((category, event, data) => {
        events.push({ category, event, data: data as Record<string, unknown> });
      }) as typeof debug.log;
      console.log = ((message: unknown) => { announcements.push(String(message)); }) as typeof console.log;
      try {
        const result = await runDevPipeline({
          input: over.input ?? { file: '/goals/rework.txt' },
          humanReadableOutput,
          ...(over.relaunch === undefined ? {} : { relaunch: over.relaunch }),
          ...(over.base === undefined ? {} : { base: over.base }),
        }, {
          readFile: () => goal,
          runGh,
          buildSelfImplementSeams: () => ({} as SelfImplementSeams),
          runSelfImplement: async () => selfResult,
        });
        return {
          plan: result.plan,
          selection: events.find((entry) => entry.category === 'dev-pipeline' && entry.event === 'base-selection')?.data,
          announcements,
          events,
          ok: devResultOk(result),
        };
      } finally {
        (debug as { log: typeof debug.log }).log = original;
        console.log = originalConsoleLog;
      }
    };

    it('records no-goal-id without querying gh when the file omits GoalId', async () => {
      let queried = false;
      const { plan, selection } = await runFileGoal(CANONICAL_GOAL_FILE, () => {
        queried = true;
        throw new Error('GoalId absence must not query gh');
      });

      expect(queried).toBe(false);
      expect(plan.base).toBe(DEFAULT_BRANCH_WORKTREE_BASE);
      expect(selection).toEqual({
        base: DEFAULT_BRANCH_WORKTREE_BASE,
        rule: 'no-goal-id',
        evidence: 'goal file has no GoalId; DEFAULT_BRANCH_WORKTREE_BASE',
      });
    });

    it('records no-pr and preserves DEFAULT_BRANCH_WORKTREE_BASE when gh finds zero PRs', async () => {
      const goalId = '4a92772c23611b64';
      const { plan, selection } = await runFileGoal(`Rework goal\n- GoalId: ${goalId}\n\n${CANONICAL_GOAL_FILE}`, (args) => {
        expect(args).toEqual(['pr', 'list', '--state', 'all', '--search', goalId, '--limit', '100', '--json', 'number,updatedAt,state']);
        return '[]';
      });

      expect(plan.base).toBe(DEFAULT_BRANCH_WORKTREE_BASE);
      expect(selection).toEqual({
        goalId,
        base: DEFAULT_BRANCH_WORKTREE_BASE,
        rule: 'no-pr',
        evidence: `GoalId ${goalId}; candidates=0; excluded-by-state=0; no open PR; DEFAULT_BRANCH_WORKTREE_BASE`,
      });
    });

    it('selects the newest OPEN PR while excluding newer CLOSED and MERGED PRs', async () => {
      const goalId = '4a92772c23611b64';
      const { plan, selection } = await runFileGoal(`Rework goal\n- GoalId: ${goalId}\n\n${CANONICAL_GOAL_FILE}`, (args) => args[1] === 'list'
        ? '[{"number":7003,"updatedAt":"2026-08-04T03:00:00Z","state":"MERGED"},{"number":7002,"updatedAt":"2026-08-04T02:00:00Z","state":"CLOSED"},{"number":7001,"updatedAt":"2026-08-04T01:00:00Z","state":"OPEN"}]'
        : '{"headRefName":"self-impl/open-run"}');

      expect(plan.base).toBe('self-impl/open-run');
      expect(toSelfImplementOptions('goal', plan, {} as SelfImplementSeams)).toMatchObject({
        base: 'self-impl/open-run', baseSource: 'automatic', baseSelectionRule: 'single-pr',
      });
      expect(selection).toEqual({
        goalId,
        base: 'self-impl/open-run',
        rule: 'single-pr',
        evidence: `GoalId ${goalId}; candidates=3; excluded-by-state=2; OPEN PR #7001`,
      });
    });

    // ⭐ 1라운드 should-fix — 위 혼합 테스트는 OPEN 이 «하나»라 정렬을 안 잰다.
    //    여러 OPEN 중 «최신 updatedAt» 이 이기는 기존 동작을 회귀로 고정한다.
    it('among several OPEN candidates the newest updatedAt wins', async () => {
      const goalId = '4a92772c23611b64';
      const { plan, selection } = await runFileGoal(`Rework goal\n- GoalId: ${goalId}\n\n${CANONICAL_GOAL_FILE}`, (args) => args[1] === 'list'
        ? '[{"number":7001,"updatedAt":"2026-08-04T01:00:00Z","state":"OPEN"},{"number":7005,"updatedAt":"2026-08-04T05:00:00Z","state":"OPEN"},{"number":7003,"updatedAt":"2026-08-04T03:00:00Z","state":"OPEN"}]'
        : '{"headRefName":"self-impl/newest-open"}');

      expect(plan.base).toBe('self-impl/newest-open');
      expect(selection).toEqual({
        goalId,
        base: 'self-impl/newest-open',
        rule: 'latest-pr',
        evidence: `GoalId ${goalId}; candidates=3; excluded-by-state=0; latest updatedAt OPEN PR #7005`,
      });
    });

    it('falls back to the default base when all candidates are CLOSED or MERGED', async () => {
      const goalId = '4a92772c23611b64';
      let viewed = false;
      const { plan, selection } = await runFileGoal(`Rework goal\n- GoalId: ${goalId}\n\n${CANONICAL_GOAL_FILE}`, (args) => {
        if (args[1] === 'view') viewed = true;
        return '[{"number":7002,"updatedAt":"2026-08-04T02:00:00Z","state":"CLOSED"},{"number":7003,"updatedAt":"2026-08-04T03:00:00Z","state":"MERGED"}]';
      });

      expect(viewed).toBe(false);
      expect(plan.base).toBe(DEFAULT_BRANCH_WORKTREE_BASE);
      expect(selection).toEqual({
        goalId,
        base: DEFAULT_BRANCH_WORKTREE_BASE,
        rule: 'no-open-pr',
        evidence: `GoalId ${goalId}; candidates=2; excluded-by-state=2; no open PR; DEFAULT_BRANCH_WORKTREE_BASE`,
      });
    });

    it('records missing-pr-head when gh returns a PR without headRefName', async () => {
      const goalId = '4a92772c23611b64';
      const { plan, selection } = await runFileGoal(`Rework goal\n- GoalId: ${goalId}\n\n${CANONICAL_GOAL_FILE}`, (args) => args[1] === 'list'
        ? '[{"number":6944,"updatedAt":"2026-08-04T01:00:00Z","state":"OPEN"}]'
        : '{"headRefName":"   "}');

      expect(plan.base).toBe(DEFAULT_BRANCH_WORKTREE_BASE);
      expect(selection).toEqual({
        goalId,
        base: DEFAULT_BRANCH_WORKTREE_BASE,
        rule: 'missing-pr-head',
        evidence: `GoalId ${goalId}; candidates=1; excluded-by-state=0; PR #6944 has no headRefName; DEFAULT_BRANCH_WORKTREE_BASE`,
      });
    });

    it('records pr-lookup-failed when injected gh throws', async () => {
      const goalId = '4a92772c23611b64';
      const { plan, selection } = await runFileGoal(`Rework goal\n- GoalId: ${goalId}\n\n${CANONICAL_GOAL_FILE}`, () => {
        throw new Error('gh unavailable');
      });

      expect(plan.base).toBe(DEFAULT_BRANCH_WORKTREE_BASE);
      expect(selection).toEqual({
        goalId,
        base: DEFAULT_BRANCH_WORKTREE_BASE,
        rule: 'pr-lookup-failed',
        evidence: `GoalId ${goalId}; PR lookup failed; DEFAULT_BRANCH_WORKTREE_BASE (gh unavailable)`,
      });
    });

    it('announces the selected stacked base then a separate actionable non-default warning before dispatch', async () => {
      const goalId = '4a92772c23611b64';
      const { plan, selection, announcements } = await runFileGoal(`Rework goal\n- GoalId: ${goalId}\n\n${CANONICAL_GOAL_FILE}`, (args) => args[1] === 'list'
        ? '[{"number":6944,"updatedAt":"2026-08-04T01:00:00Z","state":"OPEN"}]'
        : '{"headRefName":"self-impl/first-run"}');

      expect(plan.base).toBe('self-impl/first-run');
      expect(announcements.slice(-2)).toEqual([
        `[dev] base=self-impl/first-run · base-selection=single-pr · evidence=GoalId ${goalId}; candidates=1; excluded-by-state=0; OPEN PR #6944`,
        `⚠️ NON-DEFAULT BASE: this run stacks on self-impl/first-run, not ${DEFAULT_BRANCH_WORKTREE_BASE}. Review the base before treating this run as complete.`,
      ]);
      expect(selection).toEqual({
        goalId,
        base: 'self-impl/first-run',
        rule: 'single-pr',
        evidence: `GoalId ${goalId}; candidates=1; excluded-by-state=0; OPEN PR #6944`,
      });
    });

    it('announces only the unchanged default-base information line when no PR exists', async () => {
      const goalId = '4a92772c23611b64';
      const { announcements } = await runFileGoal(`Rework goal\n- GoalId: ${goalId}\n\n${CANONICAL_GOAL_FILE}`, () => '[]');
      const baseAnnouncements = announcements.filter((line) => line.startsWith('[dev] base=') || line.startsWith('⚠️ NON-DEFAULT BASE:'));

      expect(baseAnnouncements).toEqual([
        `[dev] base=${DEFAULT_BRANCH_WORKTREE_BASE} · base-selection=no-pr · evidence=GoalId ${goalId}; candidates=0; excluded-by-state=0; no open PR; DEFAULT_BRANCH_WORKTREE_BASE`,
      ]);
    });

    it('relaunch with an open PR does not select that PR branch as base', async () => {
      const goalId = '4a92772c23611b64';
      let listed = false;
      let viewed = false;
      const { plan, selection } = await runFileGoal(
        `Rework goal\n- GoalId: ${goalId}\n\n${CANONICAL_GOAL_FILE}`,
        (args) => {
          if (args[1] === 'list') listed = true;
          if (args[1] === 'view') viewed = true;
          return args[1] === 'list'
            ? '[{"number":6944,"updatedAt":"2026-08-04T01:00:00Z","state":"OPEN"}]'
            : '{"headRefName":"self-impl/first-run"}';
        },
        true,
        { relaunch: true },
      );

      expect(listed).toBe(true);
      expect(viewed).toBe(false);
      expect(plan.base).toBe(DEFAULT_BRANCH_WORKTREE_BASE);
      expect(plan.base).not.toBe('self-impl/first-run');
      expect(selection?.base).toBe(DEFAULT_BRANCH_WORKTREE_BASE);
      expect(selection?.base).not.toBe('self-impl/first-run');
      expect(toSelfImplementOptions('goal', plan, {} as SelfImplementSeams)).toMatchObject({
        base: DEFAULT_BRANCH_WORKTREE_BASE, baseSource: 'automatic', baseSelectionRule: RELAUNCH_SKIP_OPEN_PR_RULE,
      });
    });

    it('relaunch with an open PR records a relaunch-only rule name distinct from existing rules', async () => {
      const goalId = '4a92772c23611b64';
      const { plan, selection } = await runFileGoal(
        `Rework goal\n- GoalId: ${goalId}\n\n${CANONICAL_GOAL_FILE}`,
        (args) => args[1] === 'list'
          ? '[{"number":6944,"updatedAt":"2026-08-04T01:00:00Z","state":"OPEN"}]'
          : '{"headRefName":"self-impl/first-run"}',
        true,
        { relaunch: true },
      );

      expect(plan.baseSelection?.rule).toBe(RELAUNCH_SKIP_OPEN_PR_RULE);
      expect(selection?.rule).toBe(RELAUNCH_SKIP_OPEN_PR_RULE);
      expect((EXISTING_BASE_SELECTION_RULES as readonly string[]).includes(RELAUNCH_SKIP_OPEN_PR_RULE)).toBe(false);
      expect(plan.baseSelection?.evidence).toBe(
        `GoalId ${goalId}; candidates=1; excluded-by-state=0; relaunch after previous run; skip OPEN PR as base; DEFAULT_BRANCH_WORKTREE_BASE`,
      );
    });

    it('non-relaunch including unspecified still stacks on the open PR as before', async () => {
      const goalId = '4a92772c23611b64';
      const openPrList = (args: string[]) => args[1] === 'list'
        ? '[{"number":6944,"updatedAt":"2026-08-04T01:00:00Z","state":"OPEN"}]'
        : '{"headRefName":"self-impl/first-run"}';
      const expected = {
        goalId,
        base: 'self-impl/first-run',
        rule: 'single-pr',
        evidence: `GoalId ${goalId}; candidates=1; excluded-by-state=0; OPEN PR #6944`,
      };

      const unspecified = await runFileGoal(`Rework goal\n- GoalId: ${goalId}\n\n${CANONICAL_GOAL_FILE}`, openPrList);
      const disabled = await runFileGoal(
        `Rework goal\n- GoalId: ${goalId}\n\n${CANONICAL_GOAL_FILE}`,
        openPrList,
        true,
        { relaunch: false },
      );

      expect(unspecified.plan).not.toHaveProperty('relaunch');
      expect(unspecified.plan.base).toBe('self-impl/first-run');
      expect(unspecified.plan.baseSelection).toEqual({
        rule: 'single-pr',
        evidence: expected.evidence,
      });
      expect(unspecified.selection).toEqual(expected);
      expect(disabled.plan.relaunch).toBe(false);
      expect(disabled.plan.base).toBe('self-impl/first-run');
      expect(disabled.plan.baseSelection).toEqual({
        rule: 'single-pr',
        evidence: expected.evidence,
      });
      expect(disabled.selection).toEqual({ relaunch: false, ...expected });
    });

    it('relaunch without an open PR keeps the pre-change result and omits the relaunch rule name', async () => {
      const goalId = '4a92772c23611b64';
      const { plan, selection } = await runFileGoal(
        `Rework goal\n- GoalId: ${goalId}\n\n${CANONICAL_GOAL_FILE}`,
        () => '[]',
        true,
        { relaunch: true },
      );

      expect(plan.base).toBe(DEFAULT_BRANCH_WORKTREE_BASE);
      expect(plan.baseSelection).toEqual({
        rule: 'no-pr',
        evidence: `GoalId ${goalId}; candidates=0; excluded-by-state=0; no open PR; DEFAULT_BRANCH_WORKTREE_BASE`,
      });
      expect(selection).toEqual({
        relaunch: true,
        goalId,
        base: DEFAULT_BRANCH_WORKTREE_BASE,
        rule: 'no-pr',
        evidence: `GoalId ${goalId}; candidates=0; excluded-by-state=0; no open PR; DEFAULT_BRANCH_WORKTREE_BASE`,
      });
      expect(plan.baseSelection?.rule).not.toBe(RELAUNCH_SKIP_OPEN_PR_RULE);
      expect(selection?.rule).not.toBe(RELAUNCH_SKIP_OPEN_PR_RULE);
    });

    it('free text or an explicit base still does nothing', async () => {
      let queried = false;
      const refuse = () => {
        queried = true;
        throw new Error('explicit or free-text input must not query gh');
      };

      const freeText = await runDevPipeline(T({ input: { text: '기능 X' }, relaunch: true }), {
        runGh: refuse,
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => selfResult,
      });
      const explicit = await runFileGoal(
        `Rework goal\n- GoalId: 4a92772c23611b64\n\n${CANONICAL_GOAL_FILE}`,
        refuse,
        true,
        { relaunch: true, base: 'release' },
      );

      expect(queried).toBe(false);
      expect(freeText.plan.base).toBeUndefined();
      expect(freeText.plan.baseSelection).toBeUndefined();
      expect(explicit.plan.base).toBe('release');
      expect(explicit.plan.baseSelection).toEqual({ rule: 'explicit', evidence: 'caller --base' });
      expect(explicit.selection).toEqual({
        relaunch: true,
        goalId: '4a92772c23611b64',
        base: 'release',
        rule: 'explicit',
        evidence: 'caller --base',
      });
    });

    it('PR lookup failure keeps the pre-change rule and default base', async () => {
      const goalId = '4a92772c23611b64';
      const { plan, selection } = await runFileGoal(
        `Rework goal\n- GoalId: ${goalId}\n\n${CANONICAL_GOAL_FILE}`,
        () => {
          throw new Error('gh unavailable');
        },
        true,
        { relaunch: true },
      );

      expect(plan.base).toBe(DEFAULT_BRANCH_WORKTREE_BASE);
      expect(plan.baseSelection).toEqual({
        rule: 'pr-lookup-failed',
        evidence: `GoalId ${goalId}; PR lookup failed; DEFAULT_BRANCH_WORKTREE_BASE (gh unavailable)`,
      });
      expect(selection).toEqual({
        relaunch: true,
        goalId,
        base: DEFAULT_BRANCH_WORKTREE_BASE,
        rule: 'pr-lookup-failed',
        evidence: `GoalId ${goalId}; PR lookup failed; DEFAULT_BRANCH_WORKTREE_BASE (gh unavailable)`,
      });
    });

    it('suppresses human announcements in JSON mode while retaining base selection observation', async () => {
      const goalId = '4a92772c23611b64';
      const { plan, selection, announcements } = await runFileGoal(
        `Rework goal\n- GoalId: ${goalId}\n\n${CANONICAL_GOAL_FILE}`,
        (args) => args[1] === 'list'
          ? '[{"number":6944,"updatedAt":"2026-08-04T01:00:00Z","state":"OPEN"}]'
          : '{"headRefName":"self-impl/first-run"}',
        false,
      );

      expect(plan.base).toBe('self-impl/first-run');
      expect(selection).toEqual({
        goalId,
        base: 'self-impl/first-run',
        rule: 'single-pr',
        evidence: `GoalId ${goalId}; candidates=1; excluded-by-state=0; OPEN PR #6944`,
      });
      expect(announcements).toEqual([]);
    });

    it('emits lineage-threshold-needs-human with GoalId, open count, threshold, and PR numbers when two OPEN PRs exist', async () => {
      expect(LINEAGE_OPEN_PR_THRESHOLD).toBe(2);
      const goalId = '4a92772c23611b64';
      const { plan, selection, announcements, events, ok } = await runFileGoal(
        `Rework goal\n- GoalId: ${goalId}\n\n${CANONICAL_GOAL_FILE}`,
        (args) => args[1] === 'list'
          ? '[{"number":7001,"updatedAt":"2026-08-04T01:00:00Z","state":"OPEN"},{"number":7005,"updatedAt":"2026-08-04T05:00:00Z","state":"OPEN"}]'
          : '{"headRefName":"self-impl/newest-open"}',
      );
      const lineage = events.filter((entry) => entry.category === 'dev-pipeline' && entry.event === 'lineage-threshold-needs-human');

      expect(ok).toBe(true);
      expect(plan.base).toBe('self-impl/newest-open');
      expect(plan.baseSelection).toEqual({
        rule: 'latest-pr',
        evidence: `GoalId ${goalId}; candidates=2; excluded-by-state=0; latest updatedAt OPEN PR #7005`,
      });
      expect(selection).toEqual({
        goalId,
        base: 'self-impl/newest-open',
        rule: 'latest-pr',
        evidence: `GoalId ${goalId}; candidates=2; excluded-by-state=0; latest updatedAt OPEN PR #7005`,
      });
      expect(lineage).toHaveLength(1);
      expect(lineage[0]?.data).toEqual({
        goalId,
        openCount: 2,
        threshold: LINEAGE_OPEN_PR_THRESHOLD,
        prNumbers: [7001, 7005],
      });
      expect(announcements.some((line) => line.includes('2 open PRs') && line.includes('#7001') && line.includes('#7005'))).toBe(true);
    });

    it('does not emit lineage-threshold-needs-human when only one OPEN PR exists', async () => {
      const goalId = '4a92772c23611b64';
      const { plan, selection, announcements, events } = await runFileGoal(
        `Rework goal\n- GoalId: ${goalId}\n\n${CANONICAL_GOAL_FILE}`,
        (args) => args[1] === 'list'
          ? '[{"number":6944,"updatedAt":"2026-08-04T01:00:00Z","state":"OPEN"}]'
          : '{"headRefName":"self-impl/first-run"}',
      );
      const lineage = events.filter((entry) => entry.category === 'dev-pipeline' && entry.event === 'lineage-threshold-needs-human');

      expect(plan.base).toBe('self-impl/first-run');
      expect(plan.baseSelection).toEqual({
        rule: 'single-pr',
        evidence: `GoalId ${goalId}; candidates=1; excluded-by-state=0; OPEN PR #6944`,
      });
      expect(selection).toEqual({
        goalId,
        base: 'self-impl/first-run',
        rule: 'single-pr',
        evidence: `GoalId ${goalId}; candidates=1; excluded-by-state=0; OPEN PR #6944`,
      });
      expect(lineage).toEqual([]);
      expect(announcements.some((line) => line.includes('lineage-threshold-needs-human'))).toBe(false);
    });

    it('does not treat a PR lookup failure as zero open PRs and skips the lineage threshold', async () => {
      const goalId = '4a92772c23611b64';
      const { plan, selection, announcements, events } = await runFileGoal(
        `Rework goal\n- GoalId: ${goalId}\n\n${CANONICAL_GOAL_FILE}`,
        () => {
          throw new Error('gh unavailable');
        },
      );
      const lineage = events.filter((entry) => entry.category === 'dev-pipeline' && entry.event === 'lineage-threshold-needs-human');

      expect(plan.base).toBe(DEFAULT_BRANCH_WORKTREE_BASE);
      expect(plan.baseSelection).toEqual({
        rule: 'pr-lookup-failed',
        evidence: `GoalId ${goalId}; PR lookup failed; DEFAULT_BRANCH_WORKTREE_BASE (gh unavailable)`,
      });
      expect(selection).toEqual({
        goalId,
        base: DEFAULT_BRANCH_WORKTREE_BASE,
        rule: 'pr-lookup-failed',
        evidence: `GoalId ${goalId}; PR lookup failed; DEFAULT_BRANCH_WORKTREE_BASE (gh unavailable)`,
      });
      expect(lineage).toEqual([]);
      expect(announcements.some((line) => line.includes('lineage-threshold-needs-human'))).toBe(false);
    });

    it('does not emit lineage-threshold-needs-human when pr view fails after listing two OPEN PRs', async () => {
      const goalId = '4a92772c23611b64';
      const { plan, selection, announcements, events, ok } = await runFileGoal(
        `Rework goal\n- GoalId: ${goalId}\n\n${CANONICAL_GOAL_FILE}`,
        (args) => {
          if (args[1] === 'list') {
            return '[{"number":7001,"updatedAt":"2026-08-04T01:00:00Z","state":"OPEN"},{"number":7005,"updatedAt":"2026-08-04T05:00:00Z","state":"OPEN"}]';
          }
          throw new Error('gh pr view failed');
        },
      );
      const lineage = events.filter((entry) => entry.category === 'dev-pipeline' && entry.event === 'lineage-threshold-needs-human');

      expect(ok).toBe(true);
      expect(plan.base).toBe(DEFAULT_BRANCH_WORKTREE_BASE);
      expect(plan.baseSelection).toEqual({
        rule: 'pr-lookup-failed',
        evidence: `GoalId ${goalId}; PR lookup failed; DEFAULT_BRANCH_WORKTREE_BASE (gh pr view failed)`,
      });
      expect(selection).toEqual({
        goalId,
        base: DEFAULT_BRANCH_WORKTREE_BASE,
        rule: 'pr-lookup-failed',
        evidence: `GoalId ${goalId}; PR lookup failed; DEFAULT_BRANCH_WORKTREE_BASE (gh pr view failed)`,
      });
      expect(lineage).toEqual([]);
      expect(announcements.some((line) => line.includes('lineage-threshold-needs-human'))).toBe(false);
    });

    it('does not emit the human lineage line below the threshold even if a caller looks for it', async () => {
      const goalId = '4a92772c23611b64';
      const { announcements, events } = await runFileGoal(
        `Rework goal\n- GoalId: ${goalId}\n\n${CANONICAL_GOAL_FILE}`,
        (args) => args[1] === 'list'
          ? '[{"number":6944,"updatedAt":"2026-08-04T01:00:00Z","state":"OPEN"}]'
          : '{"headRefName":"self-impl/first-run"}',
      );
      const humanLineage = announcements.filter((line) => line.includes('lineage-threshold-needs-human'));
      const observed = events.filter((entry) => entry.event === 'lineage-threshold-needs-human');

      expect(humanLineage).toEqual([]);
      expect(observed).toEqual([]);
    });

    it('reuses the already-fetched OPEN PR list and does not add a gh call for the lineage notice', async () => {
      const goalId = '4a92772c23611b64';
      const calls: string[][] = [];
      await runFileGoal(
        `Rework goal\n- GoalId: ${goalId}\n\n${CANONICAL_GOAL_FILE}`,
        (args) => {
          calls.push(args);
          return args[1] === 'list'
            ? '[{"number":7001,"updatedAt":"2026-08-04T01:00:00Z","state":"OPEN"},{"number":7005,"updatedAt":"2026-08-04T05:00:00Z","state":"OPEN"}]'
            : '{"headRefName":"self-impl/newest-open"}';
        },
      );

      expect(calls).toEqual([
        ['pr', 'list', '--state', 'all', '--search', goalId, '--limit', '100', '--json', 'number,updatedAt,state'],
        ['pr', 'view', '7005', '--json', 'headRefName'],
      ]);
      expect(calls.every((args) => args[0] === 'pr' && (args[1] === 'list' || args[1] === 'view'))).toBe(true);
      expect(calls.some((args) => args[1] === 'close' || args.includes('--draft'))).toBe(false);
    });
  });

  it('elanous-tui → injected runPtyDrive로 goal과 옵션을 손실 없이 전달한다', async () => {
    let got: import('../cli/pty-drive-cli.js').PtyDriveOpts | undefined;
    const elanous: DevElanousTuiOpts = { goal: 'child goal', maxSteps: 9, pollMs: 0, model: 'brain', isolatedRoot: '/iso', cwd: '/cwd' };
    const r = await runDevPipeline(T({ elanous }), { runPtyDrive: async (opts) => { got = opts; return { exitCode: 0 }; } });
    expect(r.kind).toBe('elanous-tui');
    expect(got).toEqual({ elanous: true, ...elanous });
    expect(devResultOk(r)).toBe(true);
  });

  it('elanous-tui completion:pr은 미배선을 명시 거부한다', async () => {
    await expect(runDevPipeline(T({ elanous: { goal: 'x' }, completion: 'pr' }), { runPtyDrive: async () => ({ exitCode: 0 }) }))
      .rejects.toThrow(/NotYetUnified.*completion:pr/);
  });

  it('elanous-tui 기본 실행은 격리 root를 만들지 못하면 fail-closed로 중단한다', async () => {
    await expect(runDevPipeline(T({ elanous: { goal: 'x', cwd: process.cwd(), isolatedRoot: '/dev/null/dev-pipeline-elanous-root' } })))
      .rejects.toThrow(/cannot establish isolated elanous TUI root/);
  });

  it('agent-mission-pty → runAgentMission 호출(backend resolve)', async () => {
    let mission: string | undefined;
    const deps: DevPipelineDeps = {
      runAgentMission: async (s) => { mission = s.mission; return missionResult; },
      resolveBackend: () => ({ name: 'codex', cmd: 'codex', args: ['--yolo'] }),
    };
    const r = await runDevPipeline(T({ input: { text: '외부 미션' }, executor: { kind: 'external', backend: 'codex' }, branch: 'wt/z' }), deps);
    expect(r.kind).toBe('agent-mission');
    expect(mission).toBe('외부 미션');
  });

  const validGoalFile = `## PROBLEM\nproblem\n\n## WHAT TO BUILD\nbuild\n\n## ACCEPTANCE CRITERIA\ncriteria\n\n## REQUIRED EVIDENCE\n- [launch] child launch proof\n\n## TRACED PATHS\npaths\n\n## SCOPE BOUNDARY\nboundary\n\n## 답하지 못하는 것\nlimits\n\n## 불변식\nkeep\n\n## 판정 신호\nsignals`;
  const persistentChannelEvidenceUnavailable = 'Evidence unavailable — grounding found 1 categorized evidence items, but no persistent evidence; only the persistent channel is empty. Strengthening the ask\'s prose may not resolve this channel gap; inspect or restore persistent grounding evidence instead. See docs/manual/MANUAL-goal-authoring-method-2026-08-03.md';

  it('input {file} → 여섯 축 lint 후 저작기와 같은 증거 위치 계약을 디스패치에 전달', async () => {
    let got: string | undefined;
    const deps: DevPipelineDeps = {
      runSelfImplement: async (o) => { got = o.feature; return selfResult; },
      buildSelfImplementSeams: () => ({} as SelfImplementSeams),
      readFile: (p) => { expect(p).toBe('/mission.md'); return validGoalFile; },
    };
    await runDevPipeline(T({ input: { file: '/mission.md' } }), deps);
    expect(got).toBe(`${validGoalFile}\n\nFor every acceptance criterion, state where evidence that it was met appears in the diff or which line of the report shows it. Evidence visible only on an execution screen and left in neither the diff nor the report is not evidence.`);
  });

  it('파일 골의 REQUIRED EVIDENCE 절 누락 또는 빈 태그는 자식 발사 전에 거부하고 복구 경로를 말한다', async () => {
    for (const feature of ['골 본문', '골 본문\n## REQUIRED EVIDENCE\n- [tag]']) {
      let launched = false;
      await expect(runDevPipeline(T({ input: { file: '/invalid-goal.txt' } }), {
        readFile: () => feature,
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => { launched = true; return selfResult; },
      })).rejects.toThrow(/grounding found 0 categorized evidence items, but no persistent evidence; only the persistent channel is empty.*inspect or restore persistent grounding evidence instead.*## REQUIRED EVIDENCE 절에 채울 수 있는 - \[태그\] 설명 항목이 없습니다.*## REQUIRED EVIDENCE.*- \[태그\] 설명.*우회: --allow-no-evidence/);
      expect(launched).toBe(false);
    }
  });

  it('--allow-no-evidence는 기존 evidence 우회를 관측하며, lint ERROR는 별도 명시 우회 없이는 계속 거부한다', async () => {
    const noEvidenceGoal = validGoalFile.replace('- [launch] child launch proof\n', '');
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    let launched = false;
    try {
      await expect(runDevPipeline(T({ input: { file: '/no-evidence-goal.txt' }, allowNoEvidence: true }), {
        readFile: () => noEvidenceGoal,
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => { launched = true; return selfResult; },
      })).rejects.toThrow('ERROR [evidence-section]');
      expect(launched).toBe(false);
      expect(log).toHaveBeenCalledWith('dev-pipeline', 'goal-file-evidence-bypassed', {
        file: '/no-evidence-goal.txt', requiredCount: 0,
      });
    } finally {
      log.mockRestore();
    }
  });

  it('ERROR 없는 파일 골은 기존 self child를 발사하고 텍스트 입력은 사전검사를 건너뛴다', async () => {
    let fileLaunched = false;
    await runDevPipeline(T({ input: { file: '/valid-goal.txt' } }), {
      readFile: () => validGoalFile,
      buildSelfImplementSeams: () => ({} as SelfImplementSeams),
      runSelfImplement: async () => { fileLaunched = true; return selfResult; },
    });
    expect(fileLaunched).toBe(true);

    let textLaunched = false;
    await runDevPipeline(T({ input: { text: '텍스트 골' } }), {
      buildSelfImplementSeams: () => ({} as SelfImplementSeams),
      runSelfImplement: async () => { textLaunched = true; return selfResult; },
    });
    expect(textLaunched).toBe(true);
  });

  it('Superseded-By가 공용 머리말 범위의 첫 줄 또는 뒤 줄에 있으면 후속 경로를 말하고 자식 발사 전에 거부한다', async () => {
    for (const [label, document] of [
      ['first', `Superseded goal\n- Superseded-By: docs/goals/GOAL-first.txt\n- GoalId: 0123456789abcdef\n\n${validGoalFile}`],
      ['later', `Superseded goal\n- GoalId: 0123456789abcdef\n- Superseded-By: docs/goals/GOAL-later.txt\n\n${validGoalFile}`],
    ]) {
      let launched = false;
      const successor = label === 'first' ? 'docs/goals/GOAL-first.txt' : 'docs/goals/GOAL-later.txt';
      await expect(runDevPipeline(T({ input: { file: `/superseded-${label}-goal.txt` } }), {
        readFile: () => document,
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => { launched = true; return selfResult; },
      })).rejects.toThrow(successor);
      expect(launched).toBe(false);
    }
  });

  it('--allow-superseded-goal은 Superseded-By 관문만 우회하고 관측을 남긴다', async () => {
    let launched = false;
    const successor = 'docs/goals/GOAL-current.txt';
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      await runDevPipeline(T({ input: { file: '/superseded-goal.txt' }, allowSupersededGoal: true }), {
        readFile: () => `Superseded goal\n- Superseded-By: ${successor}\n\n${validGoalFile}`,
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => { launched = true; return selfResult; },
      });
      expect(launched).toBe(true);
      expect(log).toHaveBeenCalledWith('dev-pipeline', 'superseded-goal-file-bypassed', {
        file: '/superseded-goal.txt', successor,
      });
    } finally {
      log.mockRestore();
    }
  });

  it('본문 예시의 Superseded-By 줄은 정상 파일 골 발사를 막지 않는다', async () => {
    let launched = false;
    await runDevPipeline(T({ input: { file: '/current-goal.txt' } }), {
      readFile: () => `${validGoalFile}\n\nExample:\n- Superseded-By: docs/goals/GOAL-example.txt`,
      buildSelfImplementSeams: () => ({} as SelfImplementSeams),
      runSelfImplement: async () => { launched = true; return selfResult; },
    });
    expect(launched).toBe(true);
  });

  it('lint ERROR 파일은 자식 발사 전에 formatter 진단으로 거부한다', async () => {
    let launched = false;
    await expect(runDevPipeline(T({ input: { file: '/invalid-lint-goal.txt' } }), {
      readFile: () => validGoalFile.replace('## PROBLEM', '## BROKEN'),
      buildSelfImplementSeams: () => ({} as SelfImplementSeams),
      runSelfImplement: async () => { launched = true; return selfResult; },
    })).rejects.toThrow('ERROR [canonical-structure] missing required section: ## PROBLEM');
    expect(launched).toBe(false);
  });

  it('records ask-section relationship detail through the existing warning checks collection', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const askSectionGoal = validGoalFile.replace('## WHAT TO BUILD\nbuild', '## WHAT TO BUILD\nOriginal ask (verbatim, unmodified):\n```\n경계: 유지 범위\n```');
    try {
      await runDevPipeline(T({ input: { file: '/ask-section-goal.txt' } }), {
        readFile: () => askSectionGoal,
        branch: () => 'main',
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => selfResult,
      });
      expect(log).toHaveBeenCalledWith('dev-pipeline', 'goal-file-lint-warned', expect.objectContaining({
        file: '/ask-section-goal.txt',
        tags: expect.arrayContaining(['canonical-structure']),
        checks: expect.arrayContaining(['ask-section-relationship']),
      }));
    } finally {
      log.mockRestore();
    }
  });

  it('records canonical check detail with the existing tag when a structural lint rejects launch', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      await expect(runDevPipeline(T({ input: { file: '/invalid-goal-type.txt' } }), {
        readFile: () => validGoalFile.replace('## PROBLEM', '## BROKEN'),
        branch: () => 'main',
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => selfResult,
      })).rejects.toThrow('ERROR [canonical-structure] missing required section: ## PROBLEM');
      expect(log).toHaveBeenCalledWith('dev-pipeline', 'goal-file-lint-rejected', expect.objectContaining({
        file: '/invalid-goal-type.txt',
        tags: expect.arrayContaining(['canonical-structure']),
        checks: expect.arrayContaining(['missing-required-section']),
      }));
    } finally {
      log.mockRestore();
    }
  });

  it('grounding-evidence ERROR만 있으면 기존 표지로 셀 수 있는 비차단 관측을 남기고 자식을 발사한다', async () => {
    let launched = false;
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const groundingEvidenceGoal = validGoalFile.replace('## TRACED PATHS\npaths', `## TRACED PATHS\n- ${persistentChannelEvidenceUnavailable}`);
    try {
      await runDevPipeline(T({ input: { file: '/grounding-evidence-goal.txt' } }), {
        readFile: () => groundingEvidenceGoal,
        branch: () => 'main',
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => { launched = true; return selfResult; },
      });
      expect(launched).toBe(true);
      expect(log).toHaveBeenCalledWith('dev-pipeline', 'goal-file-lint-non-blocking', {
        file: '/grounding-evidence-goal.txt', errorCount: 1, tags: ['grounding-evidence'], checks: [],
      });
    } finally {
      log.mockRestore();
    }
  });

  it('grounding-evidence와 traced-path ERROR가 함께 있으면 모든 표지를 남기고 계속 거부한다', async () => {
    let launched = false;
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const mixedErrorGoal = validGoalFile.replace('## TRACED PATHS\npaths', `## TRACED PATHS\n- ${persistentChannelEvidenceUnavailable}\n- src/outside.ts — traced`);
    try {
      await expect(runDevPipeline(T({ input: { file: '/mixed-lint-goal.txt' } }), {
        cwd: '/repository-root',
        readFile: () => mixedErrorGoal,
        branch: () => 'main',
        readReferencedFile: () => ({ kind: 'outside-repository' }),
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => { launched = true; return selfResult; },
      })).rejects.toThrow('ERROR [traced-path] traced path is outside repository: src/outside.ts');
      expect(launched).toBe(false);
      expect(log).toHaveBeenCalledWith('dev-pipeline', 'goal-file-lint-rejected', {
        file: '/mixed-lint-goal.txt', errorCount: 2, tags: ['grounding-evidence', 'traced-path'], checks: [],
      });
    } finally {
      log.mockRestore();
    }
  });

  it('lint 경계는 branch와 repository reader 주입을 전달하고 traced-path ERROR에서 자식 발사를 막는다', async () => {
    let launched = false;
    let branchCwd: string | undefined;
    const readPaths: string[] = [];
    const tracedPathGoal = validGoalFile.replace('## TRACED PATHS\npaths', '## TRACED PATHS\n- src/outside.ts — traced');

    await expect(runDevPipeline(T({ input: { file: '/traced-path-goal.txt' } }), {
      cwd: '/repository-root',
      readFile: () => tracedPathGoal,
      branch: (cwd) => { branchCwd = cwd; return 'feature/lint-boundary'; },
      readReferencedFile: (path) => {
        readPaths.push(path);
        return { kind: 'outside-repository' };
      },
      buildSelfImplementSeams: () => ({} as SelfImplementSeams),
      runSelfImplement: async () => { launched = true; return selfResult; },
    })).rejects.toThrow('ERROR [traced-path] traced path is outside repository: src/outside.ts');

    expect(branchCwd).toBe('/repository-root');
    expect(readPaths).toEqual(['src/outside.ts']);
    expect(launched).toBe(false);
  });

  it('WARN-only lint findings leave launch non-blocking and emit compact warning telemetry', async () => {
    let launched = false;
    const stderr: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const write = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      await runDevPipeline(T({ input: { file: '/warn-goal.txt' } }), {
        readFile: () => validGoalFile.replace('## SCOPE BOUNDARY\nshort', '## SCOPE BOUNDARY\n- Boundary decision: one'),
        branch: () => 'feature/warn',
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => { launched = true; return selfResult; },
      });
      expect(launched).toBe(true);
      expect(stderr).toEqual([
        '[dev] goal-file-lint: 1 WARN finding(s) for /warn-goal.txt\n',
        expectedGoalFileLintStderrLine('WARN', 'launch-branch', 'current branch is feature/warn, not main'),
        '[dev] goal-file-markers: 0 recognized invariant(s), 0 UNVERIFIABLE invariant candidate(s), 0 grounding file(s) not mentioned in ask, 0 UNANSWERED clarification(s), decision signal: no-marker for /warn-goal.txt\n',
        '[dev] goal-file-type: implement; dispatch: self-mission for /warn-goal.txt\n',
      ]);
      expect(log).toHaveBeenCalledWith('dev-pipeline', 'goal-file-lint-warned', {
        file: '/warn-goal.txt', warningCount: 1, tags: ['launch-branch'], checks: [], branchKnown: true, recognizedInvariantCount: 0,
      });
      expect(log).toHaveBeenCalledWith('dev-pipeline', 'goal-file-lint-observed', {
        file: '/warn-goal.txt',
        warningCount: 1,
        recognizedInvariantCount: 0,
        prohibitionSymbolStartingLineCount: 0,
        permissionSymbolStartingLineCount: 0,
        mixedSymbolLineCount: 0,
        exhaustiveRequestWordingCount: 0,
        blanketBehaviorPreservationCount: 0,
        namedPreservationTargetCount: 0,
        removalFormDecisionConditionCount: 0,
        checks: [],
        branchKnown: true,
      });
    } finally {
      write.mockRestore();
      log.mockRestore();
    }
  });

  it('zero-WARN goal files explicitly report a zero finding count to stderr', async () => {
    const stderr: string[] = [];
    const write = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      await runDevPipeline(T({ input: { file: '/clean-goal.txt' } }), {
        readFile: () => validGoalFile,
        branch: () => 'main',
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => selfResult,
      });
      expect(stderr).toEqual([
        '[dev] goal-file-lint: 0 WARN finding(s) for /clean-goal.txt\n',
        '[dev] goal-file-markers: 0 recognized invariant(s), 0 UNVERIFIABLE invariant candidate(s), 0 grounding file(s) not mentioned in ask, 0 UNANSWERED clarification(s), decision signal: no-marker for /clean-goal.txt\n',
        '[dev] goal-file-type: implement; dispatch: self-mission for /clean-goal.txt\n',
      ]);
    } finally {
      write.mockRestore();
    }
  });

  it('manual goal with invariant-looking lines but no Original ask block warns without blocking launch and keeps the existing marker line', async () => {
    let launched = false;
    const stderr: string[] = [];
    const write = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const manualGoal = `${validGoalFile}\n\n불변식: src/self-implement/goal-author.ts 를 바꾸지 않는다\n불변식: 경고가 발사를 막지 않는다`;
    try {
      await runDevPipeline(T({ input: { file: '/manual-invariant-goal.txt' } }), {
        readFile: () => manualGoal,
        branch: () => 'main',
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => { launched = true; return selfResult; },
      });
      expect(launched).toBe(true);
      expect(stderr).toEqual([
        '[dev] goal-file-lint: 0 WARN finding(s) for /manual-invariant-goal.txt\n',
        '[dev] goal-file-markers: 0 recognized invariant(s), 0 UNVERIFIABLE invariant candidate(s), 0 grounding file(s) not mentioned in ask, 0 UNANSWERED clarification(s), decision signal: no-marker for /manual-invariant-goal.txt\n',
        '[dev] goal-file-markers: warning: 0 recognized invariant(s), but 2 invariant-looking line(s) appear in the goal file; not counted because recognized invariant candidates are counted only inside the Original ask block, but this goal file has no Original ask block. Launch continues.\n',
        '[dev] goal-file-type: implement; dispatch: self-mission for /manual-invariant-goal.txt\n',
      ]);
    } finally {
      write.mockRestore();
    }
  });

  it('manual goal with Original ask header still warns when invariant-looking lines are outside that block', async () => {
    let launched = false;
    const stderr: string[] = [];
    const write = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const authoredHeaderButOutsideInvariantGoal = validGoalFile.replace(
      '## WHAT TO BUILD\nbuild',
      '## WHAT TO BUILD\nOriginal ask (verbatim, unmodified):\n```\n## 불변식\n- src/heading.ts remains unchanged.\n```',
    ) + '\n\n불변식: src/self-implement/goal-author.ts 를 바꾸지 않는다';
    try {
      await runDevPipeline(T({ input: { file: '/outside-original-ask-invariant-goal.txt' } }), {
        readFile: () => authoredHeaderButOutsideInvariantGoal,
        branch: () => 'main',
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => { launched = true; return selfResult; },
      });
      expect(launched).toBe(true);
      expect(stderr).toEqual([
        '[dev] goal-file-lint: 1 WARN finding(s) for /outside-original-ask-invariant-goal.txt\n',
        expectedGoalFileLintStderrLine('WARN', 'heading-form-marker', 'Ask uses a heading-form invariant; headings are diagnostic only and do not create a invariant candidate. source="## 불변식\\n- src/heading.ts remains unchanged." truncated=false; corrected example: 불변식: src/example.ts remains unchanged.'),
        '[dev] goal-file-markers: 0 recognized invariant(s), heading-form marker label(s): 불변식, 0 UNVERIFIABLE invariant candidate(s), 0 grounding file(s) not mentioned in ask, 0 UNANSWERED clarification(s), decision signal: no-marker for /outside-original-ask-invariant-goal.txt\n',
        '[dev] goal-file-markers: warning: 0 recognized invariant(s), but 1 invariant-looking line(s) appear in the goal file; not counted because 1 invariant-looking line(s) are outside the Original ask block, so they are not counted as judgment candidates. Launch continues.\n',
        '[dev] goal-file-type: implement; dispatch: self-mission for /outside-original-ask-invariant-goal.txt\n',
      ]);
    } finally {
      write.mockRestore();
    }
  });

  it('zero-contract warning separates outside Original ask lines from inside-block parser misses', async () => {
    let launched = false;
    const stderr: string[] = [];
    const write = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const mixedInvariantGoal = validGoalFile.replace(
      '## WHAT TO BUILD\nbuild',
      '## WHAT TO BUILD\nOriginal ask (verbatim, unmodified):\n```\nInvariant: English-looking line is not parser-recognized.\n```',
    ) + '\n\n불변식: src/self-implement/goal-author.ts 를 바꾸지 않는다';
    try {
      await runDevPipeline(T({ input: { file: '/mixed-zero-contract-goal.txt' } }), {
        readFile: () => mixedInvariantGoal,
        branch: () => 'main',
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => { launched = true; return selfResult; },
      });
      expect(launched).toBe(true);
      expect(stderr).toEqual([
        '[dev] goal-file-lint: 0 WARN finding(s) for /mixed-zero-contract-goal.txt\n',
        '[dev] goal-file-markers: 0 recognized invariant(s), 0 UNVERIFIABLE invariant candidate(s), 0 grounding file(s) not mentioned in ask, 0 UNANSWERED clarification(s), decision signal: no-marker for /mixed-zero-contract-goal.txt\n',
        '[dev] goal-file-markers: warning: 0 recognized invariant(s), but 2 invariant-looking line(s) appear in the goal file; not counted because 1 invariant-looking line(s) are outside the Original ask block, so they are not counted as judgment candidates; 1 invariant-looking line(s) are inside the Original ask block but did not match the parser-recognized invariant syntax. Launch continues.\n',
        '[dev] goal-file-type: implement; dispatch: self-mission for /mixed-zero-contract-goal.txt\n',
      ]);
    } finally {
      write.mockRestore();
    }
  });

  it('does not emit the zero-contract warning when invariant-looking lines are absent or already recognized inside Original ask', async () => {
    const cases = [
      { file: '/quiet-no-invariant-goal.txt', goal: validGoalFile, expectedMarker: '[dev] goal-file-markers: 0 recognized invariant(s), 0 UNVERIFIABLE invariant candidate(s), 0 grounding file(s) not mentioned in ask, 0 UNANSWERED clarification(s), decision signal: no-marker for /quiet-no-invariant-goal.txt\n' },
      {
        file: '/recognized-original-ask-invariant-goal.txt',
        goal: validGoalFile.replace('## WHAT TO BUILD\nbuild', '## WHAT TO BUILD\nOriginal ask (verbatim, unmodified):\n```\n불변식: src/inside.ts remains unchanged.\n```'),
        expectedMarker: '[dev] goal-file-markers: 1 recognized invariant(s), 0 UNVERIFIABLE invariant candidate(s), 0 grounding file(s) not mentioned in ask, 0 UNANSWERED clarification(s), decision signal: no-marker for /recognized-original-ask-invariant-goal.txt\n',
      },
    ];
    for (const { file, goal, expectedMarker } of cases) {
      let launched = false;
      const stderr: string[] = [];
      const write = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
      try {
        await runDevPipeline(T({ input: { file } }), {
          readFile: () => goal,
          branch: () => 'main',
          buildSelfImplementSeams: () => ({} as SelfImplementSeams),
          runSelfImplement: async () => { launched = true; return selfResult; },
        });
        expect(launched).toBe(true);
        expect(stderr).toContain(expectedMarker);
        expect(stderr.some((line) => line.includes('goal-file-markers: warning: 0 recognized invariant(s)'))).toBe(false);
      } finally {
        write.mockRestore();
      }
    }
  });

  it('goal type and resolved dispatch diagnostics report research and missing metadata without blocking either launch', async () => {
    const cases = [
      { file: '/research-goal.txt', goal: `Goal title\n- GoalType: research\n\n${validGoalFile.replace('## TRACED PATHS\npaths\n\n', '')}`, expectedType: 'research' },
      { file: '/default-goal.txt', goal: validGoalFile, expectedType: 'implement' },
    ];

    for (const { file, goal, expectedType } of cases) {
      let launched = false;
      const stderr: string[] = [];
      const write = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
      try {
        await runDevPipeline(T({ input: { file } }), {
          readFile: () => goal,
          branch: () => 'main',
          buildSelfImplementSeams: () => ({} as SelfImplementSeams),
          runSelfImplement: async () => { launched = true; return selfResult; },
        });
        expect(launched).toBe(true);
        expect(stderr).toContain(`[dev] goal-file-type: ${expectedType}; dispatch: self-mission for ${file}\n`);
      } finally {
        write.mockRestore();
      }
    }
  });

  it('unreadable GoalType is diagnosed before the existing lint rejection', async () => {
    const stderr: string[] = [];
    const write = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      await expect(runDevPipeline(T({ input: { file: '/unreadable-goal.txt' } }), {
        readFile: () => `Goal title\n- GoalType: invalid\n\n${validGoalFile}`,
        branch: () => 'main',
      })).rejects.toThrow('GoalType must be one of: implement, research, document, operate');
      expect(stderr).toContain('[dev] goal-file-type: unreadable; dispatch: self-mission for /unreadable-goal.txt\n');
    } finally {
      write.mockRestore();
    }
  });

  it('reports parser-recognized inline invariant counts separately from heading-only warnings without blocking launch', async () => {
    const cases = [
      { file: '/heading-only-goal.txt', ask: '## 불변식\n- src/heading.ts remains unchanged.', count: 0, warnings: 1, headingFormLabels: ['불변식'] },
      { file: '/inline-goal.txt', ask: '불변식: src/one.ts remains unchanged.\n불변식: src/two.ts remains unchanged.', count: 2, warnings: 1, headingFormLabels: [] },
    ];
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      for (const { file, ask, count, warnings, headingFormLabels } of cases) {
        let launched = false;
        const stderr: string[] = [];
        const write = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
          stderr.push(String(chunk));
          return true;
        });
        try {
          await runDevPipeline(T({ input: { file } }), {
            readFile: () => validGoalFile.replace('## WHAT TO BUILD\nbuild', ['## WHAT TO BUILD', 'Original ask (verbatim, unmodified):', '````', ask, '````'].join('\n')),
            branch: () => 'main',
            buildSelfImplementSeams: () => ({} as SelfImplementSeams),
            runSelfImplement: async () => { launched = true; return selfResult; },
          });
          expect(launched).toBe(true);
          const headingFormDiagnostic = headingFormLabels.length ? `, heading-form marker label(s): ${headingFormLabels.join(', ')}` : '';
          expect(stderr).toContain(`[dev] goal-file-markers: ${count} recognized invariant(s)${headingFormDiagnostic}, 0 UNVERIFIABLE invariant candidate(s), 0 grounding file(s) not mentioned in ask, 0 UNANSWERED clarification(s), decision signal: no-marker for ${file}\n`);
          expect(log).toHaveBeenCalledWith('dev-pipeline', 'goal-file-marker-counts', {
            file,
            recognizedInvariantCount: count,
            headingFormMarkerLabels: headingFormLabels,
            unverifiableInvariantCandidates: 0,
            unverifiableInvariantCandidateReasons: {},
            groundingFilesNotMentionedInAsk: 0,
            unansweredClarifications: 0,
            decisionSignalStatus: 'no-marker',
          });
          expect(log).toHaveBeenCalledWith('dev-pipeline', 'goal-file-lint-observed', {
            file,
            warningCount: warnings,
            recognizedInvariantCount: count,
            prohibitionSymbolStartingLineCount: 0,
            permissionSymbolStartingLineCount: 0,
            mixedSymbolLineCount: 0,
            exhaustiveRequestWordingCount: 0,
            blanketBehaviorPreservationCount: 0,
            namedPreservationTargetCount: 0,
            removalFormDecisionConditionCount: 0,
            checks: count === 0 ? [] : ['ask-section-relationship'],
            branchKnown: true,
          });
          if (warnings) {
            expect(log).toHaveBeenCalledWith('dev-pipeline', 'goal-file-lint-warned', {
              file, warningCount: warnings, tags: count === 0 ? ['heading-form-marker'] : ['canonical-structure'], checks: count === 0 ? [] : ['ask-section-relationship'], branchKnown: true, recognizedInvariantCount: count,
            });
          }
        } finally {
          write.mockRestore();
        }
      }
    } finally {
      log.mockRestore();
    }
  });

  it('carries lint symbol-starting-line counts into goal-file-lint-observed telemetry', async () => {
    const cases = [
      {
        file: '/symbol-counts-zero.txt',
        goal: validGoalFile,
        expected: {
          prohibitionSymbolStartingLineCount: 0, permissionSymbolStartingLineCount: 0, mixedSymbolLineCount: 0, recognizedInvariantCount: 0,
          exhaustiveRequestWordingCount: 0, blanketBehaviorPreservationCount: 0, namedPreservationTargetCount: 0, removalFormDecisionConditionCount: 0,
        },
      },
      {
        file: '/symbol-counts-distinct.txt',
        goal: `${validGoalFile}\n⛔ prohibition one\n⛔ prohibition two\n✅ permission\n⛔ mixed ✅`,
        expected: {
          prohibitionSymbolStartingLineCount: 2, permissionSymbolStartingLineCount: 1, mixedSymbolLineCount: 1, recognizedInvariantCount: 0,
          exhaustiveRequestWordingCount: 0, blanketBehaviorPreservationCount: 0, namedPreservationTargetCount: 0, removalFormDecisionConditionCount: 0,
        },
      },
      {
        file: '/symbol-counts-invariant.txt',
        goal: validGoalFile.replace('## WHAT TO BUILD\nbuild', '## WHAT TO BUILD\nOriginal ask (verbatim, unmodified):\n```\n불변식: src/retained.ts remains unchanged.\n```'),
        expected: {
          prohibitionSymbolStartingLineCount: 0, permissionSymbolStartingLineCount: 0, mixedSymbolLineCount: 0, recognizedInvariantCount: 1,
          exhaustiveRequestWordingCount: 0, blanketBehaviorPreservationCount: 0, namedPreservationTargetCount: 0, removalFormDecisionConditionCount: 0,
        },
      },
      {
        file: '/author-known-shape-counts.txt',
        goal: validGoalFile.replace('## WHAT TO BUILD\nbuild', '## WHAT TO BUILD\nOriginal ask (verbatim, unmodified):\n```\n전수로 모두 찾고 빠짐없이 확인한다.\n불변식: 모든 행동을 바꾸지 않는다.\n불변식: `src/retained.ts`의 행동을 유지한다.\n판정 신호: 조건 = 캐시를 제거한 뒤 부른다; 관측 = 반환; 기대 = 유지된다\n```'),
        expected: {
          prohibitionSymbolStartingLineCount: 0, permissionSymbolStartingLineCount: 0, mixedSymbolLineCount: 0, recognizedInvariantCount: 2,
          exhaustiveRequestWordingCount: 3, blanketBehaviorPreservationCount: 1, namedPreservationTargetCount: 1, removalFormDecisionConditionCount: 1,
        },
      },
    ];
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      for (const { file, goal, expected } of cases) {
        await runDevPipeline(T({ input: { file } }), {
          readFile: () => goal,
          branch: () => 'main',
          buildSelfImplementSeams: () => ({} as SelfImplementSeams),
          runSelfImplement: async () => selfResult,
        });
        expect(log).toHaveBeenCalledWith('dev-pipeline', 'goal-file-lint-observed', expect.objectContaining({
          file,
          recognizedInvariantCount: expected.recognizedInvariantCount,
          prohibitionSymbolStartingLineCount: expected.prohibitionSymbolStartingLineCount,
          permissionSymbolStartingLineCount: expected.permissionSymbolStartingLineCount,
          mixedSymbolLineCount: expected.mixedSymbolLineCount,
          exhaustiveRequestWordingCount: expected.exhaustiveRequestWordingCount,
          blanketBehaviorPreservationCount: expected.blanketBehaviorPreservationCount,
          namedPreservationTargetCount: expected.namedPreservationTargetCount,
          removalFormDecisionConditionCount: expected.removalFormDecisionConditionCount,
        }));
      }
    } finally {
      log.mockRestore();
    }
  });

  it('goal body marker counts mirror stderr diagnostics to the debug store without gating launch', async () => {
    let launched = false;
    const stderr: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const write = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const markedGoal = `${validGoalFile}\n\n## 불변식\n- Invariant candidate: preserve ungrounded behavior\n  - UNVERIFIABLE: no grounded path\n- Invariant candidate: preserve another ungrounded behavior\n  - UNVERIFIABLE: missing fixture\n- Invariant candidate: preserve repeated ungrounded behavior\n  - UNVERIFIABLE: no grounded path\n\n- Grounding files not mentioned in ask (2): \`src/a.ts\`, \`src/b.ts\`\n\n## Clarification\n- Answer: UNANSWERED — launch-marker-counts`;
    try {
      await runDevPipeline(T({ input: { file: '/marked-goal.txt' } }), {
        readFile: () => markedGoal,
        branch: () => 'main',
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => { launched = true; return selfResult; },
      });
      expect(launched).toBe(true);
      expect(stderr).toEqual([
        '[dev] goal-file-lint: 0 WARN finding(s) for /marked-goal.txt\n',
        '[dev] goal-file-markers: 0 recognized invariant(s), 3 UNVERIFIABLE invariant candidate(s) (no grounded path: 2, missing fixture: 1), 2 grounding file(s) not mentioned in ask, 0 UNANSWERED clarification(s), decision signal: no-marker for /marked-goal.txt\n',
        '[dev] goal-file-type: implement; dispatch: self-mission for /marked-goal.txt\n',
      ]);
      expect(log).toHaveBeenCalledWith('dev-pipeline', 'goal-file-marker-counts', {
        file: '/marked-goal.txt',
        recognizedInvariantCount: 0,
        headingFormMarkerLabels: [],
        unverifiableInvariantCandidates: 3,
        unverifiableInvariantCandidateReasons: { 'no grounded path': 2, 'missing fixture': 1 },
        groundingFilesNotMentionedInAsk: 2,
        unansweredClarifications: 0,
        decisionSignalStatus: 'no-marker',
      });
      expect(log).toHaveBeenCalledWith('dev-pipeline', 'goal-file-lint-observed', {
        file: '/marked-goal.txt',
        warningCount: 0,
        recognizedInvariantCount: 0,
        prohibitionSymbolStartingLineCount: 0,
        permissionSymbolStartingLineCount: 0,
        mixedSymbolLineCount: 0,
        exhaustiveRequestWordingCount: 0,
        blanketBehaviorPreservationCount: 0,
        namedPreservationTargetCount: 0,
        removalFormDecisionConditionCount: 0,
        checks: [],
        branchKnown: true,
      });
      expect(log).toHaveBeenCalledWith('dev-pipeline', 'goal-file-type-dispatch', {
        file: '/marked-goal.txt', goalType: 'implement', dispatch: 'self-mission',
      });
    } finally {
      write.mockRestore();
      log.mockRestore();
    }
  });

  it('goal body marker counts retain the legacy summary when no UNVERIFIABLE candidate exists', async () => {
    const stderr: string[] = [];
    const write = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      await runDevPipeline(T({ input: { file: '/no-markers-goal.txt' } }), {
        readFile: () => validGoalFile,
        branch: () => 'main',
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => selfResult,
      });
      expect(stderr).toContain('[dev] goal-file-markers: 0 recognized invariant(s), 0 UNVERIFIABLE invariant candidate(s), 0 grounding file(s) not mentioned in ask, 0 UNANSWERED clarification(s), decision signal: no-marker for /no-markers-goal.txt\n');
    } finally {
      write.mockRestore();
    }
  });

  it('goal body marker counts do not invent a reason for an empty UNVERIFIABLE marker', async () => {
    const stderr: string[] = [];
    const write = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const markedGoal = `${validGoalFile}\n\n## 불변식\n- Invariant candidate: preserve ungrounded behavior\n  - UNVERIFIABLE:`;
    try {
      await runDevPipeline(T({ input: { file: '/reason-absent-goal.txt' } }), {
        readFile: () => markedGoal,
        branch: () => 'main',
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => selfResult,
      });
      expect(stderr).toContain('[dev] goal-file-markers: 0 recognized invariant(s), 1 UNVERIFIABLE invariant candidate(s), 0 grounding file(s) not mentioned in ask, 0 UNANSWERED clarification(s), decision signal: no-marker for /reason-absent-goal.txt\n');
    } finally {
      write.mockRestore();
    }
  });

  it('reports extracted, marker-present-unextracted, and no-marker decision signals without blocking launch', async () => {
    const cases = [
      { file: '/decision-signal-extracted.txt', ask: '판정 신호: condition = c; observation = o; expected result = e', status: 'extracted', guidance: false },
      { file: '/decision-signal-unextracted.txt', ask: '판정 신호: explain the launch behavior in one sentence.', status: 'marker-present-unextracted', guidance: true },
      { file: '/decision-signal-absent.txt', ask: 'The launch behavior is described without a decision-signal marker.', status: 'no-marker', guidance: false },
    ] as const;

    for (const { file, ask, status, guidance } of cases) {
      let launched = false;
      const stderr: string[] = [];
      const write = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
      try {
        await runDevPipeline(T({ input: { file } }), {
          readFile: () => validGoalFile.replace('## WHAT TO BUILD\nbuild', ['## WHAT TO BUILD', 'Original ask (verbatim, unmodified):', '````', ask, '````'].join('\n')),
          branch: () => 'main',
          buildSelfImplementSeams: () => ({} as SelfImplementSeams),
          runSelfImplement: async () => { launched = true; return selfResult; },
        });
        expect(launched).toBe(true);
        const markerLine = stderr.find((line) => line.startsWith('[dev] goal-file-markers: 0 recognized invariant(s)'));
        expect(markerLine).toBe(`[dev] goal-file-markers: 0 recognized invariant(s), 0 UNVERIFIABLE invariant candidate(s), 0 grounding file(s) not mentioned in ask, 0 UNANSWERED clarification(s), decision signal: ${status} for ${file}\n`);
        expect(stderr.some((line) => line.includes('decision signal repair:'))).toBe(guidance);
      } finally {
        write.mockRestore();
      }
    }
  });

  it('goal body marker counts deferred structured clarification blocks', async () => {
    const stderr: string[] = [];
    const write = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const deferredGoal = `${validGoalFile}\n\n- Clarification:\n  - id: marker-count\n  - header: Clarification\n  - question: Which focused test?\n  - options:\n    - label: dev-pipeline test\n      description: Name the focused test file.\n  - includeOther: true\n  - answer: DEFERRED-UNTIL: Which focused test?`;
    try {
      await runDevPipeline(T({ input: { file: '/deferred-goal.txt' } }), {
        readFile: () => deferredGoal,
        branch: () => 'main',
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => selfResult,
      });
      expect(stderr).toEqual([
        '[dev] goal-file-lint: 1 WARN finding(s) for /deferred-goal.txt\n',
        expectedGoalFileLintStderrLine('WARN', 'unanswered-clarification', '1 unanswered clarification: marker-count { question="Which focused test?"; questionTruncated=false; options="dev-pipeline test: Name the focused test file."; optionsTruncated=false }'),
        '[dev] goal-file-markers: 0 recognized invariant(s), 0 UNVERIFIABLE invariant candidate(s), 0 grounding file(s) not mentioned in ask, 1 UNANSWERED clarification(s), decision signal: no-marker for /deferred-goal.txt\n',
        '[dev] goal-file-type: implement; dispatch: self-mission for /deferred-goal.txt\n',
      ]);
    } finally {
      write.mockRestore();
    }
  });

  it('--allow-goal-lint-errors는 lint ERROR 파일을 발사하고 셀 수 있는 우회 관측을 남긴다', async () => {
    let launched = false;
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      await runDevPipeline(T({ input: { file: '/bypassed-goal.txt' }, allowGoalLintErrors: true }), {
        readFile: () => validGoalFile.replace('## PROBLEM', '## BROKEN'),
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => { launched = true; return selfResult; },
      });
      expect(launched).toBe(true);
      expect(log).toHaveBeenCalledWith('dev-pipeline', 'goal-file-lint-bypassed', {
        file: '/bypassed-goal.txt', errorCount: 2, tags: ['canonical-structure', 'canonical-structure'], checks: ['missing-required-section', 'required-section-order'],
      });
    } finally {
      log.mockRestore();
    }
  });

  it('U4b — interactive(runChatTurn 미주입) → 주입 필요 에러(NotYetUnified 아님·배선됨)', async () => {
    await expect(runDevPipeline(T({ context: 'interactive' }))).rejects.toThrow(/runChatTurn 주입 필요/);
  });

  it('U6 — acp dispatch → 주입 dispatchAcpAgent 를 매핑된 args 로 호출·kind:acp', async () => {
    let gotArgs: unknown;
    let gotSignal: AbortSignal | undefined;
    const deps: DevPipelineDeps = {
      dispatchAcpAgent: async (args, signal) => { gotArgs = args; gotSignal = signal; return { backend: args.backend, output: 'done' }; },
      cwd: '/w',
    };
    const r = await runDevPipeline(T({ input: { text: 'ACP 작업' }, executor: { kind: 'external', backend: 'codex', transport: 'acp' } }), deps);
    expect(r.kind).toBe('acp');
    expect(gotArgs).toEqual({ backend: 'codex-app-server', task: 'ACP 작업', cwd: '/w' }); // codex→codex-app-server 매핑
    expect(gotSignal).toBeInstanceOf(AbortSignal); // 주입 경로도 signal 전달(기본 경로와 일치)
    expect(r.result).toEqual({ ok: true, backend: 'codex-app-server', output: 'done' }); // 정규화(ok 부여)
  });

  it('U6 — acp completion:pr → 거부(cwd 세션·PR 완결 미배선)', async () => {
    await expect(runDevPipeline(T({ executor: { kind: 'external', backend: 'claude', transport: 'acp' }, completion: 'pr' }), { dispatchAcpAgent: async () => ({}) })).rejects.toThrow(/NotYetUnified.*completion:pr/);
  });

  it('두 결과 계약(self·agent-mission) 모두 ok 제공 — CLI 성공판정(ok===true) 회귀 가드', () => {
    // 컴파일타임 — 어느 결과 타입이 ok 를 잃으면 tsc 실패(CLI 의 (result).ok 판정이 조용히 깨지는 것 차단).
    const _selfOk: SelfImplementResult['ok'] = true;
    const _missionOk: AgentMissionResult['ok'] = true;
    expect(_selfOk && _missionOk).toBe(true);
  });

  it('빈 텍스트 → 에러', async () => {
    await expect(runDevPipeline(T({ input: { text: '   ' } }), { runSelfImplement: async () => selfResult, buildSelfImplementSeams: () => ({} as SelfImplementSeams) })).rejects.toThrow(/비었다/);
  });

  // ── 미배선 옵션 거부(수락 후 무시 금지) ──
  const selfDeps = (): DevPipelineDeps => ({ runGit: presentRemote, runSelfImplement: async () => selfResult, buildSelfImplementSeams: () => ({} as SelfImplementSeams) });
  it('T1 — plan:true(self+mission) → plan-staged dispatch(dispatchRunDevHarness 위임)·external+plan 은 거부', async () => {
    let gotArgs: DevHarnessDispatchArgs | undefined;
    const r = await runDevPipeline(T({ plan: true }), { dispatchRunDevHarness: async (a) => { gotArgs = a; return { output: '스테이지 출력' }; } });
    expect(r.kind).toBe('plan-staged');
    if (r.kind === 'plan-staged') expect(r.result.output).toBe('스테이지 출력');
    expect(gotArgs).toEqual({ objective: '기능 X', auto_drive: 'safe', target: 'self' }); // safe resolver default → safe
    // external + plan → plan-staged 조건(self) 미충족 → 거부(수락 후 무시 금지)
    await expect(runDevPipeline(T({ plan: true, executor: { kind: 'external', backend: 'codex' }, branch: 'b' }), {})).rejects.toThrow(/NotYetUnified.*plan/);
  });
  it('review:true → NotYetUnified 거부(spec 제어 미배선·self 는 내부 리뷰 고정)', async () => {
    await expect(runDevPipeline(T({ review: true }), selfDeps())).rejects.toThrow(/NotYetUnified.*review/);
  });
  it('U4b — autoReview:true 는 self-mission 에서 배선(거부 X·autoReview 옵션 전달)·비-self dispatch 는 거부', async () => {
    let opts: SelfImplementOptions | undefined;
    await runDevPipeline(T({ autoReview: true }), { runSelfImplement: async (o) => { opts = o; return selfResult; }, buildSelfImplementSeams: () => ({} as SelfImplementSeams) });
    expect(opts?.autoReview).toBe(true); // self-mission 배선 → runSelfImplement autoReview 로 전달
    // agent-mission-pty 는 autoReview 미배선 → 거부(수락 후 무시 금지)
    const amDeps: DevPipelineDeps = { runAgentMission: async () => missionResult, resolveBackend: () => ({ name: 'codex', cmd: 'codex', args: ['--yolo'] }) };
    await expect(runDevPipeline(T({ executor: { kind: 'external', backend: 'codex' }, branch: 'wt/x', autoReview: true }), amDeps)).rejects.toThrow(/NotYetUnified.*autoReview/);
  });
  it('실행 시작 시 completion 모드와 종료 의미를 stdout 한 줄로 알린다', async () => {
    const output = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const cases: Array<[DevPipelineSpec, string]> = [
        [T({ completion: 'auto-merge' }), '[dev] completion: auto-merge — PR review clean 시 자동 병합합니다 (끄기: --no-auto-merge)'],
        [T({ completion: 'pr' }), '[dev] completion: pr — PR 개설로 끝납니다'],
        [T({ completion: 'worktree-only' }), '[dev] completion: worktree-only — worktree 작업으로 끝납니다'],
      ];
      for (const [spec, expected] of cases) {
        output.mockClear();
        await runDevPipeline(spec, selfDeps());
        expect(output).toHaveBeenCalledTimes(2);
        expect(output).toHaveBeenNthCalledWith(1, expected);
      }
    } finally {
      output.mockRestore();
    }
  });

  it.each(['scripts/release-loop/publish.ts', 'graphs/release/loop.yaml', 'src/release-loop/manifest.ts'])(
    'dev-pipeline refuses an injected executor merge of %s and annotates its PR', async (path) => {
      let merged = 0;
      const labels: string[] = [];
      const comments: string[] = [];
      const result = await runDevPipeline(T({ completion: 'auto-merge' }), {
        runGit: presentRemote,
        buildSelfImplementSeams: () => ({
          readPrFiles: async () => [path],
          addPrLabel: async ({ label }: { label: string }) => { labels.push(label); },
          postPrComment: async ({ body }: { body: string }) => { comments.push(body); },
          mergePr: async () => { merged++; return { merged: true }; },
        } as unknown as SelfImplementSeams),
        runSelfImplement: async ({ seams }) => {
          const attempt = await seams.mergePr!({ number: 7, cwd: process.cwd() });
          expect(attempt.merged).toBe(false);
          return { ok: true, stage: 'pr-opened' } as SelfImplementResult;
        },
      });
      expect(result.kind).toBe('self');
      expect(merged).toBe(0);
      expect(labels).toEqual(['elanous:release-path']);
      expect(comments).toEqual([releasePathHoldComment(path)]);
    },
  );

  it('dev-pipeline preserves the injected executor merge for an ordinary PR', async () => {
    let merged = 0;
    await runDevPipeline(T({ completion: 'auto-merge' }), {
      runGit: presentRemote,
      buildSelfImplementSeams: () => ({
        readPrFiles: async () => ['src/ordinary.ts'],
        mergePr: async () => { merged++; return { merged: true }; },
      } as unknown as SelfImplementSeams),
      runSelfImplement: async ({ seams }) => {
        expect((await seams.mergePr!({ number: 7, cwd: process.cwd() })).merged).toBe(true);
        return { ok: true, stage: 'merged' } as SelfImplementResult;
      },
    });
    expect(merged).toBe(1);
  });

  it('U4b — self completion:auto-merge 는 배선(autoMerge 전달)·unmanned 는 거부', async () => {
    let opts: SelfImplementOptions | undefined;
    await runDevPipeline(T({ completion: 'auto-merge' }), { runGit: presentRemote, runSelfImplement: async (o) => { opts = o; return selfResult; }, buildSelfImplementSeams: () => ({} as SelfImplementSeams) });
    expect(opts?.autoMerge).toBe(true); // completion:auto-merge → autoMerge:true
    await expect(runDevPipeline(T({ completion: 'unmanned' }), selfDeps())).rejects.toThrow(/NotYetUnified.*completion:unmanned/);
  });
  it('agent-mission completion:pr → 거부(PR 완결 미배선)', async () => {
    const deps: DevPipelineDeps = { runAgentMission: async () => missionResult, resolveBackend: () => ({ name: 'codex', cmd: 'codex', args: ['--yolo'] }) };
    await expect(runDevPipeline(T({ executor: { kind: 'external', backend: 'codex' }, branch: 'wt/x', completion: 'pr' }), deps)).rejects.toThrow(/NotYetUnified.*completion:pr/);
  });

  it('self completion:pr → seams 빌더가 pr 계획을 받는다(worktree-only 와 구분)', async () => {
    let seenCompletion: string | undefined;
    const deps: DevPipelineDeps = {
      runGit: presentRemote,
      runSelfImplement: async () => selfResult,
      buildSelfImplementSeams: (plan) => { seenCompletion = plan.completion; return {} as SelfImplementSeams; },
    };
    await runDevPipeline(T({ completion: 'pr' }), deps);
    expect(seenCompletion).toBe('pr'); // 축약 없이 completion 이 seams 빌더에 정직 전달
  });

  it('agent-mission → 전체 스펙 필드(mission·branch·evidence·backend) 배선', async () => {
    let spec: import('../agent-mission/driver.js').AgentMissionSpec | undefined;
    const backend: AgentBackend = { name: 'claude', cmd: 'claude', args: ['--dangerously-skip-permissions'] };
    const deps: DevPipelineDeps = { runAgentMission: async (s) => { spec = s; return missionResult; }, resolveBackend: () => backend };
    await runDevPipeline(T({ input: { text: '외부미션' }, executor: { kind: 'external', backend: 'claude' }, branch: 'wt/c', base: 'main' }), deps);
    expect(spec).toMatchObject({ mission: '외부미션', branch: 'wt/c', base: 'main', evidence: { kind: 'tsc' } });
    expect(spec!.agent).toBe(backend);
  });

  it('수동 --file 골은 external 실행 경로에도 저작기 증거 위치 계약을 전달한다', async () => {
    let spec: import('../agent-mission/driver.js').AgentMissionSpec | undefined;
    const required = 'For every acceptance criterion, state where evidence that it was met appears in the diff or which line of the report shows it. Evidence visible only on an execution screen and left in neither the diff nor the report is not evidence.';
    await runDevPipeline(T({ input: { file: '/manual-goal.txt' }, executor: { kind: 'external', backend: 'codex' }, branch: 'wt/manual' }), {
      readFile: (path) => { expect(path).toBe('/manual-goal.txt'); return CANONICAL_GOAL_FILE; },
      runAgentMission: async (received) => { spec = received; return missionResult; },
      resolveBackend: () => ({ name: 'codex', cmd: 'codex', args: ['--yolo'] }),
    });
    expect(spec?.mission).toBe(`${CANONICAL_GOAL_FILE}\n\n${required}`);
  });

  // 🩸 2026-09-23 실측: 리뷰 티어를 best(sol·high)로 올린 «뒤에도» wire 에는 effort:"medium" 이 나갔다
  //   — 호출부에 'medium' 이 박혀 있었다. 사다리를 재는 시험(role-tier-contract)은 초록이었다.
  //   ⇒ 이 시험은 사다리가 아니라 ***review seam 이 streamLLM 에 «실제로 넘기는» 옵션***을 문다. 대표 결정: 리뷰는 high.
  it('⭐ 리뷰 seam 이 streamLLM 에 넘기는 effort 는 «역할 티어의 값»이다 — 하드코딩이 아니다', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'dev-pipeline-review-effort-'));
    const seen: { model?: string; effort?: string }[] = [];
    try {
      clearLaunchRoleLlmOverrides();
      writeFileSync(join(repo, 'changed.ts'), 'export const changed = true;\n');
      setUserConfigOverlay((config) => ({
        ...config, roleLlm: {}, roleModels: {}, roleModelTiers: {},
        llm: { ...config.llm, provider: 'openai-codex' },
      }));
      const seams = await buildDefaultSelfImplementSeams(planDevPipeline(T()), {
        toolReviewerRate: 0,
        streamLLM: async (_m, _c, options) => {
          seen.push({ model: options?.model, effort: (options as { reasoningEffort?: string } | undefined)?.reasoningEffort });
          return 'VERDICT: PASS';
        },
        reviewScopeDiff: async () => 'diff --git a/changed.ts b/changed.ts\n+export const changed = true;\n',
      });
      await seams.reviewDiff!(repo, { goal: 'review effort' });
      const tier = lookupLlmTierSpec('openai-codex', ROLE_MODEL_DEFAULTS.review.tier);
      expect(seen.length).toBeGreaterThan(0);                 // 자가 무는지 — 호출이 없으면 아래는 공허하다
      expect(seen[0]!.model).toBe(tier.model);
      expect(seen[0]!.effort).toBe(tier.reasoningLevel);
      expect(seen[0]!.effort).toBe('high');                   // 대표 2026-09-23 결정을 «값»으로 못 박는다
    } finally {
      setUserConfigOverlay(null);
      clearLaunchRoleLlmOverrides();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reviewReasoningEffort — 티어면 그 값 · 티어 없는 핀은 high · off 는 «안 보낸다»', () => {
    expect(reviewReasoningEffort({ provider: 'openai-codex', tier: 'best' })).toBe('high');
    expect(reviewReasoningEffort({ provider: 'openai-codex', tier: 'better' })).toBe('medium');
    expect(reviewReasoningEffort({ provider: 'openai-codex' })).toBe('high');
    expect(lookupLlmTierSpec('openai-codex', 'budget').reasoningLevel).toBe('off');   // 전제
    expect(reviewReasoningEffort({ provider: 'openai-codex', tier: 'budget' })).toBeUndefined();
  });

  it('기본 seams의 리뷰 모델은 직접 config → 역할 tier → 환경변수 → 기존 기본값 순으로 실제 review seam에 도달한다', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'dev-pipeline-role-model-'));
    const reviewModelEnv = ROLE_MODEL_DEFAULTS.review.environment;
    const originalEnvironment = process.env[reviewModelEnv];
    const originalXaiApiKey = process.env.XAI_API_KEY;
    const originalLaunchOverrides = getLaunchRoleLlmOverrides();
    const observed: string[] = [];
    const plan = planDevPipeline(T());
    const invokeReview = async (): Promise<void> => {
      const seams = await buildDefaultSelfImplementSeams(plan, {
        toolReviewerRate: 0,
        streamLLM: async (_messages, _onChunk, options) => {
          observed.push(options?.model ?? '');
          return 'VERDICT: PASS';
        },
        reviewScopeDiff: async () => 'diff --git a/changed.ts b/changed.ts\n+export const changed = true;\n',
      });
      await seams.reviewDiff!(repo, { goal: 'review model resolution' });
    };
    try {
      clearLaunchRoleLlmOverrides();
      writeFileSync(join(repo, 'changed.ts'), 'export const changed = true;\n');
      // This caller intentionally checks provider-backed role-model resolution; streamLLM is injected so no request executes.
      process.env.XAI_API_KEY = 'test-review-provider-key';
      process.env[reviewModelEnv] = '';
      setUserConfigOverlay((config) => ({ ...config, roleLlm: {}, roleModels: { review: 'grok-4.6' } }));
      await invokeReview();

      // ⛔ 이 칸의 기대값에 «모델 이름»을 박으면 사다리가 오를 때 조용히 늙는다 —
      //    실제로 grok best 가 4.6→4.7 로 오른 날 이 줄이 혼자 빨강으로 남았다(2026-09-23 실측).
      //    ⇒ 이름 대신 «사다리»에서 읽고, 자기참조가 되지 않도록 아래에서 «직접 지정 값과 다름»을 함께 단언한다.
      const tierResolvedReviewModel = lookupLlmTierSpec('grok', 'best').model;
      setUserConfigOverlay((config) => ({
        ...config,
        roleLlm: {},
        llm: { ...config.llm, provider: 'grok' },
        roleModelTiers: { review: 'best' },
      }));
      await invokeReview();

      setUserConfigOverlay((config) => ({ ...config, roleLlm: {}, roleModels: {}, roleModelTiers: {} }));
      process.env[reviewModelEnv] = 'grok-4.6';
      await invokeReview();

      process.env[reviewModelEnv] = '';
      const defaultReviewModel = resolveRoleModel('review').model;
      await invokeReview();

      // 2번째 칸이 «tier 경로»를 탔다는 증거 — 직접 지정(`roleModels`)이 준 값과 «달라야» 한다.
      expect(tierResolvedReviewModel).not.toBe('grok-4.6');
      expect(observed).toEqual(['grok-4.6', tierResolvedReviewModel, 'grok-4.6', defaultReviewModel]);
    } finally {
      setUserConfigOverlay(null);
      clearLaunchRoleLlmOverrides();
      if (originalLaunchOverrides) setLaunchRoleLlmOverrides(originalLaunchOverrides);
      if (originalEnvironment === undefined) delete process.env[reviewModelEnv];
      else process.env[reviewModelEnv] = originalEnvironment;
      if (originalXaiApiKey === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = originalXaiApiKey;
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('리뷰 폴백은 모델에서 해석한 provider를 streamLLM에 함께 전달하고 unknown 모델은 건너뛴다', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'dev-pipeline-review-provider-'));
    const calls: Array<{ model?: string; provider?: { name: string } }> = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'self-dev.review-fallback') events.push({ event, data: data ?? {} });
    });
    try {
      writeFileSync(join(repo, 'changed.ts'), 'export const changed = true;\n');
      setUserConfigOverlay((config) => ({
        ...config,
        roleLlm: {},
        roleModels: { review: 'unregistered-review-model' },
        llm: { ...config.llm, reviewFallbackModels: ['grok-4.6'] },
      }));
      const seams = await buildDefaultSelfImplementSeams(planDevPipeline(T()), {
        toolReviewerRate: 0,
        streamLLM: async (_messages, _onChunk, options) => {
          calls.push({ model: options?.model, provider: options?.provider });
          options?.onResolvedProvider?.('openai-codex', 'unregistered-review-model');
          return 'VERDICT: PASS';
        },
        reviewScopeDiff: async () => 'diff --git a/changed.ts b/changed.ts\n+export const changed = true;\n',
      });
      await seams.reviewDiff!(repo, { goal: 'review provider fallback' });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.model).toBe('grok-4.6');
      expect(calls[0]!.provider?.name).toBe('grok');
      expect(events).toContainEqual(expect.objectContaining({
        event: 'fallback',
        data: expect.objectContaining({
          model: 'unregistered-review-model',
          afterReason: 'unknown-model-provider',
        }),
      }));
      expect(events).toContainEqual(expect.objectContaining({
        event: 'resolved',
        data: expect.objectContaining({ provider: 'grok', resolvedProvider: 'openai-codex' }),
      }));
    } finally {
      setUserConfigOverlay(null);
      log.mockRestore();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('기본 seams — completion 별 approvePr 구성(pr→PR개설·worktree-only→미개설)', async () => {
    await withNonExecutingReviewProvider(async () => {
      const prPlan = planDevPipeline(T({ completion: 'pr' }));
      const wtPlan = planDevPipeline(T({ completion: 'worktree-only' }));
      // Caller: this completion-routing test → buildDefaultSelfImplementSeams → defaultSeams.
      const prSeams = await buildDefaultSelfImplementSeams(prPlan, { toolReviewerRate: 0, llmReview: nonExecutingReview });
      const wtSeams = await buildDefaultSelfImplementSeams(wtPlan, { toolReviewerRate: 0, llmReview: nonExecutingReview });
      expect(typeof prSeams.approvePr).toBe('function'); // pr → 승인 seam 구성(PR 개설)
      expect(wtSeams.approvePr).toBeUndefined();          // worktree-only → 미개설
      expect(await prSeams.approvePr!({} as never)).toBe(true);
    });
  });

  it('runDevPipeline injects the transient NL approver into the final approvePr seam', async () => {
    const approver: NonNullable<SelfImplementSeams['approvePr']> = async () => true;
    let captured: SelfImplementOptions | undefined;
    await runDevPipeline(T({ completion: 'pr' }), {
      runGit: presentRemote,
      buildSelfImplementSeams: () => ({ ...({} as SelfImplementSeams), approvePr: async () => false }),
      approver,
      runSelfImplement: async (options) => {
        captured = options;
        return { ok: true, stage: 'pr-opened', node: 'open-pr', outcome: 'completed' } as never;
      },
    });
    expect(captured?.seams.approvePr).toBe(approver);
    expect(await captured!.seams.approvePr!({} as never)).toBe(true);
  });

  it('routes every human guidance notice to a supplied progress reporter without stdout writes', async () => {
    const progress: string[] = [];
    const stdout: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((line: unknown) => { stdout.push(String(line)); });
    try {
      await runDevPipeline(T(), {
        progress: (message) => { progress.push(message); },
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => selfResult,
      });
      expect(progress).toEqual([
        '[dev] completion: worktree-only — worktree 작업으로 끝납니다',
        '[dev] base=unspecified · base-selection=unspecified · evidence=not applicable',
      ]);
      expect(stdout).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  it('renders a spec notice through the human progress surface but suppresses it for JSON output', async () => {
    const progress: string[] = [];
    await runDevPipeline(T({ notice: '[ask] ℹ️ 권장 발사 입구: cli-dev-ask' }), {
      progress: (message) => { progress.push(message); },
      buildSelfImplementSeams: () => ({} as SelfImplementSeams),
      runSelfImplement: async () => selfResult,
    });
    expect(progress).toContain('[ask] ℹ️ 권장 발사 입구: cli-dev-ask');

    progress.length = 0;
    await runDevPipeline(T({ notice: '[ask] ℹ️ 권장 발사 입구: cli-dev-ask', humanReadableOutput: false }), {
      progress: (message) => { progress.push(message); },
      buildSelfImplementSeams: () => ({} as SelfImplementSeams),
      runSelfImplement: async () => selfResult,
    });
    expect(progress).toEqual([]);
  });

  it('keeps absent-reporter CLI guidance byte-for-byte on stdout and preserves output-disabled silence', async () => {
    const stdout: string[] = [];
    const progress: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((line: unknown) => { stdout.push(String(line)); });
    try {
      await runDevPipeline(T(), {
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => selfResult,
      });
      expect(stdout).toEqual([
        '[dev] completion: worktree-only — worktree 작업으로 끝납니다',
        '[dev] base=unspecified · base-selection=unspecified · evidence=not applicable',
      ]);

      stdout.length = 0;
      await runDevPipeline(T({ humanReadableOutput: false }), {
        progress: (message) => { progress.push(message); },
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => selfResult,
      });
      expect(stdout).toEqual([]);
      expect(progress).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  it('기본 seams가 자식 진행을 사람이 읽는 부모 출력으로 전달하고 억제 모드에서는 숨긴다', async () => {
    await withNonExecutingReviewProvider(async () => {
      const output: string[] = [];
      const log = spyOn(console, 'log').mockImplementation((line: unknown) => { output.push(String(line)); });
      try {
        // Caller: this progress-routing test → buildDefaultSelfImplementSeams → defaultSeams.
        const readable = await buildDefaultSelfImplementSeams(planDevPipeline(T()), { toolReviewerRate: 0, llmReview: nonExecutingReview });
        const suppressed = await buildDefaultSelfImplementSeams(planDevPipeline(T({ humanReadableOutput: false })), { toolReviewerRate: 0, llmReview: nonExecutingReview });
        expect(typeof readable.onProgress).toBe('function');
        expect(typeof suppressed.onProgress).toBe('function');
        readable.onProgress!({ stage: 'implementing', message: 'child progress' });
        suppressed.onProgress!({ stage: 'implementing', message: 'hidden progress' });
        expect(output).toEqual(['[self-implement:implementing] child progress']);
      } finally {
        log.mockRestore();
      }
    });
  });

  it('CLI 재사용 파서·저장소 경계 로더가 만든 혼합 reviewer context가 plan과 기본 seam을 지나 내부 리뷰·관측까지 순서대로 도달한다', async () => {
    await withNonExecutingReviewProvider(async () => {
      const repo = mkdtempSync(join(tmpdir(), 'dev-pipeline-reviewer-context-'));
      const events: Record<string, unknown>[] = [];
      const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
        if (category === 'self-implement' && event === 'review.done') events.push(data ?? {});
      }) as never);
      let prompt = '';
      try {
      writeFileSync(join(repo, 'context-file.md'), 'file premise');
      writeFileSync(join(repo, 'f.ts'), 'export const a = 1;\n');
      const contextOrder = reviewerContextArgs(['--context', 'context-file.md', '--context-text=provided text']);
      const loaded = loadReviewerContext({ contextOrder }, createRepositoryReferencedFileReader(repo));
      expect(loaded.failed).toEqual([]);
      const plan = planDevPipeline(T({ reviewerContext: loaded.items }));
      const seams = await buildDefaultSelfImplementSeams(plan, {
        llmReview: async (value: string) => { prompt = value; return 'VERDICT: PASS'; },
      });
      await seams.reviewDiff!(repo, { goal: 'review context delivery' });
      expect(plan.reviewerContext).toEqual([
        { label: 'context-file.md', body: 'file premise' },
        { label: 'provided text', body: 'provided text' },
      ]);
      expect(prompt.indexOf('context-file.md')).toBeLessThan(prompt.indexOf('provided text'));
      expect(prompt).toContain('file premise');
      expect(prompt).toContain('provided text');
      expect(events).toEqual([expect.objectContaining({ reviewerContextLoaded: 2 })]);
      } finally {
        log.mockRestore();
        rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  it('비주입 파일읽기 — 기본 readFileSync(top-level import·ESM) 로 실파일 해석', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'devpipe-'));
    try {
      const f = join(dir, 'mission.md');
      writeFileSync(f, CANONICAL_GOAL_FILE);
      let got: string | undefined;
      // deps.readFile 미주입 → runDevPipeline 이 기본 readFileSync 사용(require 아님·ESM 안전).
      await runDevPipeline(T({ input: { file: f } }), { runSelfImplement: async (o) => { got = o.feature; return selfResult; }, buildSelfImplementSeams: () => ({} as SelfImplementSeams) });
      expect(got).toBe(`${CANONICAL_GOAL_FILE}\n\nFor every acceptance criterion, state where evidence that it was met appears in the diff or which line of the report shows it. Evidence visible only on an execution screen and left in neither the diff nor the report is not evidence.`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('dev-pipeline — self-mission target seam forwarding', () => {
  const selfResult = { ok: true } as SelfImplementResult;

  it('non-interactive target without --yes refuses before git init or either child seam', async () => {
    const directory = mkdtempSync(join(homedir(), 'dev-pipeline-consent-refusal-'));
    let provisioned = false;
    let seamsBuilt = false;
    try {
      await expect(runDevPipeline(T({ target: directory, humanReadableOutput: false }), {
        nonGitInteractive: false,
        askNonGitInit: async () => { throw new Error('must not ask'); },
        provisionRepository: () => { provisioned = true; throw new Error('must not provision'); },
        buildSelfImplementSeams: () => { seamsBuilt = true; return {} as SelfImplementSeams; },
      })).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('git init') });
      expect(provisioned).toBe(false);
      expect(seamsBuilt).toBe(false);
      expect(existsSync(join(directory, '.git'))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('valid non-git directory is resolved, provisioned, and reaches the injected self-mission seam plan', async () => {
    const directory = mkdtempSync(join(homedir(), 'dev-pipeline-target-'));
    let received: ResolvedDevPlan | undefined;
    try {
      await runDevPipeline(T({ target: directory, assumeYes: true, humanReadableOutput: false }), {
        buildSelfImplementSeams: (plan) => { received = plan; return {} as SelfImplementSeams; },
        runSelfImplement: async () => selfResult,
      });
      expect(received?.target).toMatchObject({
        status: 'git-repo',
        kind: 'git-repo',
        canonicalTarget: realpathSync(directory),
        repoRoot: realpathSync(directory),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('remote-less target switches automatic PR completion before the child seam receives its plan', async () => {
    const directory = mkdtempSync(join(homedir(), 'dev-pipeline-remote-absent-'));
    let received: ResolvedDevPlan | undefined;
    let childOptions: SelfImplementOptions | undefined;
    const remoteCalls: Array<{ cwd: string; args: string[] }> = [];
    try {
      await runDevPipeline(T({ target: directory, entrance: 'cli-harness-say', assumeYes: true, humanReadableOutput: false }), {
        runGit: (cwd, args) => {
          remoteCalls.push({ cwd, args });
          return { status: 0, stdout: '', stderr: '' };
        },
        buildSelfImplementSeams: (plan) => { received = plan; return {} as SelfImplementSeams; },
        runSelfImplement: async (options) => { childOptions = options; return selfResult; },
      });
      expect(remoteCalls).toEqual([{ cwd: realpathSync(directory), args: ['remote'] }]);
      expect(received?.completion).toBe('worktree-only');
      expect(childOptions).not.toHaveProperty('autoMerge');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('remote-less target rejects an explicit PR request before either child seam is called', async () => {
    const directory = mkdtempSync(join(homedir(), 'dev-pipeline-explicit-pr-'));
    let seamsBuilt = false;
    let childStarted = false;
    try {
      await expect(runDevPipeline(T({ target: directory, completion: 'pr', assumeYes: true, humanReadableOutput: false }), {
        runGit: () => ({ status: 0, stdout: '', stderr: '' }),
        buildSelfImplementSeams: () => { seamsBuilt = true; return {} as SelfImplementSeams; },
        runSelfImplement: async () => { childStarted = true; return selfResult; },
      })).rejects.toThrow(/target has no git remote.*completion:pr/);
      expect(seamsBuilt).toBe(false);
      expect(childStarted).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // ⛔ 2026-09-23 — 계약 변경(의도): 대상이 없어도 «작업 디렉토리 저장소»의 원격을 본다(Phase 4 실측:
  //   원격 없는 로컬 프로젝트가 auto-merge 로 떠서 끝에서야 PR 을 못 열고 멎었다). 대상 동작 자체는 불변.
  it('no target keeps the default target and, with a remote present, leaves completion unchanged', async () => {
    let received: ResolvedDevPlan | undefined;
    let remoteQueries = 0;
    await runDevPipeline(T({ humanReadableOutput: false, completion: 'auto-merge', completionSource: 'default' }), {
      runGit: () => { remoteQueries += 1; return { status: 0, stdout: 'origin\n', stderr: '' }; },
      buildSelfImplementSeams: (plan) => { received = plan; return {} as SelfImplementSeams; },
      runSelfImplement: async () => selfResult,
    });
    expect(received?.target).toBeUndefined();
    expect(remoteQueries).toBe(1);
    expect(received?.completion).toBe('auto-merge');
  });

  // ⛔ 2026-09-23 (벤더 A/B) — 사용자 경로에도 대상 저장소 준비(.gitignore 에 elanous 산출물)를 건다. 도구 저장소면 안 건다.
  it('no target: a foreign working repository is provisioned; the tool repository itself is not', async () => {
    const { mkdtempSync, realpathSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const foreign = realpathSync(mkdtempSync(join(homedir(), '.cwd-provision-test-')));
    try {
      execFileSync('git', ['-C', foreign, 'init', '-q']);
      const provisioned: string[] = [];
      const run = (toolRepositoryRoot: string | null) => runDevPipeline(T({ humanReadableOutput: false }), {
        cwd: foreign,
        toolRepositoryRoot,
        runGit: () => ({ status: 0, stdout: 'origin\n', stderr: '' }),
        provisionRepository: (target) => { provisioned.push(target.canonicalTarget ?? target.target); return { status: 'already-git', target: foreign } as never; },
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => selfResult,
      });
      await run('/somewhere/else/monad-agent');
      expect(provisioned).toEqual([foreign]);
      await run(foreign);                       // 작업 디렉토리 = 도구 저장소
      expect(provisioned).toEqual([foreign]);   // 더 불리지 않았다
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  it('no target but a remote-less working repository → default completion drops to worktree-only (not a late PR failure)', async () => {
    let received: ResolvedDevPlan | undefined;
    await runDevPipeline(T({ humanReadableOutput: false, completion: 'auto-merge', completionSource: 'default' }), {
      runGit: () => ({ status: 0, stdout: '', stderr: '' }),
      buildSelfImplementSeams: (plan) => { received = plan; return {} as SelfImplementSeams; },
      runSelfImplement: async () => selfResult,
    });
    expect(received?.target).toBeUndefined();
    expect(received?.completion).toBe('worktree-only');
  });

  it('rejects target for external, ACP, and parallel dispatches instead of silently ignoring it', () => {
    const target = homedir();
    const cases: DevPipelineSpec[] = [
      T({ target, executor: { kind: 'external', backend: 'codex' }, branch: 'wt/target' }),
      T({ target, executor: { kind: 'external', backend: 'codex', transport: 'acp' } }),
      T({ target, parallel: { goals: [{ feature: 'parallel target' }] } }),
    ];
    for (const spec of cases) {
      expect(() => planDevPipeline(spec)).toThrow(/target은 self-mission dispatch 에만 유효/);
    }
  });

  it('outside-home retains confirmation-needed status in the plan and prevents seam execution', async () => {
    const plan = planDevPipeline(T({ target: tmpdir() }));
    expect(plan.target?.status).toBe('outside-home');
    let seamsBuilt = false;
    await expect(runDevPipeline(T({ target: tmpdir(), humanReadableOutput: false }), {
      buildSelfImplementSeams: () => { seamsBuilt = true; return {} as SelfImplementSeams; },
      runSelfImplement: async () => selfResult,
    })).rejects.toThrow(/target 확인 필요/);
    expect(seamsBuilt).toBe(false);
  });

  it('missing target is rejected before self-mission seam execution with its reason', async () => {
    let seamsBuilt = false;
    await expect(runDevPipeline(T({ target: join(homedir(), 'dev-pipeline-target-does-not-exist'), humanReadableOutput: false }), {
      buildSelfImplementSeams: () => { seamsBuilt = true; return {} as SelfImplementSeams; },
      runSelfImplement: async () => selfResult,
    })).rejects.toThrow(/target 거부: missing/);
    expect(seamsBuilt).toBe(false);
  });

  it('buildDefaultSelfImplementSeams forwards revalidated target seam keys with childScope.elanousBinRoot', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./dev-pipeline.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export async function buildDefaultSelfImplementSeams'));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    expect(fn).toContain('revalidateHarnessTarget(plan.target)');
    expect(fn).toContain('harnessTargetOptions(target, childScope.elanousBinRoot)');
    expect(fn).toContain('...(targetOptions ?? {})');
    expect(fn).not.toContain('process.cwd()');
    expect(fn).not.toContain("resolve(import.meta.dir, '../..')");
  });
});

// ⛔ 리뷰 should-fix(2026-07-30) ⊕ ⭐ 뮤테이션이 그것을 must-fix 급으로 올렸다:
//    CLI→spec(dev-cli.test.ts) 와 seams→driver(seams.test.ts) 는 각각 잠겨 있는데
//    **그 사이 홉**(buildDefaultSelfImplementSeams 의 spec → implementActivityGraceSec)이 비어 있었다.
//    그 한 줄을 지우고 세 테스트 파일을 돌렸을 때 **0 fail** 이었다 = 커버리지 구멍.
//    ⇒ 골이 요구한 것은 "값을 넣었다" 가 아니라 **"도달했다"** 이므로 그 홉을 소스 수준으로 못박는다.
//    (buildDefaultSelfImplementSeams 는 동적 import 로 실 seams 를 만들어 유닛 주입이 어렵다 —
//     레포의 확립된 grep 테스트 관용구를 쓴다.)
describe('리뷰어 자기 읽기 «선언» — 만든 쪽만 안다', () => {
  const source = readFileSync(new URL('./dev-pipeline.ts', import.meta.url).pathname, 'utf8');

  it('기본 구현을 쓸 때만 선언하고, 도구 리뷰어를 뽑으면 true 로 바뀐다', () => {
    expect(source).toContain('const reviewerIsDefaultApiCall = deps.llmReview === undefined;');
    expect(source).toContain('...(reviewerCanSelfRead !== undefined ? { reviewerCanSelfRead } : {})');
    expect(source).toContain('reviewerCanSelfRead = true');
    expect(source).toContain('reviewerCanSelfRead = false');
  });

  it('호출자가 자기 리뷰어를 «주입»하면 선언하지 않는다 — 「모른다」가 「없다」와 다른 값으로 남는다', () => {
    const block = source.slice(source.indexOf('const reviewerIsDefaultApiCall'), source.indexOf('const opensPr'));
    expect(block).toContain('deps.llmReview === undefined');
    expect(block).toContain('if (reviewerIsDefaultApiCall)');
    expect(block).toContain('let reviewerCanSelfRead: boolean | undefined');
  });
});

describe('무인 경로 도구 리뷰어 고르기', () => {
  it('selectUnmannedToolReviewer 는 sample < rate 일 때만 뽑고 rate 0 은 한 번도 안 뽑는다', () => {
    expect(selectUnmannedToolReviewer(0.1, 0)).toEqual({ picked: true, rate: 0.1, sample: 0 });
    expect(selectUnmannedToolReviewer(0.1, 0.1)).toEqual({ picked: false, rate: 0.1, sample: 0.1 });
    expect(selectUnmannedToolReviewer(0, 0)).toEqual({ picked: false, rate: 0, sample: 0 });
    expect(selectUnmannedToolReviewer(0, 0.99)).toEqual({ picked: false, rate: 0, sample: 0.99 });
    const picks = Array.from({ length: 8 }, (_, i) => selectUnmannedToolReviewer(0, i / 8).picked);
    expect(picks.every((picked) => picked === false)).toBe(true);
  });

  it('같은 주입은 같은 고르기를 낸다', () => {
    expect(selectUnmannedToolReviewer(0.4, 0.2)).toEqual(selectUnmannedToolReviewer(0.4, 0.2));
    expect(selectUnmannedToolReviewer(0.4, 0.7)).toEqual(selectUnmannedToolReviewer(0.4, 0.7));
  });

  it('설정이 없으면 보수적 기본이고 0 으로 완전히 끈다', () => {
    const previous = process.env.ELANOUS_TOOL_REVIEWER_RATE;
    delete process.env.ELANOUS_TOOL_REVIEWER_RATE;
    try {
      expect(DEFAULT_UNMANNED_TOOL_REVIEWER_RATE).toBe(0.1);
      expect(DEFAULT_UNMANNED_TOOL_REVIEWER_RATE).toBeLessThan(0.5);
      expect(unmannedToolReviewerRateFromConfig(() => ({}))).toBe(DEFAULT_UNMANNED_TOOL_REVIEWER_RATE);
      expect(unmannedToolReviewerRateFromConfig(() => ({ llm: { toolReviewerRate: 0 } }))).toBe(0);
      expect(unmannedToolReviewerRateFromConfig(() => ({ llm: { toolReviewerRate: 1 } }))).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_TOOL_REVIEWER_RATE;
      else process.env.ELANOUS_TOOL_REVIEWER_RATE = previous;
    }
  });

  async function prepareUnmannedReview(over: {
    toolReviewerRate?: number;
    toolReviewerSample?: number;
    makeToolReviewLLM?: () => (prompt: string) => Promise<string>;
  }) {
    return withNonExecutingReviewProvider(async () => {
      const events: Record<string, unknown>[] = [];
      const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
        if (category === 'self-dev.reviewer' && event === 'tool-reviewer.select') events.push(data ?? {});
      }) as never);
      const repo = mkdtempSync(join(tmpdir(), 'dev-pipeline-tool-reviewer-'));
      writeFileSync(join(repo, 'changed.ts'), 'export const changed = true;\n');
      try {
        const toolReview = async () => 'VERDICT: PASS\nTOOL-REVIEWER';
        // Caller: prepareUnmannedReview → buildDefaultSelfImplementSeams → reviewDiff.
        const seams = await buildDefaultSelfImplementSeams(planDevPipeline(T()), {
          toolReviewerRate: over.toolReviewerRate,
          toolReviewerSample: over.toolReviewerSample,
          makeToolReviewLLM: over.makeToolReviewLLM ?? (() => toolReview),
          streamLLM: async () => 'VERDICT: PASS\nAPI-REVIEWER',
          reviewScopeDiff: async () => 'diff --git a/changed.ts b/changed.ts\n+export const changed = true;\n',
        });
        const review = await seams.reviewDiff!(repo, { goal: 'tool reviewer selection' });
        return { review, events, toolReview };
      } finally {
        log.mockRestore();
        rmSync(repo, { recursive: true, force: true });
      }
    });
  }

  it('고르기가 뽑음을 내면 도구 리뷰어이고 그 사실이 관측에 남는다', async () => {
    const prepared = await prepareUnmannedReview({ toolReviewerRate: 1, toolReviewerSample: 0 });
    expect(prepared.review.canSelfRead).toBe(true);
    expect(prepared.events).toEqual([expect.objectContaining({ picked: true, rate: 1, sample: 0 })]);
  });

  it('고르기가 안 뽑음을 내면 착지 이전과 같고 안 뽑았다가 관측에 남는다', async () => {
    const prepared = await prepareUnmannedReview({ toolReviewerRate: 1, toolReviewerSample: 1 });
    expect(prepared.review.canSelfRead).toBe(false);
    expect(prepared.events).toEqual([expect.objectContaining({ picked: false, rate: 1, sample: 1 })]);
  });

  it('비율 0 으로 여러 번 준비하면 뽑힌 횟수는 0 이다', async () => {
    let picked = 0;
    for (let i = 0; i < 5; i++) {
      const prepared = await prepareUnmannedReview({ toolReviewerRate: 0, toolReviewerSample: i / 5 });
      if (prepared.events[0]?.picked === true) picked += 1;
      expect(prepared.review.canSelfRead).toBe(false);
    }
    expect(picked).toBe(0);
  });

  it('같은 주입으로 두 번 준비하면 결과가 같다', async () => {
    const first = await prepareUnmannedReview({ toolReviewerRate: 0.4, toolReviewerSample: 0.2 });
    const second = await prepareUnmannedReview({ toolReviewerRate: 0.4, toolReviewerSample: 0.2 });
    expect(first.review.canSelfRead).toBe(second.review.canSelfRead);
    expect(first.events).toEqual(second.events);
    expect(first.review.canSelfRead).toBe(true);
  });

  it('도구를 쓸 수 있는 쪽의 스스로 읽을 수 있나 선언은 도구 없는 쪽과 다르다', async () => {
    const picked = await prepareUnmannedReview({ toolReviewerRate: 1, toolReviewerSample: 0 });
    const skipped = await prepareUnmannedReview({ toolReviewerRate: 0, toolReviewerSample: 0 });
    expect(picked.review.canSelfRead).toBe(true);
    expect(skipped.review.canSelfRead).toBe(false);
    expect(picked.review.canSelfRead).not.toBe(skipped.review.canSelfRead);
  });

  it('호출자가 llmReview 를 주입하면 고르기를 건너뛰고 선언하지 않는다', async () => {
    await withNonExecutingReviewProvider(async () => {
      const events: Record<string, unknown>[] = [];
      const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
        if (category === 'self-dev.reviewer' && event === 'tool-reviewer.select') events.push(data ?? {});
      }) as never);
      const repo = mkdtempSync(join(tmpdir(), 'dev-pipeline-injected-reviewer-'));
      writeFileSync(join(repo, 'changed.ts'), 'export const changed = true;\n');
      try {
        // Caller: this injected-reviewer test → buildDefaultSelfImplementSeams → reviewDiff.
        const seams = await buildDefaultSelfImplementSeams(planDevPipeline(T()), {
          toolReviewerRate: 1,
          toolReviewerSample: 0,
          llmReview: async () => 'VERDICT: PASS',
          reviewScopeDiff: async () => 'diff --git a/changed.ts b/changed.ts\n+export const changed = true;\n',
        });
        const review = await seams.reviewDiff!(repo, { goal: 'injected reviewer' });
        expect(Object.prototype.hasOwnProperty.call(review, 'canSelfRead')).toBe(false);
        expect(events).toEqual([]);
      } finally {
        log.mockRestore();
        rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});

describe('dev-pipeline — activity grace 도달(홉 하나가 비어 있었다)', () => {
  it('buildDefaultSelfImplementSeams 가 plan.self.activityGraceSec 를 implementActivityGraceSec 로 넘긴다', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./dev-pipeline.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export async function buildDefaultSelfImplementSeams'));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    expect(fn).toContain('plan.self?.activityGraceSec');
    expect(fn).toContain('implementActivityGraceSec');
    // 두 이름이 **같은 표현식**에 있어야 도달이다(각자 다른 줄에 있으면 통과해선 안 된다).
    const line = fn.split('\n').find((l) => l.includes('implementActivityGraceSec'));
    expect(line).toBeDefined();
    expect(line!).toContain('plan.self?.activityGraceSec');
  });
});

