import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAppSiteDeployRoute, createLectureScrapDeploymentOperations, fetchAppMemberOwner } from './app-site-deploy.js';

function deployRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://nexus.invalid/v1/apps/lecture-scrap/deploy', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer member-owner', ...headers },
    body: JSON.stringify(body),
  });
}

test('DEPLOY-1 simulation runs template → build → public publish → HTTP/content verify through the Nexus API', async () => {
  const stages: string[] = [];
  const owner = { memberId: 'member-7', userSlug: 'kaist-demo', plan: 'free', entitlements: {} };
  const route = createAppSiteDeployRoute({
    configuredPublicUserId: 'kaist-demo', resolveOwner: async () => owner,
    createFromTemplate: async input => { stages.push(`create:${input.templateId}:${input.appSlug}:${input.userSlug}:${input.owner.memberId}`); return { appRoot: '/sim/apps/lecture-scrap' }; },
    build: async input => { stages.push(`build:${input.source.appRoot}`); return { appRoot: '/sim/apps/lecture-scrap/out', verifyText: '강의 자료를 모으고 노트를 적는다' }; },
    publish: async input => { stages.push(`publish:${input.publicUrl}:${input.build.appRoot}:${input.owner.plan}`); },
    // The Nexus wire mounts the app as part of the publish stage.
    verify: async input => { stages.push(`verify:${input.publicUrl}:${input.verifyText}`); return { status: 200, body: `<main>${input.verifyText}</main>` }; },
  });

  const response = await route(deployRequest({ templateId: 'next-app-lecture-scrap' }));
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ rawOutput: {
    kind: 'site-deploy', status: 'success', publicUrl: 'https://lecture-scrap--kaist-demo.elanous.app',
  } });
  expect(stages).toEqual([
    'create:next-app-lecture-scrap:lecture-scrap:kaist-demo:member-7',
    'build:/sim/apps/lecture-scrap',
    'publish:https://lecture-scrap--kaist-demo.elanous.app:/sim/apps/lecture-scrap/out:free',
    'verify:https://lecture-scrap--kaist-demo.elanous.app:강의 자료를 모으고 노트를 적는다',
  ]);
});

test('DEPLOY-1 simulation denies non-owners before template creation and validates request fields', async () => {
  let creates = 0;
  const route = createAppSiteDeployRoute({
    configuredPublicUserId: 'kaist-demo', resolveOwner: async request => request.headers.get('authorization') === 'Bearer member-owner'
      ? { memberId: 'member-7', userSlug: 'kaist-demo', plan: 'free', entitlements: {} } : null,
    createFromTemplate: async () => { creates += 1; return { appRoot: '/sim/app' }; },
    build: async () => ({ appRoot: '/sim/out', verifyText: 'expected' }),
    publish: async () => {}, verify: async () => ({ status: 200, body: 'expected' }),
  });
  expect((await route(deployRequest({ templateId: 'next-app-lecture-scrap' }, { authorization: 'Bearer member-user' })))?.status).toBe(401);
  expect((await route(deployRequest({ templateId: 'next-app-lecture-scrap', target: 'external' })))?.status).toBe(400);
  expect(creates).toBe(0);
});

test('DEPLOY-1 simulation returns failed rawOutput unless public verification is HTTP 200 and contains build content', async () => {
  const route = createAppSiteDeployRoute({
    configuredPublicUserId: 'kaist-demo', resolveOwner: async () => ({ memberId: 'member-7', userSlug: 'kaist-demo', plan: 'free', entitlements: {} }),
    createFromTemplate: async () => ({ appRoot: '/sim/app' }),
    build: async () => ({ appRoot: '/sim/out', verifyText: 'elanous-deploy-unique-build-marker' }),
    publish: async () => {},
    // A generic document head still cannot prove that this deployment's artifact was published.
    verify: async () => ({ status: 200, body: '<!doctype html><html><head><title>Lecture</title></head><body><main>different content</main></body></html>' }),
  });
  const response = await route(deployRequest({ templateId: 'next-app-lecture-scrap' }));
  expect(response?.status).toBe(502);
  expect(await response?.json()).toEqual({ rawOutput: { kind: 'site-deploy', status: 'failed' } });
});

test('NM-1 owner lookup simulation calls the exact endpoint and forwards only app-session credentials', async () => {
  const token = `aps_${'a'.repeat(48)}`;
  const request = new Request('https://api.elanous.ai/v1/apps/lecture-scrap/deploy', {
    headers: { cookie: `analytics=ignored; __Host-app-session=${token}; other=ignored`, authorization: 'Bearer nexus-owner-token', 'x-private': 'never-forward' },
  });
  let calledUrl = '';
  let calledHeaders: Headers | undefined;
  const owner = { memberId: 'member-7', userSlug: 'kaist-demo', plan: 'free', entitlements: {} };
  const resolved = await fetchAppMemberOwner(request, 'lecture-scrap', 'http://127.0.0.1:4123', async (input, init) => {
    calledUrl = String(input);
    calledHeaders = new Headers(init?.headers);
    return Response.json(owner, { status: 200 });
  });
  expect(calledUrl).toBe('http://127.0.0.1:4123/v1/members/owner?appSlug=lecture-scrap');
  expect(calledHeaders?.get('cookie')).toBe(`__Host-app-session=${token}`);
  expect(calledHeaders?.has('authorization')).toBe(false);
  expect(calledHeaders?.has('x-private')).toBe(false);
  expect(resolved).toEqual(owner);
  expect(await fetchAppMemberOwner(request, 'lecture-scrap', 'http://127.0.0.1:4123', async () => Response.json({ ...owner, memberId: '' }))).toBeNull();
  expect(await fetchAppMemberOwner(new Request(request.url), 'lecture-scrap', 'http://127.0.0.1:4123', async () => Response.json(owner))).toBeNull();
  expect(await fetchAppMemberOwner(request, 'lecture-scrap', 'https://attacker.invalid', async () => Response.json(owner))).toBeNull();
});

test('NM-1 owner lookup accepts only a valid app-session bearer and never forwards an unrelated authorization token', async () => {
  const owner = { memberId: 'member-7', userSlug: 'kaist-demo', plan: 'free', entitlements: {} };
  const token = `aps_${'b'.repeat(48)}`;
  let calledHeaders: Headers | undefined;
  const resolved = await fetchAppMemberOwner(new Request('https://api.elanous.ai/deploy', {
    headers: { authorization: `Bearer ${token}`, cookie: 'analytics=ignored' },
  }), 'lecture-scrap', 'http://127.0.0.1:4123', async (_input, init) => {
    calledHeaders = new Headers(init?.headers);
    return Response.json(owner);
  });
  expect(resolved).toEqual(owner);
  expect(calledHeaders?.get('authorization')).toBe(`Bearer ${token}`);
  expect(calledHeaders?.has('cookie')).toBe(false);

  let called = false;
  expect(await fetchAppMemberOwner(new Request('https://api.elanous.ai/deploy', {
    headers: { authorization: 'Bearer nexus-owner-token' },
  }), 'lecture-scrap', 'http://127.0.0.1:4123', async () => { called = true; return Response.json(owner); })).toBeNull();
  expect(called).toBe(false);
});

test('default template creation refuses an existing app directory without deleting user data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-site-deploy-template-'));
  const appsRoot = join(root, 'apps');
  const appRoot = join(appsRoot, 'lecture-scrap');
  mkdirSync(appRoot, { recursive: true });
  const userData = join(appRoot, 'user-data.db');
  writeFileSync(userData, 'keep');
  const ops = createLectureScrapDeploymentOperations({
    appsRoot,
    templatesRoot: resolve(import.meta.dir, '../../../templates'),
    fetch: async () => new Response('unused'),
  });
  try {
    await expect(ops.createFromTemplate({
      appSlug: 'lecture-scrap', templateId: 'next-app-lecture-scrap',
      userSlug: 'kaist-demo', owner: { memberId: 'member-7', userSlug: 'kaist-demo', plan: 'free', entitlements: {} },
    })).rejects.toThrow();
    expect(existsSync(userData)).toBe(true);
    expect(readFileSync(userData, 'utf8')).toBe('keep');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('default build marker rejects a published response with the same generic head but different body', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-site-deploy-verify-'));
  const appsRoot = join(root, 'apps');
  const appRoot = join(appsRoot, 'lecture-scrap');
  let builtHtml = '';
  let servedBody = '';
  let expectedVerifyText = '';
  let verifyCalls = 0;
  let discarded = false;
  const operations = createLectureScrapDeploymentOperations({
    appsRoot,
    templatesRoot: resolve(import.meta.dir, '../../../templates'),
    runBuild: async (args, cwd) => {
      if (args[0] === 'run') {
        const outputRoot = join(cwd, 'out');
        mkdirSync(outputRoot, { recursive: true });
        writeFileSync(join(outputRoot, 'index.html'), '<!doctype html><html><head><title>Lecture</title></head><body><main>분산 시스템 특강</main></body></html>');
      }
    },
  });
  const route = createAppSiteDeployRoute({
    configuredPublicUserId: 'kaist-demo',
    resolveOwner: async () => ({ memberId: 'member-7', userSlug: 'kaist-demo', plan: 'free', entitlements: {} }),
    ...operations,
    build: async input => {
      const result = await operations.build(input);
      builtHtml = readFileSync(join(result.appRoot, 'index.html'), 'utf8');
      return result;
    },
    discard: async source => {
      discarded = true;
      await operations.discard?.(source);
    },
    verify: async ({ verifyText }) => {
      verifyCalls += 1;
      expectedVerifyText = verifyText;
      // Keep the same ordinary document head but return different body content.
      servedBody = builtHtml.replace(verifyText, 'stale-build-content');
      return { status: 200, body: servedBody };
    },
  });
  try {
    const response = await route(new Request('https://api.elanous.ai/v1/apps/lecture-scrap/deploy', {
      method: 'POST', headers: { authorization: 'Bearer app-owner', 'content-type': 'application/json' },
      body: JSON.stringify({ templateId: 'next-app-lecture-scrap' }),
    }));
    // Assertions live outside the route's catch so an earlier failure cannot masquerade as a verification failure.
    expect(verifyCalls).toBe(1);
    expect(builtHtml).toContain(expectedVerifyText);
    expect(servedBody).toContain('<head><title>Lecture</title></head>');
    expect(servedBody).toContain('분산 시스템 특강');
    expect(servedBody).toContain('stale-build-content');
    expect(servedBody).not.toContain(expectedVerifyText);
    expect(discarded).toBe(true);
    expect(existsSync(appRoot)).toBe(false);
    expect(response?.status).toBe(502);
    expect(await response?.json()).toEqual({ rawOutput: { kind: 'site-deploy', status: 'failed' } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
