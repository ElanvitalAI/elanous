// 하니스 공간 쓰기 경계 활성화 (2026-07-25 · #4 self-implement 격리 누출 봉쇄)
//
// self-implement / dev-harness / solve-mission 자식은 격리 git worktree 안에서 부팅한다(cwd=worktree).
// 자식은 getHarnessSpace() 로 "나는 격리 공간의 elanous"임을 **자기인지**하는데(harness-space.ts SSOT), 그
// 자기인지 위에 **쓰기 힐링/자기보호**를 쌓는다: 쓰기 경계를 worktree 로 못박아 정본 트리(main 체크아웃)
// 절대경로 오염을 봉쇄한다.
//
// ── 근본 (내부 문서 §2) ──────────────────────────
//   grounding(mission-codebase-gate)이 정본 트리 **절대경로 팩트**를 주입 + 모델이 그 절대경로를 그대로
//   write 로 재사용 → apply.ts resolveInSession 이 절대경로를 무클램프 통과(상대경로만 worktree 앵커) →
//   격리 worktree 인데도 정본 트리를 오염. 가드 인프라(setSessionCwd{boundary}·isWriteAllowedInBoundary·
//   boundaryReject)는 완비됐으나 **프로덕션 활성화 호출이 0건**이었다. 이 파일이 그 "0" 을 메운다.
//
// ── 경계 결정: 명시 마커(1순위·결정론) → isWorktree 자동추론(폴백·안전) ───────────────
//   ⭐ 스포너(worktree 를 직접 만든 headless-elanous-driver/seams)가 ELANOUS_HARNESS_BOUNDARY 에 worktree 절대
//      경로를 실어 전파(§2a). 자식은 이 마커로 경계를 **결정론적으로** 활성 — cwd 자동추론의 모호성
//      (worktree vs 정본 vs shadow-standalone 은 git 시그니처 동일)을 제거. cwd 가 정본 루트/하위여도 경계는
//      마커(worktree)라 정본 write 가 거부된다(리뷰 must-fix).
//   ⭐ 마커가 없을 때만(레거시/미배선 진입) isWorktree **자동추론 폴백**: cwd 가 진짜 linked worktree 일
//      때만 경계를 건다(isWorktree=false = 정본 체크아웃/standalone shadow → 별개 정본 없음 → 미개입=무회귀).
//
// ── 전 harness kind 커버리지·호환성 (리뷰 should-fix) ──────────────────────────────
//   정책은 getHarnessSpace() 비-null 인 **모든** 하니스 kind(self-implement·dev-harness·solve-mission)에
//   적용된다 — 셋 다 격리 worktree 공간이라 정본 오염을 똑같이 막아야 하므로 의도된 확대다. 스포너 배선:
//     · self-implement : headless-elanous-driver(PTY)·seams(spawnSync 폴백) 둘 다 ELANOUS_HARNESS_BOUNDARY 심음(결정론).
//     · dev-harness    : self-implement 의 Execute seam 을 재사용 → 같은 마커 경로(무추가 배선).
//     · solve-mission  : 별도 executor 스폰이 마커를 안 심어도, cwd 가 진짜 linked worktree 면 **자동추론 폴백**이
//                        경계를 확립(마커 無 → isWorktree 감지). 정본/standalone 부팅이면 미개입(무회귀).
//   무회귀 불변식: 비-하니스 프로세스(운영 데몬·CLI)는 getHarnessSpace()=null → 전 함수 즉시 no-op.
//
// ── 관측·자기인지·힐링 (제1원칙) ──────────────────────────────────────────────────
//   관측 : debug.log('harness.boundary', 'activate'|'main-tree-reject'|'anomaly.*', …) — elanous logs --category harness.boundary
//   자기인지: getHarnessSpace()/명시 마커 — 별도 감지 로직 최소화(스포너가 진실 전달).
//   힐링 : boot 경계 자동 활성(b) + boundary 해제 회귀에도 정본 write 거부(c·방어심화).

import { resolve, dirname, basename, join, isAbsolute, relative } from 'node:path';
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { getHarnessSpace, getHarnessBoundaryPath, HARNESS_BOUNDARY_REQUESTS_ENV, HARNESS_BOUNDARY_RESPONSES_ENV, HARNESS_RUN_ID_ENV } from './harness-space.js';
import { getSessionCwd, getSessionWorkingDir, setSessionCwd } from '../session/working-dir.js';
import { findGitDir } from '../git-fs/locate.js';
import { debug } from '../debug/log.js';
import { emitDecision } from '../live/detail-switch.js';
import { observeRawShellMetacharacters } from '../self-implement/auto-intervene.js';

export { HARNESS_BOUNDARY_REQUESTS_ENV } from './harness-space.js';

type BoundaryRequestCommandTelemetry = {
  readonly commandFirstToken: string;
  /** Shell syntax token that made the write-target parser reject, or `none` when no token decided it. */
  readonly decidingToken?: string;
  /** True when bun/node receives inline source through its documented eval/print flags, never by inspecting that source. */
  readonly inlineCode: boolean;
  /** Safe coarse summary for rejected command observations; never includes operands or paths. */
  readonly commandAction?: string;
  readonly commandChars: number;
  readonly commandHash: string;
  /** Anonymized metacharacter observation; empty string means observed-no-match, never the raw command. */
  readonly observedRawShellMetacharacters: string;
  readonly segmentHeads?: readonly string[];
  readonly segmentOperators?: readonly ('&&' | '||' | ';' | '|')[];
  readonly decidingSegmentIndex?: number;
  readonly segmentsTruncated?: true;
};

interface HarnessBoundaryRequest extends Partial<BoundaryRequestCommandTelemetry> {
  readonly requestId: string;
  readonly timestamp: string;
  readonly boundary: string;
  readonly cwd: string;
  readonly kind: string;
  readonly via: string;
  readonly path: string;
  readonly target: string;
  readonly targetKnown: boolean;
  /** Per-run join identity for rejection telemetry; null is never an empty-string surrogate. */
  readonly runId?: string | null;
  /** Distinguishes a non-harness caller from a harness whose run identity could not be read. */
  readonly runIdState?: 'present' | 'none' | 'unavailable';
  readonly requestType?: 'command-start' | 'command-start-cap-reached';
  /** `none` means the child cwd itself is outside the spawn-owned boundary. */
  readonly childResponsibility?: 'child' | 'none';
}

const HARNESS_COMMAND_START_LIMIT = 200;
let harnessCommandStartCount = 0;
let harnessCommandStartCapObserved = false;
/** Test seam for independent process-local notification cap scenarios. */
export function __resetHarnessCommandStartForTesting(): void {
  harnessCommandStartCount = 0;
  harnessCommandStartCapObserved = false;
}
const harnessBoundaryRequestCountByResponseMailbox = new Map<string, number>();
const harnessBoundaryRequestIdsByResponseMailbox = new Map<string, Set<string>>();

/** Appends a parent-designated, one-way boundary request without affecting rejection. */
function appendHarnessBoundaryRequest(
  env: NodeJS.ProcessEnv,
  request: Omit<HarnessBoundaryRequest, 'requestId' | 'timestamp'>,
): boolean {
  const requestPath = env[HARNESS_BOUNDARY_REQUESTS_ENV]?.trim();
  if (!requestPath) return false;
  try {
    const record: HarnessBoundaryRequest = {
      requestId: randomUUID(),
      timestamp: new Date().toISOString(),
      ...request,
    };
    appendFileSync(requestPath, `${JSON.stringify(record)}\n`, 'utf8');
    const responsePath = env[HARNESS_BOUNDARY_RESPONSES_ENV]?.trim();
    if (responsePath) {
      harnessBoundaryRequestCountByResponseMailbox.set(
        responsePath,
        (harnessBoundaryRequestCountByResponseMailbox.get(responsePath) ?? 0) + 1,
      );
      const requestIds = harnessBoundaryRequestIdsByResponseMailbox.get(responsePath) ?? new Set<string>();
      requestIds.add(record.requestId);
      harnessBoundaryRequestIdsByResponseMailbox.set(responsePath, requestIds);
    }
    return true;
  } catch {
    return false;
  }
}

/** Observes response IDs that correspond to requests made by this process, without changing rejection. */
function observeHarnessBoundaryResponseMatches(env: NodeJS.ProcessEnv, responsePath: string): void {
  const requestIds = harnessBoundaryRequestIdsByResponseMailbox.get(responsePath);
  if (!requestIds) return;
  try {
    const matchedRequestIds = new Set<string>();
    for (const line of readFileSync(responsePath, 'utf8').split('\n')) {
      try {
        const response: unknown = JSON.parse(line);
        if (response && typeof response === 'object' && 'requestId' in response) {
          const requestId = (response as { requestId?: unknown }).requestId;
          if (typeof requestId === 'string' && requestIds.has(requestId)) matchedRequestIds.add(requestId);
        }
      } catch { /* malformed response lines do not affect rejection */ }
    }
    debug.log('harness.boundary', 'response-mailbox-matches-observed', {
      matchedRequestCount: matchedRequestIds.size,
      requestCount: requestIds.size,
    });
  } catch { /* mailbox observation is fail-soft */ }
}

/** Observes parent response mailbox metadata and matching request IDs without writing its content. */
function observeHarnessBoundaryResponseMailbox(env: NodeJS.ProcessEnv): void {
  const responsePath = env[HARNESS_BOUNDARY_RESPONSES_ENV]?.trim();
  if (!responsePath) return;
  let responseBytes: number;
  try {
    responseBytes = statSync(responsePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
    responseBytes = 0;
  }
  observeHarnessBoundaryResponseMatches(env, responsePath);
  try {
    debug.log('harness.boundary', 'response-mailbox-observed', {
      responseBytes,
      requestCount: harnessBoundaryRequestCountByResponseMailbox.get(responsePath) ?? 0,
    });
  } catch { /* mailbox observation is fail-soft */ }
}

/**
 * ★ 심링크 우회 봉쇄(리뷰 should-fix) — 경로의 **존재하는 최장 조상**까지 realpath 로 정규화한 뒤 미존재
 *  접미(새로 만들 파일/디렉토리)를 붙여 돌려준다. worktree 내부 심링크가 정본 트리를 가리켜도 canonical
 *  경로로 펼쳐져 lexical prefix 판정이 뚫리지 않는다. 존재 조상을 못 찾으면 lexical resolve 폴백.
 *
 *  ⚠️ 잔여 위험(리뷰 should-fix·명시) — 이 정규화는 **판정 시점**의 심링크 상태를 편다. 판정 후 실제
 *  fs.writeFile(원래 경로) 사이에 심링크를 정본으로 **교체**하는 TOCTOU 는 봉쇄하지 못한다(그 수준의
 *  로컬 실행권이 있으면 이미 격리 밖 위협). 정적 심링크 우회는 닫고, 동시-교체 TOCTOU 는 수용/문서화.
 */
export function canonicalizeForBoundary(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  for (let i = 0; i < 128; i++) {
    try {
      const real = realpathSync(cur);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) break; // 루트 도달 — 존재 조상 없음
      tail.push(basename(cur));
      cur = parent;
    }
  }
  return resolve(p);
}

/**
 * ★ 격리 경계 후보를 결정한다(순수-ish·git read only). 우선순위:
 *   1) 명시 마커(getHarnessBoundaryPath) — 스포너가 심은 worktree 절대경로(결정론·1순위).
 *   2) isWorktree 자동추론 — cwd 가 **진짜 linked worktree** 일 때만 그 worktree 루트(findGitDir.root).
 *      cwd 가 정본 체크아웃/standalone(shadow) 이면(isWorktree=false) null — 별개 정본이 없어 개입 안 함.
 *  반환 canonical 경로 or null(경계 미상). 존재하지 않는 마커 경로는 무시(null 로 폴백).
 */
export function resolveHarnessBoundary(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = getSessionCwd(),
): string | null {
  // 1순위 — 명시 마커. 스포너가 심은 신뢰 인프라이나, 방어적으로 **절대경로 + 존재하는 디렉토리**만 채택
  //   (상대·미존재·파일 마커는 오설정 → 폴백). ⚠️ isWorktree(linked-worktree)는 **요구하지 않는다** — shadow
  //   staging(비-git dir/config 타겟)은 git-init 한 **standalone** 그림자(isWorktree=false)를 경계로 쓰므로,
  //   linked-worktree 를 강제하면 그림자 경계가 거부돼 오히려 무보호가 된다.
  const explicit = getHarnessBoundaryPath(env);
  if (explicit && isAbsolute(explicit)) {
    try { if (statSync(explicit).isDirectory()) return canonicalizeForBoundary(explicit); }
    catch { /* 미존재 → 폴백 */ }
  }
  // 폴백 — 진짜 worktree 만. 정본/standalone(shadow)은 자동추론으로 구분 불가 → 미개입(무회귀).
  const loc = findGitDir(cwd);
  if (loc && loc.isWorktree) return canonicalizeForBoundary(loc.root);
  return null;
}

/**
 * ★ (b) 하니스 공간이면 쓰기 경계를 활성화한다. boot(index.ts main)에서 1회 fail-open 호출. 비-하니스(운영/
 *  일반 프로세스)면 무회귀. 경계는 resolveHarnessBoundary(명시 마커 우선). 경계를 못 구하면(자동추론 실패·
 *  정본에서 부팅 등) 미활성 + 이상 관측(경계를 정본에 잘못 거는 것보다 안전 — 정본 축복 방지). idempotent.
 *
 *  @returns 활성화(또는 이미 활성)한 경계 경로, 비활성이면 null.
 */
export function activateHarnessWriteBoundary(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = getSessionCwd(),
): string | null {
  const space = getHarnessSpace(env);
  if (!space) return null; // 운영/일반 프로세스 — 무회귀
  const boundary = resolveHarnessBoundary(env, cwd);
  if (!boundary) {
    // 하니스 공간인데 경계 미상(명시 마커 없음 + cwd 가 worktree 아님 = 정본/standalone 에서 부팅). 정본을
    //   경계로 걸면 정본 write 를 축복하므로 **경계를 걸지 않는다**. 이상 신호를 크게 관측(제1원칙).
    try {
      debug.log('harness.boundary', 'anomaly.unresolved', { cwd, kind: space.kind, id: space.id }, { level: 'warn' });
    } catch { /* fail-soft */ }
    return null;
  }
  const cur = getSessionWorkingDir();
  if (cur.boundary && cur.cwd === boundary) return boundary; // idempotent
  setSessionCwd(boundary, cur.origin, { boundary: true });
  try {
    debug.log('harness.boundary', 'activate', {
      kind: space.kind, id: space.id, runId: space.runId, boundary, via: getHarnessBoundaryPath(env) ? 'explicit' : 'autodetect',
    });
  } catch { /* fail-soft */ }
  return boundary;
}

/**
 * ★ target 이 boundary 디렉토리 안(자신 포함)인가. `relative()` 기반 포함 판정 — `boundary + sep` prefix 는
 *  파일시스템 루트(`/`·`C:\`)에서 `//` 가 돼 자식 경로를 오거부하는 엣지가 있다(리뷰 should-fix). relative 는
 *  루트 경계에서도 정확: 밖이면 '..' 로 시작하거나 절대(다른 드라이브), 안이면 상대 하위경로, 자신이면 ''. 순수.
 */
export function isWithinBoundary(target: string, boundary: string): boolean {
  const rel = relative(resolve(boundary), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The child cannot repair a rejection when its spawn cwd is itself outside the boundary.
 * Any path-resolution failure remains child-repairable so this observation never changes denial. */
function childResponsibilityForBoundaryReject(cwd: string, boundary: string): 'child' | 'none' {
  try {
    return isWithinBoundary(cwd, boundary) ? 'child' : 'none';
  } catch {
    return 'child';
  }
}

/** Preserves the distinction between a harness with no run and one whose supplied identity is unusable. */
function boundaryRejectRunIdentity(env: NodeJS.ProcessEnv, space: ReturnType<typeof getHarnessSpace>): {
  runId: string | null;
  runIdState: 'present' | 'none' | 'unavailable';
} {
  if (!space) return { runId: null, runIdState: 'none' };
  if (space.runId) return { runId: space.runId, runIdState: 'present' };
  return env[HARNESS_RUN_ID_ENV]?.trim()
    ? { runId: null, runIdState: 'unavailable' }
    : { runId: null, runIdState: 'none' };
}

/**
 * ★ 순수 경로 판정 — target 이 boundary(격리 worktree) 안이면 'allow', 밖이면 'reject'. boundary null 이면
 *  판정 불가로 'allow'(무회귀). 모든 입력은 canonical 가정(호출자가 canonicalizeForBoundary 적용). 순수.
 */
export function classifyHarnessWrite(target: string, boundary: string | null): 'allow' | 'reject' {
  if (!boundary) return 'allow';
  return isWithinBoundary(target, boundary) ? 'allow' : 'reject';
}

/**
 * ★ (c) 방어심화 — boundary 플래그가 (미활성/해제)여도, 하니스 공간이면 **격리 경계 밖** write 를 거부한다.
 *  boundary 를 지우는 setSessionCwd(EnterWorktree·SetWorkingDir 등)로 (b)가 무력화된 회귀에도 격리 불변을
 *  보장. 경계는 resolveHarnessBoundary(명시 마커 우선·cwd 무관) — cwd 가 정본으로 이동/부팅해도 경계는
 *  worktree 라 정본 write 가 거부된다(리뷰 must-fix). 비-하니스/경계미상이면 null(무회귀). 거부 시 사유 문자열.
 *
 *  ⚠️ resolveMainRepoRoot/findGitDir(자동추론 폴백)은 git 서브프로세스라 저비용은 아니다 — 호출자(apply.ts)는
 *  boundary 미활성일 때만(정상 경로는 인메모리 isWriteAllowedInBoundary 로 이미 처리) 이 함수를 탄다.
 */
export function harnessMainTreeReject(
  absPath: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  via = 'code-edit',
): string | null {
  const space = getHarnessSpace(env);
  if (!space) return null; // 비-하니스 — 무회귀
  const boundary = resolveHarnessBoundary(env, cwd);
  if (!boundary) return null; // 경계 미상(정본/standalone 에서 부팅) — 개입 안 함(무회귀·이상은 (b)가 관측)
  const target = canonicalizeForBoundary(absPath);
  if (classifyHarnessWrite(target, boundary) === 'allow') return null;
  const childResponsibility = childResponsibilityForBoundaryReject(cwd, boundary);
  const request = {
    path: absPath, target, boundary, cwd, kind: space.kind, via, targetKnown: true, childResponsibility,
    ...boundaryRejectRunIdentity(env, space),
  };
  try {
    // ⭐ 이쪽은 `target` 이 «실제» 쓰기 대상이다 — 위 미지-셸 분기와 «다른 사실»이므로 값으로 가른다.
    debug.log('harness.boundary', 'main-tree-reject', request);
    emitDecision({ kind: 'VERIFY', what: `격리 경계 밖 쓰기 거절 · ${basename(absPath)}`, reason: `정본 트리(${space.kind}) 보호 — 격리 worktree 밖`, purpose: '사람 트리를 자식이 오염하지 않게', target: '자식에게 되돌림(격리 안 경로로)', phase: 'implement' });
  } catch { /* fail-soft */ }
  const requestRecorded = appendHarnessBoundaryRequest(env, request);
  observeHarnessBoundaryResponseMailbox(env);
  const refusal = `격리 경계 밖 쓰기 거부(하니스 격리·${space.kind}): ${absPath}. 격리 worktree(${boundary}) 내부 경로로 쓰라(정본 트리 오염 금지).`;
  if (childResponsibility !== 'none') return refusal;
  const parentRecordStatus = requestRecorded ? '이 요청은 부모에게 기록됐다.' : '이 요청은 부모에게 기록되지 않았다.';
  return `${refusal} 현재 작업 위치 자체가 격리 경계 밖이라 다른 경로를 시도해도 바뀌지 않으며, ${parentRecordStatus}`;
}

/** Shell strings cannot be soundly statically interpreted. These commands are
 * read-only by contract; every other unparsed shell invocation is fail-closed
 * while an explicit harness boundary is active. */
/** ⛔⭐⭐ **미등록은 곧 거부다** — 목록이 좁으면 `wc`·`date` 같은 명백한 조회까지 fail-closed 로
 *  막혀 수용 기준(*읽기 명령은 막지 않는다*)을 어기고, 하니스 자식이 아예 못 돈다
 *  (무인 리뷰 7라운드 실측). ⇒ 조회 도구를 넉넉히 싣는다.
 *  ⚠️ **뺀 것들과 이유**: `awk`(프로그램 안에서 `print > "file"` 로 쓴다) · `sort`(`-o` 로 쓴다 ⇒
 *  명령별 출력 플래그 표로 간다) · `yq`(`-i` 로 제자리 수정) — 조회처럼 보이지만 쓰기 모드가 있다. */
const READ_ONLY_SHELL_COMMANDS = new Set([
  'cat', 'diff', 'echo', 'grep', 'head', 'ls', 'pwd', 'rg', 'sleep', 'stat', 'tail', 'true', 'type', 'which', 'exit',
  'wc', 'date', 'basename', 'dirname', 'realpath', 'readlink', 'printf', 'test', 'seq', 'file',
  'du', 'df', 'id', 'whoami', 'hostname', 'uname', 'comm', 'nl', 'rev', 'tac', 'od', 'xxd',
  'shasum', 'md5sum', 'sha256sum', 'cksum', 'column', 'expr', 'cut', 'tr', 'uniq', 'paste', 'join',
  'fold', 'expand', 'unexpand', 'jq', 'less', 'more', 'wc', 'tree', 'ps', 'uptime', 'printenv', 'false',
]);
/** ⛔ 인터프리터는 그 자체로 읽기 전용이 **아니다** — 판정은 `-c` 뒤의 payload 에 있다.
 *  초판은 `bash`·`sh`·`zsh` 를 READ_ONLY 에 넣어 `sh -c 'touch /outside'` 가 **통과했다**
 *  (무인 리뷰 should-fix · 실측). 같은 파일이 선언한 fail-closed 계약과 정면으로 어긋난다.
 *  ⇒ payload 를 **같은 판정기로 재귀 분류**한다: `sh -c 'git status'` 는 통과하고
 *     `sh -c 'touch /outside'` 는 미결정으로 fail-closed 된다. `-c` 가 없는 형태
 *     (대화형 셸·`bash script.sh`)는 스크립트 내용을 못 보므로 미결정이다. */
const SHELL_INTERPRETERS = new Set(['bash', 'sh', 'zsh']);
/** ⛔⭐⭐⭐ 런타임 인터프리터 — `bun`·`node`. 이들이 미결정으로 떨어지면 **자식이 자기 검증을
 *  하나도 못 한다**: `bun test <file>` · `bun bin/elanous.mjs self typecheck` · `bun run …` 가
 *  전부 fail-closed 로 막힌다(2026-08-02 실측 — 자식이 *"격리 셸의 쓰기-대상 판정이 모든 Bash
 *  호출을 실행 전 차단하고 있어"* 라 적고 세 런이 연속 abandoned 됐다).
 *  ⇒ 판정 축은 **새로 만들지 않는다** — 아래 `-c` 없는 셸이 이미 같은 문제를 풀어 놨다:
 *     스크립트 내용을 못 보니 **cwd 축**으로 본다(경계 안에서 도는 것은 허용 · 밖은 거부).
 *     `bash script.sh` 와 `bun test file.ts` 는 *"낼 명령을 지금 볼 수 없다"* 는 점에서 같다.
 *  ⚠️ READ_ONLY 에 넣지 **않는다** — 그건 `sh` 를 넣었다가 `sh -c 'touch /outside'` 를 통과시킨
 *     초판의 실패(위 주석)와 같은 형태다. cwd 가 경계 밖이면 이 분기도 그대로 거부한다.
 *  ⛔⭐⭐ **`npx`·`bunx`·`deno` 는 일부러 뺐다**(무인 리뷰 3라운드). 초판은 넣었는데 셋 다
 *     플래그 문법이 달라 오탐·누락이 **구조적**이었다: `npx -p typescript tsc` 의 `-p` 는
 *     `--package` 라 eval 로 오탐되고, `deno --config x eval …` 은 옵션 값이 첫 피연산자
 *     자리를 먹어 eval 을 **놓친다**. ⇒ 실측으로 표면을 좁혔다 — 이 레포의 검증 경로는
 *     `package.json` 스크립트 전부가 `bun` 이고 `npx`·`deno` 는 소스에 **0건**이다.
 *     필요해지면 그때 각 런타임의 문법으로 따로 판정한다(추측으로 넓히지 않는다). */
const RUNTIME_INTERPRETERS = new Set(['bun', 'node']);
/** ⛔⭐⭐⭐ 런타임 **플래그 구간은 통째로 fail-closed** 한다 — 무인 리뷰 7라운드가 같은 자리를
 *  여섯 번 뚫었고, 뚫린 이유가 매번 *"플래그 표를 더 정교하게"* 였다:
 *    1R `node -e CODE`            2R `--eval=CODE` · `-eCODE`
 *    4R `node -r fs -e CODE`(값 소비)  5R `node -c` vs `bun -c`(런타임별로 뜻이 반대)
 *    6R `--import data:…`(값이 곧 코드)  7R `--import=data:…` · `bun --cwd=/outside`(=형)
 *  ⇒ ⭐ 표를 키우는 방향은 **틀린 방향**이었다. 실제로 필요한 것은 네 모양뿐이다:
 *       `bun test …` · `bun run …` · `bun <스크립트> …` · `node --version`
 *     즉 **런타임 자신의 플래그가 필요 없다.** 그러면 첫 토큰이 플래그인 순간 거부하면 되고,
 *     `-e`·`--import`·`--cwd`·미상 플래그가 **한 규칙으로** 전부 닫힌다.
 *  ⚠️ 버전 조회(`--version`·그 단축 `-v`)만 예외다 — 값을 안 먹고 아무것도 실행하지 않으며
 *     인자가 그것 하나뿐일 때만 통과한다. 둘 다 회귀로 고정돼 있다. */
const VERSION_ONLY_FLAGS = new Set(['--version', '-v']);
/** 재귀 상한 — `sh -c "sh -c '…'"` 중첩이 무한히 돌지 않게 한다. 넘으면 미결정(fail-closed). */
const MAX_SHELL_NESTING = 4;
/** ⛔ 같은 이유로 git 조회 서브커맨드도 넉넉히 싣는다 — `git ls-tree`·`git cat-file` 이 막히면
 *  grounding·검증 경로가 통째로 죽는다(무인 리뷰 7라운드). ⚠️ `config`·`gc`·`fetch` 는 뺀다
 *  (각각 쓰기 모드·객체 정리·ref 갱신이 있다). */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'blame', 'diff', 'log', 'ls-files', 'rev-parse', 'show', 'status',
  'ls-tree', 'cat-file', 'rev-list', 'describe', 'show-ref', 'for-each-ref', 'symbolic-ref',
  'name-rev', 'merge-base', 'diff-tree', 'diff-files', 'diff-index', 'check-ignore', 'check-attr',
  'ls-remote', 'shortlog', 'whatchanged', 'grep', 'count-objects', 'verify-commit', 'verify-tag',
  'var', 'help', 'version', 'annotate', 'cherry', 'range-diff',
]);
const GIT_MUTATING_SUBCOMMANDS = new Set([
  'add', 'branch', 'checkout', 'commit', 'merge', 'rebase', 'reset', 'restore', 'stash', 'switch', 'tag', 'update-ref',
]);
/** Safe observation vocabulary: only known git operations may leave the process. */
const OBSERVABLE_GIT_SUBCOMMANDS = new Set([
  ...READ_ONLY_GIT_SUBCOMMANDS,
  ...GIT_MUTATING_SUBCOMMANDS,
]);
const FIND_EXEC_OPTIONS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir']);
/** ⛔⭐⭐⭐ **「읽기 전용 명령」이라는 분류 자체가 구멍이다** — 거의 모든 조회 도구에
 *  *"결과를 파일로 내보내는"* 플래그가 하나씩 있다(`diff --output=` · `find -fprint` ·
 *  `grep -o` 는 아니지만 `--output` 이 있는 도구는 많다). 명령마다 쫓으면 계속 샌다
 *  (무인 리뷰 5라운드 실측 · 라운드마다 다른 명령에서 같은 계열이 나왔다).
 *  ⇒ **명령이 아니라 플래그로** 잡는다: 아래 플래그가 값과 함께 나오면 **그 값이 쓰기 대상**이고,
 *     읽기 전용 분류보다 **먼저** 판정한다. 새 도구가 들어와도 이 규칙이 먼저 걸린다. */
/** ⛔⭐⭐ **전역 플래그 집합은 오탐을 만든다** — 초판은 `-o` 를 전역 출력 플래그로 뒀는데
 *  `grep -o` 는 `--only-matching`(경로를 안 받는다)이라 **읽기 명령이 쓰기로 오판**됐다
 *  (무인 리뷰 실측 · 수용 기준 *"읽기 명령은 막지 않는다"* 위반). ⇒ ***플래그 의미는 명령마다
 *  다르다*** — git 서브커맨드에서 배운 것과 같은 교훈이라 **명령별 표**로 되돌린다.
 *  ⚠️ `find` 의 출력 술어는 **대시 하나**다(`-fprint`). */
const OUTPUT_PATH_FLAGS_BY_COMMAND: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['diff', new Set(['--output', '--output-file'])],
  ['find', new Set(['-fprint', '-fprint0', '-fprintf'])],
  ['tee', new Set(['-a', '--append'])],
  // ⛔ git 도 조회 서브커맨드에서 파일을 쓸 수 있다 — `git diff --output=X` · `git format-patch -o X`.
  //    읽기 전용 서브커맨드 판정보다 **먼저** 걸려야 한다(무인 리뷰 8라운드 실측).
  ['git', new Set(['--output', '--output-file', '-o', '--output-directory'])],
  ['sort', new Set(['-o', '--output'])],
]);

/** ⛔ **명령 앞에 붙어 다른 명령을 실행하는 것들** — `env touch /outside` 처럼 조회로 위장한다.
 *  `env` 를 읽기 전용 목록에 실었다가 그대로 뚫렸다(무인 리뷰 8라운드 실측).
 *  ⇒ 접두를 벗기고 **뒤에 오는 진짜 명령으로 다시 판정**한다. */
const COMMAND_PREFIX_RUNNERS = new Set(['env', 'nice', 'nohup', 'stdbuf', 'command', 'time', 'timeout', 'xargs', 'sudo', 'doas']);

/** 해당 명령의 **출력 경로 플래그**가 지목하는 쓰기 대상을 걷는다(`--output x` · `--output=x` 둘 다).
 *  값이 없으면 미결정 신호로 `null` 을 돌려 호출자가 fail-closed 하게 한다.
 *  ⛔ 표에 없는 명령은 **빈 배열**이다 — 모르는 플래그를 추측해 오탐을 만들지 않는다. */
function outputFlagTargets(command: string, argv: readonly string[], cwd: string): string[] | null {
  const flags = OUTPUT_PATH_FLAGS_BY_COMMAND.get(command);
  if (!flags) return [];
  const targets: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf('=');
    if (eq > 0 && flags.has(arg.slice(0, eq))) {
      targets.push(commandPath(arg.slice(eq + 1), cwd));
      continue;
    }
    if (!flags.has(arg)) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('-')) return null;   // 값이 없다 → 미결정
    targets.push(commandPath(value, cwd));
    i++;
  }
  return targets;
}

/** 인터프리터의 `-c` payload — `-c` 단독뿐 아니라 **묶인 형태**(`-lc`·`-xc`)도 찾는다.
 *  ⛔ `argv.indexOf('-c')` 만 보면 `bash -lc '<payload>'` 가 "`-c` 가 없다"로 읽혀 cwd 축으로
 *     떨어지고 경계 밖 쓰기가 통과한다(무인 리뷰 실측). */
function interpreterPayload(argv: readonly string[]): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('-') || arg.startsWith('--')) continue;
    if (!arg.slice(1).includes('c')) continue;
    return argv[i + 1];
  }
  return undefined;
}
/** ⛔⭐⭐⭐ **플래그 의미는 서브커맨드마다 다르다** — 한 집합을 공유하면 반드시 샌다.
 *  실측(무인 리뷰 4라운드): `-a` 는 `branch` 에서 `--all`(조회)이고 `tag` 에서
 *  `--annotate`(생성)다. 공유 집합을 쓰던 초판은 `git tag -a v1` 을 **조회로 오판**했다.
 *  ⇒ 서브커맨드별로 가른다. 판정 순서는 **변경 → 조회 → 피연산자**이고, 어느 쪽도
 *     확정 못 하면 **변경으로 본다**(경계 밖 오거부는 안전하고 오허용은 사고다). */
const BRANCH_READ_ONLY_FLAGS = new Set([
  '--list', '-l', '--show-current', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose',
  '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--format', '--sort',
  '--column', '--no-column', '-i', '--ignore-case',
]);
const BRANCH_MUTATING_FLAGS = new Set([
  '-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy',
  '-u', '--set-upstream-to', '--unset-upstream', '--set-upstream', '--edit-description',
  '-f', '--force', '-t', '--track', '--no-track',
]);
const TAG_READ_ONLY_FLAGS = new Set([
  '-l', '--list', '-n', '--contains', '--no-contains', '--points-at', '--merged', '--no-merged',
  '--format', '--sort', '--column', '--no-column', '-i', '--ignore-case', '-v', '--verify',
]);
const TAG_MUTATING_FLAGS = new Set([
  '-a', '--annotate', '-s', '--sign', '-u', '--local-user', '-d', '--delete',
  '-m', '--message', '-F', '--file', '-f', '--force', '--cleanup', '-e', '--edit',
]);

function commandPath(raw: string, cwd: string): string {
  return canonicalizeForBoundary(isAbsolute(raw) ? raw : resolve(cwd, raw));
}

export type UnknownCommandReasonKind = 'shell-syntax' | 'unknown-command' | 'other';

type KnownCommandTargets = { targets: string[]; known: true };
export type UnknownCommandTargets = {
  targets: string[];
  known: false;
  reason: string;
  reasonKind: UnknownCommandReasonKind;
  /** Exact shell syntax token used by this parser decision, or `none` when no token decided it. */
  decidingToken: string;
};
export type HarnessCommandWriteTargets = KnownCommandTargets | UnknownCommandTargets;

/** 거부문에 실을 허용 명령 표본 — ⛔ 전부 싣지 않는다(60개가 넘어 거부문이 화면을 덮는다).
 *  ⭐ 자식이 «실제로 자주 쓰는» 것부터 이름을 대고, 전체는 세어서 알린다. */
const REJECT_HINT_COMMANDS = ['cat', 'grep', 'rg', 'ls', 'head', 'tail', 'wc', 'diff', 'jq', 'printf'] as const;

/** Returns the repository-specific verification hint only when this child worktree provides its entrypoint. */
function elanousTypecheckHint(boundary: string): string | null {
  try {
    return existsSync(join(boundary, 'bin', 'elanous.mjs')) ? 'bun bin/elanous.mjs self typecheck' : null;
  } catch {
    return null;
  }
}

/**
 * Renders an indeterminate-command rejection from its closed reason kind, never its display text.
 *
 * ⛔⭐⭐⭐ **금지는 «길»을 같이 준다**([[FINDING-prohibition-without-a-path]] · 대표 2026-08-07).
 *   📏 실측 근거: 7일 창에 이 거부가 **1,818건**인데(전 우주 · `harness.boundary`/`main-tree-reject`),
 *     종전 문면은 *"허용된 명령 하나만 그대로 실행하라"* 라고만 했다 — ***그 「허용된 명령」이
 *     무엇인지 자식에게 «보이지 않는다».*** 목록은 이 파일 안에만 있었다.
 *   ⇒ ⭐ 이름을 대고(표본 ⊕ 전체 수), 합성이면 **어떻게 고쳐 쓰는지**를 보인다.
 *   ⛔ **행위는 한 글자도 안 바뀐다** — 여전히 거부한다. 바뀌는 것은 «자식이 다음에 무엇을 할 수 있나»뿐이다.
 */
export function formatUnknownCommandWriteReject(
  boundary: string,
  unknown: UnknownCommandTargets,
  command?: readonly string[] | string,
): string {
  const allowed = `허용된 읽기 명령 예: ${REJECT_HINT_COMMANDS.join(' · ')} (총 ${READ_ONLY_SHELL_COMMANDS.size}개)`;
  const git = `git 조회 하위 명령도 허용: ${['status', 'diff', 'log', 'show', 'ls-files'].join(' · ')} (총 ${READ_ONLY_GIT_SUBCOMMANDS.size}개)`;
  const runtimeExamples = ['bun test <파일>', 'bun run <스크립트>', elanousTypecheckHint(boundary)].filter((hint): hint is string => hint !== null);
  const runtime = `검증은 ${[...RUNTIME_INTERPRETERS].join('·')} 로 직접 실행하라 — 예: ${runtimeExamples.join(' · ')}`;
  // ⛔⭐ 경계 «경로»는 어느 갈래에서도 빠지면 안 된다 — 자식이 *"그럼 어디에는 쓸 수 있나"* 를 잃는다.
  //   (초판 수리에서 이걸 떨어뜨렸고 회귀가 잡았다 — `길을 준다` 를 하다 길의 «주소»를 지운 셈이다.)
  const where = `쓸 수 있는 곳은 격리 worktree(${boundary}) 내부다.`;
  const runnableForm = unknown.reasonKind === 'shell-syntax'
    // ⭐ 합성이 막힌 것이므로 «쪼개는 법»을 보인다 — 이것이 이 부류의 유일한 길이다.
    ? [
      ...(command && commandRejectTelemetry(command).commandFirstToken === 'cd'
        ? ['작업 디렉터리가 이미 격리 경계이므로 `cd <경로> &&` 앞머리를 빼고 그 뒤의 명령 하나만 그대로 실행하라.']
        : []),
      '작업 디렉터리가 이미 격리 경계다. 판정 못 한 합성을 빼고 **한 번에 한 명령**을 실행하라.',
      // ⭐ 읽기 명령끼리의 `|`·`&&`·`2>&1`·`cd X &&` 는 이제 통과한다(#20303) — 거부된 것은 그 안의 «모르는» 조각이다.
      '읽기 명령끼리의 `A | B`·`A && B`·`A; B`·`2>&1`·`cd <경로> && …` 는 허용된다 — 막힌 것은 그 안의 명령 치환 `$(…)`·백틱·배경 `&`·서브셸·`;` 사슬 안의 `cd` 또는 판정 못 한 명령이다. 고쳐 쓰는 법: 그 조각을 빼거나 따로 실행하라.',
      where, allowed, runtime,
    ].join(' ')
    : unknown.reasonKind === 'unknown-command'
      ? [
        '작업 디렉터리가 이미 격리 경계다. 디렉터리를 옮기는 앞머리를 빼고 허용된 명령 하나만 그대로 실행하라.',
        where, allowed, git, runtime,
      ].join(' ')
      : unknown.reason.startsWith('런타임 해석기의')
        // ⭐ 24h 경계 거부 중 가장 큰 칸(`bun -e` 등 · 2026-09-24 실측 39/223)인데 «길»이 없었다 — 파일로 쓰면 판정된다.
        ? `격리 worktree(${boundary}) 내부의 판정 가능한 경로만 쓰라. 인라인 코드(\`-e\`·\`--eval\` 등)는 판정할 수 없다 — 그 코드를 worktree 안의 파일로 쓰고(elanous 저장소면 git 이 무시하는 \`.elanous-test/scratch/<이름>.ts\`) \`bun <그 파일>\` 로 실행하라.`
        : `격리 worktree(${boundary}) 내부의 판정 가능한 경로만 쓰라.`;
  return `격리 경계 쓰기 판정 거부: ${unknown.reason}. ${runnableForm}`;
}

/** Records an allowed command start for parent observation without changing execution. */
export function notifyHarnessCommandStart(
  command: readonly string[] | string,
  cwd: string,
  via: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const space = getHarnessSpace(env);
  if (!space || harnessCommandStartCount >= HARNESS_COMMAND_START_LIMIT) {
    if (space && !harnessCommandStartCapObserved) {
      const capObserved = appendHarnessBoundaryRequest(env, {
        requestType: 'command-start-cap-reached',
        path: cwd,
        target: canonicalizeForBoundary(cwd),
        boundary: getHarnessBoundaryPath(env) ?? '',
        cwd,
        kind: space.kind,
        via,
        targetKnown: true,
      });
      if (capObserved) harnessCommandStartCapObserved = true;
    }
    return false;
  }
  const telemetry = commandRejectTelemetry(command);
  const recorded = appendHarnessBoundaryRequest(env, {
    requestType: 'command-start',
    path: cwd,
    target: canonicalizeForBoundary(cwd),
    boundary: getHarnessBoundaryPath(env) ?? '',
    cwd,
    kind: space.kind,
    via,
    targetKnown: true,
    ...telemetry,
  });
  if (recorded) harnessCommandStartCount++;
  return recorded;
}

function commandRejectTelemetry(command: readonly string[] | string): {
  commandFirstToken: string;
  inlineCode: boolean;
  commandAction: string;
  commandChars: number;
  commandHash: string;
  observedRawShellMetacharacters: string;
} {
  const commandText = typeof command === 'string' ? command : command.join('\0');
  // ⛔⭐ 배열이라고 «원소 하나 = 토큰 하나»가 아니다 — `via: 'pty-start'` 는 셸 한 줄을
  //   ***원소가 하나인 배열***(`['git status | head -5']`)로 넘긴다. 종전엔 `command[0]` 을
  //   그대로 써서 `commandFirstToken` 에 «명령 전체»가 실렸고, 그 이름이 값에 대해 거짓이었다.
  //   📏 2026-08-07 라이브 실측(2층 자식 우편함 1줄): commandFirstToken="git status | head -5".
  //   ⚠️ 그 값을 허용 목록과 대조하는 판정(`decideBoundaryApproval`)에서 «거짓 음성»이 난다 —
  //      원소가 정확히 `bun` 이면 맞지만 `bun test <파일>` 이면 안 맞는다.
  //   ⇒ 두 입력 모양을 «같은 규칙»으로 접는다: 후보를 고른 뒤 공백으로 한 번 자른다.
  //      (진짜 토큰 배열 `['git','status']` 은 자를 것이 없어 종전과 동일하다 — 회귀 0.)
  const firstCandidate = typeof command === 'string' ? command : command[0] ?? '';
  const firstToken = firstCandidate.trim().split(/\s+/, 1)[0] ?? '';
  const commandFirstToken = basename(firstToken.split('=', 1)[0] ?? '');
  const observationSource = typeof command === 'string' ? command : command.join(' ');
  return {
    commandFirstToken,
    inlineCode: observesInlineCode(command),
    commandAction: commandAction(command),
    commandChars: commandText.length,
    commandHash: createHash('sha256').update(commandText).digest('hex').slice(0, 16),
    observedRawShellMetacharacters: observeRawShellMetacharacters(observationSource),
  };
}

/**
 * Observes only whether bun/node receives inline source, never that source's contents.
 * Bun and Node document `-e`/`--eval` and `-p`/`--print`; short flags may attach their source.
 * Shell strings are split into shell words while argv arrays are already words. Runtime options with
 * operands are consumed and scanning stops at `--` or the named program, preserving script arguments.
 */
export function observesInlineCode(command: readonly string[] | string): boolean {
  const tokens = commandTokens(command);
  while (tokens[0] && isEnvironmentAssignment(tokens[0]!)) tokens.shift();
  const executable = basename(tokens.shift() ?? '');
  if (executable !== 'bun' && executable !== 'node') return false;

  const inlineFlags = ['-e', '--eval', '-p', '--print'];
  // Node documents these runtime switches as consuming their following operand. Consume that operand
  // rather than mistaking it for the named program, so a later eval/print flag remains observable.
  const optionsWithValues = new Set([
    '--require', '-r', '--import', '--loader', '--experimental-loader', '--conditions', '-C',
    '--input-type', '--env-file', '--env-file-if-exists', '--openssl-config', '--icu-data-dir',
  ]);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '--') return false;
    if (inlineFlags.some((flag) => token === flag || token.startsWith(`${flag}=`) || (flag.length === 2 && token.startsWith(flag)))) return true;
    if (optionsWithValues.has(token)) {
      index++;
      continue;
    }
    if (!token.startsWith('-')) return false;
  }
  return false;
}

/** Keeps single shell-line argv inputs aligned with the command-token folding contract. */
function commandTokens(command: readonly string[] | string): string[] {
  return typeof command === 'string' ? shellWords(command) : command.length === 1 ? shellWords(command[0] ?? '') : [...command];
}

function isEnvironmentAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/** Splits shell words without interpreting expansions; quotes and backslash escapes only delimit words. */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (char === '\\' && quote !== "'") {
      const escaped = command[++index];
      if (escaped !== undefined) word += escaped;
      else word += char;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else word += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (word) {
        words.push(word);
        word = '';
      }
    } else {
      word += char;
    }
  }
  if (word) words.push(word);
  return words;
}

/**
 * Returns an observation-only command class. This intentionally does not infer shell pipelines,
 * options, operands, or paths; `rejectUnknownShellWrite` is the rejected-request caller.
 */
export function commandAction(command: readonly string[] | string): string {
  const tokens = (typeof command === 'string' ? command : command.join(' ')).trim().split(/\s+/);
  const executable = basename((tokens[0] ?? '').split('=', 1)[0] ?? '');
  const gitSubcommand = tokens[1] ?? '';
  if (executable !== 'git') return executable;
  return OBSERVABLE_GIT_SUBCOMMANDS.has(gitSubcommand) ? `git ${gitSubcommand}` : 'git unknown';
}

/** Observation only: never pass operands, redirects, or shell source into the rejection record. */
function rejectedCommandSegments(command: readonly string[] | string, cwd: string, unknown: UnknownCommandTargets): Pick<BoundaryRequestCommandTelemetry, 'segmentHeads' | 'segmentOperators' | 'decidingSegmentIndex' | 'segmentsTruncated'> {
  const source = typeof command === 'string' ? command : command.length === 1 ? command[0] ?? '' : null;
  const fragments: string[] = [];
  const operators: Array<'&&' | '||' | ';' | '|'> = [];
  if (source === null) {
    fragments.push((command as readonly string[]).join(' '));
  } else {
    let start = 0;
    let quote: "'" | '"' | null = null;
    for (let i = 0; i < source.length; i++) {
      const ch = source[i]!;
      if (ch === '\\' && quote !== "'") { i++; continue; }
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch !== ';' && ch !== '|' && !(ch === '&' && source[i + 1] === '&')) continue;
      const operator = ch === ';' ? ';' : ch === '|' ? (source[i + 1] === '|' ? '||' : '|') : '&&';
      fragments.push(source.slice(start, i));
      operators.push(operator);
      i += operator.length - 1;
      start = i + 1;
    }
    fragments.push(source.slice(start));
  }
  const segmentHeads = fragments.slice(0, 20).map((fragment) => {
    const words = shellWords(fragment.trim());
    while (words[0] && isEnvironmentAssignment(words[0])) words.shift();
    const first = words[0] ?? '';
    // A substitution or shell punctuation is not a command name; keep only its leading marker.
    if (/^[$`(]/.test(first)) return first[0]!;
    return basename(first.split(/[;&|<>]/, 1)[0] ?? '').replace(/[^\p{L}\p{N}_.+@-].*$/u, '');
  });
  const result: { segmentHeads: string[]; segmentOperators: typeof operators; decidingSegmentIndex?: number; segmentsTruncated?: true } = {
    segmentHeads,
    segmentOperators: operators.slice(0, 19),
  };
  if (fragments.length > 20) result.segmentsTruncated = true;
  // Only identify a deciding fragment when the same classifier gives the exact rejection there.
  // Global shell syntax decisions (e.g. a semicolon chain containing cd) have no such fragment.
  if (source !== null) {
    const index = fragments.findIndex((fragment) => {
      const parsed = shellWriteTargets(fragment.trim(), cwd);
      return !parsed.known && parsed.reason === unknown.reason && parsed.reasonKind === unknown.reasonKind && parsed.decidingToken === unknown.decidingToken;
    });
    if (index >= 0) result.decidingSegmentIndex = index;
  } else if (!unknown.known) {
    result.decidingSegmentIndex = 0;
  }
  return result;
}

function rejectUnknownShellWrite(
  command: readonly string[] | string,
  cwd: string,
  boundary: string,
  via: string,
  unknown: UnknownCommandTargets,
  env: NodeJS.ProcessEnv,
): string {
  const space = getHarnessSpace(env);
  const request = {
    path: cwd,
    target: canonicalizeForBoundary(cwd),
    boundary,
    cwd,
    kind: space?.kind ?? '',
    via,
    targetKnown: false,
    ...boundaryRejectRunIdentity(env, space),
    ...commandRejectTelemetry(command),
    ...rejectedCommandSegments(command, cwd, unknown),
    decidingToken: unknown.decidingToken,
  };
  try {
    debug.log('harness.boundary', 'main-tree-reject', {
      ...request,
      detail: unknown.reason,
      reasonKind: unknown.reasonKind,
    });
  } catch { /* fail-soft */ }
  appendHarnessBoundaryRequest(env, request);
  observeHarnessBoundaryResponseMailbox(env);
  return formatUnknownCommandWriteReject(boundary, unknown, command);
}

type CommandTargets = HarnessCommandWriteTargets;

function unknownTargets(
  reason: string,
  reasonKind: UnknownCommandReasonKind = 'other',
  targets: string[] = [],
  decidingToken = 'none',
): UnknownCommandTargets {
  return { targets, known: false, reason, reasonKind, decidingToken };
}

function gitTargets(argv: readonly string[], cwd: string): CommandTargets {
  let repository = cwd;
  let workTree: string | null = null;
  // ⛔ `--git-dir` 은 **refs 가 사는 곳**이다 — 무시하면 `git --git-dir=/human/.git branch x` 가
  //    경계 안 cwd 로 판정돼 사람 트리의 ref 를 고친다(무인 리뷰 must-fix · 실측).
  let gitDir: string | null = null;
  let subcommand = '';
  let subcommandIndex = -1;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-C') {
      const value = argv[++i];
      if (!value) return unknownTargets('git -C 뒤에 경로 인자가 없음');
      repository = commandPath(value, repository);
      continue;
    }
    if (arg === '--git-dir' || arg === '--work-tree') {
      const value = argv[++i];
      if (!value) return unknownTargets(`git ${arg} 뒤에 경로 인자가 없음`);
      // ⛔ 상대경로는 **`-C` 적용 뒤 디렉토리** 기준이다(git 이 `-C` 로 먼저 이동한다).
      //    원래 cwd 로 풀면 파서는 안이라 하고 git 은 밖에 쓴다(must-fix · 실측).
      if (arg === '--work-tree') workTree = commandPath(value, repository);
      else gitDir = commandPath(value, repository);
      continue;
    }
    if (arg.startsWith('--work-tree=')) {
      workTree = commandPath(arg.slice(arg.indexOf('=') + 1), repository);
      continue;
    }
    if (arg.startsWith('--git-dir=')) {
      gitDir = commandPath(arg.slice(arg.indexOf('=') + 1), repository);
      continue;
    }
    if (!arg.startsWith('-') && !subcommand) {
      subcommand = arg;
      subcommandIndex = i;
    }
  }
  if (!subcommand) return unknownTargets('git 하위 명령 토큰이 없음');
  if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return { targets: [], known: true };
  const operands = argv.slice(subcommandIndex + 1).filter((arg) => !arg.startsWith('-'));
  // ⛔ 아래 모든 뮤테이션 분기는 **refTargets 하나로** 대상을 계산한다 — 분기마다 손으로
  //    적으면 `--git-dir` 을 빠뜨린 분기가 남는다(무인 리뷰가 remote 분기에서 그걸 잡았다).
  if (subcommand === 'remote') {
    const action = operands[0];
    return action === undefined || action === 'get-url' || action === 'show'
      ? { targets: [], known: true }
      : { targets: refTargets(gitDir, workTree, repository), known: true };
  }
  if (subcommand === 'worktree') {
    const action = operands[0];
    if (action === 'list') return { targets: [], known: true };
    if (action !== 'add') return unknownTargets(`git worktree 동작 ${action ?? '(없음)'}`);   // remove·move·prune → 미결정
    // ⛔⭐ **피연산자를 전부 경로로 본다** — 어느 것이 경로인지 옵션 문법으로 가르려 하면
    //    `worktree add -b topic <outside>` 처럼 **플래그 값이 첫 피연산자**인 형태에서 샌다
    //    (무인 리뷰 실측). 전부 넣으면 `topic` 은 경계 안으로 풀려 무해하고 `<outside>` 만
    //    걸린다 — 값이 경로가 아닐 때 **상대명은 언제나 경계 안**이라 오거부가 안 생긴다.
    const paths = operands.slice(1).map((operand) => commandPath(operand, repository));
    if (paths.length === 0) return unknownTargets('git worktree add 경로 인자가 없음');
    return { targets: [...refTargets(gitDir, workTree, repository), ...paths], known: true };
  }
  // ⛔ `branch`·`tag` 는 **조회 모드가 더 흔하다** — `git branch --show-current` 를 막으면
  //    수용 기준(*읽기 명령은 막지 않는다*)을 어긴다(무인 리뷰 must-fix). 이 저장소의 규율
  //    자체가 *"커밋 전에 `git branch --show-current` 를 본다"* 라 막으면 규율이 죽는다.
  if (subcommand === 'branch' || subcommand === 'tag') {
    const isTag = subcommand === 'tag';
    const mutatingFlags = isTag ? TAG_MUTATING_FLAGS : BRANCH_MUTATING_FLAGS;
    const readOnlyFlags = isTag ? TAG_READ_ONLY_FLAGS : BRANCH_READ_ONLY_FLAGS;
    const flags = argv.slice(subcommandIndex + 1).filter((arg) => arg.startsWith('-'));
    const mutation: KnownCommandTargets = { targets: refTargets(gitDir, workTree, repository), known: true };
    if (flags.some((flag) => mutatingFlags.has(flag))) return mutation;          // ① 변경이 이긴다
    if (flags.some((flag) => readOnlyFlags.has(flag))) return { targets: [], known: true };  // ② 조회
    // ③ 플래그로 못 가르면 피연산자로: 없으면 목록(`git branch`), 있으면 생성(`git branch foo`).
    return operands.length === 0 ? { targets: [], known: true } : mutation;
  }
  if (!GIT_MUTATING_SUBCOMMANDS.has(subcommand)) return unknownTargets(`인식하지 못한 git 하위 명령 ${subcommand}`);
  return { targets: refTargets(gitDir, workTree, repository), known: true };
}

/** 뮤테이션이 실제로 닿는 곳 — refs 는 `--git-dir`, 파일은 `--work-tree`, 둘 다 없으면 저장소.
 *  ⛔ `--git-dir` 을 빼면 refs 쓰기가 판정에서 사라진다(must-fix 의 근본). */
function refTargets(gitDir: string | null, workTree: string | null, repository: string): string[] {
  const targets = [workTree ?? repository];
  if (gitDir) targets.push(gitDir);
  return targets;
}

function argvWriteTargets(argv: readonly string[], cwd: string, depth = 0): CommandTargets {
  const command = basename(argv[0] ?? '');
  // ⛔⭐ **출력 경로 플래그를 가장 먼저 본다**(위 OUTPUT_PATH_FLAGS 주석) — 읽기 전용 분류보다
  //    앞이라 `diff --output=/outside/x` · `find … -fprint /outside/x` 가 통과하지 않는다.
  const outputs = outputFlagTargets(command, argv, cwd);
  if (outputs === null) return unknownTargets(`출력 경로 플래그의 경로 인자가 없음 (${command || '(없음)'})`);
  // ⛔ 접두 실행기는 벗기고 뒤의 진짜 명령으로 다시 판정한다(위 COMMAND_PREFIX_RUNNERS 주석).
  //    `env A=1 touch /outside` 처럼 `VAR=값` 이 사이에 낄 수 있어 함께 건너뛴다.
  if (COMMAND_PREFIX_RUNNERS.has(command)) {
    if (depth >= MAX_SHELL_NESTING) return unknownTargets(`명령 접두 실행기 중첩 한도 ${MAX_SHELL_NESTING}`, 'other', outputs);
    let i = 1;
    while (i < argv.length && (argv[i]!.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!))) i++;
    if (i >= argv.length) return unknownTargets(`명령 접두 실행기 ${command} 뒤에 실행할 명령 토큰이 없음`, 'other', outputs);   // 실행할 명령이 없다 → 미결정
    const inner = argvWriteTargets(argv.slice(i), cwd, depth + 1);
    return inner.known
      ? { targets: [...inner.targets, ...outputs], known: true }
      : unknownTargets(inner.reason, inner.reasonKind, [...inner.targets, ...outputs], inner.decidingToken);
  }
  if (command === 'git') {
    const git = gitTargets(argv, cwd);
    return git.known
      ? { targets: [...git.targets, ...outputs], known: true }
      : unknownTargets(git.reason, git.reasonKind, [...git.targets, ...outputs], git.decidingToken);
  }
  if (command === 'find') {
    const execOption = argv.find((arg) => FIND_EXEC_OPTIONS.has(arg));
    if (execOption) return unknownTargets(`find 실행 옵션 ${execOption}`, 'other', outputs);
    return { targets: outputs, known: true };
  }
  // ⭐ 인터프리터는 payload 로 판정한다(위 SHELL_INTERPRETERS 주석). `-c` 가 없으면 미결정.
  if (SHELL_INTERPRETERS.has(command)) {
    if (depth >= MAX_SHELL_NESTING) return unknownTargets(`셸 해석기 중첩 한도 ${MAX_SHELL_NESTING}`, 'other', outputs);
    const payload = interpreterPayload(argv);   // `-c` ⊕ 묶인 `-lc`·`-xc`(위 주석)
    // `-c` 없는 형태(대화형 셸 · `bash script.sh`)는 낼 명령을 지금 볼 수 없다. 미결정으로
    // 막으면 **경계 안에서 띄우는 정상 PTY 셸까지 거부**되므로(회귀 실측), 대신 **cwd 축**으로
    // 판정한다 — 경계 안에서 도는 셸은 허용하고 밖에서 도는 셸은 거부한다. 그 셸이 뒤에 치는
    // 명령은 `pty send` 가 같은 판정기로 다시 검사한다(층이 하나 더 있다).
    if (payload === undefined) return { targets: [cwd], known: true };
    return shellWriteTargets(payload, cwd, depth + 1);
  }
  // ⭐ 런타임 인터프리터도 `-c` 없는 셸과 같은 축으로 본다(위 RUNTIME_INTERPRETERS 주석).
  //    경계 안에서 도는 검증 명령은 통과하고, 경계 밖에서 도는 것은 cwd 로 거부된다.
  if (RUNTIME_INTERPRETERS.has(command)) {
    const rest = argv.slice(1);
    const first = rest[0];
    // ⛔ 런타임 플래그 구간은 통째로 미결정이다(위 VERSION_ONLY_FLAGS 주석). 첫 토큰은
    //    서브커맨드(`test`·`run`) 또는 스크립트 경로여야 한다. 그 뒤 인자는 스크립트의 것이다.
    const versionOnly = rest.length === 1 && VERSION_ONLY_FLAGS.has(first!);
    if (!versionOnly && (!first || first.startsWith('-'))) {
      return unknownTargets(`런타임 해석기의 첫 인자 ${first ?? '(없음)'}`, 'other', outputs);
    }
    // ⭐ 피연산자를 전부 대상으로 넘긴다 — cwd 는 경계 안인데 **인자가 밖을 가리키는** 형태를
    //    cwd 축만으로는 못 잡는다. 절대경로만 보면 `node ../outside/evil.js` 를 놓치므로
    //    commandPath 로 cwd 기준 해석해 함께 검사한다(2R·6R must-fix).
    const operands = rest.filter((arg) => !arg.startsWith('-')).map((arg) => commandPath(arg, cwd));
    return { targets: [cwd, ...operands, ...outputs], known: true };
  }
  if (READ_ONLY_SHELL_COMMANDS.has(command)) return { targets: outputs, known: true };
  if (command === 'dd') {
    const targets = argv.filter((arg) => arg.startsWith('of=')).map((arg) => commandPath(arg.slice(3), cwd));
    return targets.length > 0
      ? { targets: [...targets, ...outputs], known: true }
      : unknownTargets('dd 출력 토큰 of=가 없음', 'other', outputs);
  }
  if (command === 'sed' && argv.some((arg) => arg === '-i' || arg.startsWith('-i'))) {
    // ⛔ `sed -i` 는 **피연산자를 여럿 받는다** — 마지막 하나만 보면
    //    `sed -i s/x/y/ /outside/f /boundary/f` 가 통과한다(무인 리뷰 실측).
    //    첫 피연산자는 스크립트라 빼고 **나머지 전부**를 대상으로 본다.
    const operands = argv.slice(1).filter((arg) => !arg.startsWith('-') && !arg.includes('='));
    const files = operands.slice(1).map((operand) => commandPath(operand, cwd));
    return files.length > 0
      ? { targets: [...files, ...outputs], known: true }
      : unknownTargets('sed -i 파일 토큰이 없음', 'other', outputs);
  }
  if (command === 'tee') {
    const targets = argv.slice(1).filter((arg) => !arg.startsWith('-')).map((arg) => commandPath(arg, cwd));
    return targets.length > 0
      ? { targets: [...targets, ...outputs], known: true }
      : unknownTargets('tee 출력 파일 토큰이 없음', 'other', outputs);
  }
  if (command === 'rm' || command === 'unlink') {
    // ⛔⭐ 삭제는 «쓰기»다 — 대상을 못 읽으면 경계 판정이 원리상 불가하고, 그러면 자식은
    //   자기 worktree 안의 파일도 «못 지운다». 📏 2026-09-07 실측: 리뷰가 「범위 밖 문서를
    //   지워라」를 must-fix 로 낸 런 «다섯»이 그 요구를 수행하지 못해 UNCONVERGEABLE 로 끝났다
    //   (🅢 #15890 · #15965 · #15988 ⊕ 🅕 둘). 원장에서 `rm`·`unlink` 요청이 전부
    //   `targetKnown:false` 로 거부된 것을 확인했다.
    // ⛔ 이것은 «권한을 넓히는» 변경이 아니다 — 경계 «밖» 삭제는 그대로 거부된다.
    //   달라지는 것은 사유가 「대상을 못 읽었다」에서 「경계 밖이다」로 «정확해지는» 것뿐이다.
    const rest = argv.slice(1);
    const separator = rest.indexOf('--');
    const operands = separator >= 0 ? rest.slice(separator + 1) : rest.filter((arg) => !arg.startsWith('-'));
    // ⛔ 확장되지 않은 글롭은 «경로로 확정할 수 없다» — 통과시키면 경계 밖까지 지운다.
    //   `shellSyntaxToken` 은 `$`·`~`·`{}` 를 이미 막지만 `*`·`?`·`[]` 는 «안 본다».
    const unresolved = operands.find((operand) => /[*?[\]]/.test(operand));
    if (unresolved !== undefined) {
      return unknownTargets(`${command} 인자에 확장되지 않은 글롭 ${unresolved}`, 'other', outputs);
    }
    const targets = operands.map((operand) => commandPath(operand, cwd));
    return targets.length > 0
      ? { targets: [...targets, ...outputs], known: true }
      : unknownTargets(`${command} 삭제 대상 토큰이 없음`, 'other', outputs);
  }
  return unknownTargets(`인식하지 못한 명령 ${argv[0] ?? '(없음)'}`, 'unknown-command', outputs);
}

/** A shell compound command may contain pipelines, lists, substitutions, subshells,
 * redirects, or interpreter code. Without a shell AST, its complete write set cannot
 * be proved; reject it under an explicit harness boundary rather than inspecting only
 * the first token and blessing a bypass. */
/** 셸 **문법**(합성·확장·리다이렉트)이 들어 있나. 작은따옴표 구간은 전부 리터럴이고,
 * 큰따옴표 구간에서는 실제로 확장되는 `$`·백틱만 검사한다. 인용 밖 문자는 모두 검사한다.
 * ⊕ **개행도 구분자다** — 안 넣으면 `pwd\n touch /outside` 가 첫 명령만 보고 통과한다(should-fix). */
/** ⛔⭐ 거부 문면에 토큰을 «날것으로» 박으면 «안 보이는 토큰»이 사라진다.
 *  🩸 실물(2026-09-02 · 🅣 136차): 자식이 `python3 -c "from os import remove\nremove(...)"` 를 쳤고
 *  걸린 토큰은 ***개행***이었다. 문면이 「셸 합성 문법 토큰 ⏎ 작업 디렉터리가…」가 되어 화면에서 «줄이 갈렸고»,
 *  자식은 ***무엇을 고쳐야 하는지 못 보고 같은 형태로 4번 다시 쳤다***.
 *  ⇒ 「막는다」와 「무엇이 막혔는지 말한다」는 다른 값이다. 안 보이는 문자는 «이름»으로 낸다. */
export function renderShellSyntaxToken(token: string): string {
  if (token === '\n') return '개행(\\n)';
  if (token === '\t') return '탭(\\t)';
  return token;
}

function shellSyntaxToken(command: string): string | null {
  let quote: "'" | '"' | null = null;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else if (quote === '"' && (char === '$' || char === '`')) return char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/[|;&`$\\()<>{}~\n]/.test(char)) return char;
  }
  return null;
}

/** Unquoted `&&` fragments only. Null = do not split (no unquoted `&&`, or unclosed quotes). */
function splitUnquotedAndChain(command: string): string[] | null {
  const fragments: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let sawAnd = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '&' && command[i + 1] === '&') {
      sawAnd = true;
      fragments.push(current);
      current = '';
      i++;
      continue;
    }
    current += ch;
  }
  if (quote !== null || !sawAnd) return null;
  fragments.push(current);
  return fragments;
}

/** Split only unquoted single pipes; `||` remains unsupported shell syntax. */
function splitUnquotedPipeline(command: string): string[] | null {
  const fragments: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === '\\' && quote !== "'") { current += ch; escaped = true; continue; }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === '|' && (command[i + 1] === '|' || command[i - 1] === '|')) return null;
    if (ch === '|') { fragments.push(current); current = ''; continue; }
    current += ch;
  }
  if (quote || fragments.length === 0) return null;
  fragments.push(current);
  return fragments;
}

/** Remove only whole unquoted FD duplication/discard operators; other redirects stay visible. */
function stripNonFileRedirects(command: string): string {
  let result = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < command.length;) {
    const ch = command[i]!;
    if (escaped) { result += ch; escaped = false; i++; continue; }
    if (ch === '\\' && quote !== "'") { result += ch; escaped = true; i++; continue; }
    if (quote) { result += ch; if (ch === quote) quote = null; i++; continue; }
    if (ch === "'" || ch === '"') { quote = ch; result += ch; i++; continue; }
    const match = (i === 0 || /\s/.test(command[i - 1]!))
      ? /^(?:2>&1|1>&2|>&2|2>\/dev\/null|>\/dev\/null|&>\/dev\/null)(?=$|\s)/.exec(command.slice(i))
      : null;
    if (match) { result += ' '; i += match[0].length; continue; }
    result += ch;
    i++;
  }
  return result;
}

const SHELL_COMPOUND_KEYWORDS = new Set(['for', 'while', 'until', 'if', 'case', 'select', 'function']);

/** Split unquoted semicolon and && lists at the same level. */
function splitUnquotedListChain(command: string): { fragments: string[]; operators: Array<';' | '&&'> } | null {
  const fragments: string[] = [];
  const operators: Array<';' | '&&'> = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === '\\' && quote !== "'") {
      current += ch;
      if (i + 1 < command.length) current += command[++i];
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === ';' || (ch === '&' && command[i + 1] === '&')) {
      fragments.push(current);
      operators.push(ch === ';' ? ';' : '&&');
      current = '';
      if (ch === '&') i++;
      continue;
    }
    current += ch;
  }
  if (quote || !operators.includes(';')) return null;
  fragments.push(current);
  return { fragments, operators };
}

function cdDirectory(command: string, cwd: string): string | null {
  const words = shellWords(command);
  if (words[0] !== 'cd' || words.length !== 2 || words[1] === '-' || /[*?[\]{}]/.test(words[1]!) || shellSyntaxToken(command)) return null;
  return commandPath(words[1]!, cwd);
}

function shellWriteTargets(command: string, cwd: string, depth = 0): CommandTargets {
  if (observesInlineCode(command)) return unknownTargets('런타임 해석기의 인라인 코드', 'other');
  if (SHELL_COMPOUND_KEYWORDS.has(shellWords(command.trim())[0] ?? '')) {
    return unknownTargets('셸 복합문은 쓰기 대상을 확정할 수 없음', 'shell-syntax', [], ';');
  }
  const withoutFdRedirects = stripNonFileRedirects(command);
  if (withoutFdRedirects !== command) return shellWriteTargets(withoutFdRedirects, cwd, depth);
  const listChain = splitUnquotedListChain(command);
  if (listChain) {
    // ⛔ `;` 는 앞의 `cd` 가 실패해도 뒤를 «원래 cwd» 에서 돌린다 — `cd sub; cd ..; git commit` 이 경계 밖으로 샌다.
    //   cwd 후보를 둘씩 따라가면 `cd` 스무 개에 2²⁰ 상태가 된다(무인 리뷰 · 2026-09-24). ⇒ `;` 사슬에 `cd` 가 있으면
    //   통째로 fail-closed 하고, `cd` 추적은 앞이 실패하면 뒤가 안 도는 `&&` 사슬에만 둔다.
    const fragments = listChain.fragments.map((fragment) => fragment.trim());
    if (fragments.some((fragment) => shellWords(fragment)[0] === 'cd')) {
      return unknownTargets('셸 합성 문법 토큰 ;', 'shell-syntax', [], ';');
    }
    const targets: string[] = [];
    for (const [index, trimmed] of fragments.entries()) {
      if (!trimmed) {
        if (listChain.operators[index] === '&&' || listChain.operators[index - 1] === '&&') {
          return unknownTargets('셸 합성 문법 토큰 &', 'shell-syntax', [], '&');
        }
        continue;
      }
      const parsed = shellWriteTargets(trimmed, cwd, depth);
      if (!parsed.known) return parsed;
      for (const target of parsed.targets) if (!targets.includes(target)) targets.push(target);
    }
    return { targets, known: true };
  }
  const andChain = splitUnquotedAndChain(command);
  if (andChain) {
    const targets: string[] = [];
    let currentCwd = cwd;
    for (const fragment of andChain) {
      const trimmed = fragment.trim();
      if (!trimmed) return unknownTargets('셸 합성 문법 토큰 &', 'shell-syntax', [], '&');
      const nextCwd = cdDirectory(trimmed, currentCwd);
      if (nextCwd) { currentCwd = nextCwd; continue; }
      if (shellWords(trimmed)[0] === 'cd' && !shellSyntaxToken(trimmed)) {
        return unknownTargets('cd 경로 인자가 확정되지 않음');
      }
      const parsed = shellWriteTargets(trimmed, currentCwd, depth);
      if (!parsed.known) return parsed;
      targets.push(...parsed.targets);
    }
    return { targets, known: true };
  }
  if (command.includes('&&')) return unknownTargets('셸 합성 문법 토큰 &', 'shell-syntax', [], '&');
  const pipeline = splitUnquotedPipeline(command);
  if (pipeline) {
    const targets: string[] = [];
    for (const fragment of pipeline) {
      if (!fragment.trim()) return unknownTargets('셸 합성 문법 토큰 |', 'shell-syntax', [], '|');
      // A shell reading a pipe executes opaque stdin; unlike an interactive PTY it is not cwd-only.
      const words = shellWords(fragment.trim());
      if (SHELL_INTERPRETERS.has(words[0] ?? '') && interpreterPayload(words) === undefined) {
        return unknownTargets('파이프 입력을 실행하는 셸 해석기', 'other');
      }
      const parsed = shellWriteTargets(fragment.trim(), cwd, depth);
      if (!parsed.known) return parsed;
      targets.push(...parsed.targets);
    }
    return { targets, known: true };
  }
  if (command.trim() === 'cd') return { targets: [], known: true };
  if (cdDirectory(command.trim(), cwd)) return { targets: [], known: true };
  // A literal single file redirect retains its existing target classification.
  const simpleRedirect = command.match(/^\s*(.*?)\s*(?:\d*)>{1,2}\s*([^\s;&|]+)\s*$/);
  if (simpleRedirect) {
    const target = simpleRedirect[2]!.replace(/^['"]|['"]$/g, '');
    const targetToken = shellSyntaxToken(target);
    if (targetToken) return unknownTargets(`셸 합성 문법 토큰 ${renderShellSyntaxToken(targetToken)}`, 'shell-syntax', [], targetToken);
    const redirectTarget = commandPath(target, cwd);
    const prefix = simpleRedirect[1]!.trim();
    const prefixToken = shellSyntaxToken(prefix);
    if (prefixToken) return unknownTargets(`셸 합성 문법 토큰 ${renderShellSyntaxToken(prefixToken)}`, 'shell-syntax', [redirectTarget], prefixToken);
    const words = prefix.split(/\s+/);
    const parsed = argvWriteTargets(words, cwd, depth);
    return parsed.known
      ? { targets: [...parsed.targets, redirectTarget], known: true }
      : unknownTargets(parsed.reason, parsed.reasonKind, [...parsed.targets, redirectTarget], parsed.decidingToken);
  }
  const syntaxToken = shellSyntaxToken(command);
  if (syntaxToken) return unknownTargets(`셸 합성 문법 토큰 ${renderShellSyntaxToken(syntaxToken)}`, 'shell-syntax', [], syntaxToken);
  const words = command.trim().match(/(?:[^\s'\"]+|'[^']*'|"[^"]*")+/g) ?? [];
  const parsed = argvWriteTargets(words.map((word) => word.replace(/^['"]|['"]$/g, '')), cwd, depth);
  return !parsed.known && !parsed.reason
    ? { ...parsed, reason: `인식하지 못한 명령 ${words[0] ?? '(없음)'}` }
    : parsed;
}

/** Classifies a command's write targets without applying the harness boundary. */
export function inspectHarnessCommandWriteTargets(
  command: readonly string[] | string,
  cwd: string,
): HarnessCommandWriteTargets {
  // dispatchBash (src/skills/tools/index.ts) calls harnessCommandWriteReject,
  // which reaches this entrypoint; string commands (including `;` lists) use shellWriteTargets.
  return typeof command === 'string' ? shellWriteTargets(command, cwd) : argvWriteTargets(command, cwd);
}

/** Common canonical preflight for Bash, RunShell, PTY start, and structured git.
 * It permits recognised read-only operations and validates recognised mutations;
 * opaque shell programs fail closed only when an explicit harness boundary exists. */
export function harnessCommandWriteReject(
  command: readonly string[] | string,
  cwd: string,
  via: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const space = getHarnessSpace(env);
  if (!space) return null;
  const boundary = resolveHarnessBoundary(env, cwd);
  if (!boundary) return null;
  const parsed = inspectHarnessCommandWriteTargets(command, cwd);
  for (const target of parsed.targets) {
    const reject = harnessMainTreeReject(target, env, cwd, via);
    if (reject) return reject;
  }
  if (!parsed.known) {
    return rejectUnknownShellWrite(command, cwd, boundary, via, parsed, env);
  }
  return null;
}
