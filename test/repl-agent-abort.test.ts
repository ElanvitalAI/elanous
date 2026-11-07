// WT-A-3b Phase 4 — `:agent` abort registry + signal threading.
//
// Three contracts pinned here:
//   1. `createAgentTurnRunner(...)` registers an entry in the
//      module-scoped abort registry while the turn is in flight, and
//      removes it once the runner closure resolves (success path).
//   2. `abortAgentTurn(sessionId, terminalId)` calls `.abort()` on the
//      registered controller and returns true; with no live turn it
//      returns false.
//   3. `runDaemonPromptTurn` accepts an external `signal` opt and
//      forwards aborts into the internal AbortController so
//      `runCoreTurn` sees the cancellation. We assert via
//      `runCoreTurn`'s `signal` param that pre-aborted external
//      signals propagate before the LLM call kicks off.

import { describe, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import {
  createAgentTurnRunner,
  abortAgentTurn,
  _hasActiveAgentTurn,
} from '../src/repl/agent-turn';
import { DaemonSessionHistory } from '../src/boot/daemon-runtime';
import * as promptTurnModule from '../src/boot/daemon-prompt-turn';
import * as coreTurnModule from '../src/core-turn/run-core-turn';

describe('agent-turn abort registry', () => {
  test('register on enter / deregister on success', async () => {
    const history = new DaemonSessionHistory();
    let signalSeen: AbortSignal | undefined;
    const spy = spyOn(promptTurnModule, 'runDaemonPromptTurn').mockImplementation(
      async (opts) => {
        signalSeen = opts.signal;
        // Snapshot registry state mid-flight — should have our entry.
        expect(_hasActiveAgentTurn(opts.request.sessionId, 'tid-A')).toBe(true);
        return { sessionId: opts.request.sessionId, text: 'ok', stopReason: 'end_turn' };
      },
    );
    try {
      const runner = createAgentTurnRunner({
        history,
        collectContext: () => ({
          bufferText: '',
          cwd: '',
          cols: 80,
          rows: 24,
          bufferLines: 0,
        }),
      });
      await runner({ sessionId: 'sess-A', terminalId: 'tid-A', prompt: 'go' });
      // Registry deregistered after the runner returned.
      expect(_hasActiveAgentTurn('sess-A', 'tid-A')).toBe(false);
      // Signal was threaded into runDaemonPromptTurn.
      expect(signalSeen).toBeInstanceOf(AbortSignal);
    } finally {
      spy.mockRestore();
    }
  });

  test('abortAgentTurn returns false when no live turn', () => {
    expect(abortAgentTurn('sess-noop', 'tid-noop')).toBe(false);
  });

  test('abortAgentTurn fires the registered controller mid-flight', async () => {
    const history = new DaemonSessionHistory();
    let observedAbort = false;
    const spy = spyOn(promptTurnModule, 'runDaemonPromptTurn').mockImplementation(
      async (opts) => {
        // While in-flight, abort. The signal param should fire.
        opts.signal?.addEventListener('abort', () => {
          observedAbort = true;
        });
        const aborted = abortAgentTurn(opts.request.sessionId, 'tid-B');
        expect(aborted).toBe(true);
        // Yield so the addEventListener fires.
        await new Promise((r) => setTimeout(r, 0));
        return { sessionId: opts.request.sessionId, text: '', stopReason: 'aborted' };
      },
    );
    try {
      const runner = createAgentTurnRunner({
        history,
        collectContext: () => ({
          bufferText: '',
          cwd: '',
          cols: 80,
          rows: 24,
          bufferLines: 0,
        }),
      });
      await runner({ sessionId: 'sess-B', terminalId: 'tid-B', prompt: 'go' });
      expect(observedAbort).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test('deregister still happens when runner throws', async () => {
    const history = new DaemonSessionHistory();
    const spy = spyOn(promptTurnModule, 'runDaemonPromptTurn').mockImplementation(
      async () => {
        throw new Error('boom');
      },
    );
    try {
      const runner = createAgentTurnRunner({
        history,
        collectContext: () => ({
          bufferText: '',
          cwd: '',
          cols: 80,
          rows: 24,
          bufferLines: 0,
        }),
      });
      await expect(
        runner({ sessionId: 'sess-C', terminalId: 'tid-C', prompt: 'fail' }),
      ).rejects.toThrow('boom');
      expect(_hasActiveAgentTurn('sess-C', 'tid-C')).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test('concurrent re-entry under same key aborts the previous turn', async () => {
    const history = new DaemonSessionHistory();
    const aborts: boolean[] = [];
    let firstResolve!: () => void;
    const firstStarted = new Promise<void>((r) => { firstResolve = r; });
    let firstAbortFired = false;
    const spy = spyOn(promptTurnModule, 'runDaemonPromptTurn').mockImplementation(
      async (opts) => {
        const idx = aborts.length;
        aborts.push(false);
        opts.signal?.addEventListener('abort', () => {
          aborts[idx] = true;
          if (idx === 0) firstAbortFired = true;
        });
        if (idx === 0) {
          firstResolve();
          // Hold the first turn until aborted (or we'd block forever).
          await new Promise<void>((res) => {
            const fallback = setTimeout(res, 1000);
            opts.signal?.addEventListener('abort', () => {
              clearTimeout(fallback);
              res();
            }, { once: true });
            // Fallback timeout in case the test logic regresses.
          });
        }
        return { sessionId: opts.request.sessionId, text: 'ok', stopReason: 'end_turn' };
      },
    );
    try {
      const runner = createAgentTurnRunner({
        history,
        collectContext: () => ({
          bufferText: '',
          cwd: '',
          cols: 80,
          rows: 24,
          bufferLines: 0,
        }),
      });
      const first = runner({ sessionId: 'sess-D', terminalId: 'tid-D', prompt: 'one' });
      await firstStarted;
      // Second runner under the same key — should abort the first.
      const second = runner({ sessionId: 'sess-D', terminalId: 'tid-D', prompt: 'two' });
      await Promise.all([first, second]);
      expect(firstAbortFired).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test('attachments build ACP prompt blocks before runner dispatch', async () => {
    const history = new DaemonSessionHistory();
    const tmp = mkdtempSync(joinPath(tmpdir(), 'monad-agent-turn-'));
    const imagePath = joinPath(tmp, 'dock.png');
    writeFileSync(imagePath, Buffer.from([137, 80, 78, 71]));
    const spy = spyOn(promptTurnModule, 'runDaemonPromptTurn').mockImplementation(
      async (opts) => {
        expect(opts.promptBlocks).toBeDefined();
        expect(opts.promptBlocks?.length).toBeGreaterThan(1);
        expect(opts.promptBlocks?.[0]?.type).toBe('image');
        const textLast = opts.promptBlocks?.[opts.promptBlocks.length - 1];
        expect(textLast?.type).toBe('text');
        if (textLast?.type === 'text') {
          expect(textLast.text).toContain('describe this screenshot');
          expect(textLast.text).toContain('[photo');
        }
        return { sessionId: opts.request.sessionId, text: 'ok', stopReason: 'end_turn' };
      },
    );
    try {
      const runner = createAgentTurnRunner({
        history,
        collectContext: () => ({
          bufferText: '',
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          bufferLines: 0,
        }),
      });
      await runner({
        sessionId: 'sess-E',
        terminalId: 'tid-E',
        prompt: 'describe this screenshot',
        attachments: [{
          name: 'dock.png',
          localPath: imagePath,
          kind: 'photo',
          mimeType: 'image/png',
        }],
      });
    } finally {
      spy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('runDaemonPromptTurn external signal', () => {
  test('pre-aborted external signal fans through to runCoreTurn', async () => {
    const history = new DaemonSessionHistory();
    let coreSignal: AbortSignal | undefined;
    const coreSpy = spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(
      async (opts) => {
        coreSignal = opts.signal;
        return { finalText: '', stopReason: 'aborted', messages: [] };
      },
    );
    try {
      const ctrl = new AbortController();
      ctrl.abort();
      await promptTurnModule.runDaemonPromptTurn({
        history,
        request: {
          sessionId: 'sess-X',
          userText: 'hi',
          source: { kind: 'terminal', provider: 'tui' },
          effectiveSystemPrompt: '',
        },
        signal: ctrl.signal,
        dispatchToolErrorMessage: 'test',
      });
      expect(coreSignal).toBeDefined();
      expect(coreSignal!.aborted).toBe(true);
    } finally {
      coreSpy.mockRestore();
    }
  });

  test('explicit promptBlocks bypasses plain userText append path', async () => {
    const history = new DaemonSessionHistory();
    let coreMessages: Parameters<typeof coreTurnModule.runCoreTurn>[0]['messages'] | undefined;
    const coreSpy = spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(
      async (opts) => {
        coreMessages = opts.messages;
        return { finalText: '', stopReason: 'end_turn', messages: [] };
      },
    );
    try {
      await promptTurnModule.runDaemonPromptTurn({
        history,
        request: {
          sessionId: 'sess-Y',
          userText: 'fallback plain text',
          source: { kind: 'terminal', provider: 'tui' },
          effectiveSystemPrompt: '',
        },
        promptBlocks: [
          { type: 'image', data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/png' },
          { type: 'text', text: 'block path text' },
        ],
        dispatchToolErrorMessage: 'test',
      });
      const last = coreMessages?.[coreMessages.length - 1];
      expect(last?.role).toBe('user');
      expect(Array.isArray(last?.content)).toBe(true);
      expect(last?.content).toEqual([
        { type: 'image', mediaType: 'image/png', base64: Buffer.from([1, 2, 3]).toString('base64') },
        { type: 'text', text: 'block path text' },
      ]);
    } finally {
      coreSpy.mockRestore();
    }
  });
});
