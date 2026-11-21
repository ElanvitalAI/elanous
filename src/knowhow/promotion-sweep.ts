#!/usr/bin/env bun
// ── 같은 꼴 실패 3회 → 노하우 승화 스윕 (POST-TURN-LESSON-REVIEW · 2026-11-21) ──────
//
// 칸: MEM-LESSON-TO-KNOWHOW-PROMOTION(ROSTER-0332). 그래프 조리법(graphs/memory/recipes.yaml
// · post-turn-lesson-review)이 부르는 노드: 교훈 원장의 후보(candidate) 중 같은 꼴 실패를
// threshold(기본 3)회 이상 반복한 교훈을 노하우 팩 조항으로 승화한다. 조항 id 는 내용
// 해시로 결정론적이므로 재실행은 중복을 만들지 않는다(중복 0). 실패는 fail-soft(Exit 0).

import { LessonLedger } from '../lessons/lesson-ledger.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';

export interface SweepClause { lessonId: string; clauseId: string; duplicate: boolean }
export interface SweepResult {
  scanned: number;       // 후보(candidate) 행 수
  promoted: number;      // 이번 실행에 새로 승화된 조항 수(중복 제외)
  clauses: SweepClause[]; // 승화(또는 중복 판정)된 조항
}

/** 후보 중 반복 threshold(기본 3)회 이상인 교훈을 승화. 재실행 → promoted 0 · 중복 0. */
export function sweepLessonPromotions(
  opts: { stateDir?: string; threshold?: number; now?: () => Date } = {},
): SweepResult {
  const ledger = new LessonLedger({ stateDir: opts.stateDir, now: opts.now });
  const threshold = opts.threshold ?? 3;
  const clauses: SweepClause[] = [];
  // ★ 후보는 스윕 진입 시점 스냅샷으로 한 번만 읽는다 — 승격 뒤 다시 읽으면 promoted 행이
  //   빠져 scanned 가 0으로 오인된다(승격 여부와 무관한 후보 행 수여야 한다).
  const candidates = ledger.candidates();
  for (const candidate of candidates) {
    if (candidate.occurrence_count < threshold) continue;
    const { clause, duplicate } = ledger.promoteToKnowhow(candidate.id, { by: 'knowhow-sweep', threshold });
    clauses.push({ lessonId: candidate.id, clauseId: clause.id, duplicate });
  }
  return { scanned: candidates.length, promoted: clauses.filter((c) => !c.duplicate).length, clauses };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const result = dry
    ? (() => {
      const ledger = new LessonLedger({ stateDir: elanousStateRoot() });
      const threshold = 3;
      const eligible = ledger.candidates().filter((c) => c.occurrence_count >= threshold);
      return { dryRun: true, threshold, eligible: eligible.map((c) => ({ lessonId: c.id, occurrences: c.occurrence_count })) };
    })()
    : (() => {
      const sweep = sweepLessonPromotions({ stateDir: elanousStateRoot() });
      return { dryRun: false, ...sweep };
    })();
  console.log(JSON.stringify(result));
}