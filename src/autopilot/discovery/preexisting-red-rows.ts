import { isRecord } from '../../primitives/guards.js';
// ── Self-Evolution SE1 · gate.baseline 로그 조회 → 스캐너 행 변환 ────────
//
// 로그 조회 산출을 받아 scanPreexistingRed 가 먹을 수 있는 행 목록과 셈을 낸다.
// 조회 자체는 하지 않는다. 순수 함수. fs/db/network 없음.
//
// CLI(`elanous logs`) 배선은 이 골 밖 — 다음 골. 좁혀야 착지한다.
// 의도된 소비자: scanPreexistingRed(result.rows).

const GATE_BASELINE_EVENT = 'gate.baseline';
const LOG_QUERY_LIMIT_TYPE = 'log-query-limit';

export interface PreexistingRedLogRow {
  readonly ts: unknown;
  readonly [key: string]: unknown;
}

export interface PreexistingRedRowsResult {
  readonly rows: readonly PreexistingRedLogRow[];
  /** 메타가 아닌 입력 행을 본 수. 0 은 센 값이다 — 칸을 비워 「못 셌음」으로 두지 않는다. */
  readonly seen: number;
  /** data 를 객체로 못 읽은 행 수. 0 은 센 값이다. */
  readonly unreadable: number;
  /** 조회 절단 표시. 없으면 거짓 — 「모른다」로 두지 않는다. */
  readonly truncated: boolean;
}

function isMetaLine(item: unknown): item is { readonly _meta: Record<string, unknown> } {
  if (!isRecord(item) || !isRecord(item._meta)) return false;
  return item.event === undefined && item.data === undefined;
}

function isTruncationMeta(item: unknown): boolean {
  if (!isMetaLine(item)) return false;
  return item._meta.type === LOG_QUERY_LIMIT_TYPE && item._meta.limitReached === true;
}

/** data 칸: 문자열이면 JSON 으로 읽고, 이미 객체면 그대로. 못 읽으면 undefined. */
function parseData(data: unknown): Record<string, unknown> | undefined {
  let value: unknown = data;
  if (typeof data === 'string') {
    try {
      value = JSON.parse(data);
    } catch {
      return undefined;
    }
  }
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) return undefined;
  return value;
}

/** 로그 조회 산출(JSONL 파싱 행 + 선택적 절단 메타) → 스캐너가 먹을 행 목록과 셈. */
export function collectPreexistingRedRows(queryOutput: readonly unknown[]): PreexistingRedRowsResult {
  let seen = 0;
  let unreadable = 0;
  let truncated = false;
  const rows: PreexistingRedLogRow[] = [];

  for (const item of queryOutput) {
    if (isMetaLine(item)) {
      if (isTruncationMeta(item)) truncated = true;
      continue;
    }
    seen += 1;
    if (!isRecord(item)) {
      unreadable += 1;
      continue;
    }
    if (item.event !== GATE_BASELINE_EVENT) continue;
    const parsed = parseData(item.data);
    if (parsed === undefined) {
      unreadable += 1;
      continue;
    }
    rows.push({ ...parsed, ts: item.ts });
  }

  return { rows, seen, unreadable, truncated };
}
