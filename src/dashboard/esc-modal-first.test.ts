import { expect, mock, test } from 'bun:test';
import { consumeStreamingTopModalEscape, createEscAbortGate, createHarnessEscHint, routeStreamingEscapeKey } from '../esc-abort-gate.js';
import { createAskUserQuestionModal } from '../ask-user-question/modal.js';
import { approvalModalRouter } from '../approval-modal.js';
import { readDashboardAskClarification } from './slash-runtime/dashboard-handlers.js';

const escape = { name: 'escape' as const };
const bounds = { row: 1, col: 1, width: 60, height: 16 };
const question = { questionId: 'scope', header: '범위', question: '선택하세요', options: [{ label: 'small', description: '작게' }], includeOther: false, answer: '', answered: false, answerLine: 1 };

test('topmost clarification modal consumes one Esc, closes, and returns empty answer without calling abort gate', async () => {
  const modal = createAskUserQuestionModal({ id: 'clarify', bounds, request: { questions: [{ id: 'scope', header: 'Clarify goal', question: '선택하세요', options: [{ label: 'small', description: '작게' }], includeOther: false }] } });
  approvalModalRouter.set(modal as never, () => {}, 'askUser');
  const gate = { isGateOpen: () => false, handleKey: mock(() => true), handleEscape: mock(() => {}) };
  const closedLines: string[] = [];
  const surfaceUx = { question: async () => modal.promise };
  const openedLines: string[] = [];
  const answer = readDashboardAskClarification(question, surfaceUx, (line) => { openedLines.push(line); });
  expect(openedLines).toEqual(['하니스가 묻는다 — 창에서 고르거나 Esc 로 답 없이 진행']);
  const consumed = await routeStreamingEscapeKey(escape, gate, escape, async () => false, () =>
    consumeStreamingTopModalEscape({
      modal: modal.surface,
      abortGateModalId: null,
      event: escape,
      question: { id: modal.surface.id, dispose: (cancelled) => modal.dispose(cancelled), isClarification: true },
      onClarificationClosed: () => { closedLines.push('되묻기 창을 닫았다 — 답 없이 진행한다'); },
      topModalId: () => null,
      redraw: () => {},
    }));
  expect(consumed).toBe(true);
  expect(await answer).toBe('');
  expect(await modal.promise).toMatchObject({ cancelled: true });
  expect(gate.handleEscape).not.toHaveBeenCalled();
  expect(closedLines).toEqual(['되묻기 창을 닫았다 — 답 없이 진행한다']);
  await Promise.resolve();
  approvalModalRouter._resetForTesting();
});

test('ordinary question closes without a clarification notice', async () => {
  const modal = createAskUserQuestionModal({ id: 'ordinary', bounds, request: { questions: [{ id: 'scope', header: 'Clarify goal', question: '선택하세요', options: [], includeOther: false }] } });
  const onClarificationClosed = mock(() => {});
  const gate = { isGateOpen: () => false, handleKey: mock(() => true), handleEscape: mock(() => {}) };
  const result = await routeStreamingEscapeKey(escape, gate, escape, async () => false, () =>
    consumeStreamingTopModalEscape({
      modal: modal.surface, abortGateModalId: null, event: escape,
      question: { id: modal.surface.id, dispose: cancelled => modal.dispose(cancelled), isClarification: false },
      onClarificationClosed, topModalId: () => null, redraw: () => {},
    }));
  expect(result).toBe(true);
  expect(await modal.promise).toMatchObject({ cancelled: true });
  expect(onClarificationClosed).not.toHaveBeenCalled();
  expect(gate.handleEscape).not.toHaveBeenCalled();
});

test('an unhandled top modal passes Esc to the existing modal route, not the gate', async () => {
  const gate = { isGateOpen: () => false, handleKey: mock(() => true), handleEscape: mock(() => {}) };
  const onClarificationClosed = mock(() => {});
  const surface = { id: 'still-open', onKey: mock(() => 'consumed' as const) };
  const consumed = await routeStreamingEscapeKey(escape, gate, escape, async () => false, () =>
    consumeStreamingTopModalEscape({ modal: surface, abortGateModalId: null, event: escape,
      onClarificationClosed, topModalId: () => surface.id, redraw: () => {} }));
  expect(consumed).toBe(false);
  expect(gate.handleEscape).not.toHaveBeenCalled();
  expect(onClarificationClosed).not.toHaveBeenCalled();
  const missingHandler = await routeStreamingEscapeKey(escape, gate, escape, async () => false, () =>
    consumeStreamingTopModalEscape({ modal: { id: 'no-handler' }, abortGateModalId: null, event: escape,
      onClarificationClosed, topModalId: () => 'no-handler', redraw: () => {} }));
  expect(missingHandler).toBe(false);
  expect(gate.handleEscape).not.toHaveBeenCalled();
});

test('without a modal Esc reaches the existing gate and stops only this turn', async () => {
  const ctrl = new AbortController();
  const gate = createEscAbortGate({ abortCtrl: ctrl, getRunningCount: () => 0, mountModal: () => () => {}, getViewport: () => ({ cols: 80, rows: 24 }) });
  const handleEscape = mock(() => gate.handleEscape());
  const consumed = await routeStreamingEscapeKey(escape, { ...gate, handleEscape }, escape, async () => false, () => false);
  expect(consumed).toBe(true);
  expect(handleEscape).toHaveBeenCalledTimes(1);
  expect(ctrl.signal.aborted).toBe(true);
});

test('a running sub-agent without a modal keeps the first-Esc confirmation and second-Esc turn abort', async () => {
  const ctrl = new AbortController();
  let mounted = 0;
  const gate = createEscAbortGate({
    abortCtrl: ctrl, getRunningCount: () => 1,
    mountModal: () => { mounted++; return () => { mounted--; }; },
    getViewport: () => ({ cols: 80, rows: 24 }),
  });
  await routeStreamingEscapeKey(escape, gate, escape, async () => false);
  expect(mounted).toBe(1);
  expect(ctrl.signal.aborted).toBe(false);
  await routeStreamingEscapeKey(escape, gate, escape, async () => false);
  await Promise.resolve();
  expect(ctrl.signal.aborted).toBe(true);
  expect(mounted).toBe(0);
});

test('two Esc presses during SelfImplement tool execution print the survival and stop hint once', async () => {
  const lines: string[] = [];
  const showHint = createHarnessEscHint(line => { lines.push(line); });
  const ctrl = new AbortController();
  const gate = createEscAbortGate({
    abortCtrl: ctrl,
    getRunningCount: () => 0,
    getWaitingTargetNames: () => ['SelfImplement'],
    mountModal: () => () => {},
    getViewport: () => ({ cols: 80, rows: 24 }),
    onAbortPending: ({ targets }) => { showHint(targets); },
    onAbortRepeat: ({ targets }) => { showHint(targets); },
  });
  await routeStreamingEscapeKey(escape, gate, escape, async () => false);
  await routeStreamingEscapeKey(escape, gate, escape, async () => false);
  expect(lines).toEqual(['하니스 런은 따로 계속 돈다 — 멈추려면 /harness stop <space-id> · 목록은 /harness runs']);
  showHint(['self_implement']);
  expect(lines).toHaveLength(1);
  expect(ctrl.signal.aborted).toBe(true);
});
