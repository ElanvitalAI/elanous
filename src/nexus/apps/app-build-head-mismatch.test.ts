import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAppBuildLocalIssuerBridge, OFFICIAL_MEMBER_ORIGIN } from './app-build-local-bridge.js';
import { BUILD_SOURCE_HEAD_STALE, BuildSourceHeadStaleError, readSourceHeadMismatch, SOURCE_HEAD_DISPLAY_CHARS,
  SOURCE_HEAD_MISMATCH_ERROR, sourceHeadMismatchResponse } from './app-build-head-mismatch.js';
import type { DynamicAppPublisher } from './dynamic-app-publish.js';
import { createBuildExecution } from '../../graph-runner/app-build/build-execution.js';
import { createAppBuildPublishApprovalProvider, createAppBuildPublishApprovalTransport } from '../../graph-runner/capability-providers/app-build-publish-approval.js';

// RAIL-STALE-TUI-HEAD 11-17: nexus restarted on fdfb7a6a, the MVP-B TUI still ran 1728371e.
const NEXUS_HEAD = 'fdfb7a6a'.padEnd(40, '1');
const TUI_HEAD = '1728371e'.padEnd(40, '0');
const short = (head: string) => head.slice(0, SOURCE_HEAD_DISPLAY_CHARS);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Fake bridge: the real route with a publisher that must never be reached on these paths. */
function fakeBridge() {
  const publisher = new Proxy({}, { get: () => { throw new Error('publisher reached'); } }) as DynamicAppPublisher;
  const bridge = createAppBuildLocalIssuerBridge({ publisher, sourceHead: NEXUS_HEAD,
    peerAddress: () => '127.0.0.1', getSession: () => undefined,
    authorizeControl: request => request.headers.get('authorization') === 'Bearer synthetic-local-control' });
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) =>
    (await bridge(new Request(input, init))) ?? new Response(null, { status: 404 })) as typeof fetch;
  return { bridge, fetcher };
}
function localIssuer(token = 'synthetic-local-control') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'head-mismatch-'))); roots.push(root);
  const runtimePath = join(root, 'runtime.json');
  writeFileSync(join(root, 'acp-token'), token, { mode: 0o600 });
  writeFileSync(runtimePath, JSON.stringify({ pid: process.pid, httpAuth: 'on', httpPort: 31415 }), { mode: 0o600 });
  return { configDir: root, runtimePath };
}
const request = (head: string, authorization = 'Bearer synthetic-local-control') =>
  new Request('http://127.0.0.1:31415/v1/apps/demo-app/dynamic-deployment-local', { method: 'POST',
    headers: { authorization, 'content-type': 'application/json', 'x-elanous-app-build-owner': 'member-a',
      'x-elanous-app-build-head': head }, body: JSON.stringify({ action: 'reserve', runId: 'run-a' }) });

test('bridge names a head mismatch with a typed 409 and short heads; auth and malformed heads keep 401/403', async () => {
  const { bridge } = fakeBridge();
  const stale = (await bridge(request(TUI_HEAD)))!;
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({ error: SOURCE_HEAD_MISMATCH_ERROR, expectedHead: short(NEXUS_HEAD), gotHead: short(TUI_HEAD) });
  // Auth is judged first: an unauthenticated caller learns nothing about heads.
  expect((await bridge(request(TUI_HEAD, 'Bearer foreign')))!.status).toBe(401);
  expect((await bridge(request('not-a-head')))!.status).toBe(403);
});

test('mismatch response and reader each log app-build.head-mismatch with both heads', async () => {
  const events: Array<Record<string, unknown>> = [];
  const response = sourceHeadMismatchResponse(NEXUS_HEAD, TUI_HEAD, data => events.push(data));
  const error = await readSourceHeadMismatch(response, TUI_HEAD, { log: data => events.push(data), installedHead: () => NEXUS_HEAD });
  expect(error).toBeInstanceOf(BuildSourceHeadStaleError);
  expect(events).toEqual([
    { side: 'nexus-bridge', expectedHead: short(NEXUS_HEAD), gotHead: short(TUI_HEAD) },
    { side: 'client', tuiHead: short(TUI_HEAD), nexusHead: short(NEXUS_HEAD), installedHead: short(NEXUS_HEAD),
      staleSide: 'tui', message: error!.userMessage },
  ]);
  // Another 409 shape or another status stays the caller's ordinary refusal.
  expect(await readSourceHeadMismatch(Response.json({ error: 'other' }, { status: 409 }), TUI_HEAD, { log: () => {} })).toBeUndefined();
  expect(await readSourceHeadMismatch(Response.json({ error: SOURCE_HEAD_MISMATCH_ERROR }, { status: 403 }), TUI_HEAD, { log: () => {} })).toBeUndefined();
});

test('build execution maps a stale head to BUILD_SOURCE_HEAD_STALE with the restart message, not BUILD_AUTHORITY_REFUSED', async () => {
  const { fetcher: bridgeFetch } = fakeBridge();
  const session = { nexusUrl: OFFICIAL_MEMBER_ORIGIN, sessionToken: 'aps_synthetic_sdk', appSlug: 'demo-app' };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => new URL(String(input)).origin === OFFICIAL_MEMBER_ORIGIN
    ? Response.json({ memberId: 'member-a', userSlug: 'membera' }) : bridgeFetch(input, init)) as typeof fetch;
  const host = createBuildExecution({ sourceHead: TUI_HEAD, getSession: () => session, fetcher, issuerBridge: localIssuer(),
    installedHead: () => NEXUS_HEAD });
  const failure = await host.reserve('member-a', 'run-a', 'demo-app').then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(BuildSourceHeadStaleError);
  expect((failure as Error).message).toBe(BUILD_SOURCE_HEAD_STALE);
  expect((failure as BuildSourceHeadStaleError).userMessage)
    .toBe(`설치본이 갱신됨 · 이 TUI 는 옛 판(head ${short(TUI_HEAD)}) · 재기동 필요 (새 판 ${short(NEXUS_HEAD)})`);
});

test('restart advice follows the installed version: never «restart this TUI» when nexus is the old side', () => {
  // The TUI is the installed version (NEXUS_HEAD here) and nexus still runs the older TUI_HEAD.
  const nexusOld = new BuildSourceHeadStaleError(short(NEXUS_HEAD), short(TUI_HEAD), short(NEXUS_HEAD));
  expect(nexusOld.side).toBe('nexus');
  expect(nexusOld.userMessage).toBe(`nexus 가 옛 판(head ${short(TUI_HEAD)}) · 이 TUI 는 설치본 판(head ${short(NEXUS_HEAD)}) · nexus 재기동 필요`);
  const unknown = new BuildSourceHeadStaleError(short(TUI_HEAD), short(NEXUS_HEAD));
  expect(unknown.side).toBe('unknown');
  expect(unknown.userMessage).toBe(`판 불일치 · 이 TUI(head ${short(TUI_HEAD)}) ≠ nexus(head ${short(NEXUS_HEAD)}) · 설치본 판과 다른 쪽을 재기동`);
  expect(new BuildSourceHeadStaleError(short(TUI_HEAD), short(NEXUS_HEAD), short(NEXUS_HEAD)).side).toBe('tui');
});

test('build execution auth failure path is unchanged', async () => {
  const { fetcher: bridgeFetch } = fakeBridge();
  const session = { nexusUrl: OFFICIAL_MEMBER_ORIGIN, sessionToken: 'aps_synthetic_sdk', appSlug: 'demo-app' };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => new URL(String(input)).origin === OFFICIAL_MEMBER_ORIGIN
    ? Response.json({ memberId: 'member-a', userSlug: 'membera' }) : bridgeFetch(input, init)) as typeof fetch;
  const host = createBuildExecution({ sourceHead: TUI_HEAD, getSession: () => session, fetcher,
    issuerBridge: localIssuer('wrong-local-control') });
  await expect(host.reserve('member-a', 'run-a', 'demo-app')).rejects.toThrow('BUILD_AUTHORITY_REFUSED');
});

test('approval transport and provider surface the stale head; auth failure keeps the old refusal', async () => {
  const { fetcher } = fakeBridge();
  const stale = createAppBuildPublishApprovalTransport({ ...localIssuer(), sourceHead: TUI_HEAD, fetcher, installedHead: () => NEXUS_HEAD });
  await expect(stale('approval-start', 'demo-app', 'run-a', 'member-a')).rejects.toBeInstanceOf(BuildSourceHeadStaleError);
  const provider = createAppBuildPublishApprovalProvider({ transport: stale,
    trustedWindow: context => ({ signal: context.signal!, deadlineAtMs: Date.now() + 60_000 }) });
  const result = await provider({ graphId: 'app-build', runId: 'run-a', nodeId: 'approval', input: {}, outputs: {},
    graphInput: { context: { memberId: 'member-a' } }, verifiedOwnerId: 'member-a',
    nodeInput: { action: 'start', appSlug: 'demo-app', requireOwner: 'member-a' }, signal: new AbortController().signal } as never);
  expect(result).toEqual({ ok: false, outcome: 'failed',
    error: `${BUILD_SOURCE_HEAD_STALE}: 설치본이 갱신됨 · 이 TUI 는 옛 판(head ${short(TUI_HEAD)}) · 재기동 필요 (새 판 ${short(NEXUS_HEAD)})` });
  const unauthorized = createAppBuildPublishApprovalTransport({ ...localIssuer('wrong-local-control'), sourceHead: TUI_HEAD, fetcher });
  await expect(unauthorized('approval-start', 'demo-app', 'run-a', 'member-a')).rejects.toThrow('APP_BUILD_PUBLISH_APPROVAL_REFUSED');
});
