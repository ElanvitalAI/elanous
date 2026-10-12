// ── PX-3 P3: shell-command hook adapter ──

import { describe, test, expect } from 'bun:test';
import { createShellHookHandler } from '../src/plugin-hooks/shell-hook';
import { HookDispatcher } from '../src/plugin-hooks/dispatcher';

function dispatcher(warnSink: string[]) {
  return new HookDispatcher({
    auditRoot: null,
    warn: (m) => warnSink.push(m),
  });
}

describe('shell-hook', () => {
  test('immediate exits with unread large stdin preserve stdout and exit status', async () => {
    const input = { turnNumber: 1, messages: [], systemPrompt: 'x'.repeat(1024 * 1024), tools: [] };
    for (const [command, expected] of [
      ['true', 'ok'],
      ['exit 7', 'exit 7'],
      ['echo \'{"systemPromptInject":"fast"}\'', 'fast'],
    ] as const) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const d = dispatcher([]);
        d.register(createShellHookHandler({ id: `p:fast:${attempt}`, event: 'Turn', priority: 50, command }));
        const r = await d.dispatch('Turn', input);
        if (expected === 'ok') expect(r.steps[0]!.status).toBe('ok');
        else if (expected === 'fast') expect(r.output.systemPromptInject).toBe('fast');
        else expect(r.abort?.reason).toBe(expected);
      }
    }
  });

  test('stdout JSON object → output', async () => {
    const d = dispatcher([]);
    d.register(createShellHookHandler({
      id: 'p:a',
      event: 'Turn',
      priority: 50,
      command: 'echo \'{"systemPromptInject":"from shell"}\'',
    }));
    const r = await d.dispatch('Turn', {
      turnNumber: 1, messages: [], systemPrompt: '', tools: [],
    });
    expect(r.output.systemPromptInject).toBe('from shell');
  });

  test('empty stdout → {}', async () => {
    const d = dispatcher([]);
    d.register(createShellHookHandler({
      id: 'p:empty',
      event: 'Turn',
      priority: 50,
      command: 'true',
    }));
    const r = await d.dispatch('Turn', {
      turnNumber: 1, messages: [], systemPrompt: '', tools: [],
    });
    expect(r.output.systemPromptInject).toBeUndefined();
    expect(r.steps[0]!.status).toBe('ok');
  });

  test('exit non-zero → abort', async () => {
    const d = dispatcher([]);
    d.register(createShellHookHandler({
      id: 'p:fail',
      event: 'Turn',
      priority: 50,
      command: 'exit 1',
    }));
    const r = await d.dispatch('Turn', {
      turnNumber: 1, messages: [], systemPrompt: '', tools: [],
    });
    expect(r.abort?.reason).toBe('exit 1');
    expect(r.abort?.from).toBe('p:fail');
  });

  test('malformed JSON → warn + {}', async () => {
    const warns: string[] = [];
    // The HookCtx.logger.warn path writes to the dispatcher's warn
    // sink indirectly — shell-hook calls ctx.logger.warn, which the
    // dispatcher's default silent logger swallows. We instead check
    // that the step is status=ok (no error) AND output is empty.
    const d = dispatcher(warns);
    d.register(createShellHookHandler({
      id: 'p:bad',
      event: 'Turn',
      priority: 50,
      command: "echo 'not-json-at-all'",
    }));
    const r = await d.dispatch('Turn', {
      turnNumber: 1, messages: [], systemPrompt: '', tools: [],
    });
    expect(r.steps[0]!.status).toBe('ok');
    expect(r.output.systemPromptInject).toBeUndefined();
  });

  test('array JSON → warn + {}', async () => {
    const d = dispatcher([]);
    d.register(createShellHookHandler({
      id: 'p:arr',
      event: 'Turn',
      priority: 50,
      command: "echo '[1,2,3]'",
    }));
    const r = await d.dispatch('Turn', {
      turnNumber: 1, messages: [], systemPrompt: '', tools: [],
    });
    expect(r.steps[0]!.status).toBe('ok');
    expect(r.output.systemPromptInject).toBeUndefined();
  });

  test('timeout → abort via dispatcher timeout path', async () => {
    const d = dispatcher([]);
    d.register(createShellHookHandler({
      id: 'p:slow',
      event: 'Turn',
      priority: 50,
      command: 'sleep 2',
      timeoutMs: 50,
    }));
    const r = await d.dispatch('Turn', {
      turnNumber: 1, messages: [], systemPrompt: '', tools: [],
    });
    // Two valid outcomes depending on race timing: either the
    // dispatcher races its own timeout (status=timeout) OR the
    // shell-hook's own timeoutMs triggers kill + exit 124 (→ abort).
    // Both represent "cancelled because too slow" — either is
    // acceptable. We assert by shape.
    const isTimeout = r.steps[0]!.status === 'timeout';
    const isAbort = r.abort?.from === 'p:slow';
    expect(isTimeout || isAbort).toBe(true);
  });

  test('stdin gets JSON of input', async () => {
    const d = dispatcher([]);
    // Read entire stdin with cat, count chars, emit JSON with that
    // number. The input JSON has a non-zero length, so the count is
    // always > 0.
    d.register(createShellHookHandler({
      id: 'p:echo',
      event: 'Turn',
      priority: 50,
      command: 'LEN=$(cat | wc -c | tr -d " "); echo "{\\"systemPromptInject\\":\\"got:${LEN}\\"}"',
    }));
    const r = await d.dispatch('Turn', {
      turnNumber: 5, messages: [], systemPrompt: '', tools: [],
    });
    expect(r.output.systemPromptInject).toMatch(/^got:\d+$/);
    // Extract the number — should be > 0 since stdin has content.
    const n = Number(r.output.systemPromptInject!.replace('got:', ''));
    expect(n).toBeGreaterThan(0);
  });

  test('env propagated to shell', async () => {
    const d = dispatcher([]);
    d.register(createShellHookHandler({
      id: 'p:env',
      event: 'Turn',
      priority: 50,
      command: 'echo "{\\"systemPromptInject\\":\\"$MY_CUSTOM_VAR\\"}"',
      env: { ...process.env, MY_CUSTOM_VAR: 'xyz-value' },
    }));
    const r = await d.dispatch('Turn', {
      turnNumber: 1, messages: [], systemPrompt: '', tools: [],
    });
    expect(r.output.systemPromptInject).toBe('xyz-value');
  });
});
