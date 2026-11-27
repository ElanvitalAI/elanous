// KIT mail-route · hand-block routing by root — a ✋ «차단» goes ONCE to the seat with decision rights, not to OP/TC.
//
// S: measured 11-27 10:44 — 31 hand blocks in 30 min, 24 of them to OP; OP inbound 126/h. Later the same day ✋ to TC ran
//    32–77/h; the echo pairs (POOL-1↔TC 56 · CX-7↔TC 25 · CX-1↔TC 19 · MVP-B↔TC 18) were hands re-asking TC about things
//    only another owner decides — a dormant RES's lease/isolation record, a HOLD, a cell's scope.
// C: nothing is dropped · a design decision still climbs the normal ladder · an unclear block keeps the old route · the
//    hand ladder (escalation · CEO card) is unchanged — only the FIRST rung moves.
// A: classify the block by its root — structured fields first (`cause:` · `reason:` codes); an unstructured line asks the
//    decision model Jev once for root probabilities (hand-classifier.ts · no keyword rules, standing rule 11-20);
//    model unavailable / unclear → the old first rung (never blocks). Root → owner is DATA: hand-routes.yaml
//    (HAND-RAISE-DOMAIN-ROUTING): WIP → TC ⊕ takeover rule · JUD verdict / HOLD → JUDGE-BUTLER · env/host/lease/credentials
//    → GUARDIAN · cell scope → the cell's owner · design → the old rung. TC/OP remain only as the fallback.
//    Every ✋ carries `hand-ask:<root>:<cell|*>` — the post layer answers the same ask inside 30 min by reference.
//
// 세 얼굴: 관측 = refs `hand-root:<root>` ⊕ `hand-routed-from:<address>` ⊕ `hand-ask:` on the row ⊕ the caller's log ·
// 판단 근거 = {@link resolveHandRoot} (by = cause | reason | classifier | none) ⊕ hand-routes.yaml · 수복과 인계 = the receiver
// answers or the hand ladder climbs from it exactly as before (GUARDIAN / JUDGE-BUTLER / TC → their parent → OP → CEO card).
import { readHandRoutes, type HandOwnerSpec, type HandRoot, type HandRoutesTable } from './hand-routes.js';

export type { HandRoot } from './hand-routes.js';
export type HandRootBy = 'cause' | 'reason' | 'classifier' | 'none';

/** OPS-RULES «미커밋 WIP 인수 규칙» (11-27 10:3x) — attached to every WIP/handover hand routed to TC. */
export const WIP_TAKEOVER_RULE_LINE = 'OPS-RULES 미커밋 WIP 인수 규칙: 주인에게 한 줄 → 30분 무응답이면 보존 사본(가지 wip-keep/<seat>-<날짜> 또는 git stash push -u -m + SHA 기록)을 남기고 인수 · 24시간 넘게 손대지 않은 WIP 는 묻지 않고 같은 방식으로 인수 · 읽기·복사는 언제나 허용';

/** Named attachments a root row may carry (`attach:` in hand-routes.yaml). */
const ATTACHMENTS: Readonly<Record<string, string>> = { 'wip-takeover-rule': WIP_TAKEOVER_RULE_LINE };

export const HAND_ASK_REF = 'hand-ask:';

export interface HandBlockInput {
  /** BlockReason code (HUMAN_DECISION · DEPENDENCY_WAIT · TOOL_DENIED · …). */
  readonly reason?: string | null;
  /** HandCause code (writer-handover · worktree-path · slot-isolation · res-approval · hold · cell-scope). */
  readonly cause?: string | null;
  readonly detail?: string | null;
  /** The cell the ✋ is about (`cell:` ref, else the seat's claimed cell). */
  readonly cell?: string | null;
}

export interface HandClassification { readonly root: HandRoot; readonly by: HandRootBy }

export interface HandRouteOptions {
  /** The routing table (default: hand-routes.yaml ⊕ override). */
  readonly table?: HandRoutesTable;
  /** The checklist owner of a cell (null = unknown). Needed only by a `cell-owner` row. */
  readonly cellOwnerOf?: ((cell: string) => string | null) | null;
}

const tableOf = (opts?: HandRouteOptions): HandRoutesTable => opts?.table ?? readHandRoutes();

/** Classify a hand block by its STRUCTURED codes only (`cause:` then `reason:`). No text rules (standing rule 11-20). Pure over the table. */
export function classifyHandBlock(input: HandBlockInput, opts?: HandRouteOptions): HandClassification {
  const table = tableOf(opts);
  const cause = (input.cause ?? '').trim();
  if (cause && Object.hasOwn(table.causes, cause)) return { root: table.causes[cause]!, by: 'cause' };
  const reason = (input.reason ?? '').trim().toUpperCase();
  if (reason && Object.hasOwn(table.reasons, reason)) return { root: table.reasons[reason]!, by: 'reason' };
  return { root: 'ambiguous', by: 'none' };
}

/** A classifier for an unstructured block line (Jev · see hand-classifier.ts). Null = unclear. */
export type HandRootClassifier = (text: string) => Promise<HandRoot | null>;

/** Would {@link resolveHandRoot} ask the model for this block? (unclear root, or a refinable reason code). Pure over the table. */
export function handNeedsClassifier(input: HandBlockInput, opts?: HandRouteOptions): boolean {
  if (!(input.detail ?? '').trim()) return false;
  const structured = classifyHandBlock(input, opts);
  return structured.root === 'ambiguous' || (structured.by === 'reason' && tableOf(opts).refineReasons.has((input.reason ?? '').trim().toUpperCase()));
}

/** Structured codes first; still unclear (or a refinable reason) and a classifier is given → ask it once. Never throws. */
export async function resolveHandRoot(input: HandBlockInput, classify?: HandRootClassifier | null, opts?: HandRouteOptions): Promise<HandClassification> {
  const structured = classifyHandBlock(input, opts);
  const text = (input.detail ?? '').trim();
  // A refinable reason (hand-routes.yaml `refineReasons`) is only a default: the model may name the real owner's root.
  const refinable = structured.by === 'reason' && tableOf(opts).refineReasons.has((input.reason ?? '').trim().toUpperCase());
  if ((structured.root !== 'ambiguous' && !refinable) || !classify || !text) return structured;
  try {
    const root = await classify(text);
    return root && root !== 'ambiguous' ? { root, by: 'classifier' } : structured;
  } catch { return structured; }
}

export interface HandRoute {
  /** The first rung for this hand. */
  readonly to: string;
  readonly root: HandRoot;
  readonly by: HandRootBy;
  /** True when `to` differs from the old first rung. */
  readonly rerouted: boolean;
  /** A line to attach to the hand body (the WIP takeover rule for TC). */
  readonly attach?: string;
}

/** The owner a spec names for this ✋ (null = keep the old rung). Never throws. */
function ownerFor(spec: HandOwnerSpec, input: HandBlockInput & { readonly seat: string }, opts?: HandRouteOptions): string | null {
  if (spec.kind === 'keep') return null;
  if (spec.kind === 'address') return spec.address;
  const cell = (input.cell ?? '').trim();
  let owner: string | null = null;
  if (cell && opts?.cellOwnerOf) { try { owner = opts.cellOwnerOf(cell); } catch { owner = null; } }
  // A checklist owner may read `SEAT/note`; the asking seat owning its own cell decides nothing new → `else`.
  const seat = owner ? owner.split('/')[0]!.trim().toUpperCase() : '';
  if (seat && /^[A-Z][A-Z0-9_-]{0,63}$/u.test(seat) && seat !== input.seat.trim().toUpperCase()) return seat;
  return ownerFor(spec.otherwise, input, opts);
}

/**
 * The first rung of a hand. `defaultTo` = the old first rung (the seat's coordinator, or OP). Only a hand headed for a
 * relieved rung (hand-routes.yaml `relievedRungs` · OP · TC) is moved, never to the blocked seat itself; `keep` roots and
 * unclear blocks keep `defaultTo`.
 */
export function routeHandBlock(input: HandBlockInput & { readonly seat: string; readonly defaultTo: string }, classification?: HandClassification, opts?: HandRouteOptions): HandRoute {
  const table = tableOf(opts);
  const c = classification ?? classifyHandBlock(input, { ...opts, table });
  const defaultTo = input.defaultTo.trim().toUpperCase();
  const seat = input.seat.trim().toUpperCase();
  const row = c.root === 'ambiguous' ? undefined : table.roots[c.root];
  const attachLine = row?.attach ? ATTACHMENTS[row.attach] : undefined;
  const attach = attachLine ? { attach: attachLine } : {};
  const keep: HandRoute = { to: defaultTo, root: c.root, by: c.by, rerouted: false, ...attach };
  if (!row || !table.relievedRungs.has(defaultTo)) return keep;
  const owner = ownerFor(row.owner, input, { ...opts, table });
  if (!owner || owner === seat) return keep;
  return { to: owner, root: c.root, by: c.by, rerouted: owner !== defaultTo, ...attach };
}

/** The waited-on refs a ✋ text names: cell ids (two or more dash-joined upper-case parts) and mail/PR numbers. Pure. */
export function waitedOnRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.matchAll(/(?<![A-Za-z0-9-])([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)(?![A-Za-z0-9-])/gu)) refs.add(m[1]!);
  for (const m of text.matchAll(/(?:#|PR\s*#?)(\d{3,7})\b/giu)) refs.add(`#${m[1]}`);
  return [...refs].sort();
}

/**
 * The cell part of a ✋'s ask identity: an explicit `cell:` ref · else the cell ids the line names (only real cells when
 * `isCell` can tell · mail/PR numbers never count — a reworded line quoting a new mail id is the same ask) · else the
 * seat's claimed cell · else `*`. Two blocks naming different cells are two asks (05:57 TC-H-CX-1 hole). Pure.
 */
export function handAskCell(input: { readonly seat: string; readonly cell?: string | null; readonly claimed?: string | null; readonly detail?: string | null; readonly isCell?: ((id: string) => boolean) | null }): string | null {
  if (input.cell?.trim()) return input.cell.trim();
  const seat = input.seat.trim().toUpperCase();
  const named = waitedOnRefs(input.detail ?? '').filter((r) => !r.startsWith('#') && r !== seat && (() => { try { return input.isCell ? input.isCell(r) : true; } catch { return false; } })());
  if (named.length) return named.join('+');
  return input.claimed?.trim() || null;
}

/** `hand-ask:<root>:<cell|*>` — the ✋'s ask identity (with its sender) for the 30-min by-reference dedupe. Pure. */
export function handAskRef(root: HandRoot, cell?: string | null): string {
  const c = (cell ?? '').trim().toUpperCase().replace(/[^A-Z0-9._+-]/gu, '');
  return `${HAND_ASK_REF}${root}:${c || '*'}`;
}

/** A posted ✋ (msg post with `block:` ⊕ `reason:` refs) — the entrance form of {@link routeHandBlock}. */
export interface HandMailInput {
  readonly from: string;
  readonly to: string;
  readonly body: string;
  readonly refs?: readonly string[] | null;
  readonly replyTo?: number | null;
}

export interface HandMailRoute { readonly to: string; readonly refs: string[]; readonly body: string; readonly note: string; readonly root: HandRoot; readonly rerouted: boolean }

export interface HandMailOptions extends HandRouteOptions {
  /** The seat's claimed cell when the ✋ names none (`cell:` ref). */
  readonly claimedCellOf?: ((seat: string) => string | null) | null;
}

/**
 * The route for a posted hand (null = not a first ✋: a reply, an escalation, an already-routed row or a non-hand row is
 * never touched). Every first ✋ gets its `hand-ask:` ref; `rerouted` says whether its address moved. The classifier
 * is asked only for a hand headed for a relieved rung.
 */
export async function routeHandMail(m: HandMailInput, classify?: HandRootClassifier | null, opts?: HandMailOptions): Promise<HandMailRoute | null> {
  const refs = m.refs ?? [];
  const isHand = refs.some((r) => r.startsWith('block:')) && refs.some((r) => r.startsWith('reason:'));
  if (!isHand || typeof m.replyTo === 'number' || refs.some((r) => r.startsWith('hand-escalated-from:') || r.startsWith('hand-routed-from:') || r.startsWith(HAND_ASK_REF))) return null;
  const table = tableOf(opts);
  const value = (p: string): string | undefined => refs.find((r) => r.startsWith(p))?.slice(p.length);
  const to = m.to.trim().toUpperCase();
  const claimed = (() => { try { return opts?.claimedCellOf?.(m.from) ?? null; } catch { return null; } })();
  const cell = value('cell:') ?? claimed;
  const input = { seat: m.from, defaultTo: to, reason: value('reason:') ?? null, cause: value('cause:') ?? null, detail: m.body, cell };
  const ropts = { ...opts, table };
  const classification = table.relievedRungs.has(to) ? await resolveHandRoot(input, classify, ropts) : classifyHandBlock(input, ropts);
  const r = routeHandBlock(input, classification, ropts);
  const isCell = opts?.cellOwnerOf ? (id: string) => opts.cellOwnerOf!(id) !== null : null;
  const ask = handAskRef(r.root, handAskCell({ seat: m.from, cell: value('cell:') ?? null, claimed, detail: m.body, isCell }));
  if (!r.rerouted) return { to, root: r.root, rerouted: false, refs: [...refs, ask], body: m.body, note: '' };
  return {
    to: r.to, root: r.root, rerouted: true,
    refs: [...refs, `hand-root:${r.root}`, `hand-routed-from:${to}`, ask],
    body: r.attach ? `${m.body} · ${r.attach}` : m.body,
    note: `✋ ${r.root} → ${r.to} (its owner) instead of ${to}`,
  };
}
