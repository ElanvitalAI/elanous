import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { DAEMON_KEY_ENV_NAMES } from '../config.js';
import { AUXILIARY_AI_ENV_VARS, PROVIDER_ENV_SPEC, SERVICE_KEY_CATALOG } from './llm-env-detect.js';
import { renderServiceKeyCatalogMarkdown } from './llm-env-detect.js';

describe('11-04 setup service catalog', () => {
  test('has unique service ids and no duplicate credential names', () => {
    expect(new Set(SERVICE_KEY_CATALOG.map(item => item.id)).size).toBe(SERVICE_KEY_CATALOG.length);
    const envNames = SERVICE_KEY_CATALOG.flatMap(item => item.envNames);
    expect(new Set(envNames).size).toBe(envNames.length);
  });

  test('documents all scene services and maps LLM credentials to the runtime detector', () => {
    const ids = new Set(SERVICE_KEY_CATALOG.map(item => item.id));
    for (const id of ['codex', 'claude-code', 'exa', 'firecrawl', 'xai', 'tavily', 'openrouter', 'linear', 'telegram', 'google-workspace', 'aside', 'github', 'video-render']) {
      expect(ids.has(id)).toBe(true);
    }
    const catalogEnv = new Set(SERVICE_KEY_CATALOG.flatMap(item => item.envNames));
    const daemonNames = new Set(DAEMON_KEY_ENV_NAMES);
    for (const name of catalogEnv) expect(daemonNames.has(name)).toBe(true);
    for (const spec of PROVIDER_ENV_SPEC) {
      if (spec.primaryKeyEnv !== 'LOCAL_LLM_URL') expect(catalogEnv.has(spec.primaryKeyEnv)).toBe(true);
    }
    for (const item of AUXILIARY_AI_ENV_VARS) expect(catalogEnv.has(item.name)).toBe(true);
  });

  test('metadata is safe to display and includes a no-value verification instruction', () => {
    for (const item of SERVICE_KEY_CATALOG) {
      expect(item.setupUrl).toMatch(/^https:\/\//);
      expect(item.usedBy.length).toBeGreaterThan(0);
      expect(item.verification.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(SERVICE_KEY_CATALOG)).not.toMatch(/secret|token-value|api-key-value/i);
  });

  test('manual catalog table stays identical to the runtime catalog', () => {
    const manual = readFileSync(new URL('../../docs/manual/MANUAL-environment-setup-by-platform-2026-09-20.md', import.meta.url), 'utf8');
    expect(manual).toContain(renderServiceKeyCatalogMarkdown());
  });
});
