// 👁️ ACTIVE-DIRECTIVES-BLOCK (DIRECTIVES-INDEX-CLAUDE-CODE must-carry) — 세션 시작 «살아 있는 지시» 블록.
//
// S: eln OP 가 대표 지시를 못 봐서 거슬렀다(11-24 — 퀵패스 발행 지시 위에 판정 HOLD 유지 · 승인된 보안 완화를 되돌리는 PR 지시).
//    지시는 색인(`directives.db`)과 원장(`<seat-state>/<SEAT>/directives/DIRECTIVES-LEDGER-*.md`)에 있었지만 세션에 안 실렸다.
// A: 세션 시작 스냅샷에 최근 지시 ~15줄(≤1.5KB)을 싣는다 — 원장(있으면 · 해석 포함) 먼저, 그다음 색인(이 자리/이 프로젝트
//    cwd 의 사람 턴) 최신순. 대화마다 한 번 만들어 안정 구역(캐시 접두)에 둔다 ⇒ 같은 대화 동안 바이트가 같다.
//    원장이 없는 일반 사용자(시트 배치 없음)는 색인만 쓴다 · 둘 다 없으면 블록 없음(실패 0).
// 세 얼굴: 관측 = `memory` 범주 `directives-block`(줄 수·바이트·출처 수) · 판단 근거 = 상한·출처 순서 ·
//    수복 = 읽기 실패는 그 출처만 빠진다.

import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { debug, redactSecretText } from '../debug/log.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';

// 공개본은 directive-index(로컬 전용 색인 · release/public-export.yaml 제외)를 싣지 않는다 — 경로만 여기서 같은 규칙으로 계산한다.
const directiveDbPath = (stateDir = elanousStateRoot()): string => join(stateDir, 'directives', 'directives.db');

export const ACTIVE_DIRECTIVES_MAX_BYTES = 1_536;
export const ACTIVE_DIRECTIVES_MAX_ITEMS = 15;
const ITEM_TEXT_MAX_CHARS = 100;
const LEDGER_MAX_ROWS = 4;

export const ACTIVE_DIRECTIVES_CONTRACT =
  'Before reversing or overriding a change that a CEO directive asked for, search directives (`eln directives search <words>`) and the ledger; if a directive covers it, do not reverse it — raise a decision card instead.';

export interface ActiveDirectivesScope {
  /** 블록 머리에 쓰는 이름(자리 id 또는 프로젝트 꼬리표). */
  label: string;
  /** 자리 범위면 그 자리(cwd `/seats/<SEAT>` 로 거른다). */
  seat?: string;
  /** 프로젝트 범위면 작업 트리 뿌리들(cwd 접두로 거른다). */
  roots?: string[];
  /** 원장 폴더(`<seat-state>/<SEAT>/directives`) — 없으면 색인만. */
  ledgerDir?: string | null;
}

export interface ActiveDirectivesDeps { dbPath?: string }

const oneLine = (text: string, max = ITEM_TEXT_MAX_CHARS): string => {
  const t = redactSecretText(text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim());
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** 가장 최근 원장 파일의 표 줄(위가 최신) → `[원장 날짜 시각] 원문 → 해석`. */
export function readLedgerItems(ledgerDir: string): string[] {
  if (!existsSync(ledgerDir)) return [];
  const files = readdirSync(ledgerDir).filter(f => /^DIRECTIVES-LEDGER-\d{8}\.md$/.test(f)).sort().reverse();
  const latest = files[0];
  if (!latest) return [];
  const day = latest.slice(-11, -3);
  const out: string[] = [];
  for (const line of readFileSync(join(ledgerDir, latest), 'utf8').split('\n')) {
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 2 || /^-+$/.test(cells[0]!) || /시각|time/i.test(cells[0]!)) continue;
    const [when, text, meaning] = cells;
    if (!text) continue;
    out.push(`- [ledger ${day.slice(4, 6)}-${day.slice(6, 8)} ${oneLine(when!, 12)}] ${oneLine(text, 80)}${meaning ? ` → ${oneLine(meaning, 50)}` : ''}`);
    if (out.length >= LEDGER_MAX_ROWS) break;
  }
  return out;
}

function inScope(cwd: string | null, scope: ActiveDirectivesScope): boolean {
  if (!cwd) return false;
  if (scope.seat) return new RegExp(`(?:^|/)seats/${scope.seat}(?:/|$)`, 'i').test(cwd);
  const c = resolve(cwd);
  return (scope.roots ?? []).some(root => c === root || c.startsWith(root.endsWith(sep) ? root : root + sep));
}

/** 색인의 최근 사람 턴(이 범위 cwd 만). 읽기 전용 — 색인이 없으면 만들지 않는다. */
export function readIndexItems(scope: ActiveDirectivesScope, limit: number, deps: ActiveDirectivesDeps = {}): string[] {
  const path = deps.dbPath ?? directiveDbPath();
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.prepare('SELECT ts, cwd, text FROM directives WHERE cwd IS NOT NULL ORDER BY ts DESC LIMIT 2000').all() as Array<{ ts: string; cwd: string | null; text: string }>;
    const out: string[] = [];
    for (const row of rows) {
      if (out.length >= limit) break;
      if (!inScope(row.cwd, scope)) continue;
      out.push(`- [${row.ts.slice(5, 16).replace('T', ' ')}Z] ${oneLine(row.text)}`);
    }
    return out;
  } finally { db.close(); }
}

/** 세션 시작 «살아 있는 지시» 블록. 재료가 없으면 null. */
export function buildActiveDirectivesBlock(scope: ActiveDirectivesScope, deps: ActiveDirectivesDeps = {}): string | null {
  let ledger: string[] = [];
  let indexed: string[] = [];
  try { ledger = scope.ledgerDir ? readLedgerItems(scope.ledgerDir) : []; } catch { ledger = []; }
  try { indexed = readIndexItems(scope, ACTIVE_DIRECTIVES_MAX_ITEMS - ledger.length, deps); } catch { indexed = []; }
  const items = [...ledger, ...indexed];
  if (items.length === 0) {
    debug.log('memory', 'directives-block', { scope: scope.label, lines: 0, ledger: 0, indexed: 0 });
    return null;
  }
  const head = `## Active CEO directives — ${scope.label} (session-start snapshot · newest first · ledger then index)\n${ACTIVE_DIRECTIVES_CONTRACT}\n`;
  let block = head;
  let kept = 0;
  for (const item of items) {
    const next = `${block}${item}\n`;
    if (Buffer.byteLength(next, 'utf8') > ACTIVE_DIRECTIVES_MAX_BYTES) break;
    block = next;
    kept++;
  }
  if (kept === 0) return null;
  debug.log('memory', 'directives-block', { scope: scope.label, lines: kept, bytes: Buffer.byteLength(block, 'utf8'), ledger: ledger.length, indexed: indexed.length });
  return block.trimEnd();
}
