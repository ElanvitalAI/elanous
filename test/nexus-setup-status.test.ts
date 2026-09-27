import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import { buildUserConfig, type UserConfig as MainUserConfig } from '../src/user-config.js';
import {
  checkSetupStatus,
  renderSetupStatus,
  type SetupCheckResult,
} from '../src/nexus/setup-status.js';
import type { UserConfig as NexusUserConfig } from '../src/nexus/config/types.js';
import { resolveGrokCredential } from '../src/grok/credential.js';

function makeMainCfg(): MainUserConfig {
  const root = mkdtempSync(joinPath(tmpdir(), 'elanous-setup-status-'));
  try {
    return buildUserConfig(joinPath(root, 'missing.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeNexusCfg(): NexusUserConfig {
  return { version: 1, global: {}, tabs: {} };
}

function sink(): { log: (s: string) => void; error: (s: string) => void; lines: string[] } {
  const lines: string[] = [];
  return {
    log: (s) => { lines.push(s); },
    error: (s) => { lines.push(s); },
    lines,
  };
}

describe('Q.1 · checkSetupStatus', () => {
  test('LLM 미설정 + PWA 미빌드 → ok=false · required 2 fail', () => {
    const cfg = makeMainCfg();
    cfg.llm.provider = 'none';
    const result = checkSetupStatus({ cfg, nexusCfg: makeNexusCfg(), pwaBuilt: false });
    expect(result.ok).toBe(false);
    expect(result.required.filter((item) => !item.passed)).toHaveLength(2);
  });

  test('LLM provider=anthropic + apiKey 있음 + PWA built → required pass · ok=true', () => {
    const cfg = makeMainCfg();
    cfg.llm.provider = 'anthropic';
    cfg.llm.apiKey = 'sk-ant';
    const result = checkSetupStatus({ cfg, nexusCfg: makeNexusCfg(), pwaBuilt: true });
    expect(result.ok).toBe(true);
    expect(result.required.every((item) => item.passed)).toBe(true);
  });

  test('LLM provider=local + baseUrl 있음 (apiKey 없어도 OK) → pass', () => {
    const cfg = makeMainCfg();
    cfg.llm.provider = 'local';
    cfg.llm.baseUrl = 'http://127.0.0.1:11434/v1';
    const result = checkSetupStatus({ cfg, nexusCfg: makeNexusCfg(), pwaBuilt: true });
    expect(result.required.find((item) => item.id === 'llm')?.passed).toBe(true);
  });

  test('LLM provider=grok + explicit apiKey → api-key credential without resolving subscription', () => {
    const cfg = makeMainCfg();
    cfg.llm.provider = 'grok';
    cfg.llm.apiKey = 'xai-explicit-key';
    let resolverCalls = 0;
    const result = checkSetupStatus({
      cfg,
      nexusCfg: makeNexusCfg(),
      pwaBuilt: true,
      resolveGrokCredential: () => {
        resolverCalls += 1;
        return null;
      },
    });
    const llm = result.required.find((item) => item.id === 'llm');
    expect(llm?.passed).toBe(true);
    expect(llm?.detail).toBe('provider=grok · credential=api-key');
    expect(resolverCalls).toBe(0);
  });

  test('LLM provider=grok accepts only injected subscription credentials when apiKey is absent', () => {
    const cfg = makeMainCfg();
    cfg.llm.provider = 'grok';
    const subscription = checkSetupStatus({
      cfg,
      nexusCfg: makeNexusCfg(),
      pwaBuilt: true,
      resolveGrokCredential: (() => ({ kind: 'subscription', baseUrl: '', token: '', headers: {}, source: 'test' })) as typeof resolveGrokCredential,
    });
    const apiKey = checkSetupStatus({
      cfg,
      nexusCfg: makeNexusCfg(),
      pwaBuilt: true,
      resolveGrokCredential: (() => ({ kind: 'api_key', baseUrl: '', token: '', headers: {}, source: 'test' })) as typeof resolveGrokCredential,
    });
    expect(subscription.required.find((item) => item.id === 'llm')).toMatchObject({
      passed: true,
      detail: 'provider=grok · credential=subscription',
    });
    expect(apiKey.required.find((item) => item.id === 'llm')?.passed).toBe(false);
  });

  test('LLM provider=auto without credentials and provider=none both fail', () => {
    const autoCfg = makeMainCfg();
    autoCfg.llm.provider = 'auto';
    const auto = checkSetupStatus({
      cfg: autoCfg,
      nexusCfg: makeNexusCfg(),
      pwaBuilt: true,
      decideProviderForConfig: () => ({ provider: 'auto', model: '(none)', auth: 'none' }),
    });
    const noneCfg = makeMainCfg();
    (noneCfg.llm as { provider: string }).provider = 'none';
    const none = checkSetupStatus({ cfg: noneCfg, nexusCfg: makeNexusCfg(), pwaBuilt: true });
    expect(auto.required.find((item) => item.id === 'llm')?.passed).toBe(false);
    expect(none.required.find((item) => item.id === 'llm')?.passed).toBe(false);
  });

  test('LLM provider=auto passes and surfaces the resolved provider when it has credentials', () => {
    const cfg = makeMainCfg();
    cfg.llm.provider = 'auto';
    const result = checkSetupStatus({
      cfg,
      nexusCfg: makeNexusCfg(),
      pwaBuilt: true,
      decideProviderForConfig: () => ({ provider: 'auto:openai-codex', model: 'gpt-5', auth: 'oauth' }),
    });
    expect(result.required.find((item) => item.id === 'llm')).toMatchObject({
      passed: true,
      detail: 'provider=auto:openai-codex · credential=oauth',
    });
    const out = sink();
    renderSetupStatus(result, out);
    expect(out.lines.join('\n')).toContain('[✓] LLM provider (provider=auto:openai-codex · credential=oauth)');
  });

  test('setup-capable hints preserve interactive commands and add the unattended answer-file command', () => {
    const cfg = makeMainCfg();
    cfg.skills.dirs = ['/missing/skills'];
    const result = checkSetupStatus({
      cfg,
      nexusCfg: makeNexusCfg(),
      pwaBuilt: false,
      exists: () => false,
    });
    const hintFor = (id: string) => [...result.required, ...result.recommended].find((item) => item.id === id)?.hint;

    expect(hintFor('llm')).toContain('elanous setup llm');
    expect(hintFor('llm')).toContain('elanous nexus');
    expect(hintFor('skill-dirs')).toContain('create the missing skill directories');
    expect(hintFor('skill-dirs')).toContain('choose an already-existing skill directory');
    expect(hintFor('skill-dirs')).not.toContain('elanous setup skills');
    expect(hintFor('channel-bot')).toContain('elanous nexus channel-bot setup telegram|discord');
    for (const id of ['llm', 'skill-dirs', 'channel-bot']) {
      expect(hintFor(id)).toContain('elanous setup --non-interactive --config <ans.json>');
    }
  });

  test('PWA build and OS install hints do not advertise unattended setup', () => {
    const result = checkSetupStatus({ cfg: makeMainCfg(), nexusCfg: makeNexusCfg(), pwaBuilt: false });
    const hintFor = (id: string) => [...result.required, ...result.recommended].find((item) => item.id === id)?.hint;

    expect(hintFor('pwa-build')).not.toContain('--non-interactive');
    expect(hintFor('os-install')).not.toContain('--non-interactive');
  });

  test('rendered incomplete checklist exposes unattended setup only for setup-capable items', () => {
    const cfg = makeMainCfg();
    cfg.skills.dirs = ['/missing/skills'];
    const result = checkSetupStatus({
      cfg,
      nexusCfg: makeNexusCfg(),
      pwaBuilt: false,
      exists: () => false,
    });
    const out = sink();
    renderSetupStatus(result, out);
    const renderedItem = (label: string) => out.lines.find((line) => line.includes(label));

    for (const label of ['LLM provider', 'Skill dirs', 'Channel bot']) {
      expect(renderedItem(label)).toContain('elanous setup --non-interactive --config <ans.json>');
    }
    for (const label of ['PWA build', 'OS install']) {
      expect(renderedItem(label)).not.toContain('--non-interactive');
    }
  });

  test('telegram tokenRef set → channel-bot recommended pass', () => {
    const nexusCfg = makeNexusCfg();
    nexusCfg.tabs['telegram:1'] = { tokenRef: 'ref:secret:tg' };
    const result = checkSetupStatus({ cfg: makeMainCfg(), nexusCfg, pwaBuilt: false });
    expect(result.recommended.find((item) => item.id === 'channel-bot')?.passed).toBe(true);
  });

  test('discord tokenRef set (telegram 없음) → channel-bot pass', () => {
    const nexusCfg = makeNexusCfg();
    nexusCfg.tabs['discord:1'] = { tokenRef: 'ref:secret:dc' };
    const result = checkSetupStatus({ cfg: makeMainCfg(), nexusCfg, pwaBuilt: false });
    expect(result.recommended.find((item) => item.id === 'channel-bot')?.passed).toBe(true);
  });

  test('missing skill dir → skill-dirs fail with missing detail', () => {
    const cfg = makeMainCfg();
    cfg.skills.dirs = ['/missing/skills'];
    const result = checkSetupStatus({
      cfg,
      nexusCfg: makeNexusCfg(),
      pwaBuilt: false,
      exists: () => false,
    });
    const skillDirs = result.recommended.find((item) => item.id === 'skill-dirs');
    expect(skillDirs?.passed).toBe(false);
    expect(skillDirs?.detail).toBe('1 dir · 0 exist · missing: /missing/skills');
    expect(skillDirs?.hint).toContain('create');
    expect(skillDirs?.hint).toContain('choose an already-existing skill directory');
    expect(skillDirs?.hint).toContain('elanous setup --non-interactive --config <ans.json>');
  });

  test('one of two skill dirs exists → skill-dirs passes with missing detail', () => {
    const cfg = makeMainCfg();
    cfg.skills.dirs = ['/existing/skills', '/missing/skills'];
    const result = checkSetupStatus({
      cfg,
      nexusCfg: makeNexusCfg(),
      pwaBuilt: false,
      exists: (path) => path === '/existing/skills',
    });
    const skillDirs = result.recommended.find((item) => item.id === 'skill-dirs');
    expect(skillDirs?.passed).toBe(true);
    expect(skillDirs?.detail).toBe('2 dirs · 1 exist · missing: /missing/skills');
    expect(skillDirs?.hint).toContain('create the missing skill directories');
  });

  test('all skill dirs exist → skill-dirs passes without missing-dir hint', () => {
    const cfg = makeMainCfg();
    cfg.skills.dirs = ['/existing/skills'];
    const result = checkSetupStatus({
      cfg,
      nexusCfg: makeNexusCfg(),
      pwaBuilt: false,
      exists: (path) => path === '/existing/skills',
    });
    const skillDirs = result.recommended.find((item) => item.id === 'skill-dirs');
    expect(skillDirs?.passed).toBe(true);
    expect(skillDirs?.hint).toBe('');
  });

  test('skill.dirs=[] → skill-dirs fails without detail', () => {
    const cfg = makeMainCfg();
    cfg.skills.dirs = [];
    const result = checkSetupStatus({ cfg, nexusCfg: makeNexusCfg(), pwaBuilt: false });
    const skillDirs = result.recommended.find((item) => item.id === 'skill-dirs');
    expect(skillDirs?.passed).toBe(false);
    expect(skillDirs?.detail).toBeUndefined();
  });

  test('renderSetupStatus → ✗ / ✓ / ○ 글자가 sink 에 들어감', () => {
    const result: SetupCheckResult = {
      ok: false,
      required: [
        { id: 'llm', label: 'LLM provider', passed: false, hint: 'run `elanous setup llm`' },
        { id: 'pwa-build', label: 'PWA build', passed: true, hint: 'run `elanous nexus build`' },
      ],
      recommended: [
        { id: 'channel-bot', label: 'Channel bot', passed: false, hint: 'run `elanous nexus channel-bot setup telegram|discord`' },
      ],
    };
    const out = sink();
    renderSetupStatus(result, out);
    expect(out.lines.join('\n')).toContain('[✗] LLM provider');
    expect(out.lines.join('\n')).toContain('[✓] PWA build');
    expect(out.lines.join('\n')).toContain('[○] Channel bot');
  });
});
