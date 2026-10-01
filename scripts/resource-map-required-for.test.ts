import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

type Resource = {
  id?: unknown;
  auth?: unknown;
  env?: unknown;
  required_for?: unknown;
  required_for_unknown?: unknown;
  free_fallback?: unknown;
  reads?: unknown;
};

const existingRequiredFor = {
  tavily: ['web-search'],
  firecrawl: ['web-search', 'omni-crawl', 'community-buzz'],
  apify: ['x-scraping'],
  reddit: ['community-buzz'],
  elevenlabs: ['tts', 'streaming-stt'],
  'google-speech': ['gemini-live-stt'],
  supadata: ['youtube-transcript'],
  upstage: ['ocr'],
  'telegram-bot': ['outbound-alerts'],
  'telegram-mtproto': ['telegram-inject'],
  github: ['docs-lint', 'nightly-docops'],
  openrouter: ['openrouter-llm'],
  'claude-code-oauth': ['claude-budget-usage'],
  'discord-hitl-bot': ['hitl-discord-approval'],
  'telegram-hitl-bot': ['hitl-telegram-approval'],
  'telegram-dogfood-script': ['c5-telegram-stream-dogfood'],
  'edge-tts': ['tts'],
  'macos-say': ['tts'],
  topview: ['image-gen', 'video-gen', 'avatar-rig', 'canvas', 'music-gen', 'export'],
  higgsfield: ['image-gen', 'video-gen'],
  'epidemic-sound': ['licensed-music'],
};

const existingFreeFallback = {
  anthropic: 'subscription via `elanous login`; llm.fallbackChain',
  openai: '`elanous login openai-codex` (device code, no API key)',
  xai: 'llm.fallbackChain ends at grok',
  tavily: 'ddg + jina — skills/omni-crawl/src/free.ts (freeAvailable() is unconditionally true)',
  firecrawl: 'ddg + jina — skills/omni-crawl/src/free.ts',
  jina: 'the free tier calls r.jina.ai WITHOUT a key; this key only raises the rate limit',
  github: '`gh auth login` — the harness uses the gh CLI, not this token, for PRs',
};

const baselineEnvByResourceId: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY'],
  xai: ['XAI_API_KEY', 'GROK_API_KEY', 'GROK_CODE_XAI_API_KEY'],
  zhipu: ['ZHIPU_API_KEY', 'GLM_API_KEY', 'BIGMODEL_API_KEY'],
  dashscope: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  tavily: ['TAVILY_API_KEY', 'TAVILY_KEY'],
  firecrawl: ['FIRECRAWL_API_KEY'],
  jina: ['JINA_API_KEY'],
  apify: ['APIFY_TOKEN'],
  reddit: ['REDDIT_CLIENT_SECRET'],
  elevenlabs: ['ELEVENLABS_API_KEY'],
  'google-speech': ['GOOGLE_API_KEY'],
  supadata: ['SUPADATA_API_KEY'],
  upstage: ['UPSTAGE_API_KEY'],
  'telegram-bot': ['TELEGRAM_BOT_TOKEN', 'ELANOUS_TELEGRAM_BOT_TOKEN'],
  'telegram-mtproto': ['TELEGRAM_API_ID', 'TELEGRAM_API_HASH'],
  github: ['GITHUB_TOKEN'],
  eodhd: ['EODHD_API_KEY'],
  financialdatasets: ['FDS_API_KEY'],
  'korea-investment': ['KIS_APP_KEY', 'KIS_APP_SECRET'],
  tossinvest: ['TOSSINVEST_CLIENT_SECRET'],
  'elanous-control-token': ['ELANOUS_TOKEN'],
  'elanous-hitl-secret': ['ELANOUS_HITL_SECRET'],
  'elanous-openai-relay': ['ELANOUS_OPENAI_RELAY_SHARED_SECRET'],
  'discord-bot': ['ELANOUS_DISCORD_BOT_TOKEN'],
  'aws-s3': ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
  'typesafe-jev': ['TYPESAFE_API_KEY'],
  'elanous-llm-bridge': ['ELANOUS_LLM_API_KEY'],
  'claude-code-oauth': ['CLAUDE_CODE_OAUTH_TOKEN'],
  'discord-hitl-bot': ['ELANOUS_DISCORD_HITL_BOT_TOKEN'],
  'telegram-hitl-bot': ['ELANOUS_TELEGRAM_HITL_BOT_TOKEN'],
  'telegram-dogfood-script': ['TG_TOKEN'],
};

function nonEmpty(value: unknown): boolean {
  return (typeof value === 'string' && value.trim().length > 0)
    || (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim().length > 0));
}

function parseResources(source: string): Resource[] {
  const document = parseYaml(source) as { resources?: unknown } | null;
  if (!Array.isArray(document?.resources)) throw new Error('resources must be an array');
  return document.resources as Resource[];
}

function hasEnvField(resource: Resource): boolean {
  return Object.prototype.hasOwnProperty.call(resource, 'env');
}

function isKeylessResource(resource: Resource): boolean {
  return resource.auth === 'none' || resource.auth === 'mcp' || resource.auth === 'cli-login';
}

function assertRequiredFor(resources: Resource[]): void {
  for (const resource of resources) {
    if (!resource || typeof resource !== 'object') throw new Error('resource must be an object');
    if (!hasEnvField(resource)) continue;
    if (!Array.isArray(resource.env) || (!isKeylessResource(resource) && resource.env.length === 0) || !resource.env.every((name) => typeof name === 'string' && name.trim().length > 0)) {
      throw new Error('env resource must have a non-empty env array of names unless auth is none, mcp, or cli-login');
    }
    const hasRequiredFor = Object.hasOwn(resource, 'required_for');
    const hasUnknown = Object.hasOwn(resource, 'required_for_unknown');
    if (hasRequiredFor === hasUnknown) throw new Error('env resource must have exactly one required_for or required_for_unknown field');

    const mapping = hasRequiredFor ? resource.required_for : resource.required_for_unknown;
    if (!nonEmpty(mapping)) {
      if (hasUnknown && typeof mapping === 'string' && mapping.length > 0) {
        throw new Error('required_for_unknown must be a non-empty reason string');
      }
      throw new Error('env resource mapping must be non-empty');
    }

    if (hasRequiredFor && !Array.isArray(resource.required_for)) {
      throw new Error('required_for must be a non-empty array of feature names');
    }
    if (hasUnknown && typeof resource.required_for_unknown !== 'string') {
      throw new Error('required_for_unknown must be a non-empty reason string');
    }
    if (hasRequiredFor && !nonEmpty(resource.reads)) throw new Error('required_for resource must have non-empty reads');
  }
}

function envByResourceId(resources: Resource[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const resource of resources) {
    if (!hasEnvField(resource) || (isKeylessResource(resource) && Array.isArray(resource.env) && resource.env.length === 0)) continue;
    if (typeof resource.id !== 'string' || resource.id.trim() === '') throw new Error('env resource must have a non-empty id');
    if (!Array.isArray(resource.env) || !resource.env.every((name) => typeof name === 'string')) throw new Error('env resource must have an env array');
    if (Object.hasOwn(result, resource.id)) throw new Error(`duplicate resource id: ${resource.id}`);
    result[resource.id] = resource.env;
  }
  return result;
}

function assertEnvInventory(resources: Resource[]): void {
  expect(envByResourceId(resources)).toEqual(baselineEnvByResourceId);
}

function catalogResources(): Resource[] {
  return parseResources(readFileSync(join(process.cwd(), 'catalog', 'resources.yaml'), 'utf8'));
}

describe('resource map required_for ratchet', () => {
  test('the repository catalog maps every env resource and preserves established metadata', () => {
    const resources = catalogResources();
    assertRequiredFor(resources);
    assertEnvInventory(resources);

    const byId = new Map(resources.map((resource) => [String(resource.id), resource]));
    for (const [id, requiredFor] of Object.entries(existingRequiredFor)) expect(byId.get(id)?.required_for).toEqual(requiredFor);
    for (const [id, fallback] of Object.entries(existingFreeFallback)) expect(byId.get(id)?.free_fallback).toBe(fallback);
  });

  test.each(['none', 'mcp', 'cli-login'])('accepts keyless %s resources with required_for and reads', (auth) => {
    const resources = parseResources(`resources:\n  - id: keyless\n    auth: ${auth}\n    env: []\n    required_for: [feature]\n    reads: src/example.ts\n`);
    expect(() => assertRequiredFor(resources)).not.toThrow();
    expect(envByResourceId(resources)).toEqual({});
  });

  test('rejects empty env for a credential-bearing resource', () => {
    expect(() => assertRequiredFor(parseResources('resources:\n  - id: credential\n    auth: api-key\n    env: []\n    required_for: [feature]\n    reads: src/example.ts\n')))
      .toThrow('env resource must have a non-empty env array of names unless auth is none, mcp, or cli-login');
  });

  test('rejects a keyless resource without required_for or required_for_unknown', () => {
    expect(() => assertRequiredFor(parseResources('resources:\n  - id: keyless\n    auth: none\n    env: []\n')))
      .toThrow('env resource must have exactly one required_for or required_for_unknown field');
  });

  test('rejects an env resource with neither mapping', () => {
    expect(() => assertRequiredFor(parseResources('resources:\n  - env: [MISSING_KEY]\n    reads: src/example.ts\n')))
      .toThrow('env resource must have exactly one required_for or required_for_unknown field');
  });

  test.each([
    'resources:\n  - env: [AMBIGUOUS_KEY]\n    required_for: [feature]\n    required_for_unknown: cannot classify\n    reads: src/example.ts\n',
    'resources:\n  - env: [AMBIGUOUS_KEY]\n    required_for: [feature]\n    required_for_unknown: ""\n    reads: src/example.ts\n',
  ])('rejects an env resource with both mappings: %s', (source) => {
    expect(() => assertRequiredFor(parseResources(source)))
      .toThrow('env resource must have exactly one required_for or required_for_unknown field');
  });

  test.each([
    'resources:\n  - env: [EMPTY_REQUIRED_FOR]\n    required_for: []\n    reads: src/example.ts\n',
    'resources:\n  - env: [EMPTY_UNKNOWN]\n    required_for_unknown: ""\n',
  ])('rejects an env resource with an empty selected mapping: %s', (source) => {
    expect(() => assertRequiredFor(parseResources(source))).toThrow('env resource mapping must be non-empty');
  });

  test('rejects a string required_for mapping', () => {
    expect(() => assertRequiredFor(parseResources('resources:\n  - env: [STRING_REQUIRED_FOR]\n    required_for: feature\n    reads: src/example.ts\n')))
      .toThrow('required_for must be a non-empty array of feature names');
  });

  test('accepts a non-empty required_for_unknown reason string', () => {
    expect(() => assertRequiredFor(parseResources('resources:\n  - env: [UNKNOWN_KEY]\n    required_for_unknown: source does not identify a feature\n'))).not.toThrow();
  });

  test.each([
    'resources:\n  - env: [WHITESPACE_UNKNOWN]\n    required_for_unknown: "   "\n',
    'resources:\n  - env: [ARRAY_UNKNOWN]\n    required_for_unknown: [feature]\n',
  ])('rejects invalid required_for_unknown reasons: %s', (source) => {
    expect(() => assertRequiredFor(parseResources(source))).toThrow('required_for_unknown must be a non-empty reason string');
  });

  test.each(['resources:\n  - env: []\n', 'resources:\n  - env: SOME_KEY\n'])('rejects malformed env fields: %s', (source) => {
    expect(() => assertRequiredFor(parseResources(source))).toThrow('env resource must have a non-empty env array of names unless auth is none, mcp, or cli-login');
  });

  test('rejects credential replacement or movement between resource IDs', () => {
    const resources = catalogResources();
    const replacement = resources.map((resource) => resource.id === 'anthropic' ? { ...resource, env: ['REPLACED_KEY'] } : resource);
    const moved = resources.map((resource) => resource.id === 'openai' ? { ...resource, env: ['ANTHROPIC_API_KEY'] } : resource);
    expect(() => assertEnvInventory(replacement)).toThrow();
    expect(() => assertEnvInventory(moved)).toThrow();
  });
});
