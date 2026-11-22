// WIRE ⓪(OP #128835/#128878 · jud-39544-1868e6b6c4c1) — MemberShareLedger 의 프로덕션 파일 실장.
// 시험용 가짜(member-share-link.test.ts fileLedger)와 달리, 독립 프로세스의 동시 발급·폐기가
// 서로를 덮어쓰지 않게 한다:
//  - 상호배제: acquireLockSync — fs.openSync 'wx' 원자 배타 생성 + stale 회수 + inode 확인 해제.
//  - 원자 쓰기: tmp+rename — 갱신 중 kill -9 로 tmp 만 남으면 원본은 온전하다.
// 계약(member-share-link.ts MemberShareLedger):
//  - load(): 미존재 → null · 파손(해석 불가) → throw (fail-closed 구분).
//  - update(mutate): 임계역 안에서 load→mutate→save. mutate throw 시 원장 불변(아무 것도 안 씀).
// 보안(jud pr-39565 security-static HOLD): 디렉터리 0700·원장/tmp 0600 전용 권한, 심볼릭 링크·비정상
// 파일 거부, 소유(uid) 검증. readRaw 는 readFileSync 가 링크를 따라가기 «전에» lstat 으로 정체를 본다.
import {
  chmodSync,
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireLockSync } from './file-lock.js';
import { MEMBER_SHARE_LEDGER_NAME } from './member-share-link.js';

export interface FileLedgerOptions {
  /** 잠금 stale 판정 기준(ms). 기본 file-lock 기본값(30s). */
  staleMs?: number;
}

const DIR_MODE = 0o700; // 원장 디렉터리 — 소유자만 접근
const FILE_MODE = 0o600; // 원장·tmp — 소유자만 읽고 쓰는 비밀(share link token 원문 포함)

/** lstat(링크 추적 없음)으로 경로 정체를 검증 — 심볼릭 링크·디렉터리·기타 비정상 파일은 거부. */
function assertRegularFileOwned(path: string, what: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) {
    throw new Error(`member-share ledger ${what} is a symbolic link — refusing (security): ${path}`);
  }
  if (!st.isFile()) {
    throw new Error(`member-share ledger ${what} is not a regular file — refusing: ${path}`);
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`member-share ledger ${what} is owned by uid ${st.uid}, not ${process.getuid()} — refusing: ${path}`);
  }
}

/** 원장 디렉터리 보증 — 심볼릭 링크 거부 + 0700 강제(umask 와 무관하게 chmod 로 확정) + 소유 검증. */
function ensureLedgerDir(dir: string): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT') {
      // recursive 생성 — 부모도 0700. mkdir mode 는 umask 로 깎일 수 있어 chmod 로 확정한다.
      mkdirSync(dir, { recursive: true, mode: DIR_MODE });
      // 생성된 dir 자체가(또는 그 조상이) 링크일 수 있다 — 만들어진 뒤 lstat 로 정체 확인.
      const self = lstatSync(dir);
      if (self.isSymbolicLink()) {
        throw new Error(`member-share ledger dir is a symbolic link — refusing (security): ${dir}`);
      }
      if (!self.isDirectory()) {
        throw new Error(`member-share ledger path is not a directory — refusing: ${dir}`);
      }
      if (typeof process.getuid === 'function' && self.uid !== process.getuid()) {
        throw new Error(`member-share ledger dir owned by uid ${self.uid}, not ${process.getuid()} — refusing: ${dir}`);
      }
      chmodSync(dir, DIR_MODE);
      return;
    }
    throw e;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`member-share ledger dir is a symbolic link — refusing (security): ${dir}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`member-share ledger path is not a directory — refusing: ${dir}`);
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`member-share ledger dir owned by uid ${st.uid}, not ${process.getuid()} — refusing: ${dir}`);
  }
  if ((st.mode & 0o777) !== DIR_MODE) chmodSync(dir, DIR_MODE); // 조작(예: 0755) 복원
}

/** 읽기 경로의 원장 디렉터리 경계 (jud-39565-b81c757585d2) — 검증만 하고 생성하지 않는다.
 *  update() 의 ensureLedgerDir 와 같은 링크·디렉터리·소유 기준을 load() 에도 적용한다:
 *  readRaw 의 lstat 은 «상위» 심볼릭 링크를 따라가므로 configDir 자체가 링크면 파일 정체
 *  검증만으로 경계를 못 지킨다. 읽기는 원장 디렉터리를 만드는 부작용도 내지 않는다. */
function verifyLedgerDirReadOnly(dir: string): boolean {
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return false; // 디렉터리 없음 = 원장 없음(null) — 생성하지 않는다
    throw e;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`member-share ledger dir is a symbolic link — refusing (security): ${dir}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`member-share ledger path is not a directory — refusing: ${dir}`);
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`member-share ledger dir owned by uid ${st.uid}, not ${process.getuid()} — refusing: ${dir}`);
  }
  if ((st.mode & 0o777) !== DIR_MODE) {
    try { chmodSync(dir, DIR_MODE); } catch { /* 읽기 경로 복원 최선 — 링크·소유 검증은 이미 통과 */ }
  }
  return true;
}

function readRaw(path: string): Record<string, unknown> | null {
  let text: string;
  try {
    // ⭐ readFileSync 는 심볼릭 링크를 따라간다 — 읽기 «전에» lstat 으로 정체·소유를 검증하고,
    //   권한이 조작(0644 등)돼 있으면 0600 으로 바로잡는다(jud HOLD).
    assertRegularFileOwned(path, 'file');
    const st = lstatSync(path);
    if ((st.mode & 0o777) !== FILE_MODE) chmodSync(path, FILE_MODE);
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (e instanceof Error && /symbolic link|not a regular|owned by uid|not a directory/.test(e.message)) throw e;
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT') return null; // 미존재 = 신규 초기화 허용(계약)
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`member-share ledger corrupt (unparseable): ${path}`, { cause: e }); // 파손은 미존재와 구분(fail-closed)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // JSON 문법은 맞지만 원장 형태가 아니다(null·배열·스칼라) — 미존재로 오인해 덮어쓰지 않게 거부 (terra mustFix ②)
    throw new Error(`member-share ledger corrupt (invalid shape): ${path}`);
  }
  return parsed as Record<string, unknown>;
}

/** MemberShareLedger 프로덕션 파일 실장 — configDir/member-share-links.json 를 file-lock 원자 배타로 갱신한다. */
let tmpSeq = 0; // tmp 파일명 충돌 방지 카운터(프로세스 내 단조 증가)

export function createFileMemberShareLedger(configDir: string, opts: FileLedgerOptions = {}): import('./member-share-link.js').MemberShareLedger {
  const ledgerPath = join(configDir, MEMBER_SHARE_LEDGER_NAME);
  const lockPath = `${ledgerPath}.lock`;
  return {
    load(): Record<string, unknown> | null {
      // jud-39565-b81c757585d2: 공개 읽기도 원장 디렉터리 경계(링크·소유·모드)를 통과한다 —
      // 검증 실패는 그대로 전파(fail-closed), 디렉터리 미존재는 원장 미존재(null)로 읽기를 끝낸다.
      if (!verifyLedgerDirReadOnly(dirname(ledgerPath))) return null;
      return readRaw(ledgerPath);
    },
    update<T>(mutate: (state: Record<string, unknown> | null) => { newState: Record<string, unknown>; result: T }): T {
      ensureLedgerDir(dirname(ledgerPath)); // configDir 보장(첫 갱신) — 0700·링크 거부·소유 검증 (jud HOLD)
      const release = acquireLockSync(lockPath, { staleMs: opts.staleMs });
      try {
        const raw = readRaw(ledgerPath);
        const { newState, result } = mutate(raw); // throw → 저장 없이 전파(원장 불변)
        // 원자 쓰기: tmp+rename. kill -9 로 tmp 만 남으면 원본은 온전 — 다음 갱신이 덮어쓴다.
        // 충돌 방지: 같은 PID·밀리초 재시도에도 wx 가 안 부딪히게 counter 를 섞는다 (terra shouldFix ①).
        const tmpPath = `${ledgerPath}.tmp-${process.pid}-${Date.now()}-${++tmpSeq}`;
        const body = `${JSON.stringify(newState, null, 2)}\n`;
        const fd = openSync(tmpPath, 'wx', FILE_MODE);
        try {
          fchmodSync(fd, FILE_MODE); // umask 무관 확정 (jud HOLD: tmp 도 0600)
          // 부분 쓰기 방어 (terra r2 mustFix ④ · r5 ⑤ 정정): fs.writeSync(fd, buffer[, offset…]) 의
          // 세 번째 인자는 Buffer 형태에서 «버퍼 오프셋»이지 파일 위치가 아니다. 남은 조각만
          // subarray 로 넘기고 위치 인자는 주지 않는다 — 순차 writeSync 는 파일 위치를 자동 진행한다.
          const buf = Buffer.from(body, 'utf8');
          let written = 0;
          while (written < buf.length) {
            const n = writeSync(fd, buf.subarray(written));
            if (n <= 0) throw new Error(`ledger tmp write stalled at ${written}/${buf.length}`);
            written += n;
          }
        } catch (e) {
          try { closeSync(fd); } catch { /* 이미 닫힘 */ }
          try { unlinkSync(tmpPath); } catch { /* 정리 최선 */ }
          throw e; // 원본 원장은 rename 전이므로 온전
        }
        closeSync(fd);
        try {
          renameSync(tmpPath, ledgerPath);
        } catch (e) {
          try { unlinkSync(tmpPath); } catch { /* rename 실패 시 tmp 정리 최선 */ }
          throw e;
        }
        // rename 성공 = 갱신 커밋 (terra r5 mustFix ⑦). tmp 는 fchmodSync(fd, 0600) 로 이미 확정돼
        // rename 되었으므로 이 chmod 는 최선 복원(기존 조작 모드 승계 방어)일 뿐 — 실패해도 커밋을
        // 실패 보고하지 않는다. 실패 보고 시 호출자 재시도가 중복 발급을 일으킬 수 있다.
        try { chmodSync(ledgerPath, FILE_MODE); } catch { /* 커밋 후 복원 실패 — 다음 update 가 복원 */ }
        return result;
      } finally {
        release();
      }
    },
  };
}

/** 표면 점검용 — 원장 파일·잠금 파일 경로 산출(시험에서 배치 검증에 쓴다). */
export function fileMemberShareLedgerPaths(configDir: string): { ledgerPath: string; lockPath: string } {
  return { ledgerPath: join(configDir, MEMBER_SHARE_LEDGER_NAME), lockPath: `${join(configDir, MEMBER_SHARE_LEDGER_NAME)}.lock` };
}
