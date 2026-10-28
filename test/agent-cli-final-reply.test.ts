import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const cliModule = new URL('../src/cli/agent-cli.ts', import.meta.url).pathname;

function probe(json: boolean, enableTools = true, finalAfterTool = true, mode: 'tool' | 'text-only' = 'tool', expectedStatus = 0): { stdout: string; status: number } {
  const stateDir = mkdtempSync(join(tmpdir(), 'elanous-agent-reply-'));
  try {
    const child = Bun.spawnSync(['bun', '-e', `
      import { getUserConfig } from './src/user-config.ts';
      import { runChatTurnCli } from ${JSON.stringify(cliModule)};
      const cfg = getUserConfig();
      cfg.chat.toolDeny = [];
      await runChatTurnCli({
        cfg, userText: 'test', explicitSessionId: undefined, reuseActive: false,
        forceNew: true, json: ${json}, enableTools: ${enableTools},
        runTurn: async (opts) => {
          if (${JSON.stringify(mode)} === 'text-only') {
            if (${enableTools} === false && (opts.tools !== undefined || opts.dispatchTool !== undefined)) {
              throw new Error('text-only turn unexpectedly received tools');
            }
            return { provider: 'fake', model: 'fake-model', text: 'Answer without deltas.' };
          }
          opts.onDelta('Before the tool. ');
          opts.onToolCall({ id: 'fake', name: 'Read', args: {} });
          opts.onToolResult({ id: 'fake', name: 'Read', result: 'ok' });
          if (${finalAfterTool}) {
            opts.onDelta('Final ');
            opts.onDelta('answer.');
          }
          return { provider: 'fake', model: 'fake-model', text: 'Before the tool. Final answer.' };
        },
      });
    `], {
      cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: stateDir },
      stdout: 'pipe', stderr: 'pipe',
    });
    if (child.exitCode !== expectedStatus) throw new Error(`expected exit ${expectedStatus}, got ${child.exitCode}: ${new TextDecoder().decode(child.stderr)}`);
    return {
      status: child.exitCode,
      stdout: new TextDecoder().decode(child.stdout),
      stderr: new TextDecoder().decode(child.stderr),
    };
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

describe('agent CLI reply', () => {
  test('--json reply and finalReply contain only the final message; transcript preserves all deltas', () => {
    const { stdout, status } = probe(true);
    expect(status).toBe(0);
    const value = JSON.parse(stdout.trim());
    expect(value.reply).toBe('Final answer.');
    expect(value.finalReply).toBe('Final answer.');
    expect(value.incomplete).toBe(false);
    expect(value.transcript).toBe('Before the tool. Final answer.');
  });

  test('human output excludes pre-tool assistant text', () => {
    const { stdout, status } = probe(false);
    expect(status).toBe(0);
    expect(stdout).toContain('Final answer.');
    expect(stdout).not.toContain('Before the tool.');
  });

  test('an empty post-tool message is incomplete and does not promote pre-tool progress to finalReply', () => {
    const incomplete = probe(true, true, false, 'tool', 1);
    const value = JSON.parse(incomplete.stdout.trim());
    expect(value.reply).toBe('');
    expect(value.finalReply).toBe('');
    expect(value.transcript).toBe('Before the tool. ');
    expect(value.incomplete).toBe(true);
    expect(incomplete.status).toBe(1);
    const humanIncomplete = probe(false, true, false, 'tool', 1);
    expect(humanIncomplete.status).toBe(1);
    expect(humanIncomplete.stdout).not.toContain('Before the tool.');
    expect(humanIncomplete.stderr).toContain('without a final assistant reply');
  });

  test('text-only mode returns its body without tool callbacks in the child stdout JSON', () => {
    const { stdout, status } = probe(true, false, true, 'text-only');
    expect(status).toBe(0);
    const value = JSON.parse(stdout.trim());
    expect(value.reply).toBe('Answer without deltas.');
    expect(value.transcript).toBe('Answer without deltas.');
    expect(value.finalReply).toBe('Answer without deltas.');
    expect(value.incomplete).toBe(false);
  });

  test('tool-enabled turn without tool calls or deltas falls back to returned text', () => {
    const value = JSON.parse(probe(true, true, true, 'text-only').stdout.trim());
    expect(value.reply).toBe('Answer without deltas.');
    expect(value.transcript).toBe('Answer without deltas.');
    expect(value.finalReply).toBe('Answer without deltas.');
    expect(probe(false, true, true, 'text-only').stdout).toContain('Answer without deltas.');
  });
});
