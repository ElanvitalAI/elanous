// /term mock-device stage — invoke the production slash registry/handler with
// mocked terminal ports so subcommand combinations never need another PTY.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlashCommandRegistry } from '../dashboard/slash-runtime/registry.js';
import { createDashboardTermSlashRuntime } from '../dashboard/term-slash-runtime.js';
import { registerTermSlash, type TermSlashContext } from '../tui/slash/term.js';

export interface TermSlashScenarioResult {
  subcommand: string;
  expected: string;
  evidence: string;
}

const format = (text: string) => text;

/** Run the fast command matrix through the same production handler used by TUI. */
export async function runTermSlashMockScenarios(): Promise<TermSlashScenarioResult[]> {
  const root = mkdtempSync(join(tmpdir(), 'term-slash-mock-'));
  const previousState = process.env.ELANOUS_STATE_DIR;
  const previousHome = process.env.ELANOUS_TEST_HOME;
  process.env.ELANOUS_STATE_DIR = root;
  process.env.ELANOUS_TEST_HOME = root;
  try {
    const calls: string[] = [];
    const ctx = {
      chatLines: [] as string[], setChatScrollOffset: () => {},
      accent: format, warning: format, error: format, draw: () => {},
      termSlash: {
        slashRuntime: createDashboardTermSlashRuntime({ accent: format, muted: format, warning: format, error: format, text: format }),
        openNewTerminal: (command?: string) => { calls.push(`new:${command}`); },
        openSessionPicker: () => { calls.push('switch'); },
        sessionRegistry: {
          list: () => [], foreground: () => null, kill: (id: string) => { calls.push(`kill:${id}`); },
        },
        terminalMatrix: { list: () => [], get: () => null, listPipes: () => [] },
        broadcastBus: { groups: () => [] },
        channelBus: { channels: () => [] },
      },
    } as unknown as TermSlashContext;
    const registry = new SlashCommandRegistry<TermSlashContext, never>();
    registerTermSlash(registry);
    const cases = [
      ['help', [], '/term new'], ['help', ['experimental'], '/term matrix'],
      ['new', ['echo', 'hi'], 'new:echo hi'], ['list', [], 'No terminal sessions.'],
      ['attach', [], '/term attach requires'], ['detach', [], 'No foreground session'],
      ['switch', [], 'switch'], ['kill', [], 'No session to kill'],
      ['resume', [], 'No persisted sessions'], ['snapshot', [], 'Usage: /term snapshot'],
      ['matrix', [], '(no terminals'], ['move', [], 'Usage: /term move'],
      ['group', [], '(no broadcast groups'], ['channel', [], '(no channels'],
      ['pipe', [], 'Usage: /term pipe'], ['readonly', [], 'Usage: /term readonly'],
      ['recharacter', [], 'Usage: /term recharacter'],
    ] as const;
    const results: TermSlashScenarioResult[] = [];
    for (const [subcommand, args, expected] of cases) {
      const lineStart = ctx.chatLines.length;
      const callStart = calls.length;
      await registry.dispatch('term', [subcommand, ...args], ctx);
      results.push({
        subcommand,
        expected,
        evidence: [...ctx.chatLines.slice(lineStart), ...calls.slice(callStart)].join('\n'),
      });
    }
    return results;
  } finally {
    if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousState;
    if (previousHome === undefined) delete process.env.ELANOUS_TEST_HOME;
    else process.env.ELANOUS_TEST_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}
