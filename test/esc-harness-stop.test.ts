import { expect, test } from 'bun:test';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import * as escGate from '../src/esc-abort-gate.js';
import * as controlInbox from '../src/harness/control-inbox.js';
import * as dashboardIndex from '../src/dashboard/index.js';
import { SELF_IMPLEMENT_TOOL_NAMES } from '../src/boot/daemon-tools/self-implement-names.js';

// Test-only fixture builder for the three gate-contract tests below: it
// assembles the production `createEscAbortGate` with plain test deps. It
// duplicates no stop/pending logic (that seam is covered by the incident
// tests via `createEscAbortPendingGate`), so it stays.
function gateForHarness(identified: boolean) {
  const abortCtrl = new AbortController();
  const pending: number[] = [];
  const mounted: string[] = [];
  const gate = escGate.createEscAbortGate({
    abortCtrl,
    getRunningCount: () => 2,
    shouldAbortImmediately: () => identified,
    mountModal: (surface) => { mounted.push(surface.id); return () => {}; },
    getViewport: () => ({ cols: 80, rows: 24 }),
    requestRedraw: () => {},
    onAbortPending: ({ running }) => { pending.push(running); },
  });
  return { gate, abortCtrl, pending, mounted };
}

test('clarification window consumes Escape first, invokes its close notification and leaves the running turn alone', () => {
  const ctx = gateForHarness(true);
  const called: string[] = [];
  const consumed = escGate.consumeStreamingTopModalEscape({
    modal: { id: 'clarification' },
    abortGateModalId: null,
    event: { name: 'escape' } as never,
    question: { id: 'clarification', dispose: () => { called.push('closed'); }, isClarification: true },
    onClarificationClosed: () => { called.push('되묻기 창을 닫았다 — 답 없이 진행한다'); },
    topModalId: () => null,
    redraw: () => { called.push('draw'); },
  });
  expect(consumed).toBe(true);
  expect(called).toEqual(['closed', '되묻기 창을 닫았다 — 답 없이 진행한다', 'draw']);
  expect(ctx.abortCtrl.signal.aborted).toBe(false);
  expect(ctx.pending).toEqual([]);
  ctx.gate.dispose();
});

test('one Escape immediately aborts the foreground turn for an identified harness run even with running agents', () => {
  const ctx = gateForHarness(true);
  ctx.gate.handleEscape();
  expect(ctx.abortCtrl.signal.aborted).toBe(true);
  expect(ctx.pending).toEqual([2]);
  expect(ctx.mounted).toEqual([]);
  expect(ctx.gate.isGateOpen()).toBe(false);
  ctx.gate.dispose();
});

test('other turns with running agents still open the existing confirmation dialog', () => {
  const ctx = gateForHarness(false);
  ctx.gate.handleEscape();
  expect(ctx.abortCtrl.signal.aborted).toBe(false);
  expect(ctx.pending).toEqual([]);
  expect(ctx.mounted).toHaveLength(1);
  expect(ctx.gate.isGateOpen()).toBe(true);
  ctx.gate.dispose();
});

// TUI-ESC-EXIT named incident scenario — exercises the real gate
// (createEscAbortGate / routeStreamingEscapeKey) and the real production
// onAbortPending seam (`createEscAbortPendingGate`, which drives
// `runEscAbortPendingSoftStop` exported from src/dashboard/index.ts);
// no gate/stop-logic copies, no source checks.
const withIncidentInbox = async (
  run: (inboxDir: string) => Promise<void>,
): Promise<void> => {
  const inboxDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'esc-incident-inbox-'));
  const prev = process.env[controlInbox.CONTROL_INBOX_DIR_ENV];
  process.env[controlInbox.CONTROL_INBOX_DIR_ENV] = inboxDir;
  try {
    await run(inboxDir);
  } finally {
    if (prev === undefined) delete process.env[controlInbox.CONTROL_INBOX_DIR_ENV];
    else process.env[controlInbox.CONTROL_INBOX_DIR_ENV] = prev;
    try { nodeFs.rmSync(inboxDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
};

const countAborts = (abortCtrl: AbortController): (() => number) => {
  let abortCount = 0;
  const orig = abortCtrl.abort.bind(abortCtrl);
  abortCtrl.abort = () => { abortCount += 1; orig(); };
  return () => abortCount;
};

test('TUI-ESC-EXIT: 식별된 포그라운드 하니스 스페이스에서 실제 ESC 라우팅과 production 콜백이 stop 마커 1회·중단 라인·abort 1회를 남긴다', async () => {
  await withIncidentInbox(async () => {
    const SPACE = `esc-incident-${Date.now().toString(36)}`;
    const abortCtrl = new AbortController();
    const aborts = countAborts(abortCtrl);
    const chatLines: string[] = [];
    const mounted: string[] = [];
    const spacesByCallId = new Map<string, string>([['call-1', SPACE]]);
    const incidentToolState = dashboardIndex.createEscAbortToolState();
    dashboardIndex.trackEscAbortToolCall(incidentToolState, {
      id: 'call-1',
      name: SELF_IMPLEMENT_TOOL_NAMES[0] as string,
    });
    const getActiveHarnessSpace = (): string | null =>
      dashboardIndex.activeEscHarnessSpace(incidentToolState, spacesByCallId);
    const pendingGate = escGate.createEscAbortPendingGate({
      runSoftStop: dashboardIndex.runEscAbortPendingSoftStop,
      formatWaitingTargets: dashboardIndex.formatEscAbortWaitingTargets,
      getActiveHarnessSpace,
      pushChatLine: (line) => chatLines.push(line),
      showHarnessEscHint: () => false,
    });
    const gate = escGate.createEscAbortGate({
      abortCtrl,
      getRunningCount: () => 1,
      mountModal: (surface) => { mounted.push(surface.id); return () => {}; },
      getViewport: () => ({ cols: 80, rows: 24 }),
      getWaitingTargetNames: () => [SELF_IMPLEMENT_TOOL_NAMES[0] as string],
      shouldAbortImmediately: () => getActiveHarnessSpace() !== null,
      onAbortPending: pendingGate.onAbortPending,
      onAbortRepeat: pendingGate.onAbortRepeat,
    });
    const consumed = await escGate.routeStreamingEscapeKey(
      { name: 'escape', kind: 'press' },
      gate,
      { name: 'escape' },
      async () => false,
    );
    expect(consumed).toBe(true);
    expect(abortCtrl.signal.aborted).toBe(true);
    expect(aborts()).toBe(1);
    expect(mounted.length).toBe(0);
    expect(controlInbox.readSoftStopRequestStatus(SPACE).status).toBe('present');
    expect(pendingGate.getStoppedHarnessSpace()).toBe(SPACE);
    expect(chatLines.some((line) => line.includes('⏹ 멈췄다 — 해당 하니스 런에 중단 요청을 보냈습니다.'))).toBe(true);
    expect(chatLines.some((line) => line.includes('⚠ 하니스 런 중단 요청을 보내지 못했습니다'))).toBe(false);
    // ⭐ retained stopped space: later non-success callbacks must not clear it.
    pendingGate.onAbortPending({ running: 1, repeat: 0, targets: ['sub-agent-a'] });
    pendingGate.onAbortRepeat({ running: 1, repeat: 1, targets: ['sub-agent-a'], phase: 'pending' });
    expect(pendingGate.getStoppedHarnessSpace()).toBe(SPACE);
    expect(chatLines.some((line) => line.startsWith('  ⏳ ESC 재시도 '))).toBe(false);
  });
});

test('TUI-ESC-EXIT: 실제 두 활성 런(no active space) 경로는 확인 모달을 열고 stop 마커를 남기지 않는다', async () => {
  await withIncidentInbox(async () => {
    const SPACE_A = `esc-incident-multi-a-${Date.now().toString(36)}`;
    const SPACE_B = `esc-incident-multi-b-${Date.now().toString(36)}`;
    const abortCtrl = new AbortController();
    const aborts = countAborts(abortCtrl);
    const chatLines: string[] = [];
    const mounted: string[] = [];
    // 실제 2-런 상태: run마다 실제 createEscAbortToolState 로 만들고,
    // 서로 다른 활성 harness space 두 개를 등록해 activeEscHarnessSpace 가
    // 진짜 null 을 반환한다(공석이 아닌 실측).
    const multiToolState = dashboardIndex.createEscAbortToolState();
    dashboardIndex.trackEscAbortToolCall(multiToolState, {
      id: 'call-a', name: SELF_IMPLEMENT_TOOL_NAMES[0] as string,
    });
    dashboardIndex.trackEscAbortToolCall(multiToolState, {
      id: 'call-b', name: SELF_IMPLEMENT_TOOL_NAMES[0] as string,
    });
    const spacesByCallId = new Map<string, string>([
      ['call-a', SPACE_A],
      ['call-b', SPACE_B],
    ]);
    const getActiveHarnessSpace = (): string | null =>
      dashboardIndex.activeEscHarnessSpace(multiToolState, spacesByCallId);
    expect(getActiveHarnessSpace()).toBe(null);
    let onAbortPendingCalls = 0;
    const pendingGate = escGate.createEscAbortPendingGate({
      runSoftStop: dashboardIndex.runEscAbortPendingSoftStop,
      formatWaitingTargets: dashboardIndex.formatEscAbortWaitingTargets,
      getActiveHarnessSpace,
      pushChatLine: (line) => chatLines.push(line),
      showHarnessEscHint: () => false,
      afterAbortEvent: () => { onAbortPendingCalls += 1; },
    });
    const gate = escGate.createEscAbortGate({
      abortCtrl,
      getRunningCount: () => 2,
      mountModal: (surface) => { mounted.push(surface.id); return () => {}; },
      getViewport: () => ({ cols: 80, rows: 24 }),
      getWaitingTargetNames: () => ['sub-agent-a', 'sub-agent-b'],
      shouldAbortImmediately: () => getActiveHarnessSpace() !== null,
      onAbortPending: pendingGate.onAbortPending,
      onAbortRepeat: pendingGate.onAbortRepeat,
    });
    const consumed = await escGate.routeStreamingEscapeKey(
      { name: 'escape', kind: 'press' },
      gate,
      { name: 'escape' },
      async () => false,
    );
    expect(consumed).toBe(true);
    expect(mounted.length).toBe(1);
    expect(abortCtrl.signal.aborted).toBe(false);
    expect(onAbortPendingCalls).toBe(0);
    expect(controlInbox.readSoftStopRequestStatus(SPACE_A).status).toBe('absent');
    expect(controlInbox.readSoftStopRequestStatus(SPACE_B).status).toBe('absent');
    gate.handleKey({ name: 'y' } as unknown as Parameters<typeof gate.handleKey>[0]);
    await new Promise<void>((resolve) => { setTimeout(resolve, 30); });
    expect(abortCtrl.signal.aborted).toBe(true);
    expect(aborts()).toBe(1);
    expect(onAbortPendingCalls).toBe(1);
    expect(pendingGate.getStoppedHarnessSpace()).toBe(null);
    expect(chatLines.some((line) => line.startsWith('  ⏳ 중단 요청됨 — '))).toBe(true);
    expect(chatLines.some((line) => line.includes('⏹ 멈췄다'))).toBe(false);
    expect(controlInbox.readSoftStopRequestStatus(SPACE_A).status).toBe('absent');
    expect(controlInbox.readSoftStopRequestStatus(SPACE_B).status).toBe('absent');
    // no active space ⇒ teardown settle path converts the pending waiting line.
    dashboardIndex.settleEscAbortPendingLines(chatLines, 0);
    expect(chatLines.some((line) => line.startsWith('  ⏳ 중단 요청됨 — '))).toBe(false);
  });
});

// TUI-ESC-EXIT Goodhart 가드 — 양성 판정('present')은 오직 «그» 스페이스의
// 인박스에 실린 마커로만 나와야 한다. 격리 ELANOUS_STATE_DIR 안에서
// ELANOUS_CONTROL_INBOX_DIR 를 비운 뒤 실측하고, 환경변수는 원복한다.
test('TUI-ESC-EXIT: 스페이스별 인박스 경로는 서로 달라야 하고 엉뚱한 스페이스의 stop 마커는 양성 판정을 내리지 못한다', () => {
  const prevInbox = process.env[controlInbox.CONTROL_INBOX_DIR_ENV];
  const prevStateDir = process.env.ELANOUS_STATE_DIR;
  const stateDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'esc-incident-state-'));
  process.env.ELANOUS_STATE_DIR = stateDir;
  delete process.env[controlInbox.CONTROL_INBOX_DIR_ENV];
  try {
    const SPACE_A = `esc-goodhart-a-${Date.now().toString(36)}`;
    const SPACE_B = `esc-goodhart-b-${Date.now().toString(36)}`;
    const inboxA = controlInbox.controlInboxPath(SPACE_A);
    const inboxB = controlInbox.controlInboxPath(SPACE_B);
    expect(inboxA).not.toBe(inboxB);
    expect(controlInbox.readSoftStopRequestStatus(SPACE_A).status).toBe('absent');
    // wrong-space marker: B 의 인박스에 실린 마커는 A 의 양성 판정을 만들면 안 된다.
    nodeFs.mkdirSync(inboxB, { recursive: true });
    nodeFs.writeFileSync(
      nodePath.join(inboxB, 'stop-requested.json'),
      `${JSON.stringify({ version: 1, requestedAt: new Date().toISOString() })}\n`,
      { encoding: 'utf8' },
    );
    expect(controlInbox.readSoftStopRequestStatus(SPACE_A).status).toBe('absent');
    expect(controlInbox.readSoftStopRequestStatus(SPACE_B).status).toBe('present');
    // positive case: A 에 실제 enqueueSoftStop 을 하면 A 만 'present' 가 된다.
    controlInbox.enqueueSoftStop(SPACE_A);
    expect(controlInbox.readSoftStopRequestStatus(SPACE_A).status).toBe('present');
    expect(controlInbox.readSoftStopRequestStatus(SPACE_B).status).toBe('present');
  } finally {
    if (prevInbox === undefined) delete process.env[controlInbox.CONTROL_INBOX_DIR_ENV];
    else process.env[controlInbox.CONTROL_INBOX_DIR_ENV] = prevInbox;
    if (prevStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = prevStateDir;
    try { nodeFs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});