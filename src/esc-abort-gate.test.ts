import { expect, test } from 'bun:test';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { createEscAbortPendingGate, type EscAbortPendingSoftStopOutcomeLike, type EscAbortPendingSoftStopRunnerDeps } from '../src/esc-abort-gate.js';
import * as controlInbox from '../src/harness/control-inbox.js';
import * as dashboardIndex from '../src/dashboard/index.js';
import { SELF_IMPLEMENT_TOOL_NAMES } from '../src/boot/daemon-tools/self-implement-names.js';

// ⭐ TUI-ESC-EXIT production seam tests — these drive the real
// `createEscAbortPendingGate` helper that `attachChatStreamingKeys` wires
// into `createEscAbortGate`, with a scripted soft-stop runner so successive
// callback outcomes can be forced in one test.

test('onAbortPending gate keeps the earlier successful stopped space across later waiting and hint callbacks', () => {
  const SPACE_A = 'gate-space-a';
  const lines: string[] = [];
  const hintTargets: string[][] = [];
  const script: EscAbortPendingSoftStopOutcomeLike[] = [
    { outcome: 'stopped', stoppedHarnessSpace: SPACE_A },
    { outcome: 'waiting', stoppedHarnessSpace: null },
    { outcome: 'hint', stoppedHarnessSpace: null },
    { outcome: 'failed', stoppedHarnessSpace: null },
  ];
  let step = 0;
  const gate = createEscAbortPendingGate({
    runSoftStop: (targets: readonly string[], deps: EscAbortPendingSoftStopRunnerDeps) => {
      const outcome = script[step];
      step += 1;
      if (outcome.outcome === 'hint') {
        // mimic the production runner: hint consumed → no waiting line
        if (deps.showHarnessEscHint(targets)) return { outcome: 'hint', stoppedHarnessSpace: null };
        return { outcome: 'waiting', stoppedHarnessSpace: null };
      }
      if (outcome.outcome === 'failed') {
        deps.pushChatLine('  ⚠ 하니스 런 중단 요청을 보내지 못했습니다 (실험)');
      }
      return outcome;
    },
    formatWaitingTargets: dashboardIndex.formatEscAbortWaitingTargets,
    getActiveHarnessSpace: () => SPACE_A,
    pushChatLine: (line) => lines.push(line),
    showHarnessEscHint: (targets) => { hintTargets.push([...targets]); return step === 3; },
  });

  gate.onAbortPending({ running: 1, repeat: 0, targets: [SELF_IMPLEMENT_TOOL_NAMES[0] as string] });
  expect(gate.getStoppedHarnessSpace()).toBe(SPACE_A);

  // waiting callback — must NOT clear the successful space (old inline
  // wrapper assigned null here and lost the marker).
  gate.onAbortPending({ running: 1, repeat: 0, targets: ['sub-agent-a'] });
  expect(gate.getStoppedHarnessSpace()).toBe(SPACE_A);
  expect(lines.some((line) => line.startsWith('  ⏳ 중단 요청됨 — '))).toBe(true);

  // hint outcome — hint line consumed, no extra waiting line, space kept.
  const linesBeforeHint = lines.length;
  gate.onAbortPending({ running: 1, repeat: 0, targets: [SELF_IMPLEMENT_TOOL_NAMES[0] as string] });
  expect(gate.getStoppedHarnessSpace()).toBe(SPACE_A);
  expect(lines.length).toBe(linesBeforeHint);
  expect(hintTargets.length).toBe(1);

  // failed callback — failure line painted, space still kept.
  gate.onAbortPending({ running: 1, repeat: 0, targets: ['sub-agent-a'] });
  expect(gate.getStoppedHarnessSpace()).toBe(SPACE_A);
  expect(lines.some((line) => line.includes('⚠ 하니스 런 중단 요청을 보내지 못했습니다'))).toBe(true);

  // onAbortRepeat depends on the retained space: no repeat-waiting line.
  gate.onAbortRepeat({ running: 1, repeat: 1, targets: ['sub-agent-a'], phase: 'pending' });
  expect(lines.some((line) => line.startsWith('  ⏳ ESC 재시도 '))).toBe(false);
  expect(hintTargets.length).toBe(1);

  // settle behavior depends on the retained space: teardown skips settle,
  // so the earlier waiting line stays intact (turn was stopped for real).
  const settleLines = [...lines];
  if (!gate.getStoppedHarnessSpace()) dashboardIndex.settleEscAbortPendingLines(settleLines, 0);
  expect(settleLines.some((line) => line.startsWith('  ⏳ 중단 요청됨 — '))).toBe(true);
  expect(settleLines.includes('  ⏹ 중단됨')).toBe(false);
});

test('onAbortRepeat and settle path run when no successful space was retained', () => {
  const lines: string[] = [];
  const gate = createEscAbortPendingGate({
    runSoftStop: () => ({ outcome: 'waiting', stoppedHarnessSpace: null }),
    formatWaitingTargets: dashboardIndex.formatEscAbortWaitingTargets,
    getActiveHarnessSpace: () => null,
    pushChatLine: (line) => lines.push(line),
    showHarnessEscHint: () => false,
  });
  gate.onAbortPending({ running: 2, repeat: 0, targets: ['sub-agent-a', 'sub-agent-b'] });
  expect(gate.getStoppedHarnessSpace()).toBe(null);
  gate.onAbortRepeat({ running: 2, repeat: 1, targets: ['sub-agent-a'], phase: 'pending' });
  expect(lines.some((line) => line.startsWith('  ⏳ ESC 재시도 1회 — '))).toBe(true);
  const settleLines = [...lines];
  if (!gate.getStoppedHarnessSpace()) dashboardIndex.settleEscAbortPendingLines(settleLines, 0);
  expect(settleLines.includes('  ⏹ 중단됨')).toBe(true);
});

test('real soft-stop: single active space leaves a durable stop marker, hint outcome leaves none', async () => {
  const inboxDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'esc-gate-inbox-'));
  const prev = process.env[controlInbox.CONTROL_INBOX_DIR_ENV];
  process.env[controlInbox.CONTROL_INBOX_DIR_ENV] = inboxDir;
  try {
    const SPACE_A = `gate-real-a-${Date.now().toString(36)}`;
    const SPACE_B = `gate-real-b-${Date.now().toString(36)}`;

    // single run — active space resolves, soft-stop enqueues the durable marker.
    const singleState = dashboardIndex.createEscAbortToolState();
    dashboardIndex.trackEscAbortToolCall(singleState, { id: 'call-1', name: SELF_IMPLEMENT_TOOL_NAMES[0] as string });
    const singleSpaces = new Map<string, string>([['call-1', SPACE_A]]);
    const lines: string[] = [];
    const singleGate = createEscAbortPendingGate({
      runSoftStop: dashboardIndex.runEscAbortPendingSoftStop,
      formatWaitingTargets: dashboardIndex.formatEscAbortWaitingTargets,
      getActiveHarnessSpace: () => dashboardIndex.activeEscHarnessSpace(singleState, singleSpaces),
      pushChatLine: (line) => lines.push(line),
      showHarnessEscHint: () => false,
    });
    singleGate.onAbortPending({ running: 1, repeat: 0, targets: [SELF_IMPLEMENT_TOOL_NAMES[0] as string] });
    expect(singleGate.getStoppedHarnessSpace()).toBe(SPACE_A);
    expect(controlInbox.readSoftStopRequestStatus(SPACE_A).status).toBe('present');
    expect(lines.some((line) => line.includes('⏹ 멈췄다 — 해당 하니스 런에 중단 요청을 보냈습니다.'))).toBe(true);

    // fresh inbox dir for the hint scenario — the durable marker path is
    // space-independent when an explicit inbox dir is pinned, so a fresh dir
    // keeps the hint-marker-absence assertion honest.
    nodeFs.rmSync(inboxDir, { recursive: true, force: true });
    nodeFs.mkdirSync(inboxDir, { recursive: true });

    // hint outcome — hint consumed, no marker, no waiting line, no stopped space.
    const hintLines: string[] = [];
    const hintGate = createEscAbortPendingGate({
      runSoftStop: dashboardIndex.runEscAbortPendingSoftStop,
      formatWaitingTargets: dashboardIndex.formatEscAbortWaitingTargets,
      getActiveHarnessSpace: () => null,
      pushChatLine: (line) => hintLines.push(line),
      showHarnessEscHint: (targets) => (SELF_IMPLEMENT_TOOL_NAMES as readonly string[]).includes(targets[0] ?? ''),
    });
    hintGate.onAbortPending({ running: 1, repeat: 0, targets: [SELF_IMPLEMENT_TOOL_NAMES[0] as string] });
    expect(hintGate.getStoppedHarnessSpace()).toBe(null);
    expect(hintLines.some((line) => line.startsWith('  ⏳ 중단 요청됨 — '))).toBe(false);
    expect(controlInbox.readSoftStopRequestStatus(SPACE_B).status).toBe('absent');
  } finally {
    if (prev === undefined) delete process.env[controlInbox.CONTROL_INBOX_DIR_ENV];
    else process.env[controlInbox.CONTROL_INBOX_DIR_ENV] = prev;
    try { nodeFs.rmSync(inboxDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});