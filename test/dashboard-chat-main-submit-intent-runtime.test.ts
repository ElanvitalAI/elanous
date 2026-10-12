import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDashboardChatMainTurnSubmit,
  runDashboardChatMainSubmitIntent,
} from '../src/dashboard/input/chat-main-submit-intent-runtime.js';
import { debug, type DebugEvent } from '../src/debug/log.js';
import {
  clearActiveSessionId,
  getActiveSessionId,
  setActiveSessionId,
} from '../src/session/index.js';

describe('runDashboardChatMainSubmitIntent', () => {
  it('uses the live ACP session for TUI submit logs when the isolated active pointer is absent', async () => {
    const previousStateDir = process.env.ELANOUS_STATE_DIR;
    const stateDir = mkdtempSync(join(tmpdir(), 'tui-submit-session-'));
    const events: DebugEvent[] = [];
    const wasFileEnabled = debug.status().file;
    const wasDiagEnabled = debug.status().diag;
    process.env.ELANOUS_STATE_DIR = stateDir;
    debug.setFileEnabled(true);
    debug.setDiagEnabled(true);
    const unregister = debug.registerSink({
      name: 'tui-submit-acp-session-test',
      emit: (event) => { events.push(event); },
    });
    try {
      expect(getActiveSessionId()).toBeNull();
      const submit = createDashboardChatMainTurnSubmit({
        kind: 'submit-turn',
        source: { kind: 'keyboard', surface: 'dashboard-chat-main' },
        text: 'first turn',
        route: 'plain',
        sessionId: 'elanous-session-live',
      });
      expect(submit.sessionId).toBe('elanous-session-live');
      await runDashboardChatMainSubmitIntent({
        submit,
        runStickyAcpDispatch: () => {},
        runPlainTurn: async () => {},
      });
    } finally {
      unregister();
      debug.setDiagEnabled(wasDiagEnabled);
      debug.setFileEnabled(wasFileEnabled);
      if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
    expect(events.filter((event) => event.category === 'input.submit')).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'create', session_id: 'elanous-session-live' }),
      expect.objectContaining({ event: 'execute.begin', session_id: 'elanous-session-live' }),
      expect.objectContaining({ event: 'execute.ok', session_id: 'elanous-session-live' }),
    ]));
  });

  it('creates sticky ACP turn submits from submit intents', () => {
    expect(createDashboardChatMainTurnSubmit({
      kind: 'submit-turn',
      source: { kind: 'keyboard', surface: 'dashboard-chat-main' },
      text: 'hello world',
      route: 'sticky-acp',
      backend: 'codex',
    })).toMatchObject({
      intent: {
        kind: 'submit-turn',
        source: { kind: 'keyboard', surface: 'dashboard-chat-main' },
        text: 'hello world',
        route: 'sticky-acp',
        backend: 'codex',
      },
      source: { kind: 'keyboard', surface: 'dashboard-chat-main' },
      text: 'hello world',
      target: {
        kind: 'sticky-acp',
        backend: 'codex',
      },
    });
  });

  it('dispatches sticky ACP submit intents through the sticky callback', async () => {
    const calls: string[] = [];
    const route = await runDashboardChatMainSubmitIntent({
      submit: createDashboardChatMainTurnSubmit({
        kind: 'submit-turn',
        source: { kind: 'keyboard', surface: 'dashboard-chat-main' },
        text: 'hello world',
        route: 'sticky-acp',
        backend: 'codex',
      }),
      runStickyAcpDispatch: ({ target, text }) => {
        calls.push(`sticky:${target.backend}:${text}`);
      },
      runPlainTurn: async () => {
        calls.push('plain');
      },
    });

    expect(route).toBe('sticky-acp');
    expect(calls).toEqual(['sticky:codex:hello world']);
  });

  it('dispatches plain submit intents through the plain callback', async () => {
    const calls: string[] = [];
    const route = await runDashboardChatMainSubmitIntent({
      submit: createDashboardChatMainTurnSubmit({
        kind: 'submit-turn',
        source: { kind: 'keyboard', surface: 'dashboard-chat-main' },
        text: 'hello world',
        route: 'plain',
      }),
      runStickyAcpDispatch: () => {
        calls.push('sticky');
      },
      runPlainTurn: async (submit) => {
        calls.push(`plain:${submit.text}`);
      },
    });

    expect(route).toBe('plain');
    expect(calls).toEqual(['plain:hello world']);
  });

  it('runs beforeExecute before dispatching the submit', async () => {
    const calls: string[] = [];
    const route = await runDashboardChatMainSubmitIntent({
      submit: createDashboardChatMainTurnSubmit({
        kind: 'submit-turn',
        source: { kind: 'keyboard', surface: 'dashboard-chat-main' },
        text: 'hello world',
        route: 'plain',
      }),
      beforeExecute: (submit) => {
        calls.push(`before:${submit.target.kind}:${submit.source.kind}`);
      },
      runStickyAcpDispatch: () => {
        calls.push('sticky');
      },
      runPlainTurn: async (submit) => {
        calls.push(`plain:${submit.text}`);
      },
    });

    expect(route).toBe('plain');
    expect(calls).toEqual([
      'before:plain:keyboard',
      'plain:hello world',
    ]);
  });

  it('attributes TUI-created create, execute.begin, and execute.ok input.submit events to the active session', async () => {
    const events: DebugEvent[] = [];
    const previousSessionId = getActiveSessionId();
    const sessionId = 'tui-session-42';
    const wasFileEnabled = debug.status().file;
    debug.setFileEnabled(true);
    debug.setDiagEnabled(true);
    setActiveSessionId(sessionId);
    const unregister = debug.registerSink({
      name: 'dashboard-submit-session-attribution-test',
      emit: (event) => { events.push(event); },
    });
    try {
      const submit = createDashboardChatMainTurnSubmit({
        kind: 'submit-turn',
        source: { kind: 'keyboard', surface: 'dashboard-chat-main' },
        text: 'session-attributed turn',
        route: 'plain',
      });
      expect(submit.sessionId).toBe(sessionId);
      setActiveSessionId('different-active-session');
      await runDashboardChatMainSubmitIntent({
        submit,
        runStickyAcpDispatch: () => {},
        runPlainTurn: async () => {},
      });
    } finally {
      unregister();
      if (previousSessionId) setActiveSessionId(previousSessionId);
      else clearActiveSessionId();
      debug.setDiagEnabled(false);
      debug.setFileEnabled(wasFileEnabled);
    }

    expect(events.filter((event) => event.category === 'input.submit')).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'create', session_id: sessionId }),
      expect.objectContaining({ event: 'execute.begin', session_id: sessionId }),
      expect.objectContaining({ event: 'execute.ok', session_id: sessionId }),
    ]));
  });

  it('attributes execute.error input.submit events to the active TUI session', async () => {
    const events: DebugEvent[] = [];
    const previousSessionId = getActiveSessionId();
    const sessionId = 'tui-session-error';
    const wasFileEnabled = debug.status().file;
    debug.setFileEnabled(true);
    debug.setDiagEnabled(true);
    setActiveSessionId(sessionId);
    const unregister = debug.registerSink({
      name: 'dashboard-submit-session-attribution-test',
      emit: (event) => { events.push(event); },
    });
    try {
      const submit = createDashboardChatMainTurnSubmit({
        kind: 'submit-turn',
        source: { kind: 'keyboard', surface: 'dashboard-chat-main' },
        text: 'failing session-attributed turn',
        route: 'plain',
      });
      expect(submit.sessionId).toBe(sessionId);
      await expect(runDashboardChatMainSubmitIntent({
        submit,
        runStickyAcpDispatch: () => {},
        runPlainTurn: async () => { throw new Error('expected submit failure'); },
      })).rejects.toThrow('expected submit failure');
    } finally {
      unregister();
      if (previousSessionId) setActiveSessionId(previousSessionId);
      else clearActiveSessionId();
      debug.setDiagEnabled(false);
      debug.setFileEnabled(wasFileEnabled);
    }

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'input.submit',
        event: 'execute.error',
        session_id: sessionId,
      }),
    ]));
  });
});
