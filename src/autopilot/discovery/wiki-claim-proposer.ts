// ── DocOps · claim 단위 WIKI 갱신 제안기 (미션 668871 arc3 페이즈4 · 2026-07-14) ──
//
// 구 핸드오프의 생존 지식을 **문서 전체 요약이 아닌 claim 단위**로 추출해, 기존 하이브리드 검색으로
// 대상 WIKI-* living 페이지를 골라 doc-curate 큐에 제안한다. 핵심 규율(미션 불변식):
//   · 각 claim proposal 에 원문 구절·출처 경로·마지막 검증 시점(provenance) 필수 — 하나라도 없으면
//     제안이 성립하지 않는다(rejected 관측): 어떤 페이지에도 자동 쓰기·고치기·링크 제안을 남기지 않는다.
//   · 기존 claim 과 충돌하면 **덮어쓰지 않고** 병렬 근거 + contradiction 플래그(비파괴).
//   · 출력은 doc-curate CurationProposal(큐) 로만 — 자동 이동·병합·archive 없음(HITL 승인 게이트).
//   · 깨진 판정을 LLM 에 안 맡김(결정론 추출·검색/충돌만 주입). 새 큐/파서 안 만들고 재사용.

import { createHash } from 'node:crypto';
import { debug } from '../../debug/log.js';
import type { CurationItem, CurationProposal } from './doc-curation.js';

export interface Claim {
  /** claim 진술(생존 지식 한 조각). */
  text: string;
  /** 원문 구절(provenance). */
  sourceQuote: string;
  /** 출처 경로(provenance) — 구 핸드오프 등. */
  sourcePath: string;
  /** 마지막 검증 시점(provenance) — YYYY-MM-DD. */
  lastVerified: string;
}

/** 핸드오프 본문 → claim 단위 추출(순수). 생존지식 후보 = 불릿·강조 진술(전체 요약 아님).
 *  코드/링크/메타 라인·너무 짧은 조각 제외. 결정론. */
export function extractClaims(text: string, sourcePath: string, nowDate: string): Claim[] {
  const claims: Claim[] = [];
  const seen = new Set<string>();
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    const bullet = /^[-*]\s+(.{16,})/.exec(t);
    const body = bullet ? bullet[1]! : (/^\*\*.{16,}\*\*/.test(t) ? t : '');
    if (!body) continue;
    if (/^https?:|^\||^#|^```|^\s*<|=====/.test(body)) continue; // 코드/링크/메타 제외
    const clean = body
      .replace(/\*\*/g, '')
      .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1') // wiki 링크 → 텍스트
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')          // md 링크 → 텍스트
      .replace(/`([^`]+)`/g, '$1')
      .trim();
    if (clean.length < 16) continue;
    const key = clean.slice(0, 60).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    claims.push({ text: clean.slice(0, 240), sourceQuote: t.slice(0, 300), sourcePath, lastVerified: nowDate });
  }
  return claims;
}

const WIKI_CLAIM_DISCARD_REASON = 'no-matching-wiki-page' as const;
const WIKI_CLAIM_REJECT_REASON = 'missing-provenance' as const;

export interface WikiClaimStatistics {
  receivedClaims: number;
  proposedItems: number;
  discardedClaims: number;
  discarded: {
    reason: typeof WIKI_CLAIM_DISCARD_REASON;
    sourcePaths: string[];
  };
  /** 가산 관측(근거 필수 불변식 시행) — provenance 없어 명시적 거부된 claim. 0건이면 기존 계약 보존을 위해 필드를 싣지 않는다. */
  rejected?: {
    reason: typeof WIKI_CLAIM_REJECT_REASON;
    claims: number;
    sourcePaths: string[];
  };
}

export type WikiClaimItems = CurationItem[] & { statistics: WikiClaimStatistics };

export interface WikiClaimDeps {
  /** claim → 대상 WIKI-* living 페이지(하이브리드 검색·주입). null=대상 없음(자동 신규 생성 안 함). */
  findWikiPage: (claim: Claim) => string | null;
  /** 대상 WIKI 페이지 현재 본문(충돌 검사·null=아직 없음). */
  readWikiPage?: (path: string) => string | null;
  /** 충돌 판정(기본 휴리스틱). 의미판정 주입 가능. */
  detectConflict?: (claim: Claim, existing: string) => boolean;
  /** 테스트/커스텀 주입용 구조화 관측 sink. */
  logSink?: (category: string, event: string, data: WikiClaimStatistics) => void;
}

/** 기본 충돌 휴리스틱(결정론·보수) — claim 주제어가 기존에 있고 claim 에 부정/변경 신호가 있으면 충돌 의심.
 *  애매하면 충돌 아님(병렬 근거는 항상 append·비파괴라 안전). */
export function defaultDetectConflict(claim: Claim, existing: string): boolean {
  const kw = [...new Set(claim.text.toLowerCase().match(/[a-z0-9]{4,}|[가-힣]{2,}/g) ?? [])];
  if (kw.length < 2) return false;
  const ex = existing.toLowerCase();
  const hit = kw.filter((k) => ex.includes(k)).length;
  const neg = /아니|없|금지|대신|변경|폐기|틀렸|반대|no longer|not |deprecat|instead|wrong/i.test(claim.text);
  // 공유 주제어 ≥2(같은 대상을 말함) + 부정/변경 신호 → 충돌 의심. 애매하면 충돌 아님(병렬 append 는 안전).
  return hit >= 2 && neg;
}

/** 근거(provenance 3요소 — 원문 구절·출처 경로·마지막 검증 시점)가 온전한가. 하나라도 비면 제안이 성립하지 않는다. */
function hasCompleteProvenance(claim: Claim): boolean {
  return claim.sourceQuote.trim() !== '' && claim.sourcePath.trim() !== '' && claim.lastVerified.trim() !== '';
}

/** claim → CurationItem (add/update · provenance · 충돌 시 contradiction 플래그·비파괴 diff). 순수+주입. */
export function proposeWikiClaimItems(claims: readonly Claim[], deps: WikiClaimDeps): WikiClaimItems {
  const detect = deps.detectConflict ?? defaultDetectConflict;
  const items = [] as unknown as WikiClaimItems;
  const discardedSourcePaths: string[] = [];
  const rejectedSourcePaths: string[] = [];
  for (const c of claims) {
    if (!hasCompleteProvenance(c)) {
      rejectedSourcePaths.push(c.sourcePath);
      continue; // 근거 필수 불변식 — provenance 없는 claim 은 쓰기·고치기·링크 제안으로 성립하지 않는다.
    }
    const page = deps.findWikiPage(c);
    if (!page) {
      discardedSourcePaths.push(c.sourcePath);
      continue; // 대상 living 페이지 없음 — 자동 신규 생성 금지(HITL).
    }
    const existing = deps.readWikiPage?.(page) ?? null;
    const isNew = existing == null || existing.trim() === '';
    const conflict = !isNew && detect(c, existing!);
    const prov = `provenance: ${c.sourcePath} · verified ${c.lastVerified}`;
    items.push({
      action: isNew ? 'add' : 'update',
      path: page,
      targetDocument: page,
      filename: page.split('/').pop() ?? page,
      reason: `[claim] ${c.text}${conflict ? ' [CONTRADICTION — 병렬 근거 유지·원문 미변경]' : ''} (${prov})`,
      evidenceQuote: c.sourceQuote,
      sourcePath: c.sourcePath,
      diff: conflict
        ? `append parallel-evidence + contradiction-flag (원문 보존·비파괴):\n+ ${c.text}\n+ ⚠️ contradiction (${prov})`
        : `append claim (비파괴):\n+ ${c.text}\n+ (${prov})`,
      confidence: conflict ? 0.6 : 0.85,
      detectorVersion: 'wiki-claim-proposer-v1',
      inboundRefs: 0,
    });
  }
  const statistics: WikiClaimStatistics = {
    receivedClaims: claims.length,
    proposedItems: items.length,
    discardedClaims: discardedSourcePaths.length,
    discarded: { reason: WIKI_CLAIM_DISCARD_REASON, sourcePaths: discardedSourcePaths },
    ...(rejectedSourcePaths.length > 0
      ? { rejected: { reason: WIKI_CLAIM_REJECT_REASON, claims: rejectedSourcePaths.length, sourcePaths: rejectedSourcePaths } }
      : {}),
  };
  Object.defineProperty(items, 'statistics', { value: statistics, enumerable: false });
  try {
    const log = deps.logSink ?? ((category, event, data) => debug.log(category, event, data));
    log('autopilot.discovery', 'wiki-claim-proposal', statistics);
  } catch { /* observability must not prevent deterministic proposal generation */ }
  return items;
}

export interface WikiClaimProposalOpts {
  /** 결정론 타임스탬프(ISO). 호출측이 주입(테스트·재현성). */
  nowIso: string;
  model?: string;
  /** 멱등 억제 — 이미 큐에 있는 키면 suppressed 빈 제안(중복 방지). */
  existingIdempotencyKeys?: Set<string>;
}

/** items → CurationProposal 봉투(doc-curate 큐 재사용·멱등키·status=proposed·자동적용 없음). */
export function buildWikiClaimProposal(
  items: CurationItem[], sourceText: string, opts: WikiClaimProposalOpts, wikiClaimStatistics?: WikiClaimStatistics,
): CurationProposal {
  const model = opts.model ?? 'deterministic-wiki-claim';
  const promptVersion = 'wiki-claim-v1';
  const schemaVersion = 'docops-curation-v1';
  const h = (s: string): string => createHash('sha256').update(s).digest('hex');
  const inputDocumentHash = h(sourceText).slice(0, 32);
  const idempotencyKey = h(`${inputDocumentHash}\0${model}\0${promptVersion}\0${schemaVersion}`).slice(0, 32);
  if (opts.existingIdempotencyKeys?.has(idempotencyKey)) {
    return { generatedAt: opts.nowIso, scanned: items.length, items: [], status: 'proposed', inputDocumentHash, model, promptVersion, schemaVersion, idempotencyKey, suppressed: true, ...(wikiClaimStatistics ? { wikiClaimStatistics } : {}) };
  }
  return { generatedAt: opts.nowIso, scanned: items.length, items, status: 'proposed', inputDocumentHash, model, promptVersion, schemaVersion, idempotencyKey, ...(wikiClaimStatistics ? { wikiClaimStatistics } : {}) };
}

/** 핸드오프 텍스트 → claim 추출 → WIKI 제안 items → CurationProposal(end-to-end·순수+주입). */
export function proposeWikiClaimsFromHandoff(
  text: string, sourcePath: string, deps: WikiClaimDeps, opts: WikiClaimProposalOpts & { nowDate: string },
): CurationProposal {
  const claims = extractClaims(text, sourcePath, opts.nowDate);
  const items = proposeWikiClaimItems(claims, deps);
  return buildWikiClaimProposal(items, text, opts, items.statistics);
}
