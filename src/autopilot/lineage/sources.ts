// ── Lineage 5-way 소스 어댑터 (빌드 루프) (H1 · 2026-07-20) ───────────────────
//
// ★ RFC-coordinator-loop-template-lineage-historian §3c/H1. 빌드 조율 루프의 5-way 히스토리
//   스토어(RFC §2a)를 각각 LineageSource(추상 seam)로 어댑트해 mount. Historian(timeline)은
//   이걸 루프-불문으로 소비 → 통합 관측. 투자/비즈 루프는 자기 소스를 별도 mount(추상성 증명).
//
// read-only·fail-soft(각 어댑터 예외는 timeline 이 흡수). 세대(generation)는 H1 현재 ①만 보유 —
// ②③④⑤ 는 H4 에서 파티션 부여(그때까지 undefined = "gen ?" 로 관측되어 H4 갭을 가시화).

import type { LineageEntry, LineageSource } from './types.js';
import { mountLineageSource } from './registry.js';
import { getMissionRevisions } from '../mission-lifecycle.js';
import { readWorkingMemory } from '../mission-working-memory.js';
import { readFrames } from '../pipeline/frame-journal.js';
import { readExecFrames } from '../pipeline/exec-frame-journal.js';
import { loadCacheEntryForObserve } from '../mission-grounding-cache.js';
import { LogStore, logsDbPath } from '../../mss/logging/log-store.js';
import { queryRunLedgerTimeline, type RunLedgerTimelineEntry } from '../../self-implement/run-ledger.js';

let readHarnessRunTimeline: (missionId: string) => RunLedgerTimelineEntry[] = queryRunLedgerTimeline;

/** Test seam for the read-only harness projection; production always uses the run ledger query. */
export function setHarnessRunTimelineReaderForTest(reader?: (missionId: string) => RunLedgerTimelineEntry[]): void {
  readHarnessRunTimeline = reader ?? queryRunLedgerTimeline;
}

/** Harness-run projection stays in observation: the six lineage store kinds and their lifecycle policy remain unchanged. */
export function harnessRunsToLineage(entries: readonly RunLedgerTimelineEntry[]): LineageEntry[] {
  return entries.map((entry) => ({
    store: 'observation' as const,
    at: entry.executedAt,
    seq: entry.pieceIndex,
    summary: `self-implement run ${entry.runId}${entry.orchestrationId ? ` · orchestration ${entry.orchestrationId}` : ''}${entry.shardId ? ` · shard ${entry.shardId}` : ''}${entry.pieceTotal !== undefined ? ` · ${entry.pieceTotal} pieces` : ''}${entry.unitVisits?.orphanCount ? ` · graph.unit orphan ${entry.unitVisits.orphanCount}` : ''}`,
  }));
}

/** ① 세대 아카이브 — rerun/revise 세대 스냅샷(tasks.db 행). 유일하게 generation 보유. */
const GENERATION_ARCHIVE_SOURCE: LineageSource = {
  kind: 'generation-archive',
  label: '세대 아카이브',
  readTimeline: (missionId): LineageEntry[] => {
    const rev = getMissionRevisions(missionId);
    if (!rev) return [];
    return rev.history.map((s) => ({
      store: 'generation-archive',
      at: new Date(s.archivedAt).toISOString(),
      generation: s.generation,
      summary: `gen ${s.generation} 보관 [${s.reason}]${s.goal ? ` · 골 ${s.goal.slice(0, 40)}` : ''} · ${s.phases.length}P`,
    }));
  },
};

/** ② 워킹 메모리 — 라이브(현 세대). 세대 파티션은 아카이브(H4). */
const WORKING_MEMORY_SOURCE: LineageSource = {
  kind: 'working-memory',
  label: '워킹 메모리',
  readTimeline: (missionId): LineageEntry[] =>
    readWorkingMemory(missionId).map((e, i) => ({
      store: 'working-memory',
      at: e.at,
      seq: i,
      summary: `[${e.kind}] ${e.phaseTitle.slice(0, 28)} — ${e.summary.slice(0, 44)}${e.deviation ? ` ⚠️${e.deviation.kind}` : ''}`,
    })),
};

/** ③ 빌드 프레임 저널 — 분해 8단계. */
const BUILD_FRAMES_SOURCE: LineageSource = {
  kind: 'build-frames',
  label: '빌드 프레임',
  readTimeline: (missionId): LineageEntry[] =>
    readFrames(missionId).map((f) => ({
      store: 'build-frames',
      at: f.timestamp,
      seq: f.seq,
      ...(f.generation !== undefined ? { generation: f.generation } : {}),
      summary: `${f.stage}[${f.op}] ${f.status}${f.supersededBy != null ? ` ⨯→#${f.supersededBy}` : ''}`,
    })),
};

/** ④ 실행 프레임 저널 — 페이즈·put_writes. */
const EXEC_FRAMES_SOURCE: LineageSource = {
  kind: 'exec-frames',
  label: '실행 프레임',
  readTimeline: (missionId): LineageEntry[] =>
    readExecFrames(missionId).map((f) => ({
      store: 'exec-frames',
      at: f.timestamp,
      seq: f.seq,
      ...(f.generation !== undefined ? { generation: f.generation } : {}),
      summary: `${f.op} ${f.status} · ${f.phaseTitle.slice(0, 28)}${f.arcName ? ` (${f.arcName})` : ''}${f.deviation ? ` ⚠️${f.deviation.kind}` : ''}`,
    })),
};

/** ⑤ grounding/research 캐시 — 저장 상태(freshness 무관·관측). */
const CACHE_SOURCE: LineageSource = {
  kind: 'cache',
  label: '조사 캐시',
  readTimeline: (missionId): LineageEntry[] => {
    const e = loadCacheEntryForObserve(missionId);
    if (!e) return [];
    const gen = e.generation;
    const out: LineageEntry[] = [];
    if (e.research && e.researchAt)
      out.push({ store: 'cache', at: e.researchAt, ...(gen !== undefined ? { generation: gen } : {}), summary: `research 캐시(6h TTL·enrich ${e.research.enrichments.length})` });
    const gsha = e.groundingFilesSha ?? e.groundingHeadSha; // H5 파일스코프 우선·하위호환 폴백
    if (e.grounding && gsha)
      out.push({ store: 'cache', ...(gen !== undefined ? { generation: gen } : {}), summary: `grounding 캐시 · SHA ${gsha.slice(0, 8)} · ${e.grounding.files.length}파일` });
    return out;
  },
};

/** ⑥ 관측(observation) — logs.db 의 mission.* + intent.* debug.log 를 미션별로 읽는 6번째 어댑터(L1).
 *  종전 69개 debug.log 카테고리(grounding·exec.context·coordinator·selfheal·hitl…)가 logs.db 에만 갇혀
 *  Historian 통합 타임라인에 안 뜨던 사각 수복. **emit 사이트 무변경**·pull-only(다른 5개 어댑터와 동형).
 *  RFC §2a 5-way 확장(대표 지시 2026-07-20). fail-soft(logs.db 없거나 open 실패=빈 타임라인). */
const OBSERVATION_SOURCE: LineageSource = {
  kind: 'observation',
  label: '관측(logs)',
  readTimeline: (missionId): LineageEntry[] => {
    const harnessRuns = (() => {
      try { return harnessRunsToLineage(readHarnessRunTimeline(missionId)); } catch { return []; }
    })();
    let store: LogStore | null = null;
    try {
      store = LogStore.openReadOnly(logsDbPath());
      // category prefix 'mission'/'intent' → mission.*/intent.* 전부. grep=missionId → 이 미션 데이터만
      //   (전역 sweep 등 missionId 없는 로그는 자동 제외). 최근 1000건(query 상한).
      const rows = store.query({ categories: ['mission', 'intent'], grep: missionId, limit: 1000 });
      return [...observationRowsToLineage(rows), ...harnessRuns];
    } catch {
      return harnessRuns;
    } finally {
      try { store?.close(); } catch { /* noop */ }
    }
  },
};

/** logs 행 → LineageEntry(순수·테스트용 분리). category[event] + data 요약 60자. */
export function observationRowsToLineage(
  rows: readonly { category: string; event: string; data: string | null; ts: string }[],
): LineageEntry[] {
  return rows.map((r) => {
    const d = (r.data ?? '').replace(/\s+/g, ' ').trim();
    return {
      store: 'observation' as const,
      at: r.ts,
      summary: `${r.category}[${r.event}]${d ? ` ${d.slice(0, 60)}` : ''}`,
    };
  });
}

/** 빌드 루프 6-way 소스 mount(멱등). CLI/데몬 진입 시 1회 — timeline 이 소비. */
export function mountBuiltinLineageSources(): void {
  mountLineageSource(GENERATION_ARCHIVE_SOURCE);
  mountLineageSource(WORKING_MEMORY_SOURCE);
  mountLineageSource(BUILD_FRAMES_SOURCE);
  mountLineageSource(EXEC_FRAMES_SOURCE);
  mountLineageSource(CACHE_SOURCE);
  mountLineageSource(OBSERVATION_SOURCE);
}
