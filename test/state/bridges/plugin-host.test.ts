// ── Presentation P1.7 · bridgePluginHostToStore ──
//
// Wires plugin activate/deactivate lifecycle to store.plugins[id] via
// installPluginSlice / uninstallPluginSlice. Option A (method wrap).
//
// Uses a minimal fake host instead of constructing the real PluginHost
// (which requires discovery, HostHooks, display wiring, etc.). The
// bridge only depends on `active()` / `activate(name)` / `deactivate()`
// — matching those is sufficient to exercise every code path. The
// fake is cast to `PluginHost` at the bridge call-site; nothing
// production-facing leaks from the cast.

import { describe, test, expect } from 'bun:test';
import { createStore } from '../../../src/state/store.js';
import { defaultElanousState, type ElanousState } from '../../../src/state/types.js';
import { bridgePluginHostToStore } from '../../../src/state/bridges/plugin-host.js';
import type { PluginHost } from '../../../src/plugins/core/host.js';
import type { ActivePlugin } from '../../../src/plugins/core/host.js';

interface FakeState { count: number; label?: string }

class FakeHost {
  private activeEntry: { name: string; state: FakeState } | null = null;
  activationBarrier: Promise<void> | null = null;
  failNextActivation: string | null = null;

  // Seeds used by activate() to simulate different plugin state shapes.
  seeds = new Map<string, () => FakeState>();

  active(): ActivePlugin | null {
    if (!this.activeEntry) return null;
    // Only `name` + `state` are touched by the bridge. Other fields on
    // ActivePlugin are unused — cast past them.
    return this.activeEntry as unknown as ActivePlugin;
  }

  activePlugins(): ActivePlugin[] {
    return this.active() ? [this.active()!] : [];
  }

  async activate(name: string): Promise<void> {
    if (this.activationBarrier) await this.activationBarrier;
    if (this.failNextActivation === name) {
      this.failNextActivation = null;
      throw new Error(`activation failed: ${name}`);
    }
    if (this.activeEntry?.name === name) return; // idempotent (matches real plugin-host)
    if (this.activeEntry) await this.deactivate();
    const seed = this.seeds.get(name) ?? (() => ({ count: 0 }));
    this.activeEntry = { name, state: seed() };
  }

  async deactivate(_name?: string): Promise<void> {
    if (this.activationBarrier) await this.activationBarrier;
    this.activeEntry = null;
  }

  async deactivateAll(): Promise<void> {
    await this.deactivate();
  }

  // Helper used by tests to mutate active state without going through
  // activate — simulates plugin.ctx.setState writing into activeEntry.state.
  pokeState(patch: Partial<FakeState>): void {
    if (!this.activeEntry) return;
    this.activeEntry.state = { ...this.activeEntry.state, ...patch };
  }
}

function mkStore() {
  return createStore<ElanousState>(defaultElanousState());
}

function asHost(host: FakeHost): PluginHost {
  return host as unknown as PluginHost;
}

describe('bridgePluginHostToStore · initial sync', () => {
  test('no active plugin → no slice installed', () => {
    const host = new FakeHost();
    const store = mkStore();
    const dispose = bridgePluginHostToStore(store, asHost(host));
    expect(Object.keys(store.getState().plugins)).toHaveLength(0);
    dispose();
  });

  test('already-active plugin → slice installed on attach', async () => {
    const host = new FakeHost();
    host.seeds.set('alpha', () => ({ count: 7, label: 'pre-attach' }));
    await host.activate('alpha');

    const store = mkStore();
    const dispose = bridgePluginHostToStore(store, asHost(host));

    expect(store.getState().plugins.alpha).toEqual({ count: 7, label: 'pre-attach' });
    dispose();
  });
});

describe('bridgePluginHostToStore · activate → slice install', () => {
  test('activate → store.plugins[name] reflects host state', async () => {
    const host = new FakeHost();
    host.seeds.set('alpha', () => ({ count: 3 }));
    const store = mkStore();
    const dispose = bridgePluginHostToStore(store, asHost(host));

    await host.activate('alpha');
    expect(store.getState().plugins.alpha).toEqual({ count: 3 });

    dispose();
  });

  test('activate → activate (different plugin) cycles slices', async () => {
    const host = new FakeHost();
    host.seeds.set('alpha', () => ({ count: 1 }));
    host.seeds.set('beta', () => ({ count: 99, label: 'β' }));
    const store = mkStore();
    const dispose = bridgePluginHostToStore(store, asHost(host));

    await host.activate('alpha');
    expect(store.getState().plugins.alpha).toEqual({ count: 1 });

    // Real plugin-host deactivates alpha before activating beta.
    await host.activate('beta');
    // alpha slice uninstalled · beta slice installed
    expect('alpha' in store.getState().plugins).toBe(false);
    expect(store.getState().plugins.beta).toEqual({ count: 99, label: 'β' });

    dispose();
  });

  test('re-activate same plugin is idempotent (no slice duplication)', async () => {
    const host = new FakeHost();
    host.seeds.set('alpha', () => ({ count: 5 }));
    const store = mkStore();
    const dispose = bridgePluginHostToStore(store, asHost(host));

    await host.activate('alpha');
    const firstSlice = store.getState().plugins.alpha;

    await host.activate('alpha');
    // Real plugin-host early-returns on same-name re-activate · our
    // wrapper installs the slice from the still-unchanged active state.
    // Result: slice value identical (new ref is fine; value equal).
    expect(store.getState().plugins.alpha).toEqual(firstSlice as FakeState);

    dispose();
  });

  test('failed peer activation preserves a directly updated active slice', async () => {
    const host = new FakeHost();
    host.seeds.set('alpha', () => ({ count: 1 }));
    const store = mkStore();
    const dispose = bridgePluginHostToStore(store, asHost(host));

    await host.activate('alpha');
    store.setState(state => ({ plugins: { ...state.plugins, alpha: { count: 42 } } }));
    host.failNextActivation = 'beta';
    await expect(host.activate('beta')).rejects.toThrow('activation failed: beta');

    expect(store.getState().plugins.alpha).toEqual({ count: 42 });
    dispose();
  });
});

describe('bridgePluginHostToStore · deactivate → slice removal', () => {
  test('deactivate → store.plugins[name] removed', async () => {
    const host = new FakeHost();
    host.seeds.set('alpha', () => ({ count: 2 }));
    const store = mkStore();
    const dispose = bridgePluginHostToStore(store, asHost(host));

    await host.activate('alpha');
    expect('alpha' in store.getState().plugins).toBe(true);

    await host.deactivate();
    expect('alpha' in store.getState().plugins).toBe(false);

    dispose();
  });

  test('deactivate with no active plugin is a no-op', async () => {
    const host = new FakeHost();
    const store = mkStore();
    const dispose = bridgePluginHostToStore(store, asHost(host));

    await host.deactivate();
    expect(Object.keys(store.getState().plugins)).toHaveLength(0);
    dispose();
  });

  test('deactivateAll removes every previously synchronized slice', async () => {
    const host = new FakeHost();
    host.seeds.set('alpha', () => ({ count: 2 }));
    const store = mkStore();
    const dispose = bridgePluginHostToStore(store, asHost(host));

    await host.activate('alpha');
    expect('alpha' in store.getState().plugins).toBe(true);
    await host.deactivateAll();
    expect('alpha' in store.getState().plugins).toBe(false);

    dispose();
  });

  test('a queued deactivate syncs after the pending activation finishes', async () => {
    const host = new FakeHost();
    host.seeds.set('alpha', () => ({ count: 2 }));
    let release!: () => void;
    host.activationBarrier = new Promise<void>(resolve => { release = resolve; });
    const store = mkStore();
    const dispose = bridgePluginHostToStore(store, asHost(host));

    const activating = host.activate('alpha');
    await Promise.resolve();
    const deactivating = host.deactivate('alpha');
    release();
    await Promise.all([activating, deactivating]);

    expect(host.activePlugins()).toEqual([]);
    expect('alpha' in store.getState().plugins).toBe(false);
    dispose();
  });
});

describe('bridgePluginHostToStore · dispose lifecycle', () => {
  test('dispose detaches · further activate/deactivate does not touch store', async () => {
    const host = new FakeHost();
    host.seeds.set('alpha', () => ({ count: 1 }));
    host.seeds.set('beta', () => ({ count: 2 }));
    const store = mkStore();
    const dispose = bridgePluginHostToStore(store, asHost(host));

    await host.activate('alpha');
    expect(store.getState().plugins.alpha).toEqual({ count: 1 });

    dispose();

    // After dispose, further host events are invisible to the store.
    await host.deactivate();
    await host.activate('beta');
    expect(store.getState().plugins.alpha).toEqual({ count: 1 }); // still there (caller owns teardown)
    expect('beta' in store.getState().plugins).toBe(false);
  });

  test('dispose does not uninstall slice for currently-active plugin', async () => {
    const host = new FakeHost();
    host.seeds.set('alpha', () => ({ count: 42 }));
    await host.activate('alpha');

    const store = mkStore();
    const dispose = bridgePluginHostToStore(store, asHost(host));
    expect(store.getState().plugins.alpha).toEqual({ count: 42 });

    dispose();
    // Active plugin's data survives bridge detach — caller's choice
    // whether to uninstall.
    expect(store.getState().plugins.alpha).toEqual({ count: 42 });
  });

  test('double dispose is a no-op', () => {
    const host = new FakeHost();
    const store = mkStore();
    const dispose = bridgePluginHostToStore(store, asHost(host));

    dispose();
    expect(() => dispose()).not.toThrow();
  });
});

describe('bridgePluginHostToStore · isolation', () => {
  test('plugin writes via store.setState to its own slice are independent of bridge', async () => {
    const host = new FakeHost();
    host.seeds.set('alpha', () => ({ count: 0 }));
    const store = mkStore();
    const dispose = bridgePluginHostToStore(store, asHost(host));

    await host.activate('alpha');
    expect(store.getState().plugins.alpha).toEqual({ count: 0 });

    // Plugin (or test) writes directly into its own slice — no bridge
    // involvement · no echo to host.
    store.setState((s) => ({
      plugins: { ...s.plugins, alpha: { ...(s.plugins.alpha as object), count: 17 } },
    }));
    expect((store.getState().plugins.alpha as FakeState).count).toBe(17);
    // Host state unchanged · one-way lifecycle bridge doesn't pull back.
    expect((host.active()?.state as FakeState | undefined)?.count).toBe(0);

    dispose();
  });

  test('re-activate refreshes slice to current host state', async () => {
    const host = new FakeHost();
    host.seeds.set('alpha', () => ({ count: 0 }));
    const store = mkStore();
    const dispose = bridgePluginHostToStore(store, asHost(host));

    await host.activate('alpha');
    // Simulate plugin mutating its state via ctx.setState
    host.pokeState({ count: 10 });
    // Store slice is stale (bridge doesn't poll) — matches Option A
    // "plugins use store.setState directly if they want reactive mirror".
    expect((store.getState().plugins.alpha as FakeState).count).toBe(0);

    // Deactivate then re-activate · bridge re-installs from current host state
    await host.deactivate();
    await host.activate('alpha');
    // After cycle, state resets to seed(). Bridge reflects that.
    expect((store.getState().plugins.alpha as FakeState).count).toBe(0);

    dispose();
  });
});
