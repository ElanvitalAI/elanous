// ELANOUS_STATE_DIR — the unified isolated-state knob. When set, ALL mutable
// stores (sessions, acp-sessions, surface_events, codex-threads) relocate
// under it, so an isolated process (e.g. `elanous telegram-test`) never
// touches the production daemon's state while still reusing the prod
// config. Guards the wiring in the 5 path functions.

import { setDefaultTimeout, describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const ORIG = process.env.ELANOUS_STATE_DIR;
const ORIG_SESS = process.env.ELANOUS_SESSION_ROOT;
afterEach(() => {
  if (ORIG === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = ORIG;
  if (ORIG_SESS === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = ORIG_SESS;
});

const DIR = '/tmp/elanous-state-test-xyz';

describe('ELANOUS_STATE_DIR relocates every mutable store', () => {
  test('sessions', async () => {
    delete process.env.ELANOUS_SESSION_ROOT;
    process.env.ELANOUS_STATE_DIR = DIR;
    const { sessionRoot } = await import('../src/session/index.js');
    expect(sessionRoot()).toBe(join(DIR, 'sessions'));
  });

  test('surface_events db', async () => {
    process.env.ELANOUS_STATE_DIR = DIR;
    const { surfaceEventsDbPath } = await import('../src/domains/surface-events.js');
    expect(surfaceEventsDbPath()).toBe(join(DIR, 'surface_events.db'));
  });

  test('acp session store (chat→session map)', async () => {
    process.env.ELANOUS_STATE_DIR = DIR;
    const { AcpSessionStore } = await import('../src/acp/session-store.js');
    // The default path threads through defaultStorePath(); a store built
    // with no explicit path lands under ELANOUS_STATE_DIR.
    const store = new AcpSessionStore();
    expect((store as unknown as { path: string }).path).toBe(join(DIR, 'acp-sessions.json'));
  });

  test('ELANOUS_SESSION_ROOT still wins over ELANOUS_STATE_DIR for sessions', async () => {
    process.env.ELANOUS_STATE_DIR = DIR;
    process.env.ELANOUS_SESSION_ROOT = '/tmp/explicit-sessions';
    const { sessionRoot } = await import('../src/session/index.js');
    expect(sessionRoot()).toBe('/tmp/explicit-sessions');
  });

  test('unset → falls back to the homedir default (prod unaffected)', async () => {
    // ⚠️ bun test 전역 preload(bunfig.toml)가 ELANOUS_STATE_DIR 을 tmp 로 강제하지만,
    // 이 테스트는 body 에서 명시적으로 delete → homedir 폴백을 검증하므로 격리 계약과
    // 무관(preload 는 "미설정일 때만" 강제 · 명시 delete 를 존중). 기대 경로는 memory-db-path
    // 일반화(2026-07-19)로 conatus/ → memory/ 로 이동했다(surface_events.db 는 managed memory
    // 네임스페이스). 이전 conatus/ 기대값은 stale 이었다.
    delete process.env.ELANOUS_STATE_DIR;
    delete process.env.ELANOUS_SESSION_ROOT;
    const { surfaceEventsDbPath } = await import('../src/domains/surface-events.js');
    expect(surfaceEventsDbPath()).toContain('.elanous/memory/surface_events.db');
  });
});

// Legacy-session migration must NOT run into an explicitly isolated store —
// otherwise `elanous telegram-test` (ELANOUS_STATE_DIR) gets ~90 prod sessions
// copied in, drowning the bot's real turns. Run in a subprocess so module
// state (migrationChecked) is fresh and env is fully controlled.
describe('migrateLegacySessions skips isolated stores', () => {
  let tmp: string;
  afterEach(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

  function runListSessionsCount(env: Record<string, string>): number {
    const modPath = join(import.meta.dir, '..', 'src/session/index.ts');
    const script = `const { listSessions } = await import(${JSON.stringify(modPath)}); process.stdout.write(String(listSessions().length));`;
    const proc = Bun.spawnSync(['bun', '-e', script], {
      env: { ...process.env, ...env },
    });
    return parseInt(new TextDecoder().decode(proc.stdout).trim(), 10);
  }

  test('a populated legacy store does NOT bleed into a ELANOUS_STATE_DIR store', () => {
    tmp = mkdtempSync(join(tmpdir(), 'migrate-skip-'));
    // Populate a legacy store (legacySessionRoot honors XDG_DATA_HOME).
    const legacy = join(tmp, 'xdg', 'elanous', 'sessions');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'index.json'), JSON.stringify([{ id: 'legacy-1', title: 't', updatedAt: '2020-01-01T00:00:00Z' }]));
    writeFileSync(join(legacy, 'legacy-1.jsonl'), '{"role":"user","content":"old"}\n');
    // Isolated (empty) target store.
    const state = join(tmp, 'state');

    const count = runListSessionsCount({
      XDG_DATA_HOME: join(tmp, 'xdg'),
      ELANOUS_STATE_DIR: state,
      ELANOUS_SESSION_ROOT: '',
    });
    // Guard active → isolated store stays empty (no legacy copied in).
    expect(count).toBe(0);
  });
});
