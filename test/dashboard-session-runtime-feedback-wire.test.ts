// ── 배선 스모크 (source-level wire pin) ───────────────────────────────────
//
// ⛔ 이 파일은 «행동»을 재지 않는다. 행동은 이미 두 곳에서 잰다:
//    · src/dashboard/session-runtime-feedback.ts        → test/dashboard-acp-dispatch-user-text.test.ts
//    · src/session-runtime/index.ts (emitFeedback 전달) → src/session-runtime/autonomous-tool-dispatch.test.ts
//
// 🎯 이 파일이 답하는 물음은 «다른 것»이다:
//    ***"그 코드가 진입점의 실행 경로에 «있는가»"***
//
// 📏 왜 여기서만 답할 수 있나 — `src/dashboard/index.ts` 의 그 호출은 TUI 부팅 함수 «안»의
//    ACP 콜백이라 in-process import 로는 실행할 수 없다. 그래서 행동 테스트는 helper 를
//    «직접» 부를 수밖에 없고, ***그러면 index 의 한 줄을 지워도 통과한다***(무인 리뷰 R2 지적 · 정확했다).
//    ⇒ 이 저장소의 정본 처방은 «실물 spawn» 또는 «source-level wire pin» 이다
//    (선례: test/nexus-multi-llm-wire-smoke.test.ts — PR #2079 의 한 줄 배선 버그가
//     ~6,000 LOC 를 silent dead-code 로 만들었고, 단위·통합 테스트는 «전부 통과»했다).
//
// ⭐ **Brittleness 가 의도다** — 이 배선을 건드리는 사람은 이 테스트를 밟는다.
//
// 🧪 그리고 「실행 경로에 있다」의 라이브 증거는 별도로 있다(PR 코멘트):
//    격리 TUI(pty_fdcbaec7)에 자연어를 주입하자 부모 채팅에 다음이 떴다 —
//      🔨 SelfImplement 시작 (수분 소요될 수 있음)…
//      goal-author ground started
//    ⇒ 종전엔 그 자리가 «616.858초 침묵 · 화면 줄 0» 이었다.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..');
const read = (rel: string): string => readFileSync(resolve(REPO, rel), 'utf8');

describe('dashboard → session-runtime 진행 엔벨로프 배선 (wire pin)', () => {
  const dashboard = read('src/dashboard/index.ts');
  const dispatchModule = read('src/dashboard/session-runtime-dispatch.ts');
  const sessionRuntime = read('src/session-runtime/index.ts');
  const orchestrator = read('src/self-implement/orchestrator.ts');
  const selfImplementSeams = read('src/self-implement/seams.ts');
  const headlessDriver = read('src/self-implement/headless-elanous-driver.ts');

  test('진입점이 dashboard 전용 디스패처를 import 한다', () => {
    expect(dashboard).toContain("from './session-runtime-dispatch.js'");
    expect(dashboard).toContain('dispatchDashboardSessionRuntimeTool');
  });

  test('진입점이 그 디스패처를 «부른다»', () => {
    expect(dashboard).toContain('await dispatchDashboardSessionRuntimeTool(name, args, {');
  });

  test('그 호출이 렌더 의존 셋을 «넘긴다» — 하나라도 빠지면 진행이 화면에 못 닿는다', () => {
    const callSite = dashboard.slice(
      dashboard.indexOf('await dispatchDashboardSessionRuntimeTool(name, args, {'),
    ).slice(0, 600);
    expect(callSite).toContain('muted: C.muted');
    expect(callSite).toContain('pushChatLine');
    expect(callSite).toContain('draw');
  });

  // ⛔ 우회 가드 — 진입점이 하위 러너를 «직접» 부르면 emitFeedback 이 붙지 않아
  //    ux.progress 가 조용히 no-op 이 된다. 그것이 이 PR 이 고친 결함 그 자체다.
  test('진입점이 하위 dispatchSessionRuntimeTool 을 «직접» 쓰지 않는다', () => {
    expect(dashboard).not.toContain('await dispatchSessionRuntimeTool(');
    expect(dashboard).not.toContain('dispatchSessionRuntimeTool(name, args');
  });

  test('dashboard 디스패처가 emitFeedback 을 «렌더러로» 채운다', () => {
    expect(dispatchModule).toContain('emitFeedback: createDashboardSessionRuntimeFeedback(');
    expect(dispatchModule).toContain('pushChatLine');
    expect(dispatchModule).toContain('draw');
  });

  test('session-runtime 이 그 carrier 를 자율툴 ctx 로 «전달»한다', () => {
    expect(sessionRuntime).toContain('emitFeedback');
    expect(sessionRuntime).toContain('feedbackCarrier');
    // 「넘길 것이 없어 못 그렸다」와 「진행이 실제로 없었다」를 다른 값으로 남긴다.
    expect(sessionRuntime).toContain("'unobservable'");
  });

  test('SelfImplement production implement 호출이 sparse 표면 진행을 기존 implementing progress relay로 잇는다', () => {
    // The implement arguments are hoisted into implementPromise; the timed await
    // follows later. Both anchors must exist before inspecting the wire between them.
    const implStart = orchestrator.indexOf('implementPromise = s.implement({');
    const implEnd = orchestrator.indexOf("await stepTimeout(implementPromise, T.implement, 'implement')");
    expect(implStart).toBeGreaterThan(0);
    expect(implEnd).toBeGreaterThan(implStart);
    const implementCall = orchestrator.slice(implStart, implEnd);
    // ⛔ 「빈 조각을 검사했다」를 「통과」로 읽지 않는다.
    expect(implementCall.length).toBeGreaterThan(0);
    expect(implementCall).toContain("onSurfaceProgress: (line) => progress('implementing', line.trimEnd())");
    expect(implementCall).toContain('onLifecycleScreenClassification: recordRoundClassification');
  });

  test('surface 전용 세 줄은 별도 seam으로 driver까지 가며 judge raw delta는 onProgress에 남는다', () => {
    expect(selfImplementSeams).toContain('onSurfaceProgress, onLifecycleScreenClassification');
    expect(selfImplementSeams).toContain('...(onSurfaceProgress ? { onSurfaceProgress } : {})');
    expect(selfImplementSeams).toContain('...(onProgress ? { onProgress } : {})');
    expect(headlessDriver).toContain('onSurfaceProgress?: (line: string) => void;');
    expect(headlessDriver).toContain("emitSurfaceProgress(formatBoundaryProgressLine(verdict), 'boundary')");
    expect(headlessDriver).toContain("emitSurfaceProgress(formatSupervisionProgressLine({");
    expect(headlessDriver).toContain("}), 'supervision')");
    // 🪞 2026-08-26 — 이 단언은 «인자를 한 줄에» 박아 뒀는데, 그 호출이 ***여러 줄로 접혔고***
    //   인자도 늘었다(lastCommandFirstToken · toolCalls · chars · previous*).
    //   ⇒ 늙은 것은 계약이 아니라 «문면»이다 — 형제 둘(`supervision`)이 이미 쓰는
    //     ***「여는 줄 ⊕ 닫는 줄」*** 방식으로 맞춘다. 인자가 더 늘어도 안 깨진다.
    expect(headlessDriver).toContain("emitSurfaceProgress(formatFrameStallProgressLine({");
    expect(headlessDriver).toContain("}), 'frame-stall')");
    // ⛔⭐ 그러면 「무엇을 넘기나」가 느슨해지므로 ***핵심 인자 둘***은 이름으로 못 박는다 —
    //   사다리 칸(previousRung → currentRung)이 이 줄의 «요점»이고, 그게 빠지면 진행 표시가 의미를 잃는다.
    expect(headlessDriver).toMatch(/formatFrameStallProgressLine\(\{[\s\S]{0,300}?previousRung:\s*previousStallRung/);
    expect(headlessDriver).toMatch(/formatFrameStallProgressLine\(\{[\s\S]{0,300}?currentRung:\s*st\.rung/);
    expect(headlessDriver).toContain('try { opts.onProgress?.(delta); } catch { /* fail-soft */ }');
  });

  test('표면 callback 부재와 전용 줄 부재를 다른 관측 상태로 남긴다', () => {
    expect(headlessDriver).toContain("status: 'surface-callback-unwired'");
    expect(headlessDriver).toContain("status: 'no-surface-line'");
    expect(headlessDriver).toContain('callbackWired: opts.onSurfaceProgress !== undefined');
  });

  test('PTY lifecycle는 spawned·stalled만, completion은 exit를 각각 한 줄씩 안전하게 렌더링한다', () => {
    const completion = dashboard.slice(
      dashboard.indexOf('const unsubDone = onPtyCompletion((info) => {'),
      dashboard.indexOf('const unsubBus = onPtyEvent((ev) => {'),
    );
    const subscription = dashboard.slice(
      dashboard.indexOf('const unsubBus = onPtyEvent((ev) => {'),
      dashboard.indexOf("process.once('beforeExit'", dashboard.indexOf('const unsubBus = onPtyEvent((ev) => {')),
    );
    expect(completion).toContain('chatLines.push(C.muted(formatPtyCompletion(info)))');
    expect(completion).toContain('draw();');
    expect(completion).toContain('catch { /* noop */ }');
    expect(subscription).toContain("ev.type === 'spawned'");
    expect(subscription).toContain('chatLines.push(C.muted(`▶ ${ev.id} spawned`))');
    expect(subscription).toContain("ev.type === 'stalled'");
    expect(subscription).toContain('chatLines.push(C.warning(`⚡ ${ev.id} stalled (${sec}s silent)`))');
    expect(subscription).not.toContain("ev.type === 'exit'");
    expect(subscription).not.toContain("ev.type === 'output'");
    expect(subscription).toContain('else {\n          return;');
    expect(subscription).toContain('draw();');
    expect(subscription).toContain('catch { /* noop */ }');
  });
});
