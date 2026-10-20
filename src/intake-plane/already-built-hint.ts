// ── ALREADY-BUILT-HINT — «이미 있는 기능» 알림 원시함수 (UX · 0.2.34 칸) ──────────
//
// RFC-harness-full-journey-as-graph §4f 판정 — 다른 폴더의 «이미 있는 기능»을 새 요구로
// 넣으면 근거 링크(커밋·파일) 붙은 알림을 낸다 · 관련 없으면 0건 · 거절한 짝은 다시 묻지
// 않는다. 순수 함수·부수효과 0. 관련도 점수는 세션 검색의 trigram FTS5 원시함수
// (src/session/search-index.ts rankByTrigramFts — BM25, 낮을수록 관련도 높음)를 그대로
// 재사용한다. DEV-FEATURE-MAP 행을 넘겨 부르는 인테이크·저작 경로 배선(intake.hint
// 관측)은 다음 조각(남은 것)이다.

import { rankByTrigramFts, type RankedDoc, type RankResult } from '../session/search-index.js';
import { hashContent } from '../hasher.js';

/** DEV-FEATURE-MAP 한 행 — «이미 있는 기능» 후보. evidence 가 비면 그 행은 버린다(근거 없으면 침묵). */
export interface AlreadyBuiltFeature {
  readonly devProject: string;
  readonly feature: string;
  readonly text: string;
  readonly evidence: { readonly commit?: string; readonly file?: string };
}

/** 거절한 짝 — «요구 해시 ⊕ feature». 요구 해시는 hashContent(request)(sha256 hex). */
export interface AlreadyBuiltRefusedPair {
  readonly requestHash: string;
  readonly feature: string;
}

export type AlreadyBuiltHintKind = 'already' | 'similar';

/** A compact notification: one best match and at most two related matches. */
const MAX_ALREADY_BUILT_HINTS = 3;

/** 힌트 1건 — 근거 링크(커밋·파일) + BM25 점수(낮을수록 관련도 높음). */
export interface AlreadyBuiltHint {
  readonly kind: AlreadyBuiltHintKind;
  readonly devProject: string;
  readonly feature: string;
  readonly evidence: { readonly commit?: string; readonly file?: string };
  readonly score: number;
}

/** 근거 유무 — commit·file 중 하나라도 실값(빈 문자열 제외)이면 근거 있음. */
function hasEvidence(evidence: AlreadyBuiltFeature['evidence']): boolean {
  return (evidence.commit != null && evidence.commit !== '') || (evidence.file != null && evidence.file !== '');
}

/**
 * 새 요구가 «이미 있는 기능»을 가리키는지 판정하는 순수 함수.
 *
 * - 후보의 배열 인덱스를 sessionId 로 사용해 rankByTrigramFts(request, docs) 로
 *   BM25 관련도 점수를 매긴다(재사용 · 낮을수록 높음).
 * - evidence 가 비면 그 행은 버리고(근거 없으면 침묵) refused 짝(요구 해시 ⊕ feature)에
 *   있는 행은 뺀다.
 * - 매칭 행 중 관련도순 상위 3건만 내고, 첫 행(최고 관련도)은 kind='already',
 *   그 뒤는 kind='similar'.
 * - 관련 없는 요구·3자 미만 요구·FTS 오류·남는 후보 없음 → [] (출력 없음 = 침묵).
 */
export function alreadyBuiltHints(
  request: string,
  features: readonly AlreadyBuiltFeature[],
  refused: readonly AlreadyBuiltRefusedPair[],
): AlreadyBuiltHint[] {
  const requestHash = hashContent(request);
  const candidates = features.filter((f) =>
    hasEvidence(f.evidence)
    && !refused.some((p) => p.requestHash === requestHash && p.feature === f.feature),
  );
  if (candidates.length === 0) return [];

  const docs: RankedDoc[] = candidates.map((f, index) => ({
    sessionId: String(index),
    content: f.text,
  }));
  const ranked: RankResult[] | null = rankByTrigramFts(request, docs);
  if (!ranked || ranked.length === 0) return []; // 관련 없는 요구 · <3자 · FTS 오류 → 침묵

  const hints: AlreadyBuiltHint[] = [];
  for (const r of ranked.slice(0, MAX_ALREADY_BUILT_HINTS)) {
    const f = candidates[Number(r.sessionId)];
    if (!f) continue;
    hints.push({
      kind: hints.length === 0 ? 'already' : 'similar',
      devProject: f.devProject,
      feature: f.feature,
      evidence: { ...f.evidence },
      score: r.score,
    });
  }
  return hints;
}
