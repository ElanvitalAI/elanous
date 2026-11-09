// PR2 (C · 2026-05-13) — Background MCP boot doesn't block daemon listen.
//
// nexus/index.ts now kicks `registerMcpClients` as a fire-and-forget
// promise so `startNexusHttpServer` runs before the per-server
// handshake budget (8s × N · #2527) burns through. This test asserts
// that the helper itself still returns a usable handle when it
// finishes — i.e., the awaiter in `wrappedRelease` can still call
// `.shutdown()` on it without a type-level reach-around.
//
// The actual fire-and-forget wiring lives in `src/nexus/index.ts:1507`
// and is covered by source-grep guards in `test/mcp-boot-source-grep.test.ts`
// (added below).

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerMcpClients } from '../src/nexus/boot/register-mcp-clients.js';
import { buildUserConfig, resetUserConfig } from '../src/user-config.js';
import type { McpServerSpec } from '../src/user-config/types.js';

describe('registerMcpClients — background-boot compatible shape (PR2 C)', () => {
  test('promise resolves to a handle with shutdown() even when boot is slow', async () => {
    let disposed = 0;
    const p = registerMcpClients({
      servers: [{ id: 'slow', transport: 'stdio', command: ['fake'] }],
      logger: { info: () => {}, warn: () => {} },
      registerRuntime: () => {},
      handshakeTimeoutMs: 0, // disable the bound for this test
      createClient: () => ({
        // Slight delay simulates a real handshake — handle must still
        // resolve, not throw.
        start: async () => { await new Promise((r) => setTimeout(r, 10)); },
        listTools: async () => [],
        callTool: async () => ({ content: [] }),
        dispose: async () => { disposed += 1; },
      }),
    });
    // While `p` is in flight, the daemon's main path is free to call
    // `startNexusHttpServer` (mirrored here by a fast no-op).
    const daemonReadyMarker = await Promise.resolve('listening');
    expect(daemonReadyMarker).toBe('listening');
    // Eventually the boot finishes and produces a usable handle.
    const handle = await p;
    expect(handle.perServer['slow']!.status).toBe('ready');
    await handle.shutdown();
    expect(disposed).toBe(1);
  });

  test('boot promise that rejects internally still surfaces a sentinel result', async () => {
    // Per-server failures are swallowed inside registerMcpClients —
    // the helper itself shouldn't reject. (Mirrors PR2's
    // catch-and-warn wrapper in nexus/index.ts.)
    const handle = await registerMcpClients({
      servers: [{ id: 'broken', transport: 'stdio', command: ['fake'] }],
      logger: { info: () => {}, warn: () => {} },
      registerRuntime: () => {},
      handshakeTimeoutMs: 0,
      createClient: () => ({
        start: async () => { throw new Error('boom'); },
        listTools: async () => [],
        callTool: async () => ({ content: [] }),
        dispose: async () => {},
      }),
    });
    expect(handle.perServer['broken']!.status).toBe('failed');
    expect(handle.perServer['broken']!.reason).toContain('boom');
  });

  test('raw-config HTTP OAuth values reach the createClient boot seam and absent values stay absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'register-mcp-clients-oauth-'));
    const configPath = join(root, 'config.json');
    try {
      writeFileSync(configPath, JSON.stringify({ mcp: { servers: [
        {
          id: 'oauth',
          transport: 'http',
          url: 'https://mcp.example.com',
          oauthIssuer: ' https://issuer.example.com ',
          oauthTokenEndpoint: ' https://issuer.example.com/token ',
        },
        { id: 'plain', transport: 'http', url: 'https://plain.example.com' },
      ] } }));
      resetUserConfig();
      const servers = buildUserConfig(configPath).mcp!.servers;
      const captured: McpServerSpec[] = [];
      const handle = await registerMcpClients({
        servers,
        logger: { info: () => {}, warn: () => {} },
        registerRuntime: () => {},
        handshakeTimeoutMs: 0,
        createClient: (spec) => {
          captured.push(spec);
          return {
            start: async () => {},
            listTools: async () => [],
            callTool: async () => ({ content: [] }),
            dispose: async () => {},
          };
        },
      });
      expect(captured).toEqual([
        {
          id: 'oauth',
          transport: 'http',
          url: 'https://mcp.example.com',
          oauthIssuer: 'https://issuer.example.com',
          oauthTokenEndpoint: 'https://issuer.example.com/token',
        },
        { id: 'plain', transport: 'http', url: 'https://plain.example.com' },
      ]);
      await handle.shutdown();
    } finally {
      resetUserConfig();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('http reaches createClient; mixed http+stdio still resolves a usable handle', async () => {
    const spawned: string[] = [];
    let disposed = 0;
    const handle = await registerMcpClients({
      servers: [
        { id: 'remote', transport: 'http', url: 'https://mcp.example.com' },
        { id: 'local', transport: 'stdio', command: ['fake'] },
      ],
      logger: { info: () => {}, warn: () => {} },
      registerRuntime: () => {},
      handshakeTimeoutMs: 0,
      createClient: (spec) => {
        spawned.push(spec.id);
        return {
          start: async () => {},
          listTools: async () => [],
          callTool: async () => ({ content: [] }),
          dispose: async () => { disposed += 1; },
        };
      },
    });
    expect(spawned).toEqual(['remote', 'local']);
    expect(handle.perServer['remote']!.status).toBe('ready');
    expect(handle.perServer['local']!.status).toBe('ready');
    await handle.shutdown();
    expect(disposed).toBe(2);
  });
});
