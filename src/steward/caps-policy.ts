import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

export interface StewardCapsPolicy {
  readonly reclaimPerHand: number; readonly candidatesPerHand: number;
  readonly boardCardsPerHand: number; readonly splitPiecesPerHand: number;
  readonly throughputCardsPerHand: number; readonly landSlotsPerHand: number;
}
export interface StewardCaps {
  readonly reclaim: number; readonly candidates: number; readonly boardCards: number;
  readonly splitPieces: number; readonly throughputCards: number; readonly landSlots: number;
}

export function loadStewardCapsPolicy(root = resolve(import.meta.dir, '../..')): StewardCapsPolicy {
  const value = parse(readFileSync(resolve(root, 'graphs/policies/steward-caps.yaml'), 'utf8')) as Record<string, unknown>;
  const ratio = (key: string): number => {
    const n = value?.[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new Error(`steward caps: invalid ${key}`);
    return n;
  };
  return {
    reclaimPerHand: ratio('reclaim_per_hand'), candidatesPerHand: ratio('candidates_per_hand'),
    boardCardsPerHand: ratio('board_cards_per_hand'), splitPiecesPerHand: ratio('split_pieces_per_hand'),
    throughputCardsPerHand: ratio('throughput_cards_per_hand'), landSlotsPerHand: ratio('land_slots_per_hand'),
  };
}

export function stewardCaps(policy: StewardCapsPolicy, hands: number | null): StewardCaps | null {
  if (hands === null || !Number.isSafeInteger(hands) || hands < 0) return null;
  const caps = {
    reclaim: Math.ceil(policy.reclaimPerHand * hands), candidates: Math.ceil(policy.candidatesPerHand * hands),
    boardCards: Math.ceil(policy.boardCardsPerHand * hands), splitPieces: Math.ceil(policy.splitPiecesPerHand * hands),
    throughputCards: Math.ceil(policy.throughputCardsPerHand * hands), landSlots: Math.ceil(policy.landSlotsPerHand * hands),
  };
  return Object.values(caps).every(n => Number.isSafeInteger(n) && n >= 0) ? caps : null;
}
