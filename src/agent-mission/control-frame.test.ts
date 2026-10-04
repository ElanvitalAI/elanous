// U5(감독 통일 seam) — ReAct 제어루프 화면 → 통일 SelfReportFrame 버스 발행 검증.
//   #5379 는 headless/TUI 만 발행 → agent-mission 의 runPtyControlLoop 은 미발행이던 갭을 닫음.
//   실 ChannelBus 로 구독→발행→수신(headless 와 동일 버스·surfaceId=exec:<ptyId>).

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelBus } from '../terminal-matrix/channel-bus.js';
import { subscribeSurfaceFrames, subscribeAllFrames, type SelfReportFrame } from '../capture/self-report-frame.js';
import { execSurfaceId } from '../self-implement/executor-contract.js';
import { publishControlObservationFrame, makeMissionObserveStep, createMissionControlBrain } from './driver.js';
import { observeSurfaceFromBus, type ControlObserveDigest } from '../capture/control-observe-adapter.js';
import { classifyFrameState } from '../capture/frame-state-detect.js';
import { runPtyControlLoop, type ControlObservation, type ControlDecision, type RunSupervisor } from '../autopilot/pty-control-loop.js';
import { decideInterventionStep } from '../self-implement/intervention-step.js';

const OBS = (screen: string, step = 1): ControlObservation => ({
  screen,
  step,
  state: 'working' as never,
  intervention: decideInterventionStep({
    screen,
    previous: null,
    stopAfterSameScreens: 2,
    descriptor: { level: 'L3', controlStance: 'owned', draft: 'continue' },
  }),
  changed: true,
});
const DEC: ControlDecision = { action: 'wait' };

describe('mission brain screen progress', () => {
  it('the same choice question on an advancing screen does not trigger recovery', async () => {
    const actions: string[] = [];
    const brain = createMissionControlBrain({
      mission: 'Build', evidenceReady: () => false, search: () => {}, recoverAfterMs: 40_000,
      stream: async () => '{"action":"wait"}', onRecover: (_blocked, action) => { actions.push(action); },
    });
    for (let step = 0; step < 4; step++) {
      expect(await brain.decide({ ...OBS(`progress ${step}\nProceed? [y/N]`, step), sameScreenMs: 0 })).toEqual({ action: 'wait' });
    }
    expect(actions).toEqual([]);
  });
});

describe('publishControlObservationFrame — 제어루프 관측 → 프레임 버스(U5)', () => {
  it('surface 구독자가 executor 프레임 수신(surfaceId=exec:<ptyId>·text=screen·runId join)', () => {
    const bus = new ChannelBus();
    const got: SelfReportFrame[] = [];
    subscribeSurfaceFrames(bus, execSurfaceId('pty-42'), (f) => got.push(f));
    publishControlObservationFrame(bus, { screen: '자식 화면\n두 줄' }, { ptyId: 'pty-42', instance: 'test-inst', at: 1000, runId: 'run-7' });
    expect(got.length).toBe(1);
    expect(got[0]!.surfaceId).toBe('exec:pty-42');
    expect(got[0]!.text).toBe('자식 화면\n두 줄');
    expect(got[0]!.runId).toBe('run-7');
    expect(got[0]!.instance).toBe('test-inst');
  });

  it('aggregate fleet 채널(tui-observe-fleet)에도 발행 — fleet/observatory/G5 구독자 관측', () => {
    const bus = new ChannelBus();
    const got: SelfReportFrame[] = [];
    subscribeAllFrames(bus, (f) => got.push(f));
    publishControlObservationFrame(bus, { screen: 'X' }, { ptyId: 'p1', instance: 'i', at: 5 });
    expect(got.map((f) => f.surfaceId)).toContain('exec:p1');
  });

  it('runId 없으면 프레임에 runId 필드 생략(K4 serialization round-trip 계약)', () => {
    const bus = new ChannelBus();
    const got: SelfReportFrame[] = [];
    subscribeSurfaceFrames(bus, execSurfaceId('p2'), (f) => got.push(f));
    publishControlObservationFrame(bus, { screen: 'Y' }, { ptyId: 'p2', instance: 'i', at: 5 });
    expect(got[0]!.runId).toBeUndefined();
  });
});

describe('makeMissionObserveStep — onStep 발행 + capture semantics 보존', () => {
  // keyframe 캡처는 writeKeyframePng 가 ELANOUS_STATE_DIR 하위에 실 파일을 쓴다 → temp 로 스코프 + 정리(리뷰:
  //   테스트 아티팩트 누수 방지·실 홈 오염 회피). 비-keyframe 테스트엔 무해.
  let stateDir = '';
  let prevStateDir: string | undefined;
  beforeEach(() => {
    prevStateDir = process.env.ELANOUS_STATE_DIR;
    stateDir = mkdtempSync(join(tmpdir(), 'kf-test-'));
    process.env.ELANOUS_STATE_DIR = stateDir;
  });
  afterEach(() => {
    if (prevStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = prevStateDir;
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  });

  it('onStep 이 프레임을 발행하고 capture 를 호출', async () => {
    const bus = new ChannelBus();
    const got: SelfReportFrame[] = [];
    subscribeSurfaceFrames(bus, execSurfaceId('pty-x'), (f) => got.push(f));
    let captured: string | undefined;
    const onStep = makeMissionObserveStep({
      capture: async (label) => { captured = label; },
      bus, ident: { ptyId: 'pty-x', instance: 'inst', runId: 'r1' }, now: () => 42,
    });
    await onStep(OBS('제어 화면', 3), { action: 'input', text: 'go' });
    expect(got.length).toBe(1);
    expect(got[0]!.text).toBe('제어 화면');
    expect(captured).toBe('s3-input');
  });

  it('상태 전이에서만 PNG를 캡처하고 pngRef를 프레임에 스탬프한다', async () => {
    const bus = new ChannelBus();
    const got: SelfReportFrame[] = [];
    subscribeSurfaceFrames(bus, execSurfaceId('pty-kf'), (f) => got.push(f));
    let renders = 0;
    const onStep = makeMissionObserveStep({
      capture: async () => {},
      renderPng: async () => { renders += 1; return Buffer.from('png'); },
      bus, ident: { ptyId: 'pty-kf', instance: 'inst', runId: 'run-kf' }, now: () => 42,
    });
    // classifyFrameState 는 화면 텍스트를 본다 — 'esc to interrupt'=working(전이). 같은 상태 2회 → 첫 회만 캡처.
    await onStep(OBS('building... esc to interrupt'), DEC);
    await onStep(OBS('still building... esc to interrupt', 2), DEC);
    expect(renders).toBe(1);
    expect(got[0]!.pngRef).toContain('kf-run_kf-pty_kf-000-working.png');
    expect(existsSync(got[0]!.pngRef!)).toBe(true); // pngRef 는 실제로 디스크에 영속화된 파일을 가리킨다(리뷰)
    expect(got[1]!.pngRef).toBeUndefined();
  });

  it('renderPng가 null이면 프레임 발행은 유지하고 pngRef를 생략한다', async () => {
    const bus = new ChannelBus();
    const got: SelfReportFrame[] = [];
    subscribeSurfaceFrames(bus, execSurfaceId('pty-null'), (f) => got.push(f));
    const onStep = makeMissionObserveStep({
      capture: async () => {},
      renderPng: async () => null,
      bus, ident: { ptyId: 'pty-null', instance: 'inst', runId: 'run-null' }, now: () => 42,
    });
    // working 전이 → renderPng 호출되나 null 반환 → 프레임 발행은 유지하고 pngRef 생략(null 경로 실검증).
    await onStep(OBS('building... esc to interrupt'), DEC);
    expect(got).toHaveLength(1);
    expect(got[0]!.pngRef).toBeUndefined();
  });

  it('발행 우선 — capture 예외는 원래대로 전파(semantics 불변)하되 프레임은 이미 발행됨', async () => {
    const bus = new ChannelBus();
    const got: SelfReportFrame[] = [];
    subscribeSurfaceFrames(bus, execSurfaceId('pty-y'), (f) => got.push(f));
    const onStep = makeMissionObserveStep({
      capture: async () => { throw new Error('renderScreen 실패'); },
      bus, ident: { ptyId: 'pty-y', instance: 'inst' }, now: () => 7,
    });
    // capture 실패는 삼키지 않고 전파(EMIT seam 이 기존 계약 안 바꿈) — 단 발행이 먼저라 프레임은 유실 안 됨.
    await expect(onStep(OBS('화면'), DEC)).rejects.toThrow('renderScreen 실패');
    expect(got.length).toBe(1);
  });
});

describe('제어루프 경유 발행(behavior) — 실 runPtyControlLoop 이 onStep 을 호출해 프레임 발행', () => {
  // factory 직접호출이 아니라 **실제 제어루프**에 onStep(makeMissionObserveStep)을 주입해 구동 →
  // 루프가 onStep 을 호출하고 그 결과 프레임이 버스에 실제로 실림을 검증(DI behavior·onStep 미호출 시 실패).
  it('runPtyControlLoop 이 매 스텝 onStep 을 호출 → executor 프레임이 버스에 발행됨', async () => {
    const bus = new ChannelBus();
    const got: SelfReportFrame[] = [];
    subscribeSurfaceFrames(bus, execSurfaceId('pty-loop'), (f) => got.push(f));
    const brain: RunSupervisor = { decide: () => ({ action: 'done', reason: 'ok' }) };
    await runPtyControlLoop(brain, {
      observe: () => 'loop 화면',
      inject: () => true,
      verifyDone: () => ({ ok: true }),
      onStep: makeMissionObserveStep({ capture: async () => {}, bus, ident: { ptyId: 'pty-loop', instance: 'i' }, now: () => 1 }),
    }, { maxSteps: 3 });
    expect(got.length).toBeGreaterThanOrEqual(1); // 루프가 onStep 호출 → 프레임 발행(배선 제거 시 0)
    expect(got[0]!.text).toBe('loop 화면');
    expect(got[0]!.surfaceId).toBe('exec:pty-loop');
  });

  // behavior 테스트는 loop→onStep→frame 을 증명하나, runAgentMission 이 그 factory 를 배선했는지는
  // 별개 링크 → source 가드로 production wiring 회귀를 잡는다(둘이 합쳐 전 경로 커버).
  it('배선 가드 — runAgentMission 이 onStep: makeMissionObserveStep 을 배선(production wiring)', async () => {
    const src = await Bun.file(new URL('./driver.ts', import.meta.url)).text();
    // The step is built once (`const observeStep = makeMissionObserveStep(`) and awaited first inside onStep.
    expect(src).toContain('const observeStep = makeMissionObserveStep(');
    expect(src).toMatch(/onStep: async \(obs, decision\) => \{\n\s+await observeStep\(obs, decision\);/);
  });
});

describe('P3b-2 observe 어댑터 합성(behavior) — EMIT(onStep) + observe 어댑터 실동작', () => {
  // ⚠️ 범위(정직): 이건 runAgentMission **전체 통합**이 아니라, 그것이 배선하는 두 조각
  //   (makeMissionObserveStep 발행 · observeSurfaceFromBus 구독)의 **합성 계약**을 실동작으로 검증한다.
  //   실 함수 배선(driver.ts 가 이 둘을 실제로 연결·로그 sink)은 아래 별도 소스 tripwire 로 회귀만 가드.
  it('제어루프 onStep 발행 → observe sink 에 다이제스트 도달(surfaceId·summary·state)', async () => {
    const bus = new ChannelBus();
    const digests: ControlObserveDigest[] = [];
    const sess = observeSurfaceFromBus(bus, execSurfaceId('pty-z'), (d) => digests.push(d), { minIntervalMs: 3000 });
    const onStep = makeMissionObserveStep({
      capture: async () => {},
      bus, ident: { ptyId: 'pty-z', instance: 'i', runId: 'r1' }, now: () => 1000,
    });
    await onStep(OBS('작업 진행중\n마지막 줄', 1), { action: 'wait' });
    expect(digests.length).toBe(1);
    expect(digests[0]!.surfaceId).toBe('exec:pty-z');
    expect(digests[0]!.summary).toBe('마지막 줄');
    expect(digests[0]!.state).toBe(classifyFrameState('작업 진행중\n마지막 줄').state); // state 명시 검증
    expect(digests[0]!.runId).toBe('r1');
    // 정리(cleanup) 동작 — stop 후 발행 프레임은 sink 에 안 온다.
    sess.stop();
    await onStep(OBS('그 다음 화면', 2), { action: 'wait' });
    expect(digests.length).toBe(1);
  });

  // 배선 회귀 가드 — 합성 behavior 는 두 조각 결합을, 이 tripwire 는 "driver.ts 가 실제로 runWithControlObserve
  //   seam 으로 제어루프를 감싸고 observe 로그 sink 를 배선했나"를 가드(runAgentMission 전체는 실 backend
  //   spawn 필요라 seam DI 테스트 + 합성 + 이 tripwire 3중으로 커버).
  it('배선 tripwire — runAgentMission 이 runWithControlObserve 로 제어루프를 감싸 observe 를 배선', async () => {
    const src = await Bun.file(new URL('./driver.ts', import.meta.url)).text();
    expect(src).toContain('runWithControlObserve(');            // seam 으로 래핑
    expect(src).toContain('execSurfaceId(h.id)');               // 이 미션 PTY surface 구독
    expect(src).toContain("'agent-mission.observe'");           // observe 로그 sink
    expect(src).toContain('unknownInput: d.unknownInput');      // unknown 진단 입력도 로그 sink 로 전파
    expect(src).toContain('expectRunId: runId');                // run 필터 배선(타 run 혼입 방지)
  });
});
