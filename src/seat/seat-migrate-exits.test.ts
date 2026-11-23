// ELS-UPDATE-ALL-MIGRATE-EXITS: `els update-all` left eln seat tabs exited on 11-23 22:29 because each seat
// had already relaunched twice that evening (generation 3 → `tui.self-restart blocked generation-limit`).
// Expectations are literals, not product constants.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { planTuiRestartArgv, readTuiRestartGeneration, runTuiSelfRestartOnStaleBuild } from '../index.js';

const saved = { gen: process.env.ELANOUS_TUI_RESTART_GEN, at: process.env.ELANOUS_TUI_RESTART_AT };
beforeEach(() => { delete process.env.ELANOUS_TUI_RESTART_GEN; delete process.env.ELANOUS_TUI_RESTART_AT; });
afterEach(() => {
  if (saved.gen === undefined) delete process.env.ELANOUS_TUI_RESTART_GEN; else process.env.ELANOUS_TUI_RESTART_GEN = saved.gen;
  if (saved.at === undefined) delete process.env.ELANOUS_TUI_RESTART_AT; else process.env.ELANOUS_TUI_RESTART_AT = saved.at;
});

type Spawn = { argv: string[]; env: Record<string, string> };
const migrateDeps = (spawns: Spawn[], codes: number[], clock: () => number, events: [string, Record<string, unknown>][] = []) => ({
  migrateSessionId: 'session-42', scriptPath: '/opt/current/bin/elanous.mjs', fallbackScriptPath: '/opt/old/bin/elanous.mjs',
  args: ['--provider', 'openai-codex', '--model', 'gpt-6.1-terra'],
  stale: () => ({ stale: true, reason: 'installed-moved' }), owned: () => ({ sessionId: 'session-42', at: 1 }),
  liveActiveSessionId: () => 'session-42', sessionExists: () => true, globalLatestSessionId: () => null,
  sessionProvider: () => undefined, retireCurrentTui: () => {}, turnLifeLog: () => {}, now: clock,
  spawnChild: async (_command: string, argv: readonly string[], env: Record<string, string>) => {
    spawns.push({ argv: [...argv], env }); return codes.shift() ?? 0;
  },
  log: (event: string, detail: Record<string, unknown>) => { events.push([event, detail]); },
});

describe('restart generation counts only a fast loop', () => {
  test('generation resets when the previous relaunch is older than 60s or unstamped', () => {
    expect(readTuiRestartGeneration({ ELANOUS_TUI_RESTART_GEN: '3', ELANOUS_TUI_RESTART_AT: '1000' }, 1000 + 30_000)).toBe(3);
    expect(readTuiRestartGeneration({ ELANOUS_TUI_RESTART_GEN: '3', ELANOUS_TUI_RESTART_AT: '1000' }, 1000 + 61_000)).toBe(0);
    // A seat started by the old build carries GEN without AT.
    expect(readTuiRestartGeneration({ ELANOUS_TUI_RESTART_GEN: '3' }, 5000)).toBe(0);
    expect(readTuiRestartGeneration({}, 5000)).toBe(0);
  });

  test('third migration of the evening relaunches instead of generation-limit', async () => {
    process.env.ELANOUS_TUI_RESTART_GEN = '2';
    process.env.ELANOUS_TUI_RESTART_AT = String(Date.parse('2026-11-23T12:26:32Z'));
    const spawns: Spawn[] = [];
    let t = Date.parse('2026-11-23T13:29:36Z');
    const result = await runTuiSelfRestartOnStaleBuild(migrateDeps(spawns, [0], () => (t += 1_000)));
    expect(result.outcome).toBe('relaunch');
    expect(spawns.map(s => s.argv)).toEqual([
      ['/opt/current/bin/elanous.mjs', '--provider', 'openai-codex', '--model', 'gpt-6.1-terra', '--resume', 'session-42'],
    ]);
    expect(spawns[0]!.env.ELANOUS_TUI_RESTART_GEN).toBe('1');
    expect(spawns[0]!.env.ELANOUS_TUI_RESTART_AT).toBe(String(Date.parse('2026-11-23T13:29:38Z')));
  });

  test('three relaunches inside the window are still refused', async () => {
    process.env.ELANOUS_TUI_RESTART_GEN = '3';
    process.env.ELANOUS_TUI_RESTART_AT = '1000000';
    const spawns: Spawn[] = [];
    const result = await runTuiSelfRestartOnStaleBuild(migrateDeps(spawns, [0], () => 1_010_000));
    expect(result).toEqual({ outcome: 'blocked', reason: 'generation-limit' });
    expect(spawns).toEqual([]);
  });
});

describe('fail-safe when the new TUI does not come up', () => {
  test('child exits non-zero within 15s -> original command relaunches the same session once', async () => {
    const spawns: Spawn[] = [];
    const events: [string, Record<string, unknown>][] = [];
    let t = 0;
    const result = await runTuiSelfRestartOnStaleBuild(migrateDeps(spawns, [1, 0], () => (t += 2_000), events));
    expect(spawns.map(s => s.argv)).toEqual([
      ['/opt/current/bin/elanous.mjs', '--provider', 'openai-codex', '--model', 'gpt-6.1-terra', '--resume', 'session-42'],
      ['/opt/old/bin/elanous.mjs', '--provider', 'openai-codex', '--model', 'gpt-6.1-terra', '--resume', 'session-42'],
    ]);
    expect(result).toEqual({ outcome: 'relaunch', reason: 'fallback-after-child-fast-exit', sessionId: 'session-42',
      argv: ['/opt/old/bin/elanous.mjs', '--provider', 'openai-codex', '--model', 'gpt-6.1-terra', '--resume', 'session-42'], exitCode: 0 });
    expect(events.map(([event]) => event)).toEqual(['relaunch', 'fallback']);
    expect(events[1]![1]).toMatchObject({ reason: 'child-fast-exit', exitCode: 1, livedMs: 2000 });
  });

  test('fallback drops a /provider rewrite and uses the launch flags', async () => {
    const spawns: Spawn[] = [];
    let t = 0;
    await runTuiSelfRestartOnStaleBuild({ ...migrateDeps(spawns, [1, 0], () => (t += 1_000)),
      args: ['--tui', 'next', '--provider', 'glm', '--model', 'glm-5.3'],
      sessionProvider: () => ({ provider: 'openai-codex', model: 'gpt-6.1-terra' }) });
    expect(spawns.map(s => s.argv)).toEqual([
      ['/opt/current/bin/elanous.mjs', '--provider', 'openai-codex', '--model', 'gpt-6.1-terra', '--tui', 'next', '--resume', 'session-42'],
      ['/opt/old/bin/elanous.mjs', '--tui', 'next', '--provider', 'glm', '--model', 'glm-5.3', '--resume', 'session-42'],
    ]);
  });

  test('a child that ran past 15s keeps its exit code and gets no fallback', async () => {
    const spawns: Spawn[] = [];
    let t = 0;
    const result = await runTuiSelfRestartOnStaleBuild(migrateDeps(spawns, [7], () => (t += 20_000)));
    expect(spawns).toHaveLength(1);
    expect(result.exitCode).toBe(7);
    expect(result.reason).toBe('installed-moved');
  });

  test('a clean exit 0 right away gets no fallback', async () => {
    const spawns: Spawn[] = [];
    let t = 0;
    const result = await runTuiSelfRestartOnStaleBuild(migrateDeps(spawns, [0], () => (t += 100)));
    expect(spawns).toHaveLength(1);
    expect(result.exitCode).toBe(0);
  });
});

test('relaunch argv shape without a /provider override keeps launch flags in place', () => {
  expect(planTuiRestartArgv({ scriptPath: '/opt/elanous.mjs', args: ['--tui', 'next', '--provider', 'glm', '--model', 'glm-5.3'], sessionId: 's1' }))
    .toEqual(['/opt/elanous.mjs', '--tui', 'next', '--provider', 'glm', '--model', 'glm-5.3', '--resume', 's1']);
});
