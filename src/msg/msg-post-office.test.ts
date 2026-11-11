import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceLedger } from '../control-plane/ledger.js';

import { clearPostOffice, ensurePostOffice, postOfficeFile, readPostOffice, writePostOffice, writeResidentPostOffice } from './msg-post-office.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'msg-post-office-'));
  dirs.push(dir);
  return dir;
}

test('write, read and clear keep the discovery line under <root>/msg/sse.json', () => {
  const dir = root();
  expect(readPostOffice(dir)).toBeNull();
  const written = writePostOffice(dir, { port: 47821, pid: 4242 });
  expect(postOfficeFile(dir)).toBe(join(dir, 'msg', 'sse.json'));
  expect(written).toEqual({ port: 47821, pid: 4242, url: 'http://127.0.0.1:47821' });
  expect(readPostOffice(dir)).toEqual(written);
  // 다른 프로세스가 적은 줄은 지우지 않는다 — 새 서비스가 이미 등록했을 수 있다.
  expect(clearPostOffice(dir, 9999)).toBe(false);
  expect(readPostOffice(dir)).toEqual(written);
  expect(clearPostOffice(dir, 4242)).toBe(true);
  expect(readPostOffice(dir)).toBeNull();
});

test('the control resource ledger discovers a registered post office after the legacy file is removed', () => {
  const dir = root();
  const written = writePostOffice(dir, { port: 47823, pid: 4243 });
  const records = new ResourceLedger(dir).list({ kind: 'instance', name: 'msg-sse' });
  expect(records).toHaveLength(1);
  expect(records[0]?.endpoint).toBe(written.url);
  rmSync(postOfficeFile(dir));
  expect(readPostOffice(dir)).toEqual(written);
  expect(clearPostOffice(dir, 4243)).toBe(true);
  expect(new ResourceLedger(dir).list({ kind: 'instance', name: 'msg-sse' })).toHaveLength(0);
});

test('a malformed or half-written discovery line reads as absent instead of a guessed port', () => {
  const dir = root();
  mkdirSync(join(dir, 'msg'), { recursive: true });
  for (const body of ['', 'not json', '{"port":"47821","pid":1}', '{"port":47821}', '{"port":-1,"pid":1}', '{"port":47821,"pid":0}', '[]']) {
    writeFileSync(postOfficeFile(dir), body);
    expect(readPostOffice(dir)).toBeNull();
  }
});

test('ensurePostOffice is a no-op without a registration and does not spawn in the test universe', async () => {
  const dir = root();
  let launches = 0;
  const launch = () => { launches++; };
  expect(await ensurePostOffice({ stateRoot: dir, launch })).toEqual({ state: 'absent' });
  expect(launches).toBe(0);

  writePostOffice(dir, { port: 47822, pid: 4242 });
  expect(await ensurePostOffice({ stateRoot: dir, alive: () => true, probe: async () => true, launch }))
    .toEqual({ state: 'listening', port: 47822 });
  expect(launches).toBe(0);
  // 살아 있지만 응답이 없다(응답 없는 서비스) — 같은 포트로 다시 띄운다.
  expect(await ensurePostOffice({ stateRoot: dir, alive: () => true, probe: async () => false, launch }))
    .toEqual({ state: 'restarted', port: 47822 });
  expect(launches).toBe(1);
  expect(await ensurePostOffice({ stateRoot: dir, alive: () => false, probe: async () => true, launch }))
    .toEqual({ state: 'restarted', port: 47822 });
  expect(launches).toBe(2);
  // 실제 프로세스 발사는 격리 우주에서 열지 않는다 — 주입한 launch 가 없으면 skipped.
  expect(await ensurePostOffice({ stateRoot: dir, alive: () => false, probe: async () => false }))
    .toEqual({ state: 'skipped', reason: 'test-universe' });
});

// PR #30660 리뷰 SHOULD-FIX 구별자 — msg-cli.ts 의 postOfficeLaunch seam 이 소비하는 계약을 여기서도 이름 붙은 실패로 지킨다.
// 규칙을 깨면(ensurePostOffice 가 등록 포트 대신 다른 포트로 발사) 이 시험이 붉게 뜬다:
//   launch 호출이 port 0 을 받게 바꾸면 → fail: expected [ 0 ] to equal [ 47822 ].
test('a restart is ordered at the registered port and the discovery line survives for the next reader', async () => {
  const dir = root();
  const written = writePostOffice(dir, { port: 47822, pid: 4242 });
  const launched: number[] = [];
  const ensured = await ensurePostOffice({ stateRoot: dir, alive: () => false, probe: async () => false, launch: input => { launched.push(input.port); } });
  // 발사는 등록 줄의 포트 그대로 — 다시 띄운 서비스가 구독자가 이미 아는 포트에 붙는다.
  expect(launched).toEqual([written.port]);
  expect(ensured).toEqual({ state: 'restarted', port: written.port });
  // 발견 줄은 남는다 — 다시 띄운 서비스가 자기 줄을 다시 적기 전까지 독자는 같은 포트를 본다.
  expect(readPostOffice(dir)).toEqual(written);
});

test('an unrelated HTTP listener on the registered port is not mistaken for the SSE post office', async () => {
  const dir = root();
  const unrelated = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(null, { status: 204 }) });
  try {
    writePostOffice(dir, { port: unrelated.port, pid: process.pid });
    const launched: number[] = [];
    expect(await ensurePostOffice({ stateRoot: dir, launch: ({ port }) => { launched.push(port); } }))
      .toEqual({ state: 'restarted', port: unrelated.port });
    expect(launched).toEqual([unrelated.port]);
  } finally { unrelated.stop(true); }
});

test('a resident owner is not overwritten or cleared by a concurrent standalone server', async () => {
  const dir = root();
  const standalone = writePostOffice(dir, { port: 47824, pid: 4242 });
  let oldTimerAttempts = 0;
  let oldTimerRejected = 0;
  let oldTimerAccepted = 0;
  // Source: #36378 isolated timer simulation uses a 5ms tick and 30ms window to exercise older writes.
  const oldTimer = setInterval(() => {
    oldTimerAttempts++;
    try { new ResourceLedger(dir).register({ id: 'instance:msg-sse', kind: 'instance', machine: 'old', name: 'msg-sse',
      owner: 'msg-sse', endpoint: standalone.url, attrs: { port: standalone.port, pid: 4242 }, observedAt: Date.now(), ttlMs: Number.MAX_SAFE_INTEGER,
    }, 'msg-sse'); oldTimerAccepted++; } catch { oldTimerRejected++; }
  }, 5);
  // Source: #36378 the old timer first writes successfully, then keeps running across the atomic resident takeover.
  await Bun.sleep(15);
  // Source: #36378 the timer must have refreshed the standalone record before resident takeover.
  expect(oldTimerAccepted).toBeGreaterThan(0);
  const resident = (await writeResidentPostOffice(dir, { port: 47825, pid: process.pid }))!;
  expect(readPostOffice(dir)).toEqual(resident);
  expect(writePostOffice(dir, { port: standalone.port, pid: 4242 })).toEqual(resident);
  try { await Bun.sleep(30); } finally { clearInterval(oldTimer); }
  // Source: #36378 at least one timer tick proves the older writer was actually fenced.
  expect(oldTimerAttempts).toBeGreaterThan(0);
  // Source: #36378 the timer must attempt at least one write after resident takeover and be fenced.
  expect(oldTimerRejected).toBeGreaterThan(0);
  expect(oldTimerAccepted + oldTimerRejected).toBe(oldTimerAttempts);
  expect(readPostOffice(dir)).toEqual(resident);
  expect(await writeResidentPostOffice(dir, { port: 47826, pid: process.pid })).toEqual(resident);
  expect(clearPostOffice(dir, 4242, standalone.port)).toBe(false);
  expect(readPostOffice(dir)).toEqual(resident);
  expect(clearPostOffice(dir, process.pid, resident.port)).toBe(true);
  expect(readPostOffice(dir)).toBeNull();
});

test('standalone registration keeps sse.json discovery when the control ledger cannot be read', () => {
  const dir = root();
  mkdirSync(join(dir, 'control'), { recursive: true });
  writeFileSync(join(dir, 'control', 'ledger.json'), 'broken ledger');
  const info = writePostOffice(dir, { port: 47827, pid: 4242 });
  expect(readPostOffice(dir)).toEqual(info);
});
