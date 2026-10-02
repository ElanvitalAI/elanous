import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMe, operatorSignal, readOperatorConfig, readProxySecret } from './operator.js';

const SECRET = 'op-proxy-secret-0123456789abcdef';
const opts = {} as never;
const req = (headers: Record<string, string> = {}) => new Request('http://x/v1/me', { headers });
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function secretFile(mode: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'op-secret-')); dirs.push(dir);
  const path = join(dir, 'secret'); writeFileSync(path, `${SECRET}\n`); chmodSync(path, mode);
  return path;
}

test('a default install (no operator config) is never an operator — not with the right header, not as owner', () => {
  const config = readOperatorConfig(undefined);
  expect(config.enabled).toBe(false);
  for (const r of [req({ 'x-elanous-operator': SECRET }), req()]) {
    expect(operatorSignal(r, opts, { config, readSecret: () => SECRET, isOwner: () => true })).toEqual({ operator: false, operatorSource: null });
  }
});

test('enabled: the proxy header with the right secret is op-proxy; a forged one falls through', () => {
  const config = readOperatorConfig({ enabled: true, proxySecretFile: secretFile(0o600) });
  expect(operatorSignal(req({ 'x-elanous-operator': SECRET }), opts, { config, isOwner: () => false })).toEqual({ operator: true, operatorSource: 'op-proxy' });
  expect(operatorSignal(req({ 'x-elanous-operator': 'forged-forged-forged-forged' }), opts, { config, isOwner: () => false })).toEqual({ operator: false, operatorSource: null });
  expect(operatorSignal(req(), opts, { config, isOwner: () => true })).toEqual({ operator: true, operatorSource: 'owner' });
});

test('a secret file readable by others (644), missing or too short turns the header path off', () => {
  expect(readProxySecret(secretFile(0o644))).toBeNull();
  expect(readProxySecret('/no/such/file')).toBeNull();
  expect(readProxySecret(undefined)).toBeNull();
  const config = readOperatorConfig({ enabled: true, proxySecretFile: secretFile(0o644) });
  expect(operatorSignal(req({ 'x-elanous-operator': SECRET }), opts, { config, isOwner: () => false }).operator).toBe(false);
});

test('GET /v1/me answers without auth and never caches', async () => {
  const res = handleMe(req(), opts, { config: { enabled: false } });
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(await res.json()).toEqual({ operator: false, operatorSource: null });
});
