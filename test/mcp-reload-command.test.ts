import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { resolve } from 'path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const entry = resolve(import.meta.dir, '..', 'src', 'index.ts');

async function run(args: string[]): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(['bun', entry, '--test', ...args], {
    cwd: resolve(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: stdout + stderr };
}

describe('elanous mcp reload Commander wiring', () => {
  test('reload action posts to the supplied NEXUS endpoint and preserves the reload output', async () => {
    let method: string | undefined;
    let body: string | undefined;
    const server = Bun.serve({
      port: 0,
      fetch: async (received) => {
        method = received.method;
        body = await received.text();
        return Response.json({
          reloaded: true,
          registered: 1,
          perServer: { example: { status: 'ready', toolCount: 1 } },
        });
      },
    });
    try {
      const result = await run(['mcp', 'reload', '--nexus-url', server.url.origin]);
      expect(result.code).toBe(0);
      expect(method).toBe('POST');
      expect(body).toBe('{}');
      expect(result.output).toContain('✓ MCP 재장전 완료 — 서버 1개 · 도구 1개 등록');
      expect(result.output).toContain('✓ example');
    } finally {
      server.stop(true);
    }
  });

  test('MCP help adds reload without changing the existing sibling command names and descriptions', async () => {
    const result = await run(['mcp', '--help']);
    expect(result.code).toBe(0);
    expect(result.output).toContain('serve                          Run a stdio MCP server exposing the configured');
    expect(result.output).toContain('login [options] <serverId>     Acquire and persist OAuth credentials for one');
    expect(result.output).toContain('diagnose [options] [serverId]  Probe one (or every enabled) MCP server: spawn');
    expect(result.output).toContain('call [options] <tool>          Call one MCP tool on this machine\'s daemon');
    expect(result.output).toContain('reload [options]               Re-read user-config and rebuild the running');
  });
});
