/** Manual PTY acceptance fixture. Requires an explicit isolated test root. */
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { buildUserConfig, MODEL_ROLES } from '../../src/user-config.js';
import { runFirstRun } from '../../src/onboarding/first-run.js';

const root = process.env.ELANOUS_STATE_DIR;
const scenario = process.argv[2];
if (!root || !resolve(root).includes('/test-') || !['codex', 'openrouter'].includes(scenario ?? '')) {
  throw new Error('Expected ELANOUS_STATE_DIR containing /test- and scenario codex|openrouter');
}
mkdirSync(root, { recursive: true });
const path = join(root, `${scenario}-config.json`);
const config = buildUserConfig(path);
config.onboarding.webFirst = false;
const result = await runFirstRun({
  path, config, isTTY: true, locale: 'en',
  // The synthetic value only satisfies the local credential resolver. No provider call is made.
  env: { NODE_ENV: 'test', OPENROUTER_API_KEY: 'synthetic-pty-fixture-key' },
  detectProviders: async () => [
    { provider: 'openai-codex', auth: 'oauth', source: 'pty-fixture', available: true, rank: 0 },
    { provider: 'grok', auth: 'oauth', source: 'pty-fixture', available: true, rank: 1 },
  ],
  setupWhenNoProvider: async () => { throw new Error('detected subscriptions should present the provider picker'); },
  getSecretAsync: async () => undefined,
});
const saved = buildUserConfig(path);
const roles = MODEL_ROLES.filter((role) => saved.roleLlm?.[role]?.provider === 'openrouter'
  && saved.roleLlm[role]?.model === saved.llm.model);
const solarRoles = MODEL_ROLES.filter((role) => saved.roleLlm?.[role]?.provider === 'openrouter'
  && ['openrouter/upstage/solar-pro4', 'openrouter/upstage/solar-mini4'].includes(saved.roleLlm[role]?.model ?? ''));
console.log(`PTY_RESULT scenario=${scenario} outcome=${result.outcome} provider=${saved.llm.provider} model=${saved.llm.model ?? 'default'} roles=${roles.length}/${MODEL_ROLES.length} solarRoles=${solarRoles.length}/${MODEL_ROLES.length} ready=${saved.onboarding.ready === true} config=${path}`);
