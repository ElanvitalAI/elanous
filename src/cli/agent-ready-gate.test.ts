// CHAT-TOOLS-ENTRY-VIA-CORE-TURN (R2 0.3.28) — a test universe set up unattended (`onboarding.ready`, not `completed`)
// answered `chat` but `agent` refused with «No config yet — launching setup wizard». Same door as firstChatGate now.
//
// Every CLI run here is a REAL child process (simCli spawn mode, stdin 'ignore'). The `agent` action arms a 1 s
// `process.exit(0)` safety net after its turn (agent-cli.ts armAgentCliExitSafetyNet); run in-process it killed this
// test runner mid-file. This file's own process never runs the CLI main.
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simCli } from '../ux-sim/in-process-cli.js';
import { agentNeedsOnboarding } from './agent-cli.js';

// Real child CLI boots under gate-pod load can exceed Bun's 5 s default (same headroom as agent-cli.test.ts).
setDefaultTimeout(90_000);

const exitCodeAtLoad = process.exitCode;
afterAll(() => {
  // Guard: nothing in this file may leave an exit code on the runner.
  expect(process.exitCode).toBe(exitCodeAtLoad);
});

/** `--test=<dir> agent --new --json hello` as a real child: closed stdin, temp HOME/XDG, fake LLM only. */
async function agentInUniverse(onboarding: Record<string, unknown>) {
  const home = mkdtempSync(join(tmpdir(), 'elanous-agent-ready-process-'));
  const stateDir = join(home, '.elanous-test');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    onboarding, llm: { provider: 'auto', model: '', memoryJudge: { enabled: false } },
  }));
  try {
    const result = await simCli([`--test=${stateDir}`, 'agent', '--new', '--json', 'hello'], {
      mode: 'spawn', allowPaths: [['agent']], cwd: home,
      // Temp HOME/XDG so nothing reads the real ~/.elanous; ELANOUS_LLM_MODE=fake keeps the turn off any live provider.
      env: {
        PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: join(home, 'xdg'), NODE_ENV: 'test',
        ELANOUS_LLM_MODE: 'fake', ELANOUS_TEST_FAKE_LLM_RESPONSE: 'ready gate fake reply',
      },
      // Source: .rules/30-harness/testing-gates.md §R-TST36; bound the real child CLI process probe.
      timeoutMs: 60_000,
    });
    return { ...result, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('agent ready-vs-completed onboarding door', () => {
  test('a ready provider passes a non-TTY agent; an interactive or unready one still onboards', () => {
    const cfg = (onboarding: Record<string, unknown>) => ({ onboarding }) as unknown as Parameters<typeof agentNeedsOnboarding>[0];
    expect(agentNeedsOnboarding(cfg({ completed: true }), false)).toBe(false);
    expect(agentNeedsOnboarding(cfg({ completed: false, ready: true }), false)).toBe(false);
    expect(agentNeedsOnboarding(cfg({ completed: false, ready: true }), true)).toBe(true);
    expect(agentNeedsOnboarding(cfg({ completed: false }), false)).toBe(true);
  });

  test('real process: `--test=<dir> agent --new --json hello` with closed stdin and a ready config runs the fake-LLM turn', async () => {
    const result = await agentInUniverse({ completed: false, ready: true });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.output).not.toContain('No config yet');
    expect(result.output).not.toContain('setup wizard');
    expect(result.output).not.toContain('needs a configured LLM');
    // The turn ran: the JSON reply is the fake provider's scripted answer.
    const reply = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as { reply: string };
    expect(reply.reply).toContain('ready gate fake reply');
  });

  test('real process control: an unready config with closed stdin still refuses (rc 2) and runs no turn', async () => {
    const result = await agentInUniverse({ completed: false });
    expect(result.exitCode, result.output).toBe(2);
    expect(result.output).toContain('needs a configured LLM');
    expect(result.output).not.toContain('ready gate fake reply');
  });
});
