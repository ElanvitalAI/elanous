import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { planStart, registerStartCommand, runStart, type StartDeps } from './start-cli.js';
import { checkReadiness } from './doctor-readiness.js';
import { resolveUsableLlm } from '../llm/usable-llm.js';
import { getUserConfig } from '../user-config.js';

const INJECTED = {
  baseUrl: 'http://127.0.0.1:45678',
  healthUrl: 'http://127.0.0.1:45678/v1/health',
  pwaUrl: 'http://127.0.0.1:45678/app/',
  source: 'registry' as const,
};

const candidate = { provider: 'openai-codex', auth: 'oauth' as const, source: 'codex-auth', available: true, rank: 0 };
function fixture() {
  const calls: string[] = [];
  const output: string[] = [];
  const deps: StartDeps = {
    detect: async () => { calls.push('detect'); return [candidate]; },
    resolveLlm: () => ({ usable: true, provider: 'openai-codex', via: 'login', why: 'LLM via login (openai-codex)' }),
    isTty: () => true,
    health: async () => { calls.push('health'); return true; },
    launch: async () => { calls.push('launch'); return { exitCode: 0 }; },
    openGui: async (url) => { calls.push(`gui:${url}`); return true; },
    openTui: async () => { calls.push('tui'); return 0; },
    output: (line) => output.push(line),
    resolveEndpoint: () => INJECTED,
  };
  return { calls, output, deps };
}

describe('start CLI', () => {
  test('pure plan ignores agent-cli as a direct LLM and never logs in without TTY or in JSON mode', () => {
    const state = { providers: [{ provider: 'claude-code', auth: 'agent-cli' as const, available: true, rank: -2 }], llm: { usable: false, via: 'none' as const, why: 'no usable LLM route selected' }, tty: true, healthy: false };
    const plan = planStart({}, state);
    expect(plan.map((step) => [step.id, step.needed])).toEqual([
      ['detect-llm', true], ['login', true], ['check-daemon', true], ['launch-daemon', true], ['open-gui', true], ['open-tui', false],
    ]);
    expect(planStart({ json: true }, state).find((step) => step.id === 'login')?.needed).toBe(false);
    expect(planStart({ login: false }, state).find((step) => step.id === 'login')?.needed).toBe(false);
    expect(planStart({}, { ...state, discoveryFailed: true }).find((step) => step.id === 'login')?.needed).toBe(false);
    expect(planStart({ tui: true }, { ...state, tty: false, healthy: true }).map((step) => step.needed)).toEqual([true, false, true, false, false, true]);
    expect(state).toEqual({ providers: [{ provider: 'claude-code', auth: 'agent-cli', available: true, rank: -2 }], llm: { usable: false, via: 'none', why: 'no usable LLM route selected' }, tty: true, healthy: false });
  });

  test('planStart requires the selected route rather than treating discovered candidates as the route', () => {
    const providers = [{ provider: 'openai-codex', auth: 'oauth' as const, available: true, rank: 0 }];
    const base = { providers, tty: true, healthy: true };
    const selected = { usable: true, provider: 'openai-codex', via: 'login' as const, why: 'LLM via login (openai-codex)' };
    expect(planStart({}, { ...base, llm: selected }).find((step) => step.id === 'login')?.needed).toBe(false);
    expect(planStart({}, { ...base, llm: { usable: false, via: 'none', why: 'no usable LLM route selected' } }).find((step) => step.id === 'login')?.needed).toBe(true);
    expect(planStart({}, { ...base, llm: null }).find((step) => step.id === 'login')?.needed).toBe(false);
    for (const provider of ['openai', 'local', 'anthropic']) {
      expect(planStart({}, { ...base, llm: { usable: false, provider, via: 'none', why: 'no usable LLM route selected' } }).find((step) => step.id === 'login')?.needed).toBe(false);
    }
    expect(planStart({}, { ...base, llm: { usable: false, provider: 'openai-codex', via: 'none', why: 'no usable LLM route selected' } }).find((step) => step.id === 'login')?.needed).toBe(true);
  });

  test('selected auto route, not discovered candidate count, controls login and JSON availability', async () => {
    const f = fixture();
    f.deps.detect = async () => [{ provider: 'local', auth: 'local', source: 'env:LOCAL_LLM_URL', available: true, rank: 14 }];
    f.deps.resolveLlm = () => ({ usable: false, via: 'none', why: 'no usable LLM route selected' });
    const result = await runStart({ json: true, login: false }, f.deps);
    expect(result.llm).toBe('missing');
    expect(result.steps.find((step) => step.id === 'login')?.detail).not.toBe('LLM already available');
    expect(JSON.parse(f.output[0]!).llm).toBe('missing');
    f.deps.resolveLlm = () => ({ usable: true, provider: 'local', via: 'local-server', why: 'LLM via local-server (local)' });
    expect((await runStart({ json: true, login: false }, f.deps)).llm).toBe('available');
  });

  test('start and doctor agree for login, key, local server and none, including unselected local server', async () => {
    const config = { ...getUserConfig(), llm: { ...getUserConfig().llm, provider: 'auto' as const } };
    for (const [selected, auth, available] of [
      ['auto:openai-codex', 'oauth', true],
      ['auto:openai', 'apikey', true],
      ['auto:local', 'local', true],
      ['auto', 'none', false],
    ] as const) {
      const usable = resolveUsableLlm({ config, decide: () => ({ provider: selected, auth, model: '(test)' }) });
      const f = fixture();
      f.deps.detect = async () => [{ provider: 'local', auth: 'local', source: 'env:LOCAL_LLM_URL', available: true, rank: 14 }];
      f.deps.resolveLlm = () => usable;
      const result = await runStart({ json: true, login: false }, f.deps);
      const decision = checkReadiness({ provider: 'auto', usableLlm: usable }).items.find((item) => item.id === 'provider-decision')!;
      expect(result.llm === 'available').toBe(available);
      expect(decision.status === 'ok').toBe(available);
      expect(decision.evidence).toContain(available ? usable.via : 'via none');
    }
  });

  test('real unprovided CLI selectors agree for isolated auto/local, key, none and an unselected local route', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-start-doctor-'));
    const home = join(root, 'home');
    const isolated = join(root, 'isolated');
    mkdirSync(home);
    mkdirSync(isolated);
    writeFileSync(join(isolated, 'config.json'), JSON.stringify({ llm: { provider: 'auto' } }));
    mkdirSync(join(home, '.elanous'));
    writeFileSync(join(home, '.elanous', 'auth.json'), JSON.stringify({ version: 1, providers: {
      'openai-codex': { tokens: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: null }, lastRefresh: 'fixture' },
    } }));
    const entry = join(process.cwd(), 'bin/elanous.mjs');
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: '', ELANOUS_CONFIG_DIR: isolated,
      ELANOUS_STATE_DIR: isolated, CODEX_HOME: join(root, 'no-codex'), ELANOUS_CODEX_ACCOUNT: '', LOCAL_LLM_URL: '',
      OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '', GROK_API_KEY: '',
      XAI_API_KEY: '', OPENROUTER_API_KEY: '' };
    const run = (command: 'start' | 'doctor', input: Record<string, string>) => {
      const result = Bun.spawnSync([process.execPath, entry, `--test=${isolated}`, command, ...(command === 'start' ? ['--no-login', '--json'] : ['--json'])], {
        cwd: process.cwd(), env: { ...env, ...input }, stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
      });
      expect(result.signalCode).toBeUndefined();
      expect(result.stdout.toString().trim()).not.toBe('');
      return JSON.parse(result.stdout.toString());
    };
    try {
      const loginStart = run('start', {});
      const loginDoctor = run('doctor', {});
      expect(loginStart.llm).toBe('available');
      expect(loginDoctor.readiness.items.find((entry: { id: string }) => entry.id === 'provider-decision'))
        .toMatchObject({ status: 'ok', evidence: 'llm.provider=auto → login openai-codex' });
      rmSync(join(home, '.elanous', 'auth.json'));
      for (const [input, expected, via] of [
        [{ LOCAL_LLM_URL: 'http://127.0.0.1:12345/v1' }, 'available', 'local-server local'],
        [{ OPENAI_API_KEY: 'sk-fixture-do-not-print' }, 'available', 'key openai'],
        [{}, 'missing', 'via none'],
      ] as const) {
        const start = run('start', input);
        const doctor = run('doctor', input);
        const item = doctor.readiness.items.find((entry: { id: string }) => entry.id === 'provider-decision');
        expect(start.llm).toBe(expected);
        expect(item.status).toBe(expected === 'available' ? 'ok' : 'manual');
        expect(item.evidence).toContain(via);
        expect(JSON.stringify({ start, doctor })).not.toContain('sk-fixture-do-not-print');
      }
      writeFileSync(join(isolated, 'config.json'), JSON.stringify({ llm: { provider: 'openai' } }));
      const start = run('start', { LOCAL_LLM_URL: 'http://127.0.0.1:12345/v1' });
      const doctor = run('doctor', { LOCAL_LLM_URL: 'http://127.0.0.1:12345/v1' });
      expect(start.llm).toBe('missing');
      expect(doctor.readiness.items.find((entry: { id: string }) => entry.id === 'provider-decision').status).toBe('manual');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  test('healthy daemon is reused, GUI opens and no login or launch is invoked', async () => {
    const f = fixture();
    const result = await runStart({}, f.deps);
    expect(result).toMatchObject({ exitCode: 0, llm: 'available', daemon: 'running', surface: 'gui' });
    expect(f.calls).toEqual(['detect', 'health', 'gui:http://127.0.0.1:45678/app/']);
    expect(f.output.some((line) => line.includes('Daemon already healthy'))).toBe(true);
  });

  test('missing LLM offers login only with TTY consent; launch waits for health before TUI', async () => {
    const f = fixture();
    let probes = 0;
    let loggedIn = false;
    f.deps.detect = async () => { f.calls.push('detect'); return loggedIn ? [candidate] : []; };
    f.deps.resolveLlm = () => loggedIn
      ? { usable: true, provider: 'openai-codex', via: 'login', why: 'LLM via login (openai-codex)' }
      : { usable: false, via: 'none', why: 'no usable LLM route selected' };
    f.deps.confirmLogin = async () => { f.calls.push('confirm'); return true; };
    f.deps.login = async () => { f.calls.push('login'); loggedIn = true; return true; };
    f.deps.health = async () => { f.calls.push('health'); return ++probes > 2; };
    f.deps.sleep = async () => { f.calls.push('sleep'); };
    const result = await runStart({ tui: true }, f.deps);
    expect(result).toMatchObject({ exitCode: 0, llm: 'available', daemon: 'started', surface: 'tui' });
    expect(f.calls).toEqual(['detect', 'health', 'confirm', 'login', 'detect', 'launch', 'health', 'sleep', 'health', 'tui']);
  });

  test('daemon failure stops both surfaces and reports only stable secret-free JSON', async () => {
    const f = fixture();
    f.deps.detect = async () => [{ provider: 'openai', auth: 'apikey', source: 'sk-super-secret', available: true, rank: 1 }];
    f.deps.health = async () => { throw new Error('sk-super-secret'); };
    f.deps.launch = async () => { throw new Error('sk-super-secret'); };
    const result = await runStart({ json: true }, f.deps);
    expect(result).toMatchObject({ exitCode: 1, daemon: 'failed', surface: 'none' });
    expect(f.output).toHaveLength(1);
    expect(JSON.parse(f.output[0]!)).toEqual(result);
    expect(JSON.stringify(result)).not.toContain('sk-super-secret');
    expect(f.calls).toEqual([]);
  });

  test('reported daemon launch is not success until health responds; no surface opens', async () => {
    const f = fixture();
    f.deps.health = async () => { f.calls.push('health'); return false; };
    f.deps.sleep = async () => {};
    const result = await runStart({ json: true }, f.deps);
    expect(result).toMatchObject({ exitCode: 1, daemon: 'failed', surface: 'none' });
    expect(result.steps.find((step) => step.id === 'launch-daemon')).toMatchObject({ status: 'failed' });
    expect(f.calls).toContain('launch');
    expect(f.calls).not.toContain('tui');
    expect(f.calls.some((call) => call.startsWith('gui:'))).toBe(false);
    expect(f.output).toHaveLength(1);
  });

  test('non-TTY missing login is skipped; GUI fallback URL and JSON remain clean', async () => {
    const f = fixture();
    f.deps.detect = async () => [];
    f.deps.resolveLlm = () => ({ usable: false, via: 'none', why: 'no usable LLM route selected' });
    f.deps.isTty = () => false;
    f.deps.confirmLogin = async () => { throw new Error('must not prompt'); };
    f.deps.openGui = async () => false;
    const result = await runStart({ json: true }, f.deps);
    expect(result).toMatchObject({ exitCode: 1, llm: 'missing', daemon: 'running', surface: 'none' });
    expect(result.steps.find((step) => step.id === 'login')?.status).toBe('skipped');
    expect(result.steps.find((step) => step.id === 'open-gui')?.detail).toBe('Open manually: http://127.0.0.1:45678/app/');
    expect(f.output).toHaveLength(1);
  });

  test('non-TTY TUI cannot launch and leaves a safe JSON failure', async () => {
    const f = fixture();
    f.deps.isTty = () => false;
    const result = await runStart({ tui: true, json: true }, f.deps);
    expect(result).toMatchObject({ exitCode: 1, daemon: 'running', surface: 'none' });
    expect(result.steps.find((step) => step.id === 'open-tui')).toMatchObject({ status: 'failed', detail: 'TUI requires a TTY' });
    expect(f.calls).toEqual(['detect', 'health']);
    expect(JSON.parse(f.output[0]!)).toEqual(result);
  });

  test('failed login leaves a non-secret next action while GUI remains usable', async () => {
    const f = fixture();
    f.deps.detect = async () => [];
    f.deps.resolveLlm = () => ({ usable: false, via: 'none', why: 'no usable LLM route selected' });
    f.deps.confirmLogin = async () => true;
    f.deps.login = async () => { throw new Error('sk-my-secret-token'); };
    const result = await runStart({}, f.deps);
    expect(result).toMatchObject({ exitCode: 0, llm: 'missing', surface: 'gui' });
    expect(result.steps.find((step) => step.id === 'login')?.status).toBe('failed');
    expect(f.output.join('\n')).toContain('elanous login openai-codex');
    expect(f.output.join('\n')).not.toContain('sk-my-secret-token');
  });

  test('discovery exception is unknown, never prompts or claims a missing LLM even if GUI opens', async () => {
    const f = fixture();
    f.deps.detect = async () => { throw new Error('sk-my-secret-token'); };
    f.deps.resolveLlm = () => { throw new Error('sk-my-secret-token'); };
    f.deps.confirmLogin = async () => { f.calls.push('confirm'); return true; };
    const result = await runStart({}, f.deps);
    expect(result).toMatchObject({ exitCode: 1, llm: 'unknown', daemon: 'running', surface: 'gui' });
    expect(result.steps.find((step) => step.id === 'detect-llm')).toMatchObject({ status: 'failed' });
    expect(result.steps.find((step) => step.id === 'login')).toMatchObject({ status: 'skipped' });
    expect(f.calls).toEqual(['health', 'gui:http://127.0.0.1:45678/app/']);
    expect(f.output.join('\n')).toContain('LLM status unknown; discovery failed');
    expect(f.output.join('\n')).not.toContain('LLM not configured');
    expect(f.output.join('\n')).not.toContain('sk-my-secret-token');
  });

  test('post-login discovery exception is unknown in secret-free JSON despite GUI success', async () => {
    const f = fixture();
    let attempts = 0;
    f.deps.detect = async () => { if (++attempts === 1) return []; throw new Error('sk-my-secret-token'); };
    f.deps.resolveLlm = () => {
      if (attempts > 1) throw new Error('sk-my-secret-token');
      return { usable: false, via: 'none', why: 'no usable LLM route selected' };
    };
    f.deps.confirmLogin = async () => true;
    f.deps.login = async () => true;
    const result = await runStart({}, f.deps);
    expect(result).toMatchObject({ exitCode: 1, llm: 'unknown', surface: 'gui' });
    expect(result.steps.find((step) => step.id === 'login')).toMatchObject({ status: 'failed', detail: 'LLM discovery after login failed' });
    expect(f.output.join('\n')).toContain('LLM status unknown; discovery failed');
    expect(f.output.join('\n')).not.toContain('LLM not configured');
    expect(f.output.join('\n')).not.toContain('sk-my-secret-token');
    expect(JSON.stringify(result)).not.toContain('sk-my-secret-token');

    const json = fixture();
    json.deps.detect = async () => { throw new Error('sk-my-secret-token'); };
    json.deps.resolveLlm = () => { throw new Error('sk-my-secret-token'); };
    const jsonResult = await runStart({ json: true }, json.deps);
    expect(JSON.parse(json.output[0]!)).toEqual(jsonResult);
    expect(jsonResult).toMatchObject({ exitCode: 1, llm: 'unknown', surface: 'gui' });
    expect(json.output).toHaveLength(1);
    expect(json.output[0]).not.toContain('sk-my-secret-token');
  });

  test('command registration dispatches --tui --json without changing any other commands', async () => {
    const f = fixture();
    f.deps.openTui = async (json) => { f.calls.push(`tui:${json}`); return 0; };
    const program = new Command();
    program.exitOverride();
    program.command('existing').action(() => { f.calls.push('existing'); });
    registerStartCommand(program, f.deps);
    expect(program.commands.map((command) => command.name())).toEqual(['existing', 'start']);
    await program.parseAsync(['start', '--tui', '--json'], { from: 'user' });
    expect(f.calls).toEqual(['detect', 'health', 'tui:true']);
    expect(JSON.parse(f.output[0]!)).toMatchObject({ exitCode: 0, surface: 'tui' });
    await program.parseAsync(['existing'], { from: 'user' });
    expect(f.calls.at(-1)).toBe('existing');
  });

  test('default health probes the injected daemon and the opened address is its pwa url', async () => {
    const healthUrls: string[] = [];
    const opened: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      healthUrls.push(String(input));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      const result = await runStart({}, {
        detect: async () => [candidate],
        resolveLlm: () => ({ usable: true, provider: 'openai-codex', via: 'login', why: 'LLM via login (openai-codex)' }),
        isTty: () => true,
        resolveEndpoint: () => INJECTED,
        recordHealthUrl: (url) => healthUrls.push(`recorded:${url}`),
        openGui: async (url) => { opened.push(url); return true; },
        output: () => {},
      });
      expect(healthUrls).toContain('http://127.0.0.1:45678/v1/health');
      expect(healthUrls).toContain('recorded:http://127.0.0.1:45678/v1/health');
      expect(opened[0]).toBe('http://127.0.0.1:45678/app/');
      expect(result.steps.find((step) => step.id === 'open-gui')?.detail.startsWith('Opened http://127.0.0.1:45678/app/')).toBe(true);
      expect(healthUrls.join(' ')).not.toContain('31415');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a null endpoint is treated as no daemon and never probes 31415', async () => {
    const fetched: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetched.push(String(input));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      const result = await runStart({ json: true }, {
        detect: async () => [candidate],
        resolveLlm: () => ({ usable: true, provider: 'openai-codex', via: 'login', why: 'LLM via login (openai-codex)' }),
        isTty: () => true,
        resolveEndpoint: () => null,
        launch: async () => ({ exitCode: 0 }),
        sleep: async () => {},
        openGui: async (url) => { fetched.push(`gui:${url}`); return true; },
        output: () => {},
      });
      expect(fetched).toEqual([]);
      expect(result.daemon).toBe('failed');
      expect(result.surface).toBe('none');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('after launch the address is resolved again, so the opened url is the daemon that just started', async () => {
    let launched = false;
    const opened: string[] = [];
    const result = await runStart({}, {
      detect: async () => [candidate],
      resolveLlm: () => ({ usable: true, provider: 'openai-codex', via: 'login', why: 'LLM via login (openai-codex)' }),
      isTty: () => true,
      health: async () => launched,
      launch: async () => { launched = true; return { exitCode: 0 }; },
      sleep: async () => {},
      resolveEndpoint: () => launched
        ? { ...INJECTED, baseUrl: 'http://127.0.0.1:31420', healthUrl: 'http://127.0.0.1:31420/v1/health', pwaUrl: 'http://127.0.0.1:31420/app/' }
        : null,
      openGui: async (url) => { opened.push(url); return true; },
      output: () => {},
    });
    expect(result.daemon).toBe('started');
    expect(opened).toEqual(['http://127.0.0.1:31420/app/']);
  });
});
