import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepStaleHosts } from './heartbeat.js';
import { hostLedgerPath, readHostLedger, readHostLedgerStrict, recordHeartbeat } from './store.js';
import type { HostLedger } from './types.js';

// HOST-HEARTBEAT-TO-NEXUS (ROSTER P2-3) — 하트비트→원장 기록은 store.recordHeartbeat(재사용),
// 이 칸의 신규 계약은 sweep: 뒤처진 하트비트를 stale 표시해 넥서스 레지스트리를 진실 유지.
// 증거 우주 = 운영(원장 1행) ⊕ 합성(사건 주입). 출처 주석은 합성 상한 기준.

const T0 = 1_794_000_000_000; // 출처: HOST-HEARTBEAT FIXTURE 기준 시각(합성)
const SHA_A = 'a'.repeat(40); // 출처: HOST-HEARTBEAT FIXTURE installedSha 40hex(합성)
const SHA_B = 'b'.repeat(40); // 출처: HOST-HEARTBEAT FIXTURE installedSha 40hex(합성)
const MIN = 60_000; // 출처: #39747 FIXTURE 분 단위 환산(합성)

function withTempLedger(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hbreg-'));
  mkdirSync(join(dir, 'sub'), { recursive: true });
  return { dir, path: join(dir, 'sub', 'host-registry.json') };
}

test('하트비트 착지(재사용): 첫 recordHeartbeat → ENOENT에서 version:1 원장 생성 · channel unknown · 원문과 디스크 일치', () => {
  const { dir, path } = withTempLedger();
  try {
    expect(existsSync(path)).toBe(false); // 출처: HOST-HEARTBEAT FIXTURE 부재(ENOENT) 경계
    const rec = recordHeartbeat('node-b', SHA_A, T0, { path });
    expect(rec).toMatchObject({ host: 'node-b', installedSha: SHA_A, lastHeartbeatMs: T0, channel: 'unknown' }); // 추측 금지
    const ledger = readHostLedgerStrict(path)!;
    expect(ledger.version).toBe(1);
    expect(ledger.hosts['node-b']!.lastHeartbeatMs).toBe(T0); // 출처: HOST-HEARTBEAT FIXTURE 기록 시각 정합
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('합성 사건 주입: 4 host 하트비트(1개 15분 뒤처짐) → sweep이 1개만 stale 표시 · 나머지 무훼손(디스크 확인)', () => {
  const { dir, path } = withTempLedger();
  try {
    recordHeartbeat('node-c', SHA_A, T0 - 1, { path }); // 출처: HOST-HEARTBEAT FIXTURE node-c 1ms 선행(합성)
    recordHeartbeat('mbp', SHA_B, T0 - 2, { path }); // 출처: HOST-HEARTBEAT FIXTURE mbp 2ms 선행(합성)
    recordHeartbeat('node-b', SHA_A, T0, { path });
    recordHeartbeat('stale-host', SHA_A, T0 - 15 * MIN, { path }); // 출처: HOST-HEARTBEAT FIXTURE 뒤처짐 경계(15분, 합성)
    const swept = sweepStaleHosts(path, T0); // 기본 staleMs 상한으로 스윕
    expect(swept).toEqual(['stale-host']); // 15분 > 10분 → 이 host만
    const ledger = readHostLedgerStrict(path)!;
    expect(ledger.hosts['stale-host']!.state).toBe('stale');
    expect(ledger.hosts['node-c']!.state).not.toBe('stale'); // 방금 심박 → 무훼손
    expect(ledger.hosts['node-b']!.lastHeartbeatMs).toBe(T0); // 출처: HOST-HEARTBEAT FIXTURE 미건드 훼손 0
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('재심박 보존: 두 번째 recordHeartbeat → prev aliases·seat·channel 유지', () => {
  const { dir, path } = withTempLedger();
  try {
    writeFileSync(path, JSON.stringify({
      version: 1,
      hosts: { 'node-b': { host: 'node-b', aliases: ['primary'], seat: 'RES', channel: 'dev', installedSha: SHA_A, lastHeartbeatMs: T0, state: 'current' } }, // 출처: HOST-HEARTBEAT FIXTURE 선행 기록(합성)
    } satisfies HostLedger));
    const rec = recordHeartbeat('node-b', SHA_B, T0 + MIN, { path }); // 출처: HOST-HEARTBEAT FIXTURE 재심박(+60s, 합성)
    expect(rec).toMatchObject({ host: 'node-b', aliases: ['primary'], seat: 'RES', channel: 'dev', installedSha: SHA_B });
    expect(readHostLedgerStrict(path)!.hosts['node-b']!.aliases).toEqual(['primary']); // 보존 회귀
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('desiredSha 옵션: 일치 → current(대소문자 무시) · 불일치 → behind', () => {
  const { dir, path } = withTempLedger();
  try {
    expect(recordHeartbeat('node-b', SHA_A, T0, { path, desiredSha: SHA_A.toUpperCase() }).state).toBe('current');
    expect(recordHeartbeat('mbp', SHA_B, T0, { path, desiredSha: SHA_A }).state).toBe('behind');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('경계: 하트비트 나이 === staleMs → fresh(stale 아님)', () => {
  const { dir, path } = withTempLedger();
  try {
    recordHeartbeat('node-b', SHA_A, T0, { path });
    const swept = sweepStaleHosts(path, T0 + 10 * MIN); // 출처: HOST-HEARTBEAT FIXTURE 기본 stale 상한(10분) 경계
    expect(swept).toEqual([]); // age === 상한 → fresh
    expect(readHostLedgerStrict(path)!.hosts['node-b']!.state).not.toBe('stale');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('원자성: 스윕 renameImpl throw → tmp 잔재 0 · 원장 무손상 · lock 해제 후 재시도 성공', () => {
  const { dir, path } = withTempLedger();
  try {
    recordHeartbeat('old-host', SHA_A, T0 - 20 * MIN, { path }); // 출처: HOST-HEARTBEAT FIXTURE 스윕 대상(합성)
    const before = readFileSync(path, 'utf8');
    expect(() => sweepStaleHosts(path, T0, { renameImpl: () => { throw new Error('boom'); } })).toThrow(/boom/);
    expect(readdirSync(join(dir, 'sub'))).toEqual(['host-registry.json']); // tmp 잔재 0
    expect(readFileSync(path, 'utf8')).toBe(before); // 원장 무손상
    const swept = sweepStaleHosts(path, T0); // lock 해제 회귀 — 재시도 성공
    expect(swept).toEqual(['old-host']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('스윕 부재(ENOENT) → [] · 파일 생성 없음', () => {
  const { dir, path } = withTempLedger();
  try {
    expect(sweepStaleHosts(path, T0)).toEqual([]);
    expect(existsSync(path)).toBe(false); // 빈 원장은 만들지 않는다(스윕은 유지보수)
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('운영 원장 1행: ops 표본 행 → 하트비트 적용 → HostRecord 운영 출처 정합 · display 읽기 회귀', () => {
  const { dir, path } = withTempLedger();
  try {
    writeFileSync(path, JSON.stringify({
      version: 1,
      hosts: { 'ops-host': { host: 'ops-host', seat: 'RES-INFRA', channel: 'release', installedSha: SHA_A, lastHeartbeatMs: T0 - 5 * MIN, state: 'unknown' } }, // 출처: HOST-HEARTBEAT FIXTURE 운영 1행 표본(운영 우주 모사)
    } satisfies HostLedger));
    const rec = recordHeartbeat('ops-host', SHA_A, T0, { path });
    expect(rec).toMatchObject({ host: 'ops-host', seat: 'RES-INFRA', channel: 'release', installedSha: SHA_A, lastHeartbeatMs: T0 }); // 운영 출처 정합
    expect(sweepStaleHosts(path, T0)).toEqual([]); // 방금 심박 → fresh
    expect(readHostLedger(path)!.hosts['ops-host']!.lastHeartbeatMs).toBe(T0); // display 읽기 회귀
    expect(hostLedgerPath().endsWith('host-registry.json')).toBe(true); // 기본 경로 = 넥서스 레지스트리 정본
  } finally { rmSync(dir, { recursive: true, force: true }); }
});