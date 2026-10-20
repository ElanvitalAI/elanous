import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
import { selectLightCliRoute } from './light-entry-route.js';

describe('light CLI entry routing', () => {
  test('routes only the requested query paths', () => {
    expect(selectLightCliRoute(['msg', 'list', '--to', 'MK'])).toBe('msg');
    expect(selectLightCliRoute(['msg', 'ack', '17', '--to', 'MK'])).toBe('msg');
    expect(selectLightCliRoute(['msg', 'watch', '--to', 'OP', '--once'])).toBe('msg');
    expect(selectLightCliRoute(['config', 'get', 'llm.provider'])).toBe('config');
    expect(selectLightCliRoute(['config', 'get', 'llm.provider', '--reveal'])).toBeUndefined();
    expect(selectLightCliRoute(['config', 'get', 'llm.provider', '--reveal=true'])).toBeUndefined();
    expect(selectLightCliRoute(['release', 'checklist', 'status', '--version', '0.2.33'])).toBe('release');
    expect(selectLightCliRoute(['tasks', 'show', 'CARD-ID'])).toBe('tasks');
    expect(selectLightCliRoute(['pty', 'list'])).toBe('pty');
    expect(selectLightCliRoute(['pty', 'state', 'tui:1'])).toBe('pty');
    expect(selectLightCliRoute(['logs', '--category', 'cli'])).toBe('logs');
  });

  test('preserves recognized routing when common flags lead argv', () => {
    expect(selectLightCliRoute(['--test=/tmp/isolated', 'msg', 'list', '--to', 'MK'])).toBe('msg');
    expect(selectLightCliRoute(['--config-dir', '/tmp/config', 'pty', 'list'])).toBe('pty');
    expect(selectLightCliRoute(['--config-dir=/tmp/config', 'pty', 'list'])).toBe('pty');
    expect(selectLightCliRoute(['--test-state-dir=/tmp/state', 'msg', 'list'])).toBe('msg');
    expect(selectLightCliRoute(['--test', 'logs', '--category', 'cli'])).toBe('logs');
    expect(selectLightCliRoute(['--name', 'sample', 'msg', 'list'])).toBeUndefined();
    expect(selectLightCliRoute(['--remote', 'host', 'pty', 'list'])).toBeUndefined();
    expect(selectLightCliRoute(['--help-all', 'msg', 'list'])).toBeUndefined();
    expect(selectLightCliRoute(['--config-dir', '--test', 'msg', 'list'])).toBeUndefined();
  });

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
  });

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
    const env = { ...process.env, ELANOUS_STATE_DIR: stateDir };
    const seeded = spawnSync('bun', ['-e', seed], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 8000 });
    expect(seeded.status).toBe(0);
    const script = `Bun.plugin({ name: 'block-index', setup(build) { build.onLoad({ filter: /[\\\\/]src[\\\\/]index\\.ts$/ }, () => { throw new Error('INDEX_EAGERLY_LOADED'); }); } });\n` +
      `process.argv = ['node', 'elanous', 'msg', 'watch', '--to', 'MK', '--once', '--json'];\n` +
      `await import('./bin/elanous.mjs');\n`;
    const once = spawnSync(process.execPath, ['-e', script], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 8000 });
    expect([once.status, once.signal, once.stderr]).toEqual([0, null, '']);
    expect(once.stderr).not.toContain('INDEX_EAGERLY_LOADED');
    expect(once.stdout).toContain(token);
  });

  test('leaves all other commands on the full entry', () => {
    expect(selectLightCliRoute(['msg', 'post', '--to', 'OP'])).toBeUndefined();
    expect(selectLightCliRoute(['release', 'publish', '--yes'])).toBeUndefined();
    expect(selectLightCliRoute(['tasks', 'hand', '--live'])).toBeUndefined();
    expect(selectLightCliRoute(['pty', 'send', 'tui:1', 'enter'])).toBeUndefined();
    expect(selectLightCliRoute(['dev', '--say', 'hello'])).toBeUndefined();
  });
});
