// H5 Phase 3 · Claude-Code PTY adapter smoke.
//
// Factory behaviour is covered in agent-pty-adapter-factory.test.ts.
// Here we just verify brand/mode matching, id, binary default, and
// registration into an AdapterRegistry.

import { describe, test, expect, afterEach } from 'bun:test';
import { createClaudePtyAdapter } from '../src/agent/adapters/claude-pty.js';
import {
  resetForTesting,
  setPtyAdapterForTesting,
  listPty,
} from '../src/pty-shell/registry.js';

function installFakePty() {
  setPtyAdapterForTesting(() => ({
    pid: 42,
    write() {},
    kill() {},
    onData() { return { dispose() {} }; },
    onExit() { return { dispose() {} }; },
  }));
}

afterEach(() => {
  resetForTesting();
  setPtyAdapterForTesting(null);
});
describe('createClaudePtyAdapter · supports()', () => {
  test('matches claude + claude-code brand with PTY modes', () => {
    const a = createClaudePtyAdapter();
    expect(a.id).toBe('claude-pty');
    expect(a.supports({ brand: 'claude' })).toBe(true);
    expect(a.supports({ brand: 'claude-code' })).toBe(true);
    expect(a.supports({ brand: 'claude', mode: 'pty-direct' })).toBe(true);
    expect(a.supports({ brand: 'claude', mode: 'hybrid' })).toBe(true);
  });

  test('rejects codex/gemini brands and non-PTY modes', () => {
    const a = createClaudePtyAdapter();
    expect(a.supports({ brand: 'codex' })).toBe(false);
    expect(a.supports({ brand: 'gemini' })).toBe(false);
    expect(a.supports({ brand: 'claude', mode: 'acp' })).toBe(false);
    expect(a.supports({ brand: 'claude', mode: 'native-sdk' })).toBe(false);
  });
});

describe('createClaudePtyAdapter · launch()', () => {
  test('launches with default binary "claude"', async () => {
    installFakePty();
    const a = createClaudePtyAdapter();
    const session = await a.launch({ brand: 'claude' });
    expect(session.id).toMatch(/^emb-claude-pty-/);
    expect(session.transports[0]!.label).toBe('claude-pty');
    expect(session.state().title).toBe('claude [claude-pty]');
    expect(listPty().some((h) => h.cmd === 'claude')).toBe(true);
    await session.dispose();
  });

  test('custom binary override', async () => {
    installFakePty();
    const a = createClaudePtyAdapter({ binary: '/opt/claude-code' });
    await a.launch({ brand: 'claude-code' });
    expect(listPty().some((h) => h.cmd === '/opt/claude-code')).toBe(true);
  });
});
