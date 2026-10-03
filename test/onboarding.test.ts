// ── Onboarding wizard tests ──
//
// Drives the wizard via scriptedIO — a stubbed WizardIO that serves
// prompts from a queue and captures all output. We assert:
//   1. The resulting on-disk config.json matches our script choices.
//   2. Defaults are honored when the user just hits enter.
//   3. Unknown preset numbers fall back to safe picks.
//   4. markOnboardingComplete fires (onboarding.completed = true).
//   5. Telegram can be skipped cleanly.

import { setDefaultTimeout, describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOnboarding, runOnboardingStep, scriptedIO, needsOnboarding, resetOnboardingMarker, shouldRefuseInteractiveOnboarding } from '../src/onboarding';
import { CODEX_MODELS } from '../src/codex/models';
import { buildUserConfig, resetUserConfig } from '../src/user-config';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

// Onboarding now detects real subscription logins (OB1); scripted tests pin «nothing detected».
const NO_SUBSCRIPTION_DETECT = { detectProviders: async () => [], hasCodexCliLogin: () => false };

let root: string;
let cfgPath: string;

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'onboarding-'));
  cfgPath = join(root, 'config.json');
  resetUserConfig();
  // Isolate the OAuth token store so the wizard's "keep existing tokens?"
  // probe doesn't pick up the user's real ~/.config/elanous/auth.json.
  savedEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  savedEnv.CODEX_HOME = process.env.CODEX_HOME;
  savedEnv.XAI_API_KEY = process.env.XAI_API_KEY;
  process.env.XDG_CONFIG_HOME = root;
  process.env.CODEX_HOME = join(root, 'codex-home');
  delete process.env.XAI_API_KEY;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  resetUserConfig();
  if (savedEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  if (savedEnv.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedEnv.CODEX_HOME;
  if (savedEnv.XAI_API_KEY === undefined) delete process.env.XAI_API_KEY;
  else process.env.XAI_API_KEY = savedEnv.XAI_API_KEY;
});

type SkillsStepResult = {
  activeSet: string;
  dirs: string[];
  outputs: string[];
};

const skillsStepScript = `
  import { runOnboardingStep, scriptedIO } from './src/onboarding.ts';
  const io = scriptedIO(JSON.parse(process.env.ONBOARDING_SKILL_INPUTS));
  const cfg = await runOnboardingStep('skills', { io, path: process.env.ONBOARDING_SKILL_CONFIG });
  console.log(JSON.stringify({ activeSet: cfg.skills.activeSet, dirs: cfg.skills.dirs, outputs: io.outputs }));
`;

async function runSkillsStepInHome(home: string, inputs: string[]): Promise<SkillsStepResult> {
  const proc = Bun.spawn(['bun', '-e', skillsStepScript], {
    cwd: join(import.meta.dir, '..'),
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, 'config'),
      CODEX_HOME: join(home, 'codex-home'),
      ONBOARDING_SKILL_CONFIG: join(home, 'config.json'),
      ONBOARDING_SKILL_INPUTS: JSON.stringify(inputs),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
  ]);
  expect(exitCode).toBe(0);
  return JSON.parse(stdout) as SkillsStepResult;
}

describe('skills onboarding warnings', () => {
  test('preset with an existing directory emits no missing-directory warning', async () => {
    const home = mkdtempSync(join(tmpdir(), 'onboarding-skills-preset-existing-'));
    const presetDir = join(home, '.claude', 'skills');
    mkdirSync(presetDir, { recursive: true });
    try {
      const result = await runSkillsStepInHome(home, ['1']);
      expect(result.activeSet).toBe('claudecode');
      expect(result.dirs).toEqual([presetDir]);
      expect(result.outputs.join('\n')).not.toContain('does not exist yet — keeping anyway; create it later');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('preset with a missing directory warns without creating it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'onboarding-skills-preset-missing-'));
    const presetDir = join(home, '.claude', 'skills');
    try {
      const result = await runSkillsStepInHome(home, ['1']);
      expect(result.activeSet).toBe('claudecode');
      expect(result.dirs).toEqual([presetDir]);
      expect(result.outputs.join('\n')).toContain(`(warn: "${presetDir}" does not exist yet — keeping anyway; create it later)`);
      expect(existsSync(presetDir)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('custom with a missing directory preserves the keeping-anyway warning', async () => {
    const home = mkdtempSync(join(tmpdir(), 'onboarding-skills-custom-missing-'));
    const customDir = join(home, 'custom-skills');
    try {
      const result = await runSkillsStepInHome(home, ['6', customDir]);
      expect(result.activeSet).toBe('custom');
      expect(result.dirs).toEqual([customDir]);
      expect(result.outputs.join('\n')).toContain(`(warn: "${customDir}" does not exist yet — keeping anyway; create it later)`);
      expect(existsSync(customDir)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('interactive onboarding refusal', () => {
  test('refuses exactly the uninjected non-TTY combinations and keeps injected IO allowed', () => {
    expect(shouldRefuseInteractiveOnboarding({ ioInjected: false, ctx: 'production', stdinIsTTY: false })).toBe(true);
    expect(shouldRefuseInteractiveOnboarding({ ioInjected: true, ctx: 'production', stdinIsTTY: false })).toBe(false);
    expect(shouldRefuseInteractiveOnboarding({ ioInjected: false, ctx: 'production', stdinIsTTY: true })).toBe(false);
    expect(shouldRefuseInteractiveOnboarding({ ioInjected: true, ctx: 'production', stdinIsTTY: true })).toBe(false);
  });

  test('keeps autonomous contexts refused even when stdin is a TTY', () => {
    expect(shouldRefuseInteractiveOnboarding({ ioInjected: false, ctx: 'self-build', stdinIsTTY: true })).toBe(true);
    expect(shouldRefuseInteractiveOnboarding({ ioInjected: false, ctx: 'benchmark', stdinIsTTY: true })).toBe(true);
  });

  test('per-step injected IO bypasses the non-TTY guard', async () => {
    const io = scriptedIO(['1']);
    const cfg = await runOnboardingStep('skills', { io, path: cfgPath });
    expect(cfg.skills.activeSet).toBe('claudecode');
    expect(existsSync(cfgPath)).toBe(true);
  });

  test('piped setup refuses before prompting or saving config', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'onboarding-piped-cli-'));
    try {
      const proc = Bun.spawn(['bun', 'bin/elanous.mjs', '--test', 'setup'], {
        cwd: join(import.meta.dir, '..'),
        env: {
          ...process.env,
          HOME: stateRoot,
          XDG_CONFIG_HOME: join(stateRoot, 'config'),
          ELANOUS_STATE_DIR: join(stateRoot, 'state'),
          ELANOUS_SUPPRESS_XDG_WARNING: '1',
          PATH: process.env.PATH ?? '',
        },
        stdin: new TextEncoder().encode('3\nxai-1234567890abcdef\n'),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(code).not.toBe(0);
      expect(`${stdout}\n${stderr}`).toContain('대화형 온보딩은 stdin TTY가 있는 자리에서만 실행할 수 있다. 무인 설정은 `elanous setup --non-interactive`를 사용하라.');
      expect(existsSync(join(stateRoot, '.elanous-test', 'config.json'))).toBe(false);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('onboarding wizard', () => {
  test('openai-codex provider (API-key mode) + opencode skills + obsidian + telegram off', async () => {
    const skillDir = join(root, 'skills-a');
    mkdirSync(skillDir);
    const vault = join(root, 'vault');
    mkdirSync(vault);
    const customModelPickerKey = String(CODEX_MODELS.length + 1);
    const io = scriptedIO([
      // Step 1 — LLM
      '1',                    // pick "OpenAI Codex"
      '2',                    // codex auth mode: API key (OAuth skipped in tests)
      'sk-test-codex-1234567890abcdef',  // API key (PR-Δ14: validateApiKey min 16 chars)
      customModelPickerKey,   // Custom model ID option follows the current catalog
      'codex-mini-latest',
      // Step 2 — Skills: pick claudecode (index 1, preset's canonical dir
      // auto-attaches; Sprint 10b removed the multi-dir prompt)
      '1',
      // Step 3 — Obsidian
      vault,
      // Step 4 — 텔레그램: no
      'n',
      // Step 5 — Discord: no
      'n',
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);

    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath });
    expect(cfg.llm.provider).toBe('openai-codex');
    expect(cfg.llm.apiKey).toBe('sk-test-codex-1234567890abcdef');
    expect(cfg.llm.model).toBe('codex-mini-latest');
    expect(cfg.skills.activeSet).toBe('claudecode');
    // Sprint 10b — single dir from the chosen preset (claudecode dir).
    // The test no longer threads a custom skillDir; the user-supplied
    // path test lives in the next case.
    expect(cfg.obsidian.vault).toBe(vault);
    expect(cfg.telegram.enabled).toBe(false);
    expect(cfg.onboarding.completed).toBe(true);
    expect(existsSync(cfgPath)).toBe(true);

    // Reload from disk to prove persistence
    const reloaded = buildUserConfig(cfgPath);
    expect(reloaded.llm.provider).toBe('openai-codex');
    expect(reloaded.telegram.enabled).toBe(false);
    expect(reloaded.onboarding.completed).toBe(true);
  });

  test('local provider + custom skill dir + telegram enabled', async () => {
    const skillDir1 = join(root, 's1');
    mkdirSync(skillDir1);
    const vault = join(root, 'vault2');
    mkdirSync(vault);
    const io = scriptedIO([
      // Step 1 — LLM: local (index 2)
      '2',
      'llama3',                        // model
      'http://localhost:11434/v1',     // baseUrl
      '2',                             // Step 1 — Answer depth: Balanced default
      // Step 2 — Skills: custom (index 6) with one dir (Sprint 10b — single)
      '6',
      skillDir1,
      // Step 3 — Obsidian
      vault,
      // Step 4 — 텔레그램: yes
      'y',
      '12345:ABCDEF',     // bot token
      '111, 222, 333',    // allowed users
      '-1009988',         // home channel
      // Step 5 — Discord: no
      'n',
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);

    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath,
      telegramDeps: { validateToken: false },
      // Bundle 1' · stub local probe to 0 models so the wizard falls
      // through to the manual model + baseUrl prompts that this test
      // scripts (preserves the legacy path semantics).
      localProbeDeps: { probe: async () => [] },
    });
    expect(cfg.llm.provider).toBe('local');
    expect(cfg.llm.model).toBe('llama3');
    expect(cfg.llm.baseUrl).toBe('http://localhost:11434/v1');
    expect(cfg.skills.activeSet).toBe('custom');
    expect(cfg.skills.dirs).toEqual([skillDir1]);
    expect(cfg.obsidian.vault).toBe(vault);
    expect(cfg.telegram.enabled).toBe(true);
    expect(cfg.telegram.botToken).toBe('12345:ABCDEF');
    expect(cfg.telegram.allowedUsers).toEqual([111, 222, 333]);
    expect(cfg.telegram.homeChannel).toBe(-1009988);
  });

  // ── Bundle 1' · local provider auto-probe (2026-04-27) ─────────────

  test('local provider — auto-detected single model from probe', async () => {
    // 1 model found → auto-select, no model/baseUrl prompts.
    const io = scriptedIO([
      '2',          // LLM: local
      // (no model/baseUrl — auto-selected from probe)
      '1',          // Skills: opencode preset
      '',           // no extra dirs
      '',           // Obsidian default
      'n',          // Telegram off
      'n',          // Discord off
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath,
      localProbeDeps: {
        probe: async () => [{
          id: 'llama3.2',
          label: 'Llama 3.2',
          runtime: 'ollama',
          nodeId: 'local',
          baseUrl: 'http://localhost:11434/v1',
        }],
      },
    });
    expect(cfg.llm.provider).toBe('local');
    expect(cfg.llm.model).toBe('llama3.2');
    expect(cfg.llm.baseUrl).toBe('http://localhost:11434/v1');
    // Auto-select prompt should appear in the captured outputs.
    expect(io.outputs.join('\n')).toMatch(/Auto-selected: Llama 3\.2/);
  });

  test('local provider — picker shown for 2+ models', async () => {
    // 2 models → numbered picker; user picks #2.
    const io = scriptedIO([
      '2',          // LLM: local
      '2',          // pick model #2 (Mistral 7B)
      '1',          // Skills: opencode preset
      '',           // no extra dirs
      '',           // Obsidian default
      'n',          // Telegram off
      'n',          // Discord off
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath,
      localProbeDeps: {
        probe: async () => [
          { id: 'llama3.2', label: 'Llama 3.2', runtime: 'ollama', nodeId: 'local', baseUrl: 'http://localhost:11434/v1' },
          { id: 'mistral-7b', label: 'Mistral 7B', runtime: 'lmstudio', nodeId: 'local', baseUrl: 'http://localhost:1234/v1' },
        ],
      },
    });
    expect(cfg.llm.provider).toBe('local');
    expect(cfg.llm.model).toBe('mistral-7b');
    expect(cfg.llm.baseUrl).toBe('http://localhost:1234/v1');
    expect(io.outputs.join('\n')).toMatch(/2 models found/);
  });

  test('local provider — picker default (blank) lands on first model', async () => {
    // Blank input on the picker = idx 1 (matches existing wizard
    // convention where blank means default).
    const io = scriptedIO([
      '2',          // LLM: local
      '',           // pick → blank = idx 1
      '1',          // Skills
      '',           // no extras
      '',           // Obsidian
      'n',          // Telegram off
      'n',          // Discord off
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath,
      localProbeDeps: {
        probe: async () => [
          { id: 'llama3.2', label: 'Llama 3.2', runtime: 'ollama', nodeId: 'local', baseUrl: 'http://localhost:11434/v1' },
          { id: 'mistral-7b', label: 'Mistral 7B', runtime: 'lmstudio', nodeId: 'local', baseUrl: 'http://localhost:1234/v1' },
        ],
      },
    });
    expect(cfg.llm.model).toBe('llama3.2');
    expect(cfg.llm.baseUrl).toBe('http://localhost:11434/v1');
  });

  test('local provider — 0 models falls through to manual entry', async () => {
    const io = scriptedIO([
      '2',                              // LLM: local
      'custom-model',                   // model (manual fallback)
      'http://my-rig.local:8080/v1',    // baseUrl (manual fallback)
      '1',                              // Skills
      '',                               // no extras
      '',                               // Obsidian
      'n',                              // Telegram off
      'n',                              // Discord off
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath,
      localProbeDeps: { probe: async () => [] },
    });
    expect(cfg.llm.provider).toBe('local');
    expect(cfg.llm.model).toBe('custom-model');
    expect(cfg.llm.baseUrl).toBe('http://my-rig.local:8080/v1');
    expect(io.outputs.join('\n')).toMatch(/No local LLM detected/);
  });

  test('local provider — probe error falls through to manual entry', async () => {
    // A flaky probe (network blip / SSH timeout) shouldn't kill the
    // wizard — we print the error and let the user enter manually.
    const io = scriptedIO([
      '2',                              // LLM: local
      'rescue-model',                   // model (manual fallback)
      'http://localhost:11434/v1',      // baseUrl (manual fallback)
      '1',                              // Skills
      '',                               // no extras
      '',                               // Obsidian
      'n',                              // Telegram off
      'n',                              // Discord off
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath,
      localProbeDeps: {
        probe: async () => { throw new Error('probe blew up'); },
      },
    });
    expect(cfg.llm.provider).toBe('local');
    expect(cfg.llm.model).toBe('rescue-model');
    expect(io.outputs.join('\n')).toMatch(/probe failed: probe blew up/);
  });

  test('all-default path with no subscription detected → ChatGPT/Codex is preselected (OB1), not env-only auto', async () => {
    // OB1 (10-01): the old default was «Auto-detect (env vars)», so a subscriber pressing Enter got nothing.
    const io = scriptedIO([
      '',          // LLM: default → OpenAI Codex (no subscription detected)
      '3',         // Codex auth: skip (no network in tests)
      '',          // Codex model: default
      '',          // Skills: default
      '',          // no extra dirs
      '',          // Obsidian: default vault
      'n',         // 텔레그램: no
      'n',         // Discord: no
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath });
    expect(cfg.llm.provider).toBe('openai-codex');
    expect(cfg.telegram.enabled).toBe(false);
    expect(cfg.onboarding.completed).toBe(true);
  });

  test('a detected Grok subscription is preselected and announced (OB1)', async () => {
    const printed: string[] = [];
    let llmDefault: number | undefined;
    const io = scriptedIO([]);
    const capture: typeof io = {
      ...io,
      print: (line: string) => { printed.push(line); },
      choose: async (_prompt, choices, opts, stepId) => {
        if (stepId === 'llm') { llmDefault = opts?.defaultIndex; throw new Error('stop-after-llm-pick'); }
        return choices[opts?.defaultIndex ?? 0]!.value;
      },
    };
    await runOnboarding({
      grokDeps: { detectProviders: async () => [{ provider: 'grok', auth: 'oauth', source: 'grok-auth', available: true, rank: 1 }], hasCodexCliLogin: () => false },
      io: capture, path: cfgPath,
    }).catch((error: Error) => { if (!String(error.message).includes('stop-after-llm-pick')) throw error; });
    expect(printed.some(line => line.includes('Found Grok subscription') && line.includes('~/.grok/auth.json'))).toBe(true);
    expect(llmDefault).toBe(2); // 3) Grok (xAI) — zero-based index 2
  });

  test('auto provider skips api key / model prompts', async () => {
    const io = scriptedIO([
      '10',        // LLM = auto (index 7 after Gemini added)
      '1',        // Skills = opencode
      '',         // no extras
      '',         // Obsidian default
      'n',        // Telegram off
      'n',        // Discord off
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath });
    expect(cfg.llm.provider).toBe('auto');
    expect(cfg.llm.apiKey).toBeUndefined();
    expect(cfg.llm.model).toBeUndefined();
  });

  test('needsOnboarding true before, false after', async () => {
    const before = buildUserConfig(cfgPath);
    expect(needsOnboarding(before)).toBe(true);

    const io = scriptedIO([
      '10', // Step 1 — LLM: auto
      '1',  // Step 2 — Skills: claudecode
      '',   // Step 2 — Skills: no extra directories
      '',   // Step 3 — Obsidian: default vault
      'n',  // Step 4 — 텔레그램: disabled
      'n',  // Step 5 — Discord: disabled
      '1',  // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath });
    expect(needsOnboarding(cfg)).toBe(false);
  });

  test('post-save continue-here reuses daemon endpoint, 24h phone link and optional QR without exposing tokens in debug', async () => {
    const { debug } = await import('../src/debug/log');
    const logged: unknown[][] = [];
    const logSpy = spyOn(debug, 'log').mockImplementation((...args) => { logged.push(args); });
    const qrCalls: string[] = [];
    const token = 'elt_test+secret/for-encoding';
    const io = scriptedIO(['10', '1', root, 'n', 'n', '1']);
    try {
      await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath, continueHereDeps: {
        probeTailscale: async () => ({ installed: true, alive: true, magicDnsHost: 'mbp.tailnet-example.ts.net', hostname: 'mbp' }),
        showNexus: async () => ({ status: 'unregistered', urls: {
          pwa: { loopback: 'http://127.0.0.1:31415/app/', tailnet: 'https://machine.ts.net/app/' },
          rest: { loopback: 'http://127.0.0.1:31415/v1/', tailnet: 'https://machine.ts.net/v1/' },
          sse: { loopback: 'http://127.0.0.1:31415/v1/events' },
        } }),
        issueToken: () => ({ token }),
        renderQr: (link) => { qrCalls.push(link); return 'QR IMAGE'; },
      } });
      const link = qrCalls[0]!;
      expect(link).toStartWith('elanous://connect?');
      expect(new URL(link).searchParams.get('host')).toBe('machine.ts.net');
      expect(new URL(link).searchParams.get('tls')).toBe('1');
      expect(new URL(link).searchParams.get('token')).toBe(token);
      const output = io.outputs.join('\n');
      expect(output).toContain('브라우저: https://machine.ts.net/app/');
      expect(output).toContain('  어디서든(Tailscale): `elanous nexus pwa share enable` → https://mbp.tailnet-example.ts.net/app/');
      expect(output).toContain(`폰: ${link}`);
      expect(output).toContain('QR IMAGE');
      expect(io.outputs.filter(line => line.includes(link))).toEqual([`  폰: ${link}`]);
      expect(logged).toContainEqual(['onboarding.tailscale', 'probed', { installed: true, alive: true, offered: true }]);
      expect(logged).toContainEqual(['onboarding.continue-here', 'phone-link-issued', { kind: 'tailnet', tls: true, temp: true }]);
      expect(logged).toContainEqual(['onboarding.continue-here', 'shown', { daemonRunning: true, interactive: true, phoneLinkIssued: true, telegramEnabled: false }]);
      expect(JSON.stringify(logged)).not.toContain(token);
      expect(JSON.stringify(logged)).not.toContain('elanous://connect');
      expect(JSON.stringify(logged)).not.toContain('mbp.tailnet-example.ts.net');
      expect(buildUserConfig(cfgPath).onboarding.completed).toBe(true);
    } finally { logSpy.mockRestore(); }
  });

  test('post-save absent daemon keeps start/browser/phone commands and never issues a token', async () => {
    const io = scriptedIO(['10', '1', root, 'n', 'n', '1']);
    let issued = 0;
    let rendered = 0;
    await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath, continueHereDeps: {
      showNexus: async () => ({ status: 'absent' }),
      probeTailscale: async () => ({ installed: true, alive: false, hostname: 'mbp' }),
      issueToken: () => { issued++; return { token: 'elt_no_daemon' }; },
      renderQr: () => { rendered++; return 'QR IMAGE'; },
    } });
    const output = io.outputs.join('\n');
    expect(output).toContain('데몬 켜기: `elanous nexus run`');
    expect(output).toContain('브라우저: `elanous nexus show`');
    expect(output).toContain('폰: `elanous phone link --temp --ttl 24h`');
    expect(output).not.toContain('어디서든(Tailscale)');
    expect(output).not.toContain('elt_no_daemon');
    expect(issued).toBe(0);
    expect(rendered).toBe(0);
  });

  test('post-save Tailscale offer requires installed, alive and a host', async () => {
    for (const status of [
      { installed: false, alive: true, magicDnsHost: 'mbp.tailnet-example.ts.net' },
      { installed: true, alive: false, magicDnsHost: 'mbp.tailnet-example.ts.net' },
    ]) {
      const io = scriptedIO(['10', '1', root, 'n', 'n', '1']);
      await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath, continueHereDeps: {
        showNexus: async () => ({ status: 'absent' }),
        probeTailscale: async () => status,
      } });
      expect(io.outputs.join('\n')).not.toContain('어디서든(Tailscale)');
    }
  });

  test('post-save Tailscale probe failure or timeout silently omits the offer', async () => {
    for (const probeTailscale of [
      async () => { throw new Error('probe failed'); },
      () => new Promise<never>(() => {}),
    ]) {
      const io = scriptedIO(['10', '1', root, 'n', 'n', '1']);
      await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath, continueHereDeps: {
        showNexus: async () => ({ status: 'absent' }),
        probeTailscale,
      } });
      const output = io.outputs.join('\n');
      expect(output).toContain('브라우저: `elanous nexus show`');
      expect(output).not.toContain('어디서든(Tailscale)');
      expect(output).not.toContain('probe failed');
    }
  }, 10_000);

  test('post-save Tailscale without MagicDNS offers the command but no hostname URL', async () => {
    const io = scriptedIO(['10', '1', root, 'n', 'n', '1']);
    await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath, continueHereDeps: {
      showNexus: async () => ({ status: 'absent' }),
      probeTailscale: async () => ({ installed: true, alive: true, hostname: 'mbp' }),
    } });
    expect(io.outputs).toContain('  어디서든(Tailscale): `elanous nexus pwa share enable`');
    expect(io.outputs.join('\n')).not.toContain('https://mbp/');
  });

  test('scripted IO captures prompts for debugging', async () => {
    const io = scriptedIO([
      '10', // Step 1 — LLM: auto
      '1',  // Step 2 — Skills: claudecode
      '',   // Step 2 — Skills: no extra directories
      '',   // Step 3 — Obsidian: default vault
      'n',  // Step 4 — 텔레그램: disabled
      'n',  // Step 5 — Discord: disabled
      '1',  // Step 6 — Voice & AI: Smart defaults
    ]);
    await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath });
    const prompts = io.outputs.join('\n');
    // The scripted wizard runs six configuration steps; the seventh slot
    // is reserved for the interactive-only wrap-up recap.
    expect(prompts).toMatch(/Step 1 \/ 7/);
    expect(prompts).toMatch(/Step 2 \/ 7/);
    expect(prompts).toMatch(/Step 3 \/ 7/);
    expect(prompts).toMatch(/Step 4 \/ 7/);
    expect(prompts).toMatch(/Step 5 \/ 7/);
    expect(prompts).toMatch(/Step 6 \/ 7/);
    expect(prompts).toMatch(/Setup complete/);
  });

  test('telegram validateToken=true calls /getMe and shows @username', async () => {
    const vault = join(root, 'vault-tg-validate');
    mkdirSync(vault);
    const fetchCalls: string[] = [];
    const fakeFetch: any = async (url: string) => {
      fetchCalls.push(url);
      return { json: async () => ({ ok: true, result: { id: 77, username: 'elanoustestbot' } }) };
    };
    const io = scriptedIO([
      '10',                     // llm: auto
      '1', '',                 // skills: opencode, no extras
      vault,                   // obsidian
      'y',                     // telegram: yes
      '12345:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef',  // valid-shape token
      '111,222',               // allowed users
      '',                      // no home channel
      'n',                     // discord: no
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath,
      telegramDeps: { validateToken: true, fetchImpl: fakeFetch },
    });
    expect(cfg.telegram.enabled).toBe(true);
    expect(cfg.telegram.botToken).toBe('12345:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef');
    expect(fetchCalls.some(u => u.endsWith('/getMe'))).toBe(true);
    expect(io.outputs.join('\n')).toMatch(/@elanoustestbot/);
  });

  test('telegram shape-invalid token retries 3x then accepts last', async () => {
    // PR-Δ14 — askValidated retries silently up to maxAttempts=3
    // before keeping the last value (matches the old "decline retry"
    // end state without forcing the user to type Y/n between tries).
    const vault = join(root, 'vault-tg-bad');
    mkdirSync(vault);
    const io = scriptedIO([
      '10', '1', '', vault,     // llm: auto (index 7 after Gemini)
      'y',
      'not-a-valid-token',     // attempt 1 — fails shape check
      'still-bad',             // attempt 2 — fails
      'final-bad',             // attempt 3 — fails, last value kept
      '111',                   // allowed users
      '',                      // no home
      'n',                     // discord: no
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath,
      telegramDeps: { validateToken: true, fetchImpl: (async () => ({ json: async () => ({ ok: true, result: {} }) })) as any },
    });
    expect(cfg.telegram.enabled).toBe(true);
    expect(cfg.telegram.botToken).toBe('final-bad');
  });

  test('codex mode 3 (skip) leaves apiKey undefined for later `elanous login`', async () => {
    const vault = join(root, 'vault-codex-skip');
    mkdirSync(vault);
    const io = scriptedIO([
      '1',        // codex
      '3',        // skip auth (configure later)
      '',         // model default
      '',         // skills default (opencode)
      '',         // no extra dirs
      vault,      // obsidian
      'n',        // telegram off
      'n',        // discord off
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath });
    expect(cfg.llm.provider).toBe('openai-codex');
    expect(cfg.llm.apiKey).toBeUndefined();
    const output = io.outputs.join('\n');
    expect(output).toMatch(/elanous login openai-codex/);
  });

  test('explicit auto provider selection (last index) succeeds', async () => {
    // Phase 5 / chooseFrom is strict — invalid numbers re-prompt rather
    // than clamp. The original "99 → clamp to auto" pattern is replaced
    // by direct selection of the auto index. Strict re-prompt behavior
    // has its own coverage in onboarding-io-extended.test.ts.
    const io = scriptedIO([
      '10',         // auto-detect (the last provider option)
      '1', '',     // skills
      '',          // obsidian
      'n',         // telegram
      'n',         // discord
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath });
    expect(cfg.llm.provider).toBe('auto');
  });

  // ── Bundle 3' · Discord step (2026-04-27) ──────────────────────────

  test('discord step skipped cleanly (n) leaves enabled=false', async () => {
    const io = scriptedIO([
      '10', '1', '', 'n',   // llm/skills/obsidian/telegram-off
      'n',                     // discord: no
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath });
    expect(cfg.discord.enabled).toBe(false);
    expect(cfg.discord.botToken).toBeUndefined();
    expect(cfg.discord.allowedUsers).toEqual([]);
  });

  test('discord enabled (validateToken=false) — token + snowflakes saved', async () => {
    // No /users/@me round-trip — exercises the same path tests use for
    // Telegram when there's no network. Lets us assert the wizard
    // accepts the pasted token + parses the allowlist + home channel.
    const io = scriptedIO([
      '10', '1', '', 'n',                  // llm/skills/obsidian/telegram-off
      'y',                                    // discord: yes
      'MTAxNzMtBOT.GabCdEf-Y9.aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678901',  // token
      '123456789012345678,234567890123456789', // allowed snowflakes
      '345678901234567890',                   // home channel
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath,
      discordDeps: { validateToken: false },
    });
    expect(cfg.discord.enabled).toBe(true);
    expect(cfg.discord.botToken).toBe('MTAxNzMtBOT.GabCdEf-Y9.aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678901');
    expect(cfg.discord.allowedUsers).toEqual(['123456789012345678', '234567890123456789']);
    expect(cfg.discord.homeChannel).toBe('345678901234567890');
  });

  test('discord allowed users — strips <@123> mention wrappers', async () => {
    // Users often paste mentions copied from Discord client; the
    // wizard normalizes `<@123>` / `<@!123>` to bare snowflakes.
    const io = scriptedIO([
      '10', '1', '', 'n',
      'y',                                    // discord: yes
      'MTAxNzMtBOT.GabCdEf-Y9.aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678901',
      '<@123456789012345678>, <@!234567890123456789>',  // mention wrappers
      '',                                     // no home channel
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath,
      discordDeps: { validateToken: false },
    });
    expect(cfg.discord.allowedUsers).toEqual(['123456789012345678', '234567890123456789']);
    expect(cfg.discord.homeChannel).toBeUndefined();
  });

  test('discord shape-invalid token retries 3x then accepts last', async () => {
    // PR-Δ14 — same askValidated retry-up-to-3 pattern as telegram.
    const io = scriptedIO([
      '10', '1', '', 'n',
      'y',                  // discord: yes
      'short',              // attempt 1 — fails shape check (< 20 chars)
      'still-short',        // attempt 2 — fails
      'final-short',        // attempt 3 — fails, last value kept
      '111111111111111111', // allowed user (snowflake)
      '',                   // no home
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath,
      discordDeps: { validateToken: true, fetchImpl: (async () => ({ ok: true, json: async () => ({}) })) as any },
    });
    expect(cfg.discord.enabled).toBe(true);
    expect(cfg.discord.botToken).toBe('final-short');
  });

  test('discord validateToken=true calls /users/@me and shows username', async () => {
    const fetchCalls: string[] = [];
    const fakeFetch: any = async (url: string, _init?: any) => {
      fetchCalls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ id: '987654321098765432', username: 'elanoustestbot', discriminator: '0' }),
      };
    };
    const io = scriptedIO([
      '10', '1', '', 'n',
      'y',
      'MTAxNzMtBOT.GabCdEf-Y9.aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678901',
      '111111111111111111',
      '',
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath,
      discordDeps: { validateToken: true, fetchImpl: fakeFetch },
    });
    expect(cfg.discord.enabled).toBe(true);
    expect(fetchCalls.some(u => u.endsWith('/users/@me'))).toBe(true);
    expect(io.outputs.join('\n')).toMatch(/Connected as elanoustestbot/);
  });

  // ── Bundle 4' · /setup reset (2026-04-27) ──────────────────────────

  test('resetOnboardingMarker flips completed=false but preserves other fields', async () => {
    // First run a wizard to populate config + mark complete.
    const io = scriptedIO([
      '10', '1', '', 'n', 'n',  // auto / opencode / no extras / default obsidian / no telegram / no discord
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath });
    expect(cfg.onboarding.completed).toBe(true);
    expect(cfg.skills.activeSet).toBe('claudecode');

    // Now reset the marker — only `onboarding.completed` should flip;
    // every other field (provider / skills / vault) stays.
    const after = resetOnboardingMarker(cfgPath);
    expect(after.onboarding.completed).toBe(false);
    expect(after.skills.activeSet).toBe('claudecode');
    expect(after.llm.provider).toBe('auto');
    expect(needsOnboarding(after)).toBe(true);

    // Reload from disk to confirm the change persisted.
    const reloaded = buildUserConfig(cfgPath);
    expect(reloaded.onboarding.completed).toBe(false);
    expect(reloaded.skills.activeSet).toBe('claudecode');
    expect(needsOnboarding(reloaded)).toBe(true);
  });

  test('resetOnboardingMarker on a fresh config still flips to false', async () => {
    // Fresh (non-onboarded) config — calling reset shouldn't error.
    // completed is already false; the reset is idempotent.
    const before = buildUserConfig(cfgPath);
    expect(before.onboarding.completed).toBe(false);
    const after = resetOnboardingMarker(cfgPath);
    expect(after.onboarding.completed).toBe(false);
  });

  test('discord summary shows enabled/disabled state', async () => {
    const io = scriptedIO([
      '10', '1', '', 'n',
      'y',
      'MTAxNzMtBOT.GabCdEf-Y9.aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678901',
      '111111111111111111',
      '',
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath,
      discordDeps: { validateToken: false },
    });
    const summary = io.outputs.join('\n');
    expect(summary).toMatch(/Discord {2}: enabled/);
    expect(summary).toMatch(/Telegram : disabled/);
  });

  // ── PR-Δ14 (Sprint 8 · 2026-04-28) — validate wire ─────────────────

  test('PR-Δ14: telegram bad-then-good retries and accepts the good token', async () => {
    // validateToken=true triggers the shape validator; the post-paste
    // /getMe probe then runs once with the good token.
    const vault = join(root, 'vault-tg-recover');
    mkdirSync(vault);
    const fakeFetch: any = async () => ({
      json: async () => ({ ok: true, result: { id: 1, username: 'recoverbot' } }),
    });
    const io = scriptedIO([
      '10', '1', '', vault,
      'y',
      'bad-token',                              // attempt 1 — bad shape
      '12345:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef', // attempt 2 — good shape, accepted
      '111',
      '',
      'n',
      'n',
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath,
      telegramDeps: { validateToken: true, fetchImpl: fakeFetch },
    });
    expect(cfg.telegram.botToken).toBe('12345:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef');
    // The first error message must surface so the user understands.
    expect(io.outputs.join('\n')).toMatch(/<digits>:<chars>/);
  });

  test("PR-Δ14: codex API key short input retries up to 3", async () => {
    const vault = join(root, 'vault-codex-short');
    mkdirSync(vault);
    const io = scriptedIO([
      '1',                  // codex
      '2',                  // apikey mode
      'sk-short',           // attempt 1 — too short (8 chars)
      'sk-stillshort',      // attempt 2 — too short
      'sk-final-too-short', // attempt 3 — still under 16, last value kept
      '',                   // model default
      '1',                  // skills claudecode
      vault,                // obsidian
      'n',                  // telegram
      'n',                  // discord
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath });
    expect(cfg.llm.apiKey).toBe('sk-final-too-short');
    expect(io.outputs.join('\n')).toMatch(/looks too short/);
  });

  test('PR-Δ14: discord bad-then-good retries and accepts', async () => {
    const fakeFetch: any = async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ id: '999', username: 'recoverdc', discriminator: '0' }),
    });
    const io = scriptedIO([
      '10', '1', '', 'n',
      'y',                  // discord enable
      'short',              // attempt 1 — too short
      'MTAxNzMtBOT.GabCdEf-Y9.aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678901',
      '111111111111111111',
      '',
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath,
      discordDeps: { validateToken: true, fetchImpl: fakeFetch },
    });
    expect(cfg.discord.botToken).toBe('MTAxNzMtBOT.GabCdEf-Y9.aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678901');
    expect(io.outputs.join('\n')).toMatch(/too short or has whitespace/);
  });

  test('Grok subscription accepts blank API-key input through injected resolver', async () => {
    const vault = join(root, 'vault-grok-subscription');
    mkdirSync(vault);
    const io = scriptedIO(['3', '', '', '2', '1', vault, 'n', 'n', '1']);
    const cfg = await runOnboarding({
      io,
      path: cfgPath,
      grokDeps: { ...NO_SUBSCRIPTION_DETECT,
        resolveCredential: () => ({
          kind: 'subscription',
          baseUrl: 'https://cli-chat-proxy.grok.com/v1',
          token: 'subscription-token',
          headers: {},
          source: 'auth.json',
        }),
      },
    });
    expect(io.outputs).toContain('  Found grok subscription (~/.grok/auth.json)');
    expect(io.outputs.join('\n')).toContain('press enter to use the subscription');
    expect(io.outputs.join('\n')).not.toContain('Grok (xAI) API key required.');
    expect(cfg.llm.provider).toBe('grok');
    expect(cfg.llm.apiKey).toBeUndefined();
  });

  test('Grok subscription with XAI_API_KEY does not print the env-key hint it would not honor', async () => {
    const vault = join(root, 'vault-grok-subscription-env-key');
    mkdirSync(vault);
    process.env.XAI_API_KEY = 'xai-envdummy0123456789abcdef';
    const io = scriptedIO(['3', '', '', '2', '1', vault, 'n', 'n', '1']);
    const cfg = await runOnboarding({
      io,
      path: cfgPath,
      grokDeps: { ...NO_SUBSCRIPTION_DETECT,
        resolveCredential: () => ({
          kind: 'subscription',
          baseUrl: 'https://cli-chat-proxy.grok.com/v1',
          token: 'subscription-token',
          headers: {},
          source: 'auth.json',
        }),
      },
    });
    const out = io.outputs.join('\n');
    expect(out).toContain('Found grok subscription (~/.grok/auth.json)');
    expect(out).not.toContain('Found in XAI_API_KEY');
    expect(out).toContain('press enter to use the subscription');
    expect(cfg.llm.provider).toBe('grok');
    expect(cfg.llm.apiKey).toBeUndefined();
  });

  test('Grok subscription blank input discards an existing API-key', async () => {
    const vault = join(root, 'vault-grok-subscription-existing-key');
    mkdirSync(vault);
    const initial = buildUserConfig(cfgPath);
    initial.llm = { provider: 'grok', apiKey: 'xai-existing-key-1234567890' };
    const io = scriptedIO(['3', '', '', '2', '1', vault, 'n', 'n', '1']);
    const cfg = await runOnboarding({
      io,
      path: cfgPath,
      initial,
      grokDeps: { ...NO_SUBSCRIPTION_DETECT,
        resolveCredential: () => ({
          kind: 'subscription',
          baseUrl: 'https://cli-chat-proxy.grok.com/v1',
          token: 'subscription-token',
          headers: {},
          source: 'auth.json',
        }),
      },
    });
    expect(cfg.llm.provider).toBe('grok');
    expect(cfg.llm).not.toHaveProperty('apiKey');
  });

  test('Grok subscription validates and saves an entered API-key override', async () => {
    const vault = join(root, 'vault-grok-subscription-override');
    mkdirSync(vault);
    const io = scriptedIO(['3', 'xai-bad with space', 'xai-1234567890abcdef', '', '2', '1', vault, 'n', 'n', '1']);
    const cfg = await runOnboarding({
      io,
      path: cfgPath,
      grokDeps: { ...NO_SUBSCRIPTION_DETECT,
        resolveCredential: () => ({
          kind: 'subscription',
          baseUrl: 'https://cli-chat-proxy.grok.com/v1',
          token: 'subscription-token',
          headers: {},
          source: 'auth.json',
        }),
      },
    });
    expect(cfg.llm.apiKey).toBe('xai-1234567890abcdef');
    expect(io.outputs.join('\n')).toContain('should not contain whitespace');
  });

  test('Grok without a subscription still requires an API key', async () => {
    const io = scriptedIO(['3', '', '', '', '', '2', '1', root, 'n', 'n', '1']);
    await runOnboarding({
      io,
      path: cfgPath,
      grokDeps: { resolveCredential: () => null },
    });
    expect(io.outputs.join('\n')).toContain('Grok (xAI) API key required.');
  });

  test('Grok API-key credential does not print the subscription discovery', async () => {
    const vault = join(root, 'vault-grok-api-key');
    mkdirSync(vault);
    const io = scriptedIO([
      '3',
      'xai-1234567890abcdef',
      '',
      '2',
      '1',
      vault,
      'n',
      'n',
      '1',
    ]);
    await runOnboarding({
      io,
      path: cfgPath,
      grokDeps: { ...NO_SUBSCRIPTION_DETECT,
        resolveCredential: () => ({
          kind: 'api_key',
          baseUrl: 'https://api.x.ai/v1',
          token: 'api-key',
          headers: {},
          source: 'XAI_API_KEY',
        }),
      },
    });
    expect(io.outputs).not.toContain('  Found grok subscription (~/.grok/auth.json)');
  });

  test('PR-Δ14: provider api-key with whitespace rejected then accepted', async () => {
    const vault = join(root, 'vault-grok-ws');
    mkdirSync(vault);
    const io = scriptedIO([
      '3',                   // grok
      'xai-bad with space',  // attempt 1 — whitespace rejected
      'xai-1234567890abcdef', // attempt 2 — clean, accepted
      '',                    // model default
      '2',                   // Step 1 — Answer depth: Balanced default
      '1',                   // skills
      vault,                 // obsidian
      'n',                   // telegram
      'n',                   // discord
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath });
    expect(cfg.llm.provider).toBe('grok');
    expect(cfg.llm.apiKey).toBe('xai-1234567890abcdef');
    expect(io.outputs.join('\n')).toMatch(/whitespace/);
  });

  // ── PR-Δ16 (Sprint 14 · 2026-04-28) — Back navigation ───────────────

  test('PR-Δ16: ← Back from Skills step rewinds to LLM step', async () => {
    const vault = join(root, 'vault-back-skills');
    mkdirSync(vault);
    // chooseFrom fallback adds the back option last; in scriptedIO it's
    // available by typing 'b'. After Back, we re-pick LLM (auto · '10')
    // then continue normally.
    const io = scriptedIO([
      '10',     // LLM: auto (1st time)
      'b',     // Skills: ← Back → throws WizardBackError → idx-- → re-run LLM
      '10',    // LLM: auto (2nd time, replays)
      '1',     // Skills: claudecode
      vault,   // Obsidian
      'n',     // Telegram off
      'n',     // Discord off
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath });
    expect(cfg.llm.provider).toBe('auto');
    expect(cfg.skills.activeSet).toBe('claudecode');
    expect(cfg.onboarding.completed).toBe(true);
  });

  test('PR-Δ16: ← Back from Telegram step rewinds to Obsidian (then forward through)', async () => {
    const vault = join(root, 'vault-back-tg');
    mkdirSync(vault);
    const io = scriptedIO([
      '10',     // LLM: auto
      '1',     // Skills: claudecode
      vault,   // Obsidian (1st)
      'b',     // Telegram main picker → Back → idx-- to Obsidian
      vault,   // Obsidian (replay)
      'n',     // Telegram (this time choose No)
      'n',     // Discord
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath });
    expect(cfg.llm.provider).toBe('auto');
    expect(cfg.obsidian.vault).toBe(vault);
    expect(cfg.telegram.enabled).toBe(false);
  });

  test('PR-Δ16: Back option is NOT shown on Step 1 (LLM)', async () => {
    // First chooseFrom in askLLM has 10 provider entries (no Back
    // sentinel option since Step 1 has no prior step to back into).
    // Pressing '$' isn't bound to any choice and isn't a substring
    // match for any provider label, so chooseFrom prints the
    // "invalid choice" + re-prompts. We feed a valid '10' (auto)
    // immediately after to keep the wizard moving.
    const vault = join(root, 'vault-no-back-step1');
    mkdirSync(vault);
    const io = scriptedIO([
      '$',     // attempt Back at Step 1 — invalid (rejects, re-prompts)
      '10',    // LLM: auto
      '1',     // Skills
      vault,   // Obsidian
      'n', 'n',
      '1', // Step 6 — Voice & AI: Smart defaults
    ]);
    const cfg = await runOnboarding({ grokDeps: NO_SUBSCRIPTION_DETECT, io, path: cfgPath });
    expect(cfg.llm.provider).toBe('auto');
    expect(io.outputs.join('\n')).toMatch(/no match for "\$"/);
  });
});
