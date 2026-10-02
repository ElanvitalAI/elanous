import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import { defaultProbeHostEnvironment, defaultReadInstallPrefix, formatDoctorReport as renderDoctorReport, humanBreaks, registerDoctorCommand, runDoctor, setFetchHealthSpawnForTest, summarizeDoctorCapabilities } from './doctor-cli.js';
import { checkReadiness } from './doctor-readiness.js';
import { applySudoFixes } from './doctor-fix.js';
import type { UserConfig } from '../user-config.js';

const example = [
  'ENV_ONLY=',
  'CACHE_ONLY=',
  'TAVILY_API_KEY=',
  'ELEVENLABS_API_KEY=',
  'FIRECRAWL_API_KEY=',
  'MISSING_KEY=',
].join('\n');

const userConfig = (apiKey = '') => ({
  registry: { discovery: { firecrawl: { apiKey } } },
}) as UserConfig;

function options(overrides: Parameters<typeof runDoctor>[0] = {}) {
  return {
    repositoryRoot: '/repo',
    readFile: (path: string) => path === '/repo/.env.example' ? example : '',
    exists: () => false,
    env: {},
    userConfig: userConfig(),
    // Existing cases assert the credential report. Readiness is injected so they
    // never touch gh, HTTP, PATH, or ~/.elanous. The readiness section is covered below.
    readiness: {
      provider: 'grok',
      codexLogin: false,
      ghOnPath: true,
      ghAuthStatus: 0,
      pathEntries: ['/usr/bin'],
      installPrefix: null,
      health: { daemonSha: 'abc123def' },
      codeRevision: 'abc123def456',
      platform: 'darwin' as const,
    },
    ...overrides,
  };
}

const resources = `resources:
  - env: [TAVILY_API_KEY]
    free_fallback: use the free search route
  - env: [ELEVENLABS_API_KEY]
    required_for: [tts, streaming-stt]
  - env: [ENV_ONLY]
  - env: [MISSING_KEY]
    free_fallback: ""
`;

const formatDoctorReport = (report: Parameters<typeof renderDoctorReport>[0]) => renderDoctorReport(report, { credentials: true });

function credentialBlock(formatted: string, name: string, nextName?: string): string {
  const start = formatted.indexOf(`${name}:`);
  const end = nextName === undefined ? formatted.length : formatted.indexOf(`${nextName}:`, start + 1);
  if (start < 0 || end < 0) throw new Error(`could not isolate ${name} output block`);
  return formatted.slice(start, end);
}

describe('doctor CLI', () => {
  test('doctor --json reports three modes and human output adds only the mode section', async () => {
    const outputs: string[] = [];
    const program = new Command();
    const cfg = { ...userConfig(), modelTier: { llm: 'best' }, llm: { autoRoute: { enabled: true } } } as UserConfig;
    const deps = options({ userConfig: cfg, env: { ENV_ONLY: 'secret' } });
    const before = runDoctor(options({ userConfig: userConfig(), env: { ENV_ONLY: 'secret' } }));
    const after = runDoctor(deps);
    expect(after.ok).toBe(true);
    expect(after.credentials).toEqual(before.credentials);
    expect(after.capabilitySummary).toEqual(before.capabilitySummary);
    expect(after.readiness).toEqual(before.readiness);
    expect(after.requiredMissing).toEqual(before.requiredMissing);
    expect(after.modes?.map(({ id, value, source, usedByChat }) => ({ id, value, source, usedByChat }))).toEqual([
      { id: 'model-tier', value: 'best', source: 'config', usedByChat: false },
      { id: 'auto-route', value: true, source: 'config', usedByChat: false },
      { id: 'fast-mode', value: 'none', source: 'none', usedByChat: false },
    ]);
    registerDoctorCommand(program, { ...deps, out: { log: (line) => outputs.push(line) }, setExitCode: () => {} });
    await program.parseAsync(['doctor'], { from: 'user' });
    await program.parseAsync(['doctor', '--json'], { from: 'user' });
    const text = outputs[0]!;
    const json = JSON.parse(outputs[1]!);
    expect(json.modes).toEqual(after.modes);
    expect(json.credentials).toEqual(before.credentials);
    expect(json.readiness).toEqual(before.readiness);
    expect(text.split('\n').filter((line) => line.startsWith('  smart·') || line.startsWith('  빠른 모드:'))).toEqual([
      '  smart·등급: best(설정) · 대화에 안 쓰임 — 대화 턴 모델 선택에 쓰이지 않는다(표시·전환 계획만)',
      '  smart·자동 라우팅: true(설정) · 대화에 안 쓰임 — 오토파일럿 턴만 읽는다 · 켜기 = elanous config set llm.autoRoute.enabled true',
      '  빠른 모드: none(없음) · 대화에 안 쓰임 — 스위치 없음(분류기 호출부 0)',
    ]);
    const baseline = renderDoctorReport({ ...after, modes: undefined });
    const modeLines = text.split('\n').filter((line) => line.startsWith('  smart·') || line.startsWith('  빠른 모드:'));
    expect(text.startsWith(`${baseline}\n모드:\n${modeLines.join('\n')}\nLocal LLM:\n`)).toBe(true);
  });

  test('humanBreaks hides development notes and keeps user-facing prose after removing source paths', () => {
    for (const value of [
      'unmeasured',
      '4 test errors on a fresh Linux machine',
      '19 test failures on a fresh Linux machine',
      'measured with 75% capacity',
      'quota-exhausted run',
      'postmortem classified the run',
      'Chrome 을 못 찾았다',
    ]) expect(humanBreaks(value)).toBeUndefined();
    expect(humanBreaks('measured with 75% quota in the postmortem')).toBeUndefined();
    expect(humanBreaks('Browser automation is unavailable — src/browser-cdp/client.ts:23')).toBe('Browser automation is unavailable');
    expect(humanBreaks('Browser automation is unavailable')).toBe('Browser automation is unavailable');
  });

  test('an empty readiness report prints English headings and no action items', () => {
    const formatted = renderDoctorReport({ ok: true, credentials: [], externalCommands: [], readiness: { items: [] } });
    expect(formatted).toStartWith('Readiness:\nNothing to do.\nCredentials:');
    expect(formatted).toContain('Available:\n  None.\nUnavailable:\n  None.');
  });

  test('default shows readiness and action items before a one-line credentials summary; --credentials reveals details without changing JSON', async () => {
    const report = runDoctor(options({
      env: { ENV_ONLY: 'secret' },
      readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : '',
      readiness: { provider: 'auto', usableLlm: { usable: false, via: 'none', why: 'no usable LLM route selected' } },
    }));
    const plain = renderDoctorReport(report);
    const detailed = renderDoctorReport(report, { credentials: true });
    expect(plain.startsWith('Readiness:')).toBe(true);
    expect(plain).toContain('To do (1): provider-decision — each line above ends with its fix');
    expect(plain.indexOf('To do (1):')).toBeLessThan(plain.indexOf('Credentials: 1/6 resolved'));
    expect(plain).not.toContain('ENV_ONLY: resolved');
    expect(plain).not.toContain('Free fallback:');
    expect(detailed).toContain('ENV_ONLY: resolved (env)');
    expect(detailed).toContain('Free fallback: use the free search route');
    const outputs: string[] = [];
    const program = new Command();
    registerDoctorCommand(program, { ...options({ readiness: { provider: 'auto', usableLlm: { usable: false, via: 'none', why: 'no usable LLM route selected' } }, env: { ENV_ONLY: 'secret' } }),
      out: { log: (value) => outputs.push(value) }, setExitCode: () => {} });
    await program.parseAsync(['doctor'], { from: 'user' });
    await program.parseAsync(['doctor', '--credentials'], { from: 'user' });
    await program.parseAsync(['doctor', '--json'], { from: 'user' });
    await program.parseAsync(['doctor', '--json', '--credentials'], { from: 'user' });
    expect(outputs[0]).not.toContain('ENV_ONLY: resolved');
    expect(outputs[1]).toContain('ENV_ONLY: resolved (env)');
    expect(JSON.parse(outputs[2]!)).toEqual(JSON.parse(outputs[3]!));
  });

  test('human-readable Free fallback removes source paths and internal notes but JSON keeps catalog prose', () => {
    const report = runDoctor(options({ readFile: (path) => path === '/repo/.env.example' ? 'TAVILY_API_KEY=\nAPIFY_TOKEN=\n'
      : path === '/repo/catalog/resources.yaml' ? `resources:\n  - env: [TAVILY_API_KEY]\n    required_for: [web-search]\n    free_fallback: "ddg + jina — skills/omni-crawl/src/free.ts (freeAvailable() is unconditionally true)"\n  - env: [APIFY_TOKEN]\n    required_for: [x-scraping]\n    free_fallback: "None for its declared purpose. Measured: skills/omni-crawl/scripts/main.ts:386 throws APIFY_TOKEN 미설정"\n` : '' }));
    const plain = renderDoctorReport(report);
    const detailed = renderDoctorReport(report, { credentials: true });
    expect(plain).toContain('free alternative: ddg + jina');
    expect(plain).not.toContain('skills/omni-crawl/');
    expect(detailed).not.toContain('skills/omni-crawl/');
    expect(detailed).not.toContain('Measured:');
    expect(JSON.stringify(report)).toContain('skills/omni-crawl/scripts/main.ts:386');
    const catalog = runDoctor(options({
      repositoryRoot: process.cwd(),
      readFile: (path) => readFileSync(path, 'utf8'),
      exists: () => false,
      env: {},
      userConfig: userConfig(),
    }));
    const freeLines = renderDoctorReport(catalog, { credentials: true }).split('\n').filter((line) => /Free fallback|free alternative/.test(line));
    expect(freeLines.length).toBeGreaterThan(0);
    expect(freeLines.filter((line) => /\b(?:src|skills|scripts|catalog|test)\/|\b[\w-]+\.ts(?::\d+)?|MEASURED|Measured:|📏|CHANGED/.test(line))).toEqual([]);
  });

  test('without an LLM --advise retains the exact original table and exit code, with a one-line setup hint', async () => {
    const run = async (args: string[]) => {
      const lines: string[] = [];
      const codes: number[] = [];
      const program = new Command();
      registerDoctorCommand(program, {
        ...options({ readiness: { provider: 'auto', usableLlm: { usable: false, via: 'none', why: 'no usable LLM route selected' } },
          readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/external-commands.yaml' ? 'commands:\n  - name: git\n    tier: required\n' : '',
          commandExists: () => false }),
        resolveAdviceProvider: () => ({ provider: 'auto', model: '(none)', auth: 'none' }),
        out: { log: (line) => lines.push(line) }, setExitCode: (code) => codes.push(code),
      });
      await program.parseAsync(['doctor', ...args], { from: 'user' });
      return { text: lines.join('\n'), codes };
    };
    const base = await run([]);
    const advised = await run(['--advise']);
    const hint = 'LLM 없음 — 구독이 있으면 `elanous llm detect --probe --apply`, 없으면 `elanous login openai-codex`(기기 코드) 뒤 다시 `elanous doctor --advise`';
    expect(advised.text).toBe(`${base.text}\n${hint}`);
    expect(advised.codes).toEqual(base.codes);
    const json = await run(['--advise', '--json']);
    expect(JSON.parse(json.text).advise).toMatchObject({ ok: false, provider: 'auto', model: '(none)', reason: hint });
  });

  test('no-LLM advice uses the measured provider-decision remedy rather than inventing a command', async () => {
    const lines: string[] = [];
    const program = new Command();
    registerDoctorCommand(program, {
      ...options({ readiness: { provider: 'auto', usableLlm: { usable: false, via: 'none', why: 'no usable LLM route selected' } },
        checkReadiness: (deps) => {
          const readiness = checkReadiness(deps);
          readiness.items.find((item) => item.id === 'provider-decision')!.remedy = 'elanous login openai-codex --device';
          return readiness;
        } }),
      resolveAdviceProvider: () => ({ provider: 'auto', model: '(none)', auth: 'none' }),
      out: { log: (line) => lines.push(line) }, setExitCode: () => {},
    });
    await program.parseAsync(['doctor', '--advise', '--json'], { from: 'user' });
    const result = JSON.parse(lines.at(-1)!);
    expect(result.readiness.items.find((item: { id: string }) => item.id === 'provider-decision').remedy).toBe('elanous login openai-codex --device');
    expect(result.advise.reason).toContain('`elanous login openai-codex --device`');
  });

  test('doctor --advise passes the detected locale to the LLM prompt', async () => {
    const previous = process.env.ELANOUS_LANG;
    const lines: string[] = [];
    let prompt = '';
    try {
      process.env.ELANOUS_LANG = 'ko';
      const program = new Command();
      registerDoctorCommand(program, {
        ...options({ readiness: { provider: 'grok', serviceFile: null, health: null } }),
        resolveAdviceProvider: () => ({ provider: 'grok', model: 'grok-test', auth: 'oauth' }),
        adviseLlm: async (text) => { prompt = text; return JSON.stringify({ summary: '요약', order: [], manual: [] }); },
        out: { log: (line) => lines.push(line) }, setExitCode: () => {},
      });
      await program.parseAsync(['doctor', '--advise', '--json'], { from: 'user' });
      const sent = JSON.parse(prompt);
      expect(sent.instruction).toContain('Write summary, why and manual in Korean.');
      expect(sent.readiness.find((item: { id: string }) => item.id === 'service-version'))
        .toMatchObject({ status: 'ok', evidence: 'no service installed; nothing to compare' });
      expect(JSON.parse(lines.at(-1)!).advise.summary).toBe('요약');
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_LANG;
      else process.env.ELANOUS_LANG = previous;
    }
  });

  test('--advise --fix executes only selected catalog repairs after consent and keeps manual suggestions read-only', async () => {
    const outputs: string[] = [];
    const confirmed: string[] = [];
    const previews: string[] = [];
    const program = new Command();
    registerDoctorCommand(program, {
      ...options({ readiness: { provider: 'grok', installPrefix: null, platform: 'linux', distro: 'amzn2', rgOnPath: false, tmpdirSameFsAsBunCache: false } }),
      home: '/tmp/doctor-advice-fixture', cacheDir: '/tmp/doctor-advice-fixture/cache',
      installStaticTool: () => ({ ok: true, detail: 'installed' }), readdir: () => [],
      resolveAdviceProvider: () => ({ provider: 'grok', model: 'grok-test', auth: 'oauth' }),
      adviseLlm: async () => JSON.stringify({ summary: 'install rg first', order: [{ readinessId: 'harness-tools', fixId: 'static-tools', why: 'needed' }], manual: ['login by hand'] }),
      adviceInteractive: true,
      confirmAdvice: async (message) => { confirmed.push(message); return true; },
      out: { log: (line) => outputs.push(line) }, err: { error: (line) => previews.push(line) }, setExitCode: () => {},
    });
    await program.parseAsync(['doctor', '--advise', '--fix', '--json'], { from: 'user' });
    const output = JSON.parse(outputs.at(-1)!);
    expect(confirmed).toEqual(['위 1개를 실행할까요? [y/N] ']);
    expect(output.advise).toMatchObject({ ok: true, provider: 'grok', model: 'grok-test', dropped: 0 });
    expect(output.results.items.every((item: { id: string; reason?: string }) => item.id === 'static-tools' || item.reason === 'not selected')).toBe(true);
    expect(output.advise.manual).toEqual(['login by hand']);
    expect(previews[0]).toContain('순서  항목  수리 id  이유');
  });
  test('--advise --fix --yes routes selected git-install through the catalog installer only', async () => {
    const lines: string[] = [];
    let gitRuns = 0;
    let staticRuns = 0;
    const program = new Command();
    registerDoctorCommand(program, {
      ...options({ readiness: { provider: 'grok', platform: 'linux', distro: 'debian', rgOnPath: false },
        readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/external-commands.yaml' ? 'commands:\n  - name: git\n    tier: required\n' : '',
        commandExists: (name) => name === 'apt-get' }),
      platform: 'linux', isRoot: true,
      resolveAdviceProvider: () => ({ provider: 'grok', model: 'grok-test', auth: 'oauth' }),
      adviseLlm: async () => JSON.stringify({ summary: 'git first', order: [{ readinessId: 'gh-auth', fixId: 'git-install', why: 'needed' }], manual: [] }),
      runGitInstallCommand: () => { gitRuns++; return { status: 0 }; },
      installStaticTool: () => { staticRuns++; return { ok: true, detail: 'unexpected' }; },
      out: { log: (line) => lines.push(line) }, setExitCode: () => {},
    });
    await program.parseAsync(['doctor', '--advise', '--fix', '--yes', '--json'], { from: 'user' });
    const result = JSON.parse(lines.at(-1)!);
    expect(result.advise.ok).toBe(true);
    expect(result.gitInstall.ran).toBe(true);
    expect(gitRuns).toBeGreaterThan(0);
    expect(staticRuns).toBe(0);
    expect(result.results.items.every((item: { reason?: string }) => item.reason === 'not selected')).toBe(true);
  });

  test('advised repairs execute in displayed order across git and catalog, not in catalog order', async () => {
    const events: string[] = [];
    const lines: string[] = [];
    const program = new Command();
    registerDoctorCommand(program, {
      ...options({ readiness: { provider: 'grok', installPrefix: null, platform: 'linux', distro: 'debian', ghOnPath: false, rgOnPath: false, ghVersion: '1.0.0', pythonEnv: { status: 'fixable', evidence: 'venv missing' } },
        readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/external-commands.yaml' ? 'commands:\n  - name: git\n    tier: required\n' : '',
        commandExists: (name) => name === 'apt-get' }),
      isRoot: true, platform: 'linux',
      resolveAdviceProvider: () => ({ provider: 'grok', model: 'grok-test', auth: 'oauth' }),
      adviseLlm: async () => JSON.stringify({ summary: 'ordered', order: [
        { readinessId: 'python-env', fixId: 'python-env', why: 'first' },
        { readinessId: 'gh-auth', fixId: 'git-install', why: 'second' },
        { readinessId: 'harness-tools', fixId: 'static-tools', why: 'third' },
      ], manual: [] }),
      pythonSetup: () => { events.push('python-env'); return 0; },
      recheckPythonEnv: () => 'ok',
      runGitInstallCommand: (command, args) => { if (command === 'git' && args[0] === 'init') { expect(args[1]).toStartWith(join(tmpdir(), 'elanous-doctor-git-')); events.push('git-install'); } return { status: 0 }; },
      installStaticTool: () => { events.push('static-tools'); return { ok: true, detail: 'installed' }; },
      smokeCheck: () => true,
      out: { log: (line) => lines.push(line) }, setExitCode: () => {},
    });
    await program.parseAsync(['doctor', '--advise', '--fix', '--yes', '--json'], { from: 'user' });
    expect(events).toEqual(['python-env', 'git-install', 'static-tools']);
    expect(JSON.parse(lines.at(-1)!).results.items.filter((item: { result: string }) => item.result === 'fixed').map((item: { id: string }) => item.id)).toEqual(['python-env', 'static-tools']);
  });

  test('advised fix cannot select repairs of credential stores or configuration files', async () => {
    const lines: string[] = [];
    let prompt = '';
    const program = new Command();
    registerDoctorCommand(program, {
      ...options({ readiness: {
        provider: 'grok', serviceFile: { path: '/unit.service', text: 'Environment=OPENROUTER_API_KEY=sk-or-v1-secret' },
      } }),
      resolveAdviceProvider: () => ({ provider: 'grok', model: 'grok-test', auth: 'oauth' }),
      adviseLlm: async (text) => { prompt = text; return JSON.stringify({ summary: 'move credential', order: [{ readinessId: 'service-secrets', fixId: 'service-secrets', why: 'suggested' }], manual: [] }); },
      out: { log: (line) => lines.push(line) }, setExitCode: () => {},
    });
    await program.parseAsync(['doctor', '--advise', '--json'], { from: 'user' });
    const advice = JSON.parse(lines.at(-1)!).advise;
    expect(advice.order).toEqual([]);
    expect(advice.dropped).toBe(1);
    expect(JSON.parse(prompt).plan.some((item: { id: string }) => ['service-secrets', 'service-file', 'key-cache-permissions', 'private-files'].includes(item.id))).toBe(false);
  });

  test('service-file in the real plan is rejected by advice and never rewritten on --yes', async () => {
    const lines: string[] = [];
    const writes: string[] = [];
    const unit = '/opt/elanous/versions/1.0/node_modules/elanous/bin/elanous.mjs';
    let prompt = '';
    const program = new Command();
    registerDoctorCommand(program, {
      ...options({ readiness: { provider: 'grok', platform: 'linux', serviceFile: { path: '/unit.service', text: `ExecStart=${unit}` } },
        exists: (path) => path === '/opt/elanous/current/node_modules/elanous/' }),
      readFile: (path) => path === '/repo/.env.example' ? example : path === '/unit.service' ? `ExecStart=${unit}` : '',
      writeFile: (path) => { writes.push(path); },
      resolveAdviceProvider: () => ({ provider: 'grok', model: 'grok-test', auth: 'oauth' }),
      adviseLlm: async (text) => { prompt = text; return JSON.stringify({ summary: 'rewrite', order: [{ readinessId: 'service-file', fixId: 'service-file', why: 'change unit' }], manual: [] }); },
      out: { log: (line) => lines.push(line) }, setExitCode: () => {},
    });
    await program.parseAsync(['doctor', '--advise', '--fix', '--yes', '--json'], { from: 'user' });
    const result = JSON.parse(lines.at(-1)!);
    expect(result.plan.items.find((item: { id: string }) => item.id === 'service-file')?.status).toBe('fixable');
    expect(JSON.parse(prompt).plan.some((item: { id: string }) => item.id === 'service-file')).toBe(false);
    expect(result.advise).toMatchObject({ order: [], dropped: 1 });
    expect(result.results.items.find((item: { id: string }) => item.id === 'service-file')).toMatchObject({ result: 'skipped', reason: 'not selected' });
    expect(writes).toEqual([]);
  });

  test('--advise refuses sudo/restart side channels before running doctor', async () => {
    for (const flag of ['--sudo', '--restart']) {
      const errors: string[] = [];
      const codes: number[] = [];
      const program = new Command();
      registerDoctorCommand(program, {
        ...options(), err: { error: (line) => errors.push(line) }, setExitCode: (code) => codes.push(code),
      });
      await program.parseAsync(['doctor', '--advise', '--fix', '--yes', flag], { from: 'user' });
      expect(errors[0]).toContain('--advise does not run');
      expect(codes).toEqual([1]);
    }
  });

  test('failed advice with --yes still leaves LLM credential migration unselected', async () => {
    const lines: string[] = [];
    let migrated = 0;
    const program = new Command();
    registerDoctorCommand(program, {
      ...options({ readiness: { provider: 'auto', serviceFile: { path: '/unit.service', text: 'Environment=OPENROUTER_API_KEY=sk-or-v1-secret' } } }),
      resolveAdviceProvider: () => ({ provider: 'auto', model: '(none)', auth: 'none' }),
      writeFile: () => { migrated++; },
      out: { log: (line) => lines.push(line) }, setExitCode: () => {},
    });
    await program.parseAsync(['doctor', '--advise', '--fix', '--yes', '--json'], { from: 'user' });
    const result = JSON.parse(lines.at(-1)!);
    expect(result.advise.ok).toBe(false);
    expect(result.results.items.every((item: { id: string; result: string }) => item.id !== 'service-secrets' || item.result === 'skipped')).toBe(true);
    expect(migrated).toBe(0);
  });

  test('advised --fix --yes only executes ids from the model-vetted plan when the plan changes', async () => {
    const lines: string[] = [];
    let migrated = 0;
    const program = new Command();
    registerDoctorCommand(program, {
      ...options({ readiness: { provider: 'grok', serviceFile: { path: '/unit.service', text: 'Environment=OPENROUTER_API_KEY=sk-or-v1-secret' } } }),
      resolveAdviceProvider: () => ({ provider: 'grok', model: 'grok-test', auth: 'oauth' }),
      adviseLlm: async () => JSON.stringify({ summary: 'empty order', order: [], manual: [] }),
      writeFile: () => { migrated++; },
      out: { log: (line) => lines.push(line) }, setExitCode: () => {},
    });
    await program.parseAsync(['doctor', '--advise', '--fix', '--yes', '--json'], { from: 'user' });
    expect(JSON.parse(lines.at(-1)!).results.items.every((item: { reason?: string }) => item.reason === 'not selected')).toBe(true);
    expect(migrated).toBe(0);
  });

  test('successful --advise --fix without consent stays read-only', async () => {
    const lines: string[] = [];
    let applied = 0;
    const program = new Command();
    registerDoctorCommand(program, {
      ...options({ readiness: { provider: 'grok', platform: 'linux', distro: 'amzn2', rgOnPath: false } }),
      resolveAdviceProvider: () => ({ provider: 'grok', model: 'grok-test', auth: 'oauth' }),
      adviseLlm: async () => JSON.stringify({ summary: 'rg first', order: [{ readinessId: 'harness-tools', fixId: 'static-tools', why: 'needed' }], manual: [] }),
      adviceInteractive: false,
      installStaticTool: () => { applied++; return { ok: true, detail: 'unexpected' }; },
      out: { log: (line) => lines.push(line) }, setExitCode: () => {},
    });
    await program.parseAsync(['doctor', '--advise', '--fix', '--json'], { from: 'user' });
    expect(JSON.parse(lines.at(-1)!).advise.ok).toBe(true);
    expect(applied).toBe(0);
  });

  test('failed advice falls back to the deterministic --fix plan and never runs a model-selected repair', async () => {
    const lines: string[] = [];
    const program = new Command();
    registerDoctorCommand(program, {
      ...options({ readiness: { provider: 'grok', rgOnPath: false, platform: 'linux', distro: 'amzn2' } }),
      resolveAdviceProvider: () => ({ provider: 'grok', model: 'grok-test', auth: 'oauth' }),
      adviseLlm: async () => 'not JSON',
      installStaticTool: () => { throw new Error('unexpected repair'); },
      out: { log: (line) => lines.push(line) }, setExitCode: () => {},
    });
    await program.parseAsync(['doctor', '--advise', '--fix', '--json'], { from: 'user' });
    const result = JSON.parse(lines.at(-1)!);
    expect(result.advise).toMatchObject({ ok: false, reason: 'invalid JSON' });
    expect(result.plan.items.some((item: { id: string }) => item.id === 'static-tools')).toBe(true);
    expect(result.results).toBeUndefined();
  });

  test('failed advice --fix --yes applies the same non-advisable and advisable repairs as plain --fix --yes', async () => {
    const homes = [mkdtempSync(join(tmpdir(), 'elanous-doctor-base-')), mkdtempSync(join(tmpdir(), 'elanous-doctor-failed-advice-'))];
    const run = async (args: string[], home: string) => {
      const lines: string[] = [];
      const executed: string[] = [];
      const program = new Command();
      registerDoctorCommand(program, {
        ...options({
          env: { SHELL: '/bin/bash' },
          exists: existsSync,
          readFile: (path) => path === '/repo/.env.example' ? example : path.startsWith(home) ? readFileSync(path, 'utf8') : '',
          readiness: { provider: 'grok', platform: 'linux', distro: 'amzn2', rgOnPath: false, tmpdirSameFsAsBunCache: false },
        }),
        home,
        resolveAdviceProvider: () => ({ provider: 'grok', model: 'grok-test', auth: 'oauth' }),
        adviseLlm: async () => 'not JSON',
        installStaticTool: () => { executed.push('static-tools'); return { ok: true, detail: 'installed' }; },
        smokeCheck: () => true,
        out: { log: (line) => lines.push(line) }, setExitCode: () => {},
      });
      await program.parseAsync(['doctor', ...args, '--json'], { from: 'user' });
      const result = JSON.parse(lines.at(-1)!);
      return { plan: result.plan.items, items: result.results.items, executed, advice: result.advise };
    };
    try {
      const plain = await run(['--fix', '--yes'], homes[0]!);
      const failed = await run(['--advise', '--fix', '--yes'], homes[1]!);
      for (const result of [plain, failed]) {
        expect(result.plan.find((item: { id: string }) => item.id === 'bun-tmpdir')?.status).toBe('fixable');
        expect(result.plan.find((item: { id: string }) => item.id === 'static-tools')?.status).toBe('fixable');
        expect(result.items.find((item: { id: string }) => item.id === 'bun-tmpdir')?.result).toBe('fixed');
        expect(result.items.find((item: { id: string }) => item.id === 'static-tools')?.result).toBe('fixed');
        expect(result.executed).toEqual(['static-tools']);
      }
      expect(failed.advice).toMatchObject({ ok: false, reason: 'invalid JSON' });
      expect(failed.items.map((item: { id: string; result: string; reason?: string }) => ({ id: item.id, result: item.result, reason: item.reason })))
        .toEqual(plain.items.map((item: { id: string; result: string; reason?: string }) => ({ id: item.id, result: item.result, reason: item.reason })));
    } finally {
      for (const home of homes) rmSync(home, { recursive: true, force: true });
    }
  });

  test('--advise --fix --yes with no LLM falls back to the deterministic catalog', async () => {
    const lines: string[] = [];
    let staticRuns = 0;
    const program = new Command();
    registerDoctorCommand(program, {
      ...options({ readiness: { provider: 'auto', usableLlm: { usable: false, via: 'none', why: 'no usable LLM route selected' }, platform: 'linux', distro: 'amzn2', rgOnPath: false } }),
      resolveAdviceProvider: () => ({ provider: 'auto', model: '(none)', auth: 'none' }),
      installStaticTool: () => { staticRuns++; return { ok: true, detail: 'unexpected' }; },
      out: { log: (line) => lines.push(line) }, setExitCode: () => {},
    });
    await program.parseAsync(['doctor', '--advise', '--fix', '--yes', '--json'], { from: 'user' });
    expect(JSON.parse(lines.at(-1)!).advise.ok).toBe(false);
    expect(staticRuns).toBeGreaterThan(0);
  });

  test('--advise --fix failure retains the old git-install consent path', async () => {
    const lines: string[] = [];
    let gitRuns = 0;
    const program = new Command();
    registerDoctorCommand(program, {
      ...options({ readiness: { provider: 'auto', usableLlm: { usable: false, via: 'none', why: 'no usable LLM route selected' } },
        readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/external-commands.yaml' ? 'commands:\n  - name: git\n    tier: required\n' : '',
        commandExists: () => false }),
      platform: 'linux',
      resolveAdviceProvider: () => ({ provider: 'auto', model: '(none)', auth: 'none' }),
      gitInteractive: true,
      isRoot: true,
      commandExists: (name) => name === 'apt-get',
      readiness: { distro: 'debian' },
      confirmGitInstall: async () => { gitRuns++; return true; },
      runGitInstallCommand: () => { gitRuns++; return { status: 0 }; },
      out: { log: (line) => lines.push(line) }, setExitCode: () => {},
    });
    await program.parseAsync(['doctor', '--advise', '--fix', '--json'], { from: 'user' });
    expect(JSON.parse(lines.at(-1)!).advise.ok).toBe(false);
    expect(gitRuns).toBeGreaterThan(0);
  });

  test('missing required git fails, prints a platform fix, and JSON lists requiredMissing; optional commands do not fail', async () => {
    const catalog = 'commands:\n  - name: git\n    tier: required\n  - name: optional-tool\n    tier: capability\n';
    for (const installed of [false, true]) {
      for (const json of [false, true]) {
        const output: string[] = [];
        const codes: number[] = [];
        const program = new Command();
        registerDoctorCommand(program, {
          ...options({
            platform: 'linux', readiness: { distro: 'debian' },
            readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/external-commands.yaml' ? catalog : '',
            commandExists: (name) => name === 'sudo' || name === 'apt-get' || (installed && name === 'git'),
          }),
          out: { log: (line) => output.push(line) }, setExitCode: (code) => codes.push(code),
        });
        await program.parseAsync(['doctor', ...(json ? ['--json'] : [])], { from: 'user' });
        if (json) expect(JSON.parse(output[0]!).requiredMissing).toEqual(installed ? [] : ['git']);
        else if (!installed) {
          expect(output[0]).toContain('⛔ Required commands missing: git');
          expect(output[0]).toContain('git: missing (required)\n  Fix: sudo apt-get update && sudo apt-get install -y git');
        }
        expect(codes).toEqual(installed ? [] : [1]);
      }
    }
  });

  test('default git installer sends child stdout off the JSON CLI stdout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-doctor-json-git-'));
    try {
      writeFileSync(join(dir, 'sudo'), '#!/bin/sh\nprintf "installer-output\\n"\n', { mode: 0o755 });
      writeFileSync(join(dir, 'git'), '#!/bin/sh\nprintf "git version fake\\n"\n', { mode: 0o755 });
      const script = `import { Command } from 'commander';
import { registerDoctorCommand } from './src/cli/doctor-cli.ts';
const program = new Command();
let gitChecks = 0;
registerDoctorCommand(program, {
  repositoryRoot: '/repo', platform: 'linux', readiness: { distro: 'debian' },
  readFile: (path) => path === '/repo/.env.example' ? 'ONE_KEY=\\n' : path === '/repo/catalog/external-commands.yaml' ? 'commands:\\n  - name: git\\n    tier: required\\n' : '',
  commandExists: (name) => name === 'sudo' || name === 'apt-get' || (name === 'git' && ++gitChecks > 1),
  userConfig: { registry: { discovery: { firecrawl: {} } } }, env: { PATH: process.env.PATH },
  cacheDir: ${JSON.stringify(dir)}, exists: () => false,
});
await program.parseAsync(['doctor', '--fix', '--yes', '--json'], { from: 'user' });`;
      const result = spawnSync(process.execPath, ['-e', script], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
      });
      expect(result.error).toBeUndefined();
      expect(result.stdout).not.toContain('installer-output');
      expect(result.stdout).not.toContain('git version fake');
      expect(result.stderr).toContain('installer-output');
      expect(result.stderr).toContain('git version fake');
      expect(JSON.parse(result.stdout).gitInstall).toMatchObject({ ran: true, ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);

  test('a broken required command fails but missing optional commands do not', async () => {
    const broken = formatDoctorReport({ ok: true, credentials: [], externalCommands: [
      { name: 'required-tool', tier: 'required', status: 'broken' },
      { name: 'optional-tool', tier: 'capability', status: 'missing' },
    ] });
    expect(broken).toContain('⛔ Required commands missing: required-tool');
    const both = formatDoctorReport({ ok: true, credentials: [], externalCommands: [
      { name: 'git', tier: 'required', status: 'missing' },
      { name: 'bun', tier: 'required', status: 'broken' },
    ] });
    expect(both).toContain('⛔ Required commands missing: git, bun');
    const brokenOutput: string[] = [];
    const brokenCodes: number[] = [];
    const brokenProgram = new Command();
    registerDoctorCommand(brokenProgram, {
      ...options({
        platform: 'darwin',
        readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/external-commands.yaml'
          ? 'commands:\n  - name: node-pty\n    tier: required\n    probe: native-module\n  - name: optional-tool\n    tier: capability\n' : '',
        loadNativeModule: () => true,
        resolveNativeModuleDir: () => '/mod/node-pty',
        isExecutable: () => false,
        commandExists: () => false,
      }),
      out: { log: (line) => brokenOutput.push(line) }, setExitCode: (code) => brokenCodes.push(code),
    });
    await brokenProgram.parseAsync(['doctor'], { from: 'user' });
    expect(brokenOutput[0]).toContain('⛔ Required commands missing: node-pty');
    expect(brokenOutput[0]).toContain('node-pty: broken (required)');
    expect(brokenCodes).toEqual([1]);
    const output: string[] = [];
    const codes: number[] = [];
    const program = new Command();
    registerDoctorCommand(program, {
      ...options({
        platform: 'darwin',
        readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/external-commands.yaml' ? 'commands:\n  - name: required-tool\n    tier: required\n  - name: optional-tool\n    tier: capability\n' : '',
        commandExists: (name) => name === 'required-tool',
      }),
      out: { log: (line) => output.push(line) }, setExitCode: (code) => codes.push(code),
    });
    await program.parseAsync(['doctor', '--json'], { from: 'user' });
    expect(JSON.parse(output[0]!).requiredMissing).toEqual([]);
    expect(codes).toEqual([]);
  });

  test('joins resource metadata by env name while preserving absent fields and conditional formatting', () => {
    const report = runDoctor(options({ readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : '' }));

    expect(report.credentials.find((item) => item.name === 'TAVILY_API_KEY')).toMatchObject({ freeFallback: 'use the free search route' });
    expect(report.credentials.find((item) => item.name === 'ELEVENLABS_API_KEY')).toMatchObject({ requiredFor: ['tts', 'streaming-stt'] });
    expect(report.credentials.find((item) => item.name === 'MISSING_KEY')).toMatchObject({ freeFallback: '' });
    expect(report.credentials.find((item) => item.name === 'ENV_ONLY')).not.toHaveProperty('requiredFor');
    expect(report.credentials.find((item) => item.name === 'ENV_ONLY')).not.toHaveProperty('freeFallback');
    const formatted = formatDoctorReport(report);
    expect(formatted).toContain('Required for: tts, streaming-stt');
    expect(formatted).toContain('Free fallback: use the free search route');
    expect(credentialBlock(formatted, 'MISSING_KEY')).toContain('Free fallback: ');
    expect(formatted).not.toMatch(/ENV_ONLY: [^\n]*\n  Required for:/);
    const elevenLabsBlock = credentialBlock(formatted, 'ELEVENLABS_API_KEY', 'FIRECRAWL_API_KEY');
    expect(elevenLabsBlock).toContain('Required for: tts, streaming-stt');
    expect(elevenLabsBlock).not.toContain('Free fallback:');
  });

  test('partitions mapped and unresolved unmapped credentials while preserving resolved unmapped detail', () => {
    const credentials = [
      { name: 'AVAILABLE_KEY', resolved: true, source: 'env' as const, note: 'resolved from environment', requiredFor: ['tts'] },
      { name: 'UNAVAILABLE_KEY', resolved: false, source: 'unresolved' as const, note: 'not configured', requiredFor: ['web-search'], freeFallback: 'use local search' },
      { name: 'UNKNOWN_KEY', resolved: false, source: 'unresolved' as const, note: 'not configured' },
      { name: 'EMPTY_UNKNOWN_KEY', resolved: false, source: 'unresolved' as const, note: 'not configured', requiredFor: [] },
      { name: 'RESOLVED_UNMAPPED_KEY', resolved: true, source: 'env' as const, note: 'resolved from environment' },
      { name: 'RESOLVED_EMPTY_MAPPING_KEY', resolved: true, source: 'env' as const, note: 'resolved from environment', requiredFor: [] },
    ];
    const summary = summarizeDoctorCapabilities(credentials);
    const formatted = formatDoctorReport({ ok: true, credentials, externalCommands: [] });
    const categorizedCredentials = new Set([
      ...summary.available.map((item) => item.credential),
      ...summary.unavailable.map((item) => item.credential),
      ...summary.unknownCredentials,
    ]);
    // ⛔ 모집단을 «결함이 빠지도록» 정의하지 않는다. 이전 판은 resolved 이면서 requiredFor 가 빈 자격을
    //    이 집합에서 «제외»해서 전체성 단언이 공허하게 참이 됐다.
    //    📏 2026-09-21: 그 탄에 실물 doctor 에서 자격 넷이 세 묶음 «어디에도» 없었다.
    const summaryTarget = new Set(credentials.map((credential) => credential.name));

    expect(summary.available).toEqual([{ credential: 'AVAILABLE_KEY', name: 'tts' }]);
    expect(summary.unavailable).toEqual([{ credential: 'UNAVAILABLE_KEY', name: 'web-search', freeFallback: 'use local search' }]);
    expect(summary.unknownCredentials).toEqual(['UNKNOWN_KEY', 'EMPTY_UNKNOWN_KEY', 'RESOLVED_UNMAPPED_KEY', 'RESOLVED_EMPTY_MAPPING_KEY']);
    expect(categorizedCredentials).toEqual(summaryTarget);
    expect(formatted).toContain('Available:\n  tts — unlocked by AVAILABLE_KEY');
    expect(formatted).toContain('Unavailable:\n  web-search — unlock with UNAVAILABLE_KEY; free alternative: use local search');
    expect(formatted).toContain('Unknown by credential:\n  UNKNOWN_KEY');
    expect(formatted.indexOf('External commands:')).toBeLessThan(formatted.indexOf('Available:'));
    expect(formatted).toContain('RESOLVED_UNMAPPED_KEY: resolved (env) — resolved from environment');
    expect(formatted).toContain('RESOLVED_EMPTY_MAPPING_KEY: resolved (env) — resolved from environment');
  });

  test('appends all three capability sections after existing report output', () => {
    const report = {
      ok: true,
      credentials: [
        { name: 'AVAILABLE_KEY', resolved: true, source: 'env' as const, note: 'resolved from environment', requiredFor: ['tts'] },
        { name: 'UNAVAILABLE_KEY', resolved: false, source: 'unresolved' as const, note: 'not configured', requiredFor: ['web-search'], freeFallback: 'use local search' },
        { name: 'UNKNOWN_KEY', resolved: false, source: 'unresolved' as const, note: 'not configured' },
      ],
      externalCommands: [{ name: 'existing-command', tier: 'required', status: 'missing' as const, breaks: 'existing behavior' }],
    };

    const formatted = formatDoctorReport(report);
    const existingOutputEnd = formatted.indexOf('  Breaks: existing behavior') + '  Breaks: existing behavior'.length;

    expect(formatted).toContain('AVAILABLE_KEY: resolved (env) — resolved from environment');
    expect(formatted).toContain('existing-command: missing (required)');
    expect(formatted.indexOf('Available:')).toBeGreaterThan(existingOutputEnd);
    expect(formatted.indexOf('Available:')).toBeLessThan(formatted.indexOf('Unavailable:'));
    expect(formatted.indexOf('Unavailable:')).toBeLessThan(formatted.indexOf('Unknown by credential:'));
    expect(formatted).toContain('  tts — unlocked by AVAILABLE_KEY');
    expect(formatted).toContain('  web-search — unlock with UNAVAILABLE_KEY; free alternative: use local search');
    expect(formatted).toContain('  UNKNOWN_KEY');
  });

  test('puts an unresolved empty capability mapping only in the unknown group', () => {
    const summary = summarizeDoctorCapabilities([
      { name: 'EMPTY_MAPPING_KEY', resolved: false, source: 'unresolved', note: 'not configured', requiredFor: [] },
    ]);
    const formatted = formatDoctorReport({ ok: true, credentials: [{ name: 'EMPTY_MAPPING_KEY', resolved: false, source: 'unresolved', note: 'not configured', requiredFor: [] }], externalCommands: [] });

    expect(summary).toEqual({ available: [], unavailable: [], unknownCredentials: ['EMPTY_MAPPING_KEY'] });
    expect(formatted).toContain('Unknown by credential:\n  EMPTY_MAPPING_KEY');
    expect(formatted).not.toContain('EMPTY_MAPPING_KEY — unlocked by');
    expect(formatted).not.toContain('EMPTY_MAPPING_KEY — unlock with');
  });

  test('«풀렸는데 지도가 능력 이름을 안 갖는» 자격도 모른다 묶음에 들어간다 — 세 묶음이 전체를 덮는다', () => {
    // ⛔ 이 시험의 이전 판은 unknownCredentials: [] 를 «기대»했다 — 결함을 계약으로 굳힌 것이다.
    //    📏 2026-09-21 실물 측정: 그 판 때문에 ANTHROPIC_API_KEY·OPENAI_API_KEY·EODHD_API_KEY·
    //       GEMINI_API_KEY 넷이 doctor 산출의 세 묶음 «어디에도» 안 들어가 조용히 사라졌다.
    //    ⇒ 자격이 풀렸더라도 «무엇을 푸는지»를 모르면 그것이 맞는 답이다.
    const credentials = [
      { name: 'RESOLVED_EMPTY_MAPPING_KEY', resolved: true, source: 'env' as const, note: 'resolved from environment', requiredFor: [] },
      { name: 'RESOLVED_UNMAPPED_KEY', resolved: true, source: 'env' as const, note: 'resolved from environment' },
      { name: 'UNRESOLVED_UNMAPPED_KEY', resolved: false, source: 'unresolved' as const, note: 'not configured' },
      { name: 'MAPPED_RESOLVED_KEY', resolved: true, source: 'env' as const, note: 'resolved from environment', requiredFor: ['tts'] },
      { name: 'MAPPED_UNRESOLVED_KEY', resolved: false, source: 'unresolved' as const, note: 'not configured', requiredFor: ['ocr'] },
    ];
    const summary = summarizeDoctorCapabilities(credentials);
    const formatted = formatDoctorReport({ ok: true, credentials, externalCommands: [] });

    expect(summary.unknownCredentials).toEqual(['RESOLVED_EMPTY_MAPPING_KEY', 'RESOLVED_UNMAPPED_KEY', 'UNRESOLVED_UNMAPPED_KEY']);
    expect(summary.available.map((capability) => capability.credential)).toEqual(['MAPPED_RESOLVED_KEY']);
    expect(summary.unavailable.map((capability) => capability.credential)).toEqual(['MAPPED_UNRESOLVED_KEY']);

    // ⭐ 세 묶음이 전체를 «덮고» 서로 «안 겹친다» — 이것이 이 절의 계약이다.
    const placed = [
      ...summary.unknownCredentials,
      ...summary.available.map((capability) => capability.credential),
      ...summary.unavailable.map((capability) => capability.credential),
    ];
    expect(new Set(placed).size).toBe(placed.length);
    expect([...placed].sort()).toEqual(credentials.map((credential) => credential.name).sort());

    expect(formatted).toContain('RESOLVED_UNMAPPED_KEY: resolved (env) — resolved from environment');
    expect(formatted).not.toContain('RESOLVED_UNMAPPED_KEY — unlock with');
    expect(formatted).not.toContain('RESOLVED_UNMAPPED_KEY — unlocked by');
  });

  test('moves unresolved mapped capabilities to unavailable with their free alternative', async () => {
    const report = runDoctor(options({ readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : '' }));
    const summary = summarizeDoctorCapabilities(report.credentials);
    const formatted = formatDoctorReport(report);

    expect(summary.available).toEqual([]);
    expect(summary.unavailable).toEqual([
      { credential: 'ELEVENLABS_API_KEY', name: 'tts' },
      { credential: 'ELEVENLABS_API_KEY', name: 'streaming-stt' },
    ]);
    expect(summary.unknownCredentials).toEqual(['ENV_ONLY', 'CACHE_ONLY', 'TAVILY_API_KEY', 'FIRECRAWL_API_KEY', 'MISSING_KEY']);
    expect(formatted).toContain('Unavailable:\n  tts — unlock with ELEVENLABS_API_KEY');
    expect(formatted).toContain('Unknown by credential:\n  ENV_ONLY');

    const output: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command();
    registerDoctorCommand(program, {
      ...options({ readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : '' }),
      out: { log: (line) => output.push(line) },
      err: { error: () => {} },
      setExitCode: (code) => exitCodes.push(code),
    });
    await program.parseAsync(['node', 'elanous', 'doctor']);
    expect(output[0]).toContain('Unavailable:');
    expect(exitCodes).toEqual([]);
  });

  test('moves a resolved credential capability from unavailable to available', () => {
    const mappedExample = 'MAPPED_KEY=\nUNKNOWN_KEY=\n';
    const mappedResources = 'resources:\n  - env: [MAPPED_KEY]\n    required_for: [web-search]\n    free_fallback: use local search\n';
    const unresolved = runDoctor(options({
      readFile: (path) => path === '/repo/.env.example' ? mappedExample : path === '/repo/catalog/resources.yaml' ? mappedResources : '',
    }));
    const resolved = runDoctor(options({
      readFile: (path) => path === '/repo/.env.example' ? mappedExample : path === '/repo/catalog/resources.yaml' ? mappedResources : '',
      env: { MAPPED_KEY: 'configured' },
    }));

    expect(unresolved.capabilitySummary).toEqual({
      available: [],
      unavailable: [{ credential: 'MAPPED_KEY', name: 'web-search', freeFallback: 'use local search' }],
      unknownCredentials: ['UNKNOWN_KEY'],
    });
    expect(resolved.capabilitySummary).toEqual({
      available: [{ credential: 'MAPPED_KEY', name: 'web-search', freeFallback: 'use local search' }],
      unavailable: [],
      unknownCredentials: ['UNKNOWN_KEY'],
    });
  });

  test('renders unavailable free alternatives and an explicit empty unknown group', () => {
    const mappedExample = 'FREE_KEY=\nRESOLVED_KEY=\n';
    const mappedResources = 'resources:\n  - env: [FREE_KEY]\n    required_for: [web-search]\n    free_fallback: use local search\n  - env: [RESOLVED_KEY]\n    required_for: [tts]\n';
    const report = runDoctor(options({
      readFile: (path) => path === '/repo/.env.example' ? mappedExample : path === '/repo/catalog/resources.yaml' ? mappedResources : '',
      env: { RESOLVED_KEY: 'resolved-secret' },
    }));
    const formatted = formatDoctorReport(report);

    expect(report.capabilitySummary).toEqual({
      available: [{ credential: 'RESOLVED_KEY', name: 'tts' }],
      unavailable: [{ credential: 'FREE_KEY', name: 'web-search', freeFallback: 'use local search' }],
      unknownCredentials: [],
    });
    expect(formatted).toContain('web-search — unlock with FREE_KEY; free alternative: use local search');
    expect(formatted).toContain('Unknown by credential:\n  Empty.');
  });

  test('joins the repository catalog and omits unmeasured fallback from the ElevenLabs output block', () => {
    const root = process.cwd();
    const report = runDoctor({
      repositoryRoot: root,
      readFile: (path) => readFileSync(path, 'utf8'),
      exists: () => false,
      env: {},
      userConfig: userConfig(),
    });
    const formatted = formatDoctorReport(report);
    const tavilyBlock = credentialBlock(formatted, 'TAVILY_API_KEY', 'TAVILY_KEY');
    const elevenLabsBlock = credentialBlock(formatted, 'ELEVENLABS_API_KEY', 'GOOGLE_API_KEY');

    expect(tavilyBlock.split('\n').filter((line) => line.includes('Free fallback'))).toEqual(['  Free fallback [auto]: ddg + jina']);
    expect(tavilyBlock).not.toContain('skills/omni-crawl/src/free.ts');
    expect(tavilyBlock).not.toContain('freeAvailable()');
    expect(elevenLabsBlock).toContain('Required for: tts, streaming-stt');
    expect(elevenLabsBlock).not.toContain('Free fallback:');
  });

  test('reports a resolved catalog sibling beneath an unresolved credential without changing its resolution', () => {
    const siblingExample = 'TAVILY_API_KEY=\nTAVILY_KEY=\n';
    const siblingResources = 'resources:\n  - env: [TAVILY_API_KEY, TAVILY_KEY]\n';
    const report = runDoctor(options({
      readFile: (path) => path === '/repo/.env.example' ? siblingExample : path === '/repo/catalog/resources.yaml' ? siblingResources : '',
      env: { TAVILY_KEY: 'resolved-secret' },
    }));
    const formatted = formatDoctorReport(report);

    expect(report.credentials.find((item) => item.name === 'TAVILY_API_KEY')).toMatchObject({ resolved: false, source: 'unresolved', satisfiedBy: { name: 'TAVILY_KEY', source: 'env' } });
    expect(credentialBlock(formatted, 'TAVILY_API_KEY', 'TAVILY_KEY')).toContain('  Satisfied by: TAVILY_KEY (env)');
  });

  test('reports a resolved catalog-only sibling without adding it to the credential report', () => {
    const siblingExample = 'TAVILY_API_KEY=\n';
    const siblingResources = 'resources:\n  - env: [TAVILY_API_KEY, TAVILY_KEY]\n';
    const report = runDoctor(options({
      readFile: (path) => path === '/repo/.env.example' ? siblingExample : path === '/repo/catalog/resources.yaml' ? siblingResources : '',
      env: { TAVILY_KEY: 'resolved-secret' },
    }));
    const formatted = formatDoctorReport(report);

    expect(report.credentials).toHaveLength(1);
    expect(report.credentials.find((item) => item.name === 'TAVILY_API_KEY')).toMatchObject({ resolved: false, source: 'unresolved', satisfiedBy: { name: 'TAVILY_KEY', source: 'env' } });
    expect(formatted).toContain('  Satisfied by: TAVILY_KEY (env)');
    expect(formatted).not.toContain('TAVILY_KEY: resolved');
  });

  test('omits sibling resolution when no sibling resolves or catalog entries differ', () => {
    const siblingExample = 'PREFIX_A=\nPREFIX_B=\nOTHER_KEY=\n';
    const siblingResources = 'resources:\n  - env: [PREFIX_A, OTHER_KEY]\n  - env: [PREFIX_B]\n';
    const unresolvedReport = runDoctor(options({
      readFile: (path) => path === '/repo/.env.example' ? siblingExample : path === '/repo/catalog/resources.yaml' ? siblingResources : '',
    }));
    const separateReport = runDoctor(options({
      readFile: (path) => path === '/repo/.env.example' ? siblingExample : path === '/repo/catalog/resources.yaml' ? siblingResources : '',
      env: { PREFIX_B: 'resolved-secret' },
    }));

    expect(formatDoctorReport(unresolvedReport)).not.toContain('Satisfied by:');
    expect(separateReport.credentials.find((item) => item.name === 'PREFIX_A')).toMatchObject({ resolved: false, source: 'unresolved' });
    expect(credentialBlock(formatDoctorReport(separateReport), 'PREFIX_A', 'PREFIX_B')).not.toContain('Satisfied by:');
  });

  test('retains catalog-read failures as diagnostics without failing the credential report', () => {
    for (const readFile of [
      (path: string) => path === '/repo/.env.example' ? example : 'resources: [',
      (path: string) => path === '/repo/.env.example' ? example : (() => { throw new Error('catalog unavailable'); })(),
    ]) {
      const report = runDoctor(options({ readFile, env: { ENV_ONLY: 'unique-credential-value-not-in-report' } }));
      expect(report).toMatchObject({ ok: true, catalogMetadataUnavailable: true });
      expect(report.credentials.find((item) => item.name === 'ENV_ONLY')).toMatchObject({ resolved: true, source: 'env' });
      expect(report.credentials.every((item) => !('requiredFor' in item) && !('freeFallback' in item))).toBe(true);
      expect(formatDoctorReport(report)).toContain('Catalog metadata unavailable: could not read catalog/resources.yaml.');
      expect(JSON.stringify(report)).not.toContain('unique-credential-value-not-in-report');
    }
  });

  test('reports environment-only credentials without exposing their value', () => {
    const secret = 'do-not-print-this-secret';
    const report = runDoctor(options({ env: { ENV_ONLY: secret } }));
    const credential = report.credentials.find((item) => item.name === 'ENV_ONLY');

    expect(credential).toMatchObject({ name: 'ENV_ONLY', resolved: true, source: 'env' });
    expect(formatDoctorReport(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  test('reports cache and skill .env sources using their existing precedence', () => {
    const report = runDoctor(options({
      env: { CACHE_ONLY: 'environment-value' },
      cacheDir: '/cache',
      tavilyEnvFile: '/skill/.env',
      exists: (path) => path === '/cache/cache_only' || path === '/skill/.env',
      readFile: (path) => {
        if (path === '/repo/.env.example') return example;
        if (path === '/cache/cache_only') return 'cached-secret';
        if (path === '/skill/.env') return 'TAVILY_API_KEY=skill-secret\n';
        throw new Error(`unexpected read: ${path}`);
      },
    }));

    expect(report.credentials.find((item) => item.name === 'CACHE_ONLY')).toMatchObject({ resolved: true, source: 'cache' });
    expect(report.credentials.find((item) => item.name === 'TAVILY_API_KEY')).toMatchObject({ resolved: true, source: 'skill-env' });
    expect(JSON.stringify(report)).not.toContain('cached-secret');
    expect(JSON.stringify(report)).not.toContain('skill-secret');
  });

  test('reports Firecrawl user config ahead of environment and unresolved credentials without failing the report', () => {
    const report = runDoctor(options({
      env: { FIRECRAWL_API_KEY: 'legacy-env-value' },
      userConfig: userConfig('config-secret'),
    }));

    expect(report.ok).toBe(true);
    expect(report.credentials.find((item) => item.name === 'FIRECRAWL_API_KEY')).toMatchObject({ resolved: true, source: 'user-config' });
    expect(report.credentials.find((item) => item.name === 'MISSING_KEY')).toMatchObject({ resolved: false, source: 'unresolved' });
    expect(JSON.stringify(report)).not.toContain('config-secret');
  });

  test('uses process environment paths when no environment is injected', () => {
    const previousCacheDir = process.env.ELANOUS_KEY_CACHE_DIR;
    const previousTavilyEnvFile = process.env.TAVILY_ENV_FILE;
    process.env.ELANOUS_KEY_CACHE_DIR = '/process-cache';
    process.env.TAVILY_ENV_FILE = '/process-skill/.env';
    try {
      const report = runDoctor(options({
        env: undefined,
        exists: (path) => path === '/process-cache/cache_only' || path === '/process-skill/.env',
        readFile: (path) => {
          if (path === '/repo/.env.example') return example;
          if (path === '/process-cache/cache_only') return 'cached-secret';
          if (path === '/process-skill/.env') return 'TAVILY_API_KEY=skill-secret';
          throw new Error('unexpected local read');
        },
      }));
      expect(report.credentials.find((item) => item.name === 'CACHE_ONLY')).toMatchObject({ source: 'cache' });
      expect(report.credentials.find((item) => item.name === 'TAVILY_API_KEY')).toMatchObject({ source: 'skill-env' });
    } finally {
      if (previousCacheDir === undefined) delete process.env.ELANOUS_KEY_CACHE_DIR;
      else process.env.ELANOUS_KEY_CACHE_DIR = previousCacheDir;
      if (previousTavilyEnvFile === undefined) delete process.env.TAVILY_ENV_FILE;
      else process.env.TAVILY_ENV_FILE = previousTavilyEnvFile;
    }
  });

  test('returns a safe failure and CLI exit code when local report reads or config lookup fail', async () => {
    const readFailure = runDoctor(options({ readFile: () => { throw new Error('secret-not-found'); } }));
    const cacheFailure = runDoctor(options({
      exists: (path) => path === '/cache/cache_only',
      cacheDir: '/cache',
      readFile: (path) => path === '/repo/.env.example' ? example : (() => { throw new Error('cache-secret'); })(),
    }));
    const configFailure = runDoctor(options({ userConfig: undefined, getUserConfig: () => { throw new Error('config-secret'); } }));
    for (const report of [readFailure, cacheFailure, configFailure]) {
      expect(report).toMatchObject({ ok: false, credentials: [], reason: 'Could not build credential report from local configuration.' });
      expect(JSON.stringify(report)).not.toContain('secret');
    }

    const errors: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command();
    registerDoctorCommand(program, {
      ...options({ readFile: () => { throw new Error('secret-not-found'); } }),
      err: { error: (line) => errors.push(line) },
      out: { log: () => {} },
      setExitCode: (code) => exitCodes.push(code),
    });
    await program.parseAsync(['node', 'elanous', 'doctor']);
    expect(errors).toEqual(['Could not build credential report from local configuration.']);
    expect(exitCodes).toEqual([1]);
  });

  test('reports external command found, missing, unmeasured breaks, and platform-only skips from the catalog', () => {
    const externalCommands = `commands:
  - name: found-command
    tier: required
    breaks: boot breaks
  - name: missing-command
    tier: capability
    breaks: unmeasured
  - name: mac-command
    tier: platform
    platform: darwin
    breaks: mac-only
`;
    const report = runDoctor(options({
      readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : path === '/repo/catalog/external-commands.yaml' ? externalCommands : '',
      commandExists: (name) => name === 'found-command',
      platform: 'linux',
    }));
    const formatted = formatDoctorReport(report);

    expect(report.externalCommands).toEqual([
      { name: 'found-command', tier: 'required', status: 'found', breaks: 'boot breaks' },
      { name: 'missing-command', tier: 'capability', status: 'missing', breaks: 'unmeasured' },
      { name: 'mac-command', tier: 'platform', status: 'skipped', platform: 'darwin' },
    ]);
    expect(formatted).toContain('External commands:\nfound-command: found (required)');
    expect(formatted).toContain('missing-command: missing (capability)');
    expect(formatted).not.toContain('  Breaks:');
    expect(formatted).not.toContain('nothing breaks');
    expect(formatted).toContain('mac-command: skipped (darwin-only)');
  });

  test('missing commands omit development Breaks notes in human output but retain them in --json', async () => {
    const catalog = `commands:
  - name: unmeasured-tool
    tier: capability
    breaks: unmeasured
  - name: test-errors-tool
    tier: capability
    breaks: 4 test errors on a fresh Linux machine
`;
    const output: string[] = [];
    const program = new Command();
    registerDoctorCommand(program, {
      ...options({
        readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/external-commands.yaml' ? catalog : '',
        commandExists: () => false,
      }),
      out: { log: (line) => output.push(line) }, setExitCode: () => {},
    });
    await program.parseAsync(['doctor'], { from: 'user' });
    await program.parseAsync(['doctor', '--json'], { from: 'user' });
    expect(output[0]).toContain('unmeasured-tool: missing (capability)');
    expect(output[0]).toContain('test-errors-tool: missing (capability)');
    expect(output[0]).not.toContain('Breaks:');
    expect(output[0]).not.toContain('unmeasured-tool: missing (capability)\n  Breaks:');
    expect(JSON.parse(output[1]!).externalCommands.map((command: { breaks: string }) => command.breaks))
      .toEqual(['unmeasured', '4 test errors on a fresh Linux machine']);
  });

  test('native-module probe reports found for a loadable module and missing for an unresolvable one without throwing', () => {
    const externalCommands = `commands:
  - name: yaml
    tier: capability
    probe: native-module
  - name: definitely-missing-native-module-ffa4817b
    tier: capability
    probe: native-module
    breaks: pty control unnamed
`;
    const checked: string[] = [];
    let chromeDiscoveries = 0;
    let threw = false;
    let report: ReturnType<typeof runDoctor> | undefined;
    try {
      report = runDoctor(options({
        readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : path === '/repo/catalog/external-commands.yaml' ? externalCommands : '',
        commandExists: (name) => {
          checked.push(name);
          return false;
        },
        discoverChromeBinary: () => {
          chromeDiscoveries += 1;
          return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
        },
      }));
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(checked).toEqual([]);
    expect(chromeDiscoveries).toBe(0);
    expect(report?.ok).toBe(true);
    expect(report?.externalCommands).toEqual([
      { name: 'yaml', tier: 'capability', status: 'found' },
      { name: 'definitely-missing-native-module-ffa4817b', tier: 'capability', status: 'missing', breaks: 'pty control unnamed' },
    ]);
  });

  test('native-module probe returns missing without throwing when the loader rejects the module', () => {
    const externalCommands = `commands:
  - name: node-pty
    tier: capability
    probe: native-module
    breaks: unnamed pty absence
  - name: path-command
    tier: required
`;
    let threw = false;
    let report: ReturnType<typeof runDoctor> | undefined;
    try {
      report = runDoctor(options({
        readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : path === '/repo/catalog/external-commands.yaml' ? externalCommands : '',
        commandExists: (name) => name === 'path-command',
        loadNativeModule: () => {
          throw new Error('native binding missing');
        },
      }));
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(report?.ok).toBe(true);
    expect(report?.externalCommands.find((command) => command.name === 'node-pty')).toEqual({
      name: 'node-pty',
      tier: 'capability',
      status: 'missing',
      breaks: 'unnamed pty absence',
    });
    expect(report?.externalCommands.find((command) => command.name === 'path-command')).toEqual({
      name: 'path-command',
      tier: 'required',
      status: 'found',
    });
  });

  test('hides a missing node-pty development Breaks note without changing its fix or doctor exit code', async () => {
    const root = process.cwd();
    const catalog = readFileSync(`${root}/catalog/external-commands.yaml`, 'utf8');
    const parsed = parseYaml(catalog) as {
      commands: readonly { name?: string; breaks?: string; fix?: string; fix_broken?: string }[];
    };
    const nodePty = parsed.commands.find((command) => command.name === 'node-pty');
    expect(nodePty?.breaks).toEqual(expect.any(String));
    expect(nodePty?.fix).toEqual(expect.any(String));
    expect(nodePty?.fix_broken).toContain('chmod');

    const report = runDoctor({
      repositoryRoot: root,
      readFile: (path) => readFileSync(path, 'utf8'),
      exists: () => false,
      commandExists: () => false,
      loadNativeModule: () => false,
      env: {},
      userConfig: userConfig(),
    });
    const formatted = formatDoctorReport(report);
    const nodePtyLine = report.externalCommands.find((command) => command.name === 'node-pty');

    expect(nodePtyLine).toMatchObject({ name: 'node-pty', status: 'missing', breaks: nodePty?.breaks, fix: nodePty?.fix });
    expect(formatted).toContain('node-pty: missing (capability)');
    expect(formatted).not.toContain(`  Breaks: ${nodePty?.breaks}`);
    expect(formatted).toContain(`  Fix: ${nodePty?.fix}`);
    expect(report.ok).toBe(true);

    const output: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command();
    registerDoctorCommand(program, {
      repositoryRoot: root,
      readFile: (path) => readFileSync(path, 'utf8'),
      exists: () => false,
      commandExists: (name) => name === 'git' || name === 'bun',
      loadNativeModule: () => false,
      env: {},
      userConfig: userConfig(),
      out: { log: (line) => output.push(line) },
      err: { error: () => {} },
      setExitCode: (code) => exitCodes.push(code),
    });
    await program.parseAsync(['node', 'elanous', 'doctor']);
    expect(output[0]).toContain('node-pty: missing (capability)');
    expect(output[0]).not.toContain(`  Breaks: ${nodePty?.breaks}`);
    expect(output[0]).toContain(`  Fix: ${nodePty?.fix}`);
    expect(exitCodes).toEqual([]);
  });

  test('renders catalog fix only for missing commands and leaves found or unfixed missing output unchanged', async () => {
    const externalCommands = `commands:
  - name: missing-with-fix
    tier: capability
    breaks: unnamed pty absence
    fix: On Linux, node-pty builds when node-gyp is present
  - name: missing-without-fix
    tier: capability
    breaks: unmeasured
  - name: found-with-fix
    tier: required
    breaks: boot breaks
    fix: should not print
`;
    const report = runDoctor(options({
      readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : path === '/repo/catalog/external-commands.yaml' ? externalCommands : '',
      commandExists: (name) => name === 'found-with-fix',
    }));
    const formatted = formatDoctorReport(report);
    const missingWithoutFix = formatted.slice(
      formatted.indexOf('missing-without-fix:'),
      formatted.indexOf('found-with-fix:'),
    );
    const foundWithFix = formatted.slice(formatted.indexOf('found-with-fix:'));

    expect(report.externalCommands).toEqual([
      { name: 'missing-with-fix', tier: 'capability', status: 'missing', breaks: 'unnamed pty absence', fix: 'On Linux, node-pty builds when node-gyp is present' },
      { name: 'missing-without-fix', tier: 'capability', status: 'missing', breaks: 'unmeasured' },
      { name: 'found-with-fix', tier: 'required', status: 'found', breaks: 'boot breaks', fix: 'should not print' },
    ]);
    expect(formatted).toContain('missing-with-fix: missing (capability)\n  Breaks: unnamed pty absence\n  Fix: On Linux, node-pty builds when node-gyp is present');
    expect(missingWithoutFix).toBe('missing-without-fix: missing (capability)\n');
    expect(missingWithoutFix).not.toContain('Fix:');
    expect(foundWithFix).toContain('found-with-fix: found (required)');
    expect(foundWithFix).not.toContain('Fix:');
    expect(foundWithFix).not.toContain('Breaks:');
    expect(report.ok).toBe(true);

    const output: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command();
    registerDoctorCommand(program, {
      ...options({
        readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : path === '/repo/catalog/external-commands.yaml' ? externalCommands : '',
        commandExists: (name) => name === 'found-with-fix',
      }),
      out: { log: (line) => output.push(line) },
      err: { error: () => {} },
      setExitCode: (code) => exitCodes.push(code),
    });
    await program.parseAsync(['node', 'elanous', 'doctor']);
    expect(output[0]).toContain('  Breaks: unnamed pty absence');
    expect(output[0]).toContain('  Fix: On Linux, node-pty builds when node-gyp is present');
    expect(exitCodes).toEqual([]);
  });

  test('declares catalog fix only on the measured node-pty entry', () => {
    const catalog = parseYaml(readFileSync(`${process.cwd()}/catalog/external-commands.yaml`, 'utf8')) as {
      commands: readonly { name?: string; fix?: unknown; fix_broken?: unknown }[];
    };
    const withFix = catalog.commands.filter((command) => typeof command.fix === 'string');
    expect(withFix).toHaveLength(1);
    expect(withFix[0]).toMatchObject({ name: 'node-pty' });
    expect(String(withFix[0]?.fix)).not.toContain('node-gyp');
    expect(String(withFix[0]?.fix)).toContain('make');
    expect(String(withFix[0]?.fix)).toContain('g++');
    expect(String(withFix[0]?.fix_broken)).toContain('chmod');
    expect(String(withFix[0]?.fix_broken)).not.toContain('node-gyp');
  });

  test('uses catalog probes for Chrome discovery while preserving PATH and rejecting unknown probes', () => {
    const externalCommands = `commands:
  - name: omitted-path
    tier: required
  - name: explicit-path
    tier: capability
    probe: path
  - name: chrome
    tier: capability
    probe: chrome-discovery
    breaks: browser automation
  - name: unsupported
    tier: capability
    probe: no-such-probe
`;
    const checked: string[] = [];
    const report = runDoctor(options({
      readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : path === '/repo/catalog/external-commands.yaml' ? externalCommands : '',
      commandExists: (name) => {
        checked.push(name);
        return name === 'omitted-path';
      },
      discoverChromeBinary: () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    }));

    expect(checked).toEqual(['omitted-path', 'explicit-path']);
    expect(report.externalCommands).toEqual([
      { name: 'omitted-path', tier: 'required', status: 'found' },
      { name: 'explicit-path', tier: 'capability', status: 'missing' },
      { name: 'chrome', tier: 'capability', status: 'found', detail: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', breaks: 'browser automation' },
      { name: 'unsupported', tier: 'capability', status: 'unknown-probe', detail: 'no-such-probe' },
    ]);
    const formatted = formatDoctorReport(report);
    expect(formatted).toContain('chrome: found (capability) — /Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(formatted).toContain('unsupported: unknown-probe (capability) — no-such-probe');

    const missingChrome = runDoctor(options({
      readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : path === '/repo/catalog/external-commands.yaml' ? externalCommands : '',
      commandExists: () => false,
      discoverChromeBinary: () => null,
    }));
    expect(missingChrome.externalCommands.find((command) => command.name === 'chrome')).toEqual({ name: 'chrome', tier: 'capability', status: 'missing', breaks: 'browser automation' });
    expect(formatDoctorReport(missingChrome)).toContain('chrome: missing (capability)\n  Breaks: browser automation');
  });

  test('reports non-string probes as unknown without PATH lookup and preserves skipped platform wording', () => {
    const externalCommands = `commands:
  - name: false-probe
    tier: capability
    probe: false
  - name: numeric-probe
    tier: capability
    probe: 123
  - name: skipped-unsupported
    tier: platform
    platform: darwin
    probe: no-such-probe
    breaks: darwin-only
`;
    const checked: string[] = [];
    let chromeDiscoveries = 0;
    const report = runDoctor(options({
      readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : path === '/repo/catalog/external-commands.yaml' ? externalCommands : '',
      commandExists: (name) => {
        checked.push(name);
        return false;
      },
      discoverChromeBinary: () => {
        chromeDiscoveries += 1;
        return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      },
      platform: 'linux',
    }));

    expect(checked).toEqual([]);
    expect(chromeDiscoveries).toBe(0);
    expect(report.externalCommands).toEqual([
      { name: 'false-probe', tier: 'capability', status: 'unknown-probe', detail: 'false' },
      { name: 'numeric-probe', tier: 'capability', status: 'unknown-probe', detail: '123' },
      { name: 'skipped-unsupported', tier: 'platform', status: 'skipped', platform: 'darwin' },
    ]);
    const formatted = formatDoctorReport(report);
    expect(formatted).toContain('false-probe: unknown-probe (capability) — false');
    expect(formatted).toContain('numeric-probe: unknown-probe (capability) — 123');
    expect(formatted).toContain('skipped-unsupported: skipped (darwin-only)');
    expect(formatted).not.toContain('skipped-unsupported: skipped (darwin-only) —');
  });

  test('preserves structured unknown probes without invoking PATH or Chrome discovery', () => {
    const externalCommands = `commands:
  - name: object-probe
    tier: capability
    probe: { method: no-such-probe, fallback: false }
  - name: array-probe
    tier: capability
    probe: [no-such-probe, 123]
`;
    const checked: string[] = [];
    let chromeDiscoveries = 0;
    const report = runDoctor(options({
      readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : path === '/repo/catalog/external-commands.yaml' ? externalCommands : '',
      commandExists: (name) => {
        checked.push(name);
        return true;
      },
      discoverChromeBinary: () => {
        chromeDiscoveries += 1;
        return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      },
    }));

    expect(checked).toEqual([]);
    expect(chromeDiscoveries).toBe(0);
    expect(report.externalCommands).toEqual([
      { name: 'object-probe', tier: 'capability', status: 'unknown-probe', detail: '{"method":"no-such-probe","fallback":false}' },
      { name: 'array-probe', tier: 'capability', status: 'unknown-probe', detail: '["no-such-probe",123]' },
    ]);
    const formatted = formatDoctorReport(report);
    expect(formatted).toContain('object-probe: unknown-probe (capability) — {"method":"no-such-probe","fallback":false}');
    expect(formatted).toContain('array-probe: unknown-probe (capability) — ["no-such-probe",123]');
  });

  test('reports circular YAML probe aliases as unknown without running a detector', () => {
    const externalCommands = `commands:
  - name: circular-probe
    tier: capability
    probe: &p { self: *p }
`;
    const checked: string[] = [];
    let chromeDiscoveries = 0;
    const report = runDoctor(options({
      readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : path === '/repo/catalog/external-commands.yaml' ? externalCommands : '',
      commandExists: (name) => {
        checked.push(name);
        return true;
      },
      discoverChromeBinary: () => {
        chromeDiscoveries += 1;
        return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      },
    }));

    expect(checked).toEqual([]);
    expect(chromeDiscoveries).toBe(0);
    expect(report).toMatchObject({ ok: true });
    expect(report.externalCommands).toEqual([
      { name: 'circular-probe', tier: 'capability', status: 'unknown-probe', detail: '&a1\nself: *a1' },
    ]);
    expect(formatDoctorReport(report)).toContain('circular-probe: unknown-probe (capability) — &a1\nself: *a1');
  });

  test('resolves extensionless Windows commands through PATHEXT', () => {
    const externalCommands = 'commands:\n  - name: bun\n    tier: required\n  - name: rg\n    tier: harness\n  - name: already.cmd\n    tier: capability\n';
    const report = runDoctor(options({
      readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : path === '/repo/catalog/external-commands.yaml' ? externalCommands : '',
      env: { PATH: 'C:\\missing;C:\\tools', PATHEXT: '.EXE;.CMD' },
      pathDelimiter: ';',
      platform: 'win32',
      exists: (path) => ['C:\\tools/bun.exe', 'C:\\tools/rg.cmd', 'C:\\tools/already.cmd'].includes(path),
    }));

    expect(report.externalCommands).toEqual([
      { name: 'bun', tier: 'required', status: 'found' },
      { name: 'rg', tier: 'harness', status: 'found' },
      { name: 'already.cmd', tier: 'capability', status: 'found' },
    ]);
  });

  test('retains credential output and Commander success when the external commands catalog is unavailable', async () => {
    const report = runDoctor(options({
      readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : (() => { throw new Error('external catalog unavailable'); })(),
      env: { ENV_ONLY: 'secret' },
    }));
    const formatted = formatDoctorReport(report);
    expect(report).toMatchObject({ ok: true, externalCommands: [], externalCommandsCatalogUnavailable: true });
    expect(formatted).toContain('ENV_ONLY: resolved (env) — resolved from environment');
    expect(formatted).toContain('Required for: tts, streaming-stt');
    expect(formatted).toContain('Free fallback: use the free search route');
    expect(formatted).toContain('External commands catalog unavailable: could not read catalog/external-commands.yaml: external catalog unavailable');

    const output: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command();
    registerDoctorCommand(program, {
      ...options({
        readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : (() => { throw new Error('external catalog unavailable'); })(),
      }),
      out: { log: (line) => output.push(line) },
      err: { error: () => {} },
      setExitCode: (code) => exitCodes.push(code),
    });
    await program.parseAsync(['node', 'elanous', 'doctor']);
    expect(output[0]).toContain('External commands catalog unavailable');
    expect(exitCodes).toEqual([]);
  });

  test('distinguishes external command catalog read, parse, and commands-schema failures without losing credentials', () => {
    const failures = [
      {
        readFile: (path: string) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : (() => { throw new Error('permission denied'); })(),
        diagnostic: 'could not read catalog/external-commands.yaml: permission denied',
      },
      {
        readFile: (path: string) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : 'commands: [',
        diagnostic: 'could not parse catalog/external-commands.yaml:',
      },
      {
        readFile: (path: string) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : 'meta: {}',
        diagnostic: 'catalog/external-commands.yaml has no commands array.',
      },
    ];

    for (const { readFile, diagnostic } of failures) {
      const report = runDoctor(options({ readFile, env: { ENV_ONLY: 'secret' } }));
      const formatted = formatDoctorReport(report);
      expect(report).toMatchObject({
        ok: true,
        externalCommands: [],
        externalCommandsCatalogUnavailable: true,
        externalCommandsCatalogReason: expect.stringContaining(diagnostic),
      });
      expect(formatted).toContain(`External commands catalog unavailable: ${diagnostic}`);
      expect(formatted).toContain('ENV_ONLY: resolved (env) — resolved from environment');
    }
  });

  test('loads every external command from the repository default catalog', () => {
    const root = process.cwd();
    const report = runDoctor({
      repositoryRoot: root,
      readFile: (path) => readFileSync(path, 'utf8'),
      exists: () => false,
      commandExists: () => false,
      env: {},
      userConfig: userConfig(),
    });

    const catalog = parseYaml(readFileSync(`${root}/catalog/external-commands.yaml`, 'utf8')) as {
      meta: { command_count: number };
      commands: readonly unknown[];
    };
    // ⛔ 저장소 실물의 «수»를 문자로 고정하지 않는다. 밖 명령을 하나 늘리면 이 시험이 깨지고,
    //    그때 깨지는 것은 «결함»이 아니라 «정상적인 증가»다.
    //    ⭐ 이 절이 지키는 것은 둘이다 — meta 가 정직한가, 그리고 산출이 그 수를 따르는가.
    //    📏 2026-09-21: 같은 모양을 이날 셀 자리에서 «셋» 고쳤다(resource-map-check · credential-name-drift · 여기).
    expect(catalog.meta.command_count).toBe(catalog.commands.length);
    expect(catalog.meta.command_count).toBeGreaterThan(10);   // 벙어리 방지
    expect(report.externalCommands).toHaveLength(catalog.meta.command_count);
    expect(formatDoctorReport(report).match(/^[-\w]+: (?:found|missing|broken|skipped) \(/gm)).toHaveLength(catalog.meta.command_count);
  });

  test('keeps an entirely unresolved diagnostic report successful through Commander', async () => {
    const output: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command();
    registerDoctorCommand(program, {
      ...options(),
      out: { log: (line) => output.push(line) },
      err: { error: () => {} },
      setExitCode: (code) => exitCodes.push(code),
    });

    await program.parseAsync(['node', 'elanous', 'doctor', '--json']);
    const report = JSON.parse(output[0]!);
    expect(report.ok).toBe(true);
    expect(report.credentials).toHaveLength(6);
    expect(report.credentials.every((item: { source: string }) => item.source === 'unresolved')).toBe(true);
    expect(exitCodes).toEqual([]);
  });

  const nodePtyCatalog = `commands:
  - name: node-pty
    tier: capability
    probe: native-module
    breaks: pty spawn-helper unusable
    fix: chmod +x spawn-helper
`;

  function nodePtyDoctor(overrides: Parameters<typeof runDoctor>[0] = {}) {
    return runDoctor(options({
      readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : path === '/repo/catalog/external-commands.yaml' ? nodePtyCatalog : '',
      ...overrides,
    }));
  }

  test('darwin loaded node-pty with a non-executable spawn-helper is broken and not found', () => {
    const executablePaths: string[] = [];
    const report = nodePtyDoctor({
      platform: 'darwin',
      loadNativeModule: (name) => name === 'node-pty',
      resolveNativeModuleDir: (name) => name === 'node-pty' ? '/mod/node-pty' : null,
      isExecutable: (path) => {
        executablePaths.push(path);
        return false;
      },
    });
    const nodePty = report.externalCommands.find((command) => command.name === 'node-pty');

    expect(nodePty?.status).toBe('broken');
    expect(nodePty?.status).not.toBe('found');
    expect(executablePaths).toEqual([`/mod/node-pty/prebuilds/darwin-${process.arch}/spawn-helper`]);
  });

  test('darwin loaded node-pty with an executable spawn-helper is found', () => {
    const report = nodePtyDoctor({
      platform: 'darwin',
      loadNativeModule: () => true,
      resolveNativeModuleDir: () => '/mod/node-pty',
      isExecutable: () => true,
    });

    expect(report.externalCommands.find((command) => command.name === 'node-pty')).toMatchObject({ status: 'found' });
  });

  test('linux loaded node-pty is found without the darwin spawn-helper capability axis', () => {
    let resolved = 0;
    let executableChecks = 0;
    const report = nodePtyDoctor({
      platform: 'linux',
      loadNativeModule: () => true,
      resolveNativeModuleDir: () => {
        resolved += 1;
        return '/mod/node-pty';
      },
      isExecutable: () => {
        executableChecks += 1;
        return false;
      },
    });

    expect(report.externalCommands.find((command) => command.name === 'node-pty')).toMatchObject({ status: 'found' });
    expect(resolved).toBe(0);
    expect(executableChecks).toBe(0);
  });

  test('native-module load failure stays missing and is not broken', () => {
    let executableChecks = 0;
    const report = nodePtyDoctor({
      platform: 'darwin',
      loadNativeModule: () => false,
      resolveNativeModuleDir: () => '/mod/node-pty',
      isExecutable: () => {
        executableChecks += 1;
        return false;
      },
    });
    const nodePty = report.externalCommands.find((command) => command.name === 'node-pty');

    expect(nodePty?.status).toBe('missing');
    expect(nodePty?.status).not.toBe('broken');
    expect(executableChecks).toBe(0);
  });

  test('throwing or unavailable capability seams keep a loaded native module found', () => {
    const throwingDir = nodePtyDoctor({
      platform: 'darwin',
      loadNativeModule: () => true,
      resolveNativeModuleDir: () => { throw new Error('dir unavailable'); },
      isExecutable: () => false,
    });
    const unavailableDir = nodePtyDoctor({
      platform: 'darwin',
      loadNativeModule: () => true,
      resolveNativeModuleDir: () => null,
      isExecutable: () => false,
    });
    const throwingExecutable = nodePtyDoctor({
      platform: 'darwin',
      loadNativeModule: () => true,
      resolveNativeModuleDir: () => '/mod/node-pty',
      isExecutable: () => { throw new Error('stat unavailable'); },
    });

    expect(throwingDir.externalCommands.find((command) => command.name === 'node-pty')?.status).toBe('found');
    expect(unavailableDir.externalCommands.find((command) => command.name === 'node-pty')?.status).toBe('found');
    expect(throwingExecutable.externalCommands.find((command) => command.name === 'node-pty')?.status).toBe('found');
  });

  test('renders existing Breaks and Fix lines for a broken native module without a new section', () => {
    const report = nodePtyDoctor({
      platform: 'darwin',
      loadNativeModule: () => true,
      resolveNativeModuleDir: () => '/mod/node-pty',
      isExecutable: () => false,
    });
    const formatted = formatDoctorReport(report);

    expect(formatted).toContain('node-pty: broken (capability)');
    expect(formatted).toContain('  Breaks: pty spawn-helper unusable');
    expect(formatted).toContain('  Fix: chmod +x spawn-helper');
    expect(formatted).not.toContain('Broken:');
    expect(formatted).not.toContain('Unusable:');
  });

  test('broken status prints catalog breaks_broken and fix_broken and missing still prints breaks and fix', () => {
    const externalCommands = `commands:
  - name: node-pty
    tier: capability
    probe: native-module
    breaks: missing module copy
    breaks_broken: spawn-helper is not executable
    fix: On Linux, node-pty builds when make and g++ are present
    fix_broken: chmod +x grants execute permission on spawn-helper
  - name: missing-command
    tier: capability
    breaks: unmeasured
    fix: install the missing command
`;
    const report = runDoctor(options({
      readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : path === '/repo/catalog/external-commands.yaml' ? externalCommands : '',
      commandExists: () => false,
      platform: 'darwin',
      loadNativeModule: (name) => name === 'node-pty',
      resolveNativeModuleDir: () => '/mod/node-pty',
      isExecutable: () => false,
    }));
    const formatted = formatDoctorReport(report);
    const nodePty = formatted.slice(formatted.indexOf('node-pty:'), formatted.indexOf('missing-command:'));

    expect(report.externalCommands.find((command) => command.name === 'node-pty')).toMatchObject({
      status: 'broken',
      breaks: 'missing module copy',
      breaks_broken: 'spawn-helper is not executable',
      fix: 'On Linux, node-pty builds when make and g++ are present',
      fix_broken: 'chmod +x grants execute permission on spawn-helper',
    });
    expect(nodePty).toContain('node-pty: broken (capability)');
    expect(nodePty).toContain('  Breaks: spawn-helper is not executable');
    expect(nodePty).toContain('  Fix: chmod +x grants execute permission on spawn-helper');
    expect(nodePty).not.toContain('node-gyp');
    expect(nodePty).not.toContain('missing module copy');
    expect(formatted).toContain('missing-command: missing (capability)\n  Fix: install the missing command');
    expect(formatted).not.toContain('Broken:');
  });

  test('broken without breaks_broken or fix_broken falls back to breaks and fix and does not throw', () => {
    const externalCommands = `commands:
  - name: node-pty
    tier: capability
    probe: native-module
    breaks: loaded but unusable
    fix: On Linux, node-pty builds when make and g++ are present
`;
    let threw = false;
    let formatted = '';
    try {
      const report = runDoctor(options({
        readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : path === '/repo/catalog/external-commands.yaml' ? externalCommands : '',
        platform: 'darwin',
        loadNativeModule: () => true,
        resolveNativeModuleDir: () => '/mod/node-pty',
        isExecutable: () => false,
      }));
      formatted = formatDoctorReport(report);
      expect(report.externalCommands.find((command) => command.name === 'node-pty')).toEqual({
        name: 'node-pty',
        tier: 'capability',
        status: 'broken',
        breaks: 'loaded but unusable',
        fix: 'On Linux, node-pty builds when make and g++ are present',
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(formatted).toContain('node-pty: broken (capability)');
    expect(formatted).toContain('  Breaks: loaded but unusable');
    expect(formatted).toContain('  Fix: On Linux, node-pty builds when make and g++ are present');
    expect(formatted).not.toContain('node-gyp');
  });

  test('live catalog broken spawn-helper guidance names chmod and not node-gyp', () => {
    const root = process.cwd();
    const report = runDoctor({
      repositoryRoot: root,
      readFile: (path) => readFileSync(path, 'utf8'),
      exists: () => false,
      commandExists: () => false,
      platform: 'darwin',
      loadNativeModule: (name) => name === 'node-pty',
      resolveNativeModuleDir: (name) => name === 'node-pty' ? '/mod/node-pty' : null,
      isExecutable: () => false,
      env: {},
      userConfig: userConfig(),
    });
    const formatted = formatDoctorReport(report);
    const start = formatted.indexOf('\nnode-pty: broken (capability)') + 1;
    const next = formatted.indexOf('\n', formatted.indexOf('  Fix:', start));
    const nodePty = formatted.slice(start, next < 0 ? undefined : next);
    const fix = nodePty.slice(nodePty.indexOf('  Fix:'));

    expect(report.externalCommands.find((command) => command.name === 'node-pty')?.status).toBe('broken');
    expect(fix).toContain('chmod');
    expect(fix).not.toContain('node-gyp');
  });

  test('marks an existing Free fallback line with auto, manual, or none without a new line', () => {
    const prose = 'use the free search route that stays exactly this long';
    for (const mode of ['auto', 'manual', 'none'] as const) {
      const formatted = formatDoctorReport({
        ok: true,
        credentials: [{
          name: 'MODE_KEY',
          resolved: false,
          source: 'unresolved',
          note: 'not configured',
          freeFallback: prose,
          freeFallbackMode: mode,
        }],
        externalCommands: [],
      });
      const block = credentialBlock(formatted, 'MODE_KEY');
      expect(block).toContain(`  Free fallback [${mode}]: ${prose}`);
      expect(block.split('\n').filter((line) => line.includes('Free fallback'))).toHaveLength(1);
      expect(block).not.toContain('Free fallback:');
    }
  });

  test('leaves a Free fallback line unchanged when the mode is absent or outside the set', () => {
    const prose = 'use the free search route';
    const base = {
      name: 'MODE_KEY',
      resolved: false as const,
      source: 'unresolved' as const,
      note: 'not configured',
      freeFallback: prose,
    };
    const absent = formatDoctorReport({ ok: true, credentials: [base], externalCommands: [] });
    expect(credentialBlock(absent, 'MODE_KEY')).toContain(`  Free fallback: ${prose}`);
    expect(credentialBlock(absent, 'MODE_KEY')).not.toContain('Free fallback [');

    let threw = false;
    let outOfSet = '';
    try {
      outOfSet = formatDoctorReport({
        ok: true,
        credentials: [{ ...base, freeFallbackMode: 'later' as never }],
        externalCommands: [],
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(credentialBlock(outOfSet, 'MODE_KEY')).toContain(`  Free fallback: ${prose}`);
    expect(credentialBlock(outOfSet, 'MODE_KEY')).not.toContain('Free fallback [');
  });

  test('reads catalog free_fallback_mode only when it is auto, manual, or none', () => {
    const catalog = `resources:
  - env: [TAVILY_API_KEY]
    free_fallback: use the free search route
    free_fallback_mode: auto
  - env: [ELEVENLABS_API_KEY]
    required_for: [tts]
    free_fallback: speak locally
    free_fallback_mode: manual
  - env: [MISSING_KEY]
    free_fallback: ""
    free_fallback_mode: none
  - env: [ENV_ONLY]
    free_fallback: keep the prose
    free_fallback_mode: later
  - env: [CACHE_ONLY]
    free_fallback: unset stays unmarked
`;
    const report = runDoctor(options({
      readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? catalog : '',
    }));
    const formatted = formatDoctorReport(report);

    expect(report.credentials.find((item) => item.name === 'TAVILY_API_KEY')?.freeFallbackMode).toBe('auto');
    expect(report.credentials.find((item) => item.name === 'ELEVENLABS_API_KEY')?.freeFallbackMode).toBe('manual');
    expect(report.credentials.find((item) => item.name === 'MISSING_KEY')?.freeFallbackMode).toBe('none');
    expect(report.credentials.find((item) => item.name === 'ENV_ONLY')).not.toHaveProperty('freeFallbackMode');
    expect(report.credentials.find((item) => item.name === 'CACHE_ONLY')).not.toHaveProperty('freeFallbackMode');
    expect(credentialBlock(formatted, 'TAVILY_API_KEY', 'ELEVENLABS_API_KEY')).toContain('  Free fallback [auto]: use the free search route');
    expect(credentialBlock(formatted, 'ELEVENLABS_API_KEY', 'FIRECRAWL_API_KEY')).toContain('  Free fallback [manual]: speak locally');
    expect(credentialBlock(formatted, 'MISSING_KEY')).toContain('  Free fallback [none]: ');
    expect(credentialBlock(formatted, 'ENV_ONLY', 'CACHE_ONLY')).toContain('  Free fallback: keep the prose');
    expect(credentialBlock(formatted, 'ENV_ONLY', 'CACHE_ONLY')).not.toContain('Free fallback [');
    expect(credentialBlock(formatted, 'CACHE_ONLY', 'TAVILY_API_KEY')).toContain('  Free fallback: unset stays unmarked');
    expect(credentialBlock(formatted, 'CACHE_ONLY', 'TAVILY_API_KEY')).not.toContain('Free fallback [');
    expect(formatted).toContain('External commands:');
  });

  test('defaultReadInstallPrefix reads $PREFIX/install.json, not the copy under current', () => {
    const packageRoot = '/opt/elanous/current/node_modules/elanous';
    const seen: string[] = [];
    const prefix = defaultReadInstallPrefix(packageRoot, (path) => {
      seen.push(path);
      return path === '/opt/elanous/install.json';
    });
    expect(prefix).toBe('/opt/elanous');
    expect(seen).toEqual(['/opt/elanous/install.json']);
    const checkout = defaultReadInstallPrefix('/src/monad-agent', (path) => path === '/src/monad-agent/.git');
    expect(checkout).toBeNull();
    // 모르면 «모른다» — 체크아웃으로 읽지 않는다(리뷰 must-fix · 2026-09-24).
    expect(defaultReadInstallPrefix('/somewhere/monad-agent', () => false)).toBeUndefined();
  });

  // 🆕 2026-09-24 — 실물: 설치본 doctor 가 「running from a checkout」이라 했다(import.meta.url 은 심링크를 풀어 판 폴더 실경로가 된다).
  test('defaultReadInstallPrefix knows the versioned layout and the old flat layout', () => {
    const versioned = defaultReadInstallPrefix('/opt/elanous/versions/1.0.0-abc/node_modules/elanous', (p) => p === '/opt/elanous/install.json');
    expect(versioned).toBe('/opt/elanous');
    const flat = defaultReadInstallPrefix('/opt/old/node_modules/elanous', (p) => p === '/opt/old/install.json');
    expect(flat).toBe('/opt/old');
  });

  test('runDoctor carries injected readiness and the text report names 준비 상태 without changing the exit code', async () => {
    const lines: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command();
    program.exitOverride();
    registerDoctorCommand(program, {
      ...options({
        readiness: {
          provider: 'openai-codex',
          usableLlm: { usable: true, provider: 'openai-codex', via: 'login', why: 'login' },
          ghOnPath: true,
          ghAuthStatus: 0,
          rgOnPath: true,
          codexOnPath: true,
          nodeOnPath: true,
          pathEntries: ['/usr/bin'],
          installPrefix: null,
          health: { daemonSha: 'abc123def' },
          codeRevision: 'abc123def4567890',
          platform: 'darwin',
        },
      }),
      out: { log: (value) => lines.push(value) },
      err: { error: () => undefined },
      setExitCode: (code) => exitCodes.push(code),
    });

    await program.parseAsync(['doctor'], { from: 'user' });

    const report = runDoctor(options({
      readiness: {
        provider: 'openai-codex',
        usableLlm: { usable: true, provider: 'openai-codex', via: 'login', why: 'login' },
        ghOnPath: true,
        ghAuthStatus: 0,
        rgOnPath: true,
        codexOnPath: true,
        nodeOnPath: true,
        pathEntries: ['/usr/bin'],
        installPrefix: null,
        health: { daemonSha: 'abc123def' },
        codeRevision: 'abc123def4567890',
        platform: 'darwin',
        serviceFile: null,
        buildToolchain: { make: true, cxx20: true },
        nodePty: 'found',
        bunVersion: '1.4.2',
        bunPin: '1.4.2',
        pythonEnv: { status: 'ok', evidence: 'python 3.12.12 (elanous-venv) · required modules import' },
        substrate: { kubernetesServiceHost: false, serviceAccountNamespace: false, dockerenv: false, containerenv: false, cgroup: null, containerEnv: null },
        docker: { onPath: false },
        kubernetes: { onPath: false },
        memory: { totalBytes: 16 * 1024 ** 3, availableBytes: 8 * 1024 ** 3, source: 'fixture' },
      },
    }));
    const formatted = lines.join('\n');
    expect(report.readiness?.items.every((entry) => entry.status === 'ok')).toBe(true);
    expect(formatted).toContain('Readiness:');
    expect(formatted).toContain('  provider-decision: ok');
    expect(formatted).toContain('  gh-auth: ok');
    expect(formatted).toContain('  install-path: ok');
    expect(formatted).toContain('  service-version: ok');
    expect(formatted.startsWith('Readiness:')).toBe(true);
    expect(formatted.indexOf('Nothing to do.')).toBeLessThan(formatted.indexOf('Credentials:'));
    expect(formatted.indexOf('Credentials:')).toBeLessThan(formatted.indexOf('External commands:'));
    expect(exitCodes).toEqual([]);
    expect(formatted).not.toContain('--fix');
  });

  test('a bad readiness item is reported and still leaves the doctor exit code unchanged', async () => {
    const lines: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command();
    program.exitOverride();
    const readiness = {
      provider: 'auto' as const,
      usableLlm: { usable: true, provider: 'openai-codex', via: 'login' as const, why: 'login' },
      ghOnPath: true,
      ghAuthStatus: 1,
      installPrefix: '/opt/elanous',
      pathEntries: ['/usr/bin'],
      health: null,
      codeRevision: 'abc123def4567890',
      platform: 'darwin' as const,
    };
    registerDoctorCommand(program, {
      ...options({ readiness }),
      out: { log: (value) => lines.push(value) },
      err: { error: () => undefined },
      setExitCode: (code) => exitCodes.push(code),
    });

    await program.parseAsync(['doctor'], { from: 'user' });

    const formatted = lines.join('\n');
    expect(formatted).toContain('Readiness:');
    expect(formatted).toContain('provider-decision: ok');
    expect(formatted).toContain('gh-auth: manual');
    expect(formatted).toContain('gh auth login');
    expect(formatted).toContain('install-path: fixable');
    expect(formatted).toContain('service-version: unknown');
    expect(exitCodes).toEqual([]);
  });

  test('injected userConfig supplies both the provider label and the resolved route, including CLI fix planning', async () => {
    const config = { ...userConfig(), llm: { provider: 'local', baseUrl: 'http://localhost:1234' } } as UserConfig;
    const lines: string[] = [];
    const program = new Command();
    registerDoctorCommand(program, {
      ...options({
        readiness: undefined,
        userConfig: config,
        getUserConfig: () => { throw new Error('must not consult another config'); },
        checkPythonEnv: () => null,
        probeBuildToolchain: () => ({ make: null, cxx20: null }),
        probeHostEnvironment: () => null,
      }),
      out: { log: (line) => lines.push(line) },
      setExitCode: () => {},
    });
    await program.parseAsync(['doctor', '--json'], { from: 'user' });
    const report = JSON.parse(lines.at(-1)!);
    expect(report.ok).toBe(true);
    expect(report.readiness.items.find((item: { id: string }) => item.id === 'provider-decision'))
      .toMatchObject({ status: 'ok', evidence: 'llm.provider=local → local-server local' });
    await program.parseAsync(['doctor', '--fix', '--json'], { from: 'user' });
    const planned = JSON.parse(lines.at(-1)!);
    expect(planned.report.readiness.items.find((item: { id: string }) => item.id === 'provider-decision'))
      .toMatchObject({ status: 'ok', evidence: 'llm.provider=local → local-server local' });
  });

  test('runDoctor --json readiness resolves an auto route independently of credential names', () => {
    const route = { usable: true, provider: 'local', via: 'local-server' as const, why: 'LLM via local-server (local)' };
    const report = runDoctor(options({
      readiness: undefined,
      userConfig: { ...userConfig(), llm: { provider: 'auto' } } as UserConfig,
      resolveLlm: () => route,
      checkPythonEnv: () => null,
      probeBuildToolchain: () => ({ make: null, cxx20: null }),
      probeHostEnvironment: () => null,
    }));
    const selected = report.readiness?.items.find((item) => item.id === 'provider-decision');
    expect(selected).toMatchObject({ status: 'ok', evidence: 'llm.provider=auto → local-server local' });
    expect(JSON.stringify(report)).not.toContain('sk-secret');
  });

  test('runDoctor resolves readiness from injected read-only lookups when readiness is omitted', () => {
    const secret = 'sk-live-runtime-must-not-leak';
    const github = 'ghp_runtimeMustNotLeak1234567890';
    const calls: string[] = [];
    const report = runDoctor(options({
      readiness: undefined,
      userConfig: { ...userConfig(), llm: { provider: github } } as unknown as UserConfig,
      env: { PATH: '/usr/bin' },
      commandExists: (name) => {
        calls.push(`exists:${name}`);
        return name === 'gh';
      },
      resolveLlm: () => {
        calls.push('route');
        return { usable: true, provider: 'openai-codex', via: 'login', why: 'login' };
      },
      codeRevision: () => 'abc123def4567890abc123def4567890abc123de',
      fetchHealth: () => ({ daemonSha: 'fffffffffff' }),
      readInstallPrefix: () => '/opt/elanous',
      ghAuthStatus: () => {
        calls.push('gh-auth');
        return 1;
      },
      checkPythonEnv: () => null,
      platform: 'darwin',
    }));
    const formatted = formatDoctorReport(report);
    const by = (id: string) => report.readiness?.items.find((entry) => entry.id === id);

    expect(calls).toContain('route');
    expect(calls).toContain('gh-auth');
    expect(by('provider-decision')).toMatchObject({ status: 'ok' });
    expect(by('gh-auth')).toMatchObject({ status: 'manual', remedy: 'gh auth login' });
    expect(by('install-path')).toMatchObject({
      status: 'fixable',
      remedy: `export PATH='/opt/elanous/bin':\"$PATH\"`,
    });
    expect(by('service-version')?.status).toBe('manual');
    expect(by('service-version')?.evidence).toContain('fffffffffff');
    expect(by('service-version')?.evidence).toContain('abc123def4567890abc123def4567890abc123de');
    expect(formatted).toContain('Readiness:');
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain(github);
    expect(JSON.stringify(report)).not.toContain('ghp_');
    expect(formatted).not.toContain(secret);
    expect(formatted).not.toContain(github);
    expect(formatted).not.toContain('ghp_');
    expect(formatted).not.toContain('--fix');
  });

  test('doctor --fix exposes harness tools and --sudo receives the same install line', async () => {
    const lines: string[] = [];
    const sudoPlans: string[][] = [];
    const sandbox = mkdtempSync(join(tmpdir(), 'elanous-doctor-harness-'));
    const calls = join(sandbox, 'calls');
    const script = `#!/bin/sh
name="${'${0##*/}'}"
case "$name:$1" in sudo:-n) exit 0 ;; esac
printf '%s|%s\\n' "$name" "$*" >> "$DOCTOR_CALLS"
case "$name" in
  sudo) if [ "$1" = -n ]; then exit 0; fi; DOCTOR_SUDO=1 "$@" ;;
  apt-get) [ "$DOCTOR_SUDO" = 1 ] || exit 20
    if [ "$1" = update ]; then : > "$DOCTOR_APT_INDEX"; else [ -f "$DOCTOR_APT_INDEX" ] || exit 21; fi ;;
  npm) [ "$DOCTOR_SUDO" = 1 ] && [ -f "$DOCTOR_APT_INDEX" ] || exit 22 ;;
esac
`;
    for (const name of ['sudo', 'apt-get', 'npm']) writeFileSync(join(sandbox, name), script, { mode: 0o755 });
    const program = new Command();
    program.exitOverride();
    registerDoctorCommand(program, {
      ...options({
        readiness: {
          distro: 'debian', ghOnPath: true, ghAuthStatus: 0,
          rgOnPath: false, codexOnPath: false, nodeOnPath: false,
        },
      }),
      out: { log: (line) => lines.push(line) },
      err: { error: () => undefined },
      setExitCode: () => undefined,
      applySudoFixes: (manual) => {
        sudoPlans.push(manual.filter((entry) => entry.id === 'harness-tools').map((entry) => entry.remedy!));
        return applySudoFixes(manual, { run: (binary, args) => {
          const ran = Bun.spawnSync({ cmd: [binary, ...args], env: { ...process.env, PATH: `${sandbox}:${process.env.PATH ?? ''}`, DOCTOR_CALLS: calls, DOCTOR_APT_INDEX: join(sandbox, 'index') }, stdout: 'pipe', stderr: 'pipe' });
          return { status: ran.exitCode, stderr: ran.stderr.toString() };
        } });
      },
    });
    try {
      await program.parseAsync(['doctor', '--fix', '--yes', '--sudo'], { from: 'user' });
      const command = 'sudo apt-get update && sudo apt-get install -y ripgrep';
      expect(lines.join('\n')).toContain('Fix plan:');
      expect(lines.join('\n')).toContain('Applied:');
      expect(lines.join('\n')).toContain(`Sudo installation: ran — ${command}`);
      expect(lines.join('\n')).not.toContain('sudo 설치:');
      expect(lines.join('\n')).toContain(`harness-tools: manual — ${command}`);
      expect(lines.join('\n')).toContain('https://nodejs.org/en/download');
      expect(sudoPlans).toEqual([[command]]);
      expect(lines.join('\n')).toContain(`ran — ${command}`);
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
        'sudo|apt-get update', 'apt-get|update', 'sudo|apt-get install -y ripgrep', 'apt-get|install -y ripgrep',
      ]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('doctor --fix uses an English git installation heading without changing its detail', async () => {
    const lines: string[] = [];
    const program = new Command();
    registerDoctorCommand(program, {
      ...options({
        platform: 'linux', readiness: { distro: 'debian' },
        readFile: (path) => path === '/repo/.env.example' ? example : path === '/repo/catalog/external-commands.yaml' ? 'commands:\n  - name: git\n    tier: required\n' : '',
        commandExists: (name) => name === 'apt-get',
      }),
      isRoot: true, gitInteractive: false,
      out: { log: (line) => lines.push(line) }, setExitCode: () => {},
    });
    await program.parseAsync(['doctor', '--fix'], { from: 'user' });
    expect(lines.join('\n')).toContain('Fix plan:');
    expect(lines.join('\n')).toContain('Git installation: 설치하지 않음 — --fix --yes 또는 대화형 동의가 필요합니다.');
    expect(lines.join('\n')).not.toContain('git 설치:');
  });

  test('doctor --fix --yes --restart uses an English service restart heading without changing the result reason', async () => {
    const lines: string[] = [];
    const program = new Command();
    registerDoctorCommand(program, {
      ...options({ readiness: { provider: 'grok', platform: 'linux', installPrefix: null, serviceFile: null } }),
      home: '/tmp/doctor-restart-heading-fixture', cacheDir: '/tmp/doctor-restart-heading-fixture/cache',
      applyServiceRestart: async () => ({ result: 'skipped', reason: 'the service already runs this code' }),
      out: { log: (line) => lines.push(line) }, setExitCode: () => {},
    });
    await program.parseAsync(['doctor', '--fix', '--yes', '--restart'], { from: 'user' });
    expect(lines.join('\n')).toContain('Fix plan:');
    expect(lines.join('\n')).toContain('Applied:');
    expect(lines.join('\n')).toContain('Service restart: skipped — the service already runs this code');
    expect(lines.join('\n')).not.toContain('서비스 재시작:');
  });

  test('unknown distro shows missing harness names in the fix plan without inventing sudo commands', async () => {
    const lines: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerDoctorCommand(program, {
      ...options({ readiness: { distro: 'unknown', ghOnPath: true, ghAuthStatus: 0, rgOnPath: false, codexOnPath: false, nodeOnPath: false } }),
      out: { log: (line) => lines.push(line) },
      err: { error: () => undefined },
      setExitCode: () => undefined,
    });
    await program.parseAsync(['doctor', '--fix'], { from: 'user' });
    expect(lines.join('\n')).toContain('harness-tools: manual — rg and codex missing from harness tools (node missing)');
    expect(lines.join('\n')).not.toMatch(/sudo (apt-get|dnf|yum|npm) install/);
  });

  test('AL2 --sudo never adds a third-party repository for rg — it names rg for manual install instead', async () => {
    // 🅢 수확 2026-09-24: AL2 기본 저장소엔 ripgrep 이 없다. 제3자 저장소(COPR)를 --sudo 가 자동으로 붙이는 것은 위험하고
    //    aarch64 에선 실행도 안 됐다(리뷰 must-fix). ⇒ 설치 줄 없음 · 근거에 «직접 설치»를 댄다.
    const commands: string[] = [];
    const lines: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerDoctorCommand(program, {
      ...options({ readiness: { distro: 'amzn2', ghOnPath: true, ghAuthStatus: 0, rgOnPath: false, codexOnPath: true, nodeOnPath: true } }),
      out: { log: (line) => lines.push(line) },
      err: { error: () => undefined },
      setExitCode: () => undefined,
      applySudoFixes: (manual) => applySudoFixes(manual, { run: (binary, args) => { commands.push([binary, ...args].join(' ')); return { status: 0, stderr: '' }; } }),
    });
    await program.parseAsync(['doctor', '--fix', '--yes', '--sudo'], { from: 'user' });
    expect(commands.some((c) => /copr|add-repo|ripgrep/.test(c))).toBe(false);
    expect(lines.join('\n')).toContain('install rg manually');
  });
  test('catalog harness commands and readiness agree on missing rg and codex', () => {
    const report = runDoctor(options({
      readiness: undefined,
      platform: 'linux',
      readFile: (path) => path === '/repo/.env.example' ? example
        : path === '/repo/catalog/external-commands.yaml' ? readFileSync('catalog/external-commands.yaml', 'utf8') : '',
      commandExists: (name) => name === 'gh',
      ghAuthStatus: () => 0,
      listAuthProviders: () => [],
      probeBuildToolchain: () => ({ make: true, cxx20: true }),
      checkPythonEnv: () => null,
      readInstallPrefix: () => null,
      fetchHealth: () => null,
    }));
    expect(report.externalCommands.filter((entry) => entry.tier === 'harness').map((entry) => [entry.name, entry.status]))
      .toEqual([['gh', 'found'], ['rg', 'missing'], ['codex', 'missing']]);
    expect(report.readiness?.items.find((entry) => entry.id === 'gh-auth')?.status).toBe('ok');
    expect(report.readiness?.items.find((entry) => entry.id === 'harness-tools'))
      .toMatchObject({ status: 'manual', evidence: expect.stringContaining('rg and codex missing') });
  });

  test('runtime PATH probes do not mark codex ready when its node interpreter is absent', () => {
    const report = runDoctor(options({
      readiness: undefined,
      platform: 'darwin',
      commandExists: (name) => name === 'gh' || name === 'rg' || name === 'codex',
      ghAuthStatus: () => 0,
      listAuthProviders: () => ['openai-codex'],
      probeBuildToolchain: () => ({ make: true, cxx20: true }),
      checkPythonEnv: () => null,
      readInstallPrefix: () => null,
      fetchHealth: () => null,
    }));
    expect(report.readiness?.items.find((entry) => entry.id === 'harness-tools'))
      .toMatchObject({ status: 'manual', remedy: 'brew install node' });
  });

  test('runtime PATH probes feed the harness item through runDoctor without treating a login as a codex binary', () => {
    const calls: string[] = [];
    const report = runDoctor(options({
      readiness: undefined,
      platform: 'darwin',
      listAuthProviders: () => ['openai-codex'],
      commandExists: (name) => { calls.push(name); return name === 'gh' || name === 'node'; },
      ghAuthStatus: () => 0,
      probeBuildToolchain: () => ({ make: true, cxx20: true }),
      checkPythonEnv: () => null,
      readInstallPrefix: () => null,
      fetchHealth: () => null,
    }));
    expect(calls).toEqual(expect.arrayContaining(['rg', 'codex', 'node']));
    expect(report.readiness?.items.find((entry) => entry.id === 'harness-tools'))
      .toMatchObject({ status: 'manual', remedy: 'brew install ripgrep && npm install -g @openai/codex' });
  });

  test('a partial readiness injection does not invent gh, checkout, or codex-login facts', () => {
    const report = runDoctor(options({
      readiness: { provider: 'auto' },
      listAuthProviders: () => {
        throw new Error('must not look up auth');
      },
      fetchHealth: () => {
        throw new Error('must not fetch health');
      },
      readInstallPrefix: () => {
        throw new Error('must not read install');
      },
      ghAuthStatus: () => {
        throw new Error('must not run gh');
      },
    }));
    const by = (id: string) => report.readiness?.items.find((entry) => entry.id === id);
    expect(by('provider-decision')?.status).toBe('unknown');
    expect(by('provider-decision')?.evidence).not.toContain('no codex login');
    expect(by('gh-auth')?.status).toBe('unknown');
    expect(by('gh-auth')?.evidence).not.toContain('not on PATH');
    expect(by('install-path')?.status).toBe('unknown');
    expect(by('install-path')?.evidence).not.toContain('checkout');
    expect(by('service-version')?.status).toBe('unknown');
  });

  test('failed runtime lookups stay unknown and a checkout with no health response is not called down', () => {
    const report = runDoctor(options({
      readiness: undefined,
      userConfig: userConfig(),
      listAuthProviders: () => {
        throw new Error('auth-secret');
      },
      commandExists: () => {
        throw new Error('path-secret');
      },
      readInstallPrefix: () => null,
      fetchHealth: () => null,
      codeRevision: () => undefined,
      platform: 'linux',
    }));
    const failedInstall = runDoctor(options({
      readiness: undefined,
      userConfig: userConfig(),
      readInstallPrefix: () => {
        throw new Error('install-secret');
      },
      fetchHealth: () => null,
      codeRevision: () => undefined,
      platform: 'linux',
    }));
    const by = (id: string) => report.readiness?.items.find((entry) => entry.id === id);
    const failed = (id: string) => failedInstall.readiness?.items.find((entry) => entry.id === id);
    const formatted = formatDoctorReport(report);
    expect(report.ok).toBe(true);
    expect(by('provider-decision')?.status).toBe('unknown');
    expect(by('gh-auth')?.status).toBe('unknown');
    expect(by('install-path')).toMatchObject({ status: 'ok' });
    expect(by('install-path')?.evidence).toContain('checkout');
    expect(failed('install-path')?.status).toBe('unknown');
    expect(failed('install-path')?.evidence).not.toContain('checkout');
    expect(JSON.stringify(failedInstall)).not.toContain('install-secret');
    expect(formatDoctorReport(failedInstall)).not.toContain('install-secret');
    expect(by('service-version')).toMatchObject({ status: 'ok', evidence: 'no service installed; nothing to compare' });
    expect(by('service-version')?.evidence).not.toMatch(/down|stopped|안 돈다/);
    expect(formatted).not.toContain('config-secret');
    expect(formatted).not.toContain('auth-secret');
    expect(JSON.stringify(report)).not.toContain('path-secret');
  });
});

describe('doctor — retired config keys', () => {
  test('names each retired key found in the config file without changing ok', () => {
    const config = JSON.stringify({ tools: { selfImplement: { decompositionShadow: { enabled: true } } } });
    const report = runDoctor(options({
      configPath: '/cfg/config.json',
      readFile: (path) => path === '/cfg/config.json' ? config : path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : '',
    }));
    expect(report.ok).toBe(true);
    expect(report.retiredConfigKeys?.map(({ path }) => path)).toEqual(['tools.selfImplement.decompositionShadow']);
    expect(formatDoctorReport(report)).toContain('Retired config key: tools.selfImplement.decompositionShadow');
  });

  test('says nothing when the config has no retired key or cannot be read', () => {
    const report = runDoctor(options({
      configPath: '/cfg/config.json',
      readFile: (path) => path === '/cfg/config.json' ? '{"tools":{}}' : path === '/repo/.env.example' ? example : path === '/repo/catalog/resources.yaml' ? resources : '',
    }));
    expect(report.retiredConfigKeys).toEqual([]);
    expect(formatDoctorReport(report)).not.toContain('Retired config key');
  });
});

describe('defaultProbeHostEnvironment (L0 · injected probes, no real docker/kubectl)', () => {
  type Run = NonNullable<Parameters<typeof defaultProbeHostEnvironment>[0]['run']>;
  const ran = (stdout: string, status = 0, stderr = ''): ReturnType<Run> => ({ status, stdout, stderr, timedOut: false, error: false });

  test('linux container: cgroup v2 `0::/` + /.dockerenv → container · docker absent · meminfo parsed', () => {
    const calls: string[] = [];
    const probe = defaultProbeHostEnvironment({
      env: {},
      platform: 'linux',
      commandExists: () => false,
      pathEntries: [],
      exists: (path) => path === '/.dockerenv',
      readText: (path) => path === '/proc/1/cgroup' ? '0::/\n' : path === '/proc/meminfo' ? 'MemTotal: 8000000 kB\nMemAvailable: 6000000 kB\n' : null,
      run: (command, args) => { calls.push([command, ...args].join(' ')); return ran(''); },
    });
    expect(calls).toEqual([]);
    const report = checkReadiness({ substrate: probe.substrate, docker: probe.docker, kubernetes: probe.kubernetes, memory: probe.memory });
    const byId = (id: string) => report.items.find((entry) => entry.id === id)!;
    expect(byId('substrate').evidence).toBe('container (/.dockerenv)');
    expect(byId('docker').status).toBe('ok');
    expect(byId('kubernetes').status).toBe('ok');
    expect(byId('memory')).toMatchObject({ status: 'ok' });
    expect(byId('memory').evidence).toContain('/proc/meminfo');
  });

  test('darwin host: engine down → no-response with OrbStack; kubectl without context stops before the API call', () => {
    const calls: string[] = [];
    const probe = defaultProbeHostEnvironment({
      env: { KUBERNETES_SERVICE_HOST: '' },
      platform: 'darwin',
      commandExists: (name) => name === 'docker' || name === 'kubectl',
      pathEntries: [],
      exists: (path) => path === '/Applications/OrbStack.app',
      readText: () => null,
      run: (command, args) => {
        calls.push([command, ...args].join(' '));
        if (command === 'docker') return ran('{"ServerVersion":""}', 1, 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n');
        if (command === 'kubectl') return ran('', 1, 'error: current-context is not set');
        if (command.endsWith('sysctl')) return ran('137438953472\n');
        return ran('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages inactive: 200.\n');
      },
    });
    expect(calls.some((call) => call.startsWith('kubectl version'))).toBe(false);
    expect(calls.some((call) => /docker (run|pull)/.test(call))).toBe(false);
    const report = checkReadiness({ platform: 'darwin', substrate: probe.substrate, docker: probe.docker, kubernetes: probe.kubernetes, memory: probe.memory });
    const byId = (id: string) => report.items.find((entry) => entry.id === id)!;
    expect(byId('substrate').evidence).toBe('host (no container or kubernetes signal)');
    expect(byId('docker')).toMatchObject({ status: 'manual', remedy: 'open -a OrbStack' });
    expect(byId('kubernetes').evidence).toContain('no context');
    expect(byId('memory').status).toBe('manual');
    expect(byId('memory').evidence).toContain('total 128.0GB');
  });

  test('a timed-out docker info is not-measured, not engine-down', () => {
    const probe = defaultProbeHostEnvironment({
      env: {}, platform: 'linux', commandExists: (name) => name === 'docker', pathEntries: [], exists: () => false, readText: () => null,
      run: () => ({ status: null, stdout: '', stderr: '', timedOut: true, error: false }),
    });
    expect(probe.docker?.info).toEqual({ kind: 'timeout' });
    expect(probe.memory).toEqual({ totalBytes: null, availableBytes: null, source: '/proc/meminfo' });
  });

  test('daemon health is probed at the injected endpoint, never a guessed port', () => {
    const health = 'http://127.0.0.1:45678/v1/health';
    const calls: string[][] = [];
    setFetchHealthSpawnForTest(((cmd: string, args: readonly string[]) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: JSON.stringify({ daemonSha: 'injected' }), stderr: '' };
    }) as typeof spawnSync);
    try {
      const report = runDoctor(options({
        readiness: undefined,
        resolveDaemonEndpoint: () => ({ healthUrl: health }),
        listAuthProviders: () => [],
        codeRevision: () => 'abc',
        readInstallPrefix: () => null,
        ghAuthStatus: () => null,
        commandExists: () => false,
      }));
      expect(report.ok).toBe(true);
      const curled = calls.filter((argv) => argv[0] === 'curl').flat();
      expect(curled).toContain(health);
      expect(curled.join(' ')).not.toContain('31415');
      expect(JSON.stringify(report.readiness)).toContain('injected');
    } finally {
      setFetchHealthSpawnForTest(null);
    }
  });

  test('a null daemon endpoint is no daemon, and health is not probed at a guessed port', () => {
    const calls: string[][] = [];
    setFetchHealthSpawnForTest(((cmd: string, args: readonly string[]) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: JSON.stringify({ daemonSha: 'should-not-run' }), stderr: '' };
    }) as typeof spawnSync);
    try {
      const report = runDoctor(options({
        readiness: undefined,
        resolveDaemonEndpoint: () => null,
        listAuthProviders: () => [],
        codeRevision: () => 'abc',
        readInstallPrefix: () => null,
        ghAuthStatus: () => null,
        commandExists: () => false,
      }));
      expect(report.ok).toBe(true);
      expect(calls.filter((argv) => argv[0] === 'curl')).toEqual([]);
      expect(JSON.stringify(report.readiness)).not.toContain('31415');
      expect(JSON.stringify(report.readiness)).not.toContain('should-not-run');
    } finally {
      setFetchHealthSpawnForTest(null);
    }
  });
});
