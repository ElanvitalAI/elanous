// 하니스 공간 자기인지 장치 (Docker식 컨테이너 자기인지 차용 · 2026-07-21 · 대표 co-design)
//
// 대표 지시: "특정 ENV 변수로 elanous 이 스스로 self-dev-harness 격리 공간 안에 있음을 인지하게 하고,
// 그 위에 관측·프리앰블·병렬 좌표 등 여러 판단을 쌓는다." Docker 가 컨테이너에게 `container=docker`(+
// `/.dockerenv`)·`HOSTNAME`(id)으로 "너는 격리됐다"를 알리는 방식을 차용한다.
//
//   Docker                         self-dev-harness (이 장치)
//   ─────────────────────────────  ──────────────────────────────────────────────
//   container=docker / .dockerenv  ELANOUS_HARNESS_SPACE=<kind>   (존재 = 격리 공간 안)
//   HOSTNAME / container id        ELANOUS_HARNESS_SPACE_ID=<branch|runId>
//   volume mount                   git worktree (격리 FS)
//   stdin/stdout·exec              detached-hitl 라인 프로토콜(부모↔자식·이미 존재)
//   docker logs <id>               공간별 관측 태깅(surface=harness:<kind>)
//
// ⚠️ `ELANOUS_HARNESS_DETACHED=1`(재귀 위임 가드)와 **직교** — 그건 "subprocess 로 재위임 말 것" 신호이고,
//    이 SPACE 는 "나는 격리 하니스 공간의 elanous 다"라는 **정체성/자기인지**. 둘은 함께 쓰일 수 있다.
//
// 자기인지 헬퍼 getHarnessSpace() 하나 위에 (a) 관측 자동 태깅 (b) 자기인지 프리앰블 (c) 병렬 공간 좌표를
// 쌓는다. 이 파일이 그 단일 진실원(SSOT).
//
// ⭐ run-identity (K · 2026-07-25 · PLAN-self-observation §K/K-5): spaceId 는 per-child(잡별 격리 공간)지만
//    runId 는 per-RUN — 한 orchestrate 인보크(fan-out 부모)가 1개, N 자식이 공유한다. runId 를 SPACE 와 같은
//    env 채널(ELANOUS_RUN_ID)로 자식에 전파해, 나중에 runId≡spaceId≡ptyId≡sessionId 를 join(pty_manifest 스탬프·
//    K3)할 anchor 로 쓴다. 불변식: **최외곽 coordinator 만 mint(ensureRunId), 자식은 env 상속(재mint 금지)** —
//    spaceId 선례와 동형. 계약 = [[DESIGN-executor-pty-ref-contract-2026-07-25]] ExecutorPtyRef.runId.

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { ensureHostId } from '../platform/host-id.js';

/** 하니스 공간 종류 — 어떤 자율 실행이 이 격리 공간을 열었나. */
export type HarnessSpaceKind = 'self-implement' | 'dev-harness' | 'solve-mission' | 'dev-hold';

/** ENV 마커 이름(계약·2026-07-21 대표 확정). 값 있으면 그 공간 안. */
export const HARNESS_SPACE_ENV = 'ELANOUS_HARNESS_SPACE';
export const HARNESS_SPACE_ID_ENV = 'ELANOUS_HARNESS_SPACE_ID';
/** ⭐ per-run join anchor(K·2026-07-25). 값 있으면 그 run 소속. 최외곽만 mint·자식 상속. */
export const HARNESS_RUN_ID_ENV = 'ELANOUS_RUN_ID';

/** ⭐ 역할 마커(2026-07-21 대표 co-design·"세포 분화") — 한 elanous 바이너리(세포)가 env 에 따라
 *  조율자/실행자로 분화. Docker 컨테이너가 자기 격리를 인지하듯, 하니스 세포는 자기 역할을 인지한다. */
export const HARNESS_ROLE_ENV = 'ELANOUS_HARNESS_ROLE';

/** ⭐ 명시 쓰기 경계 마커(2026-07-25·#4 격리 누출 봉쇄·내부 문서 §2a).
 *  스포너(worktree 를 직접 만든 쪽)가 자식에 **격리 worktree 절대경로**를 실어, 자식이 부팅 시 쓰기 경계를
 *  **결정론적으로** 활성화하게 한다. cwd 자동추론(worktree vs 정본 vs shadow-standalone 은 git 시그니처가
 *  동일해 모호)의 한계를 제거 — 스포너는 자기가 만든 worktree 를 확실히 안다. Docker `--read-only`+`--tmpfs`
 *  로 쓰기 가능 영역을 명시 지정하는 것과 동형. */
export const HARNESS_BOUNDARY_ENV = 'ELANOUS_HARNESS_BOUNDARY';
/** 부모가 자식의 경계 거부 요청을 받는 append-only mailbox 경로. */
export const HARNESS_BOUNDARY_REQUESTS_ENV = 'ELANOUS_HARNESS_BOUNDARY_REQUESTS';
/** 부모가 자식의 경계 거부 요청에 회신을 남기는 mailbox 경로. */
export const HARNESS_BOUNDARY_RESPONSES_ENV = 'ELANOUS_HARNESS_BOUNDARY_RESPONSES';

/** 부모 소유 임시 mailbox 경로를 자식에게 전달한다. 빈 식별자 또는 디렉터리 생성 실패는 fail-open으로 생략한다. */
export function harnessBoundaryRequestsEnv(executionId: string): Record<string, string> {
  const id = (executionId || '').trim();
  if (!id) return {};
  try {
    const parent = resolve(tmpdir(), 'elanous-harness-boundary-requests');
    const filename = `${createHash('sha256').update(id).digest('hex')}.jsonl`;
    const path = resolve(parent, filename);
    const pathFromParent = relative(parent, path);
    if (!pathFromParent || pathFromParent.startsWith('..') || isAbsolute(pathFromParent)) return {};
    mkdirSync(parent, { recursive: true });
    return { [HARNESS_BOUNDARY_REQUESTS_ENV]: path };
  } catch {
    return {};
  }
}

/** 부모 소유 임시 회신 mailbox 경로를 자식에게 전달한다. 파일은 만들지 않는다. */
export function harnessBoundaryResponsesEnv(executionId: string): Record<string, string> {
  const id = (executionId || '').trim();
  if (!id) return {};
  try {
    const parent = resolve(tmpdir(), 'elanous-harness-boundary-requests');
    const filename = `${createHash('sha256').update(id).digest('hex')}.responses.jsonl`;
    const path = resolve(parent, filename);
    const pathFromParent = relative(parent, path);
    if (!pathFromParent || pathFromParent.startsWith('..') || isAbsolute(pathFromParent)) return {};
    mkdirSync(parent, { recursive: true });
    return { [HARNESS_BOUNDARY_RESPONSES_ENV]: path };
  } catch {
    return {};
  }
}

/** 자식(executor)에 실을 명시 경계 env. 스포너가 worktree 경로로 호출. ★ resolve()로 **절대경로 정규화**
 *  (리뷰 should-fix) — 상대 cwd 가 들어오면 자식측 isAbsolute 검증에서 조용히 무시돼 보호가 fail-open 되므로,
 *  마커 계약(절대경로)을 여기서 못박는다. 빈 값이면 미포함. */
export function harnessBoundaryEnv(worktreeAbsPath: string): Record<string, string> {
  const p = (worktreeAbsPath || '').trim();
  return p ? { [HARNESS_BOUNDARY_ENV]: resolve(p) } : {};
}

/** 현 프로세스에 실린 명시 쓰기 경계 절대경로(스포너가 심음). 없으면 ''. 순수 reader. */
export function getHarnessBoundaryPath(env: NodeJS.ProcessEnv = process.env): string {
  return env[HARNESS_BOUNDARY_ENV]?.trim() ?? '';
}

/** TENANT-BOUNDARY (0.2.41): 경계 회신 mailbox(HARNESS_BOUNDARY_RESPONSES_ENV)에 payload 한 줄(JSONL)을
 *  남긴다 — 익명 내보내기 전용 출구. env 가 비거나 절대경로가 아니면 fail-open(빈 문자열 반환, 파일 안 만듦). */
export function appendBoundaryResponseLine(env: NodeJS.ProcessEnv, payload: object): string {
  const path = env[HARNESS_BOUNDARY_RESPONSES_ENV]?.trim() ?? '';
  if (!path || !isAbsolute(path)) return '';
  try {
    mkdirSync(resolve(path, '..'), { recursive: true });
    appendFileSync(path, `${JSON.stringify(payload)}\n`);
    return path;
  } catch {
    return '';
  }
}

/** 전 공간 종류(SSOT) — logs `--space` 필터·검증 등이 공유. */
export const HARNESS_SPACE_KINDS: readonly HarnessSpaceKind[] = ['self-implement', 'dev-harness', 'solve-mission', 'dev-hold'];

const VALID_KINDS: ReadonlySet<string> = new Set(HARNESS_SPACE_KINDS);

export interface HarnessSpace {
  /** 항상 true — getHarnessSpace() 가 null 이 아니면 격리 공간 안. */
  inHarness: true;
  /** 공간 종류. 알 수 없는 값이면 'dev-harness' 로 폴백(존재=inHarness 는 유지). */
  kind: HarnessSpaceKind;
  /** 공간 고유 id(per-child·branch/worktree slug). 관측 태깅·병렬 좌표. 없으면 ''. */
  id: string;
  /** ⭐ per-run join anchor(K). 이 자식이 속한 run(fan-out 부모 1개·N 자식 공유). 없으면 ''. */
  runId: string;
}

export function describeHarnessSpace(space: HarnessSpace | null): string {
  return space ? `${space.kind}:${space.id}` : 'no-harness';
}

/**
 * 현 프로세스가 self-dev-harness 격리 공간 안인지 자기인지한다. ENV 마커 없으면 null(운영/일반 프로세스).
 * 순수 함수 — env 만 읽고 부작용 없음. fail-safe(파싱 실패=null).
 */
export function getHarnessSpace(env: NodeJS.ProcessEnv = process.env): HarnessSpace | null {
  const raw = env[HARNESS_SPACE_ENV]?.trim();
  if (!raw) return null;
  const kind: HarnessSpaceKind = VALID_KINDS.has(raw) ? (raw as HarnessSpaceKind) : 'dev-harness';
  const id = env[HARNESS_SPACE_ID_ENV]?.trim() ?? '';
  return { inHarness: true, kind, id, runId: getHarnessRunId(env) };
}

/** 간편 판정 — 격리 하니스 공간 안인가. */
export function isInHarnessSpace(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env[HARNESS_SPACE_ENV]?.trim();
}

/** 하니스 세포 역할(2026-07-21 대표 co-design·"한 세포가 env 에 따라 조율자/실행자로 분화").
 *  - coordinator(조율자): executor 들을 스폰·조율·관측·이력 소유(orchestrate 프로세스).
 *  - executor(실행자): 격리 공간 안에서 실제 goal-loop 구현(self implement 자식). */
export type HarnessRole = 'coordinator' | 'executor';

/**
 * ⭐ 역할 자기인지 — Docker 컨테이너가 자기 격리를 인지하듯, 하니스 세포는 자기 역할을 인지한다.
 * 우선순위: 명시 env(ELANOUS_HARNESS_ROLE) → 폴백(격리 공간 안이면 executor·밖이면 null=standalone).
 * 이 위에 (a) coordinator 는 중앙 관측/이력/조율 책임 (b) executor 는 관측 emit 책임을 분기한다. 순수.
 */
export function getHarnessRole(env: NodeJS.ProcessEnv = process.env): HarnessRole | null {
  const explicit = env[HARNESS_ROLE_ENV]?.trim();
  if (explicit === 'coordinator' || explicit === 'executor') return explicit;
  return getHarnessSpace(env)?.kind === 'dev-hold' ? null : isInHarnessSpace(env) ? 'executor' : null;
}

/** 자식(executor)에 실을 role env. 조율자가 자식 스폰 시 space env 와 함께 주입. */
export function executorRoleEnv(): Record<string, string> {
  return { [HARNESS_ROLE_ENV]: 'executor' };
}

/**
 * 자식(격리 공간)을 스폰할 때 실을 ENV 마커를 만든다. 스포너가 `{ ...process.env, ...harnessSpaceEnv(kind, id) }`
 * 로 자식에 전파 → 자식이 getHarnessSpace() 로 자기인지. id 는 정규화(로그/브랜치 안전 문자만·64자).
 *
 * ⭐ runId(K·per-run join anchor): 넘기면 ELANOUS_RUN_ID 로 명시 stamp(계약 가시화). 생략해도 스포너가 이미
 *    `...process.env` 를 spread 하므로 coordinator 가 ensureRunId 로 심어둔 runId 는 자동 상속된다(둘 다 안전).
 */
export function harnessSpaceEnv(kind: HarnessSpaceKind, id: string, runId?: string): Record<string, string> {
  const out: Record<string, string> = {
    [HARNESS_SPACE_ENV]: kind,
    [HARNESS_SPACE_ID_ENV]: normalizeSpaceId(id),
  };
  const rid = normalizeRunId(runId ?? '');
  if (rid) out[HARNESS_RUN_ID_ENV] = rid;
  return out;
}

/** 공간 id 정규화 — 관측 surface/instance·로그 안전(영숫자/하이픈/슬래시/콜론만·앞뒤 정리·64자). */
export function normalizeSpaceId(id: string): string {
  return (id || '').trim().replace(/[^A-Za-z0-9/_:.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/^-+|-+$/g, '');
}

/**
 * run id 정규화 — spaceId 보다 **엄격**(경로/구분자 안전). runId 는 run-store `<runId>.json` 파일명·
 * pty_manifest 키로 쓰이므로 `/`·`:`·`.`(경로 traversal `..`) 불허 → `[A-Za-z0-9_-]` 만·앞뒤 정리·64자.
 * mintRunId(`run-<uuid>`)·self-dev `run-<ts>-<rand>` 는 이미 안전문자라 무영향(사용자 --resume 원문만 방어).
 */
export function normalizeRunId(id: string): string {
  return (id || '').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

/**
 * ⭐ coordinator per-run runId 결정(순수·테스트가능·[[PLAN §K]] MF2/MF3). 우선순위: **resume > 상속 env >
 * 신규 mint(canonical)**. 항상 정규화 → 로컬(run-store)·전파 env·PTY 가 같은 id. self orchestrate 가 소비.
 */
export function pickRunId(resume: string | undefined, envRunId: string): string {
  return normalizeRunId(resume || envRunId || mintRunId());
}

/**
 * ⭐ per-call(detached/frontdoor) runId(순수·[[PLAN §K]] MF1/MF4). 상속 있으면 채택(nested), 없으면 fresh
 * mint. **process.env 를 변경하지 않는다** — 장수 프로세스(데몬)가 반복 dispatch 해도 독립 run 마다 다른 runId
 * (identity bleed 방지). 자식엔 harnessSpaceEnv(kind,id,runId) 로만 전파.
 */
export function perCallRunId(env: NodeJS.ProcessEnv = process.env): string {
  return getHarnessRunId(env) || mintRunId();
}

/**
 * ⭐ canonical per-run id 생성(K). uuid 기반 — slug 파생 아님(harness `slug(objective)` 슬러그충돌 회피).
 * 순수 함수. run 진입점에서 직접 부르지 말고 ensureRunId() 로 mint-once 하라(중복 mint 방지).
 */
export function mintRunId(): string {
  return normalizeRunId(`run-${randomUUID()}`);
}

/** runId 해석 출처 — 관측 필드. 명시값이 우연히 환경값과 같아도 'explicit' 이다. */
export type RunIdSource = 'explicit' | 'inherited' | 'minted';

// 출처는 이 프로세스가 run id를 정한 순간에만 확정된다. env로 전파하면 자식이 부모의
// minted 출처를 자신의 것으로 오인하므로 프로세스 로컬에만 남긴다. 테스트와 dispatch는 한
// 프로세스에서 여러 env 객체를 쓸 수 있으므로, 기록도 env 객체별로 분리한다.
type RunIdentity = { runId: string; source: RunIdSource };
const runIdentityByEnv = new WeakMap<NodeJS.ProcessEnv, RunIdentity>();

/** DB·lifecycle 경계의 신뢰할 수 없는 값은 폐쇄된 run-id 출처 어휘로 정규화한다. */
export function normalizeRunIdSource(value: unknown): RunIdSource | '' {
  return value === 'explicit' || value === 'inherited' || value === 'minted' ? value : '';
}

/**
 * 현재 env의 run id 출처. ensureRunIdentity가 이 env와 현재 run id에 남긴 기록만 반환한다.
 * 기록이 없거나 현재 run id와 불일치하면 ''이며, 이는 run 부재가 아니라 출처 미상이다.
 */
export function getHarnessRunIdSource(env: NodeJS.ProcessEnv = process.env): RunIdSource | '' {
  const runId = getHarnessRunId(env);
  if (!runId) return '';
  const recorded = runIdentityByEnv.get(env);
  return recorded?.runId === runId ? recorded.source : '';
}

/**
 * ⭐ runId 단일 resolver (2026-07-26 · 리뷰 should-fix) — 우선순위와 정규화를 **한 곳**에 둔다.
 *
 * 종전엔 같은 로직이 4곳(orchestrator·PTY driver 2지점·non-PTY spawnSync 폴백)에 흩어져 있어
 * 우선순위 연산자(`??` vs `||`)와 정규화 유무가 사이트마다 어긋났다 — 실제로 `??` 사이트가 명시적
 * `''` 를 채택해 "항상 non-empty" 계약을 깨뜨렸다. 이 함수가 그 축의 SSOT다.
 *
 * 계약: **명시 > 상속(공간/env) > canonical mint** · 모든 입력을 `normalizeRunId` 통과(공백·불안전
 * 문자·경로 traversal 제거 후 빈 값이면 다음 순위로) · **반환 runId 는 항상 non-empty·안전문자**.
 * env 를 변경하지 않는다(장수 데몬의 dispatch 간 identity bleed 방지 — `perCallRunId` 와 동일 규율).
 */
export function resolveRunIdentity(opts: {
  /** 호출자가 소유한 runId(예: runSelfImplement 가 확정한 값). */
  explicit?: string;
  /** 공간/부모에서 물려받은 runId(예: getHarnessSpace().runId). 미지정 시 env 에서 읽는다. */
  inherited?: string;
  env?: NodeJS.ProcessEnv;
} = {}): { runId: string; source: RunIdSource } {
  const explicit = normalizeRunId(opts.explicit ?? '');
  if (explicit) return { runId: explicit, source: 'explicit' };
  // 상속값도 정규화한다 — 상류(getHarnessRunId)가 이미 정규화하지만, 공간 객체가 다른 경로로
  //   합성될 수 있어 여기서 다시 좁힌다(방어적·이 함수만 보면 계약이 자족적).
  const inherited = normalizeRunId(opts.inherited ?? '') || getHarnessRunId(opts.env ?? process.env);
  if (inherited) return { runId: inherited, source: 'inherited' };
  return { runId: mintRunId(), source: 'minted' };
}

/** 현 프로세스가 속한 run id 읽기(env 상속). 없으면 ''. 순수 reader — K3 스탬프·getHarnessSpace 가 소비. */
export function getHarnessRunId(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeRunId(env[HARNESS_RUN_ID_ENV]?.trim() ?? '');
}

/**
 * ⭐ mint-once-at-outermost(K 불변식·spaceId 선례와 동형). env 에 ELANOUS_RUN_ID 있으면 그대로 상속(재mint 금지),
 * 없으면 mint 후 env 에 set 하고 반환한다. **coordinator(orchestrate·self implement·dispatch)가 자식 스폰 前
 * 1회 호출** → 이후 모든 `...process.env` spread 가 같은 runId 를 자식에 전파(fan-out N 자식이 runId 공유).
 * 부작용(env set)은 의도적 — 여러 자식에 걸쳐 동일 runId 를 보장하는 유일한 방법.
 */
export function ensureRunIdentity(env: NodeJS.ProcessEnv = process.env): { runId: string; source: RunIdSource } {
  ensureHostId(env);
  const existing = getHarnessRunId(env);
  if (existing) {
    // ★ normalize-on-write — 상속값이 외부에서 비정규 원문으로 심겼을 수 있다. 정규화값을 env 에 되써서
    //   전파되는 원문 == 관측/스탬프값(getHarnessRunId·pty_manifest)을 일치시킨다(부모/자식 관측 ID 동일).
    if (env[HARNESS_RUN_ID_ENV] !== existing) env[HARNESS_RUN_ID_ENV] = existing;
    // 반환 계약은 호출 시점의 env를 그대로 읽어 inherited다. 다만 PTY reader용 최초 provenance가
    // 같은 env/run id에 이미 있으면 덮지 않는다(방금 minted한 프로세스의 기록 보존).
    const identity: RunIdentity = { runId: existing, source: 'inherited' };
    const recorded = runIdentityByEnv.get(env);
    if (recorded?.runId !== existing) runIdentityByEnv.set(env, identity);
    return identity;
  }
  const identity: RunIdentity = { runId: mintRunId(), source: 'minted' };
  env[HARNESS_RUN_ID_ENV] = identity.runId;
  runIdentityByEnv.set(env, identity);
  return identity;
}

/** 기존 문자열 전용 호출자 호환용 껍데기. 출처가 필요한 최외곽 진입점은 ensureRunIdentity를 쓴다. */
export function ensureRunId(env: NodeJS.ProcessEnv = process.env): string {
  return ensureRunIdentity(env).runId;
}

/** 관측 surface 라벨 — 공간 종류를 `harness:<kind>` 로(로그 surface 필터에서 하니스 공간 로그 격리 조회). */
export function harnessSpaceSurface(space: HarnessSpace): string {
  return `harness:${space.kind}`;
}
