import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decidePluginInstallation, enabledPluginHooks, PluginTrustStore } from './trust-store.js';
import type { PluginSecurityDecision } from './capability-policy.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
test('ephemeral security decisions and hook consent never alter persisted trust schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trust-security-')); dirs.push(dir);
  const file = join(dir, 'trust.json');
  const store = new PluginTrustStore(file);
  store.setTrusted('sample', 'user', true, new Date('2026-01-01T00:00:00.000Z'));
  const before = readFileSync(file, 'utf8');
  const safe: PluginSecurityDecision = { scan: 'safe', findings: [], integrity: 'a'.repeat(64), license: 'unknown' };
  expect(decidePluginInstallation(safe, ['network'], false)).toEqual({ ok: false, reason: 'consent-denied' });
  expect(decidePluginInstallation(safe, ['network'], true)).toEqual({ ok: true });
  expect(decidePluginInstallation({ ...safe, scan: 'dangerous' }, [], true)).toEqual({ ok: false, reason: 'scan' });
  const hook = { id: 'turn', command: 'echo ok' };
  expect(enabledPluginHooks([hook], 'installed')).toEqual([]);
  expect(enabledPluginHooks([hook], 'builtin')).toEqual([hook]);
  expect(enabledPluginHooks([hook], 'user')).toEqual([hook]);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(JSON.parse(before)).toEqual({ version: 1, records: [{ pluginId: 'sample', scope: 'user', trusted: true, updatedAt: '2026-01-01T00:00:00.000Z' }] });
});
