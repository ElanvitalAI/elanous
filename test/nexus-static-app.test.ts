// T5.A — /app/* static handler.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import {
  handleStaticAppRequest,
  pathMatchesStaticPrefix,
  STATIC_PATH_PREFIX,
} from '../src/nexus/api/static-app.js';

function mkStaticRoot(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(joinPath(tmpdir(), 'elanous-static-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true }) };
}

describe('T5.A · pathMatchesStaticPrefix', () => {
  test('matches /app and /app/...; rejects /api', () => {
    expect(pathMatchesStaticPrefix(STATIC_PATH_PREFIX)).toBe(true);
    expect(pathMatchesStaticPrefix(`${STATIC_PATH_PREFIX}/foo`)).toBe(true);
    expect(pathMatchesStaticPrefix('/v1/health')).toBe(false);
    expect(pathMatchesStaticPrefix('/apps')).toBe(false);
  });
});

describe('T5.A · handleStaticAppRequest', () => {
  test('exact file → 200 + correct mime', async () => {
    const { dir, cleanup } = mkStaticRoot();
    writeFileSync(joinPath(dir, 'index.html'), '<html>root</html>');
    writeFileSync(joinPath(dir, 'app.js'), 'console.log(1)');
    const r1 = handleStaticAppRequest(new URL('http://x/app/index.html'), { staticDir: dir });
    expect(r1.status).toBe(200);
    expect(r1.headers.get('content-type')).toContain('text/html');
    expect(await r1.text()).toBe('<html>root</html>');

    const r2 = handleStaticAppRequest(new URL('http://x/app/app.js'), { staticDir: dir });
    expect(r2.status).toBe(200);
    expect(r2.headers.get('content-type')).toContain('javascript');
    cleanup();
  });

  test('directory → <dir>/index.html', async () => {
    const { dir, cleanup } = mkStaticRoot();
    writeFileSync(joinPath(dir, 'index.html'), '<html>root</html>');
    mkdirSync(joinPath(dir, 'chat'));
    writeFileSync(joinPath(dir, 'chat', 'index.html'), '<html>chat</html>');
    const r = handleStaticAppRequest(new URL('http://x/app/chat'), { staticDir: dir });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('<html>chat</html>');
    cleanup();
  });

  test('unknown path serves the exported 404 page with 404 status', async () => {
    const { dir, cleanup } = mkStaticRoot();
    writeFileSync(joinPath(dir, 'index.html'), '<html>root</html>');
    writeFileSync(joinPath(dir, '404.html'), '<html>missing</html>');
    const r = handleStaticAppRequest(new URL('http://x/app/anything-unknown'), { staticDir: dir });
    expect(r.status).toBe(404);
    expect(await r.text()).toBe('<html>missing</html>');
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    cleanup();
  });

  test('path traversal blocked', () => {
    const { dir, cleanup } = mkStaticRoot();
    writeFileSync(joinPath(dir, 'index.html'), '<html></html>');
    const r = handleStaticAppRequest(
      new URL('http://x/app/../etc/passwd'),
      { staticDir: dir },
    );
    expect(r.status).toBe(404);
    cleanup();
  });

  test('root /app + no index.html → 404', () => {
    const { dir, cleanup } = mkStaticRoot();
    const r = handleStaticAppRequest(new URL('http://x/app'), { staticDir: dir });
    expect(r.status).toBe(404);
    cleanup();
  });
});
