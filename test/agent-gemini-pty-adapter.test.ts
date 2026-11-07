// H5 Phase 3 · Gemini-CLI PTY adapter smoke.

import { describe, test, expect, afterEach } from 'bun:test';
import { createGeminiPtyAdapter } from '../src/agent/adapters/gemini-pty.js';
import {
  resetForTesting,
  setPtyAdapterForTesting,
  listPty,
} from '../src/pty-shell/registry.js';

function installFakePty() {
  setPtyAdapterForTesting(() => ({
    pid: 43,
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
describe('createGeminiPtyAdapter · supports()', () => {
  test('matches gemini + gemini-cli brand with PTY modes', () => {
    const a = createGeminiPtyAdapter();
    expect(a.id).toBe('gemini-pty');
    expect(a.supports({ brand: 'gemini' })).toBe(true);
    expect(a.supports({ brand: 'gemini-cli' })).toBe(true);
    expect(a.supports({ brand: 'gemini', mode: 'pty-direct' })).toBe(true);
    expect(a.supports({ brand: 'gemini', mode: 'hybrid' })).toBe(true);
  });

  test('rejects codex/claude brands and non-PTY modes', () => {
    const a = createGeminiPtyAdapter();
    expect(a.supports({ brand: 'codex' })).toBe(false);
    expect(a.supports({ brand: 'claude' })).toBe(false);
    expect(a.supports({ brand: 'gemini', mode: 'acp' })).toBe(false);
    expect(a.supports({ brand: 'gemini', mode: 'native-sdk' })).toBe(false);
  });
});

describe('createGeminiPtyAdapter · launch()', () => {
  test('launches with default binary "gemini"', async () => {
    installFakePty();
    const a = createGeminiPtyAdapter();
    const session = await a.launch({ brand: 'gemini' });
    expect(session.id).toMatch(/^emb-gemini-pty-/);
    expect(session.transports[0]!.label).toBe('gemini-pty');
    expect(session.state().title).toBe('gemini [gemini-pty]');
    expect(listPty().some((h) => h.cmd === 'gemini')).toBe(true);
    await session.dispose();
  });

  test('custom binary override', async () => {
    installFakePty();
    const a = createGeminiPtyAdapter({ binary: '/opt/gemini' });
    await a.launch({ brand: 'gemini-cli' });
    expect(listPty().some((h) => h.cmd === '/opt/gemini')).toBe(true);
  });
});
