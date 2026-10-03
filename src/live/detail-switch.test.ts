import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitDecision, isLiveDetailOn, liveDetailPath, readLiveDetail, resetLiveDetailCacheForTesting, selectLiveDetail, writeLiveDetail } from './detail-switch.js';
import { handleLiveDetail } from '../nexus/api/live-detail.js';
import { handleInsideEvents, subscribeInsideEvent } from '../nexus/api/inside-events.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'live-detail-')); dirs.push(d); return join(d, 'live', 'detail.json'); };
const originalDetailUntil = process.env.ELANOUS_LIVE_DETAIL_UNTIL;
beforeEach(() => { delete process.env.ELANOUS_LIVE_DETAIL_UNTIL; });
afterEach(() => {
  if (originalDetailUntil === undefined) delete process.env.ELANOUS_LIVE_DETAIL_UNTIL;
  else process.env.ELANOUS_LIVE_DETAIL_UNTIL = originalDetailUntil;
  resetElanousConfigDir();
  resetLiveDetailCacheForTesting();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test('기본은 꺼짐 — 파일이 없거나 깨졌으면 상세 관측을 안 낸다(fail-closed)', () => {
  const path = tmp();
  expect(isLiveDetailOn('run-1', { path })).toBe(false);
  writeLiveDetail({ ttlMin: 5 }, { path, now: 0 });
  writeFileSync(path, '{broken');
  expect(isLiveDetailOn('run-1', { path, now: 1 })).toBe(false);
  expect(emitDecision({ kind: 'ROUTE', what: 'x', reason: 'y', purpose: 'z', target: 't', runId: 'run-1' }, { path, now: 1 })).toBe(false);
});

test('범위 all 은 모든 런 · 런 id 범위는 그 런만 · until 이 지나면 저절로 꺼진다', () => {
  const path = tmp();
  writeLiveDetail({ ttlMin: 30 }, { path, now: 1_000 });
  expect(isLiveDetailOn('any', { path, now: 2_000 })).toBe(true);
  expect(isLiveDetailOn('any', { path, now: 1_000 + 30 * 60_000 + 1 })).toBe(false);
  writeLiveDetail({ scope: 'run-7', ttlMin: 10 }, { path, now: 1_000 });
  expect(isLiveDetailOn('run-7', { path, now: 2_000 })).toBe(true);
  expect(isLiveDetailOn('run-8', { path, now: 2_000 })).toBe(false);
  expect(isLiveDetailOn(undefined, { path, now: 2_000 })).toBe(false);
});

test('ttlMin 0 은 끈다 · 상한 240분', () => {
  const path = tmp();
  writeLiveDetail({ ttlMin: 30 }, { path, now: 0 });
  expect(writeLiveDetail({ ttlMin: 0 }, { path, now: 10 })).toBeNull();
  expect(readLiveDetail({ path, now: 11 })).toBeNull();
  expect(writeLiveDetail({ ttlMin: 10_000 }, { path, now: 0 })!.until).toBe(240 * 60_000);
});

test('두 뿌리 — 자기 파일 부재면 운영 켜짐, 자기 off 는 가림, 둘 다 부재면 꺼짐', () => {
  const localRoot = mkdtempSync(join(tmpdir(), 'live-local-'));
  const prodRoot = mkdtempSync(join(tmpdir(), 'live-prod-'));
  dirs.push(localRoot, prodRoot);
  setElanousConfigDir(localRoot);
  const local = liveDetailPath(localRoot);
  const production = liveDetailPath(prodRoot);
  const opts = { prodPath: production, now: 1_000 };
  expect(selectLiveDetail(opts)).toMatchObject({ state: null, source: null, path: null });
  expect(isLiveDetailOn('run-1', opts)).toBe(false);
  writeLiveDetail({ scope: 'all', ttlMin: 30 }, { path: production, now: 0 });
  expect(isLiveDetailOn('run-1', opts)).toBe(true);
  expect(selectLiveDetail(opts)).toMatchObject({ source: 'production', path: production });
  writeLiveDetail({ scope: 'all', ttlMin: 5 }, { path: local, now: 1_000 });
  expect(isLiveDetailOn('run-1', opts)).toBe(true);
  expect(selectLiveDetail(opts)).toMatchObject({ source: 'local', path: local });
  writeLiveDetail({ ttlMin: 0 }, { path: local, now: 1_000 });
  expect(isLiveDetailOn('run-1', opts)).toBe(false);
  expect(selectLiveDetail(opts)).toMatchObject({ state: null, source: 'local', path: local });
  writeFileSync(local, '{broken');
  expect(isLiveDetailOn('run-1', { ...opts, now: 6_001 })).toBe(false);
  expect(selectLiveDetail({ ...opts, now: 6_001 }).source).toBe('local');
  expect(readLiveDetail({ path: production, now: 1_001 })).not.toBeNull();
  expect(emitDecision({ kind: 'ROUTE', what: 'off', reason: 'off', purpose: 'test', target: 'none', runId: 'run-1' }, opts)).toBe(false);
});

test('두 파일의 5초 캐시 — 파일 추가와 삭제는 만료 전까지 반영하지 않는다', () => {
  const local = tmp();
  const production = tmp();
  writeLiveDetail({ ttlMin: 30 }, { path: production, now: 0 });
  expect(isLiveDetailOn('r', { path: local, prodPath: production, now: 1_000 })).toBe(true);
  mkdirSync(join(local, '..'), { recursive: true });
  writeFileSync(local, JSON.stringify({ scope: 'all', since: 2_000, until: 2_000 }));
  expect(isLiveDetailOn('r', { path: local, prodPath: production, now: 2_001 })).toBe(true);
  expect(isLiveDetailOn('r', { path: local, prodPath: production, now: 6_001 })).toBe(false);
  expect(selectLiveDetail({ path: local, prodPath: production, now: 6_001 }).source).toBe('local');
  unlinkSync(local);
  expect(isLiveDetailOn('r', { path: local, prodPath: production, now: 6_002 })).toBe(false);
  expect(isLiveDetailOn('r', { path: local, prodPath: production, now: 11_002 })).toBe(true);
  writeFileSync(production, JSON.stringify({ scope: 'all', since: 12_000, until: 12_000 }));
  expect(isLiveDetailOn('r', { path: local, prodPath: production, now: 12_001 })).toBe(true);
  expect(isLiveDetailOn('r', { path: local, prodPath: production, now: 16_003 })).toBe(false);
});

test('env until 이 미래면 파일 부재·off 에서 모든 런을 켜고 만료 시 즉시 끈다', () => {
  const path = tmp();
  process.env.ELANOUS_LIVE_DETAIL_UNTIL = '2000';
  expect(isLiveDetailOn(undefined, { path, now: 1_000 })).toBe(true);
  expect(isLiveDetailOn('any-run', { path, now: 1_000 })).toBe(true);
  expect(selectLiveDetail({ path, now: 1_000 })).toMatchObject({ state: null, source: null, path: null });
  writeLiveDetail({ ttlMin: 0 }, { path, now: 1_000 });
  expect(isLiveDetailOn('other-run', { path, now: 1_001 })).toBe(true);
  expect(isLiveDetailOn('other-run', { path, now: 2_000 })).toBe(false);
});

test('env until 은 만료·잘못된 값이면 무시하며 파일의 활성 범위를 넓히지 않는다', () => {
  const path = tmp();
  for (const value of ['1000', 'not-a-date', '2000oops', '2e3', '-1', 'Infinity', '9007199254740992', '']) {
    process.env.ELANOUS_LIVE_DETAIL_UNTIL = value;
    expect(isLiveDetailOn('run-1', { path, now: 1_000 })).toBe(false);
  }
  process.env.ELANOUS_LIVE_DETAIL_UNTIL = '2000';
  writeLiveDetail({ scope: 'run-7', ttlMin: 10 }, { path, now: 1_000 });
  expect(isLiveDetailOn('run-7', { path, now: 1_001 })).toBe(true);
  expect(isLiveDetailOn('run-8', { path, now: 1_001 })).toBe(false);
});

test('emitDecision 은 env until 로 게이트하고 만료 또는 잘못된 값에서는 내지 않는다', () => {
  const path = tmp();
  const event = { kind: 'ROUTE' as const, what: 'env gate', reason: 'reason', purpose: 'test', target: 'target', runId: 'run-1' };
  process.env.ELANOUS_LIVE_DETAIL_UNTIL = '2000';
  expect(emitDecision(event, { path, now: 1_000 })).toBe(true);
  expect(emitDecision({ ...event, what: 'expired' }, { path, now: 2_000 })).toBe(false);
  process.env.ELANOUS_LIVE_DETAIL_UNTIL = 'bad';
  expect(emitDecision({ ...event, what: 'malformed' }, { path, now: 1_001 })).toBe(false);
  writeLiveDetail({ ttlMin: 0 }, { path, now: 1_000 });
  process.env.ELANOUS_LIVE_DETAIL_UNTIL = '3000';
  expect(emitDecision({ ...event, what: 'file off' }, { path, now: 1_001 })).toBe(true);
});

test('넥서스 끝점 — 소유자만 · POST 로 켜고 GET 으로 본다 · 나쁜 값 거절', async () => {
  const path = tmp();
  const deps = { path, authorize: (r: Request) => r.headers.get('authorization') === 'Bearer ok', now: () => 1_000 };
  const url = 'http://x/v1/live/detail';
  expect((await handleLiveDetail(new Request(url), deps)).status).toBe(401);
  const off = await (await handleLiveDetail(new Request(url, { headers: { authorization: 'Bearer ok' } }), deps)).json();
  expect(off.on).toBe(false);
  const on = await handleLiveDetail(new Request(url, { method: 'POST', headers: { authorization: 'Bearer ok' }, body: JSON.stringify({ scope: 'run-3', ttlMin: 15 }) }), deps);
  expect(await on.json()).toMatchObject({ on: true, scope: 'run-3', until: 1_000 + 15 * 60_000 });
  const bad = await handleLiveDetail(new Request(url, { method: 'POST', headers: { authorization: 'Bearer ok' }, body: JSON.stringify({ ttlMin: -1 }) }), deps);
  expect(bad.status).toBe(400);
  const badScope = await handleLiveDetail(new Request(url, { method: 'POST', headers: { authorization: 'Bearer ok' }, body: JSON.stringify({ scope: '../etc' }) }), deps);
  expect(badScope.status).toBe(400);
});

test('active PTY decision arrives on the shared inside publisher with secrets masked', () => {
  const path = tmp();
  writeLiveDetail({ ttlMin: 30 }, { path, now: 0 });
  const received: unknown[] = [];
  const unsubscribe = subscribeInsideEvent(event => received.push(event));
  try {
    expect(emitDecision({ kind: 'ROUTE', what: 'choose', reason: 'password="private"', purpose: 'test', target: 'pty', runId: 'pty-run' }, { path, now: 1_000 })).toBe(true);
    expect(received).toMatchObject([{ kind: 'pty.decision', decisionKind: 'ROUTE', runId: 'pty-run', reason: 'password="[REDACTED]"' }]);
  } finally { unsubscribe(); }
});

test('emitted PTY decision is delivered as a masked SSE frame', async () => {
  const path = tmp();
  writeLiveDetail({ ttlMin: 30 }, { path, now: 0 });
  const reader = handleInsideEvents(new Request('http://localhost/v1/inside/events')).body!.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(': inside events stream\n\n');
    expect(emitDecision({ kind: 'VERIFY', what: 'pty check', reason: 'Authorization: Basic dXNlcjpwYXNz', purpose: 'test', target: 'shell', runId: 'pty-sse' }, { path, now: 1_000 })).toBe(true);
    const frame = new TextDecoder().decode((await reader.read()).value);
    expect(frame).toStartWith('event: pty.decision\ndata: ');
    expect(frame).not.toContain('dXNlcjpwYXNz');
    expect(JSON.parse(frame.split('data: ')[1]!)).toMatchObject({ kind: 'pty.decision', decisionKind: 'VERIFY', runId: 'pty-sse' });
  } finally { await reader.cancel(); }
});

test('같은 판단이 5초 안에 두 번 오면 한 번만 낸다', () => {
  const path = tmp();
  writeLiveDetail({ ttlMin: 30 }, { path, now: 0 });
  const e = { kind: 'ROUTE' as const, what: 'a → b', reason: 'r', purpose: 'p', target: 'b', runId: 'r1' };
  expect(emitDecision(e, { path, now: 1_000 })).toBe(true);
  expect(emitDecision(e, { path, now: 1_001 })).toBe(false);
  expect(emitDecision(e, { path, now: 7_000 })).toBe(true);
});

test('Trace 칸: parentRunId·shard 를 env 에서 채운다(명시가 이긴다)', () => {
  const path = tmp();
  writeLiveDetail({ ttlMin: 30 }, { path, now: 0 });
  const prevP = process.env.ELANOUS_PARENT_RUN_ID; const prevS = process.env.ELANOUS_HARNESS_SPACE_ID;
  process.env.ELANOUS_PARENT_RUN_ID = 'run-parent'; process.env.ELANOUS_HARNESS_SPACE_ID = 'task-abc';
  try {
    expect(emitDecision({ kind: 'PLAN', what: 'x', reason: 'r', purpose: 'p', target: 't', runId: 'r9', phase: 'decompose' }, { path, now: 1 })).toBe(true);
    expect(emitDecision({ kind: 'PLAN', what: 'y', reason: 'r', purpose: 'p', target: 't', runId: 'r9', parentRunId: 'explicit' }, { path, now: 2 })).toBe(true);
  } finally {
    if (prevP === undefined) delete process.env.ELANOUS_PARENT_RUN_ID; else process.env.ELANOUS_PARENT_RUN_ID = prevP;
    if (prevS === undefined) delete process.env.ELANOUS_HARNESS_SPACE_ID; else process.env.ELANOUS_HARNESS_SPACE_ID = prevS;
  }
});
