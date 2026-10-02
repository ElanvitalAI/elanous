import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { getUserConfig, resetUserConfig, saveUserConfig, jumpToRotationEntry, rotateNextProvider, rotationEntryLabel } from '../user-config.js';
import { buildDashboardSlashRegistry } from './slash-runtime/dashboard-handlers.js';
import type { DashboardSlashContext } from './slash-runtime/dashboard-handlers.js';
import { createDashboardProviderSlashRuntime } from './provider-slash-runtime.js';

const paint = (name: string) => (text: string) => `[${name}]${text}`;
const runtime = createDashboardProviderSlashRuntime({
  accent: paint('accent'), muted: paint('muted'), success: paint('success'),
  warning: paint('warning'), text: paint('text'), subtext: paint('subtext'),
});

const rotation = [
  { label: 'old', provider: 'openai-codex', model: 'gpt-5.6-sol', current: true },
  { label: 'current', provider: 'openai-codex', model: 'gpt-6-sol', current: false },
  { label: 'default', provider: 'anthropic', model: '(provider default)', current: false },
];
const providers = [
  { name: 'claude', model: 'claude-opus-5-5', available: true },
  { name: 'anthropic', model: 'claude-opus-5-5', available: true },
  { name: 'openai-codex', model: 'gpt-6-sol', available: true },
  { name: 'local', model: 'local-model', available: false },
  { name: 'openai', model: 'gpt-4o-mini', available: false },
];

test('catalog absent rotation model is marked in muted text, while present and provider-default entries are not', () => {
  const lines = runtime.overviewLines(rotation, providers, new Set(['gpt-6-sol']));
  expect(lines.find(line => line.includes('gpt-5.6-sol'))).toContain('[muted] · 목록에 없는 모델 — /provider use 로 바꾸기');
  expect(lines.find(line => line.includes('gpt-6-sol') && line.includes('current'))).not.toContain('목록에 없는 모델');
  expect(lines.find(line => line.includes('(provider default)'))).not.toContain('목록에 없는 모델');
});

test('unreadable catalog (no model-id set) does not label any rotation entry stale', () => {
  expect(runtime.overviewLines(rotation, providers).join('\n')).not.toContain('목록에 없는 모델');
});

test('only available providers appear, unavailable distinct providers collapse to one setup hint', () => {
  const lines = runtime.overviewLines([], providers);
  expect(lines).toContain('[muted]  그 밖 2개는 키·로그인 필요 — elanous setup llm');
  expect(lines.join('\n')).not.toContain('gpt-4o-mini');
  expect(lines.join('\n')).not.toContain('local-model');
  expect(lines.filter(line => line.includes('그 밖'))).toHaveLength(1);
});

test('claude/anthropic alias and case-insensitive names identify one provider, preferring available canonical anthropic', () => {
  const lines = runtime.overviewLines([], [
    { name: 'Claude', model: 'old-model', available: false },
    { name: 'anthropic', model: 'claude-opus-5-5', available: true },
    { name: 'ANTHROPIC', model: 'another-model', available: true },
  ]);
  expect(lines.filter(line => line.includes('[text]'))).toHaveLength(1);
  expect(lines.join('\n')).toContain('[text]anthropic');
  expect(lines.join('\n')).toContain('claude-opus-5-5');
  expect(lines.join('\n')).not.toContain('그 밖');
});

test('default /provider passes enabled catalog ids; failed catalog suppresses stale verdict without writing config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-slash-'));
  const oldCatalogPath = process.env.ELANOUS_MODELS_JSON;
  const catalogPath = join(dir, 'models.json');
  setElanousConfigDir(dir);
  process.env.ELANOUS_MODELS_JSON = catalogPath;
  try {
    const cfg = getUserConfig();
    cfg.llm.rotation = [
      { provider: 'openai-codex', model: 'gpt-5.6-sol', label: 'old' },
      { provider: 'openai-codex', model: 'gpt-6-sol', label: 'new' },
    ];
    saveUserConfig(cfg);
    const before = readFileSync(join(dir, 'config.json'), 'utf8');
    const ctx = {
      chatLines: [] as string[],
      provider: { slashRuntime: runtime },
      muted: paint('muted'),
      setChatScrollOffset: () => {},
    } as unknown as DashboardSlashContext;
    const registry = buildDashboardSlashRegistry();
    writeFileSync(catalogPath, JSON.stringify({ version: 1, updated: 1, models: [
      { id: 'gpt-6-sol', provider: 'openai-codex', local: true },
    ] }));
    expect((await registry.dispatch('provider', [], ctx)).kind).toBe('continue');
    expect(ctx.chatLines.find(line => line.includes('gpt-5.6-sol'))).toContain('목록에 없는 모델');
    expect(ctx.chatLines.find(line => line.includes('gpt-6-sol') && line.includes('new'))).not.toContain('목록에 없는 모델');
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(before);

    writeFileSync(catalogPath, '{broken-json');
    ctx.chatLines.length = 0;
    expect((await registry.dispatch('provider', ['list'], ctx)).kind).toBe('continue');
    expect(ctx.chatLines.join('\n')).not.toContain('목록에 없는 모델');
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(before);
  } finally {
    if (oldCatalogPath === undefined) delete process.env.ELANOUS_MODELS_JSON;
    else process.env.ELANOUS_MODELS_JSON = oldCatalogPath;
    resetUserConfig();
    resetElanousConfigDir();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/provider next|use|reset preserve rotation config changes even for a catalog-absent model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-switch-'));
  setElanousConfigDir(dir);
  try {
    const cfg = getUserConfig();
    cfg.llm.rotation = [
      { provider: 'openai-codex', model: 'gpt-5.6-sol', label: 'old' },
      { provider: 'anthropic', model: 'claude-opus-5-5', label: 'opus' },
    ];
    cfg.llm.provider = 'openai-codex';
    cfg.llm.model = 'gpt-5.6-sol';
    saveUserConfig(cfg);
    const ctx = {
      chatLines: [] as string[],
      provider: { slashRuntime: runtime },
      setChatScrollOffset: () => {},
    } as unknown as DashboardSlashContext;
    const registry = buildDashboardSlashRegistry();
    const expected = [
      { args: ['next'], result: rotateNextProvider, label: 'opus' },
      { args: ['use', 'old'], result: (config: typeof cfg) => jumpToRotationEntry(config, 'old'), label: 'old' },
      { args: ['reset'], result: (config: typeof cfg) => jumpToRotationEntry(config, rotationEntryLabel(config.llm.rotation![0]!)), label: 'old' },
    ];
    for (const { args, result, label } of expected) {
      const before = getUserConfig();
      const projected = result(before);
      expect((await registry.dispatch('provider', args, ctx)).kind).toBe('continue');
      const after = getUserConfig();
      expect(after.llm).toEqual(projected.cfg.llm);
      expect(ctx.chatLines.at(-1)).toContain(label);
    }
  } finally {
    resetUserConfig();
    resetElanousConfigDir();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('overview heads are Korean and rotation stays intact for display only', () => {
  const before = structuredClone(rotation);
  const lines = runtime.overviewLines(rotation, providers, new Set(['gpt-6-sol']));
  expect(lines).toContain('[muted]  회전(바꾸기: /provider next · /provider use <이름>)');
  expect(lines).toContain('[muted]  쓸 수 있는 공급자');
  expect(rotation).toEqual(before);
});
