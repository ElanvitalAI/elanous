/**
 * TASK-AGENT 작업 지시서(work order) 스키마 — RFC-adaptive-graph-ops-2026-10-09 §9 «작업 지시서» 칸 아홉.
 *
 * 조율자 → TA 호출의 계약으로 칸 제목 한 줄을 대신한다. 이 첫 조각은 스키마와 검증(`parseWorkOrder`)·
 * 골 문면 펼치기만 담는다 — 조율자가 칸·신호·선례에서 지시서를 «자동 작성»하는 일은 다음 조각이다.
 *
 * 칸 아홉(RFC 목록 그대로 — 칸 1·4는 여러 키로 펼친다):
 *   1. `lifeId` · 칸 id(`cellId`) · 판(`version`) · 착지 마감(`landBy`) — cellId 만 필수다.
 *   2. 신분 태그(`identityTags` — class·care·rights·origin·rework)
 *   3. 우선순위(`priority` — 신호 order 순위 · 승수 등급 · 대표 표시)
 *   4. 판정 신호(`verdictSignal` — 조건·관측·기대) ⊕ 현재 계약 한 줄(`contract`)
 *   5. 경계(`boundary` — 대상 경로 · 건드리지 말 곳)
 *   6. 예산(`budget` — 시간 · 모델 티어 · Pod 자리 · 재작업 상한)
 *   7. 선행·짝 칸(`peers`) — 항목마다 조회된 상태(`state`)와 조회 시각(`observedAt`)을 보존한다
 *      (칸 이름만으로는 발사 시점의 상태를 알 수 없다 · 조회하지 않은 항목은 «모름»).
 *   8. 선례 묶음(`precedents` — 같은 칸 앞 생애 결말·must-fix 서명)
 *   9. 올림 규칙(`escalation` — 무엇이면 누구에게 · 돈·보안은 대표)
 *
 * 빠진 칸은 거부하지 않고 «모름»(`WORK_ORDER_UNKNOWN`)으로 채워 그 키를 `unknownFields` 에 적는다
 * (RFC: 비우면 TA 가 추측한다). 거부는 두 가지뿐 — JSON 이 깨졌거나 칸 id 가 없거나.
 */

/** 빠진 칸을 채우는 값 — RFC «빠진 칸은 «모름»으로 적는다». */
export const WORK_ORDER_UNKNOWN = '모름';
/** 지시서 골 파일 이름 접미 — 이 이름으로 끝나는 파일만 지시서로 검증한다. */
export const WORK_ORDER_FILE_PATTERN = /\.work-order\.json$/i;

/** 칸 아홉 중 채울 수 있는 키(칸 id 제외) — unknownFields 는 이 순서로 적는다. */
export const WORK_ORDER_FIELDS = [
  'lifeId', 'version', 'landBy',
  'identityTags', 'priority', 'verdictSignal', 'contract',
  'boundary', 'budget', 'peers', 'precedents', 'escalation',
] as const;
export type WorkOrderField = typeof WORK_ORDER_FIELDS[number];

/**
 * 발사 전에 «모름» 이면 안 되는 칸 — 경계(건드릴 곳)·예산(시간·모델·Pod·재작업)·계약(현재 계약)·올림(막히면 누구에게).
 * 이 칸들이 비면 TA 가 추측하게 되므로 hand 가 지시서 발사를 거부한다(resolveHandText · ta-preflight 조건 3 도 같은 목록).
 */
export const WORK_ORDER_CRITICAL_FIELDS = ['boundary', 'budget', 'contract', 'escalation'] as const;

/** 시범 발사의 벽시계 상한(초) — 부모 구현 상한 2시간에서 5분 먼저 끝나는 자식 기본 하드 대기와 같다(시험이 고정). */
export const TA_PILOT_MAX_WALL_SEC = 6_900;
/** hand 가 선언된 벽시계를 발사 환경에 싣는 키 — 소비자: self-implement-pod.ts(Job 수명). */
export const TA_BUDGET_WALL_ENV = 'ELANOUS_TA_WALL_SEC';
/** 선언 벽시계 뒤에 Job 이 더 사는 여유(초) — 자식이 결과·PR 을 남기고 스스로 끝낼 시간. */
export const TA_POD_DEADLINE_GRACE_SEC = 300;

export type ParseWorkOrderBudgetResult = { ok: true; timeSec: number } | { ok: false; reason: string };

/**
 * 예산 칸 `time=6900s usd=5` (공백·`·`·`,`·`;` 구분)를 읽는다. 키는 time·usd 둘뿐 — 중복·여분 키·`key = value`·대소문자 변형·빈 값은 거부(무시하지 않는다).
 * time 은 «선언된 값 그대로» 정수 초(s·m·h 소문자 단위)이고 1..TA_PILOT_MAX_WALL_SEC 여야 한다 — 부동소수·허용오차 없이 BigInt 10진 산술로 판정한다.
 * usd 는 센트 단위 정수로 환산되는 양의 10진수(소수 둘째 자리까지)여야 한다. usd 는 형식만 검증하며 강제 소비자는 아직 없다(후속 칸).
 */
export function parseWorkOrderBudget(text: string): ParseWorkOrderBudgetResult {
  const pairs = new Map<string, string>();
  for (const token of text.split(/[\s·,;]+/u).filter(Boolean)) {
    const match = /^([a-z]+)=(.+)$/u.exec(token);
    if (!match) return { ok: false, reason: `예산 토큰 «${token.slice(0, 40)}» 는 소문자 key=value 형식이 아니다` };
    const [, key, value] = match as unknown as [string, string, string];
    if (key !== 'time' && key !== 'usd') return { ok: false, reason: `예산에 허용되지 않은 키 «${key}» (허용: time·usd)` };
    if (pairs.has(key)) return { ok: false, reason: `예산 키 «${key}» 가 중복 선언됐다` };
    pairs.set(key, value);
  }
  const rawTime = pairs.get('time');
  if (rawTime === undefined) return { ok: false, reason: '예산에 time=<초|분m|시간h> 가 없다' };
  const time = /^(\d{1,6})(?:\.(\d{1,12}))?([smh]?)$/u.exec(rawTime);
  if (!time) return { ok: false, reason: `time=${rawTime.slice(0, 20)} 형식 오류(숫자+s|m|h 소문자 단위)` };
  const fraction = time[2] ?? '';
  const scaled = BigInt(`${time[1]}${fraction}`) * BigInt(time[3] === 'h' ? 3600 : time[3] === 'm' ? 60 : 1);
  const divisor = 10n ** BigInt(fraction.length);
  if (scaled % divisor !== 0n) return { ok: false, reason: `time ${rawTime} 는 정수 초가 아니다` };
  const seconds = scaled / divisor;
  if (seconds < 1n || seconds > BigInt(TA_PILOT_MAX_WALL_SEC)) return { ok: false, reason: `time ${seconds}s 는 1..${TA_PILOT_MAX_WALL_SEC}s 밖이다` };
  const rawUsd = pairs.get('usd');
  if (rawUsd === undefined) return { ok: false, reason: '예산에 usd=<양수·소수 둘째 자리까지> 상한이 없다' };
  const usd = /^(\d{1,9})(?:\.(\d{1,2}))?$/u.exec(rawUsd);
  if (!usd) return { ok: false, reason: `usd=${rawUsd.slice(0, 20)} 는 센트 단위 양수(최대 소수 둘째 자리)가 아니다` };
  const cents = BigInt(usd[1]!) * 100n + BigInt((usd[2] ?? '').padEnd(2, '0') || '0');
  if (cents <= 0n) return { ok: false, reason: 'usd 상한은 0보다 커야 한다' };
  return { ok: true, timeSec: Number(seconds) };
}

/** 선언된 벽시계(env)에서 Pod Job 수명 상한(초)을 구한다 — 1..6900 정수 초가 아니면 undefined(적용 안 함). */
export function taPodDeadlineSeconds(env: Readonly<Record<string, string | undefined>>): number | undefined {
  const raw = env[TA_BUDGET_WALL_ENV];
  if (raw === undefined || !/^\d{1,4}$/u.test(raw)) return undefined;
  const wall = Number(raw);
  return wall >= 1 && wall <= TA_PILOT_MAX_WALL_SEC ? wall + TA_POD_DEADLINE_GRACE_SEC : undefined;
}

/** 지시서에서 «모름» 인 critical 칸 — 비어 있으면 발사해도 된다. */
export function criticalUnknownFields(order: Pick<WorkOrder, 'unknownFields' | 'boundary' | 'budget' | 'contract' | 'escalation'>): string[] {
  return WORK_ORDER_CRITICAL_FIELDS.filter((field) => order.unknownFields.includes(field) || !order[field].trim() || order[field] === WORK_ORDER_UNKNOWN);
}

/** 검증을 통과한 작업 지시서 — 모든 칸이 문자열로 채워져 있다(빠진 칸은 «모름»). */
export interface WorkOrder {
  lifeId: string;
  /** 필수 칸 — 이것만 없으면 거부한다. */
  cellId: string;
  version: string;
  landBy: string;
  identityTags: string;
  priority: string;
  verdictSignal: string;
  contract: string;
  boundary: string;
  budget: string;
  peers: string;
  precedents: string;
  escalation: string;
  /** 입력에 없어 «모름»으로 채운 키. */
  unknownFields: string[];
  /**
   * 선행 항목별 관측 — 지시서가 선행을 배열로 적었을 때만 있다(문자열 한 줄이면 종전 그대로 없다).
   * 항목마다 조회된 상태와 그 상태를 조회한 시각을 보존하고, 조회하지 않은 값은 «모름»이다.
   */
  dependencies?: WorkOrderDependency[];
}

/** 선행 칸 하나의 관측 — 칸 이름 ⊕ 조회된 상태 ⊕ 그 상태를 본 시각. */
export interface WorkOrderDependency {
  /** 선행 칸 id(또는 칸 이름). */
  cell: string;
  /** 조회된 상태(yellow·green·red …) — 조회하지 않았으면 «모름». */
  state: string;
  /** 상태를 조회한 시각(ISO 8601) — 조회하지 않았으면 «모름». */
  observedAt: string;
}

export type ParseWorkOrderResult = { ok: true; order: WorkOrder } | { ok: false; reason: string };

/** 칸 하나를 사람이 읽는 문자열로 정규화한다 — 없거나 비면 «모름», 문자열이 아니면 JSON 표기로. */
function cellText(value: unknown): string {
  if (value === undefined || value === null) return WORK_ORDER_UNKNOWN;
  if (typeof value === 'string') { const carried = value.trim(); return carried || WORK_ORDER_UNKNOWN; }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { const carried = JSON.stringify(value); return carried === 'null' || carried === undefined ? WORK_ORDER_UNKNOWN : carried; }
  catch { return WORK_ORDER_UNKNOWN; }
}

/**
 * 선행 칸을 항목별 관측으로 읽는다 — 배열 원소가 객체면 `state`·`observedAt` 을 보존하고,
 * 이름만 적힌 항목(문자열 등)은 조회하지 않은 것이므로 상태·시각 모두 «모름»으로 둔다.
 * 선행 칸이 배열이 아니면(문자열 한 줄·없음) 항목 목록은 비어 있다 — 종전 문면 그대로다.
 */
function parseDependencies(value: unknown): WorkOrderDependency[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      return {
        cell: cellText(record['cell'] ?? record['cellId']),
        state: cellText(record['state']),
        observedAt: cellText(record['observedAt']),
      };
    }
    return { cell: cellText(item), state: WORK_ORDER_UNKNOWN, observedAt: WORK_ORDER_UNKNOWN };
  });
}

/**
 * 지시서 JSON 원문을 검증한다. 깨진 JSON 은 `JSON 이 깨졌다: …`, 칸 id(문자열)가 없으면 `칸 id 가 없다`
 * 하나로 거부하고, 그 밖의 빠진 칸은 «모름»으로 채운다(거부 아님).
 */
export function parseWorkOrder(source: string): ParseWorkOrderResult {
  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch (error) {
    return { ok: false, reason: `JSON 이 깨졌다: ${error instanceof Error ? error.message : String(error)}` };
  }
  const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  const rawCellId = record['cellId'];
  if (typeof rawCellId !== 'string' || !rawCellId.trim()) return { ok: false, reason: '칸 id 가 없다' };
  const unknownFields: string[] = [];
  const cells = {} as Record<WorkOrderField, string>;
  for (const field of WORK_ORDER_FIELDS) {
    const value = record[field];
    const text = cellText(value);
    if (value == null || (typeof value === 'string' && !value.trim())) unknownFields.push(field);
    cells[field] = text;
  }
  const dependencies = parseDependencies(record['peers']);
  return {
    ok: true,
    order: {
      cellId: rawCellId.trim(), ...cells,
      ...(dependencies.length ? { dependencies } : {}),
      unknownFields,
    },
  };
}

/** 선행 항목별 «상태 ⊕ 조회 시각» 한 줄 — 이름만 있는 항목은 «모름 (관측 모름)»으로 드러난다. */
function renderDependencies(dependencies: WorkOrderDependency[]): string {
  const items = dependencies.map((dep) => `${dep.cell}=${dep.state} (관측 ${dep.observedAt})`);
  return `선행 상태: ${items.join(' · ')}`;
}

/** 검증된 지시서를 사람이 읽는 골 문면으로 펼친다 — 첫 줄 «대상 경로:»(경계), 둘째 줄 «현재 계약:». */
export function renderWorkOrderGoal(order: WorkOrder): string {
  return [
    `대상 경로: ${order.boundary}`,
    `현재 계약: ${order.contract}`,
    '',
    `[${order.lifeId} · 칸 ${order.cellId} · 판 ${order.version} · 착지 마감 ${order.landBy}]`,
    `신분 태그: ${order.identityTags}`,
    `우선순위: ${order.priority}`,
    `판정 신호: ${order.verdictSignal}`,
    `예산: ${order.budget}`,
    `선행·짝 칸: ${order.peers}`,
    ...(order.dependencies?.length ? [renderDependencies(order.dependencies)] : []),
    `선례: ${order.precedents}`,
    `올림 규칙: ${order.escalation}`,
  ].join('\n');
}
