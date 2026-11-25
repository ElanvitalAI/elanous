#!/usr/bin/env bun
// ── R3 지식레이어 인제스트 (2026-07-06 · 일 1회 크론) ────────────────────
// 유의 뉴스신호(6+)·디깅 리포트·주간 알파 리포트를 임베딩해
// ~/.elanous/conatus/knowledge.db 에 멱등 영속. 90일 휘발(pruneOld) 전에
// 지식만 남긴다 — 인제스트가 매일 돌므로 휘발 대상은 항상 이미 영속됨.
//
// cron: 45 20 * * * (KST — 주간증류 20:00 · 주간알파 20:30 뒤)
// 사용: bun scripts/knowledge-ingest.ts [--stats]

import { openKnowledgeDb, ingestKnowledge, ingestDocsCorpus, pruneKnowledge, knowledgeStats, backfillDocsFts } from '../src/domains/knowledge.js';
import { openSurfaceEventsDb, applyMemoryDecay, pruneStaleEvents, surfaceEventsDbPath } from '../src/domains/surface-events.js';
import { archiveColdEvents } from '../src/domains/memory-archive.js';
import { consolidateEpisodes, promoteSessionRecaps } from '../src/domains/memory-consolidate.js';
import { existsSync } from 'node:fs';
import { resolveSearchRoots } from '../src/knowledge/search-roots.js';

// 07-07 관찰 수리: homebrew/bun 주입만으론 부족(node=nvm 전용) — nvm bin 동적 주입.
import { ensureCronNodePath } from '../src/domains/cron-path.js';
ensureCronNodePath();

const db = openKnowledgeDb();

if (process.argv.includes('--stats')) {
  const st = knowledgeStats(db);
  console.log(`knowledge.db: 총 ${st.total}건 — ${st.byKind.map(k => `${k.kind} ${k.n}`).join(' · ') || '(비어있음)'}`);
  db.close();
  process.exit(0);
}

const t0 = Date.now();
// P2 — FTS 백필(기존 코퍼스 1회 색인·이후 멱등 no-op — 신규 행은 insert 시 동기).
try { const n = backfillDocsFts(db); if (n > 0) console.log(`docs_fts 백필: ${n}행`); } catch { /* fail-soft */ }
const counts = await ingestKnowledge(db);
// ★ M5 knowledge retention — 오래된 저가치 raw(signal/outbound) 정리(코퍼스 관리·docs/memory 보존).
let kpruned = 0;
try { kpruned = pruneKnowledge(db); } catch { /* fail-soft */ }
// ★ self-awareness(P3) — 구현/설계 문서(docs/HANDOFF·REPORT·PLAN·FEATURE…) 자동
//   벡터화(domain=elanous). elanous 가 "내가 뭘 구현했나"를 self_recall 벡터 층으로 회상.
//   DocOps P0(2026-07-13): mtime 증분(무변경=stat만·수정=구청크 교체·living doc 갱신
//   반영) + doc-lint taxonomy와 재귀 inventory를 재사용해 canonical 문서 전체를 합류한다.
//   DOCS-SEARCH-INDEX-EMPTY: 뿌리 해석+순회+per-root debug.log 를 ingestDocsCorpus 가
//   책임진다 — 크론과 docs search 색인 자가부트가 같은 해석을 공유한다(현행 절 후보 포함).
// 단일 해석기 — env ELANOUS_DOCS_ROOTS > config knowledge.docsRoots > undefined(자동 감지).
const configuredRoots = resolveSearchRoots().docsRoots;
const docs = await ingestDocsCorpus(db, {
  docsRoots: configuredRoots,
  toolModuleUrl: import.meta.url,
  toolDocsSegments: ['..', 'docs'],
});
const st = knowledgeStats(db);
const docsIndexed = st.byKind.find((k) => k.kind === 'docs')?.n ?? 0;
db.close();

// ★ M1 graded decay(2026-07-08) — 먼저 stability 기반 tier 강등(삭제 아님·흐려짐만),
//   그 다음 P4.3 미엘린 retention prune(하드 삭제 안전밸브·미엘린/중요는 보존).
let pruned = 0;
let decay = { hot: 0, warm: 0, cold: 0, changed: 0 };
let arch = { archived: 0, skipped: 0 };
let cons = { groups: 0, consolidated: 0, skipped: 0 };
let recap = { sessions: 0, promoted: 0 };
if (existsSync(surfaceEventsDbPath())) {
  const sdb = openSurfaceEventsDb();
  try {
    decay = applyMemoryDecay(sdb);       // M1: hot→warm→cold 강등(stability 곡선)
    recap = promoteSessionRecaps(sdb);   // M4: 흐린 세션 대화 턴 → session-recap 에피소드 승격
    // M3: 흐린 에피소드(warm/cold) → 의미 umbrella 압축(knowledge kind='memory'·원본 consolidated 마킹).
    const kdb2 = openKnowledgeDb();
    try { cons = await consolidateEpisodes(sdb, kdb2); } catch { /* fail-soft(임베딩 불가) */ } finally { kdb2.close(); }
    arch = archiveColdEvents(sdb);       // M2: cold → S3 Glacier 이관(삭제 아님·S3 불가 시 no-op)
    pruned = pruneStaleEvents(sdb);      // 안전밸브: 잔여 오래된 비중요·비회상 하드 삭제
  } catch { /* fail-soft */ } finally { sdb.close(); }
}

console.log([
  `지식레이어 인제스트 완료 (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  `신규: 신호 ${counts.signals} · 디깅 ${counts.digs} · 알파 ${counts.alpha} · 발송 ${counts.outbound} · 문서 ${docs.chunks}청크(${docs.files}파일·갱신 ${docs.refreshed}·무변경 ${docs.unchanged})` +
    (counts.skipped || docs.skipped ? ` · 실패skip ${counts.skipped + docs.skipped}(다음 주기 재시도)` : ''),
  `누적: 총 ${st.total}건 — ${st.byKind.map(k => `${k.kind} ${k.n}`).join(' · ')}${kpruned ? ` · M5정리 ${kpruned}건` : ''}`,
  `색인 문서 ${docsIndexed}건 — docs search 하이브리드 검색의 docs 코퍼스(kind=docs)`,
  `기억 계층(M1-M4): hot ${decay.hot} · warm ${decay.warm} · cold ${decay.cold}(강등 ${decay.changed}) · 세션recap ${recap.sessions}(${recap.promoted}턴) · 압축 ${cons.consolidated}→${cons.groups}umbrella · S3이관 ${arch.archived}${arch.skipped ? `(skip ${arch.skipped})` : ''} · 하드망각 ${pruned}건`,
].join('\n'));
