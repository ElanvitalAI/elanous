/**
 * CONTEXT-BUS-FEDERATION (0.3.39 P0 · CEO 11-28 08:4x «맥락 버스가 Claude OP↔eln OP 사이 말고도 주요 서브 조율자 사이에도 ·
 * 나중에는 주요 루프 에이전트(수호자 등) 사이에도») — which bus spaces a seat reads, and where a notice for a seat lands.
 *
 * S: the bus had one space in use (OP: 200 items = CLAUDE-OP 168 · GUARDIAN 30 · eln OP 2); TC·JUD·UX·MK·HQ spaces held 0.
 *    Coordinators decided, committed and handed off by mail only, and the turn digest read space OP alone.
 * C: no hard-coded seat list (the federation org map says who leads a space and who reads conversationally) · the OP space
 *    stays as it is (Claude OP ↔ eln OP) · raw CEO words remain context only (seat-turn.ts) · a notice goes to the bus only
 *    when its reader is known to read the bus, otherwise it stays mail.
 * Q: what does each seat's turn carry from the bus, and where does a loop agent's notice for a seat go?
 * A: `busSpacesForSeat` — the seat's own space (full view) ⊕ HQ for every conversational space leader (full) ⊕ OP for every
 *    other seat (only items addressed to it: Claude OP's handoffs). `busL0Space` walks the ✋ ladder to the first seat that
 *    reads in a conversation (a loop-agent kingdom such as RES → OP). `busReaderSeen` = that seat acked a digest recently.
 *
 * 세 얼굴: 관측 = `eln bus spaces --for <seat>` · 인지 = these pure resolvers over the org map ⊕ the ack log ·
 *          수복과 인계 = an unreadable org map falls back to DEFAULT_ORG (loadOrgMap) · no recent ack → the caller keeps mail.
 */
import { BUS_DEFAULT_SPACE, readAcks } from './bus.js';
import { isConversationalSeat, loadOrgMap, orgParentOf, type OrgDeps, type OrgMap } from '../org/org-map.js';

/** The space every conversational coordinator reads and writes (cross-coordinator decisions · handoffs to all). */
export const BUS_HQ_SPACE = 'HQ';
/** The Claude OP proxy reads and writes the OP space (it is not a space of its own). */
const PROXY_SEAT = 'CLAUDE-OP';
/** full = every item of the space · addressed = only items addressed to the seat (owner · `seat:<SEAT>` ref). */
export type BusView = 'full' | 'addressed';
export interface SeatBusSpace { readonly space: string; readonly view: BusView }

const up = (s: string): string => s.trim().toUpperCase();

/** The one prompt line coordinators (OP profile · leader card) carry — decisions travel as bus types, mail only asks. */
export const BUS_WRITE_RULE_LINE = '- 결정·약속·인계는 버스 타입으로 남긴다: `eln bus post --as <내 자리> --type decision|commitment|handoff|status <본문>` (기본 = 내 판 · 조율자 간 = `--space HQ` · 한 자리에 인계 = `--space <받는 자리> --owner <받는 자리>`) · 우편은 요청·✋ 만.';

/** The seat's own space (CLAUDE-OP writes and reads OP). */
export function busOwnSpace(seat: string): string {
  const s = up(seat);
  return s === PROXY_SEAT ? BUS_DEFAULT_SPACE : s;
}

/** A conversational seat that leads a space of the org map (OP for hq · TC · MK · UX · JUD …) — loop-agent kingdoms excluded. */
export function isBusCoordinator(org: OrgMap, seat: string): boolean {
  const s = up(seat);
  return Object.values(org.spaces).some((sp) => sp.leader === s) && isConversationalSeat(org, s);
}

/** Pure: the spaces `seat`'s turn digest carries, own space first. */
export function busSpacesForSeat(seat: string, org: OrgMap): SeatBusSpace[] {
  const s = up(seat);
  const own = busOwnSpace(s);
  const out: SeatBusSpace[] = [{ space: own, view: 'full' }];
  if (isBusCoordinator(org, s) && own !== BUS_HQ_SPACE) out.push({ space: BUS_HQ_SPACE, view: 'full' });
  if (own !== BUS_DEFAULT_SPACE) out.push({ space: BUS_DEFAULT_SPACE, view: 'addressed' });
  return out;
}

/** Live: the spaces for `seat` from the federation declaration (DEFAULT_ORG when absent or unreadable). */
export function liveBusSpacesForSeat(seat: string, deps: OrgDeps = {}): SeatBusSpace[] {
  let org: OrgMap;
  try { org = loadOrgMap(deps).org; } catch { org = (require('../org/org-map.js') as typeof import('../org/org-map.js')).DEFAULT_ORG; }
  return busSpacesForSeat(seat, org);
}

/** Pure: is `space` a space somebody reads? HQ · OP · any seat of the org map · the writer's own space. */
export function busKnownSpace(space: string, org: OrgMap, writer?: string): boolean {
  const s = up(space);
  if (s === BUS_HQ_SPACE || s === BUS_DEFAULT_SPACE) return true;
  if (writer && busOwnSpace(writer) === s) return true;
  return Object.hasOwn(org.seats, s) || Object.values(org.spaces).some((sp) => sp.leader === s || sp.advisor === s || sp.steward === s);
}

/**
 * Pure: the space a notice for `seat` lands in — the seat's own space when it reads in a conversation, else the first
 * conversational seat up the ✋ ladder (a loop-agent kingdom such as RES → its parent, OP). Bounded walk; CEO → OP.
 */
export function busL0Space(seat: string, org: OrgMap): string {
  let cur = up(seat);
  for (let i = 0; i < 8; i++) {
    if (cur === 'CEO') return BUS_DEFAULT_SPACE;
    if (cur === PROXY_SEAT || isConversationalSeat(org, cur)) return busOwnSpace(cur);
    cur = orgParentOf(org, cur);
  }
  return BUS_DEFAULT_SPACE;
}

/** Does `seat` read the bus? — it acked a digest in one of `spaces` within `windowMs` (a seat whose turns never carry the
 *  bus never acks · its own space may still be empty, so callers pass the OP space too: every bus-reading seat acks there). */
export function busReaderSeen(stateRoot: string, seat: string, spaces: readonly string[], nowMs: number, windowMs: number): boolean {
  const s = up(seat);
  return [...new Set(spaces)].some((space) => {
    try { return readAcks(stateRoot, space).some((a) => a.by === s && nowMs - Date.parse(a.at) <= windowMs); } catch { return false; }
  });
}
