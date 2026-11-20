// ── 기억 생애주기 오케스트레이터 (REM/미엘린 회고 루프 · 2026-07-10) ──────────
//
// 대표 지적: 세션 대량 정비 후 회고 루프(REM 리플레이·미엘린 consolidation)가 전혀
// 안 돌았다 — 기억 생애주기 코드(M1-M5)는 있으나 어떤 스케줄에도 배선 안 됨. 이 모듈은
// 그 단계들을 한 사이클로 순서대로 돌린다(새벽 idle 창). 각 단계 fail-soft(하나 실패해도
// 다음 진행). 실제 함수는 이미 개별 테스트됨 — 여기는 순서·집계·견고성만.
//
// 순서(대표 승인·전 단계 arm): replay → decay → consolidate → archive(Glacier S3) → prune.
//  - replay(축B): 중요/신규/최근 에피소드 우선 재활성화(recall_count++·SWR/PER) — decay 前이라
//    강화가 stability→tier 재계산에 반영(중요 기억 hot 잔류·prune 보호). 순수 메모리(미션 무접촉).
//  - rif(축B): decay 後 경쟁 억제 — 승자 있는 클러스터의 warm·미회상·저현저 기억을 cold 조기
//    강등(retrieval-induced forgetting·삭제 아님·복원 가능). archive 前이라 그 주기 S3 이관.
//  - decay(M1): tier 재계산(강등만·삭제 안 함·가역).
//  - consolidate(M3/M4): 세션 recap(증분 consolidated=0) + 에피소드 umbrella 압축.
//  - archive(M2): cold 기억 S3 이관(로컬서 빠지고 S3 영속·복원 가능·삭제 아님).
//  - prune: 오래(>90d)+안중요(imp<5)+미회상(recall=0) 이벤트만 정리(미엘린·중요 보존).
// 증분: consolidate 는 consolidated=0 만, archive/prune 은 cold/stale 만 대상(자연 증분).

export interface ReplayLike { candidates: number; strengthened: number; themes: string[] }
export interface DecayLike { hot: number; warm: number; cold: number; changed: number }
export interface RifLike { clusters: number; suppressed: number }
export interface RecapLike { sessions: number; promoted: number }
export interface ConsolidateLike { groups: number; consolidated: number; skipped: number }
export interface ArchiveLike { archived: number; skipped: number }

/** 각 단계 실행 thunk(실 DB 주입은 스크립트). 전 단계 fail-soft. */
export interface MemoryLifecycleStages {
  replay: () => ReplayLike;   // 축B — 활동의존 우선순위 replay(decay 前·중요/신규 강화)
  decay: () => DecayLike;
  rif: () => RifLike;         // 축B — RIF 경쟁 억제(decay 後·승자 있는 클러스터의 경쟁 기억 조기 강등)
  recaps: () => RecapLike;
  consolidate: () => Promise<ConsolidateLike>;
  archive: () => ArchiveLike;
  pruneEvents: () => number;
  pruneKnowledge: () => number;
}

export interface StageError { stage: string; error: string }

export interface MemoryLifecycleReport {
  replay: ReplayLike | null;
  decay: DecayLike | null;
  rif: RifLike | null;
  recaps: RecapLike | null;
  consolidate: ConsolidateLike | null;
  archive: ArchiveLike | null;
  prunedEvents: number | null;
  prunedKnowledge: number | null;
  errors: StageError[];
}

function guard<T>(stage: string, errors: StageError[], fn: () => T): T | null {
  try { return fn(); }
  catch (e) { errors.push({ stage, error: e instanceof Error ? e.message : String(e) }); return null; }
}

async function guardAsync<T>(stage: string, errors: StageError[], fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); }
  catch (e) { errors.push({ stage, error: e instanceof Error ? e.message : String(e) }); return null; }
}

/** 기억 생애주기 1 사이클 — replay→decay→rif→consolidate→archive→prune 순서·fail-soft·집계. */
export async function runMemoryLifecycle(stages: MemoryLifecycleStages): Promise<MemoryLifecycleReport> {
  const errors: StageError[] = [];
  const replay = guard('replay', errors, stages.replay);              // 축B — 중요/신규 재활성화(decay 前)
  const decay = guard('decay', errors, stages.decay);
  const rif = guard('rif', errors, stages.rif);                       // 축B — RIF 경쟁 억제(decay 後·archive 前)
  const recaps = guard('recaps', errors, stages.recaps);              // M4 세션 recap(증분)
  const consolidate = await guardAsync('consolidate', errors, stages.consolidate); // M3 에피소드 압축
  const archive = guard('archive', errors, stages.archive);          // M2 Glacier(cold→S3) — decay 후라 cold 확정
  const prunedEvents = guard('prune-events', errors, stages.pruneEvents);   // archive 후라 S3 이관된 것 로컬 정리 안전
  const prunedKnowledge = guard('prune-knowledge', errors, stages.pruneKnowledge);
  return { replay, decay, rif, recaps, consolidate, archive, prunedEvents, prunedKnowledge, errors };
}

/** 사람이 읽는 1줄 요약(로그·발송용). */
export function summarizeLifecycle(r: MemoryLifecycleReport): string {
  const parts: string[] = [];
  if (r.replay && r.replay.strengthened > 0) parts.push(`replay(강화${r.replay.strengthened}/${r.replay.candidates})`);
  if (r.decay) parts.push(`decay(hot${r.decay.hot}/warm${r.decay.warm}/cold${r.decay.cold}·변경${r.decay.changed})`);
  if (r.rif && r.rif.suppressed > 0) parts.push(`rif(억제${r.rif.suppressed}·클러스터${r.rif.clusters})`);
  if (r.recaps) parts.push(`recap(세션${r.recaps.sessions}→${r.recaps.promoted})`);
  if (r.consolidate) parts.push(`consolidate(그룹${r.consolidate.groups}·압축${r.consolidate.consolidated}·skip${r.consolidate.skipped})`);
  if (r.archive) parts.push(`archive(S3 ${r.archive.archived}·skip${r.archive.skipped})`);
  if (r.prunedEvents != null) parts.push(`prune(이벤트${r.prunedEvents}·지식${r.prunedKnowledge ?? 0})`);
  if (r.errors.length) parts.push(`⚠️오류${r.errors.length}(${r.errors.map(e => e.stage).join(',')})`);
  return parts.join(' · ') || '변화 없음';
}

/** 정리 단계를 «각각 독립» 으로 끝까지 돈다 — 앞 단계가 던져도 다음 단계는 실행된다(예외는 모아 반환). */
export function runAllCleanups(steps: Array<{ name: string; fn: () => void }>): StageError[] {
  const errors: StageError[] = [];
  for (const step of steps) guard(step.name, errors, step.fn);
  return errors;
}
