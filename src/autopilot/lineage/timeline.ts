// ── Historian 통합 타임라인 (H1 · 2026-07-20) ────────────────────────────────
//
// ★ RFC-coordinator-loop-template-lineage-historian §3c/H1. mount 된 모든 LineageSource 를
//   읽어 **세대축 단일 타임라인**으로 병합·렌더. 5-way 가 각자 다른 CLI 로 흩어져 있던 관측
//   부족(RFC §2a)을 하나의 뷰로 수렴 — 제1원칙 "관측 먼저".
//
// 순수 병합/정렬(read-only·fail-soft: 소스 예외는 흡수). CLI(autopilot history <id> --full)가 소비.

import type { LineageEntry, LineageStoreKind } from './types.js';
import { listLineageSources } from './registry.js';
import { formatShortDateTime } from '../../time/calendar.js';

const STORE_ICON: Record<LineageStoreKind, string> = {
  'generation-archive': '🗂️ ',
  'working-memory': '🧠',
  'build-frames': '🔨',
  'exec-frames': '⚙️ ',
  cache: '♻️ ',
  observation: '🔭',
};

/** mount 된 소스 전부 read → 병합 → (at, seq) 오름차순 정렬. at 없는 항목은 뒤로. fail-soft. */
export function buildLineageTimeline(missionId: string): LineageEntry[] {
  const all: LineageEntry[] = [];
  for (const src of listLineageSources()) {
    try {
      all.push(...src.readTimeline(missionId));
    } catch {
      /* fail-soft — 한 소스 실패가 전체 관측을 막지 않음 */
    }
  }
  return all.sort((a, b) => {
    const ta = a.at ? Date.parse(a.at) : Number.POSITIVE_INFINITY;
    const tb = b.at ? Date.parse(b.at) : Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    return (a.seq ?? 0) - (b.seq ?? 0);
  });
}

/** 스토어별 엔트리 수 요약(관측 헤더). */
export function summarizeLineage(entries: readonly LineageEntry[]): Record<LineageStoreKind, number> {
  const counts = {
    'generation-archive': 0,
    'working-memory': 0,
    'build-frames': 0,
    'exec-frames': 0,
    cache: 0,
  } as Record<LineageStoreKind, number>;
  for (const e of entries) counts[e.store]++;
  return counts;
}

/** 통합 타임라인 렌더(CLI). 세대 경계·스토어 아이콘·시각. H4 이전 ②③④⑤ 는 gen ? 로 표시(갭 가시화). */
export function formatLineageTimeline(entries: readonly LineageEntry[]): string {
  if (!entries.length) return `🧬 5-way lineage: (이력 없음 — 프레임 계측 OFF 이거나 신규 미션)`;
  const counts = summarizeLineage(entries);
  const head = `🧬 5-way lineage — 세대아카이브 ${counts['generation-archive']} · 워킹메모리 ${counts['working-memory']} · 빌드프레임 ${counts['build-frames']} · 실행프레임 ${counts['exec-frames']} · 캐시 ${counts.cache}`;
  const lines = entries.map((e) => {
    const t = e.at ? formatShortDateTime(e.at) : '  ??  ';
    const gen = e.generation != null ? `g${e.generation}` : 'g?';
    return `  ${t} ${gen} ${STORE_ICON[e.store]} ${e.summary}`;
  });
  return [head, ...lines].join('\n');
}
