import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../src/ux-sim/mock-seat-pty-sequence.js';

// 출처: #37872 격리 PTY 진입과 각 턴의 대기 예산.
const PTY_STEP_TIMEOUT_MS = 30_000;
// 출처: #37872 두 PTY 병렬 턴 및 종료를 포함한 시험 예산.
const PTY_PARALLEL_TEST_TIMEOUT_MS = 90_000;
// 출처: #37872 단일 PTY 턴 및 종료를 포함한 시험 예산.
const PTY_SINGLE_TEST_TIMEOUT_MS = 60_000;

/** The bottom status line of the painted screen (state · session · universe · model · queue). */
const footerOf = (screen: string): string => screen.split('\n').at(-1) ?? '';

test('two isolated Next TUI PTYs each keep a selected provider for their own fake turn', async () => {
  const roots = ['codex', 'grok'].map((name) => mkdtempSync(join(tmpdir(), `next-provider-${name}-`)));
  try {
    for (const root of roots) {
      writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true },
        errorReports: { enabled: false }, llm: { provider: 'local', model: 'local-default' } }));
    }
    const expiresAt = Math.floor(Date.now() / 1000 + 3600);
    const accessToken = `e30.${Buffer.from(JSON.stringify({ exp: expiresAt })).toString('base64url')}.sig`;
    mkdirSync(join(roots[0]!, '.codex'), { recursive: true });
    writeFileSync(join(roots[0]!, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt',
      tokens: { access_token: accessToken, refresh_token: 'fixture-only', account_id: 'fixture-account' } }));

    const providers = ['openai-codex', 'grok'] as const;
    // Footer model labels as painted today: the selected provider's default model, else the config model.
    const bootModels = ['gpt-6.1-terra', 'local-default'] as const;
    const turnModels = ['gpt-6.1-terra', 'grok-4.7'] as const;
    const evidence = await Promise.all(providers.map((provider, index) => mockSeatPtySequence({
      runId: `next-provider-${index}`,
      executable: process.execPath,
      args: [join(import.meta.dir, '../bin/elanous.mjs'), '--test={root}', '--config-dir', '{root}',
        '--test-state-dir', '{root}', '--fake-llm', '--tui', 'next', ...(index === 0 ? ['--provider', provider] : [])],
      root: roots[index], rows: 30, cols: 100,
      env: { ELANOUS_SESSION_ROOT: join(roots[index]!, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ELANOUS_TEST_FAKE_LLM_RESPONSE: `REPLY_${index}` },
      ready: { label: `${provider} ready`, until: (screen) => screen.includes('○ idle')
        && footerOf(screen).includes(bootModels[index]!), timeoutMs: PTY_STEP_TIMEOUT_MS },
      steps: [...(index === 1 ? [{ label: 'session switch', text: '/provider use grok',
        until: (screen: string) => screen.includes('이 세션 다음 턴 provider: grok/grok-4.7') }] : []),
      { label: `${provider} turn`, text: `provider test ${index}`,
        until: (screen: string) => screen.includes(`REPLY_${index}`) && footerOf(screen).includes('Turn done')
          && footerOf(screen).includes(turnModels[index]!), timeoutMs: PTY_STEP_TIMEOUT_MS }],
      quitKeys: '/quit\r', exitTimeoutMs: 10_000,
    })));
    evidence.forEach((run, index) => {
      expect(run.exitCode).toBe(0);
      expect(footerOf(run.frames.at(-1)!.screen)).toContain(turnModels[index]!);
      expect(run.frames.at(-1)?.screen).toContain(`REPLY_${index}`);
      expect(JSON.parse(readFileSync(join(roots[index]!, 'config.json'), 'utf8')).llm.provider).toBe('local');
    });
  } finally {
    roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
  }
}, { timeout: PTY_PARALLEL_TEST_TIMEOUT_MS });

test('Next PTY snapshot retains a finished turn marker after the next prompt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-turn-end-marker-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true },
      errorReports: { enabled: false }, llm: { memoryJudge: { enabled: false, crossRecall: false } } }));
    const turnPrompts = ['first marker prompt', 'second marker prompt'];
    const evidence = await mockSeatPtySequence({
      runId: 'next-turn-end-marker', executable: process.execPath,
      args: [join(import.meta.dir, '../bin/elanous.mjs'), '--test={root}', '--config-dir', '{root}',
        '--test-state-dir', '{root}', '--fake-llm', '--tui', 'next'],
      root, rows: 30, cols: 100,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ELANOUS_TEST_FAKE_LLM_RESPONSE: 'MARKER_REPLY' },
      ready: { label: 'marker ready', until: 'Enter send', timeoutMs: PTY_STEP_TIMEOUT_MS },
      steps: [
        { label: 'first turn', text: turnPrompts[0],
          until: (screen: string) => screen.includes('MARKER_REPLY') && /✻ Worked for \d+s · done \d{1,2}:\d{2} (AM|PM)/.test(screen),
          timeoutMs: PTY_STEP_TIMEOUT_MS },
        { label: 'second turn', text: turnPrompts[1],
          until: (screen: string) => (screen.match(/✻ Worked for \d+s · done \d{1,2}:\d{2} (AM|PM)/g) ?? []).length === turnPrompts.length,
          timeoutMs: PTY_STEP_TIMEOUT_MS },
      ], quitKeys: '/quit\r', exitTimeoutMs: 10_000,
    });
    expect(evidence.exitCode).toBe(0);
    const screen = evidence.frames.at(-1)!.screen;
    // One history marker per sent turn (the bottom footer now says «Turn done», not a second marker).
    expect((screen.match(/✻ Worked for \d+s · done \d{1,2}:\d{2} (AM|PM)/g) ?? [])).toHaveLength(turnPrompts.length);
    expect(screen.slice(0, screen.indexOf(turnPrompts[1]!))).toContain('✻ Worked for');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: PTY_PARALLEL_TEST_TIMEOUT_MS });

test('config-dir before root provider reaches a real Grok Next TUI turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-provider-root-order-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true },
      errorReports: { enabled: false }, llm: { provider: 'local', model: 'local-default' } }));
    const evidence = await mockSeatPtySequence({
      runId: 'next-provider-root-order', executable: process.execPath,
      args: [join(import.meta.dir, '../bin/elanous.mjs'), '--config-dir', '{root}', '--tui', 'next', '--provider', 'grok'],
      root, rows: 30, cols: 100,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ELANOUS_TEST_FAKE_LLM_RESPONSE: 'ORDER_REPLY' },
      ready: { label: 'root order ready', until: (screen) => screen.includes('○ idle') && footerOf(screen).includes('grok-4.7'), timeoutMs: PTY_STEP_TIMEOUT_MS },
      steps: [{ label: 'root order turn', text: 'root order prompt',
        until: (screen) => screen.includes('ORDER_REPLY') && footerOf(screen).includes('Turn done') && footerOf(screen).includes('grok-4.7'),
        timeoutMs: PTY_STEP_TIMEOUT_MS }],
      quitKeys: '/quit\r', exitTimeoutMs: 10_000,
    });
    expect(evidence.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).llm.provider).toBe('local');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: PTY_SINGLE_TEST_TIMEOUT_MS });

test('a sticky Next TUI child sees a confirmed global switch on the next turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-provider-global-turn-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true },
      errorReports: { enabled: false }, llm: { provider: 'local', model: 'local-default' } }));
    const evidence = await mockSeatPtySequence({
      runId: 'next-provider-global-turn', executable: process.execPath,
      args: [join(import.meta.dir, '../bin/elanous.mjs'), '--config-dir', '{root}', '--tui', 'next'],
      root, rows: 30, cols: 100,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ELANOUS_TEST_FAKE_LLM_RESPONSE: 'GLOBAL_TURN_REPLY' },
      ready: { label: 'global turn ready', until: (screen) => screen.includes('○ idle') && footerOf(screen).includes('local-default'), timeoutMs: PTY_STEP_TIMEOUT_MS },
      steps: [
        { label: 'local turn', text: 'first local turn',
          until: (screen) => footerOf(screen).includes('Turn done') && footerOf(screen).includes('local-default'), timeoutMs: PTY_STEP_TIMEOUT_MS },
        { label: 'global switch', text: '/provider use grok --global --yes',
          until: (screen) => screen.includes('전역 기본 provider: grok/grok-4.7'), timeoutMs: PTY_STEP_TIMEOUT_MS },
        { label: 'grok turn', text: 'second grok turn',
          until: (screen) => footerOf(screen).includes('Turn done') && footerOf(screen).includes('grok-4.7'), timeoutMs: PTY_STEP_TIMEOUT_MS },
      ], quitKeys: '/quit\r', exitTimeoutMs: 10_000,
    });
    expect(evidence.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).llm.provider).toBe('grok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: PTY_PARALLEL_TEST_TIMEOUT_MS });
