// Backend registry — small, but worth covering so adding a backend
// is a deliberate visible change rather than a silent typo. Future
// codex / gemini entries each get a row in the matrix.

import { describe, it, expect } from 'bun:test';
import {
  ACP_BACKENDS,
  ACP_BACKEND_ALIASES,
  getAcpBackend,
  listAcpBackends,
  canonicalizeBackendId,
} from '../src/acp/backend-registry.js';

describe('backend registry', () => {
  it('exposes the claude backend by id', () => {
    const b = getAcpBackend('claude');
    expect(b.command).toBe('claude-agent-acp');
    expect(b.npmPackage).toBe('@agentclientprotocol/claude-agent-acp');
  });

  it('throws on unknown backend with the known list in the message', () => {
    expect(() => getAcpBackend('nope')).toThrow(/Unknown ACP backend "nope"/);
    expect(() => getAcpBackend('nope')).toThrow(/claude/);
  });

  it('resolves the friendly codex aliases to the canonical id', () => {
    expect(canonicalizeBackendId('codex')).toBe('codex-app-server');
    expect(canonicalizeBackendId('cx')).toBe('codex-app-server');
    expect(canonicalizeBackendId('cas')).toBe('codex-app-server');
    // canonical / unknown pass through unchanged
    expect(canonicalizeBackendId('codex-app-server')).toBe('codex-app-server');
    expect(canonicalizeBackendId('claude')).toBe('claude');
    expect(canonicalizeBackendId('nope')).toBe('nope');
  });

  it('has one normalized alias vocabulary for all ACP entry surfaces', () => {
    expect(ACP_BACKEND_ALIASES).toMatchObject({ cc: 'claude', gm: 'gemini', codex: 'codex-app-server' });
    for (const target of Object.values(ACP_BACKEND_ALIASES)) {
      expect(ACP_BACKENDS[target]).toBeDefined();
    }
    expect(canonicalizeBackendId('  CAS  ')).toBe('codex-app-server');
  });

  it('getAcpBackend accepts the friendly "codex" alias (the /cdx bug)', () => {
    // Was: `Unknown ACP backend "codex"` — /cdx passed 'codex' but only
    // 'codex-app-server' was registered.
    const b = getAcpBackend('codex');
    expect(b.id).toBe('codex-app-server');
    expect(b.transport).toBe('codex-app-server');
    expect(getAcpBackend('cx').id).toBe('codex-app-server');
  });

  it('listAcpBackends returns claude, gemini, and codex-app-server', () => {
    // Sprint 5B (2026-04-28) — the legacy codex (Zed shim) and
    // codex-native entries were removed alongside their dep packages.
    const list = listAcpBackends();
    const ids = new Set(list.map((b) => b.id));
    expect(ids.has('claude')).toBe(true);
    expect(ids.has('gemini')).toBe(true);
    expect(ids.has('codex-app-server')).toBe(true);
    expect(ids.has('codex')).toBe(false);
    expect(ids.has('codex-native')).toBe(false);
  });

  it('marks Gemini unsupported, preserves its canonical name, and rejects it before spawn', () => {
    const gemini = ACP_BACKENDS.gemini;
    expect(gemini).toBeDefined();
    expect(gemini.unsupportedReason).toEqual(expect.stringMatching(/\S/));
    expect(gemini.unsupportedReason).toContain('--backend gemini');
    expect(canonicalizeBackendId('gemini')).toBe('gemini');
    expect(() => getAcpBackend('gemini')).toThrow(/ACP backend "gemini" is unsupported/);
    expect(() => getAcpBackend('gemini')).not.toThrow(/Unknown ACP backend/);
  });

  it('leaves Claude, Codex app-server, and Grok without an unsupported marker', () => {
    expect(ACP_BACKENDS.claude.unsupportedReason).toBeUndefined();
    expect(ACP_BACKENDS['codex-app-server'].unsupportedReason).toBeUndefined();
    expect(ACP_BACKENDS.grok.unsupportedReason).toBeUndefined();
  });

  it('includes Gemini unsupported status and reason in the backend listing', () => {
    const gemini = listAcpBackends({ includeGated: true }).find((backend) => backend.id === 'gemini');
    expect(gemini?.unsupportedReason).toEqual(expect.stringMatching(/\S/));
    expect(gemini?.unsupportedReason).toContain('--backend gemini');
  });

  it('every registered backend has a pinned npm version', () => {
    // Drift-prevention: codex-app-server uses '*' since it consumes
    // the system codex binary; pinned ACP shims must keep a real
    // version range.
    for (const b of Object.values(ACP_BACKENDS)) {
      expect(b.npmVersion.length).toBeGreaterThan(0);
    }
  });

  // ─── codex-app-server backend (canonical codex path) ─────────────

  it('exposes codex-app-server backend with transport codex-app-server', () => {
    const b = getAcpBackend('codex-app-server');
    expect(b.transport).toBe('codex-app-server');
    expect(b.command).toBe('codex');
    expect(b.requiresEnv).toBeUndefined();
  });

  it('skipEnvGate bypasses the env check (advanced callers + tests)', () => {
    expect(() => getAcpBackend('codex-app-server', { skipEnvGate: true })).not.toThrow();
  });

  it('listAcpBackends({includeGated}) returns every entry regardless of env', () => {
    const list = listAcpBackends({ includeGated: true, env: {} as NodeJS.ProcessEnv });
    const ids = new Set(list.map((b) => b.id));
    expect(ids.has('codex-app-server')).toBe(true);
    expect(ids.has('claude')).toBe(true);
    expect(ids.has('gemini')).toBe(true);
  });
});
