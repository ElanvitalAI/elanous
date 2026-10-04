// ── ReAct PTY 제어 루프 (PLAN §7 P3 · 관측→판단→행동 조립) ──
//
// P0~P5(관측)·#1(frame-state-detect 상태감지)·P2(arbiter write)를 **하나의 ReAct 루프**로 조립한다:
//   관측(화면→상태) → 판단(brain 이 다음 입력 결정) → 행동(arbiter-gated 'agent' write) → 대기 → 반복.
// 자율 brain 이 자식 PTY 를 안전하게 구동하는 재사용 코어. 거대 미션(§11)의 노드 실행기.
//
// 재발명 0: termination 타입은 `agent-loop` `AutopilotTermination` 재사용(success/stuck/budget/
// cancelled/error). "brain"(다음 입력 결정)은 주입 — 실미션=LLM, 테스트=결정론. 모든 I/O(observe/
// inject/sleep/now)도 주입 → 순수 유닛테스트. 실 PTY 구동은 `controlDepsForHandle(handle)`.
//
// ⭐P2 통합: inject 가 arbiter 에 거부되면(false·사람 takeover 로 소유권 이양) 루프가 조용히 헛도는
// 대신 `cancelled` 로 깔끔히 종료(자율→HITL yield). agent-mission 드라이버의 canWrite 셀프힐과 동형.

import { classifyFrameState, type FrameState } from '../capture/frame-state-detect.js';
import { INITIAL_FRAME_OBSERVATION, observeFrame, type FrameObservationState } from '../capture/frame-observation.js';
import { decideAutoAssist, NO_STALL } from '../self-implement/auto-intervene.js';
import { decideInterventionStep, type InterventionStep } from '../self-implement/intervention-step.js';
import type { AutopilotTermination } from './agent-loop.js';
import type { PtyHandle } from '../pty-shell/registry.js';
import { requestRemotePtyControl } from '../pty-shell/pty-control-ipc.js';
import { encodeSgrMouse, detectMouseMode, mouseModeOffReason, MOUSE_MODE_OFF_REASON, MAX_PTY_KEY_REPEAT, type PtyMouseInput } from '../pty-shell/pty-mouse.js';
import { resolvePtySpecialKey } from '../pty-shell/pty-special-keys.js';
import type { PtyWriteActor } from '../pty-shell/pty-write-arbiter.js';
import { debug } from '../debug/log.js';
import { probeControlStance, reportProbeError, stanceBlocksWrite, type ControlStance } from '../pty-shell/pty-control-stance.js';
import { mapControlStance, supervisionObservationFields } from '../self-implement/supervision-vocabulary.js';
import { getNestDepth } from '../agent/nest-depth.js';
import { getCurrentPtyId } from '../agent/pty-identity.js';
import { getHarnessRunId } from '../harness/harness-space.js';
import { getChannelBus } from '../terminal-matrix/index.js';
import { publishLifecycleRecord, type LifecycleRecord } from '../signal/lifecycle-record.js';
import { nextLifecycleSequence } from '../signal/lifecycle-sequence.js';
import type { ChannelBus } from '../terminal-matrix/channel-bus.js';

/** non-Error throw(문자열 등)도 안전하게 문자열화 — error termination message 가 undefined 안 되게. */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 한 스텝의 관측 — brain 이 다음 행동을 결정하는 입력. */
export interface ControlRoundContext {
  /** 현재 self-implement 재투입 라운드(0-based). */
  readonly round: number;
  /** 이 라운드에 적용된 재작업 상한. */
  readonly effectiveMax: number;
  /** 직전 라운드 실패 요약. 호출 경계에서 길이를 제한한다. */
  readonly previousRoundFailure: string;
  /** 이미 병합된 형제 샤드의 제한된 원장 투영. */
  readonly landedSiblings?: {
    readonly items: readonly { readonly runId: string; readonly shardId?: string; readonly pieceIndex?: number; readonly prNumber: number }[];
    readonly shownItems: number;
    readonly totalItems: number;
    readonly omittedItems: number;
    readonly truncated: boolean;
  };
}

export interface ControlObservation {
  readonly screen: string;
  readonly state: FrameState;   // #1 region-rule 분류(idle/working/blocked/…)
  readonly step: number;
  /** 이 스텝에서 공용 판정기가 반환한 개입 어휘. 재구성하지 않고 원본 값을 보존한다. */
  readonly intervention: InterventionStep;
  /** 화면이 직전 스텝 대비 (정규화 후) 바뀌었나. 진행/교착 판정용. */
  readonly changed: boolean;
  /** 화면이 바뀌지 않은 시간(ms). 모르면 생략. */
  readonly sameScreenMs?: number;
  /** stall 사다리 단(0=15s·1=60s·2=5min). stall 아님 = -1. 모르면 생략. */
  readonly stallRung?: number;
  /** self-implement 재투입 맥락. 없는 호출자는 종전 화면 기반 입력을 그대로 사용한다. */
  readonly roundContext?: ControlRoundContext;
  /** 이 판단이 감독하는 caller-declared child PTY. 선언되지 않은 감독자는 생략한다. */
  readonly subjectPtyId?: string;
  /** 이 판단이 속한 harness run. harness 밖 감독자는 생략한다. */
  readonly runId?: string;
  /** Last structured action that could not be performed; brain sees the reason next round. */
  readonly unavailableAction?: string;
}

/** brain 의 결정 — 입력 주입 | 완료 | 대기 | 무진행 보고. */
export type ControlDecision =
  | { readonly action: 'input'; readonly text: string }
  | { readonly action: 'key'; readonly name: string; readonly repeat?: number }
  | ({ readonly action: 'mouse' } & PtyMouseInput)
  | { readonly action: 'resize'; readonly cols: number; readonly rows: number }
  | { readonly action: 'done'; readonly reason: string }
  | { readonly action: 'wait' }
  | { readonly action: 'handoff'; readonly to: 'codex' | 'claude' | 'elanous'; readonly mission: string; readonly carry?: 'diff' | 'summary' }
  | { readonly action: 'ask-human'; readonly reason: string; readonly url?: string; readonly code?: string }
  /** `no-progress` reports observed lack of progress without claiming completion. */
  | { readonly action: 'no-progress'; readonly reason: string; readonly terminal?: boolean };

export interface RunSupervisor {
  /** run supervisor의 관측 → 다음 행동. 동기/비동기 모두 허용(LLM 은 async). `signal` 이 abort 되면(사람 takeover
   *  감지) 진행 중 LLM 호출을 취소하고 즉시 반환해야 한다(안전계약: 언제든 takeover→yield). */
  decide(obs: ControlObservation, signal?: AbortSignal): ControlDecision | Promise<ControlDecision>;
}

/** brain의 완료 선언을 현재 관측으로 검증하는 ground-truth 게이트 결과. */
export type VerifyDoneResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly retry: string };

export interface PtyControlDeps {
  /** 현재 화면 텍스트(예: handle.renderScreen). */
  readonly observe: () => Promise<string> | string;
  /** 입력 주입 — arbiter-gated write('agent'). 반환 false = 거부(사람 takeover)→루프 cancelled. */
  readonly inject: (text: string) => boolean;
  readonly injectKey?: (name: string, repeat?: number) => boolean;
  readonly injectMouse?: (input: PtyMouseInput) => boolean;
  readonly resize?: (cols: number, rows: number) => boolean;
  readonly mouseModeEnabled?: () => boolean;
  /** 이 child가 PTY 입력을 실제로 소비한다는 호출자 선언. 추론 금지. */
  readonly canReceiveInput?: boolean;
  /** 이 supervisor가 제어하는 child PTY id. 호출자가 선언하며 추론하지 않는다. */
  readonly subjectPtyId?: string;
  /** Lifecycle declaration bus; production defaults to the terminal-matrix singleton. */
  readonly lifecycleBus?: ChannelBus;
  /** input 자동 전달의 명시 opt-in. 부재는 false로 현재 동작을 보존한다. */
  readonly autoAssist?: { readonly enabled: boolean; readonly minRung: number };
  /** brain의 done 선언을 ground truth로 확정한다. false면 retry를 주입하고 루프를 계속한다. */
  readonly verifyDone?: (obs: ControlObservation) => VerifyDoneResult | Promise<VerifyDoneResult>;
  /** Mission-only handoff; absent in generic PTY callers. A successful handoff ends this child loop. */
  readonly handoff?: (decision: Extract<ControlDecision, { action: 'handoff' }>, obs: ControlObservation) => Promise<void>;
  /** Notify and wait without killing the child PTY. */
  readonly askHuman?: (decision: Extract<ControlDecision, { action: 'ask-human' }>, obs: ControlObservation) => Promise<void>;
  /** ⭐매 스텝 소유권 확인 — false = agent 가 write 제어 상실(사람 takeover). `wait` 중에도 감지해
   *  즉시 yield(review: takeover 를 input 시에만 보면 wait 중 놓침). 기본 항상 true.
   *  ⚠️ **boolean 은 {상실}∪{확인 불가} 를 뭉친다** — 실 PTY 배선은 아래 `controlStance` 를 쓴다.
   *  이 필드는 스크립트/테스트용 단순 주입 경로로 남는다. */
  readonly hasControl?: () => boolean;
  /** ⭐3-값 소유권(P2b P-a′ · `pty-shell/pty-control-stance`). 주입되면 **이쪽이 우선**이고,
   *  `unknown`(조회 실패)이 `lost`(확인된 상실)와 갈려 관측에 남는다. 미주입이면 `hasControl` 폴백. */
  readonly controlStance?: () => ControlStance;
  /** 자식 PTY 생존 여부. wait 중 종료를 즉시 stuck으로 수렴한다. */
  readonly isAlive?: () => boolean;
  /** 확인된 소유권 상실 뒤 반환을 기다리는 opt-in 경계. 유한한 양수여야만 활성화된다. */
  readonly awaitOwnership?: { readonly maxWaitMs: number };
  /** decide 중 ownership watcher 및 ownership wait poll 간격. 기본 250ms. */
  readonly watchIntervalMs?: number;
  readonly classify?: (screen: string) => FrameState;
  /** loop-owned timer seam — 스텝 폴과 **opt-in 소유권 대기**만 쓴다.
   *  ⚠️ ownership watcher 는 여기를 쓰지 **않는다**(실 타이머 전용 · 주입 sleep 무관이
   *  원 설계의 의도다). 그래서 이 seam 을 주입해도 watcher 의 타이밍은 바뀌지 않는다.
   *  ⚠️ 인자는 `ms` **하나뿐**이다 — abort 는 내부 기본 sleeper 만 받는다. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 소유권 대기의 단조 시계 seam. 미주입이면 실제 단조 시계를 쓴다. */
  readonly now?: () => number;
  /** ⭐관측 준비 게이트(주입식) — decide 전 자식 턴이 안정될 때까지 대기한다. 예: codex 처럼 턴이
   *  길고 버스티한 backend 는 `waitForQuiet`(출력 idle) 로 조용해질 때까지 기다린 뒤 판단해야 매 pollMs
   *  LLM 낭비를 막는다. 미주입 시 no-op → 기존 poll cadence 유지(elanous drive 무회귀). 매 스텝 observe
   *  직전 1회 호출. takeover/생존 감지는 다음 스텝 hasControl/isAlive 가 담당(settle 은 관측 대기 전용). */
  readonly settle?: () => Promise<void>;
  /** 스텝 관측 훅(진단·전사·관측). 저장이 끝난 뒤 다음 입력·완료 처리를 진행하도록 반환 Promise를 기다린다.
   * 기존 동기 소비자의 반환값은 무시한다. */
  readonly onStep?: (obs: ControlObservation, decision: ControlDecision) => unknown | Promise<unknown>;
}

export interface PtyControlOpts {
  /** 최대 스텝(budget). 기본 40. */
  readonly maxSteps?: number;
  /** 화면 무변화 연속 이 횟수면 stuck 종료. 기본 6. */
  readonly stuckLimit?: number;
  /** 스텝 간 폴 간격(ms). 기본 500. */
  readonly pollMs?: number;
}

export interface PtyControlResult {
  readonly termination: AutopilotTermination;
  readonly steps: number;
  readonly handoff?: Extract<ControlDecision, { action: 'handoff' }>;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
function normalizeScreen(s: string): string {
  return s.replace(ANSI_RE, '').replace(/\s+/g, ' ').trim();
}

/**
 * ⭐ReAct 제어 루프 — brain 이 자식 PTY 를 관측·판단·구동한다. 종료(AutopilotTermination):
 *   success  = brain 이 done 반환(골 완료)
 *   cancelled= inject 거부(사람 takeover·소유권 이양) → 자율 yield
 *   stuck    = 화면 무변화가 stuckLimit 연속(brain 이 wait 만·진전 없음)
 *   budget   = maxSteps 초과
 *   error    = observe/brain 예외
 */
export async function runPtyControlLoop(
  brain: RunSupervisor,
  deps: PtyControlDeps,
  opts: PtyControlOpts = {},
): Promise<PtyControlResult> {
  const classify = deps.classify ?? ((s: string) => classifyFrameState(s).state);
  // ⚠️ 주입 seam 은 **1인자 계약 그대로**다(`(ms) => Promise<void>`). abort 를 받는 것은
  //   내부 기본 sleeper 뿐이고, 주입된 sleep 에는 signal 을 넘길 자리가 없다 — 넘긴 적도
  //   없다. 계약에 `signal?` 을 얹으면 아무도 받지 못하는 **죽은 공개 표면**이 되고,
  //   주입자는 자기가 받지도 못할 인자를 처리하는 코드를 쓰게 된다(실제로 그랬다).
  const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
  const sleep = (ms: number): Promise<void> => (deps.sleep ? deps.sleep(ms) : abortableSleep(ms));
  const maxSteps = opts.maxSteps ?? 40;
  const stuckLimit = opts.stuckLimit ?? 6;
  const pollMs = opts.pollMs ?? 500;
  const MAX_TIMER_DELAY_MS = 2_147_483_647;
  const isSchedulerDelay = (value: number | undefined): value is number =>
    Number.isSafeInteger(value) && value! > 0 && value! <= MAX_TIMER_DELAY_MS;
  const configuredWatchIntervalMs = deps.watchIntervalMs;
  const watchIntervalMs = configuredWatchIntervalMs === undefined || isSchedulerDelay(configuredWatchIntervalMs)
    ? (configuredWatchIntervalMs ?? 250)
    : 250;
  const maxOwnershipWaitMs = deps.awaitOwnership?.maxWaitMs;
  const canAwaitOwnership = isSchedulerDelay(maxOwnershipWaitMs)
    && (configuredWatchIntervalMs === undefined || isSchedulerDelay(configuredWatchIntervalMs));
  const now = deps.now ?? performance.now.bind(performance);
  let ownershipLent = false;
  const publishOwnershipLent = (transition: 'enter' | 'exit'): boolean => {
    const runId = getHarnessRunId();
    const ptyId = getCurrentPtyId();
    const subjectPtyId = deps.subjectPtyId;
    if (!runId || !ptyId || !subjectPtyId) {
      debug.log('signal', 'lifecycle.skip-no-identity', {
        missing: [!runId && 'runId', !ptyId && 'ptyId', !subjectPtyId && 'subjectPtyId'].filter(Boolean),
      });
      return false;
    }
    const envelope = {
      runId, ptyId, subjectPtyId, depth: getNestDepth(), role: 'parent' as const,
      seq: nextLifecycleSequence(ptyId), at: Date.now(), class: 'condition' as const,
      name: 'ownership-lent' as const, payload: { actor: 'human', mode: 'manual' }, truncated: false as const,
    };
    const record: LifecycleRecord = transition === 'enter'
      ? { ...envelope, transition: 'enter', resumable: canAwaitOwnership }
      : { ...envelope, transition: 'exit' };
    publishLifecycleRecord(deps.lifecycleBus ?? getChannelBus(), record);
    debug.log('signal', 'lifecycle.published', {
      name: record.name, transition, runId, ptyId, subjectPtyId, depth: record.depth, seq: record.seq, truncated: false,
    });
    return true;
  };
  const enterOwnershipLent = (): void => {
    if (ownershipLent) return;
    ownershipLent = publishOwnershipLent('enter');
  };
  const exitOwnershipLent = (): void => {
    if (!ownershipLent) return;
    ownershipLent = false;
    publishOwnershipLent('exit');
  };

  const hasControl = deps.hasControl ?? (() => true);
  // ⭐소유권 판정은 공용 seam 하나를 탄다(P2b P-a′ · `pty-shell/pty-control-stance`) — 종전엔 이 루프와
  // driver·headless 가 각자 `canWrite('agent')` 를 불러, 한 곳을 고쳐도 나머지가 옛 판정에 남았다.
  // **fail-closed 는 그대로**: 조회 실패는 `'unknown'` 이고 `owned` 가 아니므로 여기서도 중단으로 간다.
  // 달라진 것은 *"상실"* 과 *"확인 불가"* 가 **관측에서 갈린다**는 것뿐이다(뒤에 올 `defer` 가 그 구분에 걸린다).
  // ⚠️ **이중 probe 금지**(리뷰 must-fix) — `controlStance` 를 boolean 으로 접은 뒤 다시 probe 하면
  //   조회 실패가 `lost` 로 **오분류**된다(정보가 첫 접기에서 사라진다). 주입되면 그대로 쓴다.
  // ⚠️ non-Error throw 방어(리뷰 must-fix) — 문자열 throw 는 `.message` 가 `undefined` 라 **원인이
  //   사라지고**, `null`/`undefined` throw 는 `.message` 접근이 **다시 던져** fail-closed(`cancelled`)가
  //   아니라 `error` 종료로 회귀한다. 관측 훅이 판정을 바꾸면 안 된다.
  const onProbeError = (e: unknown): void =>
    debug.log('autopilot.control', 'hascontrol-error', { error: (e as Error)?.message ?? String(e) });
  // ⚠️ 격리는 **손으로 다시 짜지 않는다** — `reportProbeError` 하나를 `probeControlStance` 와 공유한다
  //   (복제하면 그 복제본은 테스트가 못 닿는다 · 리뷰 must-fix).
  const controlStance: () => ControlStance = deps.controlStance
    ? () => { try { return deps.controlStance!(); } catch (e) { reportProbeError(onProbeError, e); return 'unknown'; } }
    : () => probeControlStance({ canWrite: () => hasControl() }, 'agent', onProbeError);
  // ⚠️ 사유를 stance 에 맞춘다(리뷰 should-fix) — 종전엔 조회 불가에도 *"사람 takeover"* 라 **단정**해
  //   구조화 필드(`stance:'unknown'`)와 설명이 모순됐다. 진단이 그 문장을 읽고 엉뚱한 곳을 판다.
  const yieldReason = (stance: ControlStance, at: 'step' | 'post-decide' | 'during-decide'): string =>
    stance === 'unknown'
      ? `control ownership unverifiable (${at}) — 조회 실패라 takeover 여부를 단정할 수 없다`
      : `lost write control (${at}) — 사람 takeover`;
  // ⚠️ **watcher 는 실 타이머로만 돈다** — 원 주석이 *"실 setTimeout watcher(주입 sleep 무관)"* 라
  //   적은 것이 의도다. 주입 sleep 을 타면 두 가지가 깨진다: ①스크립트 brain(즉시 resolve)만 쓰는
  //   테스트에서도 watcher 가 뜨고(종전엔 안 떴다) ②주입 sleep 이 reject 하는 계약이면 종전 `success`
  //   가 `error` 종료로 회귀한다. 소유권 대기(opt-in)만 주입 sleep 을 쓴다.
  const realSleepUntilAbort = (ms: number, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      function onAbort(): void { clearTimeout(timer); resolve(); }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  };
  type OwnershipWaitResult = { readonly ended: 'resumed' | 'expired'; readonly stance: ControlStance };
  const awaitLostOwnership = async (step: number): Promise<OwnershipWaitResult> => {
    const startedAt = now();
    const waitController = new AbortController();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'expired'>((resolve) => {
      deadlineTimer = setTimeout(() => {
        waitController.abort();
        resolve('expired');
      }, maxOwnershipWaitMs!);
    });
    let lastStance: ControlStance = 'lost';
    let scheduledMs = 0;
    const observedWaitedMs = (): number => {
      const measured = now() - startedAt;
      return Number.isFinite(measured) && measured >= 0 ? measured : scheduledMs;
    };
    debug.log('autopilot.control', 'ownership-wait-start', { step, stance: lastStance, waitedMs: 0 });
    try {
      for (;;) {
        const cadenceMs = Math.min(watchIntervalMs, maxOwnershipWaitMs! - scheduledMs);
        const cadenceSleep = deps.sleep ? deps.sleep(cadenceMs) : abortableSleep(cadenceMs, waitController.signal);
        const cadence = cadenceSleep.then(() => 'poll' as const);
        if (await Promise.race([cadence, expired]) === 'expired') {
          const waitedMs = Math.max(observedWaitedMs(), maxOwnershipWaitMs!);
          debug.log('autopilot.control', 'ownership-wait-end', { step, stance: lastStance, waitedMs, ended: 'expired' });
          return { ended: 'expired', stance: lastStance };
        }
        scheduledMs += cadenceMs;
        if (scheduledMs >= maxOwnershipWaitMs!) {
          const waitedMs = Math.max(observedWaitedMs(), scheduledMs);
          debug.log('autopilot.control', 'ownership-wait-end', { step, stance: lastStance, waitedMs, ended: 'expired' });
          return { ended: 'expired', stance: lastStance };
        }
        const currentStance = controlStance();
        const waitedMs = observedWaitedMs();
        if (currentStance === 'owned') {
          debug.log('autopilot.control', 'ownership-wait-end', { step, stance: currentStance, waitedMs, ended: 'resumed' });
          return { ended: 'resumed', stance: currentStance };
        }
        lastStance = currentStance;
        if (currentStance === 'unknown') {
          // ⚠️ 마감이 아니라 **조회 불가**로 끝났다. 둘 다 `expired` 로 적으면 관측이
          //   원인을 잘못 말한다(진단이 마감 시간을 늘리는 엉뚱한 곳을 판다).
          debug.log('autopilot.control', 'ownership-wait-end', { step, stance: currentStance, waitedMs, ended: 'unverifiable' });
          return { ended: 'expired', stance: currentStance };
        }
      }
    } finally {
      waitController.abort();
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    }
  };
  // ⭐제1원칙 관측: 모든 종료(특히 self-heal 결정 — stuck/cancelled/error)는 관측 관문을 거친다.
  // 어느 return 도 이 finish 를 통과해 `elanous logs --category autopilot.control` 로 조회 가능.
  const finish = (termination: AutopilotTermination, steps: number, intervention?: InterventionStep, interventionStop = false): PtyControlResult => {
    const detail =
      termination.kind === 'success' ? termination.reason
      : termination.kind === 'stuck' ? termination.reason
      : termination.kind === 'budget' ? `${termination.observed}/${termination.limit}`
      : termination.kind === 'error' ? termination.message
      : '';
    debug.log('autopilot.control', 'end', {
      kind: termination.kind,
      steps,
      detail,
      ...(intervention ? {
        interventionLevel: intervention.level,
        interventionControlStance: intervention.controlStance,
        interventionNextAction: intervention.nextAction,
        interventionReason: intervention.reason,
        interventionStop,
        ...supervisionObservationFields(intervention.supervisionVerdict),
      } : {}),
    });
    return { termination, steps };
  };

  debug.log('autopilot.control', 'start', { maxSteps, stuckLimit });
  let prevNorm: string | null = null;
  let previousIntervention: InterventionStep | null = null;
  let frameObs: FrameObservationState = INITIAL_FRAME_OBSERVATION;
  let step = 0;
  let unavailableAction: string | undefined;
  const mouseMode = detectMouseMode('');
  // ⚠️ 재개는 `continue` 로 같은 스텝을 다시 하므로 **스텝 예산을 소비하지 않는다**(그게
  //   *"재개한 스텝은 재관측·재결정한다"* 의 뜻이다). 그러면 소유권이 `lost ↔ owned` 로
  //   플래핑할 때 루프가 `maxSteps` 를 영구 우회해 **무한**이 된다 — 대기 자체는 유한한데
  //   대기의 **횟수**가 무한인 구멍이다. 그래서 재개에 별도 예산을 둔다(같은 크기).
  let ownershipResumes = 0;
  /** 재개를 한 번 소비한다. 예산 초과면 종료 결과를, 아니면 null(계속). */
  const chargeResume = (): PtyControlResult | null => {
    ownershipResumes += 1;
    if (ownershipResumes <= maxSteps) return null;
    debug.log('autopilot.control', 'ownership-resume-budget', { step, observed: ownershipResumes, limit: maxSteps });
    return finish({ kind: 'budget', budget: 'iterations', observed: ownershipResumes, limit: maxSteps }, step);
  };
  for (; step < maxSteps;) {
    // 전 스텝을 하나의 try 로 — observe/classify/decide/onStep/inject/hasControl/sleep 어느
    // 콜백이 throw 해도 Promise reject 대신 `error` termination 으로 종료(계약 완결·review).
    try {
      // ⭐P2 self-heal: 매 스텝 소유권 확인 — wait 중이라도 사람이 takeover 하면 즉시 yield.
      //   ⭐관측에 `stance` 를 싣는다(P2b P-a′) — *확인된 상실* 과 *조회 불가* 가 로그에서 갈린다.
      const stepStance = controlStance();
      if (stanceBlocksWrite(stepStance)) {
        if (stepStance === 'lost') enterOwnershipLent();
        if (stepStance !== 'lost' || !canAwaitOwnership) {
          debug.log('autopilot.control', 'yield', {
            step, stance: stepStance, reason: yieldReason(stepStance, 'step'),
            ...supervisionObservationFields(mapControlStance(stepStance, 'halt')),
          });
          return finish({ kind: 'cancelled' }, step);
        }
        const ownershipWait = await awaitLostOwnership(step);
        if (ownershipWait.ended === 'resumed') {
          exitOwnershipLent();
          const overBudget = chargeResume();
          if (overBudget) return overBudget;
          continue;
        }
        const yieldStance = ownershipWait.stance;
        debug.log('autopilot.control', 'yield', {
          step, stance: yieldStance, reason: yieldReason(yieldStance, 'step'),
          ...supervisionObservationFields(mapControlStance(yieldStance, 'halt')),
        });
        return finish({ kind: 'cancelled' }, step);
      }
      // ⭐관측 준비 게이트(주입식·quiet-gate cadence) — 자식 턴이 안정될 때까지 대기(codex 등 버스티
      // 턴서 매 pollMs LLM 낭비 방지). no-op 이면 기존 poll cadence(elanous drive 무회귀). 예외는 아래
      // 전 스텝 try 가 잡아 error termination 으로 수렴(observe 실패와 동일 정책).
      if (deps.settle) await deps.settle();
      const screen = await deps.observe();
      mouseMode.feed(screen);
      const norm = normalizeScreen(screen);
      const changed = prevNorm !== null && norm !== prevNorm;
      const state = classify(screen);
      // `decideInterventionStep` counts the first sample, whereas this loop historically
      // stopped after `stuckLimit` repeated comparisons. Offset the shared threshold by one
      // to preserve the existing stopping iteration while centralizing the recommendation.
      const intervention = decideInterventionStep({
        screen: norm,
        previous: previousIntervention,
        stopAfterSameScreens: stuckLimit + 1,
        descriptor: { controlStance: stepStance },
      });
      previousIntervention = intervention;
      // ⚠️ 한 관측은 **한 시각**을 쓴다 — `now()` 를 두 번 부르면 `stallRung` 과 `sameScreenMs`
      //   가 서로 다른 시각을 기준으로 계산되고, 테스트가 그 이중 호출로 가상 시간이 전진하는
      //   구현 세부에 의존하게 된다(리뷰 must-fix).
      const atMs = now();
      const frame = observeFrame(frameObs, { state, screen, atMs });
      frameObs = frame.next;
      const runId = getHarnessRunId();
      const obs: ControlObservation = {
        screen, state, step, changed, intervention,
        sameScreenMs: Math.max(0, atMs - frameObs.screenSinceMs),
        stallRung: frameObs.stallRung,
        ...(deps.subjectPtyId ? { subjectPtyId: deps.subjectPtyId } : {}),
        ...(runId ? { runId } : {}),
        ...(unavailableAction ? { unavailableAction } : {}),
      };

      // ⭐안전계약(review): decide()(LLM 호출)가 오래 걸려도 그동안 사람이 takeover 하면 **≤250ms 내** 감지
      // (watcher 폴 주기). 실 setTimeout watcher(주입 sleep 무관)로 hasControl 을 폴 — 상실 시 signal abort(→brain 이
      // in-flight LLM 취소) + cancelled yield. 스크립트 brain 은 즉시 resolve 라 watcher 안 뜸(테스트 무영향).
      const ac = new AbortController();
      let lostControl = false;
      // ⚠️ watcher 가 잡은 stance 를 **그때 보존한다**(리뷰 must-fix) — boolean 만 남기면 abort 뒤
      //   재-probe 결과에 따라 *실제로 무엇이었는지* 가 사라진다(transient `unknown` 이 특히 그렇다).
      let watchedStance: ControlStance | null = null;
      let watchTask: Promise<void> | undefined;
      if (deps.hasControl || deps.controlStance) {
        watchTask = (async () => {
          while (!ac.signal.aborted) {
            await realSleepUntilAbort(watchIntervalMs, ac.signal);
            if (ac.signal.aborted) return;
            const stance = controlStance();
            if (stanceBlocksWrite(stance)) {
              lostControl = true;
              watchedStance = stance;
              ac.abort();
              return;
            }
          }
        })();
      }
      // decide() 를 abort 와 **race** — provider 가 signal 을 무시해도 루프는 즉시 yield(review:
      // 협조 의존 제거). 진 decideP 는 orphan 이나 brain 자체 timeout 이 bound.
      let outcome: { aborted: true } | { aborted: false; decision: ControlDecision };
      try {
        const decideP = Promise.resolve(brain.decide(obs, ac.signal)).then((decision) => ({ aborted: false as const, decision }));
        const abortP = new Promise<{ aborted: true }>((resolve) => {
          if (ac.signal.aborted) resolve({ aborted: true });
          else ac.signal.addEventListener('abort', () => resolve({ aborted: true }), { once: true });
        });
        outcome = await Promise.race([decideP, abortP]);
      } finally {
        if (!ac.signal.aborted) ac.abort();
        await watchTask?.catch(() => { /* 관측 보조 태스크가 판정을 바꾸지 않는다 */ });
      }
      if (outcome.aborted || lostControl) {
        // watcher 가 잡은 stance 를 그대로 싣는다. 없으면(=abort 가 다른 이유) 단정하지 않는다.
        const abortStance: ControlStance | null = watchedStance;
        if (abortStance === 'lost') enterOwnershipLent();
        if (abortStance !== 'lost' || !canAwaitOwnership) {
          debug.log('autopilot.control', 'yield', {
            step,
            ...(abortStance ? {
              stance: abortStance,
              ...supervisionObservationFields(mapControlStance(abortStance, 'halt')),
            } : {}),
            reason: abortStance ? yieldReason(abortStance, 'during-decide') : 'decide aborted — 사유 미상',
          });
          return finish({ kind: 'cancelled' }, step);
        }
        const ownershipWait = await awaitLostOwnership(step);
        if (ownershipWait.ended === 'resumed') {
          exitOwnershipLent();
          const overBudget = chargeResume();
          if (overBudget) return overBudget;
          continue;
        }
        const yieldStance = ownershipWait.stance;
        debug.log('autopilot.control', 'yield', {
          step,
          ...(yieldStance ? {
            stance: yieldStance,
            ...supervisionObservationFields(mapControlStance(yieldStance, 'halt')),
          } : {}),
          reason: yieldStance ? yieldReason(yieldStance, 'during-decide') : 'decide aborted — 사유 미상',
        });
        return finish({ kind: 'cancelled' }, step);
      }
      const decision = outcome.decision;
      unavailableAction = undefined;
      // ⭐결정 직후 소유권 재검사(review) — decide 가 250ms watcher 틱 前에 완료되면 그 사이 takeover 를
      // 놓쳐 done 을 success 로 확정할 수 있다. 여기서 재검사해 상실이면 결정 무시하고 cancelled.
      const postStance = controlStance();
      // Existing generic control-loop callers retain their historical input behavior unless
      // they explicitly opt into supervisor assist gating. Input-capable elanous children always
      // pass this config (including its default-disabled value) from their spawner.
      // ⚠️ **게이트는 명시 opt-in 일 때만 판정한다.** `deps.autoAssist` 가 있기만 하면 상담하면,
      //   CLI 가 기본값(`enabled:false`)을 항상 실어 보내므로 게이트가 **항상 거부**하고
      //   `elanous drive` 의 오랜 input 주입이 통째로 멈춘다 — 기본 OFF 가 "옛 동작" 이 아니라
      //   "새 동작" 이 되는 회귀다(리뷰 must-fix). 꺼져 있으면 아예 상담하지 않는다.
      const autoAssist = decision.action === 'input' && deps.autoAssist?.enabled === true
        ? decideAutoAssist({
          action: decision.action,
          stallRung: obs.stallRung ?? NO_STALL,
          minRung: deps.autoAssist.minRung,
          // ⚠️ 생존을 **추론하지 않는다** — 확인 수단이 없으면 `false` 로 두어 게이트가 거부한다
          //   (fail-closed). 이 경로는 opt-in 일 때만 도달하므로 기본 동작은 영향받지 않는다.
          childAlive: deps.isAlive ? deps.isAlive() : false,
          ownership: postStance,
          canReceiveInput: deps.canReceiveInput ?? false,
          canQueueSupervisorInput: false,
          enabled: deps.autoAssist.enabled,
        })
        : undefined;
      if (decision.action === 'input' && autoAssist && !autoAssist.assist) {
        debug.log('autopilot.control', 'input-outcome', {
          step, attempted: false, applied: false, why: autoAssist.why,
          canReceiveInput: deps.canReceiveInput ?? false,
        });
      }
      if (stanceBlocksWrite(postStance)) {
        if (postStance === 'lost') enterOwnershipLent();
        if (postStance !== 'lost' || !canAwaitOwnership) {
          debug.log('autopilot.control', 'yield', {
            step, stance: postStance, reason: yieldReason(postStance, 'post-decide'),
            ...supervisionObservationFields(mapControlStance(postStance, 'halt')),
          });
          return finish({ kind: 'cancelled' }, step);
        }
        const ownershipWait = await awaitLostOwnership(step);
        if (ownershipWait.ended === 'resumed') {
          exitOwnershipLent();
          const overBudget = chargeResume();
          if (overBudget) return overBudget;
          continue;
        }
        const yieldStance = ownershipWait.stance;
        debug.log('autopilot.control', 'yield', {
          step, stance: yieldStance, reason: yieldReason(yieldStance, 'post-decide'),
          ...supervisionObservationFields(mapControlStance(yieldStance, 'halt')),
        });
        return finish({ kind: 'cancelled' }, step);
      }
      // ⭐관측: 매 스텝의 관측(상태)⊕판단(행동)을 남긴다(ReAct 자기인지·전사 재구성).
      debug.log('autopilot.control', 'step', {
        step, state, changed, action: decision.action,
        ...(decision.action === 'no-progress' ? { reason: decision.reason, stallRung: obs.stallRung } : {}),
      });
      await deps.onStep?.(obs, decision);

      if (decision.action === 'handoff') {
        if (!deps.handoff) {
          unavailableAction = 'handoff: unavailable';
          debug.log('autopilot.control', 'action-unavailable', { step, action: decision.action });
        } else {
          await deps.handoff(decision, obs);
          debug.log('autopilot.control', 'handoff', { step, to: decision.to });
          return { ...finish({ kind: 'success', reason: `handoff:${decision.to}` }, step), handoff: decision };
        }
      } else if (decision.action === 'ask-human') {
        if (!deps.askHuman) {
          unavailableAction = 'ask-human: unavailable';
          debug.log('autopilot.control', 'action-unavailable', { step, action: decision.action });
        } else {
          await deps.askHuman(decision, obs);
          if (deps.isAlive?.() === false) return finish({ kind: 'stuck', iteration: step, reason: 'login PTY exited' }, step);
          prevNorm = null;
          previousIntervention = null;
          frameObs = INITIAL_FRAME_OBSERVATION;
          await sleep(pollMs);
          step += 1;
          continue;
        }
      } else if (decision.action === 'done') {
        const verification = deps.verifyDone ? await deps.verifyDone(obs) : { ok: true as const };
        debug.log('autopilot.control', 'verify-done', { ok: verification.ok });
        if (verification.ok) {
          return finish({ kind: 'success', reason: decision.reason }, step);
        }
        if (!deps.inject(verification.retry)) {
          debug.log('autopilot.control', 'yield', { step, reason: 'arbiter denied verify retry inject — 사람 takeover' });
          return finish({ kind: 'cancelled' }, step);
        }
        previousIntervention = { ...intervention, sameScreenCount: 1 };
      } else if (decision.action === 'input') {
        if (autoAssist && !autoAssist.assist) {
          // The refusal was observed before ownership could yield the loop.
        } else {
          let injected: boolean;
          try {
            injected = deps.inject(decision.text);
          } catch (error) {
            debug.log('autopilot.control', 'input-outcome', {
              step, attempted: true, applied: false, why: 'inject-error',
              canReceiveInput: deps.canReceiveInput ?? false,
              error: errMsg(error).slice(0, 120),
            });
            throw error;
          }
          if (autoAssist) {
            debug.log('autopilot.control', 'input-outcome', {
              step, attempted: true, applied: injected,
              why: injected ? autoAssist.why : 'arbiter-denied-inject',
              canReceiveInput: deps.canReceiveInput ?? false,
            });
          }
          if (!injected) {
            debug.log('autopilot.control', 'yield', { step, reason: 'arbiter denied inject — 사람 takeover' });
            return finish({ kind: 'cancelled' }, step);
          }
          previousIntervention = { ...intervention, sameScreenCount: 1 };
        }
      } else if (decision.action === 'key' || decision.action === 'mouse' || decision.action === 'resize') {
        const refusal = decision.action === 'key' ? !deps.injectKey ? 'injectKey unavailable' : undefined
          : decision.action === 'mouse' ? !deps.injectMouse ? 'injectMouse unavailable' : !(deps.mouseModeEnabled?.() ?? mouseMode.enabled) ? MOUSE_MODE_OFF_REASON : undefined
          : !deps.resize ? 'resize unavailable' : undefined;
        if (refusal) {
          unavailableAction = `${decision.action}: ${refusal}`;
          debug.log('autopilot.control', 'action-unavailable', { step, action: decision.action, reason: refusal });
        } else {
          const applied = decision.action === 'key' ? deps.injectKey!(decision.name, decision.repeat)
            : decision.action === 'mouse' ? deps.injectMouse!(decision)
            : deps.resize!(decision.cols, decision.rows);
          if (!applied) {
            debug.log('autopilot.control', 'yield', { step, reason: `arbiter denied ${decision.action} — 사람 takeover` });
            return finish({ kind: 'cancelled' }, step);
          }
          previousIntervention = { ...intervention, sameScreenCount: 1 };
        }
      } else if (decision.action === 'wait' || decision.action === 'no-progress') {
        if (decision.action === 'no-progress' && decision.terminal) {
          return finish({ kind: 'stuck', iteration: step, reason: decision.reason }, step, intervention, true);
        }
        // wait/no-progress — 종료된 자식은 새 출력을 낼 수 없으므로 대기 없이 즉시 수렴한다.
        if (deps.isAlive?.() === false) {
          debug.log('autopilot.control', 'child-exited', { step });
          return finish({ kind: 'stuck', iteration: step, reason: 'child exited' }, step);
        }
        if (intervention.recommendsStop) {
          return finish({
            kind: 'stuck',
            iteration: step,
            reason: `화면 무변화 ${intervention.sameScreenCount - 1} 연속`,
          }, step, intervention, true);
        }
      }
      prevNorm = norm;
      await sleep(pollMs);
      step += 1;
    } catch (e) {
      return finish({ kind: 'error', message: errMsg(e) }, step);
    }
  }
  return finish({ kind: 'budget', budget: 'iterations', observed: step, limit: maxSteps }, step);
}

/**
 * 실 PTY 핸들 → 제어 루프 deps. observe=renderScreen · inject=arbiter-gated 'agent' write
 * (canWrite 선제 확인 → 거부 시 false 반환 → 루프가 cancelled 로 yield). = P1(#1)·P2 조립점.
 */
export function controlDepsForRemoteRef(id: string, opts: {
  readonly actor: PtyWriteActor;
  readonly request?: typeof requestRemotePtyControl;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}): Pick<PtyControlDeps, 'observe' | 'inject' | 'controlStance' | 'isAlive'> {
  const request = opts.request ?? requestRemotePtyControl;
  const log = opts.log ?? ((event, data) => debug.log('autopilot.control', event, data));
  let stance: ControlStance = 'owned';
  let alive = true;
  const record = (result: { status: string; reason?: string }, event: string, data: Record<string, unknown>): void => {
    alive = result.status !== 'unknown-pty';
    log(event, { ptyId: id, status: result.status, ...(result.reason ? { reason: result.reason } : {}), ...data });
  };
  return {
    observe: async () => {
      const result = await request(id, 'snapshot');
      alive = result.status !== 'unknown-pty';
      if (result.status === 'success') return result.screen ?? '';
      record(result, 'remote-observe-failed', {});
      return '';
    },
    inject: (text: string): boolean => {
      void request(id, 'input-text', { chars: text }, { actor: opts.actor }).then((result) => {
        stance = result.status === 'success' ? 'owned' : result.status === 'denied' ? 'lost' : 'unknown';
        record(result, 'remote-inject', { bytes: Buffer.byteLength(text) });
      }).catch((error: unknown) => {
        stance = 'unknown';
        log('remote-inject', { ptyId: id, status: 'failed', reason: error instanceof Error ? error.message : String(error), bytes: Buffer.byteLength(text) });
      });
      return true;
    },
    controlStance: () => stance,
    isAlive: () => alive,
  };
}

export function controlDepsForHandle(handle: PtyHandle): Pick<PtyControlDeps, 'observe' | 'inject' | 'injectKey' | 'injectMouse' | 'resize' | 'mouseModeEnabled' | 'controlStance' | 'isAlive' | 'subjectPtyId'> {
  const injectAgent = (chars: string): boolean => {
    const stance = probeControlStance(handle, 'agent', (e) =>
      debug.log('autopilot.control', 'hascontrol-error', { ptyId: handle.id, at: 'inject-key', error: (e as Error)?.message ?? String(e) }));
    if (stanceBlocksWrite(stance)) return false;
    handle.write(chars, 'agent');
    return true;
  };
  return {
    subjectPtyId: handle.id,
    mouseModeEnabled: () => !mouseModeOffReason(handle),
    injectKey: (name, repeat = 1) => {
      if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > MAX_PTY_KEY_REPEAT) throw new Error(`key repeat must be between 1 and ${MAX_PTY_KEY_REPEAT}`);
      return injectAgent(resolvePtySpecialKey(name).repeat(repeat));
    },
    injectMouse: (input) => {
      // Check ownership before reporting mode: a human takeover must never be
      // mistaken for a recoverable "mouse unavailable" decision.
      if (stanceBlocksWrite(probeControlStance(handle, 'agent', (e) =>
        debug.log('autopilot.control', 'hascontrol-error', { ptyId: handle.id, at: 'inject-mouse', error: (e as Error)?.message ?? String(e) })))) return false;
      const off = mouseModeOffReason(handle);
      if (off) throw new Error(off);
      return injectAgent(encodeSgrMouse(input));
    },
    resize: (cols, rows) => {
      if (!Number.isSafeInteger(cols) || cols < 1 || !Number.isSafeInteger(rows) || rows < 1) throw new Error('invalid PTY size');
      if (stanceBlocksWrite(probeControlStance(handle, 'agent', (e) =>
        debug.log('autopilot.control', 'hascontrol-error', { ptyId: handle.id, at: 'resize', error: (e as Error)?.message ?? String(e) })))) return false;
      handle.resize(cols, rows);
      return true;
    },
    observe: () => handle.renderScreen(),
    // ⭐공용 seam 경유(P2b P-a′) — `canWrite` 직접 호출 금지. 여기와 driver·headless 가 같은 판정을 본다.
    //   ⚠️boolean 으로 접지 않는다 — 루프가 `unknown` 을 그대로 봐야 상실과 갈린다.
    //   ⚠️오류 훅을 반드시 넘긴다 — 없으면 예외가 조용히 `unknown` 으로만 접혀 **종전 `hascontrol-error`
    //   관측이 사라진다**(stance 를 살려도 원인이 사라지면 무회귀가 아니다).
    controlStance: () => probeControlStance(handle, 'agent', (e) =>
      debug.log('autopilot.control', 'hascontrol-error', { ptyId: handle.id, at: 'stance', error: (e as Error)?.message ?? String(e) })),
    isAlive: () => handle.isAlive(),
    inject: (text: string): boolean => {
      // ⚠️ 계약이 boolean 이라 stance 를 **반환**할 수는 없다. 그래도 **관측에서 잃지는 않는다**(리뷰 must-fix)
      //   — 종전엔 여기서 조회가 실패해도 `lost` 와 똑같은 false 였고 로그도 없었다.
      const stance = probeControlStance(handle, 'agent', (e) =>
        debug.log('autopilot.control', 'hascontrol-error', { ptyId: handle.id, at: 'inject', error: (e as Error)?.message ?? String(e) }));
      if (stanceBlocksWrite(stance)) {
        debug.log('autopilot.control', 'inject-blocked', { ptyId: handle.id, stance });
        return false; // 사람 takeover → yield 신호
      }
      handle.write(text, 'agent');
      return true;
    },
  };
}
