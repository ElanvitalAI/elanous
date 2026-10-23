import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearPostOffice, ensurePostOffice, postOfficeFile, readPostOffice, writePostOffice } from './msg-post-office.js';

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
