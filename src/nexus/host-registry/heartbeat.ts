// HOST-HEARTBEAT-TO-NEXUS (ROSTER-0334 P2-3) — 스윕: 하트비트가 상한을 넘은 호스트를
// stale 표시해 넥서스 호스트 레지스트리가 진실을 유지. 기록 착지는 store.recordHeartbeat(재사용).
import { existsSync } from 'node:fs';
import { classifyHost } from './classify.js';
import { readHostLedgerStrict, withLedgerLock, writeHostLedgerAtomic } from './store.js';
import type { HostRecord } from './types.js';

export interface SweepStaleOptions {
  /** 스윕 상한. 기본 = classifyHost의 DEFAULT_STALE_MS(10분 — 출처: ROSTER-0334 P2-3 칸 정의). */
  staleMs?: number;
  /** Test seam: 기록 단계 실패 주입(recordHeartbeat와 같은 심). */
  renameImpl?: (from: string, to: string) => void;
}

/**
 * Maintenance sweep — never creates anything:
 * - 원장 부재(ENOENT) → [] (스윕은 유지보수, 빈 원장을 만들지 않는다)
 * - 하트비트 나이가 상한을 넘은(> staleMs; 나이 === 상한은 fresh) 호스트만 state 'stale' 표시,
 *   그 이름을 원장 등록 순으로 반환
 * - fresh 기록은 무손상(current/behind 분류 보존) — 재심박한 stale 호스트는 recordHeartbeat가 해제
 * - 직렬화된 읽기-수정-쓰기: 소유자 토큰 잠금 + tmp→rename 원자적 기록(실패 시 tmp 잔재 0)
 */
export function sweepStaleHosts(path: string, now: number, opts: SweepStaleOptions = {}): string[] {
  if (!existsSync(path)) return [];
  return withLedgerLock(path, () => {
    const ledger = readHostLedgerStrict(path);
    if (!ledger) return [];
    const swept: string[] = [];
    for (const [host, prev] of Object.entries(ledger.hosts)) {
      if (classifyHost(prev, undefined, now, opts.staleMs) !== 'stale') continue;
      const record: HostRecord = { ...prev, state: 'stale' };
      Object.defineProperty(ledger.hosts, host, { value: record, enumerable: true, writable: true, configurable: true });
      swept.push(host);
    }
    if (swept.length > 0) writeHostLedgerAtomic(ledger, path, opts.renameImpl);
    return swept;
  });
}