import { describe, expect, spyOn, test } from 'bun:test';

import {
  resolveDashboardChatMainSubmitIntent,
  resolveDashboardChatMainSubmitRoute,
} from '../src/dashboard/input/chat-main-submit-route.js';
import { resolveDashboardChatMainSlashCommand } from '../src/dashboard/input/chat-main-slash-command.js';
import {
  buildDashboardSlashRegistry,
  type DashboardSlashContext,
} from '../src/dashboard/slash-runtime/index.js';
import { closeDashboardForExit, resolveDashboardSlashSurfaceUx } from '../src/dashboard/index.js';
import { debug } from '../src/debug/log.js';
import type { QuestionChannel } from '../src/hitl/question.js';

describe('dashboard chat main submit route', () => {
  test('routes plain text to sticky ACP when armed', () => {
    expect(resolveDashboardChatMainSubmitRoute('  hello world  ', {
      stickyBackend: 'codex',
    })).toEqual({
      kind: 'sticky-acp',
      backend: 'codex',
      message: 'hello world',
    });
  });

  test('routes slash commands ahead of plain handling', () => {
    expect(resolveDashboardChatMainSubmitRoute(' /log help ', {
      stickyBackend: 'codex',
    })).toEqual({
      kind: 'slash',
      commandText: '/log help',
    });
  });

  test('routes to plain submit when no sticky backend is armed', () => {
    expect(resolveDashboardChatMainSubmitRoute('hello', {
      stickyBackend: null,
    })).toEqual({
      kind: 'plain',
      message: 'hello',
    });
  });

  test('submits bare exit words as chat with and without a sticky backend', () => {
    for (const input of ['exit', 'quit', 'EXIT', '  quit  ', '종료', '그만']) {
      for (const stickyBackend of [null, 'codex']) {
        expect(resolveDashboardChatMainSubmitIntent(input, { stickyBackend })).toMatchObject({
          kind: 'submit-turn',
          source: { kind: 'keyboard', surface: 'dashboard-chat-main' },
          text: input.trim(),
          route: stickyBackend ? 'sticky-acp' : 'plain',
        });
      }
    }
  });

  test('keeps exit sentences, partial words, and empty input on their existing plain route', () => {
    for (const input of ['exit code 를 알려줘', 'quit 을 어떻게 구현하지', 'exit now', 'quitting', '']) {
      expect(resolveDashboardChatMainSubmitIntent(input, {
        stickyBackend: null,
      })).toEqual({
        kind: 'submit-turn',
        source: { kind: 'keyboard', surface: 'dashboard-chat-main' },
        text: input,
        route: 'plain',
      });
    }
  });

  test('routes non-exact exit text to sticky ACP when armed', () => {
    for (const input of ['exit code 를 알려줘', 'quit 을 어떻게 구현하지', 'exit now', 'quitting']) {
      expect(resolveDashboardChatMainSubmitIntent(input, {
        stickyBackend: 'codex',
      })).toMatchObject({
        kind: 'submit-turn',
        text: input,
        route: 'sticky-acp',
        backend: 'codex',
      });
    }
  });

  test('adapts registered TUI question channels into slash context capability and preserves no-channel fallback', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const channel: QuestionChannel = {
      name: 'dashboard-test',
      ask: async (request) => ({ answers: { [request.questions[0]!.id]: 'minimal' } }),
      cancel: () => {},
    };
    try {
      const surfaceUx = resolveDashboardSlashSurfaceUx([channel]);
      expect(surfaceUx).toBeDefined();
      await expect(surfaceUx!.question({
        questions: [{ id: 'scope', header: 'Scope', question: 'Choose', options: [{ label: 'minimal', description: 'Minimal' }] }],
      })).resolves.toEqual({ answers: { scope: 'minimal' } });
      expect(log).toHaveBeenCalledWith('surface-ux.confirm', 'question', { surface: 'tui', mode: 'answered' });
      expect(resolveDashboardSlashSurfaceUx([])).toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });

  test('wires only explicit slash exit through slash dispatch to the exit-only callback', async () => {
    const registry = buildDashboardSlashRegistry();
    for (const input of ['/exit', '  /exit  ']) {
      const intent = resolveDashboardChatMainSubmitIntent(input, { stickyBackend: 'codex' });
      expect(intent).toMatchObject({ kind: 'control-turn', commandText: '/exit' });
      if (intent.kind !== 'control-turn') throw new Error('slash exit must be a control turn');
      const { cmdLower, args } = resolveDashboardChatMainSlashCommand(intent.commandText ?? '');
      const calls: string[] = [];
      const ctx = {
        exitTui: () => { calls.push('exit'); },
        closeTui: () => { calls.push('close'); },
      } as DashboardSlashContext;
      await expect(registry.dispatch(cmdLower, args, ctx)).resolves.toEqual({ kind: 'return', value: 'quit' });
      expect(calls).toEqual(['exit']);
    }
  });

  test('leaves a resume notice after closing and tolerates write failure', () => {
    const knownEvents: string[] = [];
    let resumeNotice = '';
    closeDashboardForExit({
      closeTui: () => { knownEvents.push('close'); },
      getSessionId: () => 'session-123',
      write: (message) => {
        knownEvents.push('write');
        resumeNotice = message;
      },
    });
    expect(knownEvents).toEqual(['close', 'write']);
    expect(resumeNotice).toContain('session-123');
    expect(resumeNotice).toContain('/resume session-123');

    const unknownEvents: string[] = [];
    expect(() => closeDashboardForExit({
      closeTui: () => { unknownEvents.push('close'); },
      getSessionId: () => undefined,
      write: (message) => {
        unknownEvents.push(`write:${message}`);
        throw new Error('closed stdout');
      },
    })).not.toThrow();
    expect(unknownEvents).toHaveLength(2);
    expect(unknownEvents[0]).toBe('close');
    expect(unknownEvents[1]).toContain('elanous session list');
  });

  test('maps keyboard submit into input intents', () => {
    expect(resolveDashboardChatMainSubmitIntent(' /log help ', {
      stickyBackend: 'codex',
    })).toEqual({
      kind: 'control-turn',
      source: { kind: 'keyboard', surface: 'dashboard-chat-main' },
      command: 'slash-command',
      commandText: '/log help',
    });
    expect(resolveDashboardChatMainSubmitIntent('  hello world  ', {
      stickyBackend: 'codex',
    })).toEqual({
      kind: 'submit-turn',
      source: { kind: 'keyboard', surface: 'dashboard-chat-main' },
      text: 'hello world',
      route: 'sticky-acp',
      backend: 'codex',
    });
    expect(resolveDashboardChatMainSubmitIntent('hello', {
      stickyBackend: null,
    })).toEqual({
      kind: 'submit-turn',
      source: { kind: 'keyboard', surface: 'dashboard-chat-main' },
      text: 'hello',
      route: 'plain',
    });
  });

  test('preserves external submit source provenance', () => {
    expect(resolveDashboardChatMainSubmitIntent('hello', {
      stickyBackend: null,
      source: {
        kind: 'voice',
        surface: 'dashboard-chat-main',
        mode: 'multi-turn',
        transcriptSource: 'voice',
        channel: 'dashboard',
      },
    })).toEqual({
      kind: 'submit-turn',
      source: {
        kind: 'voice',
        surface: 'dashboard-chat-main',
        mode: 'multi-turn',
        transcriptSource: 'voice',
        channel: 'dashboard',
      },
      text: 'hello',
      route: 'plain',
    });
  });
});
