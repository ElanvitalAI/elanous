import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { debug, withAmbientSessionScope } from '../src/debug/log.js';
import { getPty, resetForTesting, setPtyAdapterForTesting } from '../src/pty-shell/registry.js';
import { dispatchPtyShellSend, dispatchPtyShellStart } from '../src/skills/tools/pty.js';
import { dispatchDriveCodingAgentHeadless, dispatchSpawnCodingAgentHeadless } from '../src/skills/tools/spawn-coding-agent-headless.js';

/** Minimal timeout for one-shot headless drive test; production default (spawn-coding-agent-headless.ts: timeout_ms) is much larger. */
const HEADLESS_DRIVE_MINIMAL_TIMEOUT_MS = 1;
/** Minimal yield wait for PTY shell dispatch in observation tests; production default is larger. */
const PTY_OBSERVATION_YIELD_MS = 1;
const writes: string[] = [];
const attempts: Record<string, unknown>[] = [];
const networkAttempts: Record<string, unknown>[] = [];
let restoreLog: (() => void) | undefined;
let failWrite = false;

beforeEach(() => {
  writes.length = 0;
  attempts.length = 0;
  networkAttempts.length = 0;
  failWrite = false;
  setPtyAdapterForTesting(() => ({
    pid: 12345,
    write(input: string) { if (failWrite) throw new Error('write failed'); writes.push(input); },
    kill() {},
    onData() { return { dispose() {} }; },
    onExit() { return { dispose() {} }; },
  }));
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'llm.delegate' && event === 'prompt') attempts.push(data as Record<string, unknown>);
    if (category === 'llm.call' && event === 'attempt') networkAttempts.push(data as Record<string, unknown>);
  }) as typeof debug.log);
  restoreLog = () => log.mockRestore();
});

afterEach(() => {
  restoreLog?.();
  resetForTesting();
  setPtyAdapterForTesting(null);
});

function idFrom(output: string): string {
  const id = output.match(/process_id=(pty_[0-9a-f]+)/)?.[1];
  if (!id) throw new Error(`missing PTY id: ${output}`);
  return id;
}

describe('external coding CLI prompt observation', () => {
  test('spawn is not an attempt; staged text then Enter observes exactly one, no prompt or invented host', async () => {
    await withAmbientSessionScope('parent-pty-session', async () => {
      const spawned = dispatchSpawnCodingAgentHeadless(
        { brand: 'claude-code', extra_args: ['--model', 'claude-fixture'] },
        { whichBinary: () => '/fake/claude', wrapCommand: (cmd) => cmd },
      );
      const id = idFrom(spawned.output);
      expect(attempts).toHaveLength(0);
      // Existing headless spawn defaults to human-owned write mode; the agent's
      // PtyShellSend path only dispatches after ownership is made agent-writable.
      expect(getPty(id)!.accessMode).toBe('write');
      await dispatchPtyShellSend({ process_id: id, input: 'DENIED_SECRET\r', yield_time_ms: PTY_OBSERVATION_YIELD_MS });
      expect(attempts).toHaveLength(0);
      getPty(id)!.accessMode = 'auto';
      await dispatchPtyShellSend({ process_id: id, input: 'PROMPT_SECRET', yield_time_ms: PTY_OBSERVATION_YIELD_MS });
      expect(attempts).toHaveLength(0);
      await dispatchPtyShellSend({ process_id: id, input: '\r', yield_time_ms: PTY_OBSERVATION_YIELD_MS });
      expect(writes).toEqual(['PROMPT_SECRET', '\r']);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ provider: 'claude-code', model: 'claude-fixture',
        host: null, role: 'child', parentSessionId: 'parent-pty-session',
        selectionSource: 'explicit', billing: 'subscription', requestedBy: 'pty-coding-agent-prompt' });
      expect(JSON.stringify(attempts)).not.toContain('PROMPT_SECRET');
    });
  });

  test('direct codex shell send records one per submitted prompt and preserves unknown model', async () => {
    const id = idFrom((await dispatchPtyShellStart({ cmd: '/bin/codex', yield_time_ms: PTY_OBSERVATION_YIELD_MS })).output);
    await dispatchPtyShellSend({ process_id: id, input: 'FIRST_SECRET\n', yield_time_ms: PTY_OBSERVATION_YIELD_MS });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ provider: 'codex', model: null, host: null,
      role: 'child', selectionSource: 'fallback', billing: 'subscription' });
    expect(JSON.stringify(attempts)).not.toContain('FIRST_SECRET');
  });

  test('unrelated PTY, denied and failed writes do not emit a completed prompt', async () => {
    const unrelated = idFrom((await dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: PTY_OBSERVATION_YIELD_MS })).output);
    await dispatchPtyShellSend({ process_id: unrelated, input: 'echo harmless\n', yield_time_ms: PTY_OBSERVATION_YIELD_MS });
    const codex = idFrom((await dispatchPtyShellStart({ cmd: 'codex', yield_time_ms: PTY_OBSERVATION_YIELD_MS })).output);
    getPty(codex)!.accessMode = 'write';
    await dispatchPtyShellSend({ process_id: codex, input: 'DENIED_SECRET\n', yield_time_ms: PTY_OBSERVATION_YIELD_MS });
    expect(attempts).toHaveLength(0);
    getPty(codex)!.accessMode = 'auto';
    failWrite = true;
    await dispatchPtyShellSend({ process_id: codex, input: 'FAILED_SECRET\n', yield_time_ms: PTY_OBSERVATION_YIELD_MS });
    // The ledger is an attempt, emitted before a failing transport write as with llmNetworkSend.
    expect(attempts).toHaveLength(1);
    expect(JSON.stringify(attempts)).not.toContain('FAILED_SECRET');
  });

  test('one-shot drive emits once when the TUI prompt is submitted, not on spawn or staged text', async () => {
    await dispatchDriveCodingAgentHeadless({ brand: 'codex', prompt: 'DRIVE_SECRET',
      extra_args: ['-m', 'gpt-fixture'], timeout_ms: HEADLESS_DRIVE_MINIMAL_TIMEOUT_MS }, {
      whichBinary: () => '/fake/codex',
      timings: { readyInitialMs: 0, readyQuietMs: 0, readyMaxMs: 10, doneQuietMs: 0 },
    });
    expect(writes).toEqual(['DRIVE_SECRET', '\r']);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ provider: 'codex', model: 'gpt-fixture',
      host: null, role: 'child', selectionSource: 'explicit', billing: 'subscription' });
    expect(JSON.stringify(attempts)).not.toContain('DRIVE_SECRET');
  });

  test('delegated prompts never appear as network attempts', async () => {
    const id = idFrom((await dispatchPtyShellStart({ cmd: '/bin/codex', yield_time_ms: PTY_OBSERVATION_YIELD_MS })).output);
    await dispatchPtyShellSend({ process_id: id, input: 'PRIVATE_PROMPT\n', yield_time_ms: PTY_OBSERVATION_YIELD_MS });
    expect(attempts).toHaveLength(1);
    expect(networkAttempts).toHaveLength(0);
  });
});
