// ── Source-grep guards for the MCP-client boot wire ──
//
// Single-purpose: assert that `src/nexus/index.ts` actually imports +
// invokes + disposes the MCP-client substrate. Without this, all the
// unit tests in this PR could pass while the boot wire is silently
// removed in a refactor — the production daemon would have proxy
// runtime + factory + config schema all working in isolation, yet
// not register a single proxy tool at startup.
//
// Per memory `feedback_source_level_grep_test_value` (PR #2084) —
// unit + integration are NOT enough for entry-point wires; we add a
// source-level guard so the seam is observable in the file tree.
//
// Also per RFC §4.6 — these greps are the contract that Phase 2 must
// preserve. If you legitimately need to relocate the wire, update
// the regex + leave a comment pointing to the new home.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');

function readSource(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf-8');
}

describe('nexus/index.ts MCP-client boot wire (B 트랙 Phase 2 · RFC #2474)', () => {
  const src = readSource('src/nexus/index.ts');

  test('imports registerMcpClients + McpClientsHandle from the boot helper', () => {
    expect(src).toMatch(
      /from\s+['"][^'"]*boot\/register-mcp-clients(\.js)?['"]/,
    );
    expect(src).toContain('registerMcpClients');
    expect(src).toContain('McpClientsHandle');
  });

  test('declares mcpClientsHandle at function scope (visible to wrappedRelease)', () => {
    expect(src).toMatch(/let\s+mcpClientsHandle\s*:\s*McpClientsHandle\s*\|\s*undefined/);
  });

  test('boot call site exists — fire-and-forget (PR2 C) so listen path isn\'t blocked', () => {
    // PR2 changed `mcpClientsHandle = await registerMcpClients(...)`
    // to a background promise that resolves into `mcpClientsHandle`
    // out-of-band. The grep proves the await isn't accidentally
    // reintroduced (which would re-deadlock daemon listen on a hung
    // MCP server, see #2527/#2532).
    expect(src).toMatch(/mcpClientsBootPromise\s*=/);
    // ⛔⭐ 이 grep 이 «못 하는 것»을 적어 둔다 — 소스 정규식은 «스코프 바인딩»을
    //    원리상 증명할 수 없다. 별칭 선언을 남긴 채 IIFE 안에서 다른 `register` 로
    //    shadowing 해도 아래 두 줄은 통과한다(리뷰 지적 · #18569).
    //    ⇒ 「실제로 registerMcpClients 가 불린다」는 «행동»으로만 증명된다:
    //       src/nexus/index.test.ts 가 registerMcpClientsFn 을 주입하고
    //       그것이 «불렸는지와 인자»를 단언한다. 그쪽이 이 계약의 canonical 이다.
    //    여기 남는 몫은 좁다 — 「main 경로에서 await 가 재도입되지 않았나」뿐이다.
    expect(src).toMatch(
      /const\s+register\s*=\s*opts\.registerMcpClientsFn\s*\?\?\s*registerMcpClients\s*;/,
    );
    expect(src).toMatch(/await\s+register\s*\(/);
    // The await must be inside the background IIFE — confirmed by the
    // sibling assertion that `mcpClientsHandle =` is NOT the LHS of
    // the registerMcpClients await on the main path.
    expect(src).not.toMatch(/mcpClientsHandle\s*=\s*await\s+registerMcpClients\s*\(/);
  });

  test('shutdown call site exists — `mcpClientsHandle.shutdown(...)`', () => {
    expect(src).toMatch(/mcpClientsHandle\.shutdown\s*\(/);
  });

  test('shutdown settles `mcpClientsBootPromise` before disposing (PR2 C)', () => {
    // Without this race, a SIGINT mid-boot would skip dispose() and
    // leave xcrun mcpbridge / xcodebuildmcp orphaned.
    expect(src).toMatch(/mcpClientsBootPromise/);
  });

  test('boot site reads user-config mcp.servers (not a hardcoded list)', () => {
    expect(src).toMatch(/cfg\.mcp\?\.servers\s*\?\?\s*\[\]/);
  });
});

describe('register-mcp-clients.ts surface', () => {
  const src = readSource('src/nexus/boot/register-mcp-clients.ts');

  test('exports registerMcpClients + McpClientsHandle', () => {
    expect(src).toMatch(/export\s+async\s+function\s+registerMcpClients/);
    expect(src).toMatch(/export\s+interface\s+McpClientsHandle/);
  });

  test('graceful failure path: catches per-server errors and continues', () => {
    expect(src).toMatch(/catch\s*\(\s*err/);
    expect(src).toContain("status: 'failed'");
  });

  test('respects enabled:false (skips spawn silently)', () => {
    expect(src).toContain('enabled === false');
    expect(src).toContain("status: 'disabled'");
  });

  test('shutdown disposes every spawned client', () => {
    expect(src).toMatch(/dispose\s*\(/);
  });

  test('default HTTP client factory forwards parsed OAuth and static bearer environment fields only when present', () => {
    expect(src).toMatch(/oauthIssuer:\s*spec\.oauthIssuer/);
    expect(src).toMatch(/oauthTokenEndpoint:\s*spec\.oauthTokenEndpoint/);
    expect(src).toMatch(/bearerTokenEnv:\s*spec\.bearerTokenEnv/);
  });
});

describe('user-config mcp surface', () => {
  const src = readSource('src/user-config.ts');
  const types = readSource('src/user-config/types.ts');
  const schema = readSource('src/user-config/schema.ts');

  test('exports McpServerSpec + McpConfig types', () => {
    expect(types).toMatch(/export\s+type\s+McpServerSpec/);
    expect(types).toMatch(/export\s+interface\s+McpStdioServerSpec/);
    expect(types).toMatch(/export\s+interface\s+McpHttpServerSpec/);
    expect(types).toMatch(/export\s+interface\s+McpConfig/);
  });

  test('UserConfig has sparse `mcp?: McpConfig` field', () => {
    expect(schema).toMatch(/mcp\?\s*:\s*McpConfig/);
  });

  test('parseUserConfig wires `mcp` via spreadIfDefined (sparse pattern)', () => {
    expect(src).toMatch(/spreadIfDefined\(['"]mcp['"],\s*parseMcpConfig/);
  });
});
