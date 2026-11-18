import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBuildExecution } from './build-execution.js';
import { DEFAULT_TIMEOUT_MS } from '../../shell-primitive/types.js';
import { APP_BUILD_MAX_FILES } from './contracts.js';
import type { runShell } from '../../shell-primitive/index.js';
import { createAppBuildLocalIssuerBridge, OFFICIAL_MEMBER_ORIGIN } from '../../nexus/apps/app-build-local-bridge.js';
import { createAppBuildRunAuthority } from '../../nexus/apps/app-build-run-authority.js';
import { createDynamicAppPublisher } from '../../nexus/apps/dynamic-app-publish.js';
import type { NexusAppHost } from '../../nexus/apps/app-host.js';
import { getAuthPeerAddress, registerAuthPeerAddress } from '../../nexus/api/meta-api.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function setup(realSandbox = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'build-host-'))); roots.push(root);
  const sourceRoot = join(root, 'sources'); mkdirSync(sourceRoot, { mode: 0o700 });
  const ownerId = 'synthetic-owner'; const appSlug = 'synthetic-app'; const runId = 'synthetic-run';
  const sourceHead = 'a'.repeat(40); const userSlug = 'syntheticowner';
  const parent = join(sourceRoot, sha(ownerId), runId);
  const grant = { ownerId, userSlug, runId, appSlug, sourceRoot: join(parent, appSlug + '-' + 'b'.repeat(32)),
    issuerExpiresAt: '2099-01-01T00:00:00.000Z', sourceHead };
  let tamper: Record<string, unknown> = {};
  let approvalStatus = 'approval-approved';
  const operations: string[] = []; const commands: Parameters<typeof runShell>[0][] = [];
  const fetcher = (async (url: URL | RequestInfo, options?: RequestInit) => {
    if (String(url).endsWith('/v1/members/owner')) return Response.json({ memberId: ownerId, userSlug });
    const body = JSON.parse(String(options?.body)); operations.push(body.action);
    if (body.action === 'reserve') {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      writeFileSync(join(parent, appSlug + '.claim.json'), JSON.stringify({ ...grant, root: grant.sourceRoot }), { mode: 0o600 });
      return Response.json(grant);
    }
    if (body.action === 'attest') return Response.json({ ...grant, ...tamper });
    if (body.action === 'inspect') return Response.json({ status: 'inspected', artifactDigest: sha('synthetic-artifact') });
    if (body.action === 'approval-poll') return Response.json({ status: approvalStatus });
    if (body.action === 'publish') return Response.json({ status: 'published', deploymentId: 'synthetic-deployment', publicUrl: 'https://synthetic-app--syntheticowner.elanous.app' });
    return Response.json({}, { status: 400 });
  }) as typeof fetch;
  const shell = (async request => {
    commands.push(request);
    return { exitCode: 0, stdout: '', stderr: '', outcome: 'exit', sandboxed: true, sandboxTool: 'sandbox-exec', truncated: false };
  }) as typeof runShell;
  const options = { sourceRoot, scratchRoot: join(root, 'scratch'), sourceHead, fetcher,
    getSession: () => ({ nexusUrl: 'https://synthetic.invalid', sessionToken: 'aps_synthetic' }),
    ...(realSandbox ? {} : { shell, platform: 'darwin' as const,
      sandboxProfile: () => 'synthetic-profile-not-executed' }) };
  return { root, grant, operations, commands, options, host: createBuildExecution(options),
    setApprovalStatus(status: string) { approvalStatus = status; },
    tamper(value: Record<string, unknown>) { tamper = value; } };
}

test('C reservation is independently attested and registered app_create writes only after a passing private sandbox', async () => {
  const h = setup(); const grant = await h.host.reserve(h.grant.ownerId, h.grant.runId, h.grant.appSlug);
  const files = [{ path: 'backend/main.ts', content: 'export const fetch = () => new Response("ok");' }];
  const created = await h.host.materialize(grant, files, { runtime: { startCommand: ['bun', 'backend/main.ts'], healthPath: '/health' } });
  expect(created.sourceRoot).toBe(h.grant.sourceRoot);
  expect(readFileSync(join(created.sourceRoot, 'backend/main.ts'), 'utf8')).toBe(files[0]!.content);
  expect(h.commands).toHaveLength(1);
  expect(h.commands[0]?.command.slice(0, 2)).toEqual(['/usr/bin/env', '-i']);
  expect(h.commands[0]?.command).toContain('/usr/bin/sandbox-exec');
  expect(h.commands[0]?.sandbox).toBe('off'); expect(h.commands[0]?.network).toBe('off'); // exactly one explicit kernel wrapper
  expect(h.commands[0]?.command).toContain('synthetic-profile-not-executed');
  const published = await h.host.publish(grant);
  expect(published.status).toBe('published');
  expect(h.operations.slice(-4)).toEqual(['attest', 'inspect', 'approval-poll', 'publish']);
});

test('ordinary publish refuses pending or denied approval before a grant request', async () => {
  for (const status of ['approval-pending', 'approval-denied']) {
    const h = setup();
    const grant = await h.host.reserve(h.grant.ownerId, h.grant.runId, h.grant.appSlug);
    h.setApprovalStatus(status);
    await expect(h.host.publish(grant)).rejects.toThrow('BUILD_AUTHORITY_REFUSED');
    expect(h.operations).toContain('approval-poll');
    expect(h.operations).not.toContain('publish');
  }
});

test('altered issuer identity, expiry, source head or remote root cannot authorize a local write', async () => {
  for (const tamper of [{ ownerId: 'foreign' }, { runId: 'foreign' }, { userSlug: 'foreign' }, { appSlug: 'foreign' },
    { issuerExpiresAt: '2000-01-01T00:00:00.000Z' }, { sourceHead: 'f'.repeat(40) }, { sourceRoot: '/remote/untrusted' }]) {
    const h = setup(); const grant = await h.host.reserve(h.grant.ownerId, h.grant.runId, h.grant.appSlug);
    h.tamper(tamper);
    await expect(h.host.materialize(grant, [{ path: 'index.html', content: 'synthetic' }], {})).rejects.toThrow();
    expect(existsSync(h.grant.sourceRoot)).toBe(false); expect(h.commands).toHaveLength(0);
  }
});

test('a valid-looking remote reservation with no local private claim is refused before source generation', async () => {
  const h = setup(); const fetcher = (async (url: URL | RequestInfo) => Response.json(String(url).endsWith('/owner')
    ? { memberId: h.grant.ownerId, userSlug: h.grant.userSlug } : h.grant)) as typeof fetch;
  const host = createBuildExecution({ ...h.options, fetcher });
  await expect(host.reserve(h.grant.ownerId, h.grant.runId, h.grant.appSlug)).rejects.toThrow();
  expect(existsSync(h.grant.sourceRoot)).toBe(false);
});

test('official SDK identity stays remote while local C reserve, attest, writer and seal share a private claim', async () => {
  const h = setup(); const configDir = join(h.root, 'config'); mkdirSync(configDir, { mode: 0o700 });
  const runtimePath = join(configDir, 'runtime.json');
  writeFileSync(join(configDir, 'acp-token'), 'synthetic-local-control', { mode: 0o600 });
  writeFileSync(runtimePath, JSON.stringify({ pid: process.pid, httpAuth: 'on', httpPort: 31415 }), { mode: 0o600 });
  const sealRoot = join(h.root, 'seals'); const runtimeRoot = join(h.root, 'runtime');
  for (const path of [sealRoot, runtimeRoot]) mkdirSync(path, { mode: 0o700 });
  const session = { nexusUrl: OFFICIAL_MEMBER_ORIGIN, sessionToken: 'aps_synthetic_sdk', appSlug: h.grant.appSlug };
  let sessionLive = true;
  let relayKeyLive = true;
  const authorityRoot = join(configDir, 'app-build', 'authority');
  const runAuthority = createAppBuildRunAuthority({ root: authorityRoot, hostKey: 'a'.repeat(64),
    retainedSession: () => session, relayKeyFingerprint: () => relayKeyLive ? sha('synthetic-relay-key') : undefined });
  const issuer = createDynamicAppPublisher({ sourceRoot: h.options.sourceRoot, sealRoot, runtimeRoot, appHost: {} as NexusAppHost,
    testMemberId: h.grant.ownerId, testHandle: h.grant.userSlug, testApprovalExpiresAt: h.grant.issuerExpiresAt,
    issuerSourceHead: h.grant.sourceHead, approveArtifact: () => false });
  const requests: Array<{ origin: string; path: string; auth: string | null }> = [];
  const ownerFetcher = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ memberId: h.grant.ownerId, userSlug: h.grant.userSlug })) as typeof fetch;
  const bridge = createAppBuildLocalIssuerBridge({ publisher: issuer, sourceHead: h.grant.sourceHead,
    peerAddress: getAuthPeerAddress,
    getSession: () => sessionLive ? session : undefined, fetcher: ownerFetcher, runAuthority,
    authorizeControl: request => request.headers.get('authorization') === 'Bearer synthetic-local-control' });
  const fetcher = (async (input, init) => {
    const url = new URL(String(input)); const auth = new Headers(init?.headers).get('authorization');
    requests.push({ origin: url.origin, path: url.pathname, auth });
    if (url.origin === OFFICIAL_MEMBER_ORIGIN) {
      expect(url.pathname).toBe('/v1/members/owner'); expect(url.searchParams.get('appSlug')).toBe(h.grant.appSlug);
      expect(auth).toBe('Bearer aps_synthetic_sdk');
      return ownerFetcher(input, init);
    }
    expect(url.origin).toBe('http://127.0.0.1:31415'); expect(auth).toBe('Bearer synthetic-local-control');
    const candidate = new Request(input, init); registerAuthPeerAddress(candidate, '127.0.0.1');
    return (await bridge(candidate)) ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  const host = createBuildExecution({ ...h.options, getSession: () => sessionLive ? session : undefined,
    fetcher, issuerBridge: { configDir, runtimePath }, authorityRoot });
  const grant = await host.reserve(h.grant.ownerId, h.grant.runId, h.grant.appSlug);
  sessionLive = false; // The SDK expires while file generation is still running.
  const saved = [{ path: 'backend/main.ts', content: 'export const value = true;', sha256: sha('export const value = true;') }];
  await host.save(grant, sha('plan'), saved);
  expect(await host.load(grant)).toEqual({ planDigest: sha('plan'), files: saved });
  expect((await host.verify(grant, saved)).passed).toBe(true);
  const files = [{ path: 'ARCHITECTURE.md', content: '# Synthetic architecture' },
    { path: 'backend/main.ts', content: 'export const fetch = () => new Response("synthetic");' }];
  await host.materialize(grant, files, { runtime: { startCommand: ['bun', 'backend/main.ts'], healthPath: '/health' } });
  expect(readFileSync(join(grant.sourceRoot, 'backend/main.ts'), 'utf8')).toBe(files[1]!.content);
  const inspected = await issuer.inspect({ memberId: grant.ownerId, userSlug: grant.userSlug }, grant.runId, grant.appSlug, () => true);
  expect(inspected.status).toBe('inspected');
  expect(session.nexusUrl).toBe(OFFICIAL_MEMBER_ORIGIN);
  expect(requests.some(request => request.path.endsWith('/dynamic-deployment-local'))).toBe(true);
  expect(requests.filter(request => request.path === '/v1/members/owner')).toHaveLength(1);
  relayKeyLive = false;
  await expect(host.publish(grant)).rejects.toThrow('BUILD_AUTHORITY_REFUSED');
});

test('private byte checkpoints survive a fresh host but never count as sandbox execution evidence', async () => {
  const h = setup(); const grant = await h.host.reserve(h.grant.ownerId, h.grant.runId, h.grant.appSlug);
  const files = [{ path: 'backend/main.ts', content: 'export const value = true;', sha256: sha('export const value = true;') }];
  await h.host.save(grant, sha('plan'), files);
  const restarted = createBuildExecution(h.options);
  expect(await restarted.load(grant)).toEqual({ planDigest: sha('plan'), files });
  await restarted.materialize(grant, files, {});
  expect(h.commands).toHaveLength(1);
});

test('unsupported sandbox platforms fail closed without a shell or app artifact', async () => {
  const h = setup(); const grant = await h.host.reserve(h.grant.ownerId, h.grant.runId, h.grant.appSlug);
  const host = createBuildExecution({ ...h.options, platform: 'linux' });
  await expect(host.verify(grant, [{ path: 'fixture.test.ts', content: 'export {}' }])).rejects.toThrow('BUILD_SANDBOX_UNAVAILABLE');
  expect(h.commands).toHaveLength(0); expect(existsSync(h.grant.sourceRoot)).toBe(false);
});

test('checkpoint bytes with another app slot identity are refused despite matching file hashes', async () => {
  const h = setup(); const grant = await h.host.reserve(h.grant.ownerId, h.grant.runId, h.grant.appSlug);
  const content = 'export const value = true;';
  await h.host.save(grant, sha('plan'), [{ path: 'backend/main.ts', content, sha256: sha(content) }]);
  const checkpoint = join(h.root, 'scratch', 'checkpoints', sha(grant.ownerId), grant.runId, grant.appSlug, 'latest.json');
  const saved = JSON.parse(readFileSync(checkpoint, 'utf8'));
  writeFileSync(checkpoint, JSON.stringify({ ...saved, appSlug: 'another-app' }));
  await expect(h.host.load(grant)).rejects.toThrow('BUILD_AUTHORITY_REFUSED');
  expect(h.commands).toHaveLength(0);
});

test.skipIf(process.platform !== 'darwin')('real Darwin sandbox denies outside synthetic file, parent environment, network and subprocesses', async () => {
  const h = setup(true); const grant = await h.host.reserve(h.grant.ownerId, h.grant.runId, h.grant.appSlug);
  const outside = join(h.root, 'outside-private-fixture'); writeFileSync(outside, 'synthetic-private', { mode: 0o600 });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('synthetic-network') });
  const previous = process.env.APP_BUILD_SYNTHETIC_PARENT_FIXTURE;
  process.env.APP_BUILD_SYNTHETIC_PARENT_FIXTURE = 'synthetic-parent-only';
  const code = [
    'import {test,expect} from "bun:test"; import {readFileSync} from "node:fs";',
    'test("private file denied",()=>expect(()=>readFileSync(' + JSON.stringify(outside) + ')).toThrow());',
    'test("clean env",()=>expect(process.env.APP_BUILD_SYNTHETIC_PARENT_FIXTURE).toBeUndefined());',
    'test("network denied",async()=>{let denied=false;try{await fetch(' + JSON.stringify(server.url.href) + ',{signal:AbortSignal.timeout(' + String(DEFAULT_TIMEOUT_MS / APP_BUILD_MAX_FILES) + ')});}catch{denied=true;}expect(denied).toBe(true);});',
    'test("listener denied",()=>{let denied=false;try{const s=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("synthetic")});s.stop(true);}catch{denied=true;}expect(denied).toBe(true);});',
    'test("fork denied",()=>{let denied=false;try{const r=Bun.spawnSync(["/usr/bin/true"]);denied=!r.success;}catch{denied=true;}expect(denied).toBe(true);});',
  ].join('\n');
  try {
    const tested = await h.host.verify(grant, [{ path: 'sandbox.test.ts', content: code }]);
    if (!tested.passed) throw new Error('sandbox fixture failed: ' + tested.diagnostic);
    expect(tested.passed).toBe(true); expect(tested.sandbox).toBe('darwin-private-netoff-envempty');
  } finally {
    server.stop(true);
    if (previous === undefined) delete process.env.APP_BUILD_SYNTHETIC_PARENT_FIXTURE;
    else process.env.APP_BUILD_SYNTHETIC_PARENT_FIXTURE = previous;
  }
});

test('B2 measures each declared test file independently and refuses missing strategy files before shell execution', async () => {
  const h = setup(); const grant = await h.host.reserve(h.grant.ownerId, h.grant.runId, h.grant.appSlug);
  const strategy = [{ id: 'unit-check', kind: 'unit' as const, target: 'an explicit assertion', testFile: 'tests/unit.test.ts',
    device: 'bun-test-sandbox' as const, command: ['bun', 'test', './tests/unit.test.ts'] as ['bun', 'test', string] }];
  const file = { path: 'tests/unit.test.ts', content: 'import {test,expect} from "bun:test";test("value",()=>expect(true).toBe(true));' };
  await expect(h.host.verify(grant, [], undefined, strategy)).rejects.toThrow('test strategy');
  expect(h.commands).toHaveLength(0);
  const report = await h.host.verify(grant, [file], undefined, strategy);
  expect(report.passed).toBe(true);
  expect(h.commands.map(call => call.command.slice(-2))).toContainEqual(['test', './tests/unit.test.ts']);
  expect(report.testReceipts).toEqual([expect.objectContaining({ strategyId: 'unit-check', passed: true,
    exitCode: 0, testFile: file.path, fileSha256: sha(file.content) })]);
  const failing = createBuildExecution({ ...h.options, shell: (async request => {
    h.commands.push(request); return { outcome: 'exit', exitCode: request.command.at(-1) === './tests/unit.test.ts' ? 1 : 0,
      stdout: '', stderr: 'assertion failed', sandboxed: true, sandboxTool: 'sandbox-exec', truncated: false };
  }) as typeof runShell });
  const failure = await failing.verify(grant, [file], undefined, strategy);
  expect(failure.passed).toBe(false);
  expect(failure.testReceipts?.[0]?.passed).toBe(false);
});

test('strategy isolation excludes substring collisions and restores source after a prior test mutation', async () => {
  const h = setup(); const grant = await h.host.reserve(h.grant.ownerId, h.grant.runId, h.grant.appSlug);
  const target = { path: 'tests/foo.test.ts', content: 'export const original = true;' };
  const collision = { path: 'tests/foo.test.tsx', content: 'import {test} from "bun:test";test("wrong file",()=>{});' };
  const dependency = { path: 'backend/value.ts', content: 'export const value = "original";' };
  const strategy = [{ id: 'foo', kind: 'unit' as const, target: 'only the selected entry', testFile: target.path,
    device: 'bun-test-sandbox' as const, command: ['bun', 'test', './' + target.path] as ['bun', 'test', string] }];
  let suiteObserved = false;
  let isolatedObserved = false;
  const host = createBuildExecution({ ...h.options, shell: (async request => {
    const app = request.cwd!;
    if (request.command.at(-1) === 'test') {
      suiteObserved = existsSync(join(app, collision.path));
      writeFileSync(join(app, target.path), 'mutated test');
      writeFileSync(join(app, dependency.path), 'mutated dependency');
    } else {
      isolatedObserved = true;
      expect(existsSync(join(app, collision.path))).toBe(false);
      expect(readFileSync(join(app, target.path), 'utf8')).toBe(target.content);
      expect(readFileSync(join(app, dependency.path), 'utf8')).toBe(dependency.content);
    }
    // An empty selected test cannot borrow a colliding file's success.
    return { outcome: 'exit', exitCode: request.command.at(-1) === 'test' ? 0 : 1,
      stdout: '', stderr: 'No tests found', sandboxed: true, sandboxTool: 'sandbox-exec', truncated: false };
  }) as typeof runShell });
  const measured = await host.verify(grant, [target, collision, dependency], undefined, strategy);
  expect(suiteObserved).toBe(true); expect(isolatedObserved).toBe(true);
  expect(measured.passed).toBe(false);
  expect(measured.testReceipts?.[0]).toEqual(expect.objectContaining({ strategyId: 'foo', passed: false,
    selection: 'isolated-test-entry', fileSha256: sha(target.content) }));
});

test('actual Bun runs the selected entry without its colliding test while retaining a filename-matching JSON fixture', async () => {
  const h = setup(); const grant = await h.host.reserve(h.grant.ownerId, h.grant.runId, h.grant.appSlug);
  const target = { path: 'tests/foo.test.ts', content: 'import {test,expect} from "bun:test"; import fixture from "./foo.test.ts.fixture.json"; test("selected fixture",()=>expect(fixture.ok).toBe(true));' };
  const fixture = { path: 'tests/foo.test.ts.fixture.json', content: '{"ok":true}' };
  const collision = { path: 'tests/foo.test.tsx', content: 'import {test,expect} from "bun:test"; test("colliding entry",()=>expect(false).toBe(true));' };
  const strategy = [{ id: 'fixture-check', kind: 'unit' as const, target: 'fixture dependency preserved', testFile: target.path,
    device: 'bun-test-sandbox' as const, command: ['bun', 'test', './' + target.path] as ['bun', 'test', string] }];
  const observed: Array<{selected: boolean; exitCode: number}> = [];
  // Real Bun discovery/execution on synthetic files only. This injected adapter
  // deliberately does not claim a kernel sandbox or real-provider integration.
  const host = createBuildExecution({ ...h.options, shell: (async request => {
    const app = request.cwd!;
    const selected = request.command.at(-1) !== 'test';
    if (selected) {
      expect(existsSync(join(app, collision.path))).toBe(false);
      expect(readFileSync(join(app, fixture.path), 'utf8')).toBe(fixture.content);
    }
    const child = Bun.spawn([process.execPath, 'test', ...(selected ? ['./' + target.path] : [])], {
      cwd: app, env: { HOME: app, TMPDIR: app, PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited,
      new Response(child.stdout).text(), new Response(child.stderr).text()]);
    observed.push({ selected, exitCode });
    return { outcome: 'exit', exitCode, stdout, stderr, sandboxed: true, sandboxTool: 'sandbox-exec', truncated: false };
  }) as typeof runShell });
  const report = await host.verify(grant, [target, fixture, collision], undefined, strategy);
  expect(observed).toEqual([{ selected: false, exitCode: 1 }, { selected: true, exitCode: 0 }]);
  expect(report.passed).toBe(false); // Existing full-suite gate still detects the failing collision.
  expect(report.testReceipts?.[0]).toEqual(expect.objectContaining({ strategyId: 'fixture-check',
    passed: true, exitCode: 0, fileSha256: sha(target.content), selection: 'isolated-test-entry' }));
});

test('verify sets HOME and TMPDIR to the real path so an alias temp root can mkdtemp', async () => {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) return;
  const alias = mkdtempSync(join(tmpdir(), 'tmpdir-alias-'));
  const real = realpathSync(alias);
  if (alias === real) return;
  roots.push(real);
  const h = setup();
  const grant = await h.host.reserve(h.grant.ownerId, h.grant.runId, h.grant.appSlug);
  const probe = [
    'import { mkdtempSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { join } from "node:path";',
    'const dir = mkdtempSync(join(tmpdir(), "p-"));',
    'if (!dir.startsWith("/private/")) throw new Error("alias tmpdir");',
  ].join('\n');
  const host = createBuildExecution({ ...h.options, shell: undefined, scratchRoot: alias, sandboxProfile: undefined });
  const report = await host.verify(grant, [{ path: 'probe.test.ts', content: probe }]);
  expect(report.passed).toBe(true);
  expect(report.diagnostic).not.toContain('EPERM');
});

test('alias scratch root gives verify, save, and load the same canonical verdict', async () => {
  const alias = mkdtempSync(join(tmpdir(), 'scratch-alias-'));
  const real = realpathSync(alias);
  if (alias === real) return;
  roots.push(real);
  const h = setup();
  const grant = await h.host.reserve(h.grant.ownerId, h.grant.runId, h.grant.appSlug);
  const host = createBuildExecution({ ...h.options, scratchRoot: alias });
  const files = [{ path: 'backend/main.ts', content: 'export const fetch = () => new Response("ok");' }];
  const report = await host.verify(grant, files);
  const saved = await host.save(grant, 'c'.repeat(64), files.map(file => ({ ...file, sha256: sha(file.content) })));
  const loaded = await host.load(grant);
  const checkpoint = join(real, 'checkpoints', sha(grant.ownerId), grant.runId, grant.appSlug, 'latest.json');
  expect(report.passed).toBe(true);
  expect(saved.files).toBe(1);
  expect(loaded?.files).toEqual(files.map(file => ({ ...file, sha256: sha(file.content) })));
  expect(existsSync(checkpoint)).toBe(true);
  expect(existsSync(join(alias, 'checkpoints', sha(grant.ownerId), grant.runId, grant.appSlug, 'latest.json'))).toBe(true);
});
