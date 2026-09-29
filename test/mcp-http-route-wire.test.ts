// ── Source syntax guard for the POST /v1/mcp route wire ──
//
// Memory `feedback_post_route_must_be_in_method_block` — POST routes
// that escape the `if (method !== 'GET')` block silently fall through
// to the catch-all 405. Unit tests on `handleMcpHttpPost` can't catch
// this regression because they invoke the handler directly. This
// file pins the route registration so a future refactor that
// "tidies up" the dispatcher doesn't unmount the endpoint.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = join(import.meta.dir, '..');

function readSource(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf-8');
}

// Inspect syntax rather than indentation: a method guard can close after a comment or nested block.
function postRouteIsInsideMutationGuard(source: string): boolean {
  const file = ts.createSourceFile('http-server.ts', source, ts.ScriptTarget.Latest, true);
  let guard: ts.IfStatement | undefined;
  let route: ts.IfStatement | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      const condition = node.expression.getText(file);
      if (/^method\s*!==\s*['"]GET['"]$/.test(condition)) guard = node;
      if (/^pathname\s*===\s*['"]\/v1\/mcp['"]\s*&&\s*method\s*===\s*['"]POST['"]$/.test(condition)) route = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!guard || !route || !ts.isBlock(guard.thenStatement)) return false;
  // The dispatch branch must be a direct statement of the mutation block, not a
  // branch earlier in the dispatcher (or inside a different method guard).
  return guard.thenStatement.statements.some((statement) => statement === route);
}

describe('NEXUS http-server.ts — POST /v1/mcp route registration', () => {
  const src = readSource('src/nexus/api/http-server.ts');

  test('imports handleMcpHttpPost from ./mcp-http.js', () => {
    expect(src).toMatch(/handleMcpHttpPost.*from\s+['"]\.\/mcp-http(\.js)?['"]/);
  });

  test('route check `pathname === "/v1/mcp"` exists', () => {
    expect(src).toMatch(/pathname\s*===\s*['"]\/v1\/mcp['"]/);
  });

  // #21723: the later default-deny auth check shares this path; it is not the POST registration.
  test('route is registered inside the `method !== "GET"` block', () => {
    expect(postRouteIsInsideMutationGuard(src)).toBe(true);
  });

  test('a POST branch moved outside the mutation block is rejected even when closing braces are disguised', () => {
    const branch = /    if \(pathname === '\/v1\/mcp' && method === 'POST'\) \{[\s\S]*?\n    \}/;
    const match = src.match(branch);
    expect(match).not.toBeNull();
    const withoutBranch = src.replace(branch, '');
    const guardEnd = withoutBranch.indexOf('\n  }\n', withoutBranch.indexOf("if (method !== 'GET')"));
    expect(guardEnd).toBeGreaterThan(-1);
    const moved = withoutBranch.slice(0, guardEnd + '\n  }'.length)
      + '\n  // displaced POST branch\n' + match![0]
      + withoutBranch.slice(guardEnd + '\n  }'.length);
    expect(postRouteIsInsideMutationGuard(moved)).toBe(false);
    const commentedClosing = moved.replace('\n  }\n  // displaced POST branch', '\n  } // guard closed\n  // displaced POST branch');
    expect(commentedClosing).not.toBe(moved);
    expect(postRouteIsInsideMutationGuard(commentedClosing)).toBe(false);
  });

  test('route passes Bun direct peer metadata and its binding to handleMcpHttpPost', () => {
    expect(src).toMatch(/requestIP\?:\s*\(request:\s*Request\)\s*=>\s*\{\s*address:\s*string\s*\}/);
    expect(src).toMatch(/\)\.requestIP\?\.\(req\)/);
    expect(src).toMatch(/return\s+handleMcpHttpPost\s*\(\s*req\s*,\s*\{/);
    expect(src).toMatch(/peerAddress:\s*peer\.address/);
    expect(src).toMatch(/binding:\s*bind/);
  });
});

describe('mcp-http.ts surface', () => {
  const src = readSource('src/nexus/api/mcp-http.ts');

  test('exports handleMcpHttpPost', () => {
    expect(src).toMatch(/export\s+async\s+function\s+handleMcpHttpPost/);
  });

  test('delegates to handleMcpRequest from src/mcp/server.ts', () => {
    expect(src).toMatch(/['"]\.\.\/\.\.\/mcp\/server(\.js)?['"]/);
    expect(src).toContain('handleMcpRequest');
  });

  test('notifications (no id) return 202 status', () => {
    expect(src).toMatch(/status:\s*202/);
  });

  test('surface is set to "mcp" so listToolRuntimes filters consistently with stdio', () => {
    expect(src).toMatch(/surface:\s*['"]mcp['"]/);
  });
});
