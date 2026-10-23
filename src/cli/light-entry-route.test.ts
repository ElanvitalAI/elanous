import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
import { selectLightCliRoute } from './light-entry-route.js';

// The deterministic gate sets ELANOUS_CONFIG_DIR, but the CLI deliberately
// ignores it and the legacy entry prints a warning. Remove that test-runner
// marker when comparing actual fast and legacy entrypoint behavior.
const { ELANOUS_CONFIG_DIR: _ignoredGateConfigDir, ...entrypointEnv } = process.env;

describe('light CLI entry routing', () => {
  test('routes only the requested query paths', () => {
    expect(selectLightCliRoute(['msg', 'list', '--to', 'MK'])).toBe('msg');
    expect(selectLightCliRoute(['msg', 'ack', '17', '--to', 'MK'])).toBe('msg');
    expect(selectLightCliRoute(['msg', 'post', '--to', 'OP', '--body', 'hello'])).toBe('msg');
    expect(selectLightCliRoute(['msg', 'watch', '--to', 'OP', '--once'])).toBe('msg');
    expect(selectLightCliRoute(['config', 'get', 'llm.provider'])).toBe('config');
    expect(selectLightCliRoute(['config', 'get', 'llm.provider', '--reveal'])).toBeUndefined();
    expect(selectLightCliRoute(['config', 'get', 'llm.provider', '--reveal=true'])).toBeUndefined();
    expect(selectLightCliRoute(['release', 'checklist', 'status', '--version', '0.2.33'])).toBe('release');
    expect(selectLightCliRoute(['release', 'checklist', 'list', '--version', '0.2.35', '--json'])).toBe('release');
    expect(selectLightCliRoute(['tasks', 'show', 'CARD-ID'])).toBe('tasks-read');
    expect(selectLightCliRoute(['tasks', 'list', '--status', 'active'])).toBe('tasks-read');
    expect(selectLightCliRoute(['tasks', '--help'])).toBe('tasks');
    expect(selectLightCliRoute(['tasks', '-h'])).toBe('tasks');
    expect(selectLightCliRoute(['tasks', 'hand', '--help'])).toBe('tasks');
    expect(selectLightCliRoute(['pty', 'list'])).toBe('pty');
    expect(selectLightCliRoute(['pty', 'snapshot', 'tui:1'])).toBe('pty');
    expect(selectLightCliRoute(['pty', 'text', 'tui:1', 'hello'])).toBe('pty');
    expect(selectLightCliRoute(['pty', 'state', 'tui:1'])).toBe('pty');
    expect(selectLightCliRoute(['logs', '--category', 'cli'])).toBe('logs');
    expect(selectLightCliRoute(['logs', '--json'])).toBe('logs');
    expect(selectLightCliRoute(['msg', 'list', '--remote', 'host'])).toBeUndefined();
    expect(selectLightCliRoute(['msg', 'list', '--remote=host'])).toBeUndefined();
    expect(selectLightCliRoute(['msg', 'list', '-rhost'])).toBeUndefined();
    expect(selectLightCliRoute(['msg', 'list', '-Vrhost'])).toBeUndefined();
    expect(selectLightCliRoute(['msg', 'list', '--help-all'])).toBeUndefined();
    expect(selectLightCliRoute(['msg', 'list', '--version'])).toBeUndefined();
    expect(selectLightCliRoute(['msg', 'list', '-V'])).toBeUndefined();
    expect(selectLightCliRoute(['tasks', 'list', '--name', 'probe'])).toBeUndefined();
    expect(selectLightCliRoute(['logs', 'bogus'])).toBeUndefined();
    expect(selectLightCliRoute(['logs', '--json', 'bogus'])).toBeUndefined();
  }, 20000);

  test('keeps root flags and leading options on the full CLI for hot commands', () => {
    expect(selectLightCliRoute(['--test=/tmp/isolated', 'msg', 'list', '--to', 'MK'])).toBeUndefined();
    expect(selectLightCliRoute(['--config-dir', '/tmp/config', 'pty', 'list'])).toBeUndefined();
    expect(selectLightCliRoute(['--config-dir=/tmp/config', 'pty', 'list'])).toBeUndefined();
    expect(selectLightCliRoute(['--test-state-dir=/tmp/state', 'msg', 'list'])).toBeUndefined();
    expect(selectLightCliRoute(['--test', 'logs', '--category', 'cli'])).toBeUndefined();
    expect(selectLightCliRoute(['tasks', 'list', '--config-dir', '/tmp/config'])).toBeUndefined();
    expect(selectLightCliRoute(['pty', 'state', 'tui:1', '--state-dir', '/tmp/state'])).toBeUndefined();
    expect(selectLightCliRoute(['--config-dir', '/tmp/config', 'config', 'get', 'llm.provider'])).toBe('config');
    expect(selectLightCliRoute(['--test=/tmp/isolated', 'release', 'checklist', 'status'])).toBe('release');
    expect(selectLightCliRoute(['--test=/tmp/isolated', 'release', 'checklist', 'list'])).toBe('release');
    expect(selectLightCliRoute(['--name', 'sample', 'msg', 'list'])).toBeUndefined();
    expect(selectLightCliRoute(['--remote', 'host', 'pty', 'list'])).toBeUndefined();
    expect(selectLightCliRoute(['--help-all', 'msg', 'list'])).toBeUndefined();
    expect(selectLightCliRoute(['--config-dir', '--test', 'msg', 'list'])).toBeUndefined();
  }, 20000);

  test('release checklist list keeps the full entry output in an isolated house', () => {
    const root = mkdtempSync(join(tmpdir(), 'light-release-list-'));
    tempDirs.push(root);
    const args = [`--test=${root}`, 'release', 'checklist', 'list', '--version', '0.2.35', '--json'];
    const fast = spawnSync('bun', ['bin/elanous.mjs', ...args], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 20000, env: entrypointEnv,
    });
    const legacy = spawnSync('bun', ['bin/elanous.mjs', ...args], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 20000,
      env: { ...entrypointEnv, ELANOUS_FAST_ROUTER: '0' },
    });
    expect([fast.status, fast.signal, fast.stdout, fast.stderr])
      .toEqual([legacy.status, legacy.signal, legacy.stdout, legacy.stderr]);
    expect(fast.status).toBe(0);
    expect(JSON.parse(fast.stdout).version).toBe('0.2.35');
  }, 45000);

  test('release checklist status preserves owner output without importing dashboard', () => {
    const root = mkdtempSync(join(tmpdir(), 'light-release-status-'));
    tempDirs.push(root);
    const seed = (id: string, owner: string) => spawnSync('bun', [
      'bin/elanous.mjs', `--test=${root}`, `--config-dir=${root}`, 'release', 'checklist', 'add', id, '운영 칸',
      '--kind', 'ops', '--owner', owner, '--version', '9.9.9',
    ], { cwd: process.cwd(), encoding: 'utf8', timeout: 20000, env: entrypointEnv });
    expect(seed('OPC-ONLY', 'OPC').status).toBe(0);
    expect(seed('MK-ONLY', 'MK').status).toBe(0);
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ release: { codenames: { '9.9.9': 'read-probe' } } }));
    const args = [`--test=${root}`, `--config-dir=${root}`, 'release', 'checklist', 'status', '--version', 'read-probe', '--owner', 'OPC', '--json'];
    const entry = new URL('../../bin/elanous.mjs', import.meta.url).href;
    const fastScript = `Bun.plugin({ name: 'block-dashboard', setup(build) { build.onLoad({ filter: /[\\/]src[\\/]dashboard[\\/]/ }, () => { throw new Error('DASHBOARD_EAGERLY_LOADED'); }); } });\n` +
      `process.argv = ['node', 'elanous', ...${JSON.stringify(args)}];\nawait import(${JSON.stringify(entry)});\n`;
    const fast = spawnSync(process.execPath, ['-e', fastScript], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 20000, env: entrypointEnv,
    });
    const legacy = spawnSync('bun', ['bin/elanous.mjs', ...args], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 20000,
      env: { ...entrypointEnv, ELANOUS_FAST_ROUTER: '0' },
    });
    expect([fast.status, fast.signal, fast.stdout, fast.stderr])
      .toEqual([legacy.status, legacy.signal, legacy.stdout, legacy.stderr]);
    expect(fast.status).toBe(0);
    expect(fast.stderr).not.toContain('DASHBOARD_EAGERLY_LOADED');
    const result = JSON.parse(fast.stdout) as { version: string; items: Array<{ id: string }>; codename: string };
    expect(result.version).toBe('9.9.9');
    expect(result.codename).toBe('read-probe');
    expect(result.items.map((item) => item.id)).toEqual(['OPC-ONLY']);
  }, 45000);

  test('subprocess config get honors isolated config and keeps src/index.ts unloaded', () => {
    const root = mkdtempSync(join(tmpdir(), 'light-config-'));
    tempDirs.push(root);
    const configDir = join(root, 'config');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ _lightEntryProbe: 'isolated-proof-987' }));
    const script = `Bun.plugin({ name: 'block-index', setup(build) { build.onLoad({ filter: /[\\\\/]src[\\\\/]index\\.ts$/ }, () => { throw new Error('INDEX_EAGERLY_LOADED'); }); } });\n` +
      `process.argv = ['node', 'elanous', 'config', 'get', '_lightEntryProbe', '--config-dir', ${JSON.stringify(configDir)}];\n` +
      `await import(${JSON.stringify(new URL('../../bin/elanous.mjs', import.meta.url).href)});\n`;
    // The remote gate sets XDG_CONFIG_HOME for its shard; that legacy config
    // path wins over --config-dir. Test the explicit directory in a clean child.
    const { XDG_CONFIG_HOME: _gateXdgConfig, ...childEnv } = process.env;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: root, encoding: 'utf8', timeout: 15000,
      env: { ...childEnv, ELANOUS_CONFIG_DIR: configDir },
    });
    expect({ status: result.status, signal: result.signal, stderr: result.stderr, stdout: result.stdout }).toMatchObject({
      status: 0, signal: null, stdout: 'isolated-proof-987\n',
    });
    expect(result.stderr).not.toContain('INDEX_EAGERLY_LOADED');
  }, 30000);

  test('msg watch --once routes lightweight; help is bounded and usable', () => {
    const help = spawnSync('bun', ['bin/elanous.mjs', 'msg', 'watch', '--help'], { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Watch durable messages');
    expect(help.stdout).toContain('--once');
    expect(help.stdout).not.toContain('unknown command');
    const root = mkdtempSync(join(tmpdir(), 'light-watch-'));
    tempDirs.push(root);
    const stateDir = join(root, 'state');
    const token = 'light-watch-proof-987';
    // Seed an explicit temporary message ledger, never the production store.
    const seed = `const { openMsgStore } = await import('./src/msg/msg-store.ts');\n` +
      `const store = openMsgStore(); store.post({ from: 'OPT', to: 'MK', body: ${JSON.stringify(token)} }); store.close();\n`;
    const env = { ...entrypointEnv, ELANOUS_STATE_DIR: stateDir };
    const seeded = spawnSync('bun', ['-e', seed], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 8000 });
    expect(seeded.status).toBe(0);
    const script = `Bun.plugin({ name: 'block-index', setup(build) { build.onLoad({ filter: /[\\\\/]src[\\\\/]index\\.ts$/ }, () => { throw new Error('INDEX_EAGERLY_LOADED'); }); } });\n` +
      `process.argv = ['node', 'elanous', 'msg', 'watch', '--to', 'MK', '--once', '--json'];\n` +
      `await import('./bin/elanous.mjs');\n`;
    const once = spawnSync(process.execPath, ['-e', script], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 8000 });
    expect([once.status, once.signal, once.stderr]).toEqual([0, null, '']);
    expect(once.stderr).not.toContain('INDEX_EAGERLY_LOADED');
    expect(once.stdout).toContain(token);
  }, 30000);

  test('legacy fallback shapes preserve exact output and return code at the entrypoint', () => {
    const root = mkdtempSync(join(tmpdir(), 'light-root-fallback-'));
    tempDirs.push(root);
    const env = { ...entrypointEnv, HOME: root, ELANOUS_STATE_DIR: join(root, 'state') };
    for (const command of [
      ['tasks', 'hand', '--help'],
      ['msg', 'list', '--help-all'],
      ['msg', 'list', '--remote', 'missing-test-bookmark'],
      ['msg', 'list', '--version'],
      ['msg', 'list', '-V'],
      ['logs', 'bogus'],
      ['logs', '--json', 'bogus'],
      ['msg', 'list', '-rmissing-test-bookmark'],
      ['msg', 'list', '-Vrhost'],
    ]) {
      const args = ['bin/elanous.mjs', ...command];
      const fast = spawnSync('bun', args, { cwd: process.cwd(), encoding: 'utf8', timeout: 15000, env });
      const legacy = spawnSync('bun', args, {
        cwd: process.cwd(), encoding: 'utf8', timeout: 20000,
        env: { ...env, ELANOUS_FAST_ROUTER: '0' },
      });
      expect([fast.status, fast.signal, fast.stdout, fast.stderr]).toEqual([legacy.status, legacy.signal, legacy.stdout, legacy.stderr]);
    }
  }, 90000);

  test('hot command help matches legacy output without importing src/index.ts', () => {
    const entry = new URL('../../bin/elanous.mjs', import.meta.url).href;
    for (const args of [
      ['msg', 'post', '--help'],
      ['pty', 'snapshot', '--help'],
      ['logs', '--help'],
      ['logs', 'timeline', '--help'],
      ['tasks', 'hand', '--help'],
    ]) {
      const fastScript = `Bun.plugin({ name: 'block-index', setup(build) { build.onLoad({ filter: /[\\\\/]src[\\\\/]index\\.ts$/ }, () => ({ contents: "throw new Error('INDEX_EAGERLY_LOADED')", loader: 'ts' })); } });\n` +
        `process.argv = ['node', 'elanous', ...${JSON.stringify(args)}];\nawait import(${JSON.stringify(entry)});\n`;
      const fast = spawnSync(process.execPath, ['-e', fastScript], { cwd: process.cwd(), encoding: 'utf8', timeout: 60000, env: entrypointEnv });
      const legacy = spawnSync('bun', ['bin/elanous.mjs', ...args], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 60000,
        env: { ...entrypointEnv, ELANOUS_FAST_ROUTER: '0' },
        stdio: 'pipe',
      });
      expect([fast.status, fast.signal, fast.stdout, fast.stderr]).toEqual([legacy.status, legacy.signal, legacy.stdout, legacy.stderr]);
      expect(fast.stderr).not.toContain('INDEX_EAGERLY_LOADED');
    }
  }, 240000);

  test('msg list output and rc match through non-TTY pipes in an isolated ledger', () => {
    const root = mkdtempSync(join(tmpdir(), 'hot-router-msg-pipe-'));
    tempDirs.push(root);
    const stateDir = join(root, 'state');
    const env = { ...entrypointEnv, ELANOUS_STATE_DIR: stateDir };
    const seed = `const { openMsgStore } = await import('./src/msg/msg-store.ts'); const store = openMsgStore(); store.post({ from: 'OP', to: 'MK', body: 'hot-router-pipe-proof' }); store.close();`;
    const seeded = spawnSync('bun', ['-e', seed], { cwd: process.cwd(), env, encoding: 'utf8', stdio: 'pipe', timeout: 8000 });
    expect([seeded.status, seeded.signal, seeded.stderr]).toEqual([0, null, '']);
    const args = ['bin/elanous.mjs', 'msg', 'list', '--to', 'MK', '--json'];
    const fast = spawnSync('bun', args, { cwd: process.cwd(), env, encoding: 'utf8', stdio: 'pipe', timeout: 8000 });
    const legacy = spawnSync('bun', args, {
      cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', timeout: 15000,
      env: { ...env, ELANOUS_FAST_ROUTER: '0' },
    });
    expect([fast.status, fast.signal, fast.stdout, fast.stderr]).toEqual([legacy.status, legacy.signal, legacy.stdout, legacy.stderr]);
    expect(fast.status).toBe(0);
    expect(fast.stdout).toContain('hot-router-pipe-proof');
  }, 30000);

  test('msg ack advances the isolated recipient cursor identically to legacy', () => {
    const root = mkdtempSync(join(tmpdir(), 'hot-router-msg-ack-'));
    tempDirs.push(root);
    const seedAndAck = (stateDir: string, legacy = false) => {
      const env = { ...entrypointEnv, ELANOUS_STATE_DIR: stateDir };
      const seed = `const { openMsgStore } = await import('./src/msg/msg-store.ts'); const store = openMsgStore(); const message = store.post({ from: 'OP', to: 'MK', body: 'ack-parity-proof' }); store.close(); console.log(message.id);`;
      const seeded = spawnSync('bun', ['-e', seed], { cwd: process.cwd(), env, encoding: 'utf8', stdio: 'pipe', timeout: 8000 });
      expect([seeded.status, seeded.signal, seeded.stderr]).toEqual([0, null, '']);
      const id = seeded.stdout.trim();
      expect(id).toMatch(/^\d+$/);
      const ack = legacy
        ? spawnSync('bun', ['bin/elanous.mjs', 'msg', 'ack', id, '--to', 'MK', '--json'], {
          cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', timeout: 15000,
          env: { ...env, ELANOUS_FAST_ROUTER: '0' },
        })
        : spawnSync(process.execPath, ['-e',
          `Bun.plugin({ name: 'block-index', setup(build) { build.onLoad({ filter: /[\\/]src[\\/]index\\.ts$/ }, () => ({ contents: "throw new Error('INDEX_EAGERLY_LOADED')", loader: 'ts' })); } });\n` +
          `process.argv = ['node', 'elanous', 'msg', 'ack', ${JSON.stringify(id)}, '--to', 'MK', '--json'];\nawait import('./bin/elanous.mjs');\n`], {
          cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', timeout: 15000, env,
        });
      const listed = spawnSync('bun', ['bin/elanous.mjs', 'msg', 'list', '--to', 'MK', '--json'], {
        cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', timeout: 15000, env,
      });
      expect(listed.status).toBe(0);
      expect(JSON.parse(listed.stdout)).toEqual([]);
      if (!legacy) expect(ack.stderr).not.toContain('INDEX_EAGERLY_LOADED');
      return [ack.status, ack.signal, ack.stdout, ack.stderr];
    };
    expect(seedAndAck(join(root, 'fast-state'))).toEqual(seedAndAck(join(root, 'legacy-state'), true));
  }, 45000);

  test('msg list preserves the legacy warning for the ignored config env marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'hot-router-config-warning-'));
    tempDirs.push(root);
    const env = {
      ...entrypointEnv,
      ELANOUS_STATE_DIR: join(root, 'state'),
      ELANOUS_CONFIG_DIR: join(root, 'ignored-config'),
    };
    const args = ['bin/elanous.mjs', 'msg', 'list', '--to', 'MK', '--json'];
    const fast = spawnSync('bun', args, { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', timeout: 15000, env });
    const legacy = spawnSync('bun', args, {
      cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', timeout: 20000,
      env: { ...env, ELANOUS_FAST_ROUTER: '0' },
    });
    expect([fast.status, fast.signal, fast.stdout, fast.stderr]).toEqual([legacy.status, legacy.signal, legacy.stdout, legacy.stderr]);
    expect(fast.status).toBe(0);
    expect(fast.stderr).toContain('ELANOUS_CONFIG_DIR 는 읽지 않습니다');
  }, 30000);

  test('hot command executions match legacy output and isolated message writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'hot-router-exec-parity-'));
    tempDirs.push(root);
    const run = (args: string[], stateDir: string, legacy = false) => spawnSync('bun', ['bin/elanous.mjs', ...args], {
      cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', timeout: 20000,
      env: {
        ...entrypointEnv, HOME: stateDir, XDG_CONFIG_HOME: join(stateDir, '.config'), ELANOUS_TEST_HOME: stateDir,
        ELANOUS_STATE_DIR: stateDir, ...(legacy ? { ELANOUS_FAST_ROUTER: '0' } : {}),
      },
    });

    const fastState = join(root, 'fast-state');
    const legacyState = join(root, 'legacy-state');
    const postArgs = ['msg', 'post', '--from', 'OPT', '--to', 'MK', '--kind', 'report', '--body', 'router-post-proof'];
    const fastPost = run(postArgs, fastState);
    const legacyPost = run(postArgs, legacyState, true);
    const normalizeTime = (value: string) => value.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<timestamp>');
    expect([fastPost.status, fastPost.signal, normalizeTime(fastPost.stdout), fastPost.stderr])
      .toEqual([legacyPost.status, legacyPost.signal, normalizeTime(legacyPost.stdout), legacyPost.stderr]);
    expect(fastPost.status).toBe(0);
    for (const stateDir of [fastState, legacyState]) {
      const env = { ...entrypointEnv, ELANOUS_STATE_DIR: stateDir };
      const listed = spawnSync('bun', ['bin/elanous.mjs', 'msg', 'list', '--to', 'MK', '--json'], {
        cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', timeout: 15000, env,
      });
      expect(listed.status).toBe(0);
      expect(JSON.parse(listed.stdout)).toMatchObject([{ from: 'OPT', to: 'MK', kind: 'report', body: 'router-post-proof' }]);
    }

    for (const args of [
      ['pty', 'snapshot', 'missing-hot-router-pty'],
      ['pty', 'text', 'missing-hot-router-pty', 'must-not-be-written'],
      ['pty', 'state', 'missing-hot-router-pty'],
      ['logs', 'instances', '--json'],
      ['tasks', 'list', '--json'],
    ]) {
      const stem = args.join('-');
      const fastState = join(root, `fast-${stem}`);
      const legacyState = args[0] === 'logs' && args[1] === 'instances' ? fastState : join(root, `legacy-${stem}`);
      const fast = run(args, fastState);
      const legacy = run(args, legacyState, true);
      expect([fast.status, fast.signal, fast.stdout, fast.stderr]).toEqual([legacy.status, legacy.signal, legacy.stdout, legacy.stderr]);
      expect(fast.signal).toBeNull();
    }
  }, 120000);

  test('leaves all other commands on the full entry', () => {
    expect(selectLightCliRoute(['msg', 'publish', '--to', 'OP'])).toBeUndefined();
    expect(selectLightCliRoute(['release', 'publish', '--yes'])).toBeUndefined();
    expect(selectLightCliRoute(['tasks', 'hand', '--live'])).toBeUndefined();
    expect(selectLightCliRoute(['tasks', 'hand', 'mission text'])).toBeUndefined();
    expect(selectLightCliRoute(['pty', 'send', 'tui:1', 'enter'])).toBeUndefined();
    expect(selectLightCliRoute(['dev', '--say', 'hello'])).toBeUndefined();
  });
});
