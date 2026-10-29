/**
 * 디스크 관리자 — 회수 요청 원장(DISK-STEWARD-CORE · RFC-disk-steward-reclaim-on-job-end-2026-10-28 §3).
 *
 * 일을 만든 쪽은 끝날 때 `requestReclaim()` 한 줄을 던지고 «기다리지 않고» 끝난다.
 * 판정·삭제는 관리자(`steward.ts`)만 한다.
 *
 * ⛔ 계약: `requestReclaim` 은 «절대» 호출자에게 던지지 않는다(fail-soft) — 원장 한 줄 append 뿐이다.
 *    실패는 반환값 `{ ok:false }` ⊕ 관측(`disk.steward` `reclaim-request-failed`)으로만 남긴다.
 */
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';

export const RECLAIM_KINDS = ['worktree', 'graph-context', 'pod-dir', 'tmp'] as const;
export type ReclaimKind = typeof RECLAIM_KINDS[number];

export interface ReclaimRequest {
  path: string;
  kind: ReclaimKind;
  /** 소유 — `seat:<자리>` · `run:<runId>` · `train:<id>` · `release:<v>` · `pod:<job>` · `pid:<n>` 등. */
  owner?: string;
  reason?: string;
  requester?: string;
  /** ISO-8601. 비면 기록 시각. */
  timestamp?: string;
}

export interface ReclaimRequestResult {
  ok: boolean;
  ledger?: string;
  error?: string;
}

export const DISK_STEWARD_CATEGORY = 'disk.steward';

/** 원장 뿌리 — 실효 인스턴스 뿌리 아래 `disk-steward/`(우주를 따라간다). */
export function diskStewardStateDir(root?: string): string {
  return join(root ?? effectiveInstanceRoot(), 'disk-steward');
}

export function reclaimLedgerPath(root?: string): string {
  return join(diskStewardStateDir(root), 'requests.jsonl');
}

function isKind(value: unknown): value is ReclaimKind {
  return typeof value === 'string' && (RECLAIM_KINDS as readonly string[]).includes(value);
}

/** 회수 요청 한 줄을 원장에 붙인다. 판정·삭제는 하지 않는다. 절대 던지지 않는다. */
export function requestReclaim(request: ReclaimRequest, opts: { ledgerPath?: string } = {}): ReclaimRequestResult {
  let ledger: string | undefined;
  try {
    const path = typeof request?.path === 'string' ? request.path.trim() : '';
    if (!path.startsWith('/')) throw new Error(`absolute path required: ${String(request?.path)}`);
    if (!isKind(request.kind)) throw new Error(`unknown kind: ${String(request.kind)}`);
    ledger = opts.ledgerPath ?? reclaimLedgerPath();
    const row = {
      path,
      kind: request.kind,
      owner: request.owner ?? null,
      reason: request.reason ?? null,
      requester: request.requester ?? null,
      timestamp: request.timestamp ?? new Date().toISOString(),
    };
    mkdirSync(dirname(ledger), { recursive: true });
    appendFileSync(ledger, `${JSON.stringify(row)}\n`, 'utf8');
    safeLog('reclaim-requested', { ...row, ledger });
    return { ok: true, ledger };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    safeLog('reclaim-request-failed', { path: safePath(request), error: message, ledger });
    return { ok: false, error: message, ...(ledger ? { ledger } : {}) };
  }
}

function safePath(request: unknown): unknown {
  try { return (request as { path?: unknown })?.path; } catch { return undefined; }
}

function safeLog(event: string, data: unknown): void {
  try { debug.log(DISK_STEWARD_CATEGORY, event, data); } catch { /* 관측 실패가 호출자를 깨지 않는다 */ }
}

export interface LedgerRead {
  requests: Array<Required<Pick<ReclaimRequest, 'path' | 'kind'>> & ReclaimRequest>;
  /** 다음 읽기 시작 바이트(커서). */
  nextOffset: number;
  malformed: number;
}

/** `offset` 바이트부터 끝까지 읽는다. 마지막 줄이 개행 없이 잘렸으면(쓰는 중) 커서를 그 앞에 둔다. */
export function readReclaimLedger(ledgerPath: string, offset = 0): LedgerRead {
  let size = 0;
  try { size = statSync(ledgerPath).size; } catch { return { requests: [], nextOffset: 0, malformed: 0 }; }
  const start = offset > size ? 0 : offset; // 원장이 갈렸으면(작아졌으면) 처음부터
  // 커서 뒤만 읽는다 — 원장이 자라도 한 판 비용은 새 요청 크기에 비례한다.
  const buf = Buffer.alloc(size - start);
  const fd = openSync(ledgerPath, 'r');
  try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline < 0) return { requests: [], nextOffset: start, malformed: 0 };
  const text = buf.subarray(0, lastNewline + 1).toString('utf8');
  const requests: LedgerRead['requests'] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (typeof row.path !== 'string' || !isKind(row.kind)) { malformed++; continue; }
      requests.push({
        path: row.path,
        kind: row.kind,
        ...(typeof row.owner === 'string' ? { owner: row.owner } : {}),
        ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
        ...(typeof row.requester === 'string' ? { requester: row.requester } : {}),
        ...(typeof row.timestamp === 'string' ? { timestamp: row.timestamp } : {}),
      });
    } catch { malformed++; }
  }
  return { requests, nextOffset: start + lastNewline + 1, malformed };
}
