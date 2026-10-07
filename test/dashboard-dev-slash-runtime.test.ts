import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildDashboardSlashRegistry,
  _setSelfOrchestrateSlashRuntimeForTesting,
  type DashboardSlashContext,
} from '../src/dashboard/slash-runtime/index.js';
import { SLASH_COMMANDS } from '../src/chat/index.js';

function makeContext() {
  const lines: string[] = [];
  let draws = 0;
  const ctx = {
    pushChatLine: (line: string) => { lines.push(line); },
    setChatScrollOffset: () => undefined,
    warning: (text: string) => text,
    info: (text: string) => text,
    muted: (text: string) => text,
    text: (text: string) => text,
    error: (text: string) => text,
    draw: () => { draws++; },
  } as unknown as DashboardSlashContext;
  return { ctx, lines, get draws() { return draws; } };
}

afterEach(() => {
  _setSelfOrchestrateSlashRuntimeForTesting(null);
});

describe('/harness dev dashboard slash', () => {
  test('passes the complete literal goal to the observe-only-gated runtime with decomposition enabled', async () => {
    const calls: Array<{ req: Record<string, unknown>; surface: string }> = [];
    _setSelfOrchestrateSlashRuntimeForTesting({
      async run(req, context) {
        calls.push({ req, surface: context.surface });
        return { output: 'started' };
      },
    });
    const goal = 'research the slash path, implement the runtime call, and verify the focused tests';
    const surface = makeContext();

    const result = await buildDashboardSlashRegistry().dispatch('harness', ['dev', ...goal.split(' ')], surface.ctx);

    expect(result.kind).toBe('continue');
    expect(calls).toEqual([{ req: { goals: [goal], decompose: true }, surface: 'tui' }]);
    expect(surface.draws).toBe(1);
  });

  test('without a goal shows usage and does not invoke the runtime', async () => {
    let calls = 0;
    _setSelfOrchestrateSlashRuntimeForTesting({
      async run() {
        calls++;
        return { output: 'unexpected' };
      },
    });
    const surface = makeContext();

    const result = await buildDashboardSlashRegistry().dispatch('harness', ['dev'], surface.ctx);

    expect(result.kind).toBe('continue');
    expect(calls).toBe(0);
    expect(surface.lines).toEqual([expect.stringContaining('usage: /harness dev <무엇을 왜 고칠지 한 문장>')]);
    expect(surface.draws).toBe(0);
  });

  test('catalog exposes /harness for autocomplete and help', () => {
    // Not toMatchObject with an asymmetric matcher: in this bun it wrote the matcher object into the shared
    // SLASH_COMMANDS entry, and later /help tests in the same run crashed on `description.replace`.
    const harness = SLASH_COMMANDS.find((command) => command.name === 'harness');
    expect(harness?.name).toBe('harness');
    expect(harness?.description).toContain('self-dev');
  });
});
