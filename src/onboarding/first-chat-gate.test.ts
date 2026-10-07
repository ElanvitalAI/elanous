import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUserConfig } from '../user-config.js';
import { UNATTENDED_SETUP_COMMAND } from './entry-hints.js';
import { firstChatGate, type FirstChatGateDeps } from './first-chat-gate.js';
import { runFirstRun } from './first-run.js';

afterEach(() => { process.exitCode = 0; });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'first-chat-gate-'));
  const path = join(dir, 'config.json');
  return { path, cfg: buildUserConfig(path), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('non-TTY detects a subscription via first run and continues without the wizard', async () => {
  const f = fixture();
  try {
    let firstRuns = 0;
    let interactive = 0;
    const lines: string[] = [];
    const deps: FirstChatGateDeps = {
      isTTY: false,
      runFirstRun: (args) => {
        firstRuns++;
        expect(args).toMatchObject({ config: f.cfg, isTTY: false });
        return runFirstRun({ ...args, path: f.path, detectProviders: async () => [
          { provider: 'openai-codex', auth: 'oauth', source: 'test', available: true, rank: 0 },
        ] });
      },
      runInteractive: async () => { interactive++; return true; },
      print: (line) => lines.push(line),
    };
    expect(await firstChatGate(f.cfg, deps)).toBe('continue');
    expect(firstRuns).toBe(1);
    expect(interactive).toBe(0);
    expect(lines).toEqual([]);
    expect(buildUserConfig(f.path).onboarding.ready).toBe(true);
    expect(buildUserConfig(f.path).llm.provider).toBe('openai-codex');
  } finally { f.cleanup(); }
});

test('non-TTY without detected LLM prints one next step and stops with rc 2', async () => {
  const f = fixture();
  try {
    process.exitCode = 0;
    let firstRuns = 0;
    let interactive = 0;
    const lines: string[] = [];
    expect(await firstChatGate(f.cfg, {
      isTTY: false,
      runFirstRun: (args) => {
        firstRuns++;
        return runFirstRun({ ...args, path: f.path, detectProviders: async () => [] });
      },
      runInteractive: async () => { interactive++; return true; },
      print: (line) => lines.push(line),
    })).toBe('stop');
    expect(firstRuns).toBe(1);
    expect(interactive).toBe(0);
    expect(lines).toEqual([`다음: elanous setup llm (또는 ${UNATTENDED_SETUP_COMMAND})`]);
    expect(process.exitCode).toBe(2);
    expect(buildUserConfig(f.path).onboarding.ready).toBeUndefined();
  } finally { f.cleanup(); }
});

test('non-TTY already ready continues without running first run or wizard', async () => {
  const f = fixture();
  try {
    f.cfg.onboarding.ready = true;
    let firstRuns = 0;
    let interactive = 0;
    expect(await firstChatGate(f.cfg, {
      isTTY: false,
      runFirstRun: async () => { firstRuns++; return { outcome: 'needs-llm', inputs: 0 }; },
      runInteractive: async () => { interactive++; return false; },
      print: () => { throw new Error('printed'); },
    })).toBe('continue');
    expect(firstRuns).toBe(0);
    expect(interactive).toBe(0);
  } finally { f.cleanup(); }
});

test('TTY uses the existing interactive entry and returns its result', async () => {
  const f = fixture();
  try {
    let firstRuns = 0;
    let interactive = 0;
    expect(await firstChatGate(f.cfg, {
      isTTY: true,
      runFirstRun: async () => { firstRuns++; return { outcome: 'ready', inputs: 0 }; },
      runInteractive: async () => { interactive++; return false; },
      print: () => { throw new Error('printed'); },
    })).toBe('stop');
    expect(interactive).toBe(1);
    expect(firstRuns).toBe(0);
  } finally { f.cleanup(); }
});

test('completed setup continues without either setup path', async () => {
  const f = fixture();
  try {
    f.cfg.onboarding.completed = true;
    let firstRuns = 0;
    let interactive = 0;
    expect(await firstChatGate(f.cfg, {
      isTTY: true,
      runFirstRun: async () => { firstRuns++; return { outcome: 'ready', inputs: 0 }; },
      runInteractive: async () => { interactive++; return false; },
      print: () => { throw new Error('printed'); },
    })).toBe('continue');
    expect(firstRuns).toBe(0);
    expect(interactive).toBe(0);
  } finally { f.cleanup(); }
});
