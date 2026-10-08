import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { runFirstRun } from './first-run.js';
import { unattendedNextStepLine } from './entry-hints.js';
import { buildUserConfig, saveUserConfig } from '../user-config.js';
import { needsFirstRun, needsOnboarding } from '../onboarding.js';
import type { DetectedProvider } from '../llm/provider-detect.js';

const detected = (provider: string, auth: DetectedProvider['auth'] = 'oauth'): DetectedProvider =>
  ({ provider, auth, source: 'test', available: true, rank: 0 });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'onb1-first-run-'));
  return { dir, path: join(dir, 'config.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('first run', () => {
  test('ready is optional and survives parsing and saving without completing detailed onboarding', () => {
    const f = fixture();
    try {
      writeFileSync(f.path, JSON.stringify({ onboarding: { completed: false, version: 4, ready: true } }));
      const cfg = buildUserConfig(f.path);
      expect(cfg.onboarding).toMatchObject({ completed: false, version: 4, ready: true });
      saveUserConfig(cfg, f.path);
      expect(buildUserConfig(f.path).onboarding).toMatchObject({ completed: false, version: 4, ready: true });
      writeFileSync(f.path, JSON.stringify({ onboarding: { completed: false, version: 4 } }));
      const legacy = buildUserConfig(f.path);
      expect(legacy.onboarding.ready).toBeUndefined();
      saveUserConfig(legacy, f.path);
      expect(JSON.parse(readFileSync(f.path, 'utf8')).onboarding).not.toHaveProperty('ready');
    } finally { f.cleanup(); }
  });

  test('input 0: detects subscriptions in codex → grok → claude order and saves ready', async () => {
    const f = fixture();
    try {
      const cfg = buildUserConfig(f.path);
      let asked = 0;
      const result = await runFirstRun({ path: f.path, config: cfg, isTTY: true,
        detectProviders: async () => [detected('claude-code', 'agent-cli'), detected('grok'), detected('openai-codex')],
        chooseProvider: async () => { asked++; return 'grok'; },
      });
      expect(result).toEqual({ outcome: 'ready', provider: 'openai-codex', inputs: 0 });
      expect(asked).toBe(0);
      expect(buildUserConfig(f.path).llm.provider).toBe('openai-codex');
      expect(buildUserConfig(f.path).onboarding.ready).toBe(true);
      expect(buildUserConfig(f.path).onboarding.completed).toBe(false);
      expect(needsFirstRun(buildUserConfig(f.path))).toBe(false);
      expect(needsOnboarding(buildUserConfig(f.path))).toBe(true);
    } finally { f.cleanup(); }
  });

  test('grok subscription takes priority over available Claude agent-cli', async () => {
    const f = fixture();
    try {
      const result = await runFirstRun({ path: f.path, isTTY: false,
        detectProviders: async () => [detected('claude-code', 'agent-cli'), detected('grok')],
        chooseProvider: async () => { throw new Error('prompted'); },
      });
      expect(result).toEqual({ outcome: 'ready', provider: 'grok', inputs: 0 });
      expect(buildUserConfig(f.path).llm.provider).toBe('grok');
    } finally { f.cleanup(); }
  });

  test('input 1: TTY chooses LLM once without other steps', async () => {
    const f = fixture();
    try {
      let calls = 0;
      const cfg = buildUserConfig(f.path);
      cfg.llm.rotation = [{ provider: 'grok', apiKey: 'chosen-provider-key' }];
      const result = await runFirstRun({ path: f.path, config: cfg, isTTY: true, detectProviders: async () => [],
        chooseProvider: async () => { calls++; return 'grok'; },
      });
      expect(result).toEqual({ outcome: 'ready', provider: 'grok', inputs: 1 });
      expect(calls).toBe(1);
      expect(buildUserConfig(f.path).onboarding.ready).toBe(true);
      expect(buildUserConfig(f.path).llm.apiKey).toBe('chosen-provider-key');
    } finally { f.cleanup(); }
  });

  test('chosen rotation credential is saved for the chosen provider', async () => {
    const f = fixture();
    try {
      const cfg = buildUserConfig(f.path);
      cfg.llm.rotation = [{ provider: 'grok', apiKey: 'rotation-secret' }];
      const result = await runFirstRun({ path: f.path, config: cfg, isTTY: true,
        detectProviders: async () => [], chooseProvider: async () => 'grok',
      });
      expect(result).toEqual({ outcome: 'ready', provider: 'grok', inputs: 1 });
      expect(buildUserConfig(f.path).llm.apiKey).toBe('rotation-secret');
      expect(buildUserConfig(f.path).onboarding.completed).toBe(false);
    } finally { f.cleanup(); }
  });

  test('TTY choice without a usable credential does not save ready', async () => {
    const f = fixture();
    try {
      const lines: string[] = [];
      let calls = 0;
      const result = await runFirstRun({ path: f.path, isTTY: true, detectProviders: async () => [],
        chooseProvider: async () => { calls++; return 'grok'; }, print: (line) => lines.push(line),
      });
      expect(result).toEqual({ outcome: 'needs-llm', inputs: 1 });
      expect(calls).toBe(1);
      expect(lines).toEqual(['eln setup llm 으로 고르세요']);
      expect(buildUserConfig(f.path).onboarding.ready).toBeUndefined();
    } finally { f.cleanup(); }
  });

  test('existing Anthropic key and model survive a detected Codex subscription', async () => {
    const f = fixture();
    try {
      const cfg = buildUserConfig(f.path);
      cfg.llm.provider = 'anthropic';
      cfg.llm.apiKey = 'old-provider-secret';
      cfg.llm.model = 'claude-sonnet-4';
      const result = await runFirstRun({ path: f.path, config: cfg, isTTY: false,
        detectProviders: async () => [detected('openai-codex')],
        chooseProvider: async () => { throw new Error('prompted'); },
      });
      expect(result).toEqual({ outcome: 'ready', provider: 'anthropic', inputs: 0 });
      const saved = buildUserConfig(f.path);
      expect(saved.llm.apiKey).toBe('old-provider-secret');
      expect(saved.llm.model).toBe('claude-sonnet-4');
      expect(saved.llm.provider).toBe('anthropic');
      expect(saved.onboarding).toMatchObject({ ready: true, completed: false });
    } finally { f.cleanup(); }
  });

  test('existing API key without a detected subscription is ready on non-TTY', async () => {
    const f = fixture();
    try {
      const cfg = buildUserConfig(f.path);
      cfg.llm.provider = 'anthropic';
      cfg.llm.apiKey = 'existing-api-key';
      cfg.llm.model = 'claude-sonnet-4';
      const lines: string[] = [];
      const result = await runFirstRun({ path: f.path, config: cfg, isTTY: false,
        detectProviders: async () => [],
        chooseProvider: async () => { throw new Error('prompted'); },
        print: (line) => lines.push(line),
      });
      expect(result).toEqual({ outcome: 'ready', provider: 'anthropic', inputs: 0 });
      expect(lines).toEqual([]);
      expect(buildUserConfig(f.path).llm).toMatchObject({ provider: 'anthropic', apiKey: 'existing-api-key', model: 'claude-sonnet-4' });
      expect(buildUserConfig(f.path).onboarding).toMatchObject({ ready: true, completed: false });
    } finally { f.cleanup(); }
  });

  test('available Claude agent-cli is adopted without a second login flag', async () => {
    const f = fixture();
    try {
      const result = await runFirstRun({ path: f.path, isTTY: false,
        detectProviders: async () => [detected('claude-code', 'agent-cli')],
        chooseProvider: async () => { throw new Error('prompted'); },
      });
      expect(result).toEqual({ outcome: 'ready', provider: 'anthropic', inputs: 0 });
      expect(buildUserConfig(f.path).onboarding.ready).toBe(true);
    } finally { f.cleanup(); }
  });

  test('unavailable agent-cli is not adopted', async () => {
    const f = fixture();
    try {
      const unavailable = { ...detected('claude-code', 'agent-cli'), available: false };
      const result = await runFirstRun({ path: f.path, isTTY: false,
        detectProviders: async () => [unavailable],
        chooseProvider: async () => { throw new Error('prompted'); }, print: () => {},
      });
      expect(result).toEqual({ outcome: 'needs-llm', inputs: 0 });
      expect(buildUserConfig(f.path).onboarding.ready).toBeUndefined();
    } finally { f.cleanup(); }
  });

  test('needs-llm: non-TTY never prompts or writes config', async () => {
    const f = fixture();
    try {
      const lines: string[] = [];
      const result = await runFirstRun({ path: f.path, isTTY: false, detectProviders: async () => [],
        chooseProvider: async () => { throw new Error('prompted'); }, print: (line) => lines.push(line),
      });
      expect(result).toEqual({ outcome: 'needs-llm', inputs: 0 });
      expect(lines).toEqual(['eln setup llm 으로 고르세요', unattendedNextStepLine()]);
      expect(lines[1]).toBe('next: unattended: `elanous onboarding --non-interactive --config <answers.json>`');
      expect(buildUserConfig(f.path).onboarding.ready).toBeUndefined();
    } finally { f.cleanup(); }
  });

  test('completed stays unchanged, including existing settings', async () => {
    const f = fixture();
    try {
      const cfg = buildUserConfig(f.path);
      cfg.onboarding.completed = true;
      cfg.onboarding.completedAt = '2026-01-01T00:00:00Z';
      cfg.telegram.allowedUsers = [12];
      expect(needsFirstRun(cfg)).toBe(false);
      await runFirstRun({ config: cfg, path: f.path, detectProviders: async () => [detected('grok')] });
      const saved = buildUserConfig(f.path);
      expect(saved.onboarding.completed).toBe(true);
      expect(saved.onboarding.completedAt).toBe(cfg.onboarding.completedAt);
      expect(saved.telegram.allowedUsers).toEqual([12]);
    } finally { f.cleanup(); }
  });

  test('an available other OAuth subscription is adopted without a prompt', async () => {
    const f = fixture();
    try {
      const result = await runFirstRun({ path: f.path, isTTY: false,
        detectProviders: async () => [detected('gemini')],
        chooseProvider: async () => { throw new Error('prompted'); },
      });
      expect(result).toEqual({ outcome: 'ready', provider: 'gemini', inputs: 0 });
      expect(buildUserConfig(f.path).llm.provider).toBe('gemini');
    } finally { f.cleanup(); }
  });

  test('cancelled does not save ready', async () => {
    const f = fixture();
    try {
      expect(await runFirstRun({ path: f.path, isTTY: true, detectProviders: async () => [],
        chooseProvider: async () => null })).toEqual({ outcome: 'cancelled', inputs: 1 });
      expect(buildUserConfig(f.path).onboarding.ready).toBeUndefined();
    } finally { f.cleanup(); }
  });

  // ⚠️ util-linux `script -q -e -c` 문법이다 — 맥(BSD script)은 이 문법도, 파이프 입력으로 PTY 를 세우는 것도 못 한다
  //  (10-02 0.2.9 게이트에서 같은 원인으로 first-screen-band-wiring 이 깨졌다 · #22750). 리눅스(하니스 파드)에서는 돈다.
  test.skipIf(process.platform === 'darwin')('bare process: detected Codex subscription saves ready before dashboard', async () => {
    const f = fixture();
    try {
      const home = join(f.dir, 'home');
      const configDir = join(f.dir, 'cfg');
      const codexHome = join(home, '.codex');
      mkdirSync(codexHome, { recursive: true });
      mkdirSync(configDir);
      writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fake-token' } }));
      const env = { ...process.env, HOME: home, CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: join(home, '.claude'), XDG_CONFIG_HOME: '',
        ELANOUS_LLM_PROVIDER: '', ELANOUS_ESCALATE_PROVIDER: '',
        ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', XAI_API_KEY: '', GROK_API_KEY: '',
        GROK_CODE_XAI_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '',
        OPENROUTER_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_AUTH_TOKEN: '',
        LOCAL_LLM_URL: '',
      };
      const processChild = spawn('sh', ['-c', 'script -q -e -c "$1" /dev/null', 'sh',
        `${process.execPath} ${resolve(import.meta.dir, '../../bin/elanous.mjs')} --test --config-dir ${configDir}`],
        { cwd: resolve(import.meta.dir, '../..'), env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let sentQuit = false;
      processChild.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
        if (!sentQuit && stdout.includes('\x1b[?1049h')) {
          sentQuit = true;
          setTimeout(() => processChild.stdin.write('\x11'), 300);
        }
      });
      processChild.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; processChild.kill('SIGTERM'); }, 12000);
      const status = await new Promise<number | null>((resolve, reject) => {
        processChild.once('error', reject);
        processChild.once('close', (code) => resolve(code));
      }).finally(() => clearTimeout(timeout));
      const child = { status, stdout, stderr };
      expect(sentQuit).toBe(true);
      expect(timedOut).toBe(false);
      expect(child.status).toBe(0);
      expect(child.stdout).toContain('[elanous] provider: openai-codex');
      expect(child.stdout.indexOf('\x1b[?1049h')).toBeGreaterThan(child.stdout.indexOf('[elanous] provider: openai-codex'));
      expect(child.stdout + child.stderr).not.toContain('eln setup llm');
      expect(child.stdout + child.stderr).not.toContain('Step 1');
      expect(child.stdout + child.stderr).not.toContain('fake-token');
      const saved = buildUserConfig(join(configDir, 'config.json'));
      expect(saved.onboarding).toMatchObject({ ready: true, completed: false });
      expect(saved.llm.provider).toBe('openai-codex');
    } finally { f.cleanup(); }
  }, 20000);

  test('spawned CLI: empty HOME and closed stdin take real bare entry without Step 1', () => {
    const f = fixture();
    try {
      const home = join(f.dir, 'home');
      const configDir = join(f.dir, 'cfg');
      mkdirSync(home);
      mkdirSync(configDir);
      const env = { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'),
        CLAUDE_CONFIG_DIR: join(home, '.claude'), XDG_CONFIG_HOME: '',
        ELANOUS_LLM_PROVIDER: '', ELANOUS_ESCALATE_PROVIDER: '',
        ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', XAI_API_KEY: '', GROK_API_KEY: '',
        GROK_CODE_XAI_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '',
        OPENROUTER_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_AUTH_TOKEN: '',
        LOCAL_LLM_URL: '',
      };
      const child = spawnSync(process.execPath,
        [resolve(import.meta.dir, '../../bin/elanous.mjs'), '--test', '--config-dir', configDir],
        { cwd: resolve(import.meta.dir, '../..'), env, input: '', encoding: 'utf8', timeout: 12000 });
      const text = child.stdout + child.stderr;
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(text).toContain('eln setup llm');
      expect(text).toContain(unattendedNextStepLine());
      expect(text).not.toContain('Step 1');

      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ onboarding: { completed: true } }));
      const completed = spawnSync(process.execPath,
        [resolve(import.meta.dir, '../../bin/elanous.mjs'), '--test', '--config-dir', configDir],
        { cwd: resolve(import.meta.dir, '../..'), env, input: '', encoding: 'utf8', timeout: 12000 });
      expect(completed.error).toBeUndefined();
      expect(completed.status).toBe(1);
      expect(completed.stderr).toContain('stdin TTY');
      expect(completed.stdout + completed.stderr).not.toContain('eln setup llm');
      expect(completed.stdout + completed.stderr).not.toContain('Step 1');

      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        llm: { provider: 'anthropic', apiKey: 'existing-cli-secret', model: 'claude-sonnet-4' },
        onboarding: { completed: false },
      }));
      const configured = spawnSync(process.execPath,
        [resolve(import.meta.dir, '../../bin/elanous.mjs'), '--test', '--config-dir', configDir],
        { cwd: resolve(import.meta.dir, '../..'), env, input: '', encoding: 'utf8', timeout: 12000 });
      expect(configured.error).toBeUndefined();
      expect(configured.status).toBe(1);
      expect(configured.stderr).toContain('stdin TTY');
      expect(configured.stdout + configured.stderr).not.toContain('eln setup llm');
      expect(configured.stdout + configured.stderr).not.toContain('existing-cli-secret');
      expect(buildUserConfig(join(configDir, 'config.json')).llm).toMatchObject({
        provider: 'anthropic', apiKey: 'existing-cli-secret', model: 'claude-sonnet-4',
      });
      expect(buildUserConfig(join(configDir, 'config.json')).onboarding).toMatchObject({ ready: true, completed: false });
    } finally { f.cleanup(); }
  }, 20000);
});
