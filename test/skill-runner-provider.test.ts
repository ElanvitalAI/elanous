// ── skill-runner provider resolution tests ──
//
// Verifies that skill execution honors user-config even when:
//   - Environment variables suggest a different provider (XAI_API_KEY set)
//   - Skill frontmatter declares a cross-family model (e.g. grok-4 but
//     config says openai-codex)
// These two axes are the ones that caused the regression reported in
// session 13: config.openai-codex + env XAI_API_KEY + skill model=grok-*
// led every skill execution down the Grok path, contradicting the
// user's configured default.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { debug } from '../src/debug/log';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveDefaultProvider, inferProviderFromModel, isModelCompatible,
  PROVIDERS,
} from '../src/llm';
import { saveTokens } from '../src/oauth/store';
import { saveUserConfig, buildUserConfig, resetUserConfig } from '../src/user-config';
import { setElanousConfigDir, resetElanousConfigDir } from '../src/elanous-config-dir';

interface CapturedLogRecord {
  category?: string;
  event?: string;
  data?: Record<string, unknown>;
}

const saved: Record<string, string | undefined> = {};
let root: string;
let cfgPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skill-provider-'));
  setElanousConfigDir(join(root, 'elanous'));
  cfgPath = join(root, 'elanous', 'config.json');
  for (const k of ['XAI_API_KEY', 'GROK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'LOCAL_LLM_URL']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  saved.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  saved.CODEX_HOME = process.env.CODEX_HOME;
  process.env.XDG_CONFIG_HOME = root;
  process.env.CODEX_HOME = join(root, 'codex-home');
  resetUserConfig();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetElanousConfigDir();
  rmSync(root, { recursive: true, force: true });
  resetUserConfig();
});

describe('inferProviderFromModel', () => {
  test('grok-4 → grok', () => { expect(inferProviderFromModel('grok-4-1-fast-reasoning')).toBe('grok'); });
  test('gpt-5.4 → openai', () => { expect(inferProviderFromModel('gpt-5.4-mini')).toBe('openai'); });
  test('codex-mini-latest → openai-codex', () => { expect(inferProviderFromModel('codex-mini-latest')).toBe('openai-codex'); });
  test('claude-haiku → anthropic', () => { expect(inferProviderFromModel('claude-haiku-4-5')).toBe('anthropic'); });
  test('gemini-2.5-pro → gemini', () => { expect(inferProviderFromModel('gemini-2.5-pro')).toBe('gemini'); });
  test('local:llama3 → local', () => { expect(inferProviderFromModel('local:llama3')).toBe('local'); });
  test('o4-mini → openai', () => { expect(inferProviderFromModel('o4-mini')).toBe('openai'); });
  test('unknown prefix → null', () => { expect(inferProviderFromModel('foo-bar-99')).toBe(null); });
  test('empty → null', () => { expect(inferProviderFromModel('')).toBe(null); });
  test('undefined → null', () => { expect(inferProviderFromModel(undefined)).toBe(null); });

  // 2026-05-08 dogfood follow-up: short aliases used in builtin
  // workflow YAMLs were previously falling through to `null` (treated
  // as "let the provider handle"), which let `model: haiku` reach
  // LM Studio + 400. inferProviderFromModel now resolves the alias
  // first, so isModelCompatible() can correctly strip the hint.
  test('haiku alias → anthropic', () => { expect(inferProviderFromModel('haiku')).toBe('anthropic'); });
  test('sonnet alias → anthropic', () => { expect(inferProviderFromModel('sonnet')).toBe('anthropic'); });
  test('opus alias → anthropic', () => { expect(inferProviderFromModel('opus')).toBe('anthropic'); });
});

describe('isModelCompatible — local provider vs cloud-family model', () => {
  // 2026-05-08 dogfood follow-up. Previously `isModelCompatible(
  // 'local', 'haiku')` returned true (local provider was treated as
  // free-form), so the workflow runtime + skill runner forwarded
  // `model: haiku` straight to LM Studio → 400. The patch makes
  // `local` accept ONLY `local:`-prefixed hints (or no hint).
  test('local + haiku → false (was true)', () => {
    expect(isModelCompatible('local', 'haiku')).toBe(false);
  });
  test('local + sonnet → false', () => {
    expect(isModelCompatible('local', 'sonnet')).toBe(false);
  });
  test('local + claude-opus-4 → false', () => {
    expect(isModelCompatible('local', 'claude-opus-4')).toBe(false);
  });
  test('local + gpt-5.4-mini → false', () => {
    expect(isModelCompatible('local', 'gpt-5.4-mini')).toBe(false);
  });
  test('local + grok-4 → false', () => {
    expect(isModelCompatible('local', 'grok-4-1-fast-reasoning')).toBe(false);
  });
  test('local + local:llama3 → true (explicit local prefix)', () => {
    expect(isModelCompatible('local', 'local:llama3')).toBe(true);
  });
  test('local + free-form unknown name → true (let provider handle)', () => {
    expect(isModelCompatible('local', 'qwen3.6-35b-a3b-ud-mlx')).toBe(true);
  });
  test('local + undefined → true', () => {
    expect(isModelCompatible('local', undefined)).toBe(true);
  });
});

describe('isModelCompatible', () => {
  test('grok provider + grok model → ok', () => {
    expect(isModelCompatible('grok', 'grok-4')).toBe(true);
  });
  test('grok provider + gpt model → incompatible', () => {
    expect(isModelCompatible('grok', 'gpt-5.4-mini')).toBe(false);
  });
  test('openai-codex provider + grok model → incompatible (the reported bug)', () => {
    expect(isModelCompatible('openai-codex', 'grok-4-1-fast-reasoning')).toBe(false);
  });
  test('openai-codex + gpt model → ok (openai family overlap)', () => {
    expect(isModelCompatible('openai-codex', 'gpt-5.4-mini')).toBe(true);
  });
  test('openai-codex + codex model → ok', () => {
    expect(isModelCompatible('openai-codex', 'codex-mini-latest')).toBe(true);
  });
  test('local + cloud-family model → false (was permissively true; updated 2026-05-08)', () => {
    // 2026-05-08 follow-up: cloud-family model names (haiku / claude-* /
    // grok-* / gpt-*) being routed to a local provider almost always
    // means the YAML / SKILL.md author hardcoded a name the local
    // backend doesn't have. Strip the hint so the provider falls back
    // to its configured default model.
    expect(isModelCompatible('local', 'grok-4')).toBe(false);
    expect(isModelCompatible('local', 'claude-haiku')).toBe(false);
  });
  test('local + free-form / unknown model → ok (provider picks)', () => {
    expect(isModelCompatible('local', 'qwen3.6-35b-a3b-ud-mlx')).toBe(true);
    expect(isModelCompatible('local', 'local:llama3')).toBe(true);
  });
  test('no hint → always ok', () => {
    expect(isModelCompatible('openai-codex', undefined)).toBe(true);
    expect(isModelCompatible('grok', '')).toBe(true);
  });
  test('unknown model prefix → ok (let provider decide)', () => {
    expect(isModelCompatible('openai-codex', 'foo-bar-v2')).toBe(true);
  });
});

describe('resolveDefaultProvider — config wins over env', () => {
  // A/B decision for GoalId a5d5e2ca5c81656d: choose branch A.
  // Repository evidence: SkillManifest.model in src/skills/runner.ts is
  // documented as a "routing hint"; executeSkill resolves the provider
  // through resolveDefaultProvider(rawModelHint) and then strips
  // incompatible hints with isModelCompatible before streaming; workflow
  // YAML execution follows the same hint-stripping pattern; hard model
  // requirements remain local to callers such as system-lookback's Opus
  // review path instead of changing skill frontmatter precedence.
  test('config codex + env XAI_API_KEY + skill model=grok → codex wins', () => {
    // Set BOTH: env var (legacy) and user-config (new). The
    // regression was that env won. Now config wins.
    process.env.XAI_API_KEY = 'xai-stale';
    const cfg = buildUserConfig(cfgPath);
    cfg.llm.provider = 'openai-codex';
    cfg.llm.model = 'gpt-5.4-mini';
    saveUserConfig(cfg, cfgPath);
    saveTokens('openai-codex', {
      accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 3600_000,
    }, { authMode: 'chatgpt', mirrorCodex: false });
    resetUserConfig();

    const records: CapturedLogRecord[] = [];
    const unregister = debug.registerSink({
      name: 'skill-runner-provider-test',
      emit(record) { records.push(record as CapturedLogRecord); },
    });

    // Model hint `grok-4-1-fast-reasoning` is what the skill frontmatter
    // declares. resolveDefaultProvider should return the CODEX provider
    // (config wins), ignoring the hint.
    try {
      const p = resolveDefaultProvider('grok-4-1-fast-reasoning');
      expect(p.name).toBe('openai-codex');
      expect(p.defaultModel).toBe('gpt-5.4-mini');
    } finally {
      unregister();
    }

    const observed = records.find((record) =>
      record.category === 'llm.router' &&
      record.event === 'resolveDefaultProvider' &&
      record.data?.requestedModel === 'grok-4-1-fast-reasoning'
    );
    expect(observed?.data).toMatchObject({
      configProvider: 'openai-codex',
      requestedModel: 'grok-4-1-fast-reasoning',
      decisionProvider: 'openai-codex',
      resolvedTo: 'openai-codex',
    });
  });

  test('config auto + env XAI only → grok', () => {
    process.env.XAI_API_KEY = 'xai-env';
    const p = resolveDefaultProvider();
    expect(p.name).toBe('grok');
  });

  test('config auto + explicit model hint → honors prefix match', () => {
    process.env.XAI_API_KEY = 'xai-env';
    process.env.ANTHROPIC_API_KEY = 'ant-env';
    const p = resolveDefaultProvider('claude-haiku-4-5');
    expect(p.name).toBe('anthropic');
  });

});
