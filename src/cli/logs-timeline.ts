// ── logs → human-readable timeline ─────────────────────────────────────────
//
// Renders a drive / agent session from logs.db into a readable chronological
// narrative — the "휴먼 리더블" view. The tui-sim `transcript` used raw
// h.snapshot() (the full PTY byte buffer), which for a full-screen TUI is
// cursor-positioned in-place redraws with no newlines → stripAnsi collapses a
// 182 KB run into ~3 lines (내부 문서 §3 task#10).
// The signal was never on the screen bytes — it is in logs.db (the same store
// we diagnosed the B-stall from). This turns those structured events into a
// turn-by-turn story: goal iterations, tool calls + results, reasoning
// summaries, edits, and the runaway-discipline signals (repeat / doom-timeout /
// compaction). Render noise (dashboard.draw, chat.stream deltas, tool-exposure)
// is never queried.
//
// Pure `renderTimeline(rows)` so it is unit-testable off synthetic rows; the
// CLI (`elanous logs timeline`) and tui-sim both feed it real rows.

import { existsSync, writeFileSync } from 'node:fs';
import type { LogStoreRow, LogQuery } from '../mss/logging/log-store.js';
import { LogStore } from '../mss/logging/log-store.js';
import { resolveLogTargets } from './logs-cli.js';
import { formatClock } from '../time/clock.js';

/** Category PREFIXES worth pulling for a timeline. Everything else (render
 *  frames, stream deltas, cache stats, tool-exposure) is noise and never
 *  queried. Events within these are further whitelisted in the renderer.
 *
 *  OH9 참고: 이건 렌더 카테고리의 **역집합**(끌어올 것을 화이트리스트) —
 *  발화 게이트 SSOT(`isRenderCategory` · mss/logging/render-categories.ts)와
 *  직교 개념이라 직접 참조하지 않는다. 불변식: 이 목록의 어떤 접두도 렌더
 *  카테고리여선 안 된다(있으면 타임라인이 렌더 노이즈를 끌어오는 셈). */
export const TIMELINE_CATEGORIES = [
  'goal.loop',
  'llm.router',
  'llm.reasoning',
  'llm.stream',
  'llm.tool-loop',
  'chat.tool-call',
  'chat.tool-result',
] as const;

function parseData(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
}

/** 사용자 시간대 시각. 종전엔 `row.ts.slice(11, 19)` 로 ISO 를 잘라 UTC 를 그대로
 *  찍었다 — logs-cli 와 같은 결함이었고, 내러티브 타임라인이라 시각 오차가 특히
 *  치명적이다(사건 순서를 사람 기억과 대조할 수 없다). 계약: src/time/format.ts */
function hhmmss(row: LogStoreRow): string {
  return formatClock(row.ts);
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** chat.tool-call `data.args` is a JSON STRING (double-encoded). Pull the
 *  fields that matter per tool so the line reads like the actual action. */
function compactArgs(argsRaw: unknown): string {
  let a: Record<string, unknown> = {};
  if (typeof argsRaw === 'string') { try { a = JSON.parse(argsRaw); } catch { return truncate(argsRaw, 80); } }
  else if (argsRaw && typeof argsRaw === 'object') a = argsRaw as Record<string, unknown>;
  const path = a.path ?? a.file_path;
  if (a.pattern) return truncate(`${String(a.pattern)}${path ? ` @ ${String(path)}` : ''}`, 90);
  if (path) return truncate(String(path), 90);
  return truncate(JSON.stringify(a), 80);
}

function isErrorPreview(d: Record<string, unknown>): boolean {
  const p = typeof d.preview === 'string' ? d.preview : '';
  return /"error"\s*:/.test(p) || /\berror\b/i.test(String(d.status ?? ''));
}

/** Render an ascending-by-time row list into a narrative string. Pure. */
export function renderTimeline(rows: LogStoreRow[]): string {
  const out: string[] = [];
  let renderedTurn = -1;
  const push = (line: string): void => { out.push(line); };

  for (const row of rows) {
    const t = hhmmss(row);
    const d = parseData(row.data);
    const cat = row.category;
    const ev = row.event;

    if (cat === 'goal.loop') {
      if (ev === 'start') {
        const obj = truncate(String(d.objective ?? '').split('\n').find((l) => l.trim() && !l.startsWith('Context:') && !l.startsWith('Dashboard')) ?? String(d.objective ?? ''), 120);
        push('');
        push(`══════ ${t}  GOAL START ══════`);
        if (obj) push(`   ▸ ${obj}`);
        renderedTurn = -1;
      } else if (ev === 'iteration') {
        const g = d.goalUpdate ? ` goal=${String(d.goalUpdate)}` : '';
        push(`   ⟳ ${t} iter ${d.iteration}  stop=${d.stopReason} tokens=${d.lastInputTokens} Δchars=${d.finalChars}${g}`);
      } else if (ev === 'complete') {
        push(`══════ ${t}  GOAL COMPLETE (${d.iterations} iters · via ${d.via}) ══════`);
      }
      continue;
    }

    if (cat === 'llm.router') {
      if (ev === 'tool-loop.turn.start') {
        push('');
        push(`── ${t} turn ${d.turn} (history ${d.historyLen})`);
        renderedTurn = Number(d.turn);
      } else if (ev === 'tool-loop.turn.end') {
        const pend = Array.isArray(d.pendingCalls) ? (d.pendingCalls as unknown[]).join(',') : '';
        push(`   ↳ ${t} end ${d.durationMs}ms text=${d.textChars}${pend ? ` pending=[${pend}]` : ''}`);
      } else if (ev === 'tool-loop.midloop-compact') {
        push(`   🗜 ${t} COMPACT ${d.beforeLen}→${d.afterLen}${d.escalated ? ' (LLM-escalated)' : ''}`);
      } else if (ev === 'tool-loop.edit-applied') {
        const fp = String(d.file_path ?? '');
        push(`   ✎ ${t} edit applied → ${fp.split('/').pop() ?? fp}`);
      }
      continue;
    }

    if (cat === 'llm.reasoning') {
      if (ev === 'codex.summary.delta' && d.preview) push(`   💭 ${t} ${truncate(String(d.preview), 90)}`);
      continue;
    }

    if (cat === 'chat.tool-call') { push(`   🔧 ${t} ${ev}(${compactArgs(d.args)})`); continue; }
    if (cat === 'chat.tool-result') {
      const mark = isErrorPreview(d) ? '✗ ERROR' : '✓';
      push(`   → ${t} ${mark} ${truncate(String(d.preview ?? ''), 110)}`);
      continue;
    }

    if (cat === 'llm.tool-loop.repeat' && ev === 'identical-success-detected') {
      push(`   ⚠ ${t} REPEAT — ${d.tool} ×${d.window} identical → converge nudge`);
      continue;
    }
    if (cat === 'llm.tool-loop.retry') { push(`   ⚠ ${t} doom: ${ev}`); continue; }
    if (cat === 'llm.stream' && ev === 'idle-timeout') {
      push(`   ⏱ ${t} idle-timeout ${d.idleMs}ms (turn ${d.turn}, ${d.evCount} ev)`);
      continue;
    }

    // Fallback — surface warn/error rows we didn't explicitly model so problems
    // never hide. (turn context already printed above via turn.start.)
    if (row.level === 'error' || row.level === 'critical') {
      void renderedTurn;
      push(`   ⚠ ${t} [${cat}] ${ev} ${truncate(String(row.data ?? ''), 90)}`);
    }
  }

  return out.join('\n');
}

/** Pull all timeline-relevant rows in ascending time order, paginating past
 *  the 1000-row query cap via the afterId cursor. */
export function collectTimelineRows(
  store: LogStore,
  q: Pick<LogQuery, 'sessionId' | 'sinceMs' | 'untilMs'> = {},
  maxRows = 50_000,
): LogStoreRow[] {
  const all: LogStoreRow[] = [];
  let afterId = 0;
  for (;;) {
    const page = store.query({
      ...q,
      categories: [...TIMELINE_CATEGORIES],
      afterId,
      limit: 1000,
    });
    if (page.length === 0) break;
    all.push(...page);
    afterId = page[page.length - 1]!.id;
    if (page.length < 1000 || all.length >= maxRows) break;
  }
  return all;
}

function parseSince(raw: string): number | null {
  const rel = /^(\d+)(s|m|h|d)$/.exec(raw.trim());
  if (rel) {
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as 's' | 'm' | 'h' | 'd'];
    return Date.now() - Number(rel[1]) * unit;
  }
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  const d = Date.parse(raw);
  return Number.isFinite(d) ? d : null;
}

export interface LogsTimelineOpts {
  test?: boolean;
  instance?: string;
  session?: string;
  since?: string;
  until?: string;
  out?: string;
}

/** `elanous logs timeline` — render a session/window as a readable narrative. */
export function runLogsTimeline(opts: LogsTimelineOpts): number {
  const resolved = resolveLogTargets({ test: opts.test, instance: opts.instance });
  if (resolved.error) { console.error(`elanous logs timeline: ${resolved.error}`); return 1; }
  const target = resolved.targets[0];
  if (!target || !existsSync(target.dbPath)) {
    console.error(`elanous logs timeline: 로그 스토어 없음 — ${target?.dbPath ?? '타겟 0'}`);
    return 1;
  }
  const q: Pick<LogQuery, 'sessionId' | 'sinceMs' | 'untilMs'> = {};
  if (opts.session) q.sessionId = opts.session;
  if (opts.since) {
    const ms = parseSince(opts.since);
    if (ms === null) { console.error(`elanous logs timeline: --since 파싱 불가 '${opts.since}'`); return 1; }
    q.sinceMs = ms;
  }
  if (opts.until) {
    const ms = parseSince(opts.until);
    if (ms === null) { console.error(`elanous logs timeline: --until 파싱 불가 '${opts.until}'`); return 1; }
    q.untilMs = ms;
  }
  const store = LogStore.openReadOnly(target.dbPath);
  try {
    const rows = collectTimelineRows(store, q);
    const text = renderTimeline(rows);
    if (opts.out) {
      writeFileSync(opts.out, `${text}\n`);
      console.error(`[timeline] ${rows.length} events → ${opts.out}`);
    } else {
      console.log(text);
      console.error(`\n[timeline] ${rows.length} events (${target.name})`);
    }
  } finally { store.close(); }
  return 0;
}
