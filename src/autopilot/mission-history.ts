// ── 미션 종합 히스토리 (Track B · 2026-07-15) ─────────────────────────────────
//
// 대표 지시: "미션 정주 후 skip·분할·수정한 종합 히스토리를 기본으로 남긴다." Track A(관측성 통일)로
// 편집/결정/분할이 전부 logs.db(관측 관문)에 남으므로, 이 모듈이 그걸 미션 단위로 읽어 시간순
// 통합 타임라인으로 합성한다(READ-ONLY·순수 조립). revision(세대 스냅샷)도 합류.

import { getDefaultLogStore } from '../mss/logging/log-store.js';
import { formatShortDateTime } from '../time/calendar.js';

export type MissionHistoryKind = 'edit' | 'decision' | 'split' | 'drift' | 'revision' | 'external';

export interface MissionHistoryEvent {
  ts: string;
  kind: MissionHistoryKind;
  op: string;
  summary: string;
  /** 출처(RFC L1) — 🤖 autonomous · 🧭 operator · 🔧 external:<tool>. */
  provenance?: string;
}

export interface MissionHistoryReaders {
  logsReader?: (missionId: string) => Array<{ ts: string; category: string; event: string; data: string | null }>;
  revisions?: (missionId: string) => Array<{ ts: string; summary: string }>;
  /** ★ 외부 변경(claude-code/codex PR) — 미션 귀속 self-events(RFC L1). */
  externalReader?: (missionId: string) => Array<{ ts: string; tool: string; kind: string; summary: string; refs: Record<string, unknown> }>;
}

/** logs.db 에서 이 미션의 편집/결정/분할/drift 관측을 읽는다(관측 관문이 채운 것). */
function defaultLogsReader(missionId: string): Array<{ ts: string; category: string; event: string; data: string | null }> {
  try {
    const store = getDefaultLogStore();
    if (!store) return [];
    return store.query({
      categories: ['mission.selfheal.edit', 'mission.selfheal.decision', 'mission.arc.split', 'mission.arc.drift'],
      grep: missionId, limit: 400,
    }).map((r) => ({ ts: r.ts, category: r.category, event: r.event, data: r.data }));
  } catch { return []; }
}

function kindOf(category: string): MissionHistoryKind {
  if (category.endsWith('.edit')) return 'edit';
  if (category.endsWith('.decision')) return 'decision';
  if (category.includes('.drift')) return 'drift';
  if (category.includes('.split')) return 'split';
  return 'edit';
}

/** logs.db 결정/편집의 출처 — actor 가 claude-code/external 이면 외부도구, 아니면 운영자/자율. */
function provenanceOf(data: Record<string, unknown>): string {
  const actor = String((data.refs as Record<string, unknown> | undefined)?.actor ?? data.actor ?? '');
  if (/claude-code|codex|external/i.test(actor)) return `🔧 ${actor}`;
  if (actor) return `🧭 ${actor}`;
  return '🤖 autonomous';
}

/** 미션 귀속 외부 self-events 를 읽는 기본 리더 — self-awareness(surface_events domain=elanous). fail-soft. */
function defaultExternalReader(missionId: string): Array<{ ts: string; tool: string; kind: string; summary: string; refs: Record<string, unknown> }> {
  try {
    // 지연 로드(순환 회피) — self-awareness 는 domains, 여기는 autopilot.
    const { openSurfaceEventsDb } = require('../domains/surface-events.js') as typeof import('../domains/surface-events.js');
    const { listMissionExternalChanges } = require('../domains/self-awareness.js') as typeof import('../domains/self-awareness.js');
    const db = openSurfaceEventsDb();
    try { return listMissionExternalChanges(db, missionId); } finally { db.close(); }
  } catch { return []; }
}

/**
 * 미션 종합 히스토리 합성 — 편집·결정·분할·drift·revision 을 시간순 통합. 순수(readers 주입).
 * "이 미션에 무엇을 skip/분할/수정/결정했나"를 한 곳에서 본다(정직성·감사).
 */
export function buildMissionHistory(missionId: string, readers: MissionHistoryReaders = {}): MissionHistoryEvent[] {
  const rows = (readers.logsReader ?? defaultLogsReader)(missionId);
  const events: MissionHistoryEvent[] = [];
  for (const r of rows) {
    let summary = '';
    let op = r.event;
    let provenance = '🤖 autonomous';
    try {
      const d = JSON.parse(r.data ?? '{}') as Record<string, unknown>;
      summary = String(d.rationale ?? d.recommendation ?? d.detail ?? '');
      const refs = d.refs as Record<string, unknown> | undefined;
      if (refs?.op) op = String(refs.op);
      else if (refs?.kind) op = String(refs.kind);
      provenance = provenanceOf(d);
    } catch { /* raw */ }
    events.push({ ts: r.ts, kind: kindOf(r.category), op, summary: summary.slice(0, 160), provenance });
  }
  // ★ 외부 변경(claude-code/codex PR) 합류(RFC L1) — 미션이 문맥만으로 "외부가 뭘 바꿨나" 를 안다.
  for (const x of (readers.externalReader ?? defaultExternalReader)(missionId)) {
    const pr = x.refs.pr ? ` (#${x.refs.pr})` : '';
    events.push({ ts: x.ts, kind: 'external', op: x.kind, summary: `${x.summary.slice(0, 150)}${pr}`, provenance: `🔧 ${x.tool}` });
  }
  for (const rev of readers.revisions?.(missionId) ?? []) {
    events.push({ ts: rev.ts, kind: 'revision', op: 'revise', summary: rev.summary.slice(0, 160), provenance: '🧭 operator' });
  }
  return events.sort((a, b) => a.ts.localeCompare(b.ts));
}

const KIND_ICON: Record<MissionHistoryKind, string> = { edit: '✏️', decision: '🧭', split: '✂️', drift: '⚠️', revision: '🔄', external: '🔧' };

/** 사람이 읽을 종합 히스토리 문자열. 없으면 안내. */
export function formatMissionHistory(missionId: string, events: readonly MissionHistoryEvent[]): string {
  if (!events.length) return `미션 ${missionId} — 편집/결정/분할/외부 종합 히스토리 없음(관측된 변경 없음).`;
  const lines = [`━━ 미션 종합 히스토리 · ${missionId} (${events.length}건) ━━`];
  // 출처(provenance) 가 있으면 그 아이콘을 앞세우고(🤖/🧭/🔧), 종류는 [op] 옆 KIND_ICON 로.
  for (const e of events) lines.push(`${formatShortDateTime(e.ts)} ${e.provenance ?? KIND_ICON[e.kind]} ${KIND_ICON[e.kind]}[${e.op}] ${e.summary}`);
  const byKind = events.reduce<Record<string, number>>((m, e) => { m[e.kind] = (m[e.kind] ?? 0) + 1; return m; }, {});
  lines.push(`요약: ${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
  return lines.join('\n');
}
