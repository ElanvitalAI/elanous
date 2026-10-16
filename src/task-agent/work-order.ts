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
 *   7. 선행·짝 칸(`peers`)
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
    const text = cellText(record[field]);
    if (text === WORK_ORDER_UNKNOWN) unknownFields.push(field);
    cells[field] = text;
  }
  return { ok: true, order: { cellId: rawCellId.trim(), ...cells, unknownFields } };
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
    `선례: ${order.precedents}`,
    `올림 규칙: ${order.escalation}`,
  ].join('\n');
}
