import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpAgent } from '../src/acp/client.js';
import * as backendRegistry from '../src/acp/backend-registry.js';
import { debug } from '../src/debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../src/elanous-config-dir.js';
import { resetUserConfig } from '../src/user-config.js';

const MISSING_CWD = '/definitely/missing/acp-client-billing-env';
const SECRET = 'test-secret-must-not-appear';
let configDir: string;

type SpawnEvent = Record<string, unknown>;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'acp-billing-env-'));
  setElanousConfigDir(configDir);
  resetUserConfig();
});

afterEach(() => {
  resetUserConfig();
  resetElanousConfigDir();
  rmSync(configDir, { recursive: true, force: true });
});

function writeConfig(acp: unknown): void {
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ acp }));
  resetUserConfig();
}

async function captureSpawn(backendId: string, env: Record<string, string>, logs: string[] = []): Promise<SpawnEvent> {
  const events: SpawnEvent[] = [];
  const logSpy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'acp.client' && event === 'spawn') events.push(data as SpawnEvent);
  });
  try {
    await expect(new AcpAgent({ backendId, cwd: MISSING_CWD, env, log: (message) => logs.push(message) }).start())
      .rejects.toThrow('cwd does not exist');
  } finally {
    logSpy.mockRestore();
  }
  expect(events).toHaveLength(1);
  return events[0]!;
}

function childEnv(backendId: string, env: Record<string, string>): NodeJS.ProcessEnv {
  return (new AcpAgent({ backendId, cwd: MISSING_CWD, env }) as unknown as { env: NodeJS.ProcessEnv }).env;
}

describe('AcpAgent billing environment scrub', () => {
  test('defaults to subscription mode, removes Claude billing credentials, and observes the scrub', async () => {
    const logs: string[] = [];
    const spawn = await captureSpawn('claude', {
      ANTHROPIC_API_KEY: SECRET,
      ANTHROPIC_AUTH_TOKEN: SECRET,
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDECODE: '1',
    }, logs);

    expect(spawn).toMatchObject({
      backendId: 'claude',
      billingEnvScrubEnabled: true,
      scrubbedBillingEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
      authEnvPresent: false,
      authEnvName: null,
      success: false,
    });
    expect(logs[0]).toContain('billing-env=subscription');
    expect(logs[0]).toContain('scrubbed=ANTHROPIC_API_KEY,ANTHROPIC_AUTH_TOKEN');
    expect(JSON.stringify({ spawn, logs })).not.toContain(SECRET);
  });

  test('config opt-out does not apply to Claude — Claude ACP is subscription-only (CLAUDESUB1)', async () => {
    writeConfig({ scrubBillingEnv: false });
    const logs: string[] = [];
    const spawn = await captureSpawn('claude', { ANTHROPIC_API_KEY: SECRET }, logs);

    expect(spawn).toMatchObject({ backendId: 'claude', billingEnvScrubEnabled: true });
    expect(spawn.scrubbedBillingEnv).toContain('ANTHROPIC_API_KEY');
    expect(JSON.stringify({ spawn, logs })).not.toContain(SECRET);
  });

  test('does not remove Codex API credentials', async () => {
    const spawn = await captureSpawn('codex', { OPENAI_API_KEY: SECRET });

    expect(spawn).toMatchObject({
      backendId: 'codex-app-server',
      billingEnvScrubEnabled: true,
      scrubbedBillingEnv: [],
      success: false,
    });
    expect(JSON.stringify(spawn)).not.toContain(SECRET);
  });

  test('keeps nested-agent blocking independent from billing scrub opt-out', async () => {
    writeConfig({ scrubBillingEnv: false });
    const spawn = await captureSpawn('claude', { ANTHROPIC_API_KEY: SECRET, CLAUDECODE: '1' });

    expect(spawn).toMatchObject({ billingEnvScrubEnabled: true });
    expect(JSON.stringify(spawn)).not.toContain('CLAUDECODE');
    expect(JSON.stringify(spawn)).not.toContain(SECRET);
  });

  test('forces Grok API-key authentication off only under the shared subscription policy', () => {
    expect(childEnv('grok', {})).toMatchObject({ GROK_DISABLE_API_KEY_AUTH: '1' });

    writeConfig({ scrubBillingEnv: false });
    expect(childEnv('grok', {})).not.toHaveProperty('GROK_DISABLE_API_KEY_AUTH');
  });

  test('does not force Grok API-key policy for Claude or Gemini', () => {
    expect(childEnv('claude', {})).not.toHaveProperty('GROK_DISABLE_API_KEY_AUTH');
    const geminiSpec = { ...backendRegistry.getAcpBackend('claude'), id: 'gemini' };
    const getBackendSpy = spyOn(backendRegistry, 'getAcpBackend').mockReturnValue(geminiSpec);
    try {
      expect(childEnv('gemini', {})).not.toHaveProperty('GROK_DISABLE_API_KEY_AUTH');
    } finally {
      getBackendSpy.mockRestore();
    }
  });

  test('preserves an externally supplied Grok API-key policy', async () => {
    const env = childEnv('grok', { GROK_DISABLE_API_KEY_AUTH: 'off' });
    const spawn = await captureSpawn('grok', { GROK_DISABLE_API_KEY_AUTH: 'off' });

    expect(env.GROK_DISABLE_API_KEY_AUTH).toBe('off');
    expect(spawn).toMatchObject({ forcedBillingEnv: [] });
  });
});
