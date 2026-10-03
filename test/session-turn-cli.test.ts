import { setDefaultTimeout, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session/index.js';
import { _clearTurnsForTest } from '../src/session/session-input-arbiter.js';
import { startNexusHttpServer, type NexusHttpServer } from '../src/nexus/api/http-server.js';
import { NexusEventBus } from '../src/nexus/api/event-bus.js';
import { createNexusState } from '../src/nexus/state/state.js';
import { TabRegistry } from '../src/nexus/state/tab-registry.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const repoRoot = join(import.meta.dir, '..');
const token = 'session-turn-test-token';
const globallyRegisteredDaemonPort = 65530;
let root: string;
let configDir: string;
let server: NexusHttpServer | undefined;
let previousSessionRoot: string | undefined;
let previousStateDir: string | undefined;

function run(args: string[]) {
  return Bun.spawnSync({
    cmd: ['bun', 'bin/elanous.mjs', '--config-dir', configDir, ...args],
    cwd: repoRoot,
    env: { ...process.env, ELANOUS_HOME: join(root, 'global-elanous'), ELANOUS_SESSION_ROOT: root, ELANOUS_STATE_DIR: join(root, 'state') },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function runAsync(args: string[]): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(['bun', 'bin/elanous.mjs', '--config-dir', configDir, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ELANOUS_HOME: join(root, 'global-elanous'), ELANOUS_SESSION_ROOT: root, ELANOUS_STATE_DIR: join(root, 'state') },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

function startServer(): NexusHttpServer {
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  state.bus = bus;
  return startNexusHttpServer({
    state,
    registry: new TabRegistry(state),
    eventBus: bus,
    startPort: 32000 + Math.floor(Math.random() * 10000),
    portRange: 50,
    metaApi: { bearerToken: token },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'elanous-session-turn-cli-'));
  configDir = join(root, 'config');
  previousSessionRoot = process.env.ELANOUS_SESSION_ROOT;
  previousStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_SESSION_ROOT = root;
  process.env.ELANOUS_STATE_DIR = join(root, 'state');
  mkdirSync(join(configDir, 'nexus'), { recursive: true });
  mkdirSync(join(root, 'global-elanous'), { recursive: true });
  writeFileSync(join(configDir, 'acp-token'), token);
  _clearTurnsForTest();
});

afterEach(() => {
  server?.stop();
  server = undefined;
  _clearTurnsForTest();
  if (previousSessionRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
  else process.env.ELANOUS_SESSION_ROOT = previousSessionRoot;
  if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = previousStateDir;
  rmSync(root, { recursive: true, force: true });
});

describe('session turn CLI', () => {
  test('help exposes turn, takeover, and release commands', () => {
    const result = run(['session', '--help']);
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    expect(result.exitCode).toBe(0);
    expect(output).toContain('turn <prefix>');
    expect(output).toContain('takeover [options] <prefix>');
    expect(output).toContain('release [options] <prefix>');
  });

  test('turn names an unknown prefix and exits 1 before requesting the daemon', () => {
    const result = run(['session', 'turn', 'missing-prefix']);
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout.toString()}${result.stderr.toString()}`).toContain('no session matching "missing-prefix"');
  });

  test('CLI prefers its config-dir runtime over global daemon registration and shares daemon FIFO state', async () => {
    server = startServer();
    writeFileSync(join(configDir, 'nexus', 'runtime.json'), JSON.stringify({
      pid: process.pid, startedAt: new Date().toISOString(), nexusVersion: 'test', phase: 'test', httpPort: server.port, httpHost: '127.0.0.1',
    }));
    writeFileSync(join(root, 'global-elanous', 'pwa-registry.json'), JSON.stringify({
      version: 1,
      instances: [{
        pid: process.pid, ports: [globallyRegisteredDaemonPort], mode: 'static', kind: 'production', cwd: repoRoot,
        daemonDir: join(root, 'global-elanous', 'nexus'), shareMounted: false, https: false, startedAt: new Date().toISOString(),
      }],
    }));
    const session = createSession({}, root);
    const unauthorized = await fetch(`${server.url}/v1/session-turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: session.id, action: 'turn' }),
    });
    expect(unauthorized.status).toBe(401);

    const remoteRun = async (args: string[]) => {
      const result = await runAsync(args);
      const command = ['bun', 'bin/elanous.mjs', '--config-dir', configDir, ...args].join(' ');
      expect(result.exitCode, `command failed: ${command}\n${result.output}`).toBe(0);
      return result.output;
    };
    expect(await remoteRun(['session', 'takeover', session.id, '--endpoint', 'a'])).toContain('acquired: cli:a');
    expect(await remoteRun(['session', 'takeover', session.id, '--endpoint', 'b'])).toContain('held by cli:a; cli:b is waiting at position 1');
    expect(await remoteRun(['session', 'turn', session.id])).toContain('holder: cli:a. Queue: cli:b');
    expect(await remoteRun(['session', 'release', session.id, '--endpoint', 'a'])).toContain('promoted cli:b');
    expect(await remoteRun(['session', 'turn', session.id])).toContain('holder: cli:b. Queue: empty');
  });

  test('CLI rejects an invalid subscriber surface using the shared subscribe key contract', () => {
    const session = createSession({}, root);
    const result = run(['session', 'takeover', session.id, '--surface', 'invalid']);
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout.toString()}${result.stderr.toString()}`).toContain('surface must be one of cli|telegram|discord|pwa|acp|voice');
  });
});
