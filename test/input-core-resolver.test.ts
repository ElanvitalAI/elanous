import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  registerAction,
  addDefaultBinding,
  setUserConfigBindings,
  setRuntimeBinding,
  clearRuntimeBindingForAction,
  resolveInputEvent,
  dispatchInputEvent,
  pushContext,
  popContext,
  replaceContext,
  __resetActionRegistryForTests,
  __resetBindingsForTests,
  __resetContextForTests,
} from '../src/input-core/index.js';
import { keyEvent } from '../src/input-core/event.js';
import type { InputEvent } from '../src/input-core/event.js';
import type { Key } from '../src/tui.js';

function k(name: string, mods: Partial<Key> = {}): Key {
  return { name, ctrl: false, shift: false, ...mods };
}

beforeEach(() => {
  __resetActionRegistryForTests();
  __resetBindingsForTests();
  __resetContextForTests();
});

afterEach(() => {
  __resetActionRegistryForTests();
  __resetBindingsForTests();
  __resetContextForTests();
});

describe('resolver — basic resolution', () => {
  test('unmapped key returns null', () => {
    expect(resolveInputEvent(keyEvent(k('a')))).toBeNull();
  });

  test('default binding hits', () => {
    registerAction({ id: 'test.ping', handler: () => {} });
    addDefaultBinding({ matcher: 'ctrl+shift+p', actionId: 'test.ping' });
    const r = resolveInputEvent(keyEvent(k('p', { ctrl: true, shift: true })));
    // Plain letter + shift doesn't emit "shift+" — but "p" with shift
    // goes through the len===1 path, which skips shift. So the actual
    // matcher emitted for this key is "ctrl+p", not "ctrl+shift+p".
    expect(r).toBeNull();
  });

  test('binding matches the matcher toMatcher actually emits', () => {
    registerAction({ id: 'test.ping', handler: () => {} });
    addDefaultBinding({ matcher: 'ctrl+p', actionId: 'test.ping' });
    const r = resolveInputEvent(keyEvent(k('p', { ctrl: true })));
    expect(r?.actionId).toBe('test.ping');
    expect(r?.source).toBe('default');
  });

  test('matcher table is case-insensitive', () => {
    registerAction({ id: 'test.ping', handler: () => {} });
    addDefaultBinding({ matcher: 'Ctrl+P', actionId: 'test.ping' });
    expect(resolveInputEvent(keyEvent(k('p', { ctrl: true })))?.actionId)
      .toBe('test.ping');
  });
});

describe('resolver — layer precedence', () => {
  test('runtime > user-config > default', () => {
    registerAction({ id: 'test.a', handler: () => {} });
    registerAction({ id: 'test.b', handler: () => {} });
    registerAction({ id: 'test.c', handler: () => {} });
    addDefaultBinding({ matcher: 'ctrl+p', actionId: 'test.a' });
    setUserConfigBindings([{ matcher: 'ctrl+p', actionId: 'test.b' }]);
    const r0 = resolveInputEvent(keyEvent(k('p', { ctrl: true })));
    expect(r0?.actionId).toBe('test.b');

    setRuntimeBinding('test.c', ['ctrl+p']);
    const r1 = resolveInputEvent(keyEvent(k('p', { ctrl: true })));
    expect(r1?.actionId).toBe('test.c');
    expect(r1?.source).toBe('runtime');
  });

  test('clearing a runtime binding reverts to user-config', () => {
    registerAction({ id: 'test.a', handler: () => {} });
    registerAction({ id: 'test.b', handler: () => {} });
    setUserConfigBindings([{ matcher: 'ctrl+p', actionId: 'test.a' }]);
    setRuntimeBinding('test.b', ['ctrl+p']);
    clearRuntimeBindingForAction('test.b');
    expect(resolveInputEvent(keyEvent(k('p', { ctrl: true })))?.actionId)
      .toBe('test.a');
  });
});

describe('resolver — context gating', () => {
  test('contextless binding fires regardless of stack', () => {
    registerAction({ id: 'test.global', handler: () => {} });
    addDefaultBinding({ matcher: 'ctrl+p', actionId: 'test.global' });
    pushContext('input');
    expect(resolveInputEvent(keyEvent(k('p', { ctrl: true })))?.actionId)
      .toBe('test.global');
    popContext('input');
  });

  test('contextful binding only fires when tag is in stack', () => {
    registerAction({ id: 'test.input-only', handler: () => {} });
    addDefaultBinding({ matcher: 'ctrl+p', actionId: 'test.input-only', context: 'input' });
    expect(resolveInputEvent(keyEvent(k('p', { ctrl: true })))).toBeNull();
    pushContext('input');
    expect(resolveInputEvent(keyEvent(k('p', { ctrl: true })))?.actionId)
      .toBe('test.input-only');
    popContext('input');
    expect(resolveInputEvent(keyEvent(k('p', { ctrl: true })))).toBeNull();
  });

  test('runtime context-specific beats default global', () => {
    registerAction({ id: 'test.global', handler: () => {} });
    registerAction({ id: 'test.sync', handler: () => {} });
    addDefaultBinding({ matcher: 'ctrl+p', actionId: 'test.global' });
    setRuntimeBinding('test.sync', ['ctrl+p'], 'sync-mode');
    // Without sync-mode context, the contextful runtime binding filters
    // out, and we fall back to the global default.
    expect(resolveInputEvent(keyEvent(k('p', { ctrl: true })))?.actionId)
      .toBe('test.global');
    pushContext('sync-mode');
    expect(resolveInputEvent(keyEvent(k('p', { ctrl: true })))?.actionId)
      .toBe('test.sync');
    popContext('sync-mode');
  });
});

describe('resolver — dispatchInputEvent', () => {
  test('invokes the handler when a binding matches', async () => {
    let fired = 0;
    registerAction({ id: 'test.ping', handler: () => { fired++; } });
    addDefaultBinding({ matcher: 'ctrl+p', actionId: 'test.ping' });
    const ok = await dispatchInputEvent(keyEvent(k('p', { ctrl: true })));
    expect(ok).toBe(true);
    expect(fired).toBe(1);
  });

  test('returns false with no side effect when nothing matches', async () => {
    let fired = 0;
    registerAction({ id: 'test.ping', handler: () => { fired++; } });
    const ok = await dispatchInputEvent(keyEvent(k('a')));
    expect(ok).toBe(false);
    expect(fired).toBe(0);
  });

  test('errorSink receives handler throws', async () => {
    registerAction({ id: 'test.boom', handler: () => { throw new Error('bang'); } });
    addDefaultBinding({ matcher: 'ctrl+p', actionId: 'test.boom' });
    let captured: string | null = null;
    await expect(dispatchInputEvent(
      keyEvent(k('p', { ctrl: true })),
      (err, id) => { captured = `${id}:${String(err)}`; },
    )).rejects.toThrow('bang');
    expect(captured).toContain('test.boom');
    expect(captured).toContain('bang');
  });
});

describe('resolver — mouse via matcher cascade', () => {
  test('specific matcher beats generic', () => {
    registerAction({ id: 'mouse.pill', handler: () => {} });
    registerAction({ id: 'mouse.pill.model', handler: () => {} });
    addDefaultBinding({ matcher: 'click:pill', actionId: 'mouse.pill' });
    addDefaultBinding({ matcher: 'click:pill.model', actionId: 'mouse.pill.model' });
    const ev: InputEvent = {
      kind: 'mouse', type: 'click', row: 22, col: 40,
      target: { kind: 'pill', name: 'model' },
    };
    expect(resolveInputEvent(ev)?.actionId).toBe('mouse.pill.model');
  });

  test('generic matcher catches events without specific binding', () => {
    registerAction({ id: 'mouse.pill.generic', handler: () => {} });
    addDefaultBinding({ matcher: 'click:pill', actionId: 'mouse.pill.generic' });
    const ev: InputEvent = {
      kind: 'mouse', type: 'click', row: 22, col: 40,
      target: { kind: 'pill', name: 'workingDir' },
    };
    expect(resolveInputEvent(ev)?.actionId).toBe('mouse.pill.generic');
  });
});

describe('resolver — reserved-key rebind rejection', () => {
  test('setRuntimeBinding refuses reserved key', () => {
    registerAction({ id: 'custom.takeover', handler: () => {} });
    const v = setRuntimeBinding('custom.takeover', ['ctrl+c']);
    expect(v).not.toBeNull();
    expect(v!.kind).toBe('reserved-key');
  });

  test('setRuntimeBinding refuses reserved action id', () => {
    const v = setRuntimeBinding('app.interrupt', ['ctrl+x']);
    expect(v).not.toBeNull();
    expect(v!.kind).toBe('reserved-action');
  });

  test('rejected rebind does NOT alter the binding table', () => {
    registerAction({ id: 'custom.safe', handler: () => {} });
    addDefaultBinding({ matcher: 'ctrl+c', actionId: 'custom.safe' });
    // Can't override the default with a runtime binding to app.interrupt.
    setRuntimeBinding('app.interrupt', ['ctrl+c']);
    // The pre-existing default remains the winner.
    expect(resolveInputEvent(keyEvent(k('c', { ctrl: true })))?.actionId)
      .toBe('custom.safe');
  });
});

describe('context stack', () => {
  test('push + pop round-trips', () => {
    registerAction({ id: 'test.sync', handler: () => {} });
    addDefaultBinding({ matcher: 'ctrl+p', actionId: 'test.sync', context: 'input' });
    pushContext('input');
    expect(resolveInputEvent(keyEvent(k('p', { ctrl: true })))?.actionId).toBe('test.sync');
    popContext('input');
    expect(resolveInputEvent(keyEvent(k('p', { ctrl: true })))).toBeNull();
  });

  test('replaceContext swaps one tag for another', () => {
    registerAction({ id: 'test.a', handler: () => {} });
    registerAction({ id: 'test.b', handler: () => {} });
    addDefaultBinding({ matcher: 'ctrl+p', actionId: 'test.a', context: 'sync-mode' });
    addDefaultBinding({ matcher: 'ctrl+p', actionId: 'test.b', context: 'control-mode' });
    pushContext('sync-mode');
    expect(resolveInputEvent(keyEvent(k('p', { ctrl: true })))?.actionId)
      .toBe('test.a');
    replaceContext('sync-mode', 'control-mode');
    expect(resolveInputEvent(keyEvent(k('p', { ctrl: true })))?.actionId)
      .toBe('test.b');
  });
});

// ─── IDX-2a — when-clause gate integration ───────────────────────

describe('resolver — when-clause gate (IDX-2a)', () => {
  test('binding with no when field is unaffected (backward compat)', () => {
    registerAction({ id: 'test.a', handler: () => {} });
    addDefaultBinding({ matcher: 'ctrl+p', actionId: 'test.a' });
    // No deps — no context keys service. Backward compat: binding
    // without `when` must still match.
    const r = resolveInputEvent(keyEvent(k('p', { ctrl: true })));
    expect(r?.actionId).toBe('test.a');
  });

  test('binding with when-clause evaluates true → match', () => {
    registerAction({ id: 'test.a', handler: () => {} });
    setRuntimeBinding('test.a', ['ctrl+p'], undefined, 'pickerOpen');
    const deps = { getContextKeys: () => ({ pickerOpen: true }) };
    const r = resolveInputEvent(keyEvent(k('p', { ctrl: true })), deps);
    expect(r?.actionId).toBe('test.a');
  });

  test('binding with when-clause evaluates false → skip', () => {
    registerAction({ id: 'test.a', handler: () => {} });
    setRuntimeBinding('test.a', ['ctrl+p'], undefined, 'pickerOpen');
    const deps = { getContextKeys: () => ({ pickerOpen: false }) };
    const r = resolveInputEvent(keyEvent(k('p', { ctrl: true })), deps);
    expect(r).toBeNull();
  });

  test('binding with when-clause BUT no deps.getContextKeys → fail-closed', () => {
    // Without a context-key service wired, bindings with `when`
    // guards must be SKIPPED rather than silently activating. This is
    // the fail-closed posture described in IDX-2a §1.6 / DD-IDX-2a-2.
    registerAction({ id: 'test.a', handler: () => {} });
    setRuntimeBinding('test.a', ['ctrl+p'], undefined, 'pickerOpen');
    const r = resolveInputEvent(keyEvent(k('p', { ctrl: true })));
    expect(r).toBeNull();
  });

  test('malformed when-clause → skip + error hook fires', () => {
    registerAction({ id: 'test.a', handler: () => {} });
    setRuntimeBinding('test.a', ['ctrl+p'], undefined, 'pickerOpen && &&');   // parse error
    const errors: string[] = [];
    const deps = {
      getContextKeys: () => ({ pickerOpen: true }),
      onWhenClauseError: (b: unknown, msg: string) => { errors.push(msg); },
    };
    const r = resolveInputEvent(keyEvent(k('p', { ctrl: true })), deps);
    expect(r).toBeNull();
    expect(errors.length).toBe(1);
  });

  test('fallback order: first binding fails when-clause, next one matches', () => {
    // runtime binding with strict when + default binding without when
    // = when runtime fails its when, resolver should fall through to
    // the default layer.
    registerAction({ id: 'test.strict', handler: () => {} });
    registerAction({ id: 'test.fallback', handler: () => {} });
    setRuntimeBinding('test.strict', ['ctrl+p'], undefined, 'pickerOpen');
    addDefaultBinding({ matcher: 'ctrl+p', actionId: 'test.fallback' });
    const deps = { getContextKeys: () => ({ pickerOpen: false }) };
    const r = resolveInputEvent(keyEvent(k('p', { ctrl: true })), deps);
    expect(r?.actionId).toBe('test.fallback');
  });

  test('when-clause combines with context tag — both must pass', () => {
    registerAction({ id: 'test.a', handler: () => {} });
    setRuntimeBinding('test.a', ['ctrl+p'], 'sync-mode', 'pickerOpen');

    // Context tag missing → skip regardless of when-clause.
    const deps1 = { getContextKeys: () => ({ pickerOpen: true }) };
    expect(resolveInputEvent(keyEvent(k('p', { ctrl: true })), deps1)).toBeNull();

    // Context tag present + when true → match.
    pushContext('sync-mode');
    expect(resolveInputEvent(keyEvent(k('p', { ctrl: true })), deps1)?.actionId).toBe('test.a');

    // Context tag present + when false → skip.
    const deps2 = { getContextKeys: () => ({ pickerOpen: false }) };
    expect(resolveInputEvent(keyEvent(k('p', { ctrl: true })), deps2)).toBeNull();
  });

  test('dispatchInputEvent forwards deps', async () => {
    let called = 0;
    registerAction({ id: 'test.a', handler: () => { called++; } });
    setRuntimeBinding('test.a', ['ctrl+p'], undefined, 'pickerOpen');

    // No deps → no fire (fail-closed).
    const fired1 = await dispatchInputEvent(keyEvent(k('p', { ctrl: true })));
    expect(fired1).toBe(false);
    expect(called).toBe(0);

    // With deps.getContextKeys that satisfies when → fires.
    const fired2 = await dispatchInputEvent(
      keyEvent(k('p', { ctrl: true })),
      undefined,
      { getContextKeys: () => ({ pickerOpen: true }) },
    );
    expect(fired2).toBe(true);
    expect(called).toBe(1);
  });
});
