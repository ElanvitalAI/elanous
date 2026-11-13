import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCdpClient, createCdpClientFromEndpoint, discoverChromeBinary } from '../browser-cdp/client.js';
import { loadNexusAppHost } from '../nexus/apps/app-host.js';

const sourceRoot = resolve(import.meta.dir, '../..');
const slug = 'lecture-scrap';
const host = `${slug}.app.localhost`;

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close();
      if (!address || typeof address === 'string') reject(new Error('no loopback port'));
      else resolvePort(address.port);
    });
  });
}

test.skipIf(process.platform !== 'darwin')('LECTURE-SCRAP-LIVE-INPUT-RPC saves and reaches note 21 through exported page and operating App Host', async () => {
  const binary = discoverChromeBinary();
  if (!binary) throw new Error('Chrome device is unavailable');
  const template = join(sourceRoot, 'templates/next-app-lecture-scrap');
  const dependencies = join(sourceRoot, 'apps/pwa/node_modules');
  const root = mkdtempSync(join(tmpdir(), 'lecture-note-operating-host-'));
  const buildApp = join(root, 'build');
  cpSync(template, buildApp, { recursive: true });
  symlinkSync(dependencies, join(buildApp, 'node_modules'), 'dir');
  // Source: .rules/30-harness/testing-gates.md R-TST36; the exported Next build is part of this operating device.
  const build = spawnSync(join(dependencies, '.bin/next'), ['build'], { cwd: buildApp, encoding: 'utf8', timeout: 180_000,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
  expect(build.status, build.stderr.slice(-1500)).toBe(0);

  const app = join(root, 'apps', slug);
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'app.yaml'), readFileSync(join(template, 'app.yaml')));
  cpSync(join(buildApp, 'out'), join(app, 'out'), { recursive: true });
  const options = { dir: join(root, 'sessions'), databaseDirectory: join(root, 'db'), key: randomBytes(32).toString('hex') };
  let loaded = loadNexusAppHost(join(root, 'apps'), undefined, options);
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: Awaited<ReturnType<typeof createCdpClient>> | undefined;
  let page: Awaited<ReturnType<typeof createCdpClientFromEndpoint>> | undefined;
  const requests: Array<{ path: string; status: number }> = [];
  try {
    expect(loaded.issues).toEqual([]);
    const session = loaded.appHost.issueOwnerSession(slug, 'lecture-owner');
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const incoming = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.set('host', host);
      headers.set('origin', `http://${host}`);
      const response = await loaded.appHost.handle(new Request(`http://${host}${incoming.pathname}${incoming.search}`, {
        method: request.method, headers, body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        duplex: 'half',
      } as RequestInit)) ?? new Response('Not Found', { status: 404 });
      requests.push({ path: incoming.pathname, status: response.status });
      return response;
    } });
    const pageUrl = `http://127.0.0.1:${server.port}/notes/new`;
    // Source: .rules/30-harness/testing-gates.md R-TST36; Chrome must be ready for the operating-route proof.
    browser = await createCdpClient({ binary, port: await freePort(), headless: true, url: 'about:blank', timeoutMs: 15_000,
      extraFlags: ['--disable-background-networking', '--disable-extensions', '--disable-sync', '--no-first-run'] });
    // Source: .rules/30-harness/testing-gates.md R-TST36; attach to that same browser session.
    page = await createCdpClientFromEndpoint(browser.port, { timeoutMs: 15_000 });
    await page.send!('Network.enable');
    const cookie = await page.send!('Network.setCookie', { name: '__Host-app-session', value: session.sessionToken,
      url: `http://127.0.0.1:${server.port}`, path: '/', secure: true, httpOnly: true }) as { success: boolean };
    expect(cookie.success).toBe(true);
    expect((await page.navigate(pageUrl)).errorText).toBeUndefined();

    const waitFor = async (expression: string) => {
      for (let i = 0; i < 100; i++) {
        if (await page!.evaluate(expression)) return;
        await Bun.sleep(100);
      }
      throw new Error(`browser state did not settle: ${expression}`);
    };
    await waitFor('document.querySelector("form input[name=title]") && document.body.innerText.includes("저장된 노트가 없습니다")');
    const title = `A37-${randomUUID().slice(0, 8)}`;
    const body = '운영 App Host 경유 저장과 새로고침 검증';
    await page.evaluate(`(() => { for (const [name, value] of Object.entries(${JSON.stringify({ title, body })})) {
      const element = document.querySelector('[name=' + name + ']');
      const setter = Object.getOwnPropertyDescriptor(element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
      setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true }));
    } return true; })()`);
    await page.evaluate('document.querySelector("form button[type=submit]").click()');
    await waitFor(`document.querySelector('section[aria-label="저장된 노트"]')?.innerText.includes(${JSON.stringify(title)})`);
    const listed = await loaded.appHost.handle(new Request(`http://${host}/__rpc/listLectureNotes`, {
      method: 'POST', headers: { host, origin: `http://${host}`, cookie: `__Host-app-session=${session.sessionToken}`,
        'content-type': 'application/json' }, body: JSON.stringify({ params: {} }),
    }));
    expect(listed?.status).toBe(200);
    const rows = (await listed!.json() as { rows: Array<{ id: string; title: string; body: string; created_at: string }> }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title, body });
    // Source: #23480; twenty newer owner RPC saves must not strand the original note on the next page.
    for (let index = 1; index <= 20; index++) {
      const saved = await loaded.appHost.handle(new Request(`http://${host}/__rpc/addLectureNote`, {
        method: 'POST', headers: { host, origin: `http://${host}`, cookie: `__Host-app-session=${session.sessionToken}`,
          'content-type': 'application/json' },
        body: JSON.stringify({ params: { id: randomUUID(), title: `A37-newer-${index}`, body: `다음 페이지 검증 ${index}`,
          created_at: new Date(Date.parse(rows[0]!.created_at) + index * 1000).toISOString() } }),
      }));
      expect(saved?.status).toBe(200);
    }
    loaded.appHost.close();
    loaded = loadNexusAppHost(join(root, 'apps'), undefined, options);
    expect(loaded.issues).toEqual([]);
    await page.send!('Page.reload', { ignoreCache: true });
    await waitFor('document.querySelector(\'section[aria-label="저장된 노트"]\')?.innerText.includes("A37-newer-20")');
    expect(await page.evaluate(`document.querySelector('section[aria-label="저장된 노트"]')?.innerText.includes(${JSON.stringify(title)})`)).toBe(false);
    await page.evaluate('document.querySelector(\'section[aria-label="저장된 노트"] button[type=button]\').click()');
    await waitFor(`document.querySelector('section[aria-label="저장된 노트"]')?.innerText.includes(${JSON.stringify(title)})`);
    const denied = await loaded.appHost.handle(new Request(`http://${host}/__rpc/listLectureNotes`, {
      method: 'POST', headers: { host, origin: `http://${host}`, 'content-type': 'application/json' },
      body: JSON.stringify({ params: {} }),
    }));
    expect(denied?.status).toBe(403);
    expect(requests).toContainEqual({ path: '/notes/new', status: 200 });
    expect(requests.filter(row => row.path === '/__rpc/addLectureNote' && row.status === 200)).toHaveLength(1);
    // Source: #23480; initial, post-save, post-reopen and older-page loads all use the browser operating route.
    expect(requests.filter(row => row.path === '/__rpc/listLectureNotes' && row.status === 200).length).toBeGreaterThanOrEqual(4);
    console.log(JSON.stringify({ device: 'lecture-note-operating-host', deviceCatalogVersion: 32, route: '/notes/new',
      ownerNoteId: rows[0]!.id, save: 200, list: 200, reload: 200, olderNoteAfter21Saves: true, publicList: denied?.status,
      operatingRequests: requests.filter(row => row.path === '/notes/new' || row.path.startsWith('/__rpc/')) }));
  } finally {
    await page?.close();
    await browser?.close();
    server?.stop(true);
    loaded.appHost.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 240_000);
