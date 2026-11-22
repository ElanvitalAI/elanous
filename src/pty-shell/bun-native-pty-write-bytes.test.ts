// 회귀 경비: MinimalPty.write(Uint8Array)의 부분 쓰기 보장 (출처: terra r1 mustFix M2 —
// «terminal.write 반환값 무시로 백프레셔 시 바이트 유실 가능» · Bun terminal.write 계약 =
// writeTerminalFully가 이미 의존하는 «받아들인 바이트 수 반환 · 부분 쓰기 가능»).
// bunSpawnPty의 write 는 동기라 기존 writeTerminalFully(비동기)를 못 쓰고
// writeTerminalBytesFully 로 전체 쓰기를 보장한다. 이 시험은 그 헬퍼를 직접 밀어붙인다.
import { expect, test } from 'bun:test';
import { bunNativePtyAvailable, bunSpawnPty, isSilentPtyWriteNoop, makeSyncPtyWrite, PtyWriteIncompleteError, writeTerminalBytesFully } from './bun-native-pty.js';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'; // 출처: terra r5 ③④ 진입점 회귀 — 자식 도달 바이트 실측
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** 극단 백프레셔 PTY — write 호출마다 capacity 바이트만 받아들인다(1 = 매번 1바이트). */
function fakePty(capacity: number) {
  const written: number[] = [];
  let closed = false;
  return {
    written,
    get closed() { return closed; },
    close() { closed = true; },
    write(data: Uint8Array): number {
      const take = Math.min(capacity, data.length);
      for (let i = 0; i < take; i++) written.push(data[i]!);
      return take;
    },
  };
}

test('writeTerminalBytesFully: 1바이트씩만 받는 PTY에도 모든 바이트 도달', () => {
  const pty = fakePty(1);
  const bytes = Buffer.from('한글끝 burst ㅎㅏㄴ', 'utf8');
  writeTerminalBytesFully(pty, bytes); // 출처: terra M2 — 부분 쓰기 반환값을 offset 에 반영
  expect(Buffer.from(pty.written).toString('utf8')).toBe('한글끝 burst ㅎㅏㄴ');
});

test('writeTerminalBytesFully: 받은 바이트가 취합 원문과 바이트 단위 동일', () => {
  const pty = fakePty(3); // 분할 UTF-8 경계와 얽히지 않게 3바이트씩
  const bytes = Buffer.from([0xed, 0x95, 0x9c, 0xed, 0x95, 0x9f, 0xe3, 0x84, 0xb4]);
  writeTerminalBytesFully(pty, bytes);
  expect(pty.written).toEqual([...bytes]);
});

test('writeTerminalBytesFully: 비정상 반환값(음수)이면 throw — 조용한 유실 금지', () => {
  const bad = { closed: false, write(): number { return -1; } };
  expect(() => writeTerminalBytesFully(bad, new Uint8Array([1, 2, 3]))).toThrow('PTY write returned -1');
});

test('writeTerminalBytesFully: closed PTY면 throw — 죽은 채널에 쓴 척 금지', () => {
  const pty = fakePty(1);
  pty.close();
  expect(() => writeTerminalBytesFully(pty, new Uint8Array([1, 2, 3]))).toThrow('PTY write incomplete');
});

test('writeTerminalBytesFully: 0바이트 반환(백프레셔 정체)이면 즉시 throw — 동기 바쁜대기·이벤트 루프 점유 금지 (출처: terra r2 M4)', () => {
  const stalled = { closed: false, write(): number { return 0; } };
  const t0 = Date.now();  // 출처: terra r2 M4 — 즉사 확인용 측정 상한(바쁜대기 부재 증명)
  expect(() => writeTerminalBytesFully(stalled, new Uint8Array([1, 2, 3]))).toThrow('PTY write stalled');
  expect(Date.now() - t0).toBeLessThan(500);  // 출처: #39576 terra r2 M4 — 3초 바쁜대기 금지(즉시 throw)의 여유 상한
});

// terra r3 mustFix ④: 상한(dealine) 초과는 미완료 노출 — 무기한 점유 금지.
// 결정성: 상한을 시험 파라미터로 좁히고(100ms) 가짜 write 호출마다 벽시계를 30ms 소모시켜 확정적으로 초과시킨다.
test('writeTerminalBytesFully: 상한 초과하면 부분 진행 정보와 함께 미완료를 노출', () => {
  const slow = {
    closed: false,
    write(): number {
      const t0 = Date.now();
      while (Date.now() - t0 < 30) { /* 동기 소모 — 이벤트 루프 점유 모의(출처: terra r3 ④ 상황 재현) */ }
      return 1;
    },
  };
  const bytes = new Uint8Array(50); // 출처: 30ms×50호출=1.5s ≫ 상한 100ms — 상한 트리플 보장
  let caught: unknown;
  try { writeTerminalBytesFully(slow, bytes, 100); } catch (e) { caught = e; } // 출처: #39576 terra r3 mustFix ④ — 시험 전용 상한 축소(100ms): 가짜 30ms/호출 ×50 ≫ 상한 → 확정 초과
  expect(caught).toBeInstanceOf(PtyWriteIncompleteError);
  const err = caught as PtyWriteIncompleteError;
  expect(err.written).toBeGreaterThan(0); // 출처: #39576 terra r3 mustFix ④ — 상한(100ms) 초과 시점 이미 30ms/호출 진행(≈3바이트) — 부분 진행 보존 증명
  expect(err.written).toBeLessThan(50);   // 출처: #39576 terra r3 mustFix ④ — 전체(50) 도달 전 상한 초과 → 미완료 노출 증명
  expect(err.total).toBe(50);
});

// terra r3 mustFix ② ③: 부분 쓰기 후 닫히면 — 유실 바이트 수가 에러에 실려야 한다(삼킴 수리의 재료).
test('writeTerminalBytesFully: 부분 쓰기 후 닫히면 written/total이 에러에 실린다', () => {
  let closed = false;
  const fake = {
    get closed() { return closed; },
    write(d: Uint8Array): number { const n = Math.min(3, d.length); closed = true; return n; }, // 3바이트만 받고 닫힘
  };
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  let caught: unknown;
  try { writeTerminalBytesFully(fake, bytes); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(PtyWriteIncompleteError);
  expect((caught as PtyWriteIncompleteError).written).toBe(3);
  expect((caught as PtyWriteIncompleteError).total).toBe(9);
});

// terra r3 mustFix ③ — 정책 순수함수 단위 시험: 유실 삼킴 여부 전 분기 커버.
test('isSilentPtyWriteNoop: 열린 터미널 실패는 무조건 표면화, 폐쇄는 부분 유실(written>0)만 표면화', () => {
  const partial = new PtyWriteIncompleteError('x', 3, 9);
  const zero = new PtyWriteIncompleteError('x', 0, 9);
  const plain = new Error('boom');
  expect(isSilentPtyWriteNoop(false, partial)).toBe(false); // 출처: #39576 terra r3 ③ — 열림+부분 유실: 표면화
  expect(isSilentPtyWriteNoop(false, plain)).toBe(false);  // 출처: #39576 terra r3 ③ — 열림+일반 실패: 표면화
  expect(isSilentPtyWriteNoop(true, partial)).toBe(false); // 출처: #39576 terra r3 ② — 폐쇄+부분 유실(written>0): 표면화(조용히 아님)
  expect(isSilentPtyWriteNoop(true, zero)).toBe(true);      // 출처: node-pty 패리티 — 폐쇄+0바이트: 조용한 no-op
  expect(isSilentPtyWriteNoop(true, plain)).toBe(true);     // 출처: node-pty 패리티 — 폐쇄+기타 실패: 조용한 no-op
});

// terra r4 mustFix ③④ — 실제 bunSpawnPty.write 경로(makeSyncPtyWrite) 회귀: bunSpawnPty.write 는
// 이 팩토리 반환값 그대로다. 부분 유실(written>0)은 폐쇄돼도 표면화, 0바이트 폐쇄는 node-pty
// 패리티 조용한 no-op, 산(live) 터미널 실패는 무조건 표면화.
test('makeSyncPtyWrite(= bunSpawnPty.write 경로): 부분 유실 표면화 · 폐쇄 0바이트 조용한 no-op · 산 터미널 실패 표면화', () => {
  let calls = 0;
  const proc = {
    terminal: {
      get closed() { return calls > 1; }, // 출처: terra r4 ④ — 1차 3바이트 수용 뒤 예외와 함께 폐쇄로 전환
      write(_d: Uint8Array): number { calls++; if (calls === 1) return 3; throw new Error('boom'); },
    },
  };
  expect(() => makeSyncPtyWrite(proc)(new Uint8Array(9))).toThrow(PtyWriteIncompleteError); // 3바이트 유실 — 폐쇄돼도 표면화
  const dead = { terminal: { closed: true, write(): number { throw new Error('dead'); } } };
  expect(() => makeSyncPtyWrite(dead)('x')).not.toThrow(); // 출처: node-pty 패리티 — 죽은 터미널 0바이트: 조용한 no-op
  const alive = { terminal: { closed: false, write(): number { throw new Error('live boom'); } } };
  expect(() => makeSyncPtyWrite(alive)('x')).toThrow('live boom'); // 산 터미널 실패: 무조건 표면화
});

// terra r5 DELTA-FINDING ③④ (출처: pr-39576-6d5b485c9e57.json) — «실패·타임아웃 회귀에서
// bunSpawnPty.write 를 직접 호출하지 않는다»: 실 진입점(bunSpawnPty().write)을 통과하는 회귀를
// 추가한다. 문자열과 Uint8Array 양쪽 write 가 실 Bun native PTY 를 거쳐 자식 stdin 에
// 바이트 단위로 온전히 도달함을 검증한다(부분 유실 0).
test('bunSpawnPty.write 진입점: 문자열+Uint8Array 혼합 쓰기가 자식에 바이트 단위로 온전히 도달', async () => {
  const target = join(tmpdir(), `pty-entry-echo-${Date.now()}.bin`);
  const pty = bunSpawnPty(process.execPath, [join(import.meta.dir, '../cli/fixtures/stdin-dump.ts'), target], {});
  const expected = Buffer.concat([
    Buffer.from('ㅎㅏㄴ ', 'utf8'),      // 출처: #39555 종단 분할 바이트의 실측 시퀀스
    new Uint8Array([0xed, 0x95, 0x9c]), // 출처: #39576 — «한»(U+D55C) UTF-8 원문 바이트
    Buffer.from('\n', 'utf8'),
  ]);
  pty.write('ㅎㅏㄴ '); // 문자열 경로(진입점)
  pty.write(new Uint8Array([0xed, 0x95, 0x9c])); // Uint8Array 경로(진입점) — 3바이트 조각
  pty.write('\n'); // 덤프 flush 라인
  const deadline = Date.now() + 15_000; // 출처: #39576 실측 — 자식 flush 관측 여유
  while (!existsSync(target) || statSync(target).size < expected.length) {
    if (Date.now() > deadline) throw new Error(`진입점 바이트 도달 대기 초과: ${existsSync(target) ? statSync(target).size : '없음'}/${expected.length}바이트`);
    await new Promise((r) => setTimeout(r, 50)); // 출처: #39576 — 자식 쓰기 관측 폴링 주기
  }
  const got = readFileSync(target);
  expect(got.length).toBe(expected.length);
  expect(Buffer.compare(got, expected)).toBe(0); // 바이트 단위 충실 — 유실·붕괴 0
  pty.kill();
  rmSync(target, { force: true });
}, 30_000); // 출처: #37153 live e2e 상한

// terra r4 mustFix ④ — 부분 쓰기 뒤 일반 예외: 진행량(offset)을 보존해 전파한다.
// 폐쇄 플래그가 예외와 겹치는 상황(1차 write 3바이트 수용 → 2차 write 일반 예외)에서
// isSilentPtyWriteNoop 은 «폐쇄+일반예외»를 조용한 no-op 로 삼켜 유실을 숨긴다 —
// 이 시험은 PtyWriteIncompleteError(written=3) 로 진행량이 살아 전파됨을 요구한다.
test('writeTerminalBytesFully: 부분 쓰기 후 일반 예외 → 진행량이 보존된 PtyWriteIncompleteError', () => {
  let calls = 0; // 출처: terra r4 ④ — 1차 3바이트 수용 후 2차 일반 예외(폐쇄와 겹침) 상황 재현
  const flaky = {
    closed: false,
    write(_d: Uint8Array): number {
      calls++;
      if (calls === 1) return 3;
      throw new Error('boom');
    },
  };
  let caught: unknown;
  try { writeTerminalBytesFully(flaky, new Uint8Array(9)); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(PtyWriteIncompleteError);
  expect((caught as PtyWriteIncompleteError).written).toBe(3);
  expect((caught as PtyWriteIncompleteError).total).toBe(9);
});

// terra r3 mustFix ③ — 실측 고정: Bun terminal.write 는 자식이 읽지 않아도(/bin/sleep) 4MB 전량을
// 수용한다(유저랜드 버퍼링 — 2026-11-22 Bun 1.4.2 실측 152ms). 부분 반환 계약이 실제로 드러나는 날
// 이 시험이 빨강으로 알리고, 그때 표면화 경로(PtyWriteIncompleteError)가 실 write 경로를 지키는지
// 재점검하게 한다(유실 표면화 정책 자체는 위 순수함수 시험·헬퍼 시험이 결정적으로 커버).
test.skipIf(!bunNativePtyAvailable())('실 write 경로 실측 고정: 읽지 않는 자식에도 전량 수용 — 부분 반환 등장 시 RED', async () => {
  const pty = bunSpawnPty('/bin/sleep', ['30'], { cols: 40, rows: 10, name: 'xterm-256color' });
  const exited = new Promise<{ exitCode: number | null }>((resolve) => pty.onExit((e) => resolve(e)));
  const big = new Uint8Array(4 * 1024 * 1024).fill(0x61); // 출처: #39576 실측 — 커널 PTY 버퍼(≤1MB)를 압도하는 크기로 부분 반환 가능성 검출
  let caught: unknown;
  try { pty.write(big); } catch (e) { caught = e; }
  pty.kill();
  await exited;
  expect(caught).toBeUndefined(); // 출처: 2026-11-22 Bun 1.4.2 실측(152ms) — 전량 수용, 부분 반환·유실 없음
}, 15_000); // 출처: 실측 152ms — PTY 스폰·정리 포함 여유

// terra r3 mustFix ③ — 실제 bunSpawnPty.write 경로 회귀 2: 이미 종료된 PTY 쓰기는
// node-pty 패리티로 조용한 no-op(0바이트 유실이라 삼킴이 맞는 경우).
test.skipIf(!bunNativePtyAvailable())('실 write 경로: 종료된 PTY 쓰기는 조용한 no-op(node-pty 패리티)', async () => {
  const pty = bunSpawnPty('/bin/sh', ['-c', 'exit 0'], { cols: 40, rows: 10, name: 'xterm-256color' });
  const exited = new Promise<{ exitCode: number | null }>((resolve) => pty.onExit((e) => resolve(e)));
  await exited;
  await new Promise((r) => setTimeout(r, 100)); // 출처: terminal.closed 반영 여유 — onExit 직후 플래그 갱신 스케줄
  expect(() => pty.write('x')).not.toThrow();
  expect(() => pty.write(new Uint8Array([0x78]))).not.toThrow();
}, 10_000);
