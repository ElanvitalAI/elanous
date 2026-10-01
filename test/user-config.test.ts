// ── User config loader tests ──

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildUserConfig, getUserConfig, reloadUserConfig, resetUserConfig,
  saveUserConfig, markOnboardingComplete, skillSetDir, currentOnboardingVersion,
  type UserConfig,
  PROVIDER_DEFAULT_MODEL,
} from '../src/user-config';

let root: string;
let cfgPath: string;
const savedEnv = new Map<string, string | undefined>();
function setEnv(vars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
function write(json: unknown): void {
  writeFileSync(cfgPath, typeof json === 'string' ? json : JSON.stringify(json));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'user-config-'));
  cfgPath = join(root, 'config.json');
  setEnv({
    ELANOUS_LLM_PROVIDER: undefined,
    ELANOUS_LLM_MODEL: undefined,
    ELANOUS_ESCALATE_PROVIDER: undefined,
    ELANOUS_ESCALATE_MODEL: undefined,
    GROK_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
  });
  resetUserConfig();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  resetUserConfig();
});

describe('user-config defaults', () => {
  test('missing file → defaults', () => {
    const c = buildUserConfig(cfgPath);
    expect(c.skillRouter.autoRoute).toBe(false);
    expect(c.skillRouter.autoRouteCountdownMs).toBe(1500);
    expect(c.skillRouter.llmFallback).toBe(false);
    expect(c.skillRouter.keywordScoreThreshold).toBe(2);
    expect(c.skillRouter.llmConfidenceThreshold).toBe(0.75);
    expect(c.skillRouter.autoRouteMinScore).toBe(2.0);
    expect(c.skillRouter.autoRouteRequireAutoTrigger).toBe(true);
  });

  test('empty object → defaults', () => {
    write({});
    const c = buildUserConfig(cfgPath);
    expect(c.skillRouter.autoRoute).toBe(false);
    expect(c.intake.telegram.ambientCapture).toBeUndefined();
    expect(c.intake.discord.ambientCapture).toBeUndefined();
    expect(c.vw.simResident).toBe(false);
    expect(c.vw.iulResident).toBe(false);
    expect(c.vw.order).toEqual(['acp', 'sim', 'iul']);
  });

  test('malformed JSON → defaults (no throw)', () => {
    write('{this is not json');
    const c = buildUserConfig(cfgPath);
    expect(c.skillRouter.autoRoute).toBe(false);
    expect(c.skillRouter.autoRouteCountdownMs).toBe(1500);
    expect(c.acp.reviewBackend).toBeUndefined();
  });

  test('acp review and rework backends persist independently through save and reload', () => {
    write({ acp: { reviewBackend: 'configured-reviewer', reworkBackend: 'configured-reworker' } });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.acp.reviewBackend).toBe('configured-reviewer');
    expect(cfg.acp.reworkBackend).toBe('configured-reworker');
    saveUserConfig(cfg, cfgPath);
    const reloaded = reloadUserConfig(cfgPath).acp;
    expect(reloaded.reviewBackend).toBe('configured-reviewer');
    expect(reloaded.reworkBackend).toBe('configured-reworker');
  });

  test('non-object JSON → defaults', () => {
    write('"hello"');
    const c = buildUserConfig(cfgPath);
    expect(c.skillRouter.autoRoute).toBe(false);
  });

  test('shell.allowDashboardPty defaults to false', () => {
    const c = buildUserConfig(cfgPath);
    expect(c.shell.allowDashboardPty).toBe(false);
  });

  test('skills.devRequestRouting defaults, parses, and round-trips through save', () => {
    write({ skills: { devRequestRouting: { enabled: false, verbs: ['고쳐줘'], guardKeywords: ['설명해줘'] } } });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.skills.devRequestRouting).toEqual({
      enabled: false,
      verbs: ['고쳐줘'],
      guardKeywords: ['설명해줘'],
    });
    saveUserConfig(cfg, cfgPath);
    expect(buildUserConfig(cfgPath).skills.devRequestRouting).toEqual(cfg.skills.devRequestRouting);
  });

  test('acp binaryPaths round-trips through save without changing existing ACP fields', () => {
    write({ acp: { hopCap: { codex: 2 }, slashMaxTurns: 5, binaryPaths: { codex: '/opt/bin/codex-acp' } } });
    const cfg = buildUserConfig(cfgPath);
    saveUserConfig(cfg, cfgPath);

    const saved = JSON.parse(require('node:fs').readFileSync(cfgPath, 'utf-8'));
    expect(saved.acp).toEqual({
      hopCap: { codex: 2 },
      binaryPaths: { codex: '/opt/bin/codex-acp' },
      slashMaxTurns: 5,
    });
    expect(buildUserConfig(cfgPath).acp).toEqual(cfg.acp);
  });

  test('saving ACP config without binaryPaths does not add binaryPaths to disk', () => {
    write({ acp: { hopCap: { claude: 1 }, slashMaxTurns: 3 } });
    const cfg = buildUserConfig(cfgPath);
    saveUserConfig(cfg, cfgPath);

    const saved = JSON.parse(require('node:fs').readFileSync(cfgPath, 'utf-8'));
    expect(saved.acp).toEqual({ hopCap: { claude: 1 }, slashMaxTurns: 3 });
    expect(saved.acp).not.toHaveProperty('binaryPaths');
  });

  test('intake ambientCapture is user-config only and preserves known modes', () => {
    write({ intake: { telegram: { ambientCapture: 'suggest' }, discord: { ambientCapture: 'capture' } } });
    const c = buildUserConfig(cfgPath);
    expect(c.intake.telegram.ambientCapture).toBe('suggest');
    expect(c.intake.discord.ambientCapture).toBe('capture');
  });

  test('intake ambientCapture ignores unknown values', () => {
    write({ intake: { telegram: { ambientCapture: 'weird' }, discord: { ambientCapture: 1 } } });
    const c = buildUserConfig(cfgPath);
    expect(c.intake.telegram.ambientCapture).toBeUndefined();
    expect(c.intake.discord.ambientCapture).toBeUndefined();
  });

  test('vw.simResident defaults to false and requires strict true', () => {
    write({ vw: { simResident: true } });
    expect(buildUserConfig(cfgPath).vw.simResident).toBe(true);

    write({ vw: { simResident: 'yes' } });
    expect(buildUserConfig(cfgPath).vw.simResident).toBe(false);

    write({ vw: { simResident: false } });
    expect(buildUserConfig(cfgPath).vw.simResident).toBe(false);
  });

  test('vw.iulResident defaults to false and requires strict true', () => {
    write({ vw: { iulResident: true } });
    expect(buildUserConfig(cfgPath).vw.iulResident).toBe(true);

    write({ vw: { iulResident: 'yes' } });
    expect(buildUserConfig(cfgPath).vw.iulResident).toBe(false);

    write({ vw: { iulResident: false } });
    expect(buildUserConfig(cfgPath).vw.iulResident).toBe(false);
  });

  test('named vw registry parses resident and foreground flags', () => {
    write({ vw: { iul: { resident: true, foregroundOnStartup: true }, acp: { resident: false } } });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.vw.iulResident).toBe(true);
    expect(cfg.vw.iulForegroundOnStartup).toBe(true);
    expect(cfg.vw.entries.acp.resident).toBe(false);
    expect(cfg.vw.order).toEqual(['iul', 'acp', 'sim']);
  });

  test('vw.order canonicalizes config registration order with dedupe + fallback', () => {
    write({ vw: { order: ['iul', 'acp', 'iul', 'weird'] } });
    expect(buildUserConfig(cfgPath).vw.order).toEqual(['iul', 'acp', 'sim']);

    write({ vw: { order: 'iul' } });
    expect(buildUserConfig(cfgPath).vw.order).toEqual(['acp', 'sim', 'iul']);
  });

  test('shell.allowDashboardPty: true passes through', () => {
    write({ shell: { allowDashboardPty: true } });
    expect(buildUserConfig(cfgPath).shell.allowDashboardPty).toBe(true);
  });

  test('shell.allowDashboardPty: any non-true value stays false', () => {
    write({ shell: { allowDashboardPty: 'yes' } });
    expect(buildUserConfig(cfgPath).shell.allowDashboardPty).toBe(false);
    write({ shell: { allowDashboardPty: 1 } });
    expect(buildUserConfig(cfgPath).shell.allowDashboardPty).toBe(false);
  });

  test('shell.allowDashboardBash / TerminalInject / ApiCall default false', () => {
    const c = buildUserConfig(cfgPath);
    expect(c.shell.allowDashboardBash).toBe(false);
    expect(c.shell.allowDashboardTerminalInject).toBe(false);
    expect(c.shell.allowDashboardApiCall).toBe(false);
  });

  test('chat.conciseness defaults match P1 roadmap', () => {
    const c = buildUserConfig(cfgPath);
    expect(c.chat.conciseness).toEqual({
      enabled: true,
      finalMessageMaxLines: 10,
      preambleMaxWords: 12,
      flatBullets: true,
    });
    expect(c.chat.toolOutput).toEqual({
      persistOnOverflow: true,
      retentionDays: 7,
      previewLines: 8,
    });
    expect(c.chat.autoCompact).toEqual({
      enabled: true,
      triggerRatio: 0.85,
      preserveLastN: 4,
      preserveFirstN: 1,
      partial: true,
      workingBudgetTokens: 256_000,
    });
    expect(c.chat.systemPrompt).toEqual({
      overridePath: undefined,
      taskVariant: 'default',
    });
    expect(c.chat.rendering).toEqual({
      streaming: {
        mode: 'byte',
        catchUpThresholdLines: 50,
        catchUpAgeMs: 200,
      },
      wrap: {
        urlAware: false,
      },
      tool: {
        displayMode: 'inline-to-block',
        blockMaxLines: 8,
      },
      hud: {
        gaugeWarnRatio: 0.7,
        gaugeDangerRatio: 0.85,
      },
      diff: {
        colorTier: 'auto',
        headerStyle: 'legacy',
        turnBrowserHistory: 8,
        turnBrowserMode: 'all',
      },
    });
  });

  test('shell.allowDashboardBash: true passes through', () => {
    write({ shell: { allowDashboardBash: true } });
    expect(buildUserConfig(cfgPath).shell.allowDashboardBash).toBe(true);
  });

  test('shell.allowDashboardTerminalInject: true passes through', () => {
    write({ shell: { allowDashboardTerminalInject: true } });
    expect(buildUserConfig(cfgPath).shell.allowDashboardTerminalInject).toBe(true);
  });

  test('shell.allowDashboardApiCall: true passes through', () => {
    write({ shell: { allowDashboardApiCall: true } });
    expect(buildUserConfig(cfgPath).shell.allowDashboardApiCall).toBe(true);
  });

  test('new flags: non-true values stay false (same strictness as allowDashboardPty)', () => {
    write({ shell: { allowDashboardBash: 'yes', allowDashboardTerminalInject: 1, allowDashboardApiCall: null } });
    const c = buildUserConfig(cfgPath);
    expect(c.shell.allowDashboardBash).toBe(false);
    expect(c.shell.allowDashboardTerminalInject).toBe(false);
    expect(c.shell.allowDashboardApiCall).toBe(false);
  });
});

describe('llm.routePolicy', () => {
  test('accepts only explicit Codex-first policy values', () => {
    write({ llm: { routePolicy: { mode: 'codex-first', opusEscalation: 'evidence-hitl' } } });
    expect(buildUserConfig(cfgPath).llm.routePolicy).toEqual({ mode: 'codex-first', opusEscalation: 'evidence-hitl' });
    write({ llm: { routePolicy: { mode: 'anything', opusEscalation: 'automatic' } } });
    expect(buildUserConfig(cfgPath).llm.routePolicy).toBeUndefined();
  });
});

describe('user-config fields', () => {
  test('skillRouter.autoRoute: true passes through', () => {
    write({ skillRouter: { autoRoute: true } });
    expect(buildUserConfig(cfgPath).skillRouter.autoRoute).toBe(true);
  });

  test('autoRoute accepts only strict true (truthy strings ignored)', () => {
    write({ skillRouter: { autoRoute: 'yes' } });
    expect(buildUserConfig(cfgPath).skillRouter.autoRoute).toBe(false);
  });

  test('autoRouteCountdownMs clamped to [0, 10000]', () => {
    write({ skillRouter: { autoRouteCountdownMs: 50000 } });
    expect(buildUserConfig(cfgPath).skillRouter.autoRouteCountdownMs).toBe(10000);

    write({ skillRouter: { autoRouteCountdownMs: -500 } });
    expect(buildUserConfig(cfgPath).skillRouter.autoRouteCountdownMs).toBe(0);
  });

  test('non-numeric countdown → default', () => {
    write({ skillRouter: { autoRouteCountdownMs: 'fast' } });
    expect(buildUserConfig(cfgPath).skillRouter.autoRouteCountdownMs).toBe(1500);
  });

  test('llmConfidenceThreshold clamped to [0, 1]', () => {
    write({ skillRouter: { llmConfidenceThreshold: 2 } });
    expect(buildUserConfig(cfgPath).skillRouter.llmConfidenceThreshold).toBe(1);

    write({ skillRouter: { llmConfidenceThreshold: -0.1 } });
    expect(buildUserConfig(cfgPath).skillRouter.llmConfidenceThreshold).toBe(0);
  });

  test('autoRouteMinScore clamped to [0, 100]', () => {
    write({ skillRouter: { autoRouteMinScore: 500 } });
    expect(buildUserConfig(cfgPath).skillRouter.autoRouteMinScore).toBe(100);

    write({ skillRouter: { autoRouteMinScore: -1 } });
    expect(buildUserConfig(cfgPath).skillRouter.autoRouteMinScore).toBe(0);

    write({ skillRouter: { autoRouteMinScore: 0.5 } });
    expect(buildUserConfig(cfgPath).skillRouter.autoRouteMinScore).toBe(0.5);
  });

  test('autoRouteRequireAutoTrigger accepts only strict false', () => {
    write({ skillRouter: { autoRouteRequireAutoTrigger: false } });
    expect(buildUserConfig(cfgPath).skillRouter.autoRouteRequireAutoTrigger).toBe(false);

    write({ skillRouter: { autoRouteRequireAutoTrigger: 'no' } });
    // non-boolean / truthy-string → defaults back to safe true
    expect(buildUserConfig(cfgPath).skillRouter.autoRouteRequireAutoTrigger).toBe(true);
  });

  test('raw carries unknown keys for forward-compat readers', () => {
    write({ skillRouter: { autoRoute: true }, someFutureFeature: { x: 1 } });
    const c = buildUserConfig(cfgPath);
    expect((c.raw.someFutureFeature as any).x).toBe(1);
  });
});

// ── Phase L4 · lsp config section ──────────────────────────────────

describe('user-config lsp section (Phase L4)', () => {
  test('defaults: enabled=true, all three languages with default commands', () => {
    const c = buildUserConfig(cfgPath);
    expect(c.lsp.enabled).toBe(true);
    expect(c.lsp.typescript).not.toBe(false);
    expect((c.lsp.typescript as any).command).toBe('typescript-language-server');
    expect((c.lsp.python as any).command).toBe('pyright-langserver');
    expect((c.lsp.rust as any).command).toBe('rust-analyzer');
    expect(c.lsp.idleTimeoutMs).toBe(600_000);
    expect(c.lsp.workspaceSymbolLanguage).toBe('typescript');
  });

  test('defaults: typescript extensions include ts/tsx/js/jsx', () => {
    const c = buildUserConfig(cfgPath);
    const ts = c.lsp.typescript as unknown as { extensions: readonly string[] };
    expect(ts.extensions).toContain('ts');
    expect(ts.extensions).toContain('tsx');
    expect(ts.extensions).toContain('js');
    expect(ts.extensions).toContain('jsx');
  });

  test('enabled:false passes through', () => {
    write({ lsp: { enabled: false } });
    expect(buildUserConfig(cfgPath).lsp.enabled).toBe(false);
  });

  test('per-language disable: lsp.python=false keeps typescript/rust active', () => {
    write({ lsp: { python: false } });
    const c = buildUserConfig(cfgPath);
    expect(c.lsp.python).toBe(false);
    expect(c.lsp.typescript).not.toBe(false);
    expect(c.lsp.rust).not.toBe(false);
  });

  test('custom command + extensions override defaults', () => {
    write({
      lsp: {
        typescript: {
          command: '/opt/tsls',
          args: ['--flag'],
          extensions: ['ts', 'vue'],
        },
      },
    });
    const c = buildUserConfig(cfgPath);
    const ts = c.lsp.typescript as { command: string; args?: string[]; extensions: string[] };
    expect(ts.command).toBe('/opt/tsls');
    expect(ts.args).toEqual(['--flag']);
    expect(ts.extensions).toEqual(['ts', 'vue']);
  });

  test('extensions are lowercased and stripped of leading dot', () => {
    write({
      lsp: {
        typescript: {
          command: '/opt/tsls',
          extensions: ['.TS', 'TSX'],
        },
      },
    });
    const c = buildUserConfig(cfgPath);
    const ts = c.lsp.typescript as unknown as { extensions: readonly string[] };
    expect(ts.extensions).toEqual(['ts', 'tsx']);
  });

  test('idleTimeoutMs clamped to [5s, 1hr]', () => {
    write({ lsp: { idleTimeoutMs: 100 } });
    expect(buildUserConfig(cfgPath).lsp.idleTimeoutMs).toBe(5_000);
    write({ lsp: { idleTimeoutMs: 10 * 60 * 60 * 1000 } });
    expect(buildUserConfig(cfgPath).lsp.idleTimeoutMs).toBe(60 * 60 * 1000);
  });

  test('workspaceSymbolLanguage accepts enum values, falls back to typescript', () => {
    write({ lsp: { workspaceSymbolLanguage: 'rust' } });
    expect(buildUserConfig(cfgPath).lsp.workspaceSymbolLanguage).toBe('rust');
    write({ lsp: { workspaceSymbolLanguage: 'bogus' } });
    expect(buildUserConfig(cfgPath).lsp.workspaceSymbolLanguage).toBe('typescript');
  });

  test('chat.conciseness clamps numeric knobs and honors booleans', () => {
    write({
      chat: {
        conciseness: {
          enabled: false,
          finalMessageMaxLines: 999,
          preambleMaxWords: 0,
          flatBullets: false,
        },
      },
    });
    expect(buildUserConfig(cfgPath).chat.conciseness).toEqual({
      enabled: false,
      finalMessageMaxLines: 100,
      preambleMaxWords: 1,
      flatBullets: false,
    });
  });

  test('chat.toolOutput clamps numeric knobs and honors booleans', () => {
    write({
      chat: {
        toolOutput: {
          persistOnOverflow: false,
          retentionDays: 999,
          previewLines: 0,
        },
      },
    });
    expect(buildUserConfig(cfgPath).chat.toolOutput).toEqual({
      persistOnOverflow: false,
      retentionDays: 365,
      previewLines: 1,
    });
  });

  test('chat.autoCompact clamps numeric knobs and honors booleans', () => {
    write({
      chat: {
        autoCompact: {
          enabled: false,
          triggerRatio: 2,
          preserveLastN: -1,
          partial: false,
          workingBudgetTokens: 128_000,
        },
      },
    });
    expect(buildUserConfig(cfgPath).chat.autoCompact).toEqual({
      enabled: false,
      triggerRatio: 0.99,
      preserveLastN: 0,
      preserveFirstN: 1,
      partial: false,
      workingBudgetTokens: 128_000,
    });
  });

  test('chat.autoCompact restores the default working budget for invalid values', () => {
    for (const workingBudgetTokens of [0, -1, 1.5, '256000']) {
      write({ chat: { autoCompact: { workingBudgetTokens } } });
      expect(buildUserConfig(cfgPath).chat.autoCompact.workingBudgetTokens).toBe(256_000);
    }
  });

  test('chat.autoCopyQaToClipboard parses boolean with safe default', () => {
    write({
      chat: {
        autoCopyQaToClipboard: true,
      },
    });
    expect(buildUserConfig(cfgPath).chat.autoCopyQaToClipboard).toBe(true);

    write({
      chat: {
        autoCopyQaToClipboard: 'bogus',
      },
    });
    expect(buildUserConfig(cfgPath).chat.autoCopyQaToClipboard).toBe(false);
  });

  test('chat.systemPrompt parses overridePath and taskVariant', () => {
    write({
      chat: {
        systemPrompt: {
          overridePath: '/tmp/custom.md',
          taskVariant: 'default',
        },
      },
    });
    expect(buildUserConfig(cfgPath).chat.systemPrompt).toEqual({
      overridePath: '/tmp/custom.md',
      taskVariant: 'default',
    });
  });

  test('chat.rendering parses streaming while ignoring the retired compactBoundary switch', () => {
    write({
      chat: {
        rendering: {
          streaming: {
            mode: 'line',
            catchUpThresholdLines: 0,
            catchUpAgeMs: 99_999,
          },
          compactBoundary: {
            enabled: false,
          },
        },
      },
    });
    expect(buildUserConfig(cfgPath).chat.rendering).toEqual({
      streaming: {
        mode: 'line',
        catchUpThresholdLines: 1,
        catchUpAgeMs: 10_000,
      },
      wrap: {
        urlAware: false,
      },
      tool: {
        displayMode: 'inline-to-block',
        blockMaxLines: 8,
      },
      hud: {
        gaugeWarnRatio: 0.7,
        gaugeDangerRatio: 0.85,
      },
      diff: {
        colorTier: 'auto',
        headerStyle: 'legacy',
        turnBrowserHistory: 8,
        turnBrowserMode: 'all',
      },
    });
  });

  test('chat.rendering.wrap parses booleans with safe defaults', () => {
    write({
      chat: {
        rendering: {
          wrap: {
            urlAware: true,
            preserveOsc8: false,
          },
        },
      },
    });
    expect(buildUserConfig(cfgPath).chat.rendering.wrap).toEqual({
      urlAware: true,
    });
  });

  test('chat.rendering.tool parses mode and clamps block lines', () => {
    write({
      chat: {
        rendering: {
          tool: {
            displayMode: 'inline-to-block',
            blockMaxLines: 0,
          },
        },
      },
    });
    expect(buildUserConfig(cfgPath).chat.rendering.tool).toEqual({
      displayMode: 'inline-to-block',
      blockMaxLines: 1,
    });
  });

  test('chat.rendering.hud parses flags and threshold clamps', () => {
    write({
      chat: {
        rendering: {
          hud: {
            gaugeWarnRatio: -1,
            gaugeDangerRatio: 2,
          },
        },
      },
    });
    expect(buildUserConfig(cfgPath).chat.rendering.hud).toEqual({
      gaugeWarnRatio: 0,
      gaugeDangerRatio: 1,
    });
  });

  test('chat.rendering.diff parses tier and booleans', () => {
    write({
      chat: {
        rendering: {
          diff: {
            colorTier: 'ansi16',
            adaptiveBg: false,
            syntaxPerHunk: false,
            cache: false,
            headerStyle: 'edited',
            turnSummary: false,
            turnBrowser: false,
            turnBrowserHistory: 99,
            turnBrowserMode: 'files',
          },
        },
      },
    });
    expect(buildUserConfig(cfgPath).chat.rendering.diff).toEqual({
      colorTier: 'ansi16',
      headerStyle: 'edited',
      turnBrowserHistory: 20,
      turnBrowserMode: 'files',
    });
  });
});

describe('user-config extended schema', () => {
  test('defaults include llm/skills/obsidian/telegram/onboarding', () => {
    const c = buildUserConfig(cfgPath);
    expect(c.llm.provider).toBe('auto');
    expect(c.llm.apiKey).toBeUndefined();
    expect(c.skills.activeSet).toBe('claudecode');
    expect(c.skills.dirs.length).toBe(1);
    expect(c.skills.dirs[0]).toContain('.claude/skills');
    expect(c.obsidian.vault).toMatch(/Obsidian|ElanvitalAI/);
    expect(c.telegram.enabled).toBe(false);
    expect(c.telegram.allowedUsers).toEqual([]);
    expect(c.onboarding.completed).toBe(false);
    expect(c.onboarding.version).toBe(0);
    expect(c.onboarding.webFirst).toBeUndefined();
  });

  test('onboarding.webFirst accepts only boolean and survives save + reload', () => {
    for (const value of [true, false]) {
      write({ onboarding: { webFirst: value } });
      const cfg = buildUserConfig(cfgPath);
      expect(cfg.onboarding.webFirst).toBe(value);
      saveUserConfig(cfg, cfgPath);
      expect(reloadUserConfig(cfgPath).onboarding.webFirst).toBe(value);
    }
    write({ onboarding: { webFirst: 'true' } });
    expect(buildUserConfig(cfgPath).onboarding.webFirst).toBeUndefined();
  });

  test('llm.provider accepts valid enum; coerces unknown → auto', () => {
    write({ llm: { provider: 'openai-codex', apiKey: 'sk-xxx', model: 'o4-mini' } });
    const c = buildUserConfig(cfgPath);
    expect(c.llm.provider).toBe('openai-codex');
    expect(c.llm.apiKey).toBe('sk-xxx');
    expect(c.llm.model).toBe('o4-mini');

    write({ llm: { provider: 'haiku-turbo' } });
    expect(buildUserConfig(cfgPath).llm.provider).toBe('auto');
  });

  test('ELANOUS_LLM_PROVIDER overrides the configured provider, model, and resolves target credentials', () => {
    write({
      llm: {
        provider: 'openai-codex',
        model: 'gpt-5.6-terra',
        apiKey: 'sk-config',
        rotation: [{ provider: 'grok', apiKey: 'xai-target' }],
      },
    });
    process.env.ELANOUS_LLM_PROVIDER = 'grok';

    const cfg = buildUserConfig(cfgPath);
    expect(cfg.llm.provider).toBe('grok');
    // ⛔ 모델 이름을 박지 않는다 — provider 기본은 `PROVIDER_DEFAULT_MODEL` 이 SSOT(08-18 이후 grok-4.6 → 4.7 로 늙었다).
    expect(cfg.llm.model).toBe(PROVIDER_DEFAULT_MODEL.grok);
    expect(cfg.llm.apiKey).toBe('xai-target');
  });

  test('ELANOUS_LLM_MODEL overrides the switched provider default', () => {
    write({ llm: { provider: 'openai-codex', model: 'gpt-5.6-terra' } });
    setEnv({ ELANOUS_LLM_PROVIDER: 'grok', ELANOUS_LLM_MODEL: 'grok-4.6-custom' });

    expect(buildUserConfig(cfgPath).llm.model).toBe('grok-4.6-custom');
  });

  test.each([
    ['missing config', () => undefined],
    ['malformed config', () => write('{not json')],
    ['non-object config', () => write('"not an object"')],
  ])('ELANOUS_LLM_MODEL overrides the default model without a provider override for %s', (_label, prepare) => {
    prepare();
    setEnv({ ELANOUS_LLM_MODEL: 'model-only-override' });

    const cfg = buildUserConfig(cfgPath);
    expect(cfg.llm.provider).toBe('auto');
    expect(cfg.llm.model).toBe('model-only-override');
  });

  test('same ELANOUS_LLM_PROVIDER preserves the configured model', () => {
    write({ llm: { provider: 'grok', model: 'grok-pinned' } });
    setEnv({ ELANOUS_LLM_PROVIDER: 'grok' });

    expect(buildUserConfig(cfgPath).llm.model).toBe('grok-pinned');
  });

  test('without provider or model env overrides config provider and model are preserved', () => {
    write({ llm: { provider: 'openai-codex', model: 'gpt-5.6-terra' } });

    const cfg = buildUserConfig(cfgPath);
    expect(cfg.llm.provider).toBe('openai-codex');
    expect(cfg.llm.model).toBe('gpt-5.6-terra');
  });

  test('model-only env mismatch names provider and model on stderr before a request', () => {
    write({ llm: { provider: 'openai-codex', model: 'gpt-5.6-terra' } });
    setEnv({ ELANOUS_LLM_MODEL: 'grok-4.6' });
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return (original as (c: string | Uint8Array, ...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    let cfg;
    try {
      cfg = buildUserConfig(cfgPath);
    } finally {
      process.stderr.write = original;
    }
    const observed = chunks.join('');
    expect(cfg!.llm.provider).toBe('openai-codex');
    expect(cfg!.llm.model).toBe('grok-4.6');
    expect(observed).toContain('model-provider mismatch');
    expect(observed).toContain('provider=openai-codex');
    expect(observed).toContain('model=grok-4.6');
  });

  test('same-provider model-only env override stays silent', () => {
    write({ llm: { provider: 'openai-codex', model: 'gpt-5.6-terra' } });
    setEnv({ ELANOUS_LLM_MODEL: 'gpt-5.6-sol' });
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return (original as (c: string | Uint8Array, ...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    let cfg;
    try {
      cfg = buildUserConfig(cfgPath);
    } finally {
      process.stderr.write = original;
    }
    expect(cfg!.llm.provider).toBe('openai-codex');
    expect(cfg!.llm.model).toBe('gpt-5.6-sol');
    expect(chunks.join('')).not.toContain('model-provider mismatch');
  });

  test('exact o3 model-only env mismatch names provider and model on stderr before a request', () => {
    write({ llm: { provider: 'grok', model: 'grok-4.6' } });
    setEnv({ ELANOUS_LLM_MODEL: 'o3' });
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return (original as (c: string | Uint8Array, ...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    let cfg;
    try {
      cfg = buildUserConfig(cfgPath);
    } finally {
      process.stderr.write = original;
    }
    const observed = chunks.join('');
    expect(cfg!.llm.provider).toBe('grok');
    expect(cfg!.llm.model).toBe('o3');
    expect(observed).toContain('model-provider mismatch');
    expect(observed).toContain('provider=grok');
    expect(observed).toContain('model=o3');
  });

  test('openai provider with gpt-5.6-sol model-only env names both values', () => {
    write({ llm: { provider: 'openai', model: 'gpt-4o' } });
    setEnv({ ELANOUS_LLM_MODEL: 'gpt-5.6-sol' });
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return (original as (c: string | Uint8Array, ...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    let cfg;
    try {
      cfg = buildUserConfig(cfgPath);
    } finally {
      process.stderr.write = original;
    }
    const observed = chunks.join('');
    expect(cfg!.llm.provider).toBe('openai');
    expect(cfg!.llm.model).toBe('gpt-5.6-sol');
    expect(observed).toContain('model-provider mismatch');
    expect(observed).toContain('provider=openai');
    expect(observed).toContain('model=gpt-5.6-sol');
  });

  test.each([
    ['missing config', () => undefined],
    ['malformed config', () => write('{not json')],
    ['non-object config', () => write('"not an object"')],
  ])('ELANOUS_LLM_PROVIDER resolves target credentials with %s', (_label, prepare) => {
    prepare();
    setEnv({ ELANOUS_LLM_PROVIDER: 'openai-codex', OPENAI_API_KEY: 'sk-openai-from-env' });

    const cfg = buildUserConfig(cfgPath);
    expect(cfg.llm.provider).toBe('openai-codex');
    expect(cfg.llm.apiKey).toBe('sk-openai-from-env');
  });

  test.each([
    ['missing config', () => undefined],
    ['malformed config', () => write('{not json')],
    ['non-object config', () => write('"not an object"')],
  ])('%s preserves the default empty raw shape through save and reload', (_label, prepare) => {
    prepare();

    const cfg = buildUserConfig(cfgPath);
    expect(cfg.llm.provider).toBe('auto');
    expect(cfg.raw).toEqual({});

    saveUserConfig(cfg, cfgPath);
    const saved = JSON.parse(require('node:fs').readFileSync(cfgPath, 'utf-8'));
    const reloaded = reloadUserConfig(cfgPath);
    expect(saved.raw).toBeUndefined();
    expect(reloaded.raw).toEqual(saved);
  });

  test('EV12c discord.chatChannels parses snowflakes as strings and survives save + reload', () => {
    write({ discord: { enabled: true, allowedUsers: ['1'], chatChannels: ['1500000000000000001', 1500, ' ', ''] } });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.discord.chatChannels).toEqual(['1500000000000000001', '1500']);
    saveUserConfig(cfg, cfgPath);
    expect(reloadUserConfig(cfgPath).discord.chatChannels).toEqual(['1500000000000000001', '1500']);
    write({ discord: { enabled: true, allowedUsers: [] } });
    expect(buildUserConfig(cfgPath).discord.chatChannels).toBeUndefined();
  });

  test('ELANOUS_ESCALATE_PROVIDER retains priority when both provider env overrides are set', () => {
    write({ llm: { provider: 'openai-codex', rotation: [{ provider: 'anthropic', apiKey: 'sk-ant-target' }] } });
    setEnv({ ELANOUS_LLM_PROVIDER: 'grok', ELANOUS_ESCALATE_PROVIDER: 'anthropic' });

    const cfg = buildUserConfig(cfgPath);
    expect(cfg.llm.provider).toBe('anthropic');
    expect(cfg.llm.apiKey).toBe('sk-ant-target');
  });

  // ⛔⭐ 우선순위는 **경로마다 같아야 한다**(무인 리뷰 must-fix 2R). 파싱 경로만 검증하면
  //   config 파일이 「있느냐 없느냐」로 provider 가 갈리는 분기 불일치를 놓친다.
  test.each([
    ['missing config', () => undefined],
    ['malformed config', () => write('{not json')],
    ['non-object config', () => write('"not an object"')],
  ])('ELANOUS_ESCALATE_PROVIDER keeps the same priority with %s', (_label, prepare) => {
    prepare();
    setEnv({ ELANOUS_LLM_PROVIDER: 'grok', ELANOUS_ESCALATE_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-from-env' });

    const cfg = buildUserConfig(cfgPath);
    expect(cfg.llm.provider).toBe('anthropic');
    expect(cfg.llm.apiKey).toBe('sk-ant-from-env');
  });

  test('empty ELANOUS_LLM_PROVIDER preserves the configured provider', () => {
    write({ llm: { provider: 'openai-codex' } });
    setEnv({ ELANOUS_LLM_PROVIDER: '   ' });

    expect(buildUserConfig(cfgPath).llm.provider).toBe('openai-codex');
  });

  test('invalid ELANOUS_LLM_PROVIDER fails instead of silently using config', () => {
    write({ llm: { provider: 'openai-codex' } });
    process.env.ELANOUS_LLM_PROVIDER = 'typo-provider';

    expect(() => buildUserConfig(cfgPath)).toThrow('Invalid ELANOUS_LLM_PROVIDER "typo-provider"');
  });

  test('without ELANOUS_LLM_PROVIDER the configured provider is preserved', () => {
    write({ llm: { provider: 'anthropic' } });

    expect(buildUserConfig(cfgPath).llm.provider).toBe('anthropic');
  });

  test('skills.dirs falls back to default when empty/invalid', () => {
    write({ skills: { dirs: [] } });
    expect(buildUserConfig(cfgPath).skills.dirs.length).toBe(1);

    write({ skills: { dirs: 'not-an-array' } });
    expect(buildUserConfig(cfgPath).skills.dirs.length).toBe(1);

    write({ skills: { dirs: ['/tmp/a', '/tmp/b'] } });
    const c = buildUserConfig(cfgPath);
    expect(c.skills.dirs).toEqual(['/tmp/a', '/tmp/b']);
  });

  test('skills.activeSet accepts known names; unknown → opencode', () => {
    write({ skills: { activeSet: 'claudecode' } });
    expect(buildUserConfig(cfgPath).skills.activeSet).toBe('claudecode');

    write({ skills: { activeSet: 'weirdname' } });
    expect(buildUserConfig(cfgPath).skills.activeSet).toBe('opencode');
  });

  test('skills.allow / skills.deny parsed as string arrays, default empty', () => {
    const c1 = buildUserConfig(cfgPath);
    expect(c1.skills.allow).toEqual([]);
    expect(c1.skills.deny).toEqual([]);

    write({ skills: { allow: ['omni-digest', 'youtube-master'], deny: ['noisy-skill'] } });
    const c2 = buildUserConfig(cfgPath);
    expect(c2.skills.allow).toEqual(['omni-digest', 'youtube-master']);
    expect(c2.skills.deny).toEqual(['noisy-skill']);

    // Non-array garbage falls back to []
    write({ skills: { allow: 'not-an-array', deny: 42 } });
    const c3 = buildUserConfig(cfgPath);
    expect(c3.skills.allow).toEqual([]);
    expect(c3.skills.deny).toEqual([]);
  });

  test('skillSetDir returns canonical paths and null for custom', () => {
    expect(skillSetDir('claudecode')).toContain('/.claude/skills');
    expect(skillSetDir('opencode')).toContain('/.config/opencode/skills');
    expect(skillSetDir('codex')).toContain('/.codex/skills');
    expect(skillSetDir('hermes')).toContain('/.hermes/skills');
    expect(skillSetDir('openclaw')).toContain('/.openclaw/workspace/skills');
    expect(skillSetDir('custom')).toBeNull();
  });

  test('telegram.allowedUsers coerces to number array', () => {
    write({ telegram: { enabled: true, allowedUsers: [12345, 'not-a-num', 67890] } });
    const c = buildUserConfig(cfgPath);
    expect(c.telegram.enabled).toBe(true);
    expect(c.telegram.allowedUsers).toEqual([12345, 67890]);
  });

  // ⚠️ 이 테스트가 `skills.urlRouting` **부재** 경로의 가드다 — 아래에서 `cfg.skills` 를
  //   `{ activeSet, dirs }` 로 덮어써 `urlRouting` 이 사라진다. `saveUserConfig` 가 그걸 무조건
  //   접으면 여기서 TypeError 로 죽는다(실제로 그렇게 잡혔다). 별도 테스트를 더하지 않는 이유다.
  test('saveUserConfig round-trips', () => {
    const cfg: UserConfig = buildUserConfig(cfgPath);
    cfg.llm = { provider: 'local', baseUrl: 'http://localhost:11434/v1', model: 'llama3' };
    cfg.skills = { activeSet: 'hermes', dirs: ['/tmp/s1', '/tmp/s2'] };
    cfg.telegram = { enabled: true, botToken: 'xxx:yyy', allowedUsers: [111], homeChannel: -1001 };
    cfg.obsidian = { vault: '/tmp/vault' };
    cfg.debug = { file: true, level: 'diag', exposeFullLlmTools: true };
    cfg.chat = {
      conciseness: {
        enabled: false,
        finalMessageMaxLines: 6,
        preambleMaxWords: 8,
        flatBullets: false,
      },
      toolOutput: {
        persistOnOverflow: false,
        retentionDays: 14,
        previewLines: 11,
      },
      autoCompact: {
        enabled: false,
        triggerRatio: 0.9,
        preserveLastN: 2,
        partial: false,
      },
      autoCopyQaToClipboard: true,
      systemPrompt: {
        overridePath: '/tmp/custom.md',
        taskVariant: 'default',
      },
      rendering: {
        streaming: {
          mode: 'line',
          catchUpThresholdLines: 25,
          catchUpAgeMs: 150,
        },
        wrap: {
          urlAware: true,
        },
        tool: {
          displayMode: 'inline-to-block',
          blockMaxLines: 12,
        },
        diff: {
          colorTier: '256',
          headerStyle: 'legacy',
          turnBrowserHistory: 8,
          turnBrowserMode: 'all',
        },
        hud: {
          gaugeWarnRatio: 0.4,
          gaugeDangerRatio: 0.6,
        },
      },
      // FU8 PR #6 (2026-05-12) — `ChatConfig` gained `compact`
      // (4-layer summary controls) and `toolDeny` (LLM tool deny
      // list) after this fixture was last refreshed. Defaults match
      // `CHAT_DEFAULTS` so the reload smoke stays minimal-touch.
      compact: {
        verifyProbe: false,
        archiveEnabled: true,
        archiveRetentionDays: 30,
        archiveRetentionMb: 50,
      },
      toolDeny: [],
    };
    saveUserConfig(cfg, cfgPath);

    const reloaded = reloadUserConfig(cfgPath);
    expect(reloaded.llm.provider).toBe('local');
    expect(reloaded.llm.baseUrl).toBe('http://localhost:11434/v1');
    expect(reloaded.skills.activeSet).toBe('hermes');
    expect(reloaded.skills.dirs).toEqual(['/tmp/s1', '/tmp/s2']);
    expect(reloaded.telegram.enabled).toBe(true);
    expect(reloaded.telegram.botToken).toBe('xxx:yyy');
    expect(reloaded.telegram.allowedUsers).toEqual([111]);
    expect(reloaded.telegram.homeChannel).toBe(-1001);
    expect(reloaded.obsidian.vault).toBe('/tmp/vault');
    expect(reloaded.debug).toEqual({ file: true, level: 'diag', exposeFullLlmTools: true, renderLogs: false });
    expect(reloaded.chat.conciseness).toEqual({
      enabled: false,
      finalMessageMaxLines: 6,
      preambleMaxWords: 8,
      flatBullets: false,
    });
    expect(reloaded.chat.toolOutput).toEqual({
      persistOnOverflow: false,
      retentionDays: 14,
      previewLines: 11,
    });
    expect(reloaded.chat.autoCompact).toEqual({
      enabled: false,
      triggerRatio: 0.9,
      preserveLastN: 2,
      preserveFirstN: 1,
      partial: false,
      workingBudgetTokens: 256_000,
    });
    expect(reloaded.chat.autoCopyQaToClipboard).toBe(true);
    expect(reloaded.chat.systemPrompt).toEqual({
      overridePath: '/tmp/custom.md',
      taskVariant: 'default',
    });
    expect(reloaded.chat.rendering).toEqual({
      streaming: {
        mode: 'line',
        catchUpThresholdLines: 25,
        catchUpAgeMs: 150,
      },
      wrap: {
        urlAware: true,
      },
      tool: {
        displayMode: 'inline-to-block',
        blockMaxLines: 12,
      },
      diff: {
        colorTier: '256',
        headerStyle: 'legacy',
        turnBrowserHistory: 8,
        turnBrowserMode: 'all',
      },
      hud: {
        gaugeWarnRatio: 0.4,
        gaugeDangerRatio: 0.6,
      },
    });
  });

  test('debug.level stays on historical default when omitted on disk', () => {
    write({ debug: { file: true } });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.debug).toEqual({ file: true, level: 'trail', exposeFullLlmTools: true, renderLogs: false });
    saveUserConfig(cfg, cfgPath);
    expect(buildUserConfig(cfgPath).debug).toEqual({ file: true, level: 'trail', exposeFullLlmTools: true, renderLogs: false });
  });

  test('debug.level honors explicit config override', () => {
    write({ debug: { file: true, level: 'diag' } });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.debug).toEqual({ file: true, level: 'diag', exposeFullLlmTools: true, renderLogs: false });
    saveUserConfig(cfg, cfgPath);
    expect(buildUserConfig(cfgPath).debug).toEqual({ file: true, level: 'diag', exposeFullLlmTools: true, renderLogs: false });
  });

  test('saveUserConfig preserves unknown raw keys', () => {
    write({ skillRouter: { autoRoute: true }, futureFeature: { a: 1 } });
    const cfg = buildUserConfig(cfgPath);
    saveUserConfig(cfg, cfgPath);
    const reloaded = reloadUserConfig(cfgPath);
    expect((reloaded.raw.futureFeature as any).a).toBe(1);
  });

  test('markOnboardingComplete flips completed+timestamp+version', () => {
    const before = buildUserConfig(cfgPath);
    expect(before.onboarding.completed).toBe(false);
    const after = markOnboardingComplete(before);
    expect(after.onboarding.completed).toBe(true);
    expect(after.onboarding.completedAt).toBeDefined();
    expect(after.onboarding.version).toBe(currentOnboardingVersion());
  });

  test('onboarding.completed persists via save/load', () => {
    const cfg = markOnboardingComplete(buildUserConfig(cfgPath));
    saveUserConfig(cfg, cfgPath);
    const reloaded = reloadUserConfig(cfgPath);
    expect(reloaded.onboarding.completed).toBe(true);
    expect(reloaded.onboarding.version).toBe(currentOnboardingVersion());
  });
});

describe('dashboard view config', () => {
  test('loads dashboard.views raw object for view-config parser', () => {
    write({
      dashboard: {
        views: {
          order: ['compact'],
          views: [{
            id: 'compact',
            label: 'Compact',
            shortcut: '5',
            baseView: 1,
            rows: [{ ratio: 1, panes: [{ pane: 'browser', ratio: 1 }] }],
          }],
        },
      },
    });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.dashboard.views?.order).toEqual(['compact']);
  });

  test('saveUserConfig persists dashboard.views and reset can omit it', () => {
    let cfg = buildUserConfig(cfgPath);
    // FU8 PR #6 (2026-05-12) — `DashboardConfig.promptBank` is now a
    // required field. Preserve the existing fixture by spreading
    // `cfg.dashboard` so the original promptBank defaults flow into
    // both halves of the test (the override + the reset).
    cfg = {
      ...cfg,
      dashboard: {
        ...cfg.dashboard,
        views: {
          order: ['compact'],
          views: [{ id: 'compact', rows: [{ panes: ['browser'] }] }],
        },
      },
    };
    saveUserConfig(cfg, cfgPath);
    expect(buildUserConfig(cfgPath).dashboard.views?.order).toEqual(['compact']);
    saveUserConfig(
      { ...cfg, dashboard: { ...cfg.dashboard, views: undefined } },
      cfgPath,
    );
    expect(buildUserConfig(cfgPath).dashboard.views).toBeUndefined();
  });

  test('loads and persists dashboard.theme raw object for theme-token parser', () => {
    write({
      dashboard: {
        theme: {
          name: 'night-test',
          colors: { accent: '#123456' },
          pane: { dividerActive: '#abcdef' },
        },
      },
    });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.dashboard.theme?.name).toBe('night-test');
    expect((cfg.dashboard.theme?.colors as any)?.accent).toBe('#123456');
    saveUserConfig(cfg, cfgPath);
    const reloaded = buildUserConfig(cfgPath);
    expect((reloaded.dashboard.theme?.pane as any)?.dividerActive).toBe('#abcdef');
  });

  test('loads and persists dashboard.promptBank live injection flags', () => {
    write({
      dashboard: {
        promptBank: {
          enabled: true,
          dashboardTurns: true,
          skillRuns: true,
          budgetTokens: 2500,
          limit: 12,
          record: false,
        },
      },
    });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.dashboard.promptBank.enabled).toBe(true);
    expect(cfg.dashboard.promptBank.dashboardTurns).toBe(true);
    expect(cfg.dashboard.promptBank.skillRuns).toBe(true);
    expect(cfg.dashboard.promptBank.budgetTokens).toBe(2500);
    expect(cfg.dashboard.promptBank.limit).toBe(12);
    expect(cfg.dashboard.promptBank.record).toBe(false);
    saveUserConfig(cfg, cfgPath);
    const reloaded = buildUserConfig(cfgPath);
    expect(reloaded.dashboard.promptBank.enabled).toBe(true);
    expect(reloaded.dashboard.promptBank.record).toBe(false);
  });
});

describe('user-config voice.stt/tts config화 (2026-07-12 — 러너 env 대체)', () => {
  test('voice.stt.provider accepts elevenlabs-scribe-realtime', () => {
    write({ voice: { stt: { provider: 'elevenlabs-scribe-realtime' } } });
    expect(buildUserConfig(cfgPath).voice.stt.provider).toBe('elevenlabs-scribe-realtime');
  });

  test('voice.stt.provider unknown id normalizes to default', () => {
    write({ voice: { stt: { provider: 'scribe-v9-unknown' } } });
    expect(buildUserConfig(cfgPath).voice.stt.provider).toBe('openai-realtime-stt');
  });

  test('voice.discord.sttProvider override — 유효 id 수용 · 오타는 미설정으로', () => {
    write({ voice: { discord: { sttProvider: 'elevenlabs-scribe-realtime' } } });
    expect(buildUserConfig(cfgPath).voice.discord.sttProvider).toBe('elevenlabs-scribe-realtime');
    // override 필드는 normalize(기본값 강제) 대신 드롭 — 오타가 조용히
    // openai 로 바뀌면 dogfood 비교가 무효가 된다.
    write({ voice: { discord: { sttProvider: 'scribe-typo' } } });
    expect(buildUserConfig(cfgPath).voice.discord.sttProvider).toBeUndefined();
  });

  test('voice.tts.voiceId preserved (trimmed) · empty/non-string dropped', () => {
    write({ voice: { tts: { voiceId: ' ksaI0TCD9BstzEzlxj4q ' } } });
    expect(buildUserConfig(cfgPath).voice.tts.voiceId).toBe('ksaI0TCD9BstzEzlxj4q');
    write({ voice: { tts: { voiceId: '   ' } } });
    expect(buildUserConfig(cfgPath).voice.tts.voiceId).toBeUndefined();
    write({ voice: { tts: { voiceId: 42 } } });
    expect(buildUserConfig(cfgPath).voice.tts.voiceId).toBeUndefined();
  });
});

describe('user-config voice.telegram (Phase 8 — Telegram voice msg)', () => {
  test('default → empty object (resolver applies adapter default replyMode = auto)', () => {
    const c = buildUserConfig(cfgPath);
    expect(c.voice.telegram).toEqual({});
  });

  test('dispatch preserved when valid', () => {
    write({ voice: { telegram: { dispatch: 'auto-reply' } } });
    expect(buildUserConfig(cfgPath).voice.telegram.dispatch).toBe('auto-reply');
    write({ voice: { telegram: { dispatch: 'tui-bridge' } } });
    expect(buildUserConfig(cfgPath).voice.telegram.dispatch).toBe('tui-bridge');
  });

  test('dispatch dropped when invalid (sparse fallback)', () => {
    write({ voice: { telegram: { dispatch: 'fanout' } } });
    expect(buildUserConfig(cfgPath).voice.telegram.dispatch).toBeUndefined();
    write({ voice: { telegram: { dispatch: 3 } } });
    expect(buildUserConfig(cfgPath).voice.telegram.dispatch).toBeUndefined();
  });

  test('replyMode preserved when valid', () => {
    write({ voice: { telegram: { replyMode: 'voice' } } });
    expect(buildUserConfig(cfgPath).voice.telegram.replyMode).toBe('voice');
    write({ voice: { telegram: { replyMode: 'text' } } });
    expect(buildUserConfig(cfgPath).voice.telegram.replyMode).toBe('text');
    write({ voice: { telegram: { replyMode: 'auto' } } });
    expect(buildUserConfig(cfgPath).voice.telegram.replyMode).toBe('auto');
  });

  test('replyMode dropped when invalid (sparse fallback)', () => {
    write({ voice: { telegram: { replyMode: 'shout' } } });
    expect(buildUserConfig(cfgPath).voice.telegram.replyMode).toBeUndefined();
    write({ voice: { telegram: { replyMode: 1 } } });
    expect(buildUserConfig(cfgPath).voice.telegram.replyMode).toBeUndefined();
  });

  test('voiceLanguage preserved when non-empty string', () => {
    write({ voice: { telegram: { voiceLanguage: 'ko' } } });
    expect(buildUserConfig(cfgPath).voice.telegram.voiceLanguage).toBe('ko');
  });

  test('voiceLanguage dropped when empty / wrong type', () => {
    write({ voice: { telegram: { voiceLanguage: '' } } });
    expect(buildUserConfig(cfgPath).voice.telegram.voiceLanguage).toBeUndefined();
    write({ voice: { telegram: { voiceLanguage: 42 } } });
    expect(buildUserConfig(cfgPath).voice.telegram.voiceLanguage).toBeUndefined();
  });

  test('coexists with other voice sub-sections', () => {
    write({
      voice: {
        tts: { auto: true },
        chat: { multiTurn: true },
        telegram: { dispatch: 'tui-bridge', replyMode: 'voice', voiceLanguage: 'ko' },
      },
    });
    const c = buildUserConfig(cfgPath);
    expect(c.voice.tts.auto).toBe(true);
    expect(c.voice.chat.multiTurn).toBe(true);
    expect(c.voice.telegram.dispatch).toBe('tui-bridge');
    expect(c.voice.telegram.replyMode).toBe('voice');
    expect(c.voice.telegram.voiceLanguage).toBe('ko');
  });
});

describe('user-config voice.discord (sprint 22 follow-up — Discord text dispatch)', () => {
  test('default → empty object (caller applies dispatch = "auto-reply")', () => {
    const c = buildUserConfig(cfgPath);
    expect(c.voice.discord).toEqual({});
  });

  test('voiceLanguage preserved when non-empty string', () => {
    write({ voice: { discord: { voiceLanguage: 'ko' } } });
    expect(buildUserConfig(cfgPath).voice.discord.voiceLanguage).toBe('ko');
  });

  test('voiceLanguage dropped when empty / wrong type', () => {
    write({ voice: { discord: { voiceLanguage: '' } } });
    expect(buildUserConfig(cfgPath).voice.discord.voiceLanguage).toBeUndefined();
    write({ voice: { discord: { voiceLanguage: 42 } } });
    expect(buildUserConfig(cfgPath).voice.discord.voiceLanguage).toBeUndefined();
  });

  test('voiceChannel follow-up fields preserved when valid', () => {
    write({
      voice: {
        discord: {
          voiceChannel: {
            enabled: true,
            listenFilter: 'all',
            leaveOnEmpty: false,
          },
        },
      },
    });
    const c = buildUserConfig(cfgPath);
    expect(c.voice.discord.voiceChannel?.enabled).toBe(true);
    expect(c.voice.discord.voiceChannel?.listenFilter).toBe('all');
    expect(c.voice.discord.voiceChannel?.leaveOnEmpty).toBe(false);
  });

  test('voiceChannel listenFilter dropped when invalid', () => {
    write({ voice: { discord: { voiceChannel: { listenFilter: 'nobody' } } } });
    expect(buildUserConfig(cfgPath).voice.discord.voiceChannel?.listenFilter).toBeUndefined();
  });

  test('voiceChannel 튜닝 상수 (갭 #4) preserved when valid, dropped out of range', () => {
    write({
      voice: {
        discord: {
          voiceChannel: {
            bargeIn: true,
            bargeInSustainMs: 500,
            selfEchoTailMs: 200,
            sttSilenceFinalizeMs: 900,
          },
        },
      },
    });
    const c = buildUserConfig(cfgPath);
    expect(c.voice.discord.voiceChannel?.bargeIn).toBe(true);
    expect(c.voice.discord.voiceChannel?.bargeInSustainMs).toBe(500);
    expect(c.voice.discord.voiceChannel?.selfEchoTailMs).toBe(200);
    expect(c.voice.discord.voiceChannel?.sttSilenceFinalizeMs).toBe(900);
    write({
      voice: {
        discord: {
          voiceChannel: {
            bargeIn: 'yes',              // not a boolean
            bargeInSustainMs: 10,        // < 50
            selfEchoTailMs: 99999,       // > 5000
            sttSilenceFinalizeMs: 0,     // < 100
          },
        },
      },
    });
    const d = buildUserConfig(cfgPath);
    expect(d.voice.discord.voiceChannel?.bargeIn).toBeUndefined();
    expect(d.voice.discord.voiceChannel?.bargeInSustainMs).toBeUndefined();
    expect(d.voice.discord.voiceChannel?.selfEchoTailMs).toBeUndefined();
    expect(d.voice.discord.voiceChannel?.sttSilenceFinalizeMs).toBeUndefined();
  });

  test('coexists with telegram + pwa sub-sections', () => {
    write({
      voice: {
        discord: {
          voiceLanguage: 'ko',
          voiceChannel: { enabled: true, listenFilter: 'caller', leaveOnEmpty: true },
        },
        telegram: { dispatch: 'auto-reply', replyMode: 'voice' },
      },
    });
    const c = buildUserConfig(cfgPath);
    expect(c.voice.discord.voiceLanguage).toBe('ko');
    expect(c.voice.discord.voiceChannel?.enabled).toBe(true);
    expect(c.voice.discord.voiceChannel?.listenFilter).toBe('caller');
    expect(c.voice.discord.voiceChannel?.leaveOnEmpty).toBe(true);
    expect(c.voice.telegram.dispatch).toBe('auto-reply');
    expect(c.voice.telegram.replyMode).toBe('voice');
  });
});

describe('user-config voice.pwa (sprint 22 §1.2 — PWA voice WS dispatch)', () => {
  test('retired voice dispatch/replyMode keys are ignored (2026-09-26 config graduation)', () => {
    write({ voice: { discord: { dispatch: 'tui-bridge', replyMode: 'voice' }, pwa: { dispatch: 'tui-bridge' } } });
    const c = buildUserConfig(cfgPath);
    expect(c.voice.discord).toEqual({});
    expect(c.voice.pwa).toEqual({});
  });

  test('default → empty object (caller applies dispatch = "daemon-direct")', () => {
    const c = buildUserConfig(cfgPath);
    expect(c.voice.pwa).toEqual({});
  });

  test('coexists with telegram + tts sub-sections', () => {
    write({
      voice: {
        tts: { auto: true },
        telegram: { replyMode: 'voice' },
      },
    });
    const c = buildUserConfig(cfgPath);
    expect(c.voice.tts.auto).toBe(true);
    expect(c.voice.telegram.replyMode).toBe('voice');
  });
});

describe('user-config voice.tts.drainCooldownMs (BACKLOG §9.5b option A)', () => {
  test('default → undefined (resolver applies VOICE_HARDCODED_DEFAULTS.ttsDrainCooldownMs = 300)', () => {
    const c = buildUserConfig(cfgPath);
    expect(c.voice.tts.drainCooldownMs).toBeUndefined();
  });

  test('valid number in range 0..2000 is preserved', () => {
    write({ voice: { tts: { drainCooldownMs: 500 } } });
    expect(buildUserConfig(cfgPath).voice.tts.drainCooldownMs).toBe(500);
    write({ voice: { tts: { drainCooldownMs: 0 } } });
    expect(buildUserConfig(cfgPath).voice.tts.drainCooldownMs).toBe(0);
    write({ voice: { tts: { drainCooldownMs: 2000 } } });
    expect(buildUserConfig(cfgPath).voice.tts.drainCooldownMs).toBe(2000);
  });

  test('out-of-range / wrong type drops the field (sparse fallback)', () => {
    write({ voice: { tts: { drainCooldownMs: -1 } } });
    expect(buildUserConfig(cfgPath).voice.tts.drainCooldownMs).toBeUndefined();
    write({ voice: { tts: { drainCooldownMs: 9999 } } });
    expect(buildUserConfig(cfgPath).voice.tts.drainCooldownMs).toBeUndefined();
    write({ voice: { tts: { drainCooldownMs: 'fast' } } });
    expect(buildUserConfig(cfgPath).voice.tts.drainCooldownMs).toBeUndefined();
  });

  test('floors fractional values', () => {
    write({ voice: { tts: { drainCooldownMs: 350.7 } } });
    expect(buildUserConfig(cfgPath).voice.tts.drainCooldownMs).toBe(350);
  });

  test('coexists with auto / maxSentenceChars in voice.tts', () => {
    write({ voice: { tts: { auto: true, maxSentenceChars: 1500, drainCooldownMs: 250 } } });
    const c = buildUserConfig(cfgPath);
    expect(c.voice.tts.auto).toBe(true);
    expect(c.voice.tts.maxSentenceChars).toBe(1500);
    expect(c.voice.tts.drainCooldownMs).toBe(250);
  });
});

describe('user-config cache', () => {
  test('getUserConfig caches same path', () => {
    write({ skillRouter: { autoRoute: true } });
    const first = getUserConfig(cfgPath);
    const second = getUserConfig(cfgPath);
    expect(second).toBe(first);
  });

  test('reloadUserConfig picks up on-disk changes', () => {
    write({ skillRouter: { autoRoute: false } });
    expect(getUserConfig(cfgPath).skillRouter.autoRoute).toBe(false);
    // Phase 4: external rewrites invalidate the cache via mtime check.
    // Bump mtime forward to defeat sub-millisecond timing on fast hosts —
    // see test/user-config-cache-invalidation.test.ts for the dedicated
    // suite covering this contract.
    write({ skillRouter: { autoRoute: true } });
    require('node:fs').utimesSync(cfgPath, Date.now() / 1000 + 5, Date.now() / 1000 + 5);
    expect(getUserConfig(cfgPath).skillRouter.autoRoute).toBe(true);
    const fresh = reloadUserConfig(cfgPath);
    expect(fresh.skillRouter.autoRoute).toBe(true);
    expect(getUserConfig(cfgPath).skillRouter.autoRoute).toBe(true);
  });

  test('resetUserConfig forces next getUserConfig to rebuild', () => {
    write({ skillRouter: { autoRoute: true } });
    getUserConfig(cfgPath);
    resetUserConfig();
    write({ skillRouter: { autoRoute: false } });
    expect(getUserConfig(cfgPath).skillRouter.autoRoute).toBe(false);
  });
});

describe('provider rotation helpers', () => {
  const rotModule = require('../src/user-config');
  const {
    rotateNextProvider, jumpToRotationEntry, addRotationEntry,
    removeRotationEntry, rotationEntryLabel, currentRotationIndex,
  } = rotModule;

  // Minimal shape for the helpers — they only read cfg.llm.
  const cfgWith = (rotation: any[], provider: string = 'anthropic', model: string = 'claude-opus-4-6'): any => ({
    llm: { provider, model, rotation },
  });

  test('rotateNextProvider: empty rotation → no-op (entry=null)', () => {
    const cfg = cfgWith([]);
    const { entry } = rotateNextProvider(cfg);
    expect(entry).toBeNull();
  });

  test('rotateNextProvider: advances through N entries then wraps', () => {
    const cfg = cfgWith([
      { provider: 'anthropic', model: 'claude-opus-4-6', label: 'opus' },
      { provider: 'openai-codex', model: 'gpt-5.4', label: 'codex' },
      { provider: 'grok', model: 'grok-4.20', label: 'grok' },
    ], 'anthropic', 'claude-opus-4-6');
    const step1 = rotateNextProvider(cfg);
    expect(step1.entry.label).toBe('codex');
    expect(step1.cfg.llm.provider).toBe('openai-codex');
    const step2 = rotateNextProvider(step1.cfg);
    expect(step2.entry.label).toBe('grok');
    const step3 = rotateNextProvider(step2.cfg);
    expect(step3.entry.label).toBe('opus');
  });

  test('rotateNextProvider: current not in list → starts from index 0', () => {
    const cfg = cfgWith([
      { provider: 'openai-codex', model: 'gpt-5.4', label: 'codex' },
      { provider: 'grok', model: 'grok-4.20', label: 'grok' },
    ], 'anthropic', 'claude-haiku-4-5');
    const { entry } = rotateNextProvider(cfg);
    expect(entry.label).toBe('codex');
  });

  test('jumpToRotationEntry: exact label', () => {
    const cfg = cfgWith([
      { provider: 'anthropic', label: 'opus' },
      { provider: 'grok', label: 'grok' },
    ]);
    const { entry } = jumpToRotationEntry(cfg, 'grok');
    expect(entry.provider).toBe('grok');
  });

  test('jumpToRotationEntry: model substring fallback', () => {
    const cfg = cfgWith([
      { provider: 'anthropic', model: 'claude-opus-4-6' },
      { provider: 'openai-codex', model: 'gpt-5.4' },
    ]);
    const { entry } = jumpToRotationEntry(cfg, 'gpt-5');
    expect(entry.provider).toBe('openai-codex');
  });

  test('jumpToRotationEntry: no match → null', () => {
    const cfg = cfgWith([{ provider: 'grok', model: 'grok-4.20' }]);
    const { entry } = jumpToRotationEntry(cfg, 'nonexistent');
    expect(entry).toBeNull();
  });

  test('addRotationEntry: dedup by label', () => {
    const cfg = cfgWith([{ provider: 'anthropic', label: 'opus' }]);
    const next = addRotationEntry(cfg, { provider: 'anthropic', label: 'opus' });
    expect(next.llm.rotation).toHaveLength(1);
  });

  test('removeRotationEntry: removes matching label', () => {
    const cfg = cfgWith([
      { provider: 'anthropic', label: 'opus' },
      { provider: 'grok', label: 'grok' },
    ]);
    const { removed, cfg: next } = removeRotationEntry(cfg, 'opus');
    expect(removed.label).toBe('opus');
    expect(next.llm.rotation).toHaveLength(1);
  });

  test('rotationEntryLabel: fallback chain', () => {
    expect(rotationEntryLabel({ provider: 'grok', model: 'grok-4.20', label: 'custom' })).toBe('custom');
    expect(rotationEntryLabel({ provider: 'grok', model: 'grok-4.20' })).toBe('grok:grok-4.20');
    expect(rotationEntryLabel({ provider: 'grok' })).toBe('grok');
  });

  test('currentRotationIndex: matches (provider, model) pair', () => {
    const cfg = cfgWith([
      { provider: 'anthropic', model: 'claude-opus-4-6' },
      { provider: 'grok', model: 'grok-4.20' },
    ], 'grok', 'grok-4.20');
    expect(currentRotationIndex(cfg)).toBe(1);
  });
});

// ── Bundle 2' · secrets-bearing config locked to owner-only (2026-04-27) ──
//
// saveUserConfig used to chmod 600 only when telegram.botToken was set.
// Bundle 2' generalizes that: the config also carries llm.apiKey and
// (future) discord.botToken, plus personal preferences (skill paths,
// vault path) the user wouldn't want world-readable on a shared box.
// On Windows chmod is a no-op (best-effort) — we skip the assertion.
describe('user-config chmod 600 (Bundle 2\')', () => {
  const isWindows = process.platform === 'win32';

  test('saveUserConfig writes 0o600 even without secrets', () => {
    const cfg = buildUserConfig(cfgPath);
    saveUserConfig(cfg, cfgPath);
    if (isWindows) return;
    const mode = statSync(cfgPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('saveUserConfig writes 0o600 when llm.apiKey present', () => {
    const cfg = buildUserConfig(cfgPath);
    cfg.llm.apiKey = 'sk-test-secret';
    saveUserConfig(cfg, cfgPath);
    if (isWindows) return;
    const mode = statSync(cfgPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('saveUserConfig writes 0o600 when telegram.botToken present', () => {
    const cfg = buildUserConfig(cfgPath);
    cfg.telegram.botToken = '12345:ABC';
    saveUserConfig(cfg, cfgPath);
    if (isWindows) return;
    const mode = statSync(cfgPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('discord.sprint21 — retired (설정 졸업 2 · 2026-09-26)', () => {
  test('a leftover sprint21 block is not loaded and is saved away', () => {
    write({ discord: { botToken: 't', sprint21: { enabled: true, appId: '111' } } });
    const cfg = buildUserConfig(cfgPath);
    expect('sprint21' in cfg.discord).toBe(false);
    saveUserConfig(cfg, cfgPath);
    const text = require('node:fs').readFileSync(cfgPath, 'utf8');
    expect(text).not.toContain('sprint21');
  });
});

describe('tools.nativeStructure', () => {
  test('missing file defaults enabled to false', () => {
    expect(buildUserConfig(cfgPath).tools.nativeStructure.enabled).toBe(false);
  });

  test('explicit true is preserved alongside existing tool settings', () => {
    write({ tools: { nativeStructure: { enabled: true }, agentSpawn: { hopCap: 3 } } });
    const config = buildUserConfig(cfgPath);
    expect(config.tools.nativeStructure.enabled).toBe(true);
    expect(config.tools.agentSpawn.hopCap).toBe(3);
  });

  test.each([['missing', undefined], ['string', 'true'], ['number', 1], ['object', {}], ['array', []]])('invalid enabled value %s falls back to false', (_name, enabled) => {
    write({ tools: { nativeStructure: { enabled } } });
    expect(buildUserConfig(cfgPath).tools.nativeStructure.enabled).toBe(false);
  });
});

// ⛔ 이 절이 왜 있나 — 리뷰 should-fix: 오버레이 테스트는 «실제 파싱»을 우회한다.
//    그래서 기본 OFF·설정 반영·비정상 값 처리를 여기서 «파일로» 직접 잰다.
describe('tools.selfImplement.clarificationEscalation', () => {
  test('파일이 없으면 꺼져 있고 timeoutMs 는 «없다»', () => {
    const c = buildUserConfig(cfgPath);
    expect(c.tools.selfImplement.clarificationEscalation.enabled).toBe(false);
    // ⛔ 기본값 숫자를 두지 않는다 — 근거 없이 고른 수는 아무도 다시 안 잰다.
    expect(c.tools.selfImplement.clarificationEscalation.timeoutMs).toBeUndefined();
  });

  test('유효한 값이면 그대로 반영된다', () => {
    write({ tools: { selfImplement: { clarificationEscalation: { enabled: true, timeoutMs: 30_000 } } } });
    const c = buildUserConfig(cfgPath);
    expect(c.tools.selfImplement.clarificationEscalation.enabled).toBe(true);
    expect(c.tools.selfImplement.clarificationEscalation.timeoutMs).toBe(30_000);
  });

  test('enabled 만 켜고 timeoutMs 가 없으면 timeoutMs 는 «생기지 않는다»', () => {
    write({ tools: { selfImplement: { clarificationEscalation: { enabled: true } } } });
    const c = buildUserConfig(cfgPath);
    expect(c.tools.selfImplement.clarificationEscalation.enabled).toBe(true);
    expect(c.tools.selfImplement.clarificationEscalation.timeoutMs).toBeUndefined();
  });

  test.each([
    ['0 < v < 1 은 정수화하면 0 이라 거부', 0.5],
    ['0 거부', 0],
    ['음수 거부', -5],
    ['NaN 거부', Number.NaN],
    ['Infinity 거부', Number.POSITIVE_INFINITY],
    ['문자열 거부', '30000'],
  ])('%s', (_name, value) => {
    write({ tools: { selfImplement: { clarificationEscalation: { enabled: true, timeoutMs: value } } } });
    const c = buildUserConfig(cfgPath);
    expect(c.tools.selfImplement.clarificationEscalation.timeoutMs).toBeUndefined();
  });

  test('setTimeout 32-bit 상한을 넘으면 «거부»한다 — 즉시 만료가 되기 때문', () => {
    write({ tools: { selfImplement: { clarificationEscalation: { enabled: true, timeoutMs: 2_147_483_648 } } } });
    expect(buildUserConfig(cfgPath).tools.selfImplement.clarificationEscalation.timeoutMs).toBeUndefined();
  });

  test('상한 «경계값»은 살린다', () => {
    write({ tools: { selfImplement: { clarificationEscalation: { enabled: true, timeoutMs: 2_147_483_647 } } } });
    expect(buildUserConfig(cfgPath).tools.selfImplement.clarificationEscalation.timeoutMs).toBe(2_147_483_647);
  });

  test('소수는 «내림»한다 — 1 이상이면 살린다', () => {
    write({ tools: { selfImplement: { clarificationEscalation: { enabled: true, timeoutMs: 1500.9 } } } });
    expect(buildUserConfig(cfgPath).tools.selfImplement.clarificationEscalation.timeoutMs).toBe(1500);
  });
});

// ⛔⭐ 리뷰 must-fix ② — 「malformed config 에서 실제로 폴백하는가」를 «진짜 파서»로 문다.
//    종전 테스트는 seam 에 값을 «주입»해서, 파싱 배선을 지워도 통과했다(Goodhart).
//    이 블록은 config 파일을 실제로 써서 로더를 통과시킨다 ⇒ 정규화를 지우면 «실패한다».
describe('acp.reviewBackend — 실제 파싱과 폴백', () => {
  test('문자열이면 그대로 실린다', () => {
    write({ acp: { reviewBackend: 'codex' } });
    expect(buildUserConfig(cfgPath).acp.reviewBackend).toBe('codex');
  });

  test('앞뒤 공백은 다듬어진다', () => {
    write({ acp: { reviewBackend: '  codex  ' } });
    expect(buildUserConfig(cfgPath).acp.reviewBackend).toBe('codex');
  });

  // ⭐ 아래 넷이 「폴백해야 하는」 모양이다 — 값이 «없어야» 소비자가 DEFAULT_REVIEW_BACKEND 로 간다.
  test('빈 문자열·공백뿐이면 «없음»이다', () => {
    write({ acp: { reviewBackend: '' } });
    expect(buildUserConfig(cfgPath).acp.reviewBackend).toBeUndefined();
    resetUserConfig();
    write({ acp: { reviewBackend: '   ' } });
    expect(buildUserConfig(cfgPath).acp.reviewBackend).toBeUndefined();
  });

  test('문자열이 아니면 «없음»이다 (숫자·객체·null)', () => {
    for (const bad of [42, { id: 'codex' }, null, ['codex']]) {
      resetUserConfig();
      write({ acp: { reviewBackend: bad } });
      expect(buildUserConfig(cfgPath).acp.reviewBackend).toBeUndefined();
    }
  });

  test('acp 절 자체가 깨져 있어도 기동이 멈추지 않고 «없음»이다', () => {
    write({ acp: 'not-an-object' });
    expect(buildUserConfig(cfgPath).acp.reviewBackend).toBeUndefined();
  });
});
