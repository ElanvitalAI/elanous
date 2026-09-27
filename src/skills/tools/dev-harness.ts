// RunDevHarness — 스테이지드 하니스(P→E→R→D) front door LLM 툴 (P2 · 2026-07-20)
//
// PLAN-dev-harness-front-door §3 P2. 텔레그램 등에서 objective 를 던지면 **플래너→실행기→리뷰기→
// 배포기** 전 파이프라인이 격리 worktree 에서 자율 구현 → gate → (autoDrive 게이트) draft PR.
// SelfImplement(단발 implement+gate)와 달리 **명시 P→E→R→D**(리뷰 라운드·divergence 캡)를 노출.
//
//   dispatch: ctx→SurfaceUx → defaultSeams(repoRoot) → runStagedHarnessOnSurface(막·autoDrive)
//
// 배선 패턴 = SelfImplement(#4794)/RelayShellPrompt(#4806) 복제 — monad-agent-turn 인터셉트로
// per-turn surface HITL 채널을 ctx 로 실어줘 승인/진행이 그 서피스로. P2 는 **elanous 자신** 타깃
// (repoRoot 생략 = 데몬 cwd repo). 외부 repo(target)는 P3.
//
// ★ 제1원칙: front door 결정 observe(harness.frontdoor) — objective digest·autoDrive·terminal.
//   autoDrive 'safe'(기본): 저위험 자율·고위험(PR open)만 ux.confirm(막 채널 없으면 fail-closed).

import { tierModel } from '../../llm/model-defaults.js';
import type { LLMToolSpec } from '../../llm.js';
import type { DaemonToolDispatchCtx } from '../../boot/daemon-tools/types.js';
import type { SelfImplementSeams } from '../../self-implement/orchestrator.js';
import type { DefaultSeamsOptions } from '../../self-implement/seams.js';
import type { AutoDrive, HarnessResult } from '../../harness/staged-harness.js';
import type { RunHarnessOnSurfaceOptions } from '../../harness/harness-membrane.js';
import { surfaceUxFromDispatchCtx, type SurfaceUxSource } from '../../agent/surface-ux/build.js';
import { debug } from '../../debug/log.js';
import { mintRunId } from '../../harness/harness-space.js';
import { resolveObserveOnlyDecision } from '../../self-implement/observe-only.js';
import { harnessTargetOptions, resolveHarnessTarget, revalidateHarnessTarget, type HarnessTargetResolution } from '../../self-implement/harness-target-options.js';
import { resolveMainRepoRoot } from '../../git-fs/worktree.js';
import { describeEntranceCommand, lookupEntrance } from '../../self-dev/entrance-registry.js';

const AUTO_DRIVES = ['off', 'safe', 'on'] as const;
// ⛔ 모듈 평가 시점에 조회하지 않는다 — entrance-registry → native-tool-catalog → 이 파일의 순환에서
//    registry 가 아직 초기화 중이면 `byId` TDZ 로 적재가 죽는다(🅞 2026-09-27 · test/intake-plane-draft.test.ts).
const RUN_DEV_HARNESS_REPLACEMENT = 'SelfImplement 또는 SolveMission';
const RUN_DEV_HARNESS_DESCRIPTION =
  'Use this tool when the user mentions the harness: forms such as "하니스로 개발", "하니스:", "하니스로 구현해줘", "하니스 구현", English "harness", or "self dev" mean the same even with Korean particles or punctuation. ' +
  'Develop a feature/fix end-to-end through the full staged harness — Planner → Executor → Reviewer → ' +
  'Deployer — in an isolated git worktree, then open a DRAFT pull request. Unlike SelfImplement (single ' +
  'implement+gate pass), this runs the explicit P→E→R→D pipeline with review rounds and a divergence cap. ' +
  'Targets elanous itself, an external git repo (worktree+PR), a non-git directory or a single config/dotfile ' +
  '(git-init shadow staging → syntax/manifest gate → HITL diff → backup + in-place apply; never PR). ' +
  'In-place apply always requires human diff confirmation (no auto-apply, even auto_drive="on"). ' +
  'Use when the user wants elanous to develop something through the ' +
  'planner/executor/reviewer harness (e.g. "P→E→R→D로 X 개발해줘", "하니스로 구현해줘", "플래너부터 리뷰기까지 돌려서"). ' +
  'auto_drive: "safe" (default — low-risk stages autonomous, PR-open → operator approval), "off" (every ' +
  'gate → operator), "on" (fully autonomous; PR-open still fail-closed). Coding + gate autonomous; ' +
  'PR-open is a fail-closed human gate. Long-running (minutes).';

/** Observability only; tool selection remains model-led. */
function harnessMentionState(userText: string | undefined): 'absent' | 'matched' | 'not-matched' {
  if (userText === undefined) return 'absent';
  return /하니스|harness|self[\s_-]*dev/i.test(userText) ? 'matched' : 'not-matched';
}

export function isDevHarnessModelSurfaceEnabled(): boolean {
  const { getUserConfig } = require('../../user-config.js') as typeof import('../../user-config.js');
  const configured = getUserConfig().tools.runDevHarness.modelSurface;
  const enabled = configured === true;
  debug.log('tools.surface', 'dev-harness-exposure', {
    enabled,
    source: configured === undefined ? 'default' : 'config',
  });
  return enabled;
}

export function buildRunDevHarnessTool(): LLMToolSpec {
  return {
    name: 'RunDevHarness',
    description: describeEntranceCommand(
      lookupEntrance('nl-run-dev-harness'),
      RUN_DEV_HARNESS_REPLACEMENT,
      RUN_DEV_HARNESS_DESCRIPTION,
    ),
    parameters: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: 'What to build/fix — the feature description the harness will plan, implement, review, and PR.' },
        target: { type: 'string', description: 'What to develop: omit this (or use "self") to develop elanous itself. Set an absolute path only when the user explicitly names an external repository, directory, or config/dotfile; never invent or construct a path. External targets may be an external git repo (worktree+PR), a non-git directory, or a single config/dotfile (shadow staging → backup + HITL in-place apply). Must be inside the home directory; system paths outside home are refused.' },
        auto_drive: { type: 'string', enum: ['off', 'safe', 'on'], description: 'Autonomy level (default "safe"). "off"=every gate to operator; "safe"=low-risk auto, PR-open to operator; "on"=fully autonomous (PR-open still fail-closed).' },
        base: { type: 'string', description: 'Base branch to worktree from (default: repo default).' },
        auto_review: { type: 'boolean', description: 'G8/G9 — **defaults to TRUE** (unattended review is the norm; set false, or say "내가 직접 검토"/"manual review", to suppress). Attaches the `auto-review` label on the opened PR (subject to work-risk self-assessment; external-deploy/live-order/design-fork/destructive/security are refused). A labeled PR is completed unmanned by the L3 poller (rework→judge→merge). Symmetric with the dev line (self implement/orchestrate --auto-review).' },
        red_team: { type: 'boolean', description: 'Set true to force an ADVERSARIAL red-team review of the plan BEFORE execution (a critic attacks the plan for missing steps, wrong ordering, risky assumptions, edge cases, then revises). Decide this yourself when the objective is complex/risky/high-stakes. Complex plans (many steps) auto-trigger it even when false.' },
        multi_angle: { type: 'boolean', description: 'Set true to run a MULTI-ANGLE plan review — an N-lens panel (correctness / completeness / ordering / risk) attacks the plan in parallel, then synthesizes a revised plan. Stronger than red_team (single critic). If the USER explicitly asked for a multi-angle/다각도 review, it runs directly; if YOU decide it autonomously, it is HITL-gated (operator approves running it first in off/safe).' },
        domain: { type: 'string', enum: ['web', 'publish', 'invest', 'research', 'digest', 'skill'], description: 'Non-code execution domain (default: code). "web"/"publish"=deploy a web page via content-to-web (published). "invest"/"research"/"digest"=read-only skill fan-out report. **"skill"=GENERIC skill executor** — luna discovers the best-matching skill for the objective and runs it Write-allowed (e.g. native-deck→PPT, frontend-slides→web deck, diagram-master→image). Use "skill" for any capability not covered by a specific domain (decks, images, documents). Omit for normal code development. Investment ORDER EXECUTION is NOT here — operator-triggered only.' },
        carry_capsule: { type: 'boolean', description: 'Force-carry the plan-stage design contract (Context Capsule — objective, scope, success criteria, evidence) into the executor prompt as a compass. Default is AUTO: the capsule is carried automatically when the clarify interview populated real success/scope/risk (skipped when only generic defaults exist). Set true to always carry, false to never.' },
        sizing_mode: { type: 'string', enum: ['off', 'observe'], description: 'Plan-time step-size lens (C3). "observe" (default) = grade/observe only, never cuts steps (goal-loop untouched). "off" = disable sizing entirely (pure goal-loop).' },
        ledger_mode: { type: 'string', enum: ['off', 'observe'], description: 'Failure investigation ledger (C4). "observe" (default) = record each failure against the design contract for the HITL bundle (diagnosis only, control flow untouched). "off" = no ledger.' },
      },
      required: ['objective'],
      additionalProperties: false,
    },
  };
}

/** dev-harness 실행 seam 세트(테스트/대체 주입). */
export interface DevHarnessDeps {
  /** 하니스 구동(기본 runStagedHarnessOnSurface). */
  runHarness?: (opts: RunHarnessOnSurfaceOptions) => Promise<HarnessResult>;
  /** seam 팩토리(기본 defaultSeams). */
  seamsFactory?: (o: DefaultSeamsOptions) => SelfImplementSeams;
  /** 비대화형 HITL relay 팩토리 seam(기본 buildLlmHitlRelay). */
  hitlRelayFactory?: typeof import('../../harness/llm-hitl-relay.js').buildLlmHitlRelay;
  /** detached dispatch seam(테스트에서 parent relay 배선을 검증). */
  dispatchDetached?: typeof import('../../harness/dispatch-detached.js').dispatchRunDevHarnessDetached;
  /** defaultSeams 에 얹을 추가 옵션(repoRoot 등 — P3). */
  seamsOptions?: DefaultSeamsOptions;
  /** ⭐ 인프로세스 경로의 SurfaceUx 원천 — ctx 없는 CLI 호출이 «진행 sink» 를 넣는 자리.
   *  ⛔ ctx 로 넣으면 안 된다: 위 detached 가드가 `ctx && !deps` 라 ctx 를 주는 순간 subprocess 위임으로 갈린다.
   *  📏 왜 생겼나(2026-08-11 실측): `elanous harness run` 이 8분 3초를 완주하는 동안 부모 stdout 이 «0줄»이었다.
   *    시퀀서는 스테이지마다 progress 를 내고 있었고(`staged-harness.ts`), 막이 그것을 `ux.progress` 로
   *    보내고 있었는데(`harness-membrane.ts:212`), CLI 경로의 ux 는 `emitFeedback` 이 없어 no-op 였다.
   *    ⇒ ***만들어져 있는데 CLI 경로만 안 이어져 있었다.*** */
  uxSource?: SurfaceUxSource;
}

/** ★ #24 — autoDrive 해석: 명시 `auto_drive` 파라미터 우선, 없으면 **objective 텍스트에서 의도 추론**.
 *  텔레그램 자연어("auto_drive on으로 …")를 LLM 이 파라미터로 안 넘겨도 on 을 잡아야 detached 위임(데몬
 *  이벤트루프 격리)이 발동한다(실런 갭 실측 2026-07-21). daemon-tools 의 detached 판정도 이걸 쓴다. */
export function resolveAutoDrive(rawArgs: Record<string, unknown>, fallbackText?: string): AutoDrive {
  const explicit = rawArgs.auto_drive;
  if (typeof explicit === 'string' && (AUTO_DRIVES as readonly string[]).includes(explicit)) return explicit as AutoDrive;
  // objective(LLM arg) + fallbackText(원본 유저 메시지 — LLM 이 objective 에서 "auto_drive on" 을 떼도 잡게).
  const text = `${typeof rawArgs.objective === 'string' ? rawArgs.objective : ''}\n${fallbackText ?? ''}`;
  if (/auto[_\s-]?drive\s*(=|:)?\s*on|완전\s*자율|승인\s*없이|무인\s*자율|fully\s*autonomous/i.test(text)) return 'on';
  if (/auto[_\s-]?drive\s*(=|:)?\s*off/i.test(text)) return 'off';
  return 'safe';
}

/** ★ auto-review 발동 판정(대표 2026-07-27) — **기본 ON**, 억제 표현이 있을 때만 OFF.
 *
 *  배경: 설명은 *"Symmetric with the dev line"* 이라 적혀 있는데 **기본값이 비대칭**이었다.
 *  `elanous dev` 는 auto-review 가 기본 on 인데 이 툴은 `rawArgs.auto_review` 를 명시해야만 켜져,
 *  L2 자연어로 부르면 사실상 영영 안 켜졌다(실측: RunDevHarness 호출 1건 · auto_review 미지정 →
 *  PR 도 무인 리뷰도 안 붙음). 사람이 *"내가 볼게"* 라 하지 않는 한 무인이 기본이어야 한다.
 *
 *  우선순위: 명시 파라미터 → 억제 표현 → **기본 true**.
 *  ⚠️ 억제 어휘는 **"사람이 직접 보겠다"** 는 의사만 잡는다 — "리뷰 없이"(리뷰 자체를 건너뛰라)는
 *     다른 뜻이라 넣지 않는다. `resolveAutoDrive` 와 동형(명시 우선 → 텍스트 추론). */
export function resolveAutoReview(rawArgs: Record<string, unknown>, fallbackText?: string): boolean {
  if (typeof rawArgs.auto_review === 'boolean') return rawArgs.auto_review;
  const text = `${typeof rawArgs.objective === 'string' ? rawArgs.objective : ''}\n${fallbackText ?? ''}`;
  const SUPPRESS = /매뉴얼(로|\s*로)?\s*(검토|리뷰)|수동(으로)?\s*(검토|리뷰)|직접\s*(검토|리뷰|볼게|보겠)|(?:내가|제가)\s*(?:직접\s*)?(검토|리뷰|확인|볼게|보겠)|사람이\s*(검토|리뷰)|손으로\s*(검토|리뷰)|i(?:'ll|\s+will)\s+(?:review|check)(?:\s+(?:it|this))?(?:\s+myself)?|let\s+me\s+(?:review|check)|auto[_\s-]?review\s*(=|:)?\s*(off|false)|no[_\s-]?auto[_\s-]?review|manual\s*review/gi;
  const hasUnnegatedSuppress = Array.from(text.matchAll(SUPPRESS)).some((match) => {
    const start = match.index!;
    const end = start + match[0].length;
    const clauseStart = Math.max(text.lastIndexOf('.', start - 1), text.lastIndexOf('?', start - 1), text.lastIndexOf('!', start - 1), text.lastIndexOf('\n', start - 1)) + 1;
    const nextBoundary = [text.indexOf('.', end), text.indexOf('?', end), text.indexOf('!', end), text.indexOf('\n', end)]
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0] ?? text.length;
    const before = text.slice(clauseStart, start);
    const after = text.slice(end, nextBoundary);
    const hasLeadingEnglishNegation = /\b(?:don't|do\s+not|no\s+need\s+to)\s+(?:(?:do|manually)\s+)*(?:the\s+)?$/i.test(before);
    // ⚠️ 조사를 넓게 잡는다 — 종전엔 `는|을|를` 뿐이라 "auto_review=off**로** 하지 마" 를 놓쳤다.
    const hasTrailingKoreanNegation = /^\s*(?:은|는|이|가|을|를|에|의|로|으로|와|과)?\s*(?:하지\s*(?:마|말고?|않아도)|없이)/.test(after);
    // ⭐ 기능·설정 지칭은 의사 표명이 아니다(2026-07-27) — "manual review **기능**을 자동화해줘" 는
    //   그 기능을 손봐 달라는 **작업 요청**이지 "내가 보겠다" 가 아니다.
    //   ⚠️ `^…$` 앵커가 안전장치다: 매칭이 **모드·설정 이름 그 자체**일 때만 이 예외에 들어간다.
    //      1인칭 어휘(`내가 검토`·`제가 확인`)는 이 목록에 없으므로 **애초에 진입할 수 없다** —
    //      앵커가 느슨해지면 "내가 검토**할 코드**는 이거야" 가 무인으로 새고, 그 방향이 위험하다
    //      (auto-review 라벨 → L3 폴러 → `gh pr merge --squash` 까지 완결되므로 사람 확인이 없어진다).
    //      회귀 테스트가 그 뮤테이션을 잡는다.
    const MODE_OR_SETTING_NAME = /^(?:매뉴얼(로|\s*로)?\s*(검토|리뷰)|수동(으로)?\s*(검토|리뷰)|auto[_\s-]?review\s*(=|:)?\s*(off|false)|no[_\s-]?auto[_\s-]?review|manual\s*review)$/i;
    const REFERS_TO_FEATURE = /^\s*(?:(?:하는|할|된)\s*)?(?:기능|설정|옵션|플래그|로직|코드|feature|flag|option)/i;
    const namesTheFeature = MODE_OR_SETTING_NAME.test(match[0]) && REFERS_TO_FEATURE.test(after);
    return !hasLeadingEnglishNegation && !hasTrailingKoreanNegation && !namesTheFeature;
  });
  return !hasUnnegatedSuppress;
}

/** ★ H2 adversarial(대표 2026-07-21) — 레드팀 강제 발동 판정: 명시 `red_team` 파라미터(에이전트 LLM 판단)
 *  OR objective/원문 키워드(레드팀·적대적·꼼꼼히/신중히 계획·red team). false 여도 복잡 계획은 자동 발동(seam 측). */
export function resolveRedTeam(rawArgs: Record<string, unknown>, fallbackText?: string): boolean {
  if (rawArgs.red_team === true) return true;
  const text = `${typeof rawArgs.objective === 'string' ? rawArgs.objective : ''}\n${fallbackText ?? ''}`;
  return /레드\s*팀|red[_\s-]?team|적대적|꼼꼼히\s*계획|신중히\s*계획|계획.*(공격|검증)해/i.test(text);
}

/** ★ N-크리틱 다각도 점검 발동 판정(대표 2026-07-21). 반환:
 *  - 'explicit' = **유저가 명시 요청**(원문에 "다각도" 키워드) → 바로 실행(HITL 불요).
 *  - 'llm'      = **LLM 스스로 트리거**(multi_angle 파라미터·유저 원문엔 키워드 없음) → 실행 前 HITL 승인.
 *  - 'none'     = 다각도 아님(단일 크리틱 경로).
 *  ★ HITL 대상 = 자율 트리거('llm')일 때만 — 유저가 시켰으면 바로 돈다(대표 정정). */
export function resolveMultiAngle(rawArgs: Record<string, unknown>, fallbackText?: string): 'explicit' | 'llm' | 'none' {
  // detached 자식은 부모가 baked 한 값 사용(ctx.userText 없어 재추론 불가·auto_drive 와 동형).
  const baked = rawArgs.multi_angle_mode;
  if (baked === 'explicit' || baked === 'llm' || baked === 'none') return baked;
  const kw = /다각도|multi[_\s-]?angle|여러\s*각도|다각적/i;
  // 유저 원문(fallbackText=ctx.userText)에 키워드 → 유저 명시 요청.
  if (fallbackText && kw.test(fallbackText)) return 'explicit';
  // objective(LLM 재서술)에 키워드도 유저 의도로 간주(LLM 이 유저 요청을 objective 로 옮김).
  if (typeof rawArgs.objective === 'string' && kw.test(rawArgs.objective)) return 'explicit';
  // multi_angle 파라미터만(유저 원문 키워드 없음) = LLM 자율 판단 → HITL.
  if (rawArgs.multi_angle === true) return 'llm';
  return 'none';
}

/** ★ B1 membrane 관통(§8/§3k) — C1~C4 노브를 rawArgs(surface 파라미터)에서 해석해 막으로 전달한다.
 *  carry_capsule=명시 bool OR 자연어("설계 계약/캡슐/나침반 전달"). sizing_mode/ledger_mode=명시 enum만
 *  (기본 observe 가 이미 유용하므로 자연어 추론 불필요). 미지정=undefined → seam/sequencer 기본(무회귀).
 *  detached 자식은 부모 baked 값 사용(auto_drive 동형). 순수. */
export function resolveHarnessKnobs(
  rawArgs: Record<string, unknown>,
  fallbackText?: string,
): { carryCapsule?: boolean; sizingMode?: 'off' | 'observe'; ledgerMode?: 'off' | 'observe' } {
  const out: { carryCapsule?: boolean; sizingMode?: 'off' | 'observe'; ledgerMode?: 'off' | 'observe' } = {};
  const text = `${typeof rawArgs.objective === 'string' ? rawArgs.objective : ''}\n${fallbackText ?? ''}`;
  // 자연어는 **구체 어구**만(오탐 방지·ACP review #2): 바로 "나침반"/"캡슐" 단독은 흔한 단어라 제외 —
  //   "설계 계약"·"context capsule"·"캡슐 전달/실어"·"나침반 전달/실어" 처럼 의도가 분명할 때만.
  if (rawArgs.carry_capsule === true || /설계\s*계약|context\s*capsule|캡슐\s*(전달|실어)|나침반\s*(전달|실어)/i.test(text)) out.carryCapsule = true;
  else if (rawArgs.carry_capsule === false) out.carryCapsule = false;
  if (rawArgs.sizing_mode === 'off' || rawArgs.sizing_mode === 'observe') out.sizingMode = rawArgs.sizing_mode;
  if (rawArgs.ledger_mode === 'off' || rawArgs.ledger_mode === 'observe') out.ledgerMode = rawArgs.ledger_mode;
  return out;
}

export async function dispatchRunDevHarness(
  rawArgs: Record<string, unknown>,
  ctx?: DaemonToolDispatchCtx,
  deps?: DevHarnessDeps,
): Promise<{ output: string }> {
  const objective = typeof rawArgs.objective === 'string' ? rawArgs.objective.trim() : '';
  if (!objective) throw new Error('RunDevHarness: objective required');
  const autoDrive = resolveAutoDrive(rawArgs, ctx?.userText);   // #24 — objective+원본 유저텍스트 추론(자연어 auto_drive on)
  const runId = typeof rawArgs.runId === 'string' && rawArgs.runId ? rawArgs.runId : mintRunId();

  // ⛔⭐⭐⭐ **observe-only 관문** — `daemon-tools/self-implement.ts` 와 «동형»(대표 2026-08-06).
  //
  //   왜 여기가 필요했나: 라우팅을 재려고 자연어를 넣었을 때 모델이 `RunDevHarness` 를 고르면
  //   ***관문이 없어서 진짜 하니스 런이 떴다.*** `self_implement` 만 막아 두면 «막힌 문 옆에 열린 문»이
  //   있는 상태로 측정하는 것이고, 그 측정은 사람 트리에 worktree·PR 을 남긴다.
  //   📏 실측(2026-08-06): 이 경로는 안 쓰는 길이 아니다 — `harness.frontdoor` 92건 · `harness.skill` 43건
  //     (`self_implement` 18건보다 «많다»). ⚠️ 처음엔 `dev-harness` 라는 «없는 카테고리»로 재서 0건으로
  //     오판했다 — 「0」을 읽기 전에 «어느 자로 쟀나».
  //
  //   ⛔ 스위치는 **새로 만들지 않는다** — `resolveObserveOnlyDecision()` 한 자리가 판정한다.
  //     이름(`…SELF_IMPLEMENT_OBSERVE_ONLY`)이 self-implement 계열이지만 뜻은 ***「기록만 하고 런은 안 띄운다」***
  //     이고, 두 하니스 입구가 그 뜻을 공유해야 «한 번 켜면 둘 다» 막힌다(스위치가 둘이면 하나는 반드시 잊는다).
  const observeOnly = resolveObserveOnlyDecision();
  debug.log('harness.frontdoor', 'observe-only-decision', { runId, autoDrive, observeOnly: observeOnly.enabled, observeOnlySource: observeOnly.source });
  if (observeOnly.enabled) {
    // ⭐ 판정에 필요한 것(어떤 골로 불렸나)은 남기고, 실행만 끊는다.
    debug.log('harness.frontdoor', 'observed', { runId, autoDrive, objectiveChars: objective.length, observeOnlySource: observeOnly.source });
    return { output: `RunDevHarness: observe-only (${observeOnly.source}) — 호출을 기록했고 런은 시작하지 않았다. runId=${runId}` };
  }

  // ★ #24 A(2026-07-21)+완결 — 데몬 서피스(ctx 존재)에서 하니스를 **subprocess 로 위임**해 데몬 메인
  //   이벤트루프를 격리(하니스 동기 op 가 telegram 폴링/HTTP 를 굶기던 근본 차단). **모든 autoDrive**
  //   (off/safe/on) 위임 — off/safe 의 HITL(confirm/question)은 자식↔부모 IPC 로 릴레이한다(detached-hitl).
  //   두 caller(monad-agent-turn 직접 · daemon-tools)가 모두 이 함수를 타므로 여기서 판정. 재귀 가드:
  //   ① 위임된 subprocess(run-detached·ELANOUS_HARNESS_DETACHED) ② 테스트 주입(deps) ③ ctx 없는 직접 CLI 는 인프로세스.
  if (ctx && (!deps || deps.dispatchDetached) && !process.env.ELANOUS_HARNESS_DETACHED) {
    const { dispatchRunDevHarnessDetached: defaultDispatchDetached } = await import('../../harness/dispatch-detached.js');
    const dispatchDetached = deps?.dispatchDetached ?? defaultDispatchDetached;
    const relayUx = surfaceUxFromDispatchCtx(ctx);   // 데몬 surface(telegram 등) — 진행/HITL 을 이리로 relay
    debug.log('harness.frontdoor', 'delegate-detached', { runId, autoDrive, surface: relayUx.surface, interactive: relayUx.interactive });
    // ★ 해석된 autoDrive/adversarial 을 rawArgs 에 고정(bake) — 자식은 ctx.userText 가 없어 재추론이
    //   달라질 수 있으므로 부모가 정한 값을 그대로 쓰게 한다(auto_drive·red_team·multi_angle_mode 일관).
    const knobs = resolveHarnessKnobs(rawArgs, ctx.userText);   // ★ B1 — 부모가 해석해 bake(자식은 재추론 불가)
    const detachedArgs = {
      ...rawArgs,
      runId,
      auto_drive: autoDrive,
      red_team: resolveRedTeam(rawArgs, ctx.userText),
      multi_angle_mode: resolveMultiAngle(rawArgs, ctx.userText),
      ...(knobs.carryCapsule !== undefined ? { carry_capsule: knobs.carryCapsule } : {}),
      ...(knobs.sizingMode !== undefined ? { sizing_mode: knobs.sizingMode } : {}),
      ...(knobs.ledgerMode !== undefined ? { ledger_mode: knobs.ledgerMode } : {}),
    };
    // ★ 진행 릴레이(라이브 카드) + HITL 릴레이(off/safe 승인/질문) 둘 다. relayUx 는 SurfaceUx =
    //   { confirm, question } 를 이미 가짐 → HitlRelay 로 그대로 넘긴다(재발명 0). 데몬 이벤트루프는
    //   async 대기라 무블로킹.
    // ★ HITL 완주(2026-07-22·트랙 HITL/X3·대표 "hitl 도 클로드가 응답해서 해결") — 비인터랙티브(무인 자율)
    //   surface 는 종전 confirm=fail-closed·question=null 로 HITL 에서 dead-end 했다. LLM relay 로 저위험
    //   confirm/명확화 질문을 응답해 **무인 완주**시킨다. ⚠️ X3 규율: 부작용(apply/배포/집행)은 LLM relay 도
    //   기본 fail-closed(approveSideEffects off) — 자율 임의 집행 금지 불변식 유지. 인터랙티브(사람 있음)면 사람 우선.
    let hitlRelay: typeof relayUx | import('../../harness/detached-hitl.js').HitlRelay = relayUx;
    if (!relayUx.interactive) {
      const { buildLlmHitlRelay: defaultHitlRelayFactory } = await import('../../harness/llm-hitl-relay.js');
      const hitlRelayFactory = deps?.hitlRelayFactory ?? defaultHitlRelayFactory;
      const { streamLLM } = await import('../../llm.js');
      const hitlModel = process.env.ELANOUS_PR_REVIEW_MODEL || tierModel('better');
      hitlRelay = hitlRelayFactory({ context: objective, ask: (p) => streamLLM([{ role: 'user', content: p }], () => {}, { model: hitlModel, reasoningEffort: 'low' }) });
      debug.log('harness.frontdoor', 'hitl-llm-relay', { reason: 'non-interactive-autonomous', model: hitlModel });
    }
    return dispatchDetached(detachedArgs, {
      onProgress: (msg) => { try { relayUx.progress(msg, { phase: 'delta' }); } catch { /* fail-soft */ } },
      hitlRelay,
    });
  }
  const base = typeof rawArgs.base === 'string' && rawArgs.base.trim() ? rawArgs.base.trim() : undefined;
  // P3 — 타깃 repo: 'self'/생략 = elanous 자신(seamsOptions 없음). 그 외 = 외부 repo 경로.
  const target = typeof rawArgs.target === 'string' && rawArgs.target.trim() && rawArgs.target.trim() !== 'self'
    ? rawArgs.target.trim() : null;

  const ux = surfaceUxFromDispatchCtx(deps?.uxSource ?? ctx ?? {});
  const { resolveDomainExecute } = await import('../../harness/domain-presets.js');
  const domainExecute = resolveDomainExecute(rawArgs.domain);
  debug.log('harness.frontdoor', 'dispatch', {
    objective: objective.slice(0, 100), runId, autoDrive, target: target ?? 'self', surface: ux.surface, interactive: ux.interactive,
    harnessMention: harnessMentionState(ctx?.userText),
    domain: rawArgs.domain ?? null,
    domainExecuteInjected: !!domainExecute,
  });
  // #24 — 이벤트루프 stall 범인 특정: dev-harness dispatch 를 세분 activity 로 마킹(무한루프가 하니스
  //   경로에서 나면 watchdog stall 로그가 이 라벨을 가리킴). fail-soft.
  try {
    const { setEventLoopActivity } = await import('../../debug/event-loop-watchdog.js');
    setEventLoopActivity(`harness:dispatch:${objective.slice(0, 40)}`);
  } catch { /* fail-soft */ }

  // Target classification is centralized so every front door gets the same
  // canonical home containment and linked-worktree main-root validation.
  let targetOptions: DefaultSeamsOptions | undefined = deps?.seamsOptions;
  let targetResolution: HarnessTargetResolution | undefined;
  if (!targetOptions && target) {
    const elanousBinRoot = resolveMainRepoRoot(process.cwd()) ?? process.cwd();
    const resolution = resolveHarnessTarget(target);
    targetResolution = resolution;
    debug.log('harness.frontdoor', 'target.resolved', {
      target, kind: resolution.status, elanousBinRoot,
      canonicalTarget: resolution.canonicalTarget, repoRoot: resolution.repoRoot,
    });
    if (resolution.status === 'git-repo' || resolution.status === 'non-git-dir' || resolution.status === 'file') {
      targetOptions = harnessTargetOptions(resolution, elanousBinRoot);
    } else if (resolution.status === 'outside-home') {
      // The classifier does not own HITL; the front door retains the existing
      // fail-closed authorization contract for canonical outside-home targets.
      if (!resolution.canonicalTarget) {
        debug.log('harness.frontdoor', 'refused', { target, reason: 'outside-home-normalization-failed' });
        return { output: `RunDevHarness ⚠️ 거부: target '${target}' — 홈 밖 경로를 안전하게 정규화할 수 없습니다.` };
      }
      const approved = await ux.confirm({
        prompt: `⚠️ 최고위험: 홈(homedir) 밖 시스템경로 '${resolution.canonicalTarget}' 를 개발 대상으로 삼을까요?`,
        detail: '시스템/OS 설정 손상 위험. 백업 후 적용되고, 적용 직전 변경 diff 를 한 번 더 확인합니다(2단 HITL). 확신 없으면 취소하세요.',
        yesLabel: '위험 감수·진행', noLabel: '취소',
      });
      if (!approved) {
        debug.log('harness.frontdoor', 'refused', { target, reason: 'outside-home-declined', interactive: ux.interactive });
        return { output: `RunDevHarness ⚠️ 거부: 홈 밖 시스템경로 '${target}' — 진입 ${ux.interactive ? '취소됨(HITL 미승인).' : '승인 채널 없음(fail-closed).'}` };
      }
      const authorized = revalidateHarnessTarget(resolution);
      if (authorized.status === 'normalization-failed' || authorized.status === 'missing') {
        debug.log('harness.frontdoor', 'refused', { target, reason: 'outside-home-revalidation-failed', detail: authorized.reason });
        return { output: `RunDevHarness ⚠️ 거부: target '${target}' — 승인 중 경로 재검증에 실패했습니다.` };
      }
      const authorizedOptions = harnessTargetOptions(authorized, elanousBinRoot);
      if (!authorizedOptions) {
        debug.log('harness.frontdoor', 'refused', { target, reason: 'outside-home-options-unavailable', detail: authorized.reason });
        return { output: `RunDevHarness ⚠️ 거부: target '${target}' — 승인된 경로의 실행 옵션을 만들 수 없습니다.` };
      }
      targetResolution = authorized;
      targetOptions = authorizedOptions;
      debug.log('harness.frontdoor', 'system-path-authorized', { target, kind: authorized.kind ?? authorized.status });
    } else {
      const reason = resolution.status === 'missing' ? 'missing' : 'normalization-failed';
      debug.log('harness.frontdoor', 'refused', { target, reason, detail: resolution.reason });
      const message = resolution.status === 'missing'
        ? '존재하지 않는 경로'
        : '경로를 안전하게 정규화할 수 없음';
      return { output: `RunDevHarness ⚠️ 거부: target '${target}' — ${message}. 홈 안의 git repo·디렉토리·config 파일만 지원(홈 밖은 확인 후 진행). 외부 저장소를 사용하지 않는다면 target을 생략하세요(그러면 elanous 자신을 대상으로 합니다).` };
    }
  }

  // Recheck immediately before handing paths to seams; a symlink retarget after
  // classification must not reach staging or apply through stale options.
  if (targetResolution) {
    const revalidated = revalidateHarnessTarget(targetResolution);
    if (revalidated.status === 'normalization-failed') {
      debug.log('harness.frontdoor', 'refused', { target, reason: 'target-revalidation-failed', detail: revalidated.reason });
      return { output: `RunDevHarness ⚠️ 거부: target '${target}' — 스테이징 전 경로 재검증에 실패했습니다.` };
    }
  }

  // seam — configDir/stateDir 격리(자식 elanous 코딩에이전트). P2: repoRoot 생략 = elanous 자신.
  const { defaultSeams } = await import('../../self-implement/seams.js');
  const { runStagedHarnessOnSurface } = await import('../../harness/harness-membrane.js');
  const { groundMissionInCodebase } = await import('../../autopilot/mission-codebase-gate.js'); // ★ 이식 §3.1 — 하니스 Planner grounding
  const { analyzeGoalAmbiguity } = await import('../../autopilot/mission-intake-clarify.js'); // ⓪ clarify(인터뷰·경량)
  const { invokeResearch } = await import('../../research-bridge/invoke.js'); // ★ H3 외부 research(상황부·게이트)
  const { buildSkillHint } = await import('../../harness/skill-hint.js'); // ★ H3 skill 힌트(결정론·상황부)
  const { selectHarnessSkill } = await import('../../harness/skill-select.js'); // ★ S1 실행형(luna 주경로·substring fallback)
  const { buildAttractivenessSignal } = await import('../../harness/signal-gate.js'); // ★ R3 신호 게이트(판단층·부작용0)
  const { getSkillIndex } = await import('../../skills/index.js');
  const { llmDecomposeSteps } = await import('../../harness/llm-decompose.js'); // ★ H2 LLM decompose(TaskGenerator·DB-free)
  const { adversarialPlanCritique, multiAngleCritique } = await import('../../harness/adversarial-plan.js'); // ★ H2 adversarial 레드팀 + 다각도
  const { childInstanceScope } = await import('../../instance/child-scope.js');
  const childScope = childInstanceScope();
  const seamsFactory = deps?.seamsFactory ?? defaultSeams;
  // ★ S2(autoTrigger 활성화·config-first·2026-07-22) — config 확장과 선언 안전 skill 을 기본 allowlist 에
  //   병합하고 위험패턴은 강제 제외한다. fail-soft(config/index 로드 실패=기본). skillExec seam 에 주입.
  let execAllowlist: ReadonlySet<string> | undefined;
  try {
    const { getUserConfig } = await import('../../user-config.js');
    const { HARNESS_EXEC_ALLOWLIST, resolveHarnessExecAllowlist, isDeclaredAutoExecSafe } = await import('../../harness/skill-exec.js');
    const extra = getUserConfig().skillRouter.harnessExecAllowlist;
    const index = getSkillIndex();
    execAllowlist = resolveHarnessExecAllowlist(
      extra,
      (skill, reason) => debug.log('harness.skill', 'allowlist-reject', { skill, reason }),
      index,
    );
    const declaredSafeCandidates = index.filter((entry) => isDeclaredAutoExecSafe(entry)).map((entry) => entry.name);
    const declaredSafeAdmitted = declaredSafeCandidates.filter(
      (name) => !HARNESS_EXEC_ALLOWLIST.has(name) && execAllowlist!.has(name),
    );
    debug.log('harness.skill', 'allowlist-config', {
      extra, indexSize: index.length, declaredSafeCandidates,
      declaredSafeAdmitted, declaredSafeAdmittedCount: declaredSafeAdmitted.length,
      resolved: [...execAllowlist],
    });
  } catch { /* fail-soft — config 또는 index 없으면 기본 allowlist */ }
  const seams = seamsFactory({
    ...childScope,
    ...(ctx?.signal ? { signal: ctx.signal } : {}),   // #21 — 턴 abort(/cancel) → 자식 goal-loop PTY 즉시 kill
    ...(targetOptions ?? {}),
  });
  if (targetResolution) {
    const assertStableTarget = (): void => {
      const current = revalidateHarnessTarget(targetResolution!);
      if (current.status === 'normalization-failed' || current.status === 'missing') {
        debug.log('harness.frontdoor', 'refused', { target, reason: 'target-revalidation-failed', detail: current.reason });
        throw new Error(`harness target revalidation failed: ${current.reason ?? current.status}`);
      }
    };
    const createWorktree = seams.createWorktree;
    seams.createWorktree = async (options) => {
      assertStableTarget();
      return createWorktree(options);
    };
    if (seams.apply) {
      const apply = seams.apply;
      seams.apply = (options) => {
        assertStableTarget();
        return apply(options);
      };
    }
  }

  // ★ LLM 리뷰어 주입(대표 2026-07-21) — Review critique(FAIL findings → rework 자동수정)·PR 제목·post-PR
  //   리뷰 커멘트. `elanous self review` 와 동일 엔진(reviewPullRequest·gpt-5.6-sol). fail-soft(미주입=게이트-only).
  const { streamLLM } = await import('../../llm.js');
  const reviewModel = process.env.ELANOUS_PR_REVIEW_MODEL || tierModel('better');
  const llmReview = (prompt: string): Promise<string> =>
    streamLLM([{ role: 'user', content: prompt }], () => {}, { model: reviewModel, reasoningEffort: 'medium' });

  // ★ HITL 완주 in-process 배선(2026-07-22·트랙 HITL·#5037 확장) — 인프로세스 경로(ctx 없는 직접 CLI:
  //   `elanous self implement --plan`)는 ux 가 비인터랙티브라 confirm=fail-closed·question=null 로 HITL dead-end.
  //   #5037 은 detached(daemon) 경로만 LLM relay 를 붙였다 — 인프로세스도 동일하게 붙여 CLI --plan 무인 완주.
  //   비인터랙티브일 때만 confirm/question 을 LLM relay 로 위임(progress/spill/surface 원본 유지). ⚠️ X3 규율:
  //   부작용(apply/배포/집행)은 relay 가 기본 fail-closed(approveSideEffects off) — 자율 임의 집행 금지 유지.
  let effectiveUx = ux;
  if (!ux.interactive) {
    const { buildLlmHitlRelay: defaultHitlRelayFactory } = await import('../../harness/llm-hitl-relay.js');
    const hitlRelayFactory = deps?.hitlRelayFactory ?? defaultHitlRelayFactory;
    const relay = hitlRelayFactory({ context: objective, ask: (p) => streamLLM([{ role: 'user', content: p }], () => {}, { model: reviewModel, reasoningEffort: 'low' }) });
    effectiveUx = {
      surface: ux.surface,
      interactive: true,   // relay 가 실답을 주므로 harness 가 confirm/question 을 시도하게
      confirm: (req) => relay.confirm(req),
      question: (req) => relay.question(req),
      spillFile: (f) => ux.spillFile(f),
      progress: (m, o) => ux.progress(m, o),
    };
    debug.log('harness.frontdoor', 'hitl-llm-relay', { reason: 'non-interactive-inprocess', model: reviewModel });
  }
  // ★ 트랙 R2 도메인 프리셋(2026-07-22) — 명시 domain 파라미터('invest'/'research'/'digest')면 execute 를
  //   코드 implement 대신 skill 실행형(fan-out/chain) executor 로 라우팅(비-코드 도메인 실행기). 미지정=코드(무회귀).
  const runHarness = deps?.runHarness ?? runStagedHarnessOnSurface;
  const knobs = resolveHarnessKnobs(rawArgs, ctx?.userText);   // ★ B1 관통 — C1~C4 노브를 surface 파라미터에서 막으로
  const harnessMention = harnessMentionState(ctx?.userText);
  const result = await runHarness({
    // ⛔⭐ `naturalLanguageDispatch` 를 «단정»하지 않는다 — 증거로 정한다.
    //   이 함수는 «둘» 이 지난다: ⑴ 모델이 부른 도구(사용자 턴 문면이 ctx.userText 로 온다)
    //   ⑵ `elanous harness run` CLI(사용자 턴이 «없다» — ctx 자체가 undefined).
    //   종전엔 `true` 로 못 박혀 ⑵ 도 「자연어 유래」로 기록됐다(2026-08-06 라이브 실측:
    //   CLI 로 띄운 런의 원장에 goalSource=natural-language-dispatch 가 찍혔다).
    //   ⇒ v25 ⑷ 의 «분자»가 부풀어 그 수가 못 믿을 값이 된다.
    //   ⭐ 판정은 이미 있는 `harnessMention` 이 한다 — `absent` = 문면 자체가 «안 왔다».
    objective, runId, harnessMention, seams, ux: effectiveUx, autoDrive, llmReview,
    // ★ G9 즉효(2026-07-25) — auto_review 인텐트를 harness deploy 로 관통(harness↔무인리뷰 대칭화).
    // ★ 기본 ON(2026-07-27 대표) — 억제 표현이 없으면 무인 리뷰까지 간다. resolveAutoReview 참조.
    ...(resolveAutoReview(rawArgs, ctx?.userText) ? { autoReview: true } : {}),
    ...(domainExecute ? { domainExecute } : {}),
    ...(knobs.carryCapsule !== undefined ? { carryCapsule: knobs.carryCapsule } : {}),
    ...(knobs.sizingMode !== undefined ? { sizingMode: knobs.sizingMode } : {}),
    ...(knobs.ledgerMode !== undefined ? { ledgerMode: knobs.ledgerMode } : {}),
    ground: groundMissionInCodebase,   // ★ 이식 §3.1 — Executor 자식에 3박자 grounding 팩트 주입
    // ⓪ clarify(인터뷰·경량) — phase='scope'·heavy=false 로 과도한 조사 방지(대표 원칙: 명확하면 0질문·최상위 1개만).
    analyzeGoal: (obj) => analyzeGoalAmbiguity(obj, { phase: 'scope', heavy: false }),
    // ★ H3 외부 research(상황부) — objective 가 외부지식 요할 때만(intent-gate) web 조사 → grounding 에 얹음.
    research: (topic) => invokeResearch(topic).then((r) => ({ ok: r.ok, output: r.output })),
    // ★ H3 skill 힌트(상황부) — objective 의 explicit 트리거가 특정 skill 을 강하게 가리키면 grounding 힌트
    //   (결정론·실행 안 함·luna 보완축). getSkillIndex 는 프로세스 캐시. fail-soft(index 로드 실패=null).
    skillHint: (objective) => { try { return buildSkillHint(objective, getSkillIndex()); } catch { return null; } },
    // ★ S1 실행형(상황부) — objective 가 allowlist skill 을 가리키면 격리 실행(invokeResearch·Write/Edit deny)해
    //   실 출력을 grounding 에. **luna 의미매칭 주경로**(한/영·오타·동의어 견고·#4839 교훈), luna 무결과면
    //   substring fallback. 코딩 objective 엔 드묾(북극성 총동원 인프라). fail-soft(실패=null→hint 폴백).
    skillExec: (objective) => selectHarnessSkill(objective, { index: getSkillIndex(), ...(execAllowlist ? { allowlist: execAllowlist } : {}) }),
    // ★ R3 신호 게이트(판단층·2026-07-22) — objective 에서 종목을 뽑아 매력도 규율 신호(±1σ)를 grounding 에.
    //   판단 참고·집행 아님(scores.db READ-ONLY·부작용0). 종목/신호 없으면 null(스킵). fail-soft.
    signalGate: (objective) => { try { return buildAttractivenessSignal(objective)?.block ?? null; } catch { return null; } },
    // ★ H2 LLM decompose(Planner) — 마커 없는 자유서술 objective 만 richer 스텝 분해(TaskGenerator·DB-free).
    //   callable=streamLLM(mission-engine 우회·방화벽). grounding 을 context 로 실어 재조사 없이 분해. fail-soft([]).
    decompose: (objective, context) => llmDecomposeSteps(
      objective,
      (inp) => streamLLM([{ role: 'user', content: inp.prompt }], () => {}, { model: process.env.ELANOUS_DECOMPOSE_MODEL || reviewModel, reasoningEffort: 'high' }).then((text) => ({ text })),
      { ...(context ? { context } : {}), maxTasks: 8, ...(ctx?.signal ? { signal: ctx.signal } : {}) },
    ),
    // ★ H2 adversarial — 계획 실행 前 크리틱이 공격해 보강. 두 모드:
    //   ① 다각도(N-크리틱·multi_angle): N 렌즈 병렬 → 종합. **HITL 대상 = LLM 자율 트리거('llm')만** 실행 前
    //      승인(대표 정정) · 유저 명시('explicit')는 바로 실행 · autoDrive 'on'=사전승인(HITL 스킵).
    //   ② 단일 레드팀(red_team/복잡 자동): 1 크리틱·자동적용(#4930).
    adversarialPlan: async (objective, steps, context) => {
      const multi = resolveMultiAngle(rawArgs, ctx?.userText);
      if (multi !== 'none') {
        if (multi === 'llm' && autoDrive !== 'on') {
          // 자율 트리거는 실행 前 HITL 승인(비용/영향 있는 자율 결정). 채널 없으면 fail-closed(원안 유지).
          const ok = await ux.confirm({
            prompt: '🔬 다각도 플랜 점검(N 렌즈: 정확성·완전성·순서·위험)을 돌릴까요?',
            detail: `LLM 판단으로 제안 — 현재 계획 ${steps.length}스텝. 승인 시 병렬 크리틱 점검 후 수정안 반영.`,
            yesLabel: '점검 진행', noLabel: '원안대로',
          });
          if (!ok) { debug.log('harness.frontdoor', 'multiangle-declined', { steps: steps.length }); return null; }
        }
        const r = await multiAngleCritique(objective, steps, llmReview, context ? { context } : undefined);
        if (r) { try { ux.progress(`🔬 다각도 점검: ${r.issues.length}개 발견${r.revisedSteps.length ? ' → 수정안 반영' : ''}`, { phase: 'delta' }); } catch { /* fail-soft */ } }
        return r && r.revisedSteps.length ? { revisedSteps: r.revisedSteps, issues: r.issues } : null;
      }
      return adversarialPlanCritique(objective, steps, llmReview, context);   // 단일 레드팀
    },
    // 다각도(explicit/llm) OR 단일 레드팀이면 강제 발동(seam 이 복잡도 무관 호출). 'none' 은 복잡 계획만 자동.
    adversarialForce: resolveMultiAngle(rawArgs, ctx?.userText) !== 'none' || resolveRedTeam(rawArgs, ctx?.userText),
    branchPrefix: 'dev',
    ...(base ? { base } : {}),
  });

  debug.log('harness.frontdoor', 'done', { runId, terminal: result.terminal, ok: result.ok, rounds: result.rounds, ref: result.deployRef ?? null });
  // ⚠️ 정직화(대표 2026-07-21): "deployed" 는 draft PR 개설을 과대표현("머지·배포됨"으로 오독)이었다.
  //   terminal 별로 실제 상태 + 다음 스텝을 명시한다(draft=리뷰 후 사람이 Ready→머지·fail-closed HITL).
  const ref = result.deployRef ?? '';
  const desc: Record<string, string> = {
    'pr-opened': `📬 draft PR 개설 — ${ref}\n리뷰 후 Ready→머지(사람 판단·HITL). 아직 배포/머지 아님.`,
    'branch-prepared': `📦 브랜치 준비(커밋됨) — ${ref}\nPR 은 승인 대기(fail-closed). 승인 시 개설.`,
    'applied': `✅ 실위치 적용 완료(비-git/config 타겟) — 백업: ${ref}\n원복 시 백업 경로에서 복원.`,
    'apply-staged': `📦 적용 대기 — 그림자에 변경 준비됨(미적용). HITL diff 확인(승인) 후 백업+적용(fail-closed).`,
    'executed': `✅ 집행 완료(비-코드) — ${ref}\n투자 주문 등 부작용 executor 수행. 감사 ref 첨부.`,
    'published': `✅ 게시 완료(비-코드) — ${ref}\n웹 배포 등. 게시 URL 첨부.`,
    'signaled': `✅ 신호 산출(판단층·부작용0) — ${ref}\n집행 없이 규율 신호만 산출.`,
    'no-changes': `⚠️ 변경 없음 — 구현이 실 산출을 남기지 않음.`,
    'escalated': `⚠️ escalated — operator 판단 필요.${result.detail ? ` ${result.detail}` : ''}`,
    'review-diverged': `⚠️ 리뷰 ${result.rounds}라운드 미통과(자동수정 한계) — 사람 개입.`,
    'execute-failed': `⚠️ 구현 실패.${result.detail ? ` ${result.detail}` : ''}`,
    'deploy-failed': `⚠️ 배포 실패.${result.detail ? ` ${result.detail}` : ''}`,
    'plan-empty': `⚠️ 계획 산출 없음.`,
  };
  const body = desc[result.terminal] ?? `${result.ok ? '✅' : '⚠️'} ${result.terminal}${result.detail ? `: ${result.detail}` : ''}`;
  return { output: `RunDevHarness ${body}\n(rounds=${result.rounds} · autoDrive=${autoDrive})` };
}
