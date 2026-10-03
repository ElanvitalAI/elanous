// M1-2b (PLAN-friction-free-model-selection-ux-2026-05-12 · Phase 1) —
// /v1/config/model-tier handler unit tests.
//
// Drives the GET/PUT handlers directly with a sandboxed
// XDG_CONFIG_HOME so the test never touches the user's real config.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  handleModelTierGet,
  handleModelTierPut,
} from '../../src/nexus/api/config-model-tier.js';
import { __resetXdgDeprecationWarningForTests, reloadUserConfig, userConfigPath } from '../../src/user-config.js';

let tmpDir: string;
const PREV_XDG = process.env.XDG_CONFIG_HOME;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'm1-2b-'));
  process.env.XDG_CONFIG_HOME = tmpDir;
  process.env.ELANOUS_SUPPRESS_XDG_WARNING = '1';
  __resetXdgDeprecationWarningForTests();
  // Force buildUserConfig cache to drop the previous test's state.
  reloadUserConfig();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (PREV_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = PREV_XDG;
  reloadUserConfig();
});

function putRequest(body: unknown): Request {
  return new Request('http://localhost/v1/config/model-tier', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function asJson(res: Response): Promise<Record<string, unknown>> {
  return await res.json() as Record<string, unknown>;
}

describe('M1-2b · GET /v1/config/model-tier', () => {
  test('legacy on-disk key is read and emitted as profile', async () => {
    mkdirSync(join(userConfigPath(), '..'), { recursive: true });
    writeFileSync(userConfigPath(), JSON.stringify({ modelTier: { persona: 'power' } }));
    const res = handleModelTierGet();
    expect(res.status).toBe(200);
    expect((await asJson(res)).modelTier).toEqual({ profile: 'power' });
  });

  test('empty user-config → empty body', async () => {
    const res = handleModelTierGet();
    expect(res.status).toBe(200);
    const body = await asJson(res);
    expect(body).toEqual({});
  });
});

describe('M1-2b · PUT /v1/config/model-tier', () => {
  test('writes modelTier.voice.stt + GET round-trips', async () => {
    const res = await handleModelTierPut(putRequest({ modelTier: { voice: { stt: 'best' } } }));
    expect(res.status).toBe(200);
    const body = await asJson(res);
    expect(body.modelTier).toEqual({ voice: { stt: 'best' } });

    // On-disk shape: file contains the sparse modelTier sub-tree.
    const raw = JSON.parse(readFileSync(userConfigPath(), 'utf-8')) as Record<string, unknown>;
    expect(raw.modelTier).toEqual({ voice: { stt: 'best' } });

    // GET reads it back.
    const getRes = handleModelTierGet();
    const getBody = await asJson(getRes);
    expect(getBody.modelTier).toEqual({ voice: { stt: 'best' } });
  });

  test('accepts legacy request but echoes and persists only model tier profile', async () => {
    const res = await handleModelTierPut(putRequest({ modelTier: { persona: 'power' } }));
    expect(res.status).toBe(200);
    expect((await asJson(res)).modelTier).toEqual({ profile: 'power' });
    const raw = JSON.parse(readFileSync(userConfigPath(), 'utf8')) as { modelTier: unknown };
    expect(raw.modelTier).toEqual({ profile: 'power' });
    expect((await asJson(handleModelTierGet())).modelTier).toEqual({ profile: 'power' });
  });

  test('new request profile wins over legacy key; rejects invalid profile', async () => {
    const res = await handleModelTierPut(putRequest({ modelTier: { persona: 'power', profile: 'casual' } }));
    expect(res.status).toBe(200);
    expect((await asJson(res)).modelTier).toEqual({ profile: 'casual' });
    const invalid = await handleModelTierPut(putRequest({ modelTier: { persona: 'power', profile: 'invalid' } }));
    expect(invalid.status).toBe(400);
  });

  test('writes budget.monthlyUsdCap with sparse semantics', async () => {
    const res = await handleModelTierPut(putRequest({ budget: { monthlyUsdCap: 25 } }));
    expect(res.status).toBe(200);
    const body = await asJson(res);
    expect(body.budget).toEqual({ monthlyUsdCap: 25 });
  });

  test('rejects unknown tier', async () => {
    const res = await handleModelTierPut(putRequest({ modelTier: { voice: { stt: 'ultra' } } }));
    expect(res.status).toBe(400);
    const body = await asJson(res);
    expect(body.error).toBe('invalid-tier');
  });

  test('rejects negative monthlyUsdCap', async () => {
    const res = await handleModelTierPut(putRequest({ budget: { monthlyUsdCap: -1 } }));
    expect(res.status).toBe(400);
    const body = await asJson(res);
    expect(body.error).toBe('invalid-budget');
  });

  test('rejects non-boolean autoSuggest', async () => {
    const res = await handleModelTierPut(putRequest({ smartDefaults: { autoSuggest: 'yes' } }));
    expect(res.status).toBe(400);
    const body = await asJson(res);
    expect(body.error).toBe('invalid-smart-defaults');
  });

  test('rejects empty body (no fields supplied)', async () => {
    const res = await handleModelTierPut(putRequest({}));
    expect(res.status).toBe(400);
    const body = await asJson(res);
    expect(body.error).toBe('no-fields-supplied');
  });

  test('null clears a sub-tree', async () => {
    await handleModelTierPut(putRequest({ modelTier: { voice: { stt: 'best' } } }));
    await handleModelTierPut(putRequest({ modelTier: null }));
    const getRes = handleModelTierGet();
    const getBody = await asJson(getRes);
    expect(getBody.modelTier).toBeUndefined();
  });

  test('partial PUT preserves untouched sub-trees', async () => {
    // First write modelTier + budget.
    await handleModelTierPut(putRequest({
      modelTier: { voice: { stt: 'best' } },
      budget: { monthlyUsdCap: 30 },
    }));
    // Then update budget only.
    const res = await handleModelTierPut(putRequest({ budget: { monthlyUsdCap: 100 } }));
    const body = await asJson(res);
    // modelTier still there.
    expect(body.modelTier).toEqual({ voice: { stt: 'best' } });
    expect(body.budget).toEqual({ monthlyUsdCap: 100 });
  });

  test('invalid JSON body → 400', async () => {
    const res = await handleModelTierPut(new Request('http://localhost/v1/config/model-tier', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    }));
    expect(res.status).toBe(400);
    const body = await asJson(res);
    expect(body.error).toBe('invalid-json');
  });
});
