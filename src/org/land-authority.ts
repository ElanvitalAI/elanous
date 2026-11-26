// JUD-SPLIT-FU-CONSUMERS (CEO 11-26) — landing and veto are two duties on the org map, read here and nowhere else.
//   landing (executor ⊕ owner): owns land-graph cards, receives landing exceptions and refusal mail, may run land/train ops.
//   veto (independent judiciary): may set or clear HOLD · NO-GO · security veto, receives disputes. A veto from the
//   veto owner stops landing whoever owns landing; a HOLD from any other seat is ignored (recorded, never blocks).
// Fallback: an unreadable org map (load errors) keeps today's behaviour — both duties on DEFAULT_ORG (JUD).
import { DEFAULT_ORG, loadOrgMap, type OrgDeps } from './org-map.js';

const up = (s: string) => s.trim().toUpperCase();

function duty(name: 'landing' | 'veto' | 'escalation-parent', deps: OrgDeps): string {
  const fallback = DEFAULT_ORG.duties[name]!;
  try {
    const { org, errors } = loadOrgMap(deps);
    if (errors.length) return fallback;
    return org.duties[name] ?? fallback;
  } catch { return fallback; }
}

/** Seat that owns and executes landing (land-graph cards, land/train ops). */
export const landingOwner = (deps: OrgDeps = {}): string => duty('landing', deps);
/** Seat that holds HOLD / NO-GO / security veto and receives disputes. */
export const vetoOwner = (deps: OrgDeps = {}): string => duty('veto', deps);
/** Land-graph refusal cards and landing exceptions go to the landing owner. */
export const landRefusalRecipient = (deps: OrgDeps = {}): string => landingOwner(deps);
/** Disputes over a verdict or a HOLD go to the veto owner. */
export const disputeRecipient = (deps: OrgDeps = {}): string => vetoOwner(deps);

/** Land and train ops: the landing owner, or the HQ seat (escalation-parent) as manual override. */
export function mayRunLandOps(seat: string, deps: OrgDeps = {}): boolean {
  const s = up(seat);
  return s === landingOwner(deps) || s === duty('escalation-parent', deps);
}

export type VetoKind = 'hold' | 'no-go' | 'security-veto';
export interface VetoMark { readonly seat: string; readonly kind: VetoKind; readonly reason?: string }

/** Only the veto owner may set or clear a HOLD / NO-GO / security veto. */
export function maySetVeto(seat: string, deps: OrgDeps = {}): boolean { return up(seat) === vetoOwner(deps); }

/** Policy: veto-owner marks block landing; any other seat's mark is ignored (returned for the audit/refusal line). */
export function evaluateLandVetoes(marks: readonly VetoMark[], deps: OrgDeps = {}): { blocked: boolean; honored: VetoMark[]; ignored: VetoMark[] } {
  const owner = vetoOwner(deps);
  const honored = marks.filter(m => up(m.seat) === owner);
  const ignored = marks.filter(m => up(m.seat) !== owner);
  return { blocked: honored.length > 0, honored, ignored };
}
