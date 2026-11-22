// ── 팩 조항 id 결정 원장 (knowhow clauses · 2026-11-21) ──────────────────────────
//
// 칸: MEM-LESSON-TO-KNOWHOW-PROMOTION(ROSTER-0332). 같은 꼴 실패 3회로 승화된 교훈을
// 노하우 팩 조항으로 결정(id 부여)하는 원장. 조항 id 는 내용(lessonId·owner·incident·
// cause·remedy)의 해시로 **결정론적**이다 — 같은 교훈을 두 번 승화해도 같은 id 가 나와
// 중복이 생기지 않는다(appendClause 중복 판정 · 쓰기 생략). 파일: <stateDir>/knowhow/clauses.json.
// OP #117563 ①②③ + JUD HOLD 1121 로 강인성 확보. 잠금(OP #118502 · 6라운드): 획득 = 잠금 «디렉터리»
// 생성(mkdir 은 원자 · 이미 있으면 EEXIST 로 실패) → 그 안에 owner.json(pid·시각) 기록. 해제 =
// owner.json 의 pid 가 자기 pid 인지 확인한 뒤에만 rmdir. 남의 잠금 중 **죽은 소유자**(kill(pid,0)
// ESRCH 확정 + 나이 하한 경과)의 잔존 잠금은 기본 동작으로 자동 회수한다 — 옵션·깃발 없음(OP #131901).
// 빈 클레임(owner.json 부재·파손)과 산 소유자는 절대 회수하지 않는다 — rename·덮어쓰기 0(JUD HOLD
// #118510: 회수 판정과 rename 사이 교체 경합 제거)으로 활성 쓰기 상호배제가 구조적으로 보장된다.
// 회수는 마커 원자 교체로 회수자를 한 명으로 직렬화한다(FU-39383-LOCK-CRASH-RECOVERY). 회수 불가
// 잔존 잠금은 대기 상한 뒤 «잠금 남음(pid·시각) — 수동 회수 필요» 오류로 멈춘다.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface KnowhowClause {
  /** 결정된 조항 id — KN-<sha256(내용) 앞 12>. */
  id: string;
  /** 승화된 교훈(lesson-ledger) 행 id. */
  lessonId: string;
  owner: string;
  incident: string;
  cause: string;
  remedy: string;
  /** 승화 시점 관측 횟수(같은 꼴 실패 반복). */
  occurrences: number;
  status: 'promoted';
  createdAt: string;
}

export interface KnowhowClausesFile { schema: 1; clauses: KnowhowClause[] }

export interface ClauseAppendInput {
  lessonId: string; owner: string; incident: string; cause: string; remedy: string; occurrences: number;
}

/** 원장 파일 경로 — <stateDir>/knowhow/clauses.json. */
export function clausesPath(stateDir: string): string {
  return join(stateDir, 'knowhow', 'clauses.json');
}

/** 조항 id 결정 — 내용 해시(결정론적 · 같은 교훈 ⇒ 같은 id ⇒ 중복 0). */
export function determineClauseId(input: Omit<ClauseAppendInput, 'occurrences'>): string {
  const material = [input.lessonId, input.owner, input.incident, input.cause, input.remedy]
    .map((part) => String(part ?? '').trim()).join('|');
  return `KN-${createHash('sha256').update(material).digest('hex').slice(0, 12)}`;
}

function loadFile(path: string): KnowhowClausesFile {
  // 판독 자체의 ENOENT 만 빈 원장(신규 시작)으로 삼는다 — existsSync 판정은 검사·판독 사이
  // 창(TOCTAU)이 있어 ① 참→소실 경로를 그대로 크래시시키고 ② 거짓→타 프로세스가 신규 생성한
  // 원장을 통째로 덮어쓴다(OP #117563 ①). 그 외 판독·파싱·스키마 오류는 전파(던짐)한다 —
  // 삼켜 빈 원장으로 취급하면 appendClause 가 그 경로를 덮어써 기존 조항이 유실된다
  // (JUD-B HOLD 1121 · 보존 우선 · 오류≠부재 분리).
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { schema: 1, clauses: [] };
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || (parsed as KnowhowClausesFile).schema !== 1
    || !Array.isArray((parsed as KnowhowClausesFile).clauses)) {
    throw new Error(`knowhow clauses 원장 파손(schema/clauses 불일치): ${path}`);
  }
  return parsed as KnowhowClausesFile;
}

export function readClauses(stateDir: string): KnowhowClause[] {
  return loadFile(clausesPath(stateDir)).clauses;
}

export function clauseCount(stateDir: string): number {
  return readClauses(stateDir).length;
}

export interface ClauseAppendResult { path: string; clause: KnowhowClause; duplicate: boolean }

/** 원장 읽기-수정-쓰기 직렬화 잠금 — 프로세스 간에도 한 줄로 세운다(OP #117563 ③ · 동시 쓰기 HOLD). */
const LOCK_TIMEOUT_MS_DEFAULT = 10_000;
const LOCK_RETRY_MS = 25;

/** 잠금 대기 상한 — 환경변수로만 단축(시험 전용), 제품 기본은 그대로. */
function lockTimeoutMs(): number {
  const raw = Number(process.env.KNOWHOW_CLAUSES_LOCK_TIMEOUT_MS);
  return raw > 0 ? Math.floor(raw) : LOCK_TIMEOUT_MS_DEFAULT;
}

// ── FU-39383-LOCK-CRASH-RECOVERY — 잔존 잠금 자동 회수(기본 동작 · OP #131901) ──────────
// 소유 프로세스 kill -9 로 잔존한 잠금은 이전엔 appendClause 전부 대기 상한 뒤 clausesLockHeldError
// 로 실패했다(회복 경로 0 · 수동 rm 필요). 이제 아래 판정을 통과한 잔존 잠금을 기본 동작으로 회수한다.

/** 회수 나이 하한 — 이보다 젊은 잔존 잠금은 소유자가 owner.json 을 기록하는 중일 수 있어 그대로 둔다.
 *  출처: FU-39383-LOCK-CRASH-RECOVERY 조사 원문 §4(30s) */
const RECLAIM_MIN_AGE_MS = 30_000;

/** 잔존 잠금 자동 회수 시도(기본 동작) — owner.json 서명 + 나이 하한 경과 + 소유 pid ESRCH(확실 부재)일 때만.
 *  회수 직렬점 = owner.json 을 잡아내 옮기는 원자 교체(rename 1회): 두 회수자가 동시에 시도하면 한 명만
 *  성공(나머지 ENOENT → rmSync 금지). 잡아낸 바이트가 판정한 죽은 소유자 그대로인지 재확인한다 — 판정↔교체
 *  사이에 다른 프로세스가 회수 뒤 재취득했으면 산 잠금이므로 되돌리고 절대 지우지 않는다(JUD #118510 경합 폐쇄).
 *  성공(회수자 한 명) = 회수 마커를 남긴 뒤 rmSync → true(호출처는 mkdir 재경쟁으로 재취득). 모든 실패는
 *  «그대로 둔다»로 귀결(회수 0) — 중간 실패로 마커만 남으면 빈 클레임 판정이 다음 회수를 막는다(수동 회수 귀결). */
function tryAutoreclaimStaleLock(lockDir: string): boolean {
  const owner = readLockOwner(lockDir);
  if (owner === null) return false; // 빈 클레임(owner.json 부재·파손) — 기록 중일 수 있다 → 회수 금지
  if (!(Date.now() - owner.createdAtMs > RECLAIM_MIN_AGE_MS)) return false; // 나이 하한 이내 — 산 것으로 친다(유예)
  try {
    process.kill(owner.pid, 0); // 시그널 0 = 존재 확인 전용(전송 없음)
    return false; // 살아 있다 — 산 소유자의 잠금은 나이·서명 무관 절대 회수 금지(바이트 무변경)
  } catch (error) {
    if ((error as { code?: string }).code !== 'ESRCH') return false; // EPERM 등 = 존재하지만 권한 없음 → 산 것
  }
  const ownerJson = ownerPath(lockDir);
  const captured = `${ownerJson}.reclaim-${process.pid}-${Date.now().toString(36)}`;
  try {
    renameSync(ownerJson, captured); // 원자 교체 ① — 소유 서명을 통째로 잡아낸다(직렬점)
  } catch {
    return false; // 다른 회수자가 먼저 잡아냈다 — 나는 rmSync 금지, 재시도 루프로
  }
  let stale = false;
  try {
    const seen = JSON.parse(readFileSync(captured, 'utf8')) as { pid?: unknown; createdAtMs?: unknown };
    stale = Number(seen.pid) === owner.pid && Number(seen.createdAtMs) === owner.createdAtMs; // 판정한 죽은 소유자 그대로인가
  } catch { stale = false; }
  if (!stale) {
    // 판정 뒤 주인이 바뀌었다(다른 프로세스가 회수 후 재취득) — 산 잠금이다. 되돌리고 절대 지우지 않는다.
    try { renameSync(captured, ownerJson); } catch { /* 되돌리기 실패 시 잔여 captured 파일은 수동 회수 대상 */ }
    return false;
  }
  const markerTmp = `${ownerJson}.marker-${process.pid}-${Date.now().toString(36)}`;
  try {
    // 원자 교체 ② — 회수 마커(누가·무엇을 회수했는지 감사 흔적)를 owner.json 자리에 기록한 뒤에만
    writeFileSync(markerTmp, `${JSON.stringify({ reclaimPid: process.pid, reclaimedPid: owner.pid, createdAtMs: Date.now() })}\n`);
    renameSync(markerTmp, ownerJson);
    rmSync(lockDir, { recursive: true, force: true }); // 마커 교체에 성공한 회수자(한 명)만 잠금 디렉터리를 지운다
    return true;
  } catch {
    return false; // 마커·rmSync 중간 실패 — 마커(빈 클레임)가 남는다 → 다음 회수는 금지(수동 회수 귀결)
  }
}

/** 잠금 = 원자 디렉터리. 획득 = mkdir(이미 있으면 EEXIST) → 그 안에 owner.json(pid·시각). */
function lockDirPath(path: string): string {
  return `${path}.lockdir`;
}
function ownerPath(lockDir: string): string {
  return join(lockDir, 'owner.json');
}
interface LockOwner { pid: number; createdAtMs: number }

/** owner.json 판독 — 부재·파손은 null(«빈 클레임» → 디렉터리 나이로 유예 판정). */
function readLockOwner(lockDir: string): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ownerPath(lockDir), 'utf8'));
    const pid = Number((parsed as { pid?: unknown }).pid);
    const createdAtMs = Number((parsed as { createdAtMs?: unknown }).createdAtMs);
    if (!Number.isFinite(pid) || !(pid > 0) || !Number.isFinite(createdAtMs)) return null;
    return { pid, createdAtMs };
  } catch { return null; }
}

/** 해제 — 잠금은 자기 것일 때만 지운다: owner.json 의 pid 가 자기 pid 인지 확인한 뒤 rmdir.
 *  서명이 아니면(빈 클레임·남의 pid) 손대지 않고 남긴다 — 산·빈 잔존은 수동 회수 대상(죽은 잔존은 기본 회수 · OP #131901). */
function releaseClausesLock(lockDir: string): void {
  const owner = readLockOwner(lockDir);
  if (owner === null || owner.pid !== process.pid) return;
  rmSync(lockDir, { recursive: true, force: true });
}

/** 남은 잠금 오류 — pid·시각(읽을 수 있으면)과 수동 회수 대상 경로를 안내한다(기본 회수 시도 뒤에 남은 것). */
function clausesLockHeldError(lockDir: string): Error {
  const owner = readLockOwner(lockDir);
  const pid = owner === null ? 'unknown' : String(owner.pid);
  const at = owner === null ? 'unknown' : new Date(owner.createdAtMs).toISOString();
  return new Error(`기억 조항 원장 잠금 남음(pid=${pid}, 시각=${at}) — 수동 회수 필요: ${lockDir}`);
}

function withClausesLock<T>(path: string, work: () => T): T {
  mkdirSync(dirname(path), { recursive: true }); // 잠금 디렉터리를 놓을 디렉터리 보장
  const lockDir = lockDirPath(path);
  const startedAt = Date.now();
  for (;;) {
    // ① 획득 — mkdir 은 원자: 성공한 쪽이 잠금을 얻는다(EEXIST = 남이 잠금). 그 안에 owner.json(pid·시각).
    let acquired = false;
    try { mkdirSync(lockDir); acquired = true; }
    catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error; // 퍼미션 등 다른 실패는 전파
    }
    if (acquired) {
      let wrote = false;
      try {
        writeFileSync(ownerPath(lockDir), `${JSON.stringify({ pid: process.pid, createdAtMs: Date.now() })}\n`);
        wrote = true;
      } finally {
        // owner.json 기록 실패 시에도 잠금은 반드시 해제 — 빈 잠금 유예에 기대지 않는다.
        if (!wrote) rmSync(lockDir, { recursive: true, force: true });
      }
      try { return work(); }
      finally { releaseClausesLock(lockDir); } // ② 해제 — 자기 owner 확인 뒤 rmdir
    }
    // ③ 남의 잠금 — 죽은 소유자(ESRCH 확정 + 나이 하한 경과)의 잔존 잠금만 기본 동작으로 회수 시도한다
    //    (FU-39383-LOCK-CRASH-RECOVERY · OP #131901 기본 동작화) — 성공 시 루프 선두로 복귀해 mkdir 재경쟁으로
    //    재취득, 실패(산 소유자·빈 클레임·나이 하한 이내)는 대기 상한 뒤 수동 회수 오류로 멈춘다.
    if (tryAutoreclaimStaleLock(lockDir)) continue;
    if (Date.now() - startedAt > lockTimeoutMs()) throw clausesLockHeldError(lockDir);
    const until = Date.now() + LOCK_RETRY_MS;
    while (Date.now() < until) { /* 동기 재시도 간격 */ }
  }
}

/** 원자 쓰기 — tmp 에 온전히 기록한 뒤 rename 교체. 중간 실패 시 기존 원장 바이트 보존(OP #117563 ②). */
function writeFileAtomically(path: string, contents: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, contents);
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 잔여 tmp 정리 실패는 본 오류를 가리지 않는다 */ }
    throw error;
  }
}

/** 조항 1건 추가 — 같은 id 가 이미 있으면 **쓰지 않고** 기존 조항을 돌려준다(중복 0). */
export function appendClause(
  stateDir: string,
  input: ClauseAppendInput,
  now: () => Date = () => new Date(),
): ClauseAppendResult {
  const path = clausesPath(stateDir);
  mkdirSync(dirname(path), { recursive: true }); // 잠금 파일부터 놓을 수 있게
  return withClausesLock(path, () => {
    const file = loadFile(path);
    const id = determineClauseId(input);
    const existing = file.clauses.find((clause) => clause.id === id);
    if (existing) return { path, clause: existing, duplicate: true };
    const clause: KnowhowClause = {
      id, lessonId: input.lessonId, owner: input.owner, incident: input.incident,
      cause: input.cause, remedy: input.remedy, occurrences: input.occurrences,
      status: 'promoted', createdAt: now().toISOString(),
    };
    const next: KnowhowClausesFile = { schema: 1, clauses: [...file.clauses, clause] };
    writeFileAtomically(path, `${JSON.stringify(next, null, 2)}\n`);
    return { path, clause, duplicate: false };
  });
}