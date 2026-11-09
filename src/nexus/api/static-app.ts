// NEXUS · /app/* static handler (Track 5.A · 2026-05-07)
//
// Migrates daemon-public-server.ts:892-916 의 static handler 를 NEXUS HTTP
// 로 옮긴다. v6 hard landing decision #18 의 자연스러운 마무리 — daemon-
// public-server 는 freeze, NEXUS 가 단일 process · 단일 port (31415).
//
// Resolution order (daemon-public 와 동일):
//   1. exact file (`/app/foo.css` → `<root>/foo.css`)
//   2. directory index (`/app/chat/` → `<root>/chat/index.html`) —
//      Next.js export trailingSlash 페이지 호환
//   3. exported 404 page (`/app/anything-unknown` → `<root>/404.html`)
//
// Path traversal: resolve() + prefix 비교로 차단.
// gzip/cache header / CDN 통합 = ROADMAP §9.7 (v2 개선).

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join as joinPath, normalize, resolve } from 'node:path';

export const STATIC_PATH_PREFIX = '/app';

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.map': 'application/json',
};

function notFound(body = JSON.stringify({ error: 'not-found' })): Response {
  return new Response(body, {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

export interface StaticAppOpts {
  /** Absolute path to the directory served at /app/*. */
  staticDir: string;
}

export function pathMatchesStaticPrefix(pathname: string): boolean {
  return pathname === STATIC_PATH_PREFIX || pathname.startsWith(`${STATIC_PATH_PREFIX}/`);
}

export function handleStaticAppRequest(
  url: URL,
  opts: StaticAppOpts,
): Response {
  if (!pathMatchesStaticPrefix(url.pathname)) return notFound();
  const root = resolve(opts.staticDir);
  let rel = url.pathname.slice(STATIC_PATH_PREFIX.length);
  if (rel === '' || rel === '/') rel = '/index.html';
  const resolved = resolve(joinPath(opts.staticDir, normalize(rel)));
  if (!resolved.startsWith(root)) return notFound();

  let filePath = resolved;
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    const dirIndex = joinPath(filePath, 'index.html');
    if (existsSync(dirIndex)) filePath = dirIndex;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    const notFoundPath = joinPath(root, '404.html');
    if (!existsSync(notFoundPath) || !statSync(notFoundPath).isFile()) return notFound();
    return new Response(readFileSync(notFoundPath), {
      status: 404, headers: { 'content-type': MIME_BY_EXT['.html'] },
    });
  }
  const buf = readFileSync(filePath);
  const ext = extname(filePath).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  return new Response(buf, { status: 200, headers: { 'content-type': mime } });
}
