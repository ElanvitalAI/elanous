// NEXUS-LLM-POLICY-PANEL (0.3.33 · UX) — /v1/llm/policy GET/PUT 계약 시험.
// 실패 먼저: 구현(llm-policy-panel.ts)이 없으면 import 단계에서 RED.
// 시험은 원격 호스트(minim5)에서만 실행한다(mshq 로컬 금지 · RES-INFRA #100499).

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleLlmPolicyGet, handleLlmPolicyPut } from './llm-policy-panel.js';

const configDir = () => mkdtempSync(join(tmpdir(), 'llm-policy-panel-'));
const URL_ = 'http://hq.ts.net/v1/llm/policy';
const owner = { authorizeOwner: () => true };
const notOwner = { authorizeOwner: () => false };

describe('GET /v1/llm/policy', () => {
  test('owner: default policy + provenance (file absent)', async () => {
    const res = await handleLlmPolicyGet(new Request(URL_), { ...owner, configDir: configDir() });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { valid: boolean; filePresent: boolean; policy: { default: { provider: string } }; sources: Record<string, string> };
    expect(json.valid).toBe(true);
    expect(json.filePresent).toBe(false);
    expect(json.policy.default.provider).toBe('auto');
    expect(json.sources['default.provider']).toBe('default');
  });

  test('non-owner: 401', async () => {
    const res = await handleLlmPolicyGet(new Request(URL_), { ...notOwner, configDir: configDir() });
    expect(res.status).toBe(401);
  });
});

describe('PUT /v1/llm/policy', () => {
  test('invalid doc: 400 with rejection reasons, nothing written (previous policy preserved)', async () => {
    const dir = configDir();
    const res = await handleLlmPolicyPut(new Request(URL_, { method: 'PUT', body: 'alerts:\n  lowRemainingPercent: 999\n  typoField: 1\n' }), { ...owner, configDir: dir });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; errors: string[] };
    expect(json.error).toBe('invalid-policy');
    expect(json.errors).not.toEqual([]);
    expect(existsSync(join(dir, 'policy', 'llm.yaml'))).toBe(false);
  });

  test('valid partial doc: 200, written, reload shows merged policy from file', async () => {
    const dir = configDir();
    const res = await handleLlmPolicyPut(new Request(URL_, { method: 'PUT', body: 'alerts:\n  lowRemainingPercent: 25\n' }), { ...owner, configDir: dir });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { valid: boolean; filePresent: boolean; policy: { alerts: { lowRemainingPercent: number } }; sources: Record<string, string> };
    expect(json.valid).toBe(true);
    expect(json.filePresent).toBe(true);
    expect(json.policy.alerts.lowRemainingPercent).toBe(25);
    expect(json.sources['alerts.lowRemainingPercent']).toBe('file');
  });

  test('existing file + invalid PUT: 400 and file content byte-identical (previous policy preserved)', async () => {
    const dir = configDir();
    mkdirSync(join(dir, 'policy'), { recursive: true });
    const before = 'alerts:\n  lowRemainingPercent: 30\n';
    writeFileSync(join(dir, 'policy', 'llm.yaml'), before);
    const res = await handleLlmPolicyPut(new Request(URL_, { method: 'PUT', body: 'version: 2\n' }), { ...owner, configDir: dir });
    expect(res.status).toBe(400);
    expect(readFileSync(join(dir, 'policy', 'llm.yaml'), 'utf8')).toBe(before);
  });

  test('non-owner: 401, nothing written', async () => {
    const dir = configDir();
    const res = await handleLlmPolicyPut(new Request(URL_, { method: 'PUT', body: 'alerts:\n  lowRemainingPercent: 25\n' }), { ...notOwner, configDir: dir });
    expect(res.status).toBe(401);
    expect(existsSync(join(dir, 'policy', 'llm.yaml'))).toBe(false);
  });
});
