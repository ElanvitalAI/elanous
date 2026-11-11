// ── PX-2 P5: smoke — hello plugin consumer + cross-restart persist ──

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginHost, type HostHooks } from '../src/plugins/core/host';
import { FsPluginStatePersistence } from '../src/plugin-state/persistence';

function makeHooks(): HostHooks & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    log: (l) => logs.push(l),
    hudSet: () => {},
    requestRender: () => {},
    focusPane: () => {},
  };
}

describe('fixture plugin + persistentState', () => {
  let root: string;
  let builtinDir: string;
  let userRoot: string;

  // Minimal hello-clone written into the temp plugin dir for test
  // isolation. Uses an in-memory plugin fixture.
  function writeHello(): void {
    const dir = join(builtinDir, 'hello');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'plugin.ts'),
      `
      export default {
        name: 'hello',
        version: '0.1.0',
        description: 'smoke',
        initialState: () => ({ waves: 0 }),
        panes: {},
        async onActivate(ctx) {
          const ps = ctx.persistentState;
          if (ps) {
            const prior = await ps.load('counters');
            if (prior && typeof prior.waves === 'number') {
              ctx.setState({ waves: prior.waves });
            }
          }
        },
        async onDeactivate(ctx) {
          const ps = ctx.persistentState;
          if (ps) {
            await ps.persist('counters', { waves: (ctx.state && ctx.state.waves) || 0 });
          }
        },
      };
      `,
      'utf-8',
    );
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pss-smoke-'));
    builtinDir = join(root, 'plugins');
    userRoot = join(root, 'state-user');
    mkdirSync(builtinDir);
    writeHello();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('fixture plugin activate → persist → reload restores state', async () => {
    // First session — advance counter manually, deactivate to persist.
    const persistence = new FsPluginStatePersistence({ userRoot, warn: () => {} });
    const host = new PluginHost(makeHooks(), null, { statePersistence: persistence });
    (host as any).scanOverride = { builtin: builtinDir, user: '/nonexistent' };
    await (host as any).scanDir(builtinDir, 'builtin');
    await host.activate('hello');
    // Mutate state via the plugin-host's setState semantics.
    (host as any).activeEntry.state = { waves: 3 };
    await host.deactivate();

    // Confirm the file on disk holds the counter.
    const file = join(userRoot, 'hello', 'counters.json');
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    expect(raw.waves).toBe(3);

    // Second session — fresh host, same userRoot. Activate and read
    // back the restored state via the plugin's setState path.
    const host2 = new PluginHost(makeHooks(), null, {
      statePersistence: new FsPluginStatePersistence({ userRoot, warn: () => {} }),
    });
    (host2 as any).scanOverride = { builtin: builtinDir, user: '/nonexistent' };
    await (host2 as any).scanDir(builtinDir, 'builtin');
    await host2.activate('hello');
    // onActivate set state via ctx.setState({waves: 3}); check the
    // active entry reflects it.
    expect((host2 as any).activeEntry.state).toEqual({ waves: 3 });
  });

  test('fixture plugin without persistence backend still works (no-op path)', async () => {
    const host = new PluginHost(makeHooks());  // no statePersistence
    (host as any).scanOverride = { builtin: builtinDir, user: '/nonexistent' };
    await (host as any).scanDir(builtinDir, 'builtin');
    await host.activate('hello');
    // Plugin activated fine; persistentState was undefined so no load/persist.
    expect((host as any).activeEntry.name).toBe('hello');
    await host.deactivate();
    // No file was created.
    try {
      readFileSync(join(userRoot, 'hello', 'counters.json'), 'utf-8');
      throw new Error('should not exist');
    } catch (err: any) {
      expect(err.message).toMatch(/ENOENT|no such/i);
    }
  });
});
