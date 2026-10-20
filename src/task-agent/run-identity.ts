/**
 * RUN-IDENTITY-TAGS(칸 0.2.32 · P0) — 런 신분 묶음 정본(RFC adaptive-graph-ops §9.9).
 *
 * - 닫힌 목록 신분 묶음 `RunIdentity`: GATE-PRIORITY 의 «run priority» 를 `class` 로
 *   흡수한다(승인·선점이 `RUN_IDENTITY_QUEUE_PRIORITY` 로 이 문을 읽는다 — 나머지
 *   디스패처 배선은 RUN-IDENTITY-ADMIT).
 * - parse/validate: 목록 밖 값은 거부한다(조용히 다듬지 않는다).
 * - 출생 신분 자동(`deriveBirthIdentity`): 칸 우선순위(P0 = critical·special·protect ·
 *   P1 = normal · 그 외 normal)·대표 표시에서 단다. 권한(rights)은 명시 `--tag rights=…`만 기록한다
 *   (RUN-IDENTITY-RIGHTS — 체크리스트에는 권한 근거가 없으므로 출생값으로 추정하지 않는다).
 * - 태그 덮기(`applyRunIdentityTags`): `tasks hand --tag k=v`(반복) 이 출생 신분을 덮는다.
 * - ⛔ 모르는 칸을 기본값으로 확정하지 않는다: 칸 조회가 실패하면 명시 태그만 담고 나머지는 «미기록».
 * - 태그 바꾸기 감사(`runTagChange` — task-hand.ts): 카드 history 에 `run-tag-change`
 *   {from, to, by, reason} 을 남긴다.
 */

/** 신분 계급 — GATE-PRIORITY «run priority» 흡수: 게이트|착지|비상|보통|유휴. */
export const RUN_IDENTITY_CLASSES = ['gate', 'landing', 'critical', 'normal', 'idle'] as const;
export type RunIdentityClass = (typeof RUN_IDENTITY_CLASSES)[number];
/** 돌봄: 표준|특별|집중돌봄. */
export const RUN_IDENTITY_CARES = ['standard', 'special', 'icu'] as const;
export type RunIdentityCare = (typeof RUN_IDENTITY_CARES)[number];
/** 권한 크기: 보통|중간|큰. */
export const RUN_IDENTITY_RIGHTS = ['s', 'm', 'l'] as const;
export type RunIdentityRights = (typeof RUN_IDENTITY_RIGHTS)[number];
/** 출생 자리: 디스패처|손|대기열|의사. */
export const RUN_IDENTITY_LAUNCHERS = ['dispatcher', 'hand', 'queue', 'doctor'] as const;
export type RunIdentityLauncher = (typeof RUN_IDENTITY_LAUNCHERS)[number];

/** 출생 기록 — 칸마다 optional: 없는 칸은 «미기록»(모른다)이다. 출생 자리를 모르면 `launcher` 를 비운다(지어내지 않는다). */
export interface RunIdentityOrigin {
  checklistId?: string;
  version?: string;
  seat?: string;
  launcher?: RunIdentityLauncher;
}

/**
 * 런 신분 묶음 — 카드 상태 파일(원장 정본)에 실린다(`TaskCard.identity`).
 * ⛔ 모르는 칸을 기본값으로 확정하지 않는다 — 칸마다 optional 이고 없는 칸은 «미기록»이다.
 * 확인된 칸만 담는다: 명시 태그(`--tag k=v`) ⊕ 조회에 성공한 칸에서 단 출생값(`deriveBirthIdentity`).
 * 승인·선점이 `class` 를 못 찾으면 normal 로 «읽을» 뿐(`runPriorityClass`) 원장엔 적지 않는다.
 */
export interface RunIdentity {
  class?: RunIdentityClass;
  care?: RunIdentityCare;
  rights?: RunIdentityRights;
  protect?: boolean;
  origin: RunIdentityOrigin;
}

/** 화면·감사 줄의 «미기록» 표기 — 원장에 없는 칸(모른다). */
export const RUN_IDENTITY_UNRECORDED = '미기록';

/** 신분 칸 하나를 글로 — 없으면 «미기록»(기본값으로 채우지 않는다). */
export function runIdentityFieldText(identity: RunIdentity | undefined, key: RunTagKey): string {
  const value = identity?.[key];
  return value === undefined ? RUN_IDENTITY_UNRECORDED : String(value);
}

/** `--tag k=v` 칸(닫힌 목록) — 신분의 어느 칸을 바꾸는지. */
export const RUN_TAG_KEYS = ['class', 'care', 'rights', 'protect'] as const;
export type RunTagKey = (typeof RUN_TAG_KEYS)[number];
export type RunIdentityTag =
  | { key: 'class'; value: RunIdentityClass }
  | { key: 'care'; value: RunIdentityCare }
  | { key: 'rights'; value: RunIdentityRights }
  | { key: 'protect'; value: boolean };

/** 칸(체크리스트 셀) — 출생 신분이 단다: 우선순위·대표 표시(제목)·칸보드 판. */
export interface RunIdentityCell {
  title?: string;
  priority?: string;
  version?: string;
}

export function parseRunIdentityClass(value: string): RunIdentityClass {
  if (!RUN_IDENTITY_CLASSES.includes(value as RunIdentityClass)) throw new Error(`run identity class 는 ${RUN_IDENTITY_CLASSES.join('|')} 중 하나다: ${JSON.stringify(value)}`);
  return value as RunIdentityClass;
}

export function parseRunIdentityCare(value: string): RunIdentityCare {
  if (!RUN_IDENTITY_CARES.includes(value as RunIdentityCare)) throw new Error(`run identity care 는 ${RUN_IDENTITY_CARES.join('|')} 중 하나다: ${JSON.stringify(value)}`);
  return value as RunIdentityCare;
}

export function parseRunIdentityRights(value: string): RunIdentityRights {
  if (!RUN_IDENTITY_RIGHTS.includes(value as RunIdentityRights)) throw new Error(`run identity rights 는 ${RUN_IDENTITY_RIGHTS.join('|')} 중 하나다: ${JSON.stringify(value)}`);
  return value as RunIdentityRights;
}

export function parseRunIdentityProtect(value: string): boolean {
  if (value !== 'true' && value !== 'false') throw new Error(`run identity protect 는 true|false 다: ${JSON.stringify(value)}`);
  return value === 'true';
}

/** `k=v` 한 줄을 신분 태그로 — 모르는 칸·목록 밖 값은 거부한다. */
export function parseRunIdentityTag(tag: string): RunIdentityTag {
  const eq = tag.indexOf('=');
  const key = eq < 0 ? '' : tag.slice(0, eq);
  const value = eq < 0 ? '' : tag.slice(eq + 1);
  if (!RUN_TAG_KEYS.includes(key as RunTagKey)) throw new Error(`run identity 태그 칸은 ${RUN_TAG_KEYS.join('|')} 중 하나다: ${JSON.stringify(tag)}`);
  switch (key) {
    case 'class': return { key: 'class', value: parseRunIdentityClass(value) };
    case 'care': return { key: 'care', value: parseRunIdentityCare(value) };
    case 'rights': return { key: 'rights', value: parseRunIdentityRights(value) };
    default: return { key: 'protect', value: parseRunIdentityProtect(value) };
  }
}

/** 이미 검증한 태그 하나를 신분에 얹는다(검증은 `parseRunIdentityTag` 몫). */
export function applyRunIdentityTag(identity: RunIdentity, tag: RunIdentityTag): RunIdentity {
  switch (tag.key) {
    case 'class': return { ...identity, class: tag.value };
    case 'care': return { ...identity, care: tag.value };
    case 'rights': return { ...identity, rights: tag.value };
    default: return { ...identity, protect: tag.value };
  }
}

/** `--tag k=v`(반복) 이 출생 신분을 덮는다 — 순서대로 얹는다. */
export function applyRunIdentityTags(identity: RunIdentity, tags: readonly string[]): RunIdentity {
  let next = identity;
  for (const tag of tags) next = applyRunIdentityTag(next, parseRunIdentityTag(tag));
  return next;
}

/** 대표 표시(왕관) — 이스케이프로 적어 이 줄이 누출 검사(ceo-mark)에 걸리지 않게 한다. */
const CROWN_MARK = '\u{1F451}';

/**
 * 출생 신분 자동 — «조회에 성공한» 칸의 우선순위(P0 = critical·special·protect · P1 = normal · 그 외 normal)·대표 표시에서 단다.
 * 권한(rights)은 추정하지 않는다(RUN-IDENTITY-RIGHTS): 체크리스트 출생 정보에는 권한 근거가 없으므로
 * `--tag rights=…` 명시 태그로만 기록하고, 태그가 없으면 «미기록».
 * ⛔ 칸을 못 읽었으면 부르지 않는다 — 그때는 `{ origin }` 에 명시 태그만 얹는다(나머지 «미기록»).
 * ⛔ 읽은 칸이라도 `priority`·`title` 이 비면 그 값에서 파생되는 칸을 확정하지 않는다(«미기록»):
 *   class 는 priority 가 있어야 · care·protect 는 P0 이거나 대표 가 보이면 올리고, «안 올림»(standard·false)은
 *   priority 와 title 이 둘 다 있을 때만 확정한다.
 */
export function deriveBirthIdentity(cell: RunIdentityCell, origin: RunIdentityOrigin): RunIdentity {
  const priority = cell.priority?.trim() ? cell.priority.trim() : undefined;
  const title = cell.title?.trim() ? cell.title : undefined;
  const critical = priority === 'P0';
  const crown = title?.includes(CROWN_MARK) === true;
  const raised = critical || crown;
  const careKnown = raised || (priority !== undefined && title !== undefined);
  return {
    ...(priority !== undefined ? { class: critical ? 'critical' as const : 'normal' as const } : {}),
    ...(careKnown ? { care: raised ? 'special' as const : 'standard' as const, protect: raised } : {}),
    origin,
  };
}

/** GATE-PRIORITY «run priority» 흡수 — 신분 `class` 가 런 우선순위다(승인·선점이 읽는다 · 없거나 «미기록»이면 normal 로 «읽는다» — 원장엔 적지 않는다). */
export function runPriorityClass(identity?: Pick<RunIdentity, 'class'> | null): RunIdentityClass {
  return identity?.class ?? 'normal';
}

/**
 * 승인·선점 가늠자 — 신분 `class` 를 대기열 줄 우선순위로 옮긴다(RUN-IDENTITY-ADMIT 첫 배선).
 * 게이트 > 착지 > 비상 순, 셋 다 칸 러브릭·CEO 보너스(`harness-queue.ts` ≈ 125.5 이하)보다
 * 위에 줄 선다 — `tasks hand` 발사 인자가 이 값을 싣고 승인·선점이 읽는다.
 * 보통·유휴는 칸 러브릭을 그대로 쓴다(값 없음).
 */
export const RUN_IDENTITY_QUEUE_PRIORITY: Record<RunIdentityClass, number | undefined> = { gate: 200, landing: 175, critical: 150, normal: undefined, idle: undefined };

/** 신분의 대기열 줄 우선순위 — 보통·유휴는 칸 러브릭으로 흐른다(값 없음). */
export function runIdentityQueuePriority(identity?: Pick<RunIdentity, 'class'> | null): number | undefined {
  return RUN_IDENTITY_QUEUE_PRIORITY[runPriorityClass(identity)];
}

/** 평범한 객체인가 — 원형이 Object.prototype 또는 null 인 객체만(배열·Date·클래스 인스턴스·null 아님). 원장에서 읽은 값의 형태 검사. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 원장에서 읽은 신분도 닫힌 목록으로 검증한다 — 목록 밖 값·형태가 틀린 값은 거부한다.
 * 출생 기록(origin)은 없으면 «미기록»(빈 출생 기록 `{}` 으로 읽는다 — 지어내지 않는다) ·
 * 있으면 평범한 객체여야 하고 checklistId·version·seat 는 문자열, launcher 는 닫힌 목록이다.
 */
export function validateRunIdentity(identity: RunIdentity): RunIdentity {
  if (!isPlainRecord(identity)) throw new Error(`run identity 는 객체다: ${JSON.stringify(identity)}`);
  // 칸마다 optional(없으면 «미기록») — 있는 칸만 닫힌 목록으로 검증한다.
  const { class: klass, care, rights, protect, origin } = identity as Partial<RunIdentity>;
  if (klass !== undefined && !RUN_IDENTITY_CLASSES.includes(klass)) throw new Error(`run identity class 는 ${RUN_IDENTITY_CLASSES.join('|')} 중 하나다: ${JSON.stringify(klass)}`);
  if (care !== undefined && !RUN_IDENTITY_CARES.includes(care)) throw new Error(`run identity care 는 ${RUN_IDENTITY_CARES.join('|')} 중 하나다: ${JSON.stringify(care)}`);
  if (rights !== undefined && !RUN_IDENTITY_RIGHTS.includes(rights)) throw new Error(`run identity rights 는 ${RUN_IDENTITY_RIGHTS.join('|')} 중 하나다: ${JSON.stringify(rights)}`);
  if (protect !== undefined && typeof protect !== 'boolean') throw new Error(`run identity protect 는 true|false 다: ${JSON.stringify(protect)}`);
  if (origin === undefined) return { ...identity, origin: {} };   // 출생 기록 «미기록» — 칸을 지어내지 않는다.
  if (!isPlainRecord(origin)) throw new Error(`run identity origin 은 객체다: ${JSON.stringify(origin)}`);
  for (const key of ['checklistId', 'version', 'seat'] as const) {
    const value = origin[key];
    if (value !== undefined && typeof value !== 'string') throw new Error(`run identity origin.${key} 는 문자열이다: ${JSON.stringify(value)}`);
  }
  const launcher = origin.launcher;
  if (launcher !== undefined && !RUN_IDENTITY_LAUNCHERS.includes(launcher as RunIdentityLauncher)) throw new Error(`run identity 출생 자리는 ${RUN_IDENTITY_LAUNCHERS.join('|')} 중 하나다: ${JSON.stringify(launcher)}`);
  return identity;
}
