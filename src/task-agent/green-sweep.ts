/**
 * GREEN-FROM-LEDGER, first slice: decide from a bound card or an explicit
 * checklist evidence line.  This module never writes a checklist or card.
 */
import type { ChecklistItem } from '../release-loop/checklist.js';
import { debug } from '../debug/log.js';
import { cardPrNumber, type TaskCard } from './task-hand.js';

export type GreenSweepVerdict = 'green' | 'record-only' | 'skip';
export interface GreenSweepCandidate {
  cell: string;
  pr: number;
  source: 'card' | 'evidence';
  card?: TaskCard;
  ambiguousAcrossCards?: boolean;
}
export interface GreenSweepPr {
  number: number;
  state: string;
  mergeSha?: string;
  url?: string;
  viaTrain?: { integrationPr: number };
}
export interface GreenSweepDecision {
  cell: string;
  pr: number;
  mergeSha: string | null;
  source: GreenSweepCandidate['source'];
  verdict: GreenSweepVerdict;
  reason: string;
  /** Present when traffic hold state could not be read; preserves the decision reason while exposing its cause. */
  holdDiagnostic?: string;
  evidence: string;
  existingEvidence: string;
  /** Preview only; a later live operation may persist this complete value. */
  plannedEvidence: string;
}

/** PR-body mentions are intentionally absent from this parser. */
export function explicitEvidencePrs(evidence: string | undefined): number[] {
  const numbers = new Set<number>();
  for (const line of (evidence ?? '').split(/\r?\n/)) {
    // A previous refusal is diagnostic text, never new landing evidence.
    if (/^GREEN-FROM-LEDGER:/i.test(line) && !/· green ·/.test(line)) continue;
    // A negated landing claim cannot establish this cell's PR ownership.
    if (/미착지|미병합|예정|계획|아님|않음|안\s*함|보류|대기|실패|불가|아직|미완료|누락|못\s*함|(?:착지|병합)\s*전|\b(?:not\s+(?:yet\s+)?(?:merged|landed)|unmerged|pending|planned)\b/i.test(line)) continue;
    // A PR number only counts when this cell's own evidence calls it landed.
    for (const match of line.matchAll(/(?:착지|병합|merged|landed)\s*(?:PR\s*)?#(\d+)\b|(?:PR\s*)?#(\d+)\s*(?:착지|병합|merged|landed)(?=$|[^A-Za-z가-힣])/gi)) {
      const number = Number(match[1] ?? match[2]);
      if (Number.isSafeInteger(number) && number > 0) numbers.add(number);
    }
    for (const match of line.matchAll(/https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)\b\s*(?:착지|병합|merged|landed)|(?:착지|병합|merged|landed)\s*https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)\b/gi)) {
      const number = Number(match[1] ?? match[2]);
      if (Number.isSafeInteger(number) && number > 0) numbers.add(number);
    }
  }
  return [...numbers];
}

export function greenSweepCandidates(item: ChecklistItem, version: string, cards: readonly TaskCard[]): GreenSweepCandidate[] {
  if (item.status !== 'yellow' && item.status !== 'red') return [];
  const candidates = new Map<number, GreenSweepCandidate>();
  for (const number of explicitEvidencePrs(item.evidence)) candidates.set(number, { cell: item.id, pr: number, source: 'evidence' });
  for (const card of cards) {
    if (card.checklistId !== item.id || (card.checklistVersion && card.checklistVersion !== version)
      || (card.completion ?? 'code-pr') !== 'code-pr') continue;
    const pr = cardPrNumber(card);
    if (!pr) continue;
    // Multiple cards claiming one PR are ambiguous, even if one has a complete marker.
    if (candidates.get(pr)?.source === 'card') candidates.set(pr, { cell: item.id, pr, source: 'card' });
    else candidates.set(pr, { cell: item.id, pr, source: 'card', card });
  }
  return [...candidates.values()].map((candidate) => ({ ...candidate,
    ambiguousAcrossCards: cards.filter((card) => cardPrNumber(card) === candidate.pr).length > 1,
  })).sort((a, b) => a.pr - b.pr);
}

export function ambiguousGreenSweepPrs(items: readonly ChecklistItem[], version: string, cards: readonly TaskCard[]): Set<number> {
  const claims = new Map<number, Set<string>>();
  for (const item of items) {
    const numbers = new Set(explicitEvidencePrs(item.evidence));
    for (const card of cards) {
      if (card.checklistId === item.id && (!card.checklistVersion || card.checklistVersion === version)
        && (card.completion ?? 'code-pr') === 'code-pr') {
        const pr = cardPrNumber(card);
        if (pr) numbers.add(pr);
      }
    }
    for (const pr of numbers) {
      const cells = claims.get(pr) ?? new Set<string>();
      cells.add(item.id);
      claims.set(pr, cells);
    }
  }
  return new Set([...claims].filter(([, cells]) => cells.size > 1).map(([pr]) => pr));
}

export function appendGreenSweepEvidence(existing: string | undefined, line: string): string {
  const before = existing ?? '';
  if (before.split(/\r?\n/).includes(line)) return before;
  return `${before}${before && !before.endsWith('\n') ? '\n' : ''}${line}`;
}

/** A merge establishes ownership of a PR, not completion of a whole cell. */
export function decideGreenSweep(input: {
  item: ChecklistItem;
  candidate: GreenSweepCandidate;
  candidateCount: number;
  pr: GreenSweepPr | null;
  ancestor: boolean | null;
  hold: boolean | null;
  holdDiagnostic?: string;
  repositoryMatches?: boolean | null;
  ambiguousAcrossCells?: boolean;
}): GreenSweepDecision {
  const { item, candidate, pr } = input;
  const mergeSha = pr?.mergeSha && /^[a-f0-9]{40}$/i.test(pr.mergeSha) ? pr.mergeSha : null;
  const result = (verdict: GreenSweepVerdict, reason: string): GreenSweepDecision => {
    const landing = pr?.viaTrain ? ` via train #${pr.viaTrain.integrationPr}` : '';
    const evidence = `GREEN-FROM-LEDGER: PR #${candidate.pr}${landing}${mergeSha ? ` merged ${mergeSha}` : ''} · ${verdict} · ${reason}`;
    return { cell: item.id, pr: candidate.pr, mergeSha, source: candidate.source, verdict, reason,
      ...(reason === 'hold-state-unreadable' && input.holdDiagnostic ? { holdDiagnostic: input.holdDiagnostic } : {}),
      evidence, existingEvidence: item.evidence ?? '', plannedEvidence: appendGreenSweepEvidence(item.evidence, evidence) };
  };
  if (item.status !== 'yellow' && item.status !== 'red') return result('skip', 'cell-not-yellow');
  if (item.status === 'red') return result('skip', 'red-cell-requires-owner');
  if (!pr || pr.number !== candidate.pr) return result('skip', 'pr-unreadable');
  if (input.repositoryMatches === false) return result('skip', 'repository-mismatch');
  if (input.repositoryMatches !== true) return result('record-only', 'repository-unreadable');
  if (pr.state !== 'MERGED') return result('skip', `pr-${pr.state.toLowerCase()}`);
  if (pr.viaTrain && (candidate.card?.trainLanding?.componentPr !== candidate.pr
    || candidate.card.trainLanding.integrationPr !== pr.viaTrain.integrationPr
    || candidate.card.trainLanding.mergeSha !== pr.mergeSha)) return result('skip', 'train-binding-mismatch');
  if (!mergeSha) return result('skip', 'merge-sha-unreadable');
  if (input.ancestor === null) return result('record-only', 'origin-main-ref-unverified');
  if (!input.ancestor) return result('skip', 'merge-sha-not-on-origin-main');
  const explicitUrls = [...(item.evidence ?? '').matchAll(/https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\b/gi)]
    .map((match) => match[0]);
  if (explicitUrls.some((url) => /\/pull\/(\d+)\b/.exec(url)?.[1] === String(candidate.pr)
    && url.replace(/\/+$/, '').toLowerCase() !== (pr.url ?? '').replace(/\/+$/, '').toLowerCase()))
    return result('skip', 'evidence-pr-url-mismatch');
  if (/보류|중단|정지|\bhold\b/i.test(`${item.title}\n${item.evidence ?? ''}`))
    return result('skip', 'cell-stop-evidence');
  if (input.hold === null) return result('record-only', 'hold-state-unreadable');
  if (input.hold) return result('skip', 'traffic-hold');
  if (input.candidateCount !== 1) return result('record-only', 'multiple-piece-prs');
  if (input.ambiguousAcrossCells) return result('record-only', 'ambiguous-pr-across-cells');
  if (candidate.ambiguousAcrossCards) return result('record-only', 'ambiguous-pr-across-cards');
  if (/남은|나머지|후속|조각|분할|미착지|미병합|예정|계획|(?:착지|병합)\s*(?:실패|불가|아직|미완료|누락|못\s*함)|PR\s*#\d+\s*누락|추가\s*(?:작업|실물|검증|배선|조각|PR|필요)|(?:착지|실물|판정|검증|승인|운영)\s*대기|대기\s*(?:중|필요)|[1-9]차|(?:작업|검증|확인|운영|수리|배선)\s*필요|(?:일부|부분)(?:\s*범위(?:만)?)?\s*완료|잔여|미충족|미달|미완료|대체\s*후보/i.test(`${item.title}\n${item.evidence ?? ''}`))
    return result('record-only', 'remaining-or-multiple-piece-evidence');
  const verdictLines = [...(item.evidence ?? '').matchAll(/(?:^|\n)\s*(?:판정|결론|상태)\s*:\s*([^\n]+)/gi)];
  if (verdictLines.some((match) => !/^(?:green|완료|충족)(?:$|[\s·,.;])/i.test(match[1] ?? '')))
    return result('record-only', 'conflicting-cell-verdict-evidence');
  if (candidate.source === 'evidence') {
    const fullCellProof = /(?:^|\n)\s*(?:판정|결론|상태)\s*:\s*(?:green|완료|충족)(?:$|[\s·,.;])/i;
    return fullCellProof.test(item.evidence ?? '')
      ? result('green', 'explicit-cell-completion-evidence')
      : result('record-only', 'cell-completion-not-explicit');
  }
  const card = candidate.card;
  if (!card) return result('record-only', 'ambiguous-card-binding');
  if (!card.checklistVersion) return result('record-only', 'card-version-unbound');
  if (card.status !== 'done') return result('record-only', 'card-not-done');
  if (card.postLand && (card.postLand.outcome !== 'complete' || card.postLand.remaining.length > 0))
    return result('record-only', 'card-post-land-incomplete');
  if (card.history.some((event) => event.event === 'closed-by-hand'))
    return result('record-only', 'card-stop-evidence');
  if (typeof card.pr === 'object' && pr.url && card.pr.url
    && card.pr.url.replace(/\/+$/, '') !== pr.url.replace(/\/+$/, ''))
    return result('record-only', 'card-pr-url-mismatch');
  if (card.prTerminal?.state === 'CLOSED' && !pr.viaTrain) return result('record-only', 'card-terminal-conflict');
  return result('green', card.postLand?.outcome === 'complete' ? 'bound-card-complete' : pr.viaTrain ? 'bound-card-train-merged' : 'bound-card-merged');
}

/** Every candidate emits one structured decision, including refusals. */
export function observeGreenSweep(decision: GreenSweepDecision, log: typeof debug.log = debug.log.bind(debug)): void {
  log('task-agent.green-sweep', decision.verdict,
    { cell: decision.cell, pr: decision.pr, mergeSha: decision.mergeSha, reason: decision.reason });
}
