// TUI modal path honours the caller's AbortSignal (TUI-DOOM-ASK-TIMEOUT-STALE-MODAL
// #79). Same contract as the ACP bridge: when the caller stops waiting, the
// modal closes — surface disposed, approval router slot released, pending
// question record removed — so it cannot keep the operator's keys or block
// the next AskUser / approval with «another approval/question is already open».

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DisplayCoordinator } from '../../src/display/index.js';
import {
  dispatchAskUserQuestion,
  setAskUserQuestionDeps,
  setAskUserQuestionResolver,
  setPendingQuestionPersistenceForTesting,
} from '../../src/ask-user-question/tool.js';
import { approvalModalRouter } from '../../src/approval-modal.js';
import { debug } from '../../src/debug/log.js';

const request = {
  questions: [{
    id: 'q1',
    header: 'Pick one',
    question: 'Choose your option',
    options: [
      { label: 'Alpha', description: 'First option' },
      { label: 'Beta', description: 'Second option' },
    ],
  }],
};

let written: string[] = [];
let removed: string[] = [];

function installTuiDeps(): DisplayCoordinator {
  const coordinator = new DisplayCoordinator({
    frameMs: 16,
    schedule: (fn) => setTimeout(fn, 0),
    termSize: () => ({ rows: 30, cols: 120 }),
  });
  setAskUserQuestionDeps({ coordinator, termSize: () => ({ rows: 30, cols: 120 }) });
  return coordinator;
}

const openAskModals = (coordinator: DisplayCoordinator) => coordinator.modalLifecycleAPI().stackOrder()
  .filter((h) => h.typeName === 'ask-user-question-modal' && !h.isDisposed());

beforeEach(() => {
  written = [];
  removed = [];
  setPendingQuestionPersistenceForTesting({
    write: (q) => { written.push(q.id); },
    remove: (id) => { removed.push(id); },
  });
  setAskUserQuestionResolver(null);
  approvalModalRouter._resetForTesting();
});

afterEach(() => {
  setAskUserQuestionDeps(null);
  setAskUserQuestionResolver(null);
  setPendingQuestionPersistenceForTesting(null);
  approvalModalRouter._resetForTesting();
  debug.clear();
  debug.disable();
});

describe('dispatchAskUserQuestion TUI path — AbortSignal', () => {
  test('abort closes the modal, releases the router slot and the pending record; the next ask opens without busy', async () => {
    debug.clear();
    debug.setLevel('normal');
    const coordinator = installTuiDeps();
    const ac = new AbortController();
    const first = dispatchAskUserQuestion(request, { sessionId: 's1', signal: ac.signal });
    await Promise.resolve();
    expect(openAskModals(coordinator)).toHaveLength(1);
    expect(approvalModalRouter.currentKind()).toBe('askUser');

    ac.abort();
    const out = await first;
    expect(out.result?.cancelled).toBe(true);
    expect(openAskModals(coordinator)).toHaveLength(0);
    expect(approvalModalRouter.current()).toBeNull();
    expect(removed).toEqual(written);
    const end = debug.events().find((entry) => entry.category === 'ask-user-question.dispatch'
      && entry.event === 'end' && (entry.data as { outcome?: unknown } | undefined)?.outcome !== undefined);
    expect(end?.data).toMatchObject({ outcome: 'cancelled', cancelledBySignal: true });

    const next = dispatchAskUserQuestion(request, { sessionId: 's2' });
    await Promise.resolve();
    expect(openAskModals(coordinator)).toHaveLength(1);
    approvalModalRouter.current()?.dispose(true);
    const nextOut = await next;
    expect(nextOut.output).not.toContain('already open');
  });

  test('an already-aborted signal never opens the modal', async () => {
    const coordinator = installTuiDeps();
    const ac = new AbortController();
    ac.abort();
    const out = await dispatchAskUserQuestion(request, { sessionId: 's3', signal: ac.signal });
    expect(out.result?.cancelled).toBe(true);
    expect(openAskModals(coordinator)).toHaveLength(0);
    expect(approvalModalRouter.current()).toBeNull();
    expect(written).toHaveLength(0);
  });

  test('without an abort the modal stays until answered (no spurious cancel)', async () => {
    const coordinator = installTuiDeps();
    const ac = new AbortController();
    const pending = dispatchAskUserQuestion(request, { sessionId: 's4', signal: ac.signal });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(openAskModals(coordinator)).toHaveLength(1);
    approvalModalRouter.current()?.dispose(true);
    await pending;
  });
});
