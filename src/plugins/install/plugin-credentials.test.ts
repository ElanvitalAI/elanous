import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialStatus, pluginEnv, setPluginCredentials } from './plugin-credentials.js';

const dirs: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'plugin-credentials-'));
  dirs.push(root);
  return root;
}
function install(root: string, name: string, fields: unknown[] = [{ name: 'api-key', secret: true }, { name: 'region' }]): void {
  const path = join(root, 'plugins', 'local', name, '1.0.0');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'plugin.ts'), 'export default {}');
  writeFileSync(join(path, 'plugin.json'), JSON.stringify({ id: name, version: '1.0.0', main: './plugin.ts',
    contributes: { connectors: [{ id: 'service', fields }] } }));
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('installed plugin credentials', () => {
  test('0600 atomic writes, partial merge, deletion, and no leftover temporary file', () => {
    const root = fixture();
    install(root, 'sample-plugin');
    const file = join(root, 'plugins', 'credentials', 'sample-plugin.json');
    expect(credentialStatus('sample-plugin', root)).toEqual({ fields: [
      { name: 'api-key', env: 'ELANOUS_PLUGIN_SAMPLE_PLUGIN_API_KEY', set: false },
      { name: 'region', env: 'ELANOUS_PLUGIN_SAMPLE_PLUGIN_REGION', set: false },
    ] });
    expect(existsSync(file)).toBe(false);
    expect(setPluginCredentials('sample-plugin', { 'api-key': 'top-secret', region: 'west' }, root)).toEqual({ set: ['api-key', 'region'] });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'plugins', 'credentials')).mode & 0o777).toBe(0o700);
    const inode = lstatSync(file).ino;
    expect(setPluginCredentials('sample-plugin', { region: 'east' }, root)).toEqual({ set: ['region'] });
    expect(lstatSync(file).ino).not.toBe(inode);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'api-key': 'top-secret', region: 'east' });
    expect(setPluginCredentials('sample-plugin', { 'api-key': null }, root)).toEqual({ set: [] });
    expect(credentialStatus('sample-plugin', root).fields.map(field => field.set)).toEqual([false, true]);
    expect(pluginEnv('sample-plugin', root)).toEqual({ ELANOUS_PLUGIN_SAMPLE_PLUGIN_REGION: 'east' });
    expect(readdirSync(join(root, 'plugins', 'credentials'))).toEqual(['sample-plugin.json']);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('replacement restores 0600 permissions on a legacy credential file', () => {
    const root = fixture();
    install(root, 'sample-plugin');
    const file = join(root, 'plugins', 'credentials', 'sample-plugin.json');
    setPluginCredentials('sample-plugin', { 'api-key': 'old-value' }, root);
    chmodSync(file, 0o644);
    setPluginCredentials('sample-plugin', { region: 'new-value' }, root);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(pluginEnv('sample-plugin', root)).toEqual({
      ELANOUS_PLUGIN_SAMPLE_PLUGIN_API_KEY: 'old-value',
      ELANOUS_PLUGIN_SAMPLE_PLUGIN_REGION: 'new-value',
    });
  });

  test('status lists field names, derived and explicit environment names and set flags, never secrets', () => {
    const root = fixture();
    install(root, 'weather-plugin', [{ name: 'apiKey', env: 'WEATHER_TOKEN', secret: true }, { name: 'unused_key' }]);
    setPluginCredentials('weather-plugin', { apiKey: 'never-in-status' }, root);
    const status = credentialStatus('weather-plugin', root);
    expect(status).toEqual({ fields: [
      { name: 'apiKey', env: 'WEATHER_TOKEN', set: true },
      { name: 'unused_key', env: 'ELANOUS_PLUGIN_WEATHER_PLUGIN_UNUSED_KEY', set: false },
    ] });
    expect(JSON.stringify(status)).not.toContain('never-in-status');
    expect(pluginEnv('weather-plugin', root)).toEqual({ WEATHER_TOKEN: 'never-in-status' });
  });

  test('an explicitly declared __proto__ environment name remains an own property', () => {
    const root = fixture();
    install(root, 'prototype-plugin', [{ name: 'token', env: '__proto__', secret: true }]);
    setPluginCredentials('prototype-plugin', { token: 'prototype-secret' }, root);
    expect(credentialStatus('prototype-plugin', root)).toEqual({ fields: [
      { name: 'token', env: '__proto__', set: true },
    ] });
    const env = pluginEnv('prototype-plugin', root);
    expect(Object.getPrototypeOf(env)).toBeNull();
    expect(Object.hasOwn(env, '__proto__')).toBe(true);
    expect(env['__proto__']).toBe('prototype-secret');
    expect(Object.keys(env)).toEqual(['__proto__']);
  });

  test('userConfig keys derive env names and state-root isolation follows the configured instance', () => {
    const isolated = fixture();
    const other = fixture();
    const previous = process.env.ELANOUS_STATE_DIR;
    install(isolated, 'legacy-plugin');
    install(other, 'legacy-plugin');
    const manifest = join(isolated, 'plugins', 'local', 'legacy-plugin', '1.0.0', 'plugin.json');
    writeFileSync(manifest, JSON.stringify({ id: 'legacy-plugin', version: '1.0.0', main: './plugin.ts',
      contributes: { connectors: [{ id: 'service', userConfig: [{ key: 'access-token', secret: true }] }] } }));
    process.env.ELANOUS_STATE_DIR = isolated;
    try {
      expect(setPluginCredentials('legacy-plugin', { 'access-token': 'isolated-secret' })).toEqual({ set: ['access-token'] });
      expect(pluginEnv('legacy-plugin')).toEqual({ ELANOUS_PLUGIN_LEGACY_PLUGIN_ACCESS_TOKEN: 'isolated-secret' });
      expect(pluginEnv('legacy-plugin', other)).toEqual({});
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous;
    }
  });

  test('only declared fields can be set; a rejected update leaves prior data unchanged', () => {
    const root = fixture();
    install(root, 'sample-plugin');
    setPluginCredentials('sample-plugin', { 'api-key': 'original' }, root);
    expect(() => setPluginCredentials('sample-plugin', { region: 'north', UNKNOWN: 'wrong' }, root)).toThrow('invalid plugin credential field');
    expect(pluginEnv('sample-plugin', root)).toEqual({ ELANOUS_PLUGIN_SAMPLE_PLUGIN_API_KEY: 'original' });
    expect(() => setPluginCredentials('../sample-plugin', { 'api-key': 'wrong' }, root)).toThrow('invalid plugin name');
    expect(() => setPluginCredentials('absent-plugin', { 'api-key': 'wrong' }, root)).toThrow('plugin not installed');
  });

  test('each plugin stores and exposes only its own values, including shared field names', () => {
    const root = fixture();
    install(root, 'first-plugin');
    install(root, 'other-plugin');
    setPluginCredentials('first-plugin', { 'api-key': 'first-value' }, root);
    setPluginCredentials('other-plugin', { 'api-key': 'second-value' }, root);
    expect(pluginEnv('first-plugin', root)).toEqual({ ELANOUS_PLUGIN_FIRST_PLUGIN_API_KEY: 'first-value' });
    expect(pluginEnv('other-plugin', root)).toEqual({ ELANOUS_PLUGIN_OTHER_PLUGIN_API_KEY: 'second-value' });
    expect(JSON.stringify(credentialStatus('other-plugin', root))).not.toContain('first-value');
  });
});
