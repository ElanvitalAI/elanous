import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectTuiMemberSessionFile, readTuiMemberSession, type TuiMemberSessionFileState } from './member-session-contract.js';
import { APP_BUILD_APPROVAL_SESSION_MS, APP_BUILD_EXPECTED_MS, APP_BUILD_RESERVE_SESSION_MS, MEMBER_APP_SESSION_TTL_MS,
  assertMemberSessionCovers, MemberSessionExpiringError } from './member-session-budget.js';
import { createAppBuildPublishApprovalProvider, createAppBuildPublishApprovalTransport } from '../graph-runner/capability-providers/app-build-publish-approval.js';
import { createBuildExecution } from '../graph-runner/app-build/build-execution.js';

// Synthetic token only — it must never reach a log line, an error message or stdout.
const TOKEN = 'aps_syntheticAbSessionNeverLogged';
const NOW = Date.parse('2026-11-17T09:00:00.000Z');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function sessionFile(expiresAt: number, appSlug = 'demo-app'): string {
  const dir = mkdtempSync(join(tmpdir(), 'ab-session-budget-')); roots.push(dir);
  const path = join(dir, 'member-session.json');
  writeFileSync(path, JSON.stringify({ nexusUrl: 'https://api.elanous.ai', sessionToken: TOKEN,
    expiresAt: new Date(expiresAt).toISOString(), appSlug }), { mode: 0o600 });
  return path;
}
const valid = (remainingMs: number): TuiMemberSessionFileState =>
  ({ state: 'valid', appSlug: 'demo-app', expiresAtMs: NOW + remainingMs, remainingMs, dev: 1, ino: 1 });

test('the reserve budget fits inside one session TTL and reserves the approval window', () => {
  expect(APP_BUILD_RESERVE_SESSION_MS).toBe(APP_BUILD_EXPECTED_MS + APP_BUILD_APPROVAL_SESSION_MS);
  // 출처: src/nexus/apps/app-auth.ts DEFAULT_SESSION_TTL_MS — 새 세션 하나로 reserve 예산을 채울 수 있어야 한다.
  expect(Math.min(MEMBER_APP_SESSION_TTL_MS, APP_BUILD_RESERVE_SESSION_MS)).toBe(APP_BUILD_RESERVE_SESSION_MS);
});

test('the token-free inspector separates missing, expired, valid and unsafe envelopes on a fake clock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-session-missing-')); roots.push(dir);
  expect(inspectTuiMemberSessionFile(join(dir, 'member-session.json'), NOW)).toEqual({ state: 'missing' });
  const expired = sessionFile(NOW - 1);
  const state = inspectTuiMemberSessionFile(expired, NOW);
  expect(state.state).toBe('expired');
  expect(JSON.stringify(state).includes(TOKEN)).toBe(false);
  expect(readTuiMemberSession(expired, NOW)).toBeUndefined();
  expect(readTuiMemberSession(expired, 0)?.sessionToken).toBe(TOKEN);
  const live = sessionFile(NOW + APP_BUILD_RESERVE_SESSION_MS);
  expect(inspectTuiMemberSessionFile(live, NOW)).toMatchObject({ state: 'valid', appSlug: 'demo-app', remainingMs: APP_BUILD_RESERVE_SESSION_MS });
  const linked = join(dir, 'linked.json'); symlinkSync(live, linked);
  expect(inspectTuiMemberSessionFile(linked, NOW)).toEqual({ state: 'unsafe' });
});

test('a near-expiry session refuses reserve up front with minutes only, and the expiring event carries no token', () => {
  const events: Array<Record<string, unknown>> = [];
  const short = APP_BUILD_RESERVE_SESSION_MS - 60_000;
  let caught: unknown;
  try { assertMemberSessionCovers('reserve', valid(short), (_event, data) => events.push(data)); }
  catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(MemberSessionExpiringError);
  const error = caught as MemberSessionExpiringError;
  expect(error.message).toBe('BUILD_MEMBER_SESSION_EXPIRING');
  expect(error.userMessage.startsWith(`세션 잔여 ${short / 60_000}분 < 빌드 예상 ${APP_BUILD_RESERVE_SESSION_MS / 60_000}분 · 재연결 필요`)).toBe(true);
  expect(events).toEqual([{ stage: 'reserve', remainingMinutes: short / 60_000,
    requiredMinutes: APP_BUILD_RESERVE_SESSION_MS / 60_000, expired: false }]);
  expect(() => assertMemberSessionCovers('reserve', valid(APP_BUILD_RESERVE_SESSION_MS), () => {})).not.toThrow();
  expect(() => assertMemberSessionCovers('reserve', { state: 'missing' }, () => {})).not.toThrow();
});

test('build reserve refuses a near-expiry session before any owner or bridge call', async () => {
  let fetched = 0; let sessionReads = 0;
  const host = createBuildExecution({ sourceHead: 'a'.repeat(40), now: () => NOW,
    getSession: () => { sessionReads++; return { nexusUrl: 'https://api.elanous.ai', sessionToken: TOKEN, appSlug: 'demo-app' }; },
    inspectSession: () => valid(APP_BUILD_RESERVE_SESSION_MS - 60_000),
    fetcher: (async () => { fetched++; return Response.json({}); }) as unknown as typeof fetch });
  await expect(host.reserve('synthetic-owner', 'synthetic-run', 'demo-app')).rejects.toBeInstanceOf(MemberSessionExpiringError);
  expect(fetched).toBe(0);
  expect(sessionReads).toBe(0);
});

test('approval-start refuses a session that would lapse inside the approval window, before the bridge', async () => {
  let fetched = 0;
  const logSpy = spyOn(console, 'log'); const errorSpy = spyOn(console, 'error');
  const writeSpy = spyOn(process.stdout, 'write');
  try {
    const transport = createAppBuildPublishApprovalTransport({ sourceHead: 'a'.repeat(40),
      configDir: join(tmpdir(), 'ab-session-no-runtime'), runtimePath: join(tmpdir(), 'ab-session-no-runtime.json'),
      inspectSession: () => valid(APP_BUILD_APPROVAL_SESSION_MS - 60_000),
      fetcher: (async () => { fetched++; return Response.json({}); }) as unknown as typeof fetch });
    await expect(transport('approval-start', 'demo-app', 'synthetic-run', 'synthetic-owner'))
      .rejects.toBeInstanceOf(MemberSessionExpiringError);
    const controller = new AbortController();
    const provider = createAppBuildPublishApprovalProvider({ transport,
      presentApprovalUrl: async () => {}, trustedWindow: context => ({ signal: context.signal!, deadlineAtMs: Date.now() + 60_000 }) });
    const result = await provider({ runId: 'synthetic-run', verifiedOwnerId: 'synthetic-owner', signal: controller.signal,
      nodeInput: { action: 'start', appSlug: 'demo-app', requireOwner: 'synthetic-owner' },
      graphInput: { context: { memberId: 'synthetic-owner' } } } as never);
    expect(result).toEqual({ ok: false, outcome: 'failed', error: `BUILD_MEMBER_SESSION_EXPIRING: 세션 잔여 ${
      (APP_BUILD_APPROVAL_SESSION_MS - 60_000) / 60_000}분 < 승인 예상 ${APP_BUILD_APPROVAL_SESSION_MS / 60_000}분 · 재연결 필요 (재연결하면 이 빌드는 다시 시작해야 합니다)` });
    expect(fetched).toBe(0);
    const printed = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...writeSpy.mock.calls].map(call => call.map(String).join(' ')).join('\n');
    expect(printed.includes(TOKEN)).toBe(false);
  } finally { logSpy.mockRestore(); errorSpy.mockRestore(); writeSpy.mockRestore(); }
});
