// 교차 프로세스 락 + reserved 만료 정리 시험 (JUD «배선 전 필수 FU» ①②)
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileReservationLedger, createInMemoryReservationLedger, LOCK_STALE_MS, RESERVATION_TTL_MS } from './llm-spend-reservation.js';

const T0 = new Date('2026-11-20T03:00:00.000Z');
const WORKER = join(import.meta.dir, 'llm-spend-reservation-lock.worker.ts');

async function runWorkers(path: string, n: number, cap: number, est: number): Promise<string[]> {
  const procs = Array.from({ length: n }, (_, i) =>
    Bun.spawn(['bun', WORKER, path, `w${i}`, String(cap), String(est)], { stdout: 'pipe', stderr: 'pipe' }));
  return Promise.all(procs.map(async (p) => { const out = (await new Response(p.stdout).text()).trim(); await p.exited; return out; }));
}

describe('교차 프로세스 락 — 자식 N개가 같은 파일 원장에 동시 reserve', () => {
  test('잔여 10 · 호출당 3 · 자식 8개 → 정확히 3건 OK · 5건 DENY · 합 9 (초과 허용 0)', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rsv-x-')), 'ledger.json');
    const outs = await runWorkers(path, 8, 10, 3);
    expect(outs.filter((o) => o === 'OK')).toHaveLength(3);
    expect(outs.filter((o) => o === 'DENY')).toHaveLength(5);
    const entries = (JSON.parse(readFileSync(path, 'utf8')) as { entries: { usd: number }[] }).entries;
    expect(entries.reduce((a, e) => a + e.usd, 0)).toBe(9);
    expect(entries).toHaveLength(3);
  }, 60_000);

  test('죽은 pid 가 남긴 락은 회수된다 — reserve 성공 · 락 파일 정리', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsv-dead-'));
    const path = join(dir, 'ledger.json');
    const child = Bun.spawn(['bun', '-e', 'process.exit(0)']);
    await child.exited; // 자식이 스스로 끝났다 — 그 pid 는 죽었다
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: child.pid, at: new Date().toISOString() }));
    const ledger = createFileReservationLedger(path);
    expect(ledger.reserve({ id: 'a', row: 'openrouter', estimateUsd: 2, at: T0.toISOString() })).toBe(true);
    expect(ledger.snapshot(T0)).toHaveLength(1);
    expect(() => readFileSync(`${path}.lock`, 'utf8')).toThrow();
  });

  test('살아 있는 pid 라도 LOCK_STALE_MS 보다 오래된 락은 회수된다', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rsv-old-')), 'ledger.json');
    const oldAt = new Date(Date.now() - LOCK_STALE_MS - 1000).toISOString();
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.ppid, at: oldAt })); // 부모 = 살아 있는 pid
    const ledger = createFileReservationLedger(path);
    expect(await ledger.withExclusive!(async () => ledger.reserve({ id: 'b', row: 'openrouter', estimateUsd: 1, at: T0.toISOString() }))).toBe(true);
  });

  test('withExclusive 안에서 reserve/commit 은 재진입(교착 0)', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rsv-re-')), 'ledger.json');
    const ledger = createFileReservationLedger(path);
    const ok = await ledger.withExclusive!(async () => ledger.reserve({ id: 'c', row: 'r', estimateUsd: 1, at: T0.toISOString() }) && ledger.commit('c', 0.5, T0.toISOString()));
    expect(ok).toBe(true);
    expect(ledger.snapshot(T0)[0]).toMatchObject({ state: 'committed', usd: 0.5 });
  });
});

describe('reserved 만료 정리 — crash 로 남은 예약이 상한을 영영 막지 않는다', () => {
  for (const [name, make] of [
    ['메모리', () => createInMemoryReservationLedger()],
    ['파일', () => createFileReservationLedger(join(mkdtempSync(join(tmpdir(), 'rsv-ttl-')), 'l.json'))],
  ] as const) {
    test(`${name}: commit/release 없이 방치 → TTL 직전엔 합 4 · TTL 뒤엔 0 · 다음 reserve 가 원장에서 걷음`, () => {
      const ledger = make();
      expect(ledger.reserve({ id: 'crash', row: 'openrouter', estimateUsd: 4, at: T0.toISOString() })).toBe(true);
      const before = new Date(T0.getTime() + RESERVATION_TTL_MS - 1);
      const after = new Date(T0.getTime() + RESERVATION_TTL_MS);
      expect(ledger.snapshot(before).reduce((a, e) => a + e.usd, 0)).toBe(4);
      expect(ledger.snapshot(after)).toHaveLength(0);
      expect(ledger.reserve({ id: 'next', row: 'openrouter', estimateUsd: 1, at: after.toISOString() })).toBe(true);
      expect(ledger.snapshot(after).map((e) => e.id)).toEqual(['next']);
    });
  }

  test('명시 expiresAt 이 TTL 보다 우선 · committed 는 만료로 빠지지 않는다', () => {
    const ledger = createInMemoryReservationLedger();
    ledger.reserve({ id: 'e', row: 'r', estimateUsd: 2, at: T0.toISOString(), expiresAt: new Date(T0.getTime() + 1000).toISOString() });
    ledger.reserve({ id: 'k', row: 'r', estimateUsd: 3, at: T0.toISOString() });
    ledger.commit('k', 3, T0.toISOString());
    const later = new Date(T0.getTime() + 2000);
    expect(ledger.snapshot(later).map((e) => e.id)).toEqual(['k']);
  });
});
