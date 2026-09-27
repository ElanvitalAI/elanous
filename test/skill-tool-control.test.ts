import { describe, test, expect, beforeEach } from 'bun:test';
import {
  buildControlTools,
  dispatchControlToolToggle,
  dispatchControlPromptAppend,
  dispatchControlPromptClear,
} from '../src/skills/tools/control.js';
import { ALL_CONTROL_RUNTIMES, controlPromptAppendRuntime } from '../src/tool-runtime/control-runtime.js';
import { dispatchToolByName, registerToolRuntime } from '../src/tool-runtime/registry.js';
import {
  drainPromptHintsForTurn,
  _resetPromptHintsForTesting,
} from '../src/prompt/hint-store.js';
import { nativeToolCatalog } from '../src/native-tool-catalog.js';

describe('skill-tool-control / specs', () => {
  test('builds the three essential specs with unique names and matching runtimes', () => {
    const names = buildControlTools().map(t => t.name);
    expect(names).toEqual(['ControlToolToggle', 'ControlPromptAppend', 'ControlPromptClear']);
    expect(ALL_CONTROL_RUNTIMES.map(rt => rt.spec.name)).toEqual(names);
  });
});

describe('skill-tool-control / tool toggle', () => {
  test('flips defaultEnabled on a catalog entry', async () => {
    const before = nativeToolCatalog.find(t => t.id === 'bash')!;
    const prior = before.defaultEnabled;
    const r1 = await dispatchControlToolToggle({ toolId: 'bash', enabled: !prior });
    expect(r1.ok).toBe(true);
    expect(before.defaultEnabled).toBe(!prior);
    // Restore to avoid leaking into other tests
    await dispatchControlToolToggle({ toolId: 'bash', enabled: prior });
  });

  test('unknown tool rejected', async () => {
    const r = await dispatchControlToolToggle({ toolId: 'nope', enabled: true });
    expect(r.ok).toBe(false);
  });
});

describe('skill-tool-control / prompt append', () => {
  beforeEach(() => _resetPromptHintsForTesting());

  test('runtime dispatch with text x preserves the turn-scoped result', async () => {
    registerToolRuntime(controlPromptAppendRuntime);
    expect(await dispatchToolByName('ControlPromptAppend', { text: 'x' }, { surface: 'skill' })).toEqual({
      output: 'hint stored (scope=turn, len=1)', ok: true,
    });
    expect(drainPromptHintsForTurn()).toBe('x');
  });

  test('stores turn-scoped hint and drains on turn', async () => {
    const r = await dispatchControlPromptAppend({ text: 'JSON only', scope: 'turn' });
    expect(r.ok).toBe(true);
    expect(drainPromptHintsForTurn()).toBe('JSON only');
    // Drained: next call returns empty.
    expect(drainPromptHintsForTurn()).toBe('');
  });

  test('session-scoped hint persists across turn drains', async () => {
    await dispatchControlPromptAppend({ text: 'Use bun not npm', scope: 'session' });
    expect(drainPromptHintsForTurn()).toBe('Use bun not npm');
    expect(drainPromptHintsForTurn()).toBe('Use bun not npm');
  });

  test('empty text rejected', async () => {
    const r = await dispatchControlPromptAppend({ text: '   ' });
    expect(r.ok).toBe(false);
  });

  test('prompt clear keeps the previous output and removes only requested scope', async () => {
    await dispatchControlPromptAppend({ text: 'x' });
    await dispatchControlPromptAppend({ text: 'y', scope: 'session' });
    expect(await dispatchControlPromptClear({ scope: 'turn' })).toEqual({
      output: 'cleared 1 hint(s) (scope=turn); 1 remaining', ok: true, remaining: 1,
    });
    expect(drainPromptHintsForTurn()).toBe('y');
  });
});
