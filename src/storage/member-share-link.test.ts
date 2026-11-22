import { describe, expect, test } from 'bun:test';
// OP #127318 · ROSTER-0333-RANKED 31위 MEMBER-FILE-SHARE-LINK — 실패 먼저 시험.
// 설계 근거 내부 문서 `member-file-space` 완성조각 3: 만료/폐기 가능한 불투명 공유 토큰,
// 불변 객체 버전(generation) 결속, 해시만 저장, 읽기 전용·개별 폐기·재발급.
// 이 파일은 구현(member-share-link.ts)보다 먼저 작성되었고 그 시점에 실패해야 한다(RED).
// terra 셀프리뷰 mustFix ②③④ 수리(2026-11-22)를 위한 원장 계약 시험도 여기서 먼저 실패한다:
//   ② load(): 미존재 null / 파손 throw 구분 + 레코드 전수 검증(expiresAtMs 누락 등) fail-closed
//   ③ 인코딩된 구분자(%2F) 명시적 거부 + 검증한 정규 키 = 반환·원장 키 일치
//   ④ 갱신은 오직 update 경유(원자적) — load/save 직접 조작 금지 + mutate throw 시 원장 불변
// terra 재리뷰 r2(2026-11-22) ②보강·③ 수리도 먼저 실패한다(RED — 아래 r2 절):
//   ②보강 records 배열([] 포함)·비정규(인코딩 잔존) objectKey 저장 레코드 = 파손
//   ③ ttlMs: Infinity 발급·재발급 / 폐기 now 비유한수 = 거부(저장-읽기 계약 모순 제거) + 원장 불변
// JUD 보안 HOLD 수리(OP #128536 · 판정 jud-39544-ea7110a91a0e.json)도 먼저 실패한다(RED — 아래 JUD 절):
//   ① reissue 만료 검사 — 만료 토큰만으로 갱신 불가(경계는 resolve 와 동일: now > expires)
//   ② 재발급·폐기 소유자 검증 — 인증된 소유자(ownerMemberId)만 갱신·폐기, 타인·미지정 거부
//   ③ 객체 소유권 결속 — 발급 때의 소유자·객체·generation 이 저장·검증·재발급 전체에 유지

import {
  MEMBER_SHARE_LEDGER_NAME,
  createMemberShareLink,
  resolveMemberShareLink,
  revokeMemberShareLink,
  reissueMemberShareLink,
  type MemberShareLedger,
} from './member-share-link.js';

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = 1_797_000_000_000;

function newDir(): string {
  const dir = join(tmpdir(), `member-share-link-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 최소 원장(파일) — 계약 그대로: load 는 미존재 null·파손 throw 구분, update 는 단일 임계역(원자적). */
const fileLedger = (dir: string): MemberShareLedger => ({
  load: () => {
    try {
      return JSON.parse(readFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), 'utf8')) as Record<string, unknown>;
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return null; // 미존재 = 신규 초기화 허용
      throw e; // 파손(해석 불가)은 전파 — 미존재와 구분(fail-closed)
    }
  },
  update: <T>(mutate: (state: Record<string, unknown> | null) => { newState: Record<string, unknown>; result: T }): T => {
    let raw: Record<string, unknown> | null;
    try {
      raw = JSON.parse(readFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), 'utf8')) as Record<string, unknown>;
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') raw = null;
      else throw e;
    }
    const { newState, result } = mutate(raw); // mutate 가 throw 하면 save 없이 전파 → 원장 불변
    writeFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), JSON.stringify(newState));
    return result;
  },
});

describe('MEMBER-FILE-SHARE-LINK · 토큰 발급·검증 (설계 완성조각 3)', () => {
  test('발급: 256비트 불투명 토큰·원장에는 해시만, 소유자·generation 결속', () => {
    const dir = newDir();
    try {
      const rec = createMemberShareLink(fileLedger(dir), 'members/h1/private/a.pdf', {
        ownerMemberId: 'mem-1',
        generation: '1712345678901234',
        now: NOW,
      });
      expect(rec.token.startsWith('mfs1_')).toBe(true);
      // 토큰은 URL 안전(base64url) 32바이트 = 256비트 엔트로피
      expect(rec.token.length).toBeGreaterThanOrEqual('mfs1_'.length + 43);
      const state = JSON.parse(readFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), 'utf8'));
      const raw = JSON.stringify(state);
      expect(raw).not.toContain(rec.token); // 원장 원문에 평문 토큰 금지
      expect(rec.expiresAtMs).toBe(NOW + 7 * 24 * 3600_000); // 기본 만료 7일
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('검증: 유효 토큰 → 객체키·generation 반환', () => {
    const dir = newDir();
    try {
      const ledger = fileLedger(dir);
      const rec = createMemberShareLink(ledger, 'members/h1/private/b.md', {
        ownerMemberId: 'mem-1', generation: 'g2', now: NOW,
      });
      const got = resolveMemberShareLink(ledger, rec.token, { now: NOW + 1000 });
      expect(got.objectKey).toBe('members/h1/private/b.md');
      expect(got.generation).toBe('g2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('실패 경로: 잘못된 토큰·만료·폐기 뒤 접근은 모두 거부', () => {
    const dir = newDir();
    try {
      const ledger = fileLedger(dir);
      const rec = createMemberShareLink(ledger, 'members/h1/private/c.pdf', {
        ownerMemberId: 'mem-1', generation: 'g3', now: NOW,
      });
      expect(() => resolveMemberShareLink(ledger, 'mfs1_deadbeef', { now: NOW })).toThrow();
      // 만료(기본 7일 경과)
      expect(() => resolveMemberShareLink(ledger, rec.token, { now: NOW + 7 * 24 * 3600_000 + 1 })).toThrow();
      // 폐기 후 — JUD ② 폐기도 인증된 소유자 검증
      revokeMemberShareLink(ledger, rec.token, { ownerMemberId: 'mem-1', now: NOW + 5 });
      expect(() => resolveMemberShareLink(ledger, rec.token, { now: NOW + 6000 })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('generation 결속: 토큰은 발급 때의 generation만 가리킨다', () => {
    const dir = newDir();
    try {
      const ledger = fileLedger(dir);
      const rec = createMemberShareLink(ledger, 'members/h1/private/d.txt', {
        ownerMemberId: 'mem-1', generation: 'gen-old', now: NOW,
      });
      const got = resolveMemberShareLink(ledger, rec.token, { now: NOW + 1 });
      expect(got.generation).toBe('gen-old'); // 키가 같아도 새 generation 을 따라가지 않는다
      expect(rec.token.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('재발급: 새 토큰·폐기 이력과 함께, 옛 토큰은 즉시 무효', () => {
    const dir = newDir();
    try {
      const ledger = fileLedger(dir);
      const rec1 = createMemberShareLink(ledger, 'members/h1/private/e.txt', {
        ownerMemberId: 'mem-1', generation: 'g5', now: NOW,
      });
      const rec2 = reissueMemberShareLink(ledger, rec1.token, { ownerMemberId: 'mem-1', now: NOW + 10_000 }); // JUD ② 소유자 검증
      expect(rec2.token).not.toBe(rec1.token);
      expect(() => resolveMemberShareLink(ledger, rec1.token, { now: NOW + 11_000 })).toThrow();
      const got = resolveMemberShareLink(ledger, rec2.token, { now: NOW + 11_000 });
      expect(got.objectKey).toBe('members/h1/private/e.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('토큰 형식·객체키 검증: 경로 조작·디코딩 공격 거부', () => {
    const dir = newDir();
    try {
      const ledger = fileLedger(dir);
      expect(() => createMemberShareLink(ledger, '../escape.pdf', {
        ownerMemberId: 'mem-1', generation: 'g', now: NOW,
      })).toThrow();
      expect(() => createMemberShareLink(ledger, 'members/h1/private/%2e%2e/x', {
        ownerMemberId: 'mem-1', generation: 'g', now: NOW,
      })).toThrow();
      expect(() => createMemberShareLink(ledger, 'members/h1/private/nul\0x', {
        ownerMemberId: 'mem-1', generation: 'g', now: NOW,
      })).toThrow();
      expect(() => resolveMemberShareLink(ledger, '', { now: NOW })).toThrow();
      // 원장 파일 경계 확인용: MEMBER_SHARE_LEDGER_NAME 상수 존재
      expect(typeof MEMBER_SHARE_LEDGER_NAME).toBe('string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── terra mustFix ② 원장 파손 fail-closed ─────────────────────────────

  test('② 미존재(null)와 파손 구분: 빈 객체 원장은 신규 초기화가 아니라 파손으로 거부', () => {
    const dir = newDir();
    try {
      writeFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), '{}');
      expect(() => createMemberShareLink(fileLedger(dir), 'members/h1/private/x.pdf', {
        ownerMemberId: 'm', generation: 'g', now: NOW,
      })).toThrow(/corrupt/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('② 파손 JSON(해석 불가)은 미존재로 둔갑하지 않는다 — throw', () => {
    const dir = newDir();
    try {
      writeFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), '{"version":1,"records":{'); // 잘린 원장
      expect(() => resolveMemberShareLink(fileLedger(dir), 'mfs1_x', { now: NOW })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('② 레코드 전수 검증: expiresAtMs 누락 레코드는 만료 통과가 아니라 파손으로 거부', () => {
    const dir = newDir();
    try {
      const ledger = fileLedger(dir);
      const rec = createMemberShareLink(ledger, 'members/h1/private/ok.pdf', {
        ownerMemberId: 'm', generation: 'g', now: NOW,
      });
      const state = JSON.parse(readFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), 'utf8'));
      const key = Object.keys(state.records)[0];
      delete state.records[key].expiresAtMs; // 필수 필드 제거 — 파손
      writeFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), JSON.stringify(state));
      expect(() => resolveMemberShareLink(fileLedger(dir), rec.token, { now: NOW + 1 })).toThrow(/corrupt/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── terra mustFix ③ 인코딩된 구분자·정규 키 일치 ────────────────────────

  test('③ 인코딩된 구분자 %2F 는 디코딩 결과가 유효해도 명시적으로 거부', () => {
    const dir = newDir();
    try {
      expect(() => createMemberShareLink(fileLedger(dir), 'members/h1/private/a%2Fb.pdf', {
        ownerMemberId: 'm', generation: 'g', now: NOW,
      })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('③ 무해 인코딩은 정규화: 반환 키·원장 저장 키 = 검증한 정규(decoded) 키', () => {
    const dir = newDir();
    try {
      const rec = createMemberShareLink(fileLedger(dir), 'members/h1/private/a%2eb.pdf', {
        ownerMemberId: 'm', generation: 'g', now: NOW,
      });
      expect(rec.objectKey).toBe('members/h1/private/a.b.pdf');
      const state = JSON.parse(readFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), 'utf8'));
      const stored = Object.values(state.records)[0] as { objectKey: string };
      expect(stored.objectKey).toBe('members/h1/private/a.b.pdf'); // 원장도 정규 키만
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── terra mustFix ④ 원자적 갱신 계약 ──────────────────────────────────

  test('④ 갱신은 오직 update 경유 — load/save 직접 조작 금지 + mutate throw 시 원장 불변', () => {
    const dir = newDir();
    try {
      const base = fileLedger(dir);
      const calls: string[] = [];
      const spy: MemberShareLedger = {
        load: () => { throw new Error('mutation path must not call load directly'); },
        update: (mutate) => { calls.push('update'); return base.update(mutate); },
      };
      createMemberShareLink(spy, 'members/h1/private/s.pdf', { ownerMemberId: 'm', generation: 'g', now: NOW });
      expect(calls).toEqual(['update']); // 갱신이 정확히 한 번의 원자적 update 로 끝난다
      const before = readFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), 'utf8');
      expect(() => base.update(() => { throw new Error('boom'); })).toThrow('boom');
      expect(readFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), 'utf8')).toBe(before); // 원장 불변
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('④ 동시성 계약: 두 발급이 서로를 덮어쓰지 않는다(원자적 update 직렬화)', () => {
    const dir = newDir();
    try {
      const ledger = fileLedger(dir);
      const rec1 = createMemberShareLink(ledger, 'members/h1/private/c1.pdf', { ownerMemberId: 'm', generation: 'g', now: NOW });
      const rec2 = createMemberShareLink(ledger, 'members/h1/private/c2.pdf', { ownerMemberId: 'm', generation: 'g', now: NOW });
      expect(() => resolveMemberShareLink(ledger, rec1.token, { now: NOW + 1 })).not.toThrow();
      expect(() => resolveMemberShareLink(ledger, rec2.token, { now: NOW + 1 })).not.toThrow();
      revokeMemberShareLink(ledger, rec1.token, { ownerMemberId: 'm', now: NOW + 2 }); // 폐기도 update 경유 — rec2 에 영향 없음 · JUD ②
      expect(() => resolveMemberShareLink(ledger, rec2.token, { now: NOW + 3 })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── terra 재리뷰 r2(2026-11-22) ②보강·③ — 저장·읽기 계약 모순 제거 ────────────────

  test('② records 가 배열([] 포함)인 원장은 파손 — 미존재가 아니다', () => {
    const dir = newDir();
    try {
      writeFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), '{"version":1,"records":[]}');
      expect(() => resolveMemberShareLink(fileLedger(dir), 'mfs1_x', { now: NOW })).toThrow(/corrupt/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('② 저장 레코드의 objectKey 는 정규(decoded) 형식 — 인코딩 잔존은 파손', () => {
    const dir = newDir();
    try {
      const ledger = fileLedger(dir);
      const rec = createMemberShareLink(ledger, 'members/h1/private/enc.pdf', {
        ownerMemberId: 'm', generation: 'g', now: NOW,
      });
      const state = JSON.parse(readFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), 'utf8'));
      const key = Object.keys(state.records)[0];
      state.records[key].objectKey = 'members/h1/private/a%2eb.pdf'; // 디코딩하면 유효하지만 비정규(인코딩 잔존)
      writeFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), JSON.stringify(state));
      expect(() => resolveMemberShareLink(fileLedger(dir), rec.token, { now: NOW + 1 })).toThrow(/corrupt/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('③ ttlMs: Infinity 발급은 거부 — 허용하면 readState 전수 검증과 모순해 원장 전체를 봉쇄한다', () => {
    const dir = newDir();
    try {
      expect(() => createMemberShareLink(fileLedger(dir), 'members/h1/private/inf.pdf', {
        ownerMemberId: 'm', generation: 'g', now: NOW, ttlMs: Number.POSITIVE_INFINITY,
      })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('③ 재발급 ttlMs: Infinity · 폐기 now 비유한수는 거부 — 원장 불변', () => {
    const dir = newDir();
    try {
      const ledger = fileLedger(dir);
      const rec = createMemberShareLink(ledger, 'members/h1/private/rt.pdf', {
        ownerMemberId: 'm', generation: 'g', now: NOW,
      });
      expect(() => reissueMemberShareLink(ledger, rec.token, { ownerMemberId: 'm', now: NOW + 1, ttlMs: Number.POSITIVE_INFINITY })).toThrow();
      expect(() => revokeMemberShareLink(ledger, rec.token, { ownerMemberId: 'm', now: Number.NaN })).toThrow();
      // 갱신 거부는 원장을 바꾸지 않는다 — 원 토큰이 그대로 유효(mutate throw → 저장 없음)
      const got = resolveMemberShareLink(ledger, rec.token, { now: NOW + 2 });
      expect(got.objectKey).toBe('members/h1/private/rt.pdf');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── JUD 보안 HOLD 수리(OP #128536 · 판정 jud-39544-ea7110a91a0e.json) — 이 절이 먼저 실패한다(RED) ──

  test('JUD ① 만료: 만료 토큰만으로 갱신 불가 — reissue 도 resolve 와 같은 만료 경계 검사', () => {
    const dir = newDir();
    try {
      const ledger = fileLedger(dir);
      const rec = createMemberShareLink(ledger, 'members/h1/private/exp.pdf', {
        ownerMemberId: 'mem-1', generation: 'g', now: NOW,
        ttlMs: 1_000, // 출처: #39544/jud-39544-ea7110a91a0e — 만료 재발급 경계 시험용 토큰 수명
      });
      // 만료 시각 경과 뒤 재발급은 거부 — 만료 토큰을 갱신해 되살릴 수 없다
      expect(() => reissueMemberShareLink(ledger, rec.token, { ownerMemberId: 'mem-1', now: NOW + 1_001 })).toThrow(/expired/);
      // 거부는 원장을 바꾸지 않는다 — 직전 시각 경계(now == expires)에서는 원 토큰이 그대로 유효
      const got = resolveMemberShareLink(ledger, rec.token, { now: NOW + 1_000 });
      expect(got.objectKey).toBe('members/h1/private/exp.pdf');
      // 경계에서 갱신은 허용(resolve 기준과 동일 — now > expires 일 때만 만료)
      const rec2 = reissueMemberShareLink(ledger, rec.token, { ownerMemberId: 'mem-1', now: NOW + 1_000 });
      expect(rec2.token).not.toBe(rec.token);
      expect(() => resolveMemberShareLink(ledger, rec.token, { now: NOW + 1_001 })).toThrow(); // 옛 토큰 즉시 무효
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('JUD ② 소유자: 재발급·폐기는 인증된 소유자 검증 — 타인·미지정 거부, 원장 불변', () => {
    const dir = newDir();
    try {
      const ledger = fileLedger(dir);
      const rec = createMemberShareLink(ledger, 'members/h1/private/own.pdf', {
        ownerMemberId: 'mem-1', generation: 'g', now: NOW,
      });
      type ReissueOpts = Parameters<typeof reissueMemberShareLink>[2];
      type RevokeOpts = Parameters<typeof revokeMemberShareLink>[2];
      // 타인(다른 인증 회원)·미지정(ownerMemberId 없음) 재발급·폐기는 모두 거부 — 토큰 소지만으로는 불가
      expect(() => reissueMemberShareLink(ledger, rec.token, { ownerMemberId: 'mem-2', now: NOW + 1 })).toThrow(/not owned/);
      expect(() => reissueMemberShareLink(ledger, rec.token, { now: NOW + 1 } as unknown as ReissueOpts)).toThrow();
      expect(() => revokeMemberShareLink(ledger, rec.token, { ownerMemberId: 'mem-2', now: NOW + 2 })).toThrow(/not owned/);
      expect(() => revokeMemberShareLink(ledger, rec.token, { now: NOW + 2 } as unknown as RevokeOpts)).toThrow();
      // 거부 뒤에도 원 토큰은 그대로 유효 — 원장 불변(mutate throw → 저장 없음)
      const got = resolveMemberShareLink(ledger, rec.token, { now: NOW + 3 });
      expect(got.objectKey).toBe('members/h1/private/own.pdf');
      // 소유자의 재발급·폐기는 성공
      const rec2 = reissueMemberShareLink(ledger, rec.token, { ownerMemberId: 'mem-1', now: NOW + 4 });
      expect(() => resolveMemberShareLink(ledger, rec.token, { now: NOW + 5 })).toThrow(); // 옛 토큰 무효
      expect(resolveMemberShareLink(ledger, rec2.token, { now: NOW + 5 }).objectKey).toBe('members/h1/private/own.pdf');
      revokeMemberShareLink(ledger, rec2.token, { ownerMemberId: 'mem-1', now: NOW + 6 });
      expect(() => resolveMemberShareLink(ledger, rec2.token, { now: NOW + 7 })).toThrow(); // 폐기 후 무효
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('JUD ③ 결속: 객체 소유권 결속 — 발급 때의 소유자·객체·generation 이 저장·검증·재발급 전체에 유지', () => {
    const dir = newDir();
    try {
      const ledger = fileLedger(dir);
      const rec = createMemberShareLink(ledger, 'members/h9/private/bind.pdf', {
        ownerMemberId: 'mem-9', generation: 'gen-bind', now: NOW,
      });
      expect(rec.ownerMemberId).toBe('mem-9');
      const got = resolveMemberShareLink(ledger, rec.token, { now: NOW + 1 });
      expect(got.ownerMemberId).toBe('mem-9');
      expect(got.objectKey).toBe('members/h9/private/bind.pdf');
      expect(got.generation).toBe('gen-bind');
      // 원장 저장 레코드도 같은 결속(평문 토큰 없이 해시만 저장)
      const state = JSON.parse(readFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), 'utf8'));
      const stored = Object.values(state.records)[0] as { ownerMemberId: string; objectKey: string; generation: string };
      expect(stored.ownerMemberId).toBe('mem-9');
      expect(stored.objectKey).toBe('members/h9/private/bind.pdf');
      expect(stored.generation).toBe('gen-bind');
      // 재발급 토큰도 같은 소유자·객체·generation 결속 — 타인은 여전히 폐기 불가
      const rec2 = reissueMemberShareLink(ledger, rec.token, { ownerMemberId: 'mem-9', now: NOW + 2 });
      expect(rec2.ownerMemberId).toBe('mem-9');
      expect(rec2.objectKey).toBe('members/h9/private/bind.pdf');
      expect(rec2.generation).toBe('gen-bind');
      expect(() => revokeMemberShareLink(ledger, rec2.token, { ownerMemberId: 'mem-2', now: NOW + 3 })).toThrow(/not owned/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
