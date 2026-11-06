// ── Source-grep guard for /v1/tools/runtime + /v1/tools/<id>/call ──
//
// Memory `feedback_post_route_must_be_in_method_block` — the POST
// `/v1/tools/<id>/call` route must live inside `if (method !== 'GET')`,
// or a future refactor that "tidies up" the dispatcher will silently
// drop it to the 405 catch-all (same trap as #2121 R3 + #2047 intent
// feedback). Unit tests on the handler can't catch this — they invoke
// the function directly.
//
// Memory `feedback_source_level_grep_test_value` — wires + boot
// registrations need source-level guards because unit/integration
// tests pass through happy paths but don't pin the registration site.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');

function readSource(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf-8');
}

describe('http-server.ts — /v1/tools/runtime + /v1/tools/<id>/call route wires', () => {
  const src = readSource('src/nexus/api/http-server.ts');

  test('imports the three meta-api exports', () => {
    expect(src).toContain('handleRuntimeToolsList');
    expect(src).toContain('handleRuntimeToolCall');
    expect(src).toContain('parseRuntimeToolCallPath');
  });

  test('GET /v1/tools/runtime route exists', () => {
    expect(src).toMatch(/pathname\s*===\s*['"]\/v1\/tools\/runtime['"]/);
  });

  test('POST /v1/tools/<id>/call route is registered inside method!=="GET" block', () => {
    const blockIndex = src.search(/if\s*\(\s*method\s*!==\s*['"]GET['"]\s*\)/);
    const routeIndex = src.search(/parseRuntimeToolCallPath\s*\(\s*pathname\s*\)/);
    expect(blockIndex).toBeGreaterThan(-1);
    expect(routeIndex).toBeGreaterThan(blockIndex);
  });

  test('POST route returns handleRuntimeToolCall(req, opts.metaApi, restToolId)', () => {
    expect(src).toMatch(
      /return\s+handleRuntimeToolCall\s*\(\s*req\s*,\s*opts\.metaApi\s*,\s*restToolId\s*\)/,
    );
  });

  test('GET /v1/tools/runtime forwards url to handleRuntimeToolsList', () => {
    expect(src).toMatch(/handleRuntimeToolsList\s*\(\s*req\s*,\s*opts\.metaApi\s*,\s*url\s*\)/);
  });
});

describe('meta-api.ts — REST handler surface', () => {
  const src = readSource('src/nexus/api/meta-api.ts');

  test('exports handleRuntimeToolsList + handleRuntimeToolCall + parseRuntimeToolCallPath', () => {
    expect(src).toMatch(/export\s+function\s+parseRuntimeToolCallPath/);
    expect(src).toMatch(/export\s+function\s+handleRuntimeToolsList/);
    expect(src).toMatch(/export\s+async\s+function\s+handleRuntimeToolCall/);
  });

  test('REST call handler emits PFC capture intent with origin=rest', () => {
    expect(src).toMatch(/emitProxyCallIntent\s*\(\s*toolId\s*,\s*['"]rest['"]/);
  });

  test('imports listToolRuntimes + getToolRuntime from tool-runtime registry', () => {
    expect(src).toMatch(/listToolRuntimes\s+as\s+listRuntimeRegistry/);
    expect(src).toMatch(/getToolRuntime\s+as\s+getRuntimeRegistry/);
  });

  test('imports emitProxyCallIntent from src/mcp/server.ts', () => {
    expect(src).toMatch(/(?:emitProxyCallIntent.*from\s+['"]\.\.\/\.\.\/mcp\/server(\.js)?['"]|const\s+\{\s*emitProxyCallIntent\s*\}\s*=\s*await\s+import\(['"]\.\.\/\.\.\/mcp\/server(\.js)?['"]\))/);
  });
});

describe('mcp/server.ts — PFC capture seam', () => {
  const src = readSource('src/mcp/server.ts');

  test('exports emitProxyCallIntent for reuse from REST shim', () => {
    expect(src).toMatch(/export\s+function\s+emitProxyCallIntent/);
  });

  test('McpServerContext carries the origin tag (mcp-http | mcp-stdio | rest)', () => {
    expect(src).toMatch(/origin\?\s*:\s*['"]mcp-http['"]\s*\|\s*['"]mcp-stdio['"]\s*\|\s*['"]rest['"]/);
  });

  test('tools/call success path emits with success=true', () => {
    expect(src).toMatch(/emitProxyCallIntent\s*\(\s*name\s*,\s*ctx\.origin\s*,\s*true\s*\)/);
  });

  test('tools/call unknown-tool path emits with error_kind=unknown_tool', () => {
    expect(src).toMatch(/emitProxyCallIntent\s*\(\s*name\s*,\s*ctx\.origin\s*,\s*false\s*,\s*['"]unknown_tool['"]/);
  });

  test('runs the emit only when origin is set (skips when undefined)', () => {
    expect(src).toMatch(/if\s*\(\s*!origin\s*\)\s*return/);
  });
});

describe('callers pass origin tag', () => {
  test('mcp-http.ts dispatches with origin=mcp-http', () => {
    const src = readSource('src/nexus/api/mcp-http.ts');
    expect(src).toMatch(/origin:\s*['"]mcp-http['"]/);
  });

  test('src/index.ts mcp serve passes origin=mcp-stdio to startMcpStdioServer', () => {
    const src = readSource('src/index.ts');
    expect(src).toMatch(/startMcpStdioServer\s*\(\s*\{\s*origin:\s*['"]mcp-stdio['"]/);
  });
});
