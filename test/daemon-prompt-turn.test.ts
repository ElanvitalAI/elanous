import { describe, expect, it, spyOn } from 'bun:test';

import { runDaemonPromptTurn } from '../src/boot/daemon-prompt-turn.js';
import { DaemonSessionHistory } from '../src/boot/daemon-runtime.js';
import * as coreTurnModule from '../src/core-turn/index.js';
import type { CoreTurnContext } from '../src/core-turn/index.js';
import type { DaemonToolSurface } from '../src/boot/daemon-tools/types.js';
import * as notifyTurnEndModule from '../src/web-push/notify-turn-end.js';

describe('runDaemonPromptTurn', () => {
  it('appends the user message and returns final output', async () => {
    const calls: CoreTurnContext[] = [];
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx: CoreTurnContext) => {
      calls.push(ctx);
      return {
        stopReason: 'end_turn',
        finalText: 'done',
      };
    });
    const history = new DaemonSessionHistory();
    const result = await runDaemonPromptTurn({ fastPathEnabled: false,
      history,
      request: {
        sessionId: 'sess-1',
        userText: 'hello',
        source: null,
        effectiveSystemPrompt: 'System prompt',
      },
      dispatchToolErrorMessage: 'no tools here',
    });
    expect(result).toEqual({
      sessionId: 'sess-1',
      text: 'done',
      stopReason: 'end_turn',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.userText).toBe('hello');
    expect(calls[0]!.messages[0]).toEqual({
      role: 'system',
      content: 'System prompt',
    });
    expect(calls[0]!.messages[1]).toEqual({
      role: 'user',
      content: 'hello',
    });
  });

  // Image-pipeline followup #1+#4 (2026-05-05) — when toolSurface is
  // 'webterm', the system prompt should grow a daemon-context block
  // and dispatch ctx should carry the request's sessionId so the
  // webterm dispatchers can auto-inject scope.
  it("kind='webterm': injects webterm context into system prompt + threads sessionId into dispatch", async () => {
    const calls: CoreTurnContext[] = [];
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx: CoreTurnContext) => {
      calls.push(ctx);
      return { stopReason: 'end_turn', finalText: 'ok' };
    });

    const dispatchCalls: { name: string; args: Record<string, unknown>; ctx: { sessionId?: string } }[] = [];
    const surface: DaemonToolSurface = {
      kind: 'webterm',
      specs: [],
      async dispatch(name, args, ctx) {
        dispatchCalls.push({ name, args, ctx: { sessionId: ctx.sessionId } });
        return { ok: true };
      },
    };

    const history = new DaemonSessionHistory();
    await runDaemonPromptTurn({
      history,
      toolSurface: surface,
      toolCwd: process.cwd(),
      request: {
        sessionId: 'sess-webterm',
        userText: 'inspect',
        source: null,
        effectiveSystemPrompt: 'Base.',
      },
      dispatchToolErrorMessage: 'unused',
    });

    expect(calls).toHaveLength(1);
    const sysMsg = calls[0]!.messages[0];
    expect(sysMsg.role).toBe('system');
    expect(typeof sysMsg.content).toBe('string');
    expect(sysMsg.content as string).toContain('Base.');
    expect(sysMsg.content as string).toContain('Current ACP sessionId: sess-webterm');
    expect(sysMsg.content as string).toContain('daemon tool-cwd directly');

    // Invoke dispatchTool indirectly via the runCoreTurn ctx to verify
    // the closure injects request.sessionId.
    await calls[0]!.dispatchTool('WebTerminalList', {}, { callId: 'c1' });
    expect(dispatchCalls).toEqual([
      {
        name: 'WebTerminalList',
        args: {},
        ctx: { sessionId: 'sess-webterm' },
      },
    ]);
  });

  // PLAN-multi-surface-pty-shell M3 — a PtyShell-bearing surface folds
  // the shared terminal adapters onto the daemon turn: budgetGrant,
  // mission discipline in the system prompt, and `_imageFile` results
  // converted to the inline image-bearing convention.
  it('PtyShell surface: budgetGrant + discipline prompt + _imageFile→inline image', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const calls: CoreTurnContext[] = [];
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx: CoreTurnContext) => {
      calls.push(ctx);
      return { stopReason: 'end_turn', finalText: 'ok' };
    });
    const dir = mkdtempSync(join(tmpdir(), 'daemon-pty-'));
    try {
      const png = join(dir, 'shot.png');
      writeFileSync(png, Buffer.from('fake-png'));
      const surface: DaemonToolSurface = {
        kind: 'webterm',
        specs: [{ name: 'PtyShellStart', description: '', parameters: { type: 'object' } }],
        async dispatch(name) {
          return name === 'PtyShellScreenshot'
            ? { output: 'frame', _imageFile: png }
            : { ok: true };
        },
      };
      await runDaemonPromptTurn({
        history: new DaemonSessionHistory(),
        toolSurface: surface,
        toolCwd: process.cwd(),
        request: {
          sessionId: 'sess-pty',
          userText: 'drive',
          source: null,
          effectiveSystemPrompt: 'Base.',
        },
        dispatchToolErrorMessage: 'unused',
      });
      const ctx = calls[0]!;
      expect(ctx.budgetGrant).toBeDefined();
      expect(ctx.budgetGrant!.tools).toContain('PtyShellStart');
      const sys = ctx.messages[0]!.content as string;
      expect(sys).toContain('Base.');
      expect(sys).toContain('[터미널 미션 규율]');
      // dispatch converts _imageFile to inline bytes (PWA/iOS/Android
      // onImageBlock path + vision LLM)
      const converted = await ctx.dispatchTool('PtyShellScreenshot', {}, { callId: 'c1' }) as Record<string, unknown>;
      expect(converted.mediaType).toBe('image/png');
      expect(converted.dataB64).toBe(Buffer.from('fake-png').toString('base64'));
      expect('_imageFile' in converted).toBe(false);
      // non-PtyShell surfaces stay un-granted (existing test covers the
      // no-surface path; here assert the gate itself)
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fires notifyAgentTurnEnd after runCoreTurn with sessionId + finalText + stopReason', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async () => ({
      stopReason: 'end_turn',
      finalText: 'final assistant text',
    }));
    const calls: { sessionId: string; finalText: string; stopReason?: string }[] = [];
    spyOn(notifyTurnEndModule, 'notifyAgentTurnEnd').mockImplementation(
      async (opts: { sessionId: string; finalText: string; stopReason?: string }) => {
        calls.push(opts);
      },
    );
    const history = new DaemonSessionHistory();
    await runDaemonPromptTurn({
      history,
      request: {
        sessionId: 'sess-push',
        userText: 'hi',
        source: null,
        effectiveSystemPrompt: 'sys',
      },
      dispatchToolErrorMessage: 'no tools',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      sessionId: 'sess-push',
      finalText: 'final assistant text',
      stopReason: 'end_turn',
    });
  });

  // ── Phase B-3 (PWA chat streaming · 2026-05-06) ──────────────────

  it('B-3: forwards tool calls to onToolCall before dispatch (id + name + args)', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      ctx.callbacks?.onToolCall?.({
        id: 'call-1',
        name: 'WebTerminalScreenshot',
        args: { terminalId: 't-1' },
      });
      return { stopReason: 'end_turn', finalText: '' };
    });
    const seen: { id: string; name: string; args: Record<string, unknown> }[] = [];
    const history = new DaemonSessionHistory();
    await runDaemonPromptTurn({
      history,
      request: {
        sessionId: 'sess-tc',
        userText: 'cap',
        source: null,
        effectiveSystemPrompt: 'sys',
      },
      onToolCall: (info) => seen.push(info),
      dispatchToolErrorMessage: 'unused',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      id: 'call-1',
      name: 'WebTerminalScreenshot',
      args: { terminalId: 't-1' },
    });
  });

  it('B-3: forwards every tool result to onToolResultMeta with derived summary (image)', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      ctx.callbacks?.onToolResult?.({
        id: 'call-1',
        name: 'WebTerminalScreenshot',
        result: { mediaType: 'image/png', dataB64: 'a'.repeat(16384) }, // ~12 KB
      });
      return { stopReason: 'end_turn', finalText: '' };
    });
    const seen: { id: string; name: string; ok: boolean; summary?: string }[] = [];
    const history = new DaemonSessionHistory();
    await runDaemonPromptTurn({
      history,
      request: {
        sessionId: 'sess-tr',
        userText: 'x',
        source: null,
        effectiveSystemPrompt: 'sys',
      },
      onToolResultMeta: (info) => seen.push(info),
      dispatchToolErrorMessage: 'unused',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBe('call-1');
    expect(seen[0]!.ok).toBe(true);
    expect(seen[0]!.summary).toMatch(/image\/png ~12 KB/);
  });

  it('B-3: derives summary for matches array / lines array / output text', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      ctx.callbacks?.onToolResult?.({
        id: 'r1',
        name: 'Grep',
        result: { matches: [{}, {}, {}] },
      });
      ctx.callbacks?.onToolResult?.({
        id: 'r2',
        name: 'Read',
        result: { lines: Array(95).fill('line') },
      });
      ctx.callbacks?.onToolResult?.({
        id: 'r3',
        name: 'Bash',
        result: { output: 'first line of output\nsecond line\nthird' },
      });
      return { stopReason: 'end_turn', finalText: '' };
    });
    const seen: { id: string; summary?: string }[] = [];
    const history = new DaemonSessionHistory();
    await runDaemonPromptTurn({
      history,
      request: {
        sessionId: 'sess-multi-summary',
        userText: 'x',
        source: null,
        effectiveSystemPrompt: 'sys',
      },
      onToolResultMeta: (info) => seen.push(info),
      dispatchToolErrorMessage: 'unused',
    });
    expect(seen).toHaveLength(3);
    expect(seen[0]!.summary).toBe('3 matches');
    expect(seen[1]!.summary).toBe('95 lines');
    expect(seen[2]!.summary).toBe('first line of output');
  });

  it('B-3: image + meta callbacks both fire for the same tool result (B-2.5 + B-3 coexist)', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      ctx.callbacks?.onToolResult?.({
        id: 'call-1',
        name: 'WebTerminalScreenshot',
        result: { mediaType: 'image/png', dataB64: 'AAA' },
      });
      return { stopReason: 'end_turn', finalText: '' };
    });
    const imgSeen: unknown[] = [];
    const metaSeen: unknown[] = [];
    const history = new DaemonSessionHistory();
    await runDaemonPromptTurn({
      history,
      request: {
        sessionId: 'sess-both',
        userText: 'x',
        source: null,
        effectiveSystemPrompt: 'sys',
      },
      onImageBlock: (info) => imgSeen.push(info),
      onToolResultMeta: (info) => metaSeen.push(info),
      dispatchToolErrorMessage: 'unused',
    });
    expect(imgSeen).toHaveLength(1);
    expect(metaSeen).toHaveLength(1);
  });

  // ── Phase B-2.5 (PWA chat streaming · 2026-05-06) ────────────────
  //
  // `onImageBlock` is the daemon hook that turns image-bearing tool
  // results (`{mediaType:'image/…', dataB64, …}`) into SSE
  // `image-block` events for the PWA `/chat` surface. The conversion
  // reuses `maybeImageBearingResult` so a tool result that the LLM
  // consumed as an image is the same one PWA renders inline.

  it('B-2.5: forwards image-bearing tool result to onImageBlock with data: URI + default alt', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      // Drive the same callback path the production tool loop uses.
      ctx.callbacks?.onToolResult?.({
        id: 'call-1',
        name: 'WebTerminalScreenshot',
        result: {
          sessionId: 's-1',
          terminalId: 't-1',
          mediaType: 'image/png',
          dataB64: 'iVBORw0KGgo=',
          // Extra fields the convention preserves but daemon ignores.
          cols: 80,
          rows: 24,
        },
      });
      return { stopReason: 'end_turn', finalText: '' };
    });
    const seen: { src: string; mediaType: string; alt?: string }[] = [];
    const history = new DaemonSessionHistory();
    await runDaemonPromptTurn({
      history,
      request: {
        sessionId: 'sess-img',
        userText: 'capture',
        source: null,
        effectiveSystemPrompt: 'sys',
      },
      onImageBlock: (info) => seen.push(info),
      dispatchToolErrorMessage: 'unused',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      src: 'data:image/png;base64,iVBORw0KGgo=',
      mediaType: 'image/png',
      alt: 'WebTerminalScreenshot result',
    });
  });

  it('B-2.5: ignores tool results that do not match the image-bearing shape', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      // Plain text result — no image conversion should happen.
      ctx.callbacks?.onToolResult?.({
        id: 'call-1',
        name: 'WebTerminalSnapshot',
        result: { sessionId: 's-1', text: 'plain text snapshot' },
      });
      // Malformed image-shape (mediaType but missing dataB64) — must
      // not synthesize a broken data URI.
      ctx.callbacks?.onToolResult?.({
        id: 'call-2',
        name: 'BrokenTool',
        result: { mediaType: 'image/png' },
      });
      return { stopReason: 'end_turn', finalText: '' };
    });
    const seen: unknown[] = [];
    const history = new DaemonSessionHistory();
    await runDaemonPromptTurn({
      history,
      request: {
        sessionId: 'sess-no-img',
        userText: 'snap',
        source: null,
        effectiveSystemPrompt: 'sys',
      },
      onImageBlock: (info) => seen.push(info),
      dispatchToolErrorMessage: 'unused',
    });
    expect(seen).toHaveLength(0);
  });

  it('B-2.5: emits one image-block per matching tool call when several fire in a turn', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      ctx.callbacks?.onToolResult?.({
        id: 'call-1',
        name: 'WebTerminalScreenshot',
        result: { mediaType: 'image/png', dataB64: 'AAA' },
      });
      ctx.callbacks?.onToolResult?.({
        id: 'call-2',
        name: 'LiveCameraFrame',
        result: { mediaType: 'image/jpeg', dataB64: 'BBB' },
      });
      return { stopReason: 'end_turn', finalText: '' };
    });
    const seen: { src: string; mediaType: string; alt?: string }[] = [];
    const history = new DaemonSessionHistory();
    await runDaemonPromptTurn({
      history,
      request: {
        sessionId: 'sess-multi',
        userText: 'capture both',
        source: null,
        effectiveSystemPrompt: 'sys',
      },
      onImageBlock: (info) => seen.push(info),
      dispatchToolErrorMessage: 'unused',
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.mediaType).toBe('image/png');
    expect(seen[1]!.mediaType).toBe('image/jpeg');
    expect(seen[0]!.alt).toBe('WebTerminalScreenshot result');
    expect(seen[1]!.alt).toBe('LiveCameraFrame result');
  });

  it("kind='none': system prompt unchanged + no surface dispatch", async () => {
    const calls: CoreTurnContext[] = [];
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx: CoreTurnContext) => {
      calls.push(ctx);
      return { stopReason: 'end_turn', finalText: 'ok' };
    });
    const history = new DaemonSessionHistory();
    await runDaemonPromptTurn({ fastPathEnabled: false,
      history,
      request: {
        sessionId: 'sess-none',
        userText: 'hi',
        source: null,
        effectiveSystemPrompt: 'Just base.',
      },
      dispatchToolErrorMessage: 'no tools',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages[0]).toEqual({ role: 'system', content: 'Just base.' });
  });
});
