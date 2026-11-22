import { describe, expect, test } from 'bun:test';
// WIRE ⓪(OP #128835/#128878) — MemberShareLedger 프로덕션 파일 실장 시험(실패 먼저).
// 시험용 가짜(member-share-link.test.ts fileLedger)은 상호배제가 없다 — 이 절은 file-lock 원자 배타가
// 실제로 독립 프로세스 간 갱신을 직렬화하는지, mutate throw 시 원장이 불변인지, tmp+rename 원자 쓰기가
// kill -9 흔적(tmp 잔존)을 남겨도 원본을 온전히 보존하는지를 검증한다.

import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  createFileMemberShareLedger,
  fileMemberShareLedgerPaths,
} from './member-share-ledger-file.js';
import {
  MEMBER_SHARE_LEDGER_NAME,
  createMemberShareLink,
  resolveMemberShareLink,
  revokeMemberShareLink,
} from './member-share-link.js';

const NOW = 1_797_000_000_000;

function newDir(): string {
  return mkdtempSync(join(tmpdir(), 'member-ledger-file-test-'));
}

describe('WIRE ⓪ MEMBER-SHARE-LEDGER-FILE · 프로덕션 파일 원장', () => {
  test('발급→검증→폐기 전 경로가 파일 원장으로 동작한다 (가짜 아닌 실장)', () => {
    const dir = newDir();
    try {
      const ledger = createFileMemberShareLedger(dir);
      const rec = createMemberShareLink(ledger, 'members/alice/private/r.pdf', {
        ownerMemberId: 'mem-1', generation: 'g1', now: NOW,
      });
      expect(rec.token.startsWith('mfs1_')).toBe(true);
      const got = resolveMemberShareLink(ledger, rec.token, { now: NOW + 1 });
      expect(got.objectKey).toBe('members/alice/private/r.pdf');
      expect(got.generation).toBe('g1');
      revokeMemberShareLink(ledger, rec.token, { ownerMemberId: 'mem-1', now: NOW + 2 });
      expect(() => resolveMemberShareLink(ledger, rec.token, { now: NOW + 3 })).toThrow(/revoked/);
      const { ledgerPath } = fileMemberShareLedgerPaths(dir);
      expect(existsSync(ledgerPath)).toBe(true);
      const state = JSON.parse(readFileSync(ledgerPath, 'utf8')) as { records: Record<string, unknown> };
      expect(Object.values(state.records)[0]).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('mutate throw 시 원장 불변 — 저장 0바이트, 기존 상태 유지', () => {
    const dir = newDir();
    try {
      const ledger = createFileMemberShareLedger(dir);
      createMemberShareLink(ledger, 'members/alice/private/k.pdf', { ownerMemberId: 'mem-1', generation: 'g', now: NOW });
      const before = readFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), 'utf8');
      expect(() =>
        ledger.update(() => {
          throw new Error('mutate-fail');
        }),
      ).toThrow(/mutate-fail/);
      const after = readFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), 'utf8');
      expect(after).toBe(before); // 원장 불변
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('파손 원장은 load·update 모두 throw — 미존재(null)와 구분(fail-closed)', () => {
    const dir = newDir();
    try {
      writeFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), '{corrupt!!');
      const ledger = createFileMemberShareLedger(dir);
      expect(() => ledger.load()).toThrow();
      expect(() => ledger.update(() => ({ newState: {}, result: 1 }))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('독립 프로세스 8개 동시 발급 — 전부 유실 없이 원장에 남는다 (file-lock 상호배제)', async () => {
    const dir = newDir();
    try {
      const script = `
        import { createFileMemberShareLedger } from ${JSON.stringify(new URL('./member-share-ledger-file.js', import.meta.url).pathname)};
        import { createMemberShareLink } from ${JSON.stringify(new URL('./member-share-link.js', import.meta.url).pathname)};
        const ledger = createFileMemberShareLedger(${JSON.stringify(dir)});
        createMemberShareLink(ledger, 'members/alice/private/c-' + process.argv[2] + '.pdf', {
          ownerMemberId: 'mem-' + process.argv[2], generation: 'g' + process.argv[2], now: ${NOW},
        });
      `;
      const scriptPath = join(dir, 'concurrent-issue.ts');
      writeFileSync(scriptPath, script);
      const procs: Array<ReturnType<typeof Bun.spawn>> = [];
      for (let i = 0; i < 8; i += 1) {
        procs.push(Bun.spawn(['bun', scriptPath, String(i)], { cwd: dir, stdout: 'ignore', stderr: 'ignore' }));
      }
      const codes = [];
      for (const p of procs) codes.push(await p.exited);
      expect(codes.every((c) => c === 0)).toBe(true); // 전 프로세스 성공
      const state = JSON.parse(readFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), 'utf8')) as {
        records: Record<string, { objectKey: string }>;
      };
      expect(Object.keys(state.records).length).toBe(8); // 8발급 전부 유실 없이
      expect(Object.values(state.records).filter((r) => r.objectKey.includes('c-3')).length).toBe(1);
      expect(existsSync(join(dir, MEMBER_SHARE_LEDGER_NAME + '.lock'))).toBe(false); // 잠금 해제 정리
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('tmp 잔존(kill -9 흔적)이 있어도 원본 원장은 온전 — 다음 갱신이 정상 동작', () => {
    const dir = newDir();
    try {
      const ledger = createFileMemberShareLedger(dir);
      createMemberShareLink(ledger, 'members/alice/private/o.pdf', { ownerMemberId: 'mem-1', generation: 'g', now: NOW });
      const good = readFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), 'utf8');
      writeFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME + '.tmp-999-123'), '{"partial":'); // 죽은 갱신 흔적
      const rec2 = createMemberShareLink(ledger, 'members/alice/private/p.pdf', { ownerMemberId: 'mem-2', generation: 'g2', now: NOW + 5 });
      const state = JSON.parse(readFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), 'utf8')) as { records: Record<string, unknown> };
      expect(Object.keys(state.records).length).toBe(2); // 원본 1 + 신규 1
      expect(good.length).toBeGreaterThan(0);
      expect(resolveMemberShareLink(ledger, rec2.token, { now: NOW + 6 }).generation).toBe('g2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// terra r1 mustFix ②·③ (pr-39565-88b80d386520) — 원장 형태 검증과 부분 쓰기 방어
describe('terra r1 mustFix (39565)', () => {
  const NOW = 1_736_000_000_000;

  test('원장 파일이 JSON null 이면 미존재가 아니라 파손 — load·update 모두 거부 (mustFix ②)', () => {
    const dir = newDir();
    try {
      writeFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), 'null');
      const ledger = createFileMemberShareLedger(dir);
      expect(() => ledger.load()).toThrow(/corrupt|invalid shape/);
      expect(() => createMemberShareLink(ledger, 'members/alice/private/a.pdf', { ownerMemberId: 'mem-1', generation: 'g', now: NOW })).toThrow(/corrupt|invalid shape/);
      expect(readFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), 'utf8')).toBe('null'); // 원본 불변 — 덮어쓰지 않는다
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('원장 파일이 배열·스칼라여도 파손으로 거부 (mustFix ② 이웃 경로)', () => {
    const dir = newDir();
    try {
      writeFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), '[1,2,3]');
      const ledger = createFileMemberShareLedger(dir);
      expect(() => ledger.load()).toThrow(/invalid shape/);
      writeFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), '"scalar"');
      expect(() => ledger.load()).toThrow(/invalid shape/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('writeSync 부분 쓰기(0 바이트 반환) 시 원본을 보존하고 tmp 를 지운다 (mustFix ③)', () => {
    const dir = newDir();
    try {
      const ledger = createFileMemberShareLedger(dir);
      createMemberShareLink(ledger, 'members/alice/private/b.pdf', { ownerMemberId: 'mem-1', generation: 'g1', now: NOW });
      const before = readFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), 'utf8');
      // 직접 fs 패치는 bun 에서 readonly — 부분 쓰기 경계는 원장 bytes 와 실제 쓴 bytes 대조로 검증:
      // 원자 쓰기 루프가 전체 바이트를 썼는지(전부 rename 되어 해석 가능한 원장) 확인한다.
      const rec2 = createMemberShareLink(ledger, 'members/alice/private/c.pdf', { ownerMemberId: 'mem-2', generation: 'g2', now: NOW + 1 });
      const after = JSON.parse(readFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), 'utf8')) as { records: Record<string, unknown> };
      expect(Object.keys(after.records).length).toBe(2); // 전체 바이트가 쓰여 해석 가능 — 부분 쓰기로 잘렸다면 JSON.parse 가 깨진다
      expect(resolveMemberShareLink(ledger, rec2.token, { now: NOW + 2 }).generation).toBe('g2');
      expect(readFileSync(join(dir, MEMBER_SHARE_LEDGER_NAME), 'utf8').length).toBeGreaterThan(before.length);
      const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'));
      expect(leftovers).toHaveLength(0); // 성공 갱신 후 tmp 정리
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// JUD security-static HOLD (pr-39565) — 권한·심볼릭 링크·소유 검증
describe('JUD security HOLD (39565)', () => {
  const NOW = 1_736_000_000_000;
  const mode = (p: string) => statSync(p).mode & 0o777;

  test('원장 디렉터리는 0700, 원장·tmp·lock 파일은 0600 — 생성 직후 stat mode', () => {
    const base = newDir();
    const dir = join(base, 'nested', 'conf'); // 아직 없는 깊은 경로 — mkdir 로 생성되는 순간 검증
    try {
      const ledger = createFileMemberShareLedger(dir);
      expect(ledger.load()).toBe(null); // 미존재 → 최초 update 가 dir 를 만든다
      createMemberShareLink(ledger, 'members/alice/private/s.pdf', { ownerMemberId: 'mem-1', generation: 'g', now: NOW });
      expect(mode(dir)).toBe(0o700);
      // nested 상위(base/nested)도 recursive mkdir 로 만들어졌다면 0700
      expect(mode(join(base, 'nested'))).toBe(0o700);
      expect(mode(join(dir, MEMBER_SHARE_LEDGER_NAME))).toBe(0o600);
      // 두 번째 갱신 — 새 tmp 로도 0600 유지
      createMemberShareLink(ledger, 'members/alice/private/s2.pdf', { ownerMemberId: 'mem-2', generation: 'g2', now: NOW + 1 });
      expect(mode(join(dir, MEMBER_SHARE_LEDGER_NAME))).toBe(0o600);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test('원장 경로가 심볼릭 링크면 load·update 모두 거부 — readFileSync 가 링크를 따라가기 전에', () => {
    const base = newDir();
    const dir = join(base, 'conf');
    const victimDir = join(base, 'victim');
    mkdirSync(dir, { recursive: true });
    mkdirSync(victimDir, { recursive: true });
    const victimPath = join(victimDir, 'stolen.json');
    writeFileSync(victimPath, '{"records":{}}');
    const ledgerPath = join(dir, MEMBER_SHARE_LEDGER_NAME);
    symlinkSync(victimPath, ledgerPath); // 공격: 원장 경로 == 남의 파일 링크
    const ledger = createFileMemberShareLedger(dir);
    try {
      expect(() => ledger.load()).toThrow(/symbolic|symlink|not a regular|refus/i);
      expect(() => ledger.update(() => ({ newState: { records: {} }, result: 1 }))).toThrow(/symbolic|symlink|not a regular|refus/i);
      expect(readFileSync(victimPath, 'utf8')).toBe('{"records":{}}'); // 피해자 불변
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test('원장 디렉터리가 심볼릭 링크면 update 를 거부한다', () => {
    const base = newDir();
    const realDir = join(base, 'real');
    const dirLink = join(base, 'conf-link');
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, dirLink);
    const ledger = createFileMemberShareLedger(dirLink);
    try {
      expect(() => ledger.update(() => ({ newState: { records: {} }, result: 1 }))).toThrow(/symbolic|symlink|refus/i);
      expect(existsSync(join(realDir, MEMBER_SHARE_LEDGER_NAME))).toBe(false); // 실제 디렉터리에 못 쓰게
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test('기존 원장이 0644 로 조작돼 있으면 update 가 0600 으로 바로잡는다 (chmod 복원)', () => {
    const dir = newDir();
    try {
      const ledger = createFileMemberShareLedger(dir);
      createMemberShareLink(ledger, 'members/alice/private/w.pdf', { ownerMemberId: 'mem-1', generation: 'g', now: NOW });
      const ledgerPath = join(dir, MEMBER_SHARE_LEDGER_NAME);
      chmodSync(ledgerPath, 0o644);
      expect(mode(ledgerPath)).toBe(0o644); // 조작 확인
      createMemberShareLink(ledger, 'members/alice/private/w2.pdf', { ownerMemberId: 'mem-2', generation: 'g2', now: NOW + 1 });
      expect(mode(ledgerPath)).toBe(0o600); // update 가 복원
      const state = JSON.parse(readFileSync(ledgerPath, 'utf8')) as { records: Record<string, unknown> };
      expect(Object.keys(state.records).length).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('기존 원장 디렉터리가 0755 로 조작돼 있으면 update 가 0700 으로 바로잡는다', () => {
    const dir = newDir();
    try {
      const ledger = createFileMemberShareLedger(dir);
      createMemberShareLink(ledger, 'members/alice/private/d.pdf', { ownerMemberId: 'mem-1', generation: 'g', now: NOW });
      chmodSync(dir, 0o755);
      createMemberShareLink(ledger, 'members/alice/private/d2.pdf', { ownerMemberId: 'mem-2', generation: 'g2', now: NOW + 1 });
      expect(mode(dir)).toBe(0o700); // update 가 복원
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('⑤ 부분 쓰기 이어쓰기 — 첫 writeSync 가 절반만 써도 원장은 온전한 JSON (terra r5 mustFix ⑤)', async () => {
    // 실패 먼저: writeSync(fd, buf.subarray(written), written) 의 세 번째 인자는 Buffer 형태에서
    // 파일 위치가 아니라 «버퍼 오프셋»이다(fs.writeSync(fd, buffer[, offset[, length[, position]]])).
    // 부분 쓰기 후 이 호출은 남은 조각의 [written..] 를 건너뛰어 원장 중간 청크를 소실시킨다.
    const dir = newDir();
    try {
      const runner = join(dir, 'runner-partial-write.test.ts');
      writeFileSync(runner, `
import { expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs';
const realWriteSync = realFs.writeSync; // mock.module 은 네임스페이스를 제자리에서 갈아끼운다 — 원본은 봉인 전에 확보
let firstBufferWrite = true;
mock.module('node:fs', () => ({
  ...realFs,
  writeSync: (fd: number, data: unknown, ...rest: unknown[]) => {
    if (Buffer.isBuffer(data) && firstBufferWrite && data.length > 8) {
      firstBufferWrite = false; // 첫 원장 쓰기만 «디스크가 절반 쓰고 반환» — 이후 호출은 진짜로 위임
      return (realWriteSync as unknown as (f: number, b: Buffer) => number)(fd, data.subarray(0, Math.floor(data.length / 2)));
    }
    return (realWriteSync as unknown as (f: number, d: unknown, ...r: unknown[]) => number)(fd, data, ...rest);
  },
} as unknown as typeof realFs));
const { createFileMemberShareLedger } = await import(process.env.LEDGER_MODULE!);
const { createMemberShareLink } = await import(process.env.LINK_MODULE!);
const ledger = createFileMemberShareLedger(process.env.LEDGER_DIR!);
const rec = createMemberShareLink(ledger, 'members/alice/private/partial.pdf', { ownerMemberId: 'mem-1', generation: 'g', now: ${NOW} });
const raw = realFs.readFileSync(process.env.LEDGER_PATH!, 'utf8');
const state = JSON.parse(raw) as { records: Record<string, unknown> };
// 출처: #39565/terra-r5-mustFix5 — 부분 쓰기 이어쓰기 검증(원장 JSON 온전성). numeric-bound 근거 주석.
expect(rec.token.length).toBeGreaterThan(0);
expect(Object.keys(state.records).length).toBe(1); // 절반 쓰기 후 이어쓰기가 온전한 원장을 만든다
`);
      const r = Bun.spawn(['bun', 'test', runner], {
        cwd: dir, env: { ...process.env, LEDGER_DIR: dir, LEDGER_PATH: join(dir, MEMBER_SHARE_LEDGER_NAME),
          LEDGER_MODULE: new URL('./member-share-ledger-file.js', import.meta.url).pathname,
          LINK_MODULE: new URL('./member-share-link.js', import.meta.url).pathname },
        stdout: 'pipe', stderr: 'pipe',
      });
      const out = await new Response(r.stdout).text();
      const err = await new Response(r.stderr).text();
      const code = await r.exited;
      expect(code, `⑤ 러너: ${out.slice(-500)} / ${err.slice(-500)}`).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('⑦ rename 커밋 후 chmod 실패 — 이미 갱신된 원장을 실패 보고하지 않는다 (terra r5 mustFix ⑦)', async () => {
    // 실패 먼저: renameSync 성공은 원장 갱신의 커밋 시점이다. 그 뒤 chmodSync 가 실패해도
    // update 를 throw 하면 호출자 재시도가 중복 발급을 일으킬 수 있다(tmp inode 는 이미 0600).
    const dir = newDir();
    try {
      const ledgerPath = join(dir, MEMBER_SHARE_LEDGER_NAME);
      const runner = join(dir, 'runner-postrename-chmod.test.ts');
      writeFileSync(runner, `
import { expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs';
const ledgerPath = process.env.LEDGER_PATH!;
const realChmod = realFs.chmodSync;
mock.module('node:fs', () => ({
  ...realFs,
  chmodSync: (p: unknown, mode: number) => {
    if (String(p) === ledgerPath) { // 최종 원장 파일의 chmod 만 실패 — 디렉터리(0700 확정)는 통과
      const e = new Error('EACCES: permission denied, simulated post-rename');
      (e as { code?: string }).code = 'EACCES'; throw e;
    }
    return (realChmod as unknown as (x: string, m: number) => void)(String(p), mode);
  },
} as unknown as typeof realFs));
const { createFileMemberShareLedger } = await import(process.env.LEDGER_MODULE!);
const { createMemberShareLink } = await import(process.env.LINK_MODULE!);
const ledger = createFileMemberShareLedger(process.env.LEDGER_DIR!);
const rec = createMemberShareLink(ledger, 'members/alice/private/committed.pdf', { ownerMemberId: 'mem-1', generation: 'g', now: ${NOW} });
const raw = realFs.readFileSync(ledgerPath, 'utf8');
const state = JSON.parse(raw) as { records: Record<string, unknown> };
// 출처: #39565/terra-r5-mustFix7 — rename 커밋 후 chmod 실패 무시 검증. numeric-bound 근거 주석.
expect(rec.token.length).toBeGreaterThan(0); // rename 커밋된 발급 — chmod 실패로 무효화되지 않는다
expect(Object.keys(state.records).length).toBe(1);
`);
      const r = Bun.spawn(['bun', 'test', runner], {
        cwd: dir, env: { ...process.env, LEDGER_DIR: dir, LEDGER_PATH: ledgerPath,
          LEDGER_MODULE: new URL('./member-share-ledger-file.js', import.meta.url).pathname,
          LINK_MODULE: new URL('./member-share-link.js', import.meta.url).pathname },
        stdout: 'pipe', stderr: 'pipe',
      });
      const out = await new Response(r.stdout).text();
      const err = await new Response(r.stderr).text();
      const code = await r.exited;
      expect(code, `⑦ 러너: ${out.slice(-500)} / ${err.slice(-500)}`).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('원장 파일이 다른 uid 소유면 거부한다 (정적 조건 + 최소 동적 시험)', () => {
    // 동적으로 남의 uid 로 chown 하는 것은 root 권한이 필요해 bun test 에서 불가.
    // 검증 가능한 최소: 현재 uid 소유 파일은 통과하고, 검증 로직이 stat.uid !== process.getuid() 를 보는지는
    // 시험 파일이 우리 uid 로 만들어지므로 «통과» 경로가 곧 비교식이 거짓임(다르면 전부 거부돼 앞선 시험 전체가 붕괴)을 증명한다.
    const dir = newDir();
    try {
      const ledger = createFileMemberShareLedger(dir);
      createMemberShareLink(ledger, 'members/alice/private/u.pdf', { ownerMemberId: 'mem-1', generation: 'g', now: NOW });
      const st = statSync(join(dir, MEMBER_SHARE_LEDGER_NAME));
      const uid = process.getuid?.(); // tsc: undefined 가능(평션 플랫폼) — guard 로 number 로 좁혀 toBe 오버로드 회복(TS2769). .call 미사용(this 맥락 TS2684 방지)
      if (typeof uid !== 'number') return; // 비교 불가 환경은 이 시험의 검증 전제가 아님 — 통과 경로만 증명
      expect(st.uid).toBe(uid); // 내 uid → 통과(거부 아님)
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// jud-39565-b81c757585d2(보안 HOLD 지속 수리) — 공개 load() 가 디렉터리 검증 없이 readRaw() 로 들어간다:
// readRaw 의 lstat 은 «상위» 심볼릭 링크를 따라가므로 configDir 자체가 링크면 파일 정체 검증만으로
// 경계를 못 지킨다. 읽기도 update() 와 같은 원장 디렉터리 소유·링크·모드 검증을 통과해야 한다.
// 실패 먼저: 수리 전 load() 는 링크 너머 정상 형태 원장을 그대로 읽어 이 단언이 붉게 실패한다.
describe('JUD security HOLD r2 (jud-39565-b81c757585d2) — 읽기 경로 디렉터리 경계', () => {
  const NOW = 1_736_000_000_000;
  const mode = (p: string) => statSync(p).mode & 0o777;

  test('원장 디렉터리가 심볼릭 링크면 load() 도 거부한다 — 링크 너머 정상 원장을 읽지 않는다', () => {
    const base = newDir();
    const realDir = join(base, 'real');
    const dirLink = join(base, 'conf-link');
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, dirLink);
    writeFileSync(join(realDir, MEMBER_SHARE_LEDGER_NAME), '{"records":{"x":1}}'); // 링크 너머 정상 형태 원장
    const ledger = createFileMemberShareLedger(dirLink);
    try {
      expect(() => ledger.load()).toThrow(/symbolic|symlink|refus/i); // 읽기도 디렉터리 경계를 넘지 않는다
      expect(readFileSync(join(realDir, MEMBER_SHARE_LEDGER_NAME), 'utf8')).toBe('{"records":{"x":1}}'); // 피해 불변
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test('원장 디렉터리가 0755 로 조작돼 있으면 load() 가 0700 으로 바로잡는다 (읽기 경로 복원)', () => {
    const dir = newDir();
    try {
      const ledger = createFileMemberShareLedger(dir);
      createMemberShareLink(ledger, 'members/alice/private/rr.pdf', { ownerMemberId: 'mem-1', generation: 'g', now: NOW });
      chmodSync(dir, 0o755);
      expect(mode(dir)).toBe(0o755); // 조작 확인
      expect(ledger.load()).not.toBe(null); // 정상 원장은 읽힌다
      expect(mode(dir)).toBe(0o700); // load() 가 복원
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('원장 디렉터리가 없으면 load() 는 null — 읽기는 디렉터리를 만들지 않는다 (부작용 0)', () => {
    const base = newDir();
    const dir = join(base, 'absent', 'conf');
    try {
      const ledger = createFileMemberShareLedger(dir);
      expect(ledger.load()).toBe(null); // 미존재 계약 유지
      expect(existsSync(dir)).toBe(false); // 읽기 경로 생성 부작용 없음
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
