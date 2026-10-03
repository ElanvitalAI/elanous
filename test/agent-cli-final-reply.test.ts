import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const cliModule = new URL('../src/cli/agent-cli.ts', import.meta.url).pathname;

function probe(json: boolean, enableTools = true, finalAfterTool = true, mode: 'tool' | 'text-only' = 'tool'): { stdout: string; status: number } {
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
    if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
    return { status: child.exitCode, stdout: new TextDecoder().decode(child.stdout) };
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

describe('agent CLI reply', () => {
  test('--json reply and finalReply contain only the final message; transcript preserves all deltas', () => {
    const { stdout } = probe(true);
    const value = JSON.parse(stdout.trim());
    expect(value.reply).toBe('Final answer.');
    expect(value.finalReply).toBe('Final answer.');
    expect(value.transcript).toBe('Before the tool. Final answer.');
  });

  test('human output excludes pre-tool assistant text', () => {
    const { stdout } = probe(false);
    expect(stdout).toContain('Final answer.');
    expect(stdout).not.toContain('Before the tool.');
  });

  test('an empty post-tool message does not repeat the pre-tool answer', () => {
    const value = JSON.parse(probe(true, true, false).stdout.trim());
    expect(value.reply).toBe('');
    expect(value.finalReply).toBe('Before the tool.');
    expect(value.transcript).toBe('Before the tool. ');
    expect(probe(false, true, false).stdout).not.toContain('Before the tool.');
  });

  test('text-only mode returns its body without tool callbacks in the child stdout JSON', () => {
    const { stdout, status } = probe(true, false, true, 'text-only');
    expect(status).toBe(0);
    const value = JSON.parse(stdout.trim());
    expect(value.reply).toBe('Answer without deltas.');
    expect(value.transcript).toBe('Answer without deltas.');
    expect(value.finalReply).toBe('Answer without deltas.');
  });

  test('tool-enabled turn without tool calls or deltas falls back to returned text', () => {
    const value = JSON.parse(probe(true, true, true, 'text-only').stdout.trim());
    expect(value.reply).toBe('Answer without deltas.');
    expect(value.transcript).toBe('Answer without deltas.');
    expect(value.finalReply).toBe('Answer without deltas.');
    expect(probe(false, true, true, 'text-only').stdout).toContain('Answer without deltas.');
  });
});
