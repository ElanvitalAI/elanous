import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { handleStaticAppRequest } from '../nexus/api/static-app.js';
import { createPwaRouteWorld, PWA_RETAINED_ROUTES } from './pwa-retained-routes-world';

function appRouterPages(root: string): string[] {
  const pages: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /^page\.(?:tsx?|jsx?)$/.test(entry.name)) {
        const parts = relative(root, directory).split(sep).filter(Boolean);
        pages.push(parts.length ? `/${parts.join('/')}` : '/');
      }
    }
  };
  walk(root);
  pages.push('/404');
  return pages;
}

async function buildExport(appDir: string): Promise<void> {
  const result = spawnSync('bun', ['run', 'build'], { cwd: appDir, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`PWA static export failed (${result.status ?? result.signal}):\n${result.stdout}\n${result.stderr}`);
  }
}

test('the merged App Router catalog matches the allowlist and the real Nexus static handler serves it', async () => {
  const app = resolve(dirname(import.meta.path), '../../apps/pwa/src/app');
  const appDir = resolve(app, '../..');
  const out = join(appDir, 'out');
  await buildExport(appDir);
  expect(existsSync(join(out, '404.html'))).toBe(true);

  const server = createServer(async (request, response) => {
    const result = handleStaticAppRequest(new URL(request.url ?? '/', 'http://pwa.test'), { staticDir: out });
    response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('PWA static test server did not bind a TCP port');
  const origin = `http://127.0.0.1:${address.port}`;
  const world = createPwaRouteWorld(appRouterPages(app), async (route) => {
    const servedPath = route === '/' ? '/app/' : `/app${route}/`;
    return (await fetch(new URL(servedPath, origin))).status;
  });

  try {
    expect(world.registeredRoutes).toEqual([...PWA_RETAINED_ROUTES].sort());
    for (const route of PWA_RETAINED_ROUTES.filter((path) => path !== '/404')) {
      expect(await world.request(route)).toEqual({ status: 200, route });
    }
    for (const route of ['/workspace', '/approvals', '/ops/release', '/market', '/pitch', '/showroom']) {
      expect(await world.request(route)).toEqual({ status: 404, route: null });
    }
    expect(existsSync(join(app, 'apps/page.tsx'))).toBe(true);
    expect(existsSync(join(app, 'design-check/page.tsx'))).toBe(true);
    expect(existsSync(resolve(app, '../components/apps/AppSimLiveView.tsx'))).toBe(true);
    expect(existsSync(resolve(app, '../components/shell/sidebar-nav-items.ts'))).toBe(true);
    expect(await world.request('/settings?tab=theme')).toEqual({ status: 200, route: '/settings' });
    expect(await world.request('/apps?view=all')).toEqual({ status: 200, route: '/apps' });
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
}, 180_000);
