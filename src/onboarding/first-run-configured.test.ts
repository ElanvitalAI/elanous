import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUserConfig } from '../user-config.js';
import { configuredFirstRunProvider, runFirstRun, type FirstRunDeps } from './first-run.js';

function config(mutate: (cfg: ReturnType<typeof buildUserConfig>) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'first-run-configured-'));
  const cfg = buildUserConfig(join(dir, 'config.json'));
  mutate(cfg);
  return { cfg, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const noSecrets: Pick<FirstRunDeps, 'env' | 'getSecretAsync'> = {
  env: {} as NodeJS.ProcessEnv,
  getSecretAsync: (async () => undefined) as unknown as FirstRunDeps['getSecretAsync'],
};

test('a member session config (hq-proxy + emt_ token, onboarding unfinished) counts as already chatting', async () => {
  const f = config((cfg) => {
    cfg.llm.provider = 'hq-proxy' as never; cfg.llm.baseUrl = 'https://hq.tail1234.ts.net'; cfg.llm.apiKey = `emt_${'a'.repeat(20)}`;
    cfg.onboarding.completed = false; cfg.onboarding.ready = false;
  });
  try {
    expect(await configuredFirstRunProvider(f.cfg, noSecrets)).toBe('hq-proxy');
    // The real first-run keeps that provider without asking anything.
    const lines: string[] = [];
    const result = await runFirstRun({ config: f.cfg, isTTY: false, print: (l: string) => lines.push(l),
      detectProviders: async () => [], ...noSecrets });
    expect(result).toMatchObject({ outcome: 'ready', provider: 'hq-proxy', inputs: 0 });
  } finally { f.cleanup(); }
});

test('no provider, no key: not configured — fresh installs still get setup', async () => {
  const f = config((cfg) => { cfg.llm.provider = 'auto' as never; cfg.onboarding.completed = false; cfg.onboarding.ready = false; });
  try { expect(await configuredFirstRunProvider(f.cfg, noSecrets)).toBeUndefined(); } finally { f.cleanup(); }
});

test('a named provider whose credential does not resolve is not configured (no provider-less bypass)', async () => {
  const f = config((cfg) => { cfg.llm.provider = 'openrouter' as never; cfg.llm.apiKey = undefined; cfg.onboarding.completed = false; });
  try { expect(await configuredFirstRunProvider(f.cfg, noSecrets)).toBeUndefined(); } finally { f.cleanup(); }
});
