// OP-NEXT-BEST-ACTION — a deterministic pre-turn planner for the OP seat (CEO 11-26 night · eln OP runs alone from 11-27).
//
// S: on 11-26 eln OP answered what it was given, honestly — but mostly by «requesting and scheduling a check». With 16
//    hands idle and few ready cells it mailed the board steward instead of splitting and assigning; mission mail sat
//    unconverted until coached twice; it missed loops that said «done» and produced nothing (land graph 0 landed, the
//    release run never created, the bulletin 11 h stale). Its goal line was the generic «로스터 착지 · 초록».
// C: every input already exists as state (checklist · hand pool · msg store · land/release/bulletin outcomes). What was
//    missing is a rule that turns that state into ONE thing to DO now — not a mail asking someone else.
// Q: what is the single most valuable action right now, and who does it — code (deterministic) or the OP turn (LLM)?
// A: planNextActions() walks a fixed rule ladder over a state snapshot (pure · no I/O):
//      (w) a P0 open cell without done-when                → write its done-when first (OP turn · CEO 11-26 21:5x)
//      (a) a CEO directive / mission mail no cell cites   → register cells (OP turn)
//      (h) an open ✋ NEED HUMAN at OP past the hold       → resolve/reject it, or put ONE concrete question to the CEO
//      (b) idle hands + ready cells                        → priorityOrder ⊕ pull hint ⊕ one wake (planner · OP-PUSH-BUDGET)
//      (c) idle hands + no ready cells                     → split the top P0 cell into ≤45-min cells, then assign (OP turn)
//      (d) ready-to-land > 0 and nothing landed in 1 h     → outcome alarm + one land-graph tick (planner · never by hand)
//      (e) a cut-at passed with no release run             → create the run (planner) — or alarm when times are unknown
//      (f) stale bulletin                                  → write it (OP turn)
//      (g) else                                            → the next 3 concrete goals of the release into the pulse note
//    executeNextActions() runs the planner-owned actions through injected actuators (live only) and returns one
//    «did X (evidence)» line each; renderNextActionBlock() puts the did-lines and the first OP-owned action, as
//    «NEXT ACTION (do it)», at the top of OP's turn. The live probes/actuators live in op-next-action-live.ts.
//
// 세 얼굴:
//   관측 = the pulse table's «다음 행동» block ⊕ {stateRoot}/loops/op-next-action.jsonl (one line per plan: rules · did)
//   판단 근거 = each action's evidence line (counts · ids · ages from the snapshot) and the rule letter
//   수복과 인계 = planner actions run at once (assign · land tick · release run); OP-owned ones open the OP turn with the
//          exact command and done-when; an actuator failure stays in the block as «failed X (why)» for the OP turn.

export type NextRule = 'w' | 'a' | 'h' | 'z' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g';
/** planner = deterministic code does it now · op = the OP turn must do it now (needs judgement/LLM) · ceo = one question. */
export type NextActor = 'planner' | 'op' | 'ceo';

export interface NaCell {
  readonly id: string;
  readonly title: string;
  readonly status: 'green' | 'yellow' | 'red' | 'done';
  readonly owner?: string;
  readonly priority?: 'P0' | 'P1' | 'P2';
  readonly predecessors?: readonly string[];
  readonly doneCriterion?: string;
  readonly source?: string;
  readonly body?: string;
  readonly evidence?: string;
  /** checklist dispatchKind: umbrella/decision cells are never assigned or split. */
  readonly dispatchKind?: string;
  readonly updatedAt?: string;
}

export interface NaHand {
  readonly seat: string;
  readonly home: string;
  readonly state: 'idle' | 'working' | 'no-pane';
  /** Epoch ms the state began (idle since), when known. */
  readonly since?: number;
  /** A judge hand (JUD*) — never given implementation cells. */
  readonly judge?: boolean;
  /** The hand holds this open cell but its pane has sat idle (hand pool OWNER-IDLE-WAKE) — wake it on that cell. */
  readonly ownerIdleCell?: string;
}

/** A CEO directive (crown) or a mission mail addressed to OP. */
export interface NaDirective {
  readonly msgId: number;
  readonly crownDirective?: string | null;
  readonly kind?: string | null;
  readonly from: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface NaHandRaise {
  readonly msgId: number;
  readonly seat: string;
  readonly line: string;
  readonly ageMin: number;
  /** Only the CEO can answer (money · security · publish): OP puts one concrete question. */
  readonly ceoOnly: boolean;
}

export interface NaHold { readonly coordinator: string; readonly msgId: number; readonly at: string; readonly frozen: readonly string[]; readonly scoped: boolean; readonly body: string }

export interface NaRelease {
  readonly version: string;
  readonly cutAt: string | null;
  readonly publishAt: string | null;
  readonly hasRun: boolean;
}

export interface NextActionState {
  readonly now: string;
  /** The release in play (checklist version). */
  readonly version: string | null;
  /** The last published version (release runs are only expected for newer ones). */
  readonly released?: string | null;
  /** null = not measured (never read as «no cells»). */
  readonly cells: readonly NaCell[] | null;
  readonly hands: readonly NaHand[] | null;
  readonly directives: readonly NaDirective[] | null;
  /** Directive mail ids OP dismissed as «no cell needed» (`eln pulse dismiss`). */
  readonly dismissed?: readonly number[];
  readonly handRaises: readonly NaHandRaise[] | null;
  /** readyToLand = PRs passing every gate but not landed (land-graph last tick) · landedLastHour from the land ledger. */
  readonly land: { readonly readyToLand: number | null; readonly landedLastHour: number | null; readonly mode?: string } | null;
  readonly releases: readonly NaRelease[] | null;
  /** ageMin null = BULLETIN-NOW.md missing. The whole field null = not measured. */
  readonly bulletin: { readonly ageMin: number | null } | null;
  readonly unmeasured?: readonly string[];
  /** Coordinator broadcast holds with hands frozen behind them (src/msg/hand-escalation-step.ts broadcastHolds). */
  readonly holds?: readonly NaHold[];
  /** Unacked mail per seat (most first) — shown as one line in the plan block. */
  readonly unacked?: readonly { readonly seat: string; readonly count: number; readonly oldestMin: number }[];
  /** Actions the previous no-op turn left pending (op-forced-next.json): they lead the plan, marked FORCED. */
  readonly forced?: readonly { readonly key: string; readonly reason: string }[];
  /** Split requests the planner recorded (cells with no done-when that an idle hand could not take as they are). */
  readonly splitRequests?: readonly NaSplitRequest[];
  /** THROTTLE-AUDIT: config `op.next.*` overrides; absent = caps scaled with the pool. */
  readonly pushPolicy?: PushPolicy;
}

export interface NaSplitRequest { readonly cell: string; readonly at: string; readonly deadline: string; readonly why: string }

export interface NextAction {
  readonly rule: NextRule;
  readonly actor: NextActor;
  /** Imperative, one line: «assign UX-12 → UX-H3». */
  readonly what: string;
  /** Why now, from the snapshot (numbers · ids · ages). */
  readonly evidence: string;
  /** Exact commands, in order. */
  readonly commands: readonly string[];
  /** What must be observed after the action. */
  readonly doneWhen: string;
  /** Dedupe key across pulses (rule + target). */
  readonly key: string;
  readonly target?: { readonly seat?: string; readonly cell?: string; readonly version?: string; readonly msgId?: number; readonly cutAt?: string; readonly publishAt?: string; readonly deadline?: string };
  /** (d)/(e): an outcome alarm card goes with the action (OUTCOME-DONE-ALARMS card path). */
  readonly alarm?: boolean;
  /** What the planner's actuator does for a planner action (b/c pull hint · b holder wake · c split request). */
  readonly do?: 'pull' | 'wake' | 'split-request';
  /** Why this action leads the plan regardless of the ladder (an overdue split request · a no-op turn). */
  readonly forced?: string;
}

export interface NextPlan {
  readonly actions: readonly NextAction[];
  /** THROTTLE-AUDIT: OP→hand mails allowed this hour (scaled with the pool) — executeNextActions folds wakes past it. */
  readonly handMailsPerHour?: number;
  /** The next three concrete goals of the release (always computed — the goal line reads them). */
  readonly goals: readonly string[];
  readonly unmeasured: readonly string[];
  /** One mail-health line («mail: TC 52 unacked · oldest 13h | …»), when measured. */
  readonly mail?: string;
}

// 출처: OP-NEXT-BEST-ACTION brief (CEO 11-26) — «split into ≤45-min cells» · the work-pull lease is 45 min (eln work next).
export const SPLIT_CELL_MIN = 45;
// 출처: OUTCOME-DONE-ALARMS (#40264) — cut-at + 5 min grace, 24 h lookback, bulletin stale > 45 min.
export const RELEASE_CUT_GRACE_MIN = 5;
export const RELEASE_LOOKBACK_MIN = 24 * 60;
export const BULLETIN_STALE_MIN = 45;
// 출처: hand-raise ladder (11-25) — a ✋ left 15 min at OP's level is OP's to close (resolve · reject · escalate).
export const HAND_RAISE_HOLD_MIN = 15;
/** Floor of pull hints (and holder wakes) per plan. THROTTLE-AUDIT: the real cap is `planAssignCap` — one per hand in the pool. */
export const MAX_ASSIGN_PER_PLAN = 8;
// OP-PUSH-BUDGET (11-27 · 15:24Z: 27 [SEAT-ASSIGN] mails in one burst, OP→hands 60/h, against the CEO-approved pull model):
// the planner never assigns — it hints and wakes; every OP→hand mail of the last hour counts against this budget.
// 출처: OP-PUSH-BUDGET cell (coordinator 11-27 00:5x) — «cap ≤15 OP→hand mails/h total, fold the rest».
// THROTTLE-AUDIT (CEO 11-27 11:0x «a land-10 target needs that much upstream supply — a fixed cap blocking it is absurd»):
// 15 is now the FLOOR. 11-27 live: 42 wakes folded on «budget 15/h spent» while 25 hands idled. The budget scales with the
// pool: OP_HAND_MAILS_PER_HAND per hand per hour. The burst guard stays where it belongs — one wake per hand per plan and
// the shared wake ledger's one wake per seat per window (SHARED-WAKE-LEDGER).
export const OP_HAND_MAILS_PER_HOUR = 15;
/** Wakes per pool hand per hour (a pull hint ⊕ one holder wake). */
export const OP_HAND_MAILS_PER_HAND = 2;

/** Policy override (config `op.next.handMailsPerHour` · `op.next.handMailsPerHand` · `op.next.assignPerPlan`); absent/invalid = scaled default. */
export interface PushPolicy { readonly handMailsPerHour?: unknown; readonly handMailsPerHand?: unknown; readonly assignPerPlan?: unknown }
const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);

/** Hands the planner may hint or wake (judges never get implementation cells). */
export function poolHandCount(hands: readonly NaHand[] | null | undefined): number {
  return (hands ?? []).filter(h => !h.judge).length;
}

/** OP→hand mails per hour: an explicit policy value, else max(floor 15, perHand × pool hands). */
export function opHandMailBudgetPerHour(poolHands: number, policy: PushPolicy = {}): number {
  const fixed = posInt(policy.handMailsPerHour);
  if (fixed !== null) return fixed;
  const perHand = posInt(policy.handMailsPerHand) ?? OP_HAND_MAILS_PER_HAND;
  return Math.max(OP_HAND_MAILS_PER_HOUR, perHand * Math.max(0, Math.floor(poolHands)));
}

/** Pull hints / holder wakes per plan: an explicit policy value, else max(floor 8, pool hands) — every idle hand in one pulse. */
export function planAssignCap(poolHands: number, policy: PushPolicy = {}): number {
  return posInt(policy.assignPerPlan) ?? Math.max(MAX_ASSIGN_PER_PLAN, Math.max(0, Math.floor(poolHands)));
}
/** At most this many pieces per split (one per idle hand, capped — a split wider than this is a new umbrella). */
export const MAX_SPLIT_PIECES = 4;
// 출처: CEO 11-26 21:5x (OP-STRUCTURAL item 2) — «split request record with a 30-min deadline; if no split by deadline,
// next OP turn gets it as forced NEXT ACTION».
export const SPLIT_REQUEST_DEADLINE_MIN = 30;
/** P0 cells without done-when listed per plan (the oldest first; the rest show as a count). */
export const MAX_DONE_WHEN_PER_PLAN = 3;
/** Directives listed per plan (the oldest first; the rest show as a count). */
export const MAX_DIRECTIVES_PER_PLAN = 3;

const OPEN = (c: NaCell) => c.status === 'yellow' || c.status === 'red';
const UNOWNED = (owner: string | undefined) => !owner || !owner.trim() || owner.trim() === '-' || owner.trim().toUpperCase() === 'POOL';
const NOT_WORK = (c: NaCell) => c.dispatchKind === 'umbrella' || c.dispatchKind === 'decision';
const PRI = (p: NaCell['priority']) => p === 'P0' ? 0 : p === 'P1' ? 1 : p === 'P2' ? 2 : 3;
const oneLine = (s: string, n: number) => { const t = s.replace(/\s+/gu, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const q = (s: string) => `'${s.replace(/'/gu, '\'\\\'\'')}'`;

/** Open cells, most urgent first: priority · red before yellow · oldest update. */
export function rankCells(cells: readonly NaCell[]): NaCell[] {
  return cells.filter(c => OPEN(c) && !NOT_WORK(c)).sort((a, b) => PRI(a.priority) - PRI(b.priority)
    || (a.status === 'red' ? 0 : 1) - (b.status === 'red' ? 0 : 1)
    || (Date.parse(a.updatedAt ?? '') || 0) - (Date.parse(b.updatedAt ?? '') || 0) || a.id.localeCompare(b.id));
}

/** A ready cell: open yellow, nobody owns it, every known predecessor is green/done. */
export function readyCells(cells: readonly NaCell[]): NaCell[] {
  const status = new Map(cells.map(c => [c.id, c.status] as const));
  return rankCells(cells).filter(c => c.status === 'yellow' && UNOWNED(c.owner)
    && (c.predecessors ?? []).every(p => { const s = status.get(p); return s === undefined || s === 'green' || s === 'done'; }));
}

/** Idle hands that can take implementation work, longest idle first. A hand that owns an open cell is not free. */
export function freeHands(hands: readonly NaHand[], cells: readonly NaCell[]): NaHand[] {
  const owners = new Set(cells.filter(OPEN).map(c => (c.owner ?? '').split(/[/:\s]/u)[0]!.toUpperCase()).filter(Boolean));
  return hands.filter(h => h.state === 'idle' && !h.judge && !owners.has(h.seat.toUpperCase()))
    .sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity) || a.seat.localeCompare(b.seat));
}

/** Does any cell cite this directive (mail id `#123` · `msg 123` · the crown id) in source/body/evidence/title? */
export function directiveRegistered(d: NaDirective, cells: readonly NaCell[]): boolean {
  const id = String(d.msgId);
  const idRe = new RegExp(`(?:#|msg[\\s:#-]*|mail[\\s:#-]*)${id}(?!\\d)`, 'iu');
  const crown = d.crownDirective?.trim();
  return cells.some(c => {
    const text = `${c.source ?? ''}\n${c.body ?? ''}\n${c.evidence ?? ''}\n${c.title}`;
    return idRe.test(text) || (c.source ?? '').trim() === id || (!!crown && text.includes(crown));
  });
}

const semverNewer = (version: string, released: string | null | undefined): boolean => {
  if (!released) return true;
  const a = version.split('.').map(Number); const b = released.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
};

/** The next three concrete goals: top open cells with their done-when. */
export function nextGoals(cells: readonly NaCell[], n = 3): string[] {
  return rankCells(cells).slice(0, n).map(c => `${c.id}${c.priority ? ` (${c.priority})` : ''} ${oneLine(c.title, 70)} — done when ${c.doneCriterion ? oneLine(c.doneCriterion, 90) : '(no done-when on the cell — name one in the turn)'}${UNOWNED(c.owner) ? ' · unowned' : ` · ${c.owner}`}`);
}

/** The release goal line from the actual top cells (replaces «로스터 착지 · 초록»): «UX-12 · TC-3 · OP-NBA (+N open)». */
export function goalNoteFromCells(cells: readonly NaCell[], n = 3): string | null {
  const ranked = rankCells(cells);
  const top = ranked.slice(0, n);
  return top.length ? `${top.map(c => c.id).join(' · ')}${ranked.length > n ? ` (+${ranked.length - n} open)` : ''}` : null;
}

/** Walk the rule ladder over one snapshot. Pure: same state → same plan. */
export function planNextActions(state: NextActionState): NextPlan {
  const now = Date.parse(state.now);
  const actions: NextAction[] = [];
  const unmeasured = [...(state.unmeasured ?? [])];
  const cells = state.cells;
  if (cells === null) unmeasured.push('cells');
  const v = state.version ?? '<version>';

  // (w) P0 open cells with no done-when → OP writes it first: nothing can be assigned, split or judged green against a
  //     cell that does not say what «done» is (11-26 live: JUD-BUTLER · JUDGE-THROUGHPUT showed «no done-when»).
  if (cells) {
    const missing = rankCells(cells).filter(c => c.priority === 'P0' && !(c.doneCriterion ?? '').trim());
    for (const c of missing.slice(0, MAX_DONE_WHEN_PER_PLAN)) {
      actions.push({ rule: 'w', actor: 'op', key: `w:${c.id}`, target: { cell: c.id, version: v },
        what: `write the done-when of P0 ${c.id}`,
        evidence: `P0 ${c.status} «${oneLine(c.title, 80)}»${c.owner ? ` (owner ${c.owner})` : ''} has no done-when${missing.length > MAX_DONE_WHEN_PER_PLAN ? ` · ${missing.length} P0 cells without one in all` : ''}`,
        commands: [`eln release checklist set ${c.id} --done ${q('<what is observed when it is done — a command, a screen, a number>')} --version ${v}`],
        doneWhen: `${c.id} has a done-when (checklist doneCriterion)` });
    }
  }

  // (a) directives no cell cites → register cells (OP turn: the wording needs judgement).
  if (state.directives && cells) {
    const dismissed = new Set(state.dismissed ?? []);
    const open = state.directives.filter(d => !dismissed.has(d.msgId) && !directiveRegistered(d, cells))
      .sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt));
    for (const d of open.slice(0, MAX_DIRECTIVES_PER_PLAN)) {
      const age = Math.max(0, Math.round((now - Date.parse(d.createdAt)) / 60_000));
      const label = d.crownDirective ? `CEO directive #${d.msgId} (crown ${d.crownDirective})` : `${d.kind ?? 'mission'} mail #${d.msgId} from ${d.from}`;
      actions.push({ rule: 'a', actor: 'op', key: `a:${d.msgId}`, target: { msgId: d.msgId, version: v },
        what: `register cells for ${label}`,
        evidence: `${age} min old · no cell cites #${d.msgId}${open.length > MAX_DIRECTIVES_PER_PLAN ? ` · ${open.length} unregistered in all` : ''} · «${oneLine(d.body, 100)}»`,
        commands: [`eln release checklist add <ID> ${q('<title>')} --priority P0 --done ${q('<observable done-when>')} --source '#${d.msgId}'`,
          `(no work in it? → eln pulse dismiss ${d.msgId} --why '<one line>')`],
        doneWhen: `a cell in ${v} cites #${d.msgId} in --source (or the mail is dismissed with a reason)` });
    }
  } else if (state.directives === null) unmeasured.push('directives');

  // (h) ✋ NEED HUMAN left at OP's level → close it (resolve · reject · escalate) or one concrete CEO question.
  if (state.handRaises) {
    for (const h of state.handRaises.filter(x => x.ageMin >= HAND_RAISE_HOLD_MIN).sort((x, y) => y.ageMin - x.ageMin).slice(0, 2)) {
      actions.push(h.ceoOnly
        ? { rule: 'h', actor: 'ceo', key: `h:${h.msgId}`, target: { msgId: h.msgId, seat: h.seat },
          what: `put ONE concrete question to the CEO for ✋ #${h.msgId} (${h.seat})`,
          evidence: `open ${h.ageMin} min · CEO-only · «${oneLine(h.line, 100)}»`,
          commands: [`eln decisions raise --title ${q(`[✋ ${h.seat}] <yes/no question>`)} --category other --s ${q(oneLine(h.line, 120))} --c '<what is blocked>' --option 'a=<A>:<result>' --option 'b=<B>:<result>' --recommend a`, `eln msg hand ${h.msgId} escalate '<the question, one line>'`],
          doneWhen: `#${h.msgId} has an outcome (escalated with one decision card)` }
        : { rule: 'h', actor: 'op', key: `h:${h.msgId}`, target: { msgId: h.msgId, seat: h.seat },
          what: `close ✋ #${h.msgId} from ${h.seat} — resolve or reject it yourself`,
          evidence: `open ${h.ageMin} min at OP's level · «${oneLine(h.line, 100)}»`,
          commands: [`eln msg hand ${h.msgId} resolve '<decision + next step>'`, `(or) eln msg hand ${h.msgId} reject '<why>'`],
          doneWhen: `#${h.msgId} closed (resolve/reject outcome in the ladder)` });
    }
  } else unmeasured.push('hand-raises');

  // (z) hands frozen behind a coordinator's broadcast hold (11-26: TC #178978 «… 금지», 8 ✋ unanswered 13 h, all hands
  //     idle) → OP decides: narrow it to cells ⊕ expiry, or lift it. A scoped hold (cells: ⊕ until:) still shows, softer.
  for (const hold of (state.holds ?? []).slice(0, 2)) {
    const hours = Math.max(0, Math.round((now - Date.parse(hold.at)) / 3_600_000));
    actions.push({ rule: 'z', actor: 'op', key: `z:${hold.msgId}`, target: { msgId: hold.msgId, seat: hold.coordinator },
      what: `${hold.frozen.length} hands frozen by ${hold.coordinator} hold #${hold.msgId} for ${hours}h — decide: narrow it to named cells ⊕ an expiry, or lift it`,
      evidence: `${hold.scoped ? 'scoped' : 'no cells, no expiry'} · frozen ${hold.frozen.join(', ')} (open ✋ to ${hold.coordinator} after it) · «${hold.body}»`,
      commands: [`eln msg post --from OP --to ${hold.coordinator} --kind coord --body '[OP decision on #${hold.msgId}] lifted for <cells/all> · held only for <cells> until <ISO> · refs cells:<ids> until:<iso>'`,
        ...hold.frozen.slice(0, 3).map(h => `(then close the ✋ of ${h}: eln msg hand <id> resolve '<decision>' --owner ${h} --deadline 30m)`)],
      doneWhen: `#${hold.msgId} is lifted or re-posted with cells: ⊕ until: refs, and the frozen hands' ✋ have outcomes` });
  }

  // (b·wake) a hand that holds an open cell while its pane sits idle (11-26 22:43: TC «0 ready / 8 idle» were all such) —
  //     wake it on its own cell (one wake per hand, inside the OP→hand mail budget) — a wake, never a re-assignment.
  // THROTTLE-AUDIT: hints and holder wakes per plan scale with the pool (floor MAX_ASSIGN_PER_PLAN).
  const assignCap = planAssignCap(poolHandCount(state.hands), state.pushPolicy);
  if (state.hands && cells) {
    const open = new Set(cells.filter(OPEN).map(c => c.id));
    for (const h of state.hands.filter(x => x.ownerIdleCell && open.has(x.ownerIdleCell) && !x.judge).slice(0, assignCap)) {
      const idle = h.since !== undefined ? ` (idle ${Math.max(0, Math.round((now - h.since) / 60_000))} min)` : '';
      actions.push({ rule: 'b', actor: 'planner', do: 'wake', key: `b:wake:${h.seat}:${h.ownerIdleCell}`, target: { seat: h.seat, cell: h.ownerIdleCell!, version: v },
        what: `wake ${h.seat} on its own ${h.ownerIdleCell}`,
        evidence: `${h.seat} holds ${h.ownerIdleCell} but its pane is idle${idle} — a wake on its cell, not a split`,
        commands: [`(wake ${h.seat}: you hold ${h.ownerIdleCell} and your pane is idle — continue it or hand it back)`],
        doneWhen: `${h.seat} is working again (pane busy) or hands ${h.ownerIdleCell} back` });
    }
  }

  // (b) idle hands × ready cells → raise the cell in priorityOrder ⊕ hint it to the hand; the hand claims it on its next
  //     `eln work next` (one wake per hand). (c) idle hands, nothing ready → hint the cells with a done-when, split the rest.
  if (state.hands && cells) {
    const free = freeHands(state.hands, cells);
    const ready = readyCells(cells);
    if (free.length && ready.length) {
      const pairs = Math.min(free.length, ready.length, assignCap);
      for (let i = 0; i < pairs; i++) {
        const hand = free[i]!; const cell = ready[i]!;
        const idle = hand.since !== undefined ? `idle ${Math.max(0, Math.round((now - hand.since) / 60_000))} min` : 'idle';
        actions.push({ rule: 'b', actor: 'planner', do: 'pull', key: `b:${hand.seat}:${cell.id}`, target: { seat: hand.seat, cell: cell.id, version: v },
          what: `prioritize ${cell.id} for ${hand.seat} (pull)`,
          evidence: `${hand.seat} ${idle} · ${cell.id}${cell.priority ? ` ${cell.priority}` : ''} ready (unowned) · free hands ${free.length} · ready cells ${ready.length}`,
          commands: [`eln work priority ${cell.id} <current order…>  (hint ${cell.id} → ${hand.seat})`, `(${hand.seat}) eln work next`],
          doneWhen: `${hand.seat} claims ${cell.id} (or other work) via eln work next` });
      }
    } else if (free.length && !ready.length) {
      // (c) idle hands, nothing «ready» (11-26 live: TC 0 ready / 6 idle · JUD 0 / 4 — OP only mailed «leaders: split
      //     cells»). Actuate instead: the oldest yellow cells nobody is working on (unowned · owned by a coordinator or a
      //     seat with no pane) WITH a done-when go straight to the idle hands; those WITHOUT one get a split request
      //     (30-min deadline); an overdue request becomes OP's forced first action. Never a mail.
      const working = new Set(state.hands.filter(h => h.state === 'working').map(h => h.seat.toUpperCase()));
      const idleHands = new Set(state.hands.filter(h => h.state === 'idle').map(h => h.seat.toUpperCase()));
      const status = new Map(cells.map(c => [c.id, c.status] as const));
      const ownerSeat = (c: NaCell) => (c.owner ?? '').split(/[/:\s]/u)[0]!.toUpperCase();
      const nobodyOnIt = (c: NaCell) => UNOWNED(c.owner) || (!working.has(ownerSeat(c)) && !idleHands.has(ownerSeat(c)));
      const split = (c: NaCell) => cells.some(x => x.id.startsWith(`${c.id}-S`));
      const candidates = cells.filter(c => c.status === 'yellow' && !NOT_WORK(c) && nobodyOnIt(c) && !split(c)
        && (c.predecessors ?? []).every(p => { const st = status.get(p); return st === undefined || st === 'green' || st === 'done'; }))
        .sort((a, b) => PRI(a.priority) - PRI(b.priority) || (Date.parse(a.updatedAt ?? '') || 0) - (Date.parse(b.updatedAt ?? '') || 0) || a.id.localeCompare(b.id));
      const withDone = candidates.filter(c => (c.doneCriterion ?? '').trim());
      const without = candidates.filter(c => !(c.doneCriterion ?? '').trim());
      const pairs = Math.min(free.length, withDone.length, assignCap);
      for (let i = 0; i < pairs; i++) {
        const hand = free[i]!; const cell = withDone[i]!;
        const idle = hand.since !== undefined ? `idle ${Math.max(0, Math.round((now - hand.since) / 60_000))} min` : 'idle';
        actions.push({ rule: 'c', actor: 'planner', do: 'pull', key: `c:pull:${hand.seat}:${cell.id}`, target: { seat: hand.seat, cell: cell.id, version: v },
          what: `prioritize ${cell.id} for ${hand.seat} (pull)`,
          evidence: `${hand.seat} ${idle} · 0 ready cells · ${cell.id}${cell.priority ? ` ${cell.priority}` : ''} has a done-when and nobody on it${cell.owner ? ` (owner ${cell.owner})` : ''}`,
          commands: [`eln work priority ${cell.id} <current order…>  (hint ${cell.id} → ${hand.seat})`, `(${hand.seat}) eln work next`],
          doneWhen: `${hand.seat} claims ${cell.id} (or other work) via eln work next` });
      }
      const open = new Map((state.splitRequests ?? []).map(r => [r.cell, r] as const));
      const handsLeft = Math.max(0, free.length - pairs);
      const forced: NextAction[] = [];
      for (const cell of without.slice(0, Math.min(MAX_SPLIT_PIECES, Math.max(1, handsLeft)))) {
        const req = open.get(cell.id);
        if (!req) {
          const deadline = new Date(now + SPLIT_REQUEST_DEADLINE_MIN * 60_000).toISOString();
          actions.push({ rule: 'c', actor: 'planner', do: 'split-request', key: `c:split:${cell.id}`, target: { cell: cell.id, version: v, deadline },
            what: `record a split request for ${cell.id} (deadline ${deadline.slice(11, 16)}Z)`,
            evidence: `${free.length} free hands · 0 ready cells · ${cell.id}${cell.priority ? ` ${cell.priority}` : ''} «${oneLine(cell.title, 60)}» has no done-when — it cannot go to a hand as it is`,
            commands: [`eln release checklist add ${cell.id}-S1 ${q('<one ≤45-min piece>')} --done ${q('<observable>')} --source ${q(`split of ${cell.id}`)} --version ${v}`,
              `(or) eln release checklist set ${cell.id} --done ${q('<observable>')} --version ${v}`],
            doneWhen: `${cell.id} has a done-when or ${cell.id}-S<n> cells exist by ${deadline}` });
        } else if (Date.parse(req.deadline) <= now) {
          const late = Math.round((now - Date.parse(req.deadline)) / 60_000);
          forced.push({ rule: 'c', actor: 'op', key: `c:split-overdue:${cell.id}`, target: { cell: cell.id, version: v },
            forced: `split request for ${cell.id} recorded ${req.at.slice(11, 16)}Z, deadline passed ${late} min ago — nothing split, no done-when`,
            what: `split ${cell.id} into ≤${SPLIT_CELL_MIN}-min cells with done-when (or write its done-when), then raise them with eln work priority — ${free.slice(0, MAX_SPLIT_PIECES).map(h => h.seat).join(', ')} pull them`,
            evidence: `${free.length} free hands · 0 ready cells · split request overdue ${late} min`,
            commands: [`eln release checklist add ${cell.id}-S1 ${q('<one ≤45-min piece>')} --priority ${cell.priority ?? 'P0'} --done ${q('<observable>')} --source ${q(`split of ${cell.id}`)} --version ${v}`,
              `eln work priority ${cell.id}-S1 <current order…>`],
            doneWhen: `${cell.id}-S<n> cells exist with --done and hands claimed them via eln work next (or ${cell.id} has a done-when)` });
        }
      }
      actions.unshift(...forced); // overdue split requests lead the whole plan, oldest first
      if (!candidates.length) {
        const top = rankCells(cells).find(c => c.status === 'yellow' && c.priority === 'P0' && !split(c))
          ?? rankCells(cells).find(c => c.status === 'yellow' && !split(c));
        if (top) {
          const pieces = Math.max(2, Math.min(free.length, MAX_SPLIT_PIECES));
          const seats = free.slice(0, pieces).map(h => h.seat);
          actions.push({ rule: 'c', actor: 'op', key: `c:${top.id}`, target: { cell: top.id, version: v },
            what: `split ${top.id} into ${pieces} cells of ≤${SPLIT_CELL_MIN} min each, then raise them with eln work priority — ${seats.join(', ')} pull them`,
            evidence: `${free.length} free hands · 0 ready cells · no free cell at all · top open cell ${top.id}${top.priority ? ` ${top.priority}` : ''} «${oneLine(top.title, 80)}»${top.owner ? ` (owner ${top.owner})` : ''}`,
            commands: [
              ...seats.map((s, i) => `eln release checklist add ${top.id}-S${i + 1} ${q('<one ≤45-min piece>')} --priority ${top.priority ?? 'P0'} --done ${q('<observable>')} --source ${q(`split of ${top.id}`)} --version ${v}`),
              `eln work priority ${seats.map((_s, i) => `${top.id}-S${i + 1}`).join(' ')} <current order…>`],
            doneWhen: `${pieces} cells ${top.id}-S1…S${pieces} exist with --done and hands claimed them via eln work next` });
        }
      }
    }
  } else if (state.hands === null) unmeasured.push('hands');

  // (d) ready-to-land but nothing landed in the last hour → outcome alarm + one land-graph tick (never a hand land).
  const land = state.land;
  if (land && land.readyToLand !== null && land.readyToLand > 0 && land.landedLastHour === 0) {
    const shadow = land.mode !== undefined && land.mode !== 'live';
    actions.push(shadow
      ? { rule: 'd', actor: 'ceo', key: `d:mode:${land.mode}`, alarm: true,
        what: `ask the CEO: land graph is ${land.mode} with ${land.readyToLand} PRs ready — switch it to live?`,
        evidence: `ready-to-land ${land.readyToLand} · landed 0 in 60 min · land.graph.mode=${land.mode}`,
        commands: [`eln decisions raise --title ${q(`land graph ${land.mode}: ${land.readyToLand} ready, 0 landed — go live?`)} --category scope --s ${q(`${land.readyToLand} PRs pass every gate`)} --c ${q(`land.graph.mode=${land.mode} lands nothing`)} --option 'a=live now:the next tick lands them' --option ${q(`b=keep ${land.mode}:nothing lands`)} --recommend a`],
        doneWhen: 'a decision card exists (or land.graph.mode = live)' }
      : { rule: 'd', actor: 'planner', key: 'd:land', alarm: true,
        what: `outcome alarm + one land-graph tick (${land.readyToLand} ready, 0 landed)`,
        evidence: `ready-to-land ${land.readyToLand} · landed 0 in 60 min · mode ${land.mode ?? '?'}`,
        commands: ['eln land graph tick --json'],
        doneWhen: 'the tick lands ≥1 PR, or its refusal classes name who must fix what' });
  } else if (!land || land.readyToLand === null) unmeasured.push('land');

  // (e) a cut-at passed with no release run → create the run, or alarm when its times are unknown.
  if (state.releases) {
    for (const r of state.releases) {
      const cut = r.cutAt ? Date.parse(r.cutAt) : NaN;
      if (!Number.isFinite(cut) || r.hasRun || !semverNewer(r.version, state.released)) continue;
      const late = Math.round((now - cut) / 60_000);
      if (late < RELEASE_CUT_GRACE_MIN || late > RELEASE_LOOKBACK_MIN) continue;
      actions.push(r.publishAt
        ? { rule: 'e', actor: 'planner', key: `e:${r.version}`, alarm: true, target: { version: r.version, cutAt: r.cutAt!, publishAt: r.publishAt },
          what: `create the ${r.version} release run`,
          evidence: `cut-at ${r.cutAt} passed ${late} min ago · no release-graph run for ${r.version}`,
          commands: [`eln release graph run ${r.version} --cut-at ${r.cutAt} --publish-at ${r.publishAt}`],
          doneWhen: `release-graph/${r.version}/state.json exists and its first tick ran` }
        : { rule: 'e', actor: 'ceo', key: `e:${r.version}:times`, alarm: true, target: { version: r.version },
          what: `ask the CEO for ${r.version}'s publish time (cut passed ${late} min ago, no run, no publish-at)`,
          evidence: `cut-at ${r.cutAt} · publish-at unknown · no release-graph run`,
          commands: [`eln decisions raise --title ${q(`${r.version}: cut passed, publish time?`)} --category publish --s ${q(`cut-at ${r.cutAt} passed`)} --c 'no publish-at, so no release run' --option 'a=<HH:MM today>:run created' --option ${q(`b=skip ${r.version}:moves to the next version`)} --recommend a`],
          doneWhen: `a publish time is set (eln release schedule set ${r.version} …) or the version is skipped` });
    }
  } else unmeasured.push('releases');

  // (f) stale bulletin → OP writes it now.
  const b = state.bulletin;
  if (b && (b.ageMin === null || b.ageMin > BULLETIN_STALE_MIN)) {
    actions.push({ rule: 'f', actor: 'op', key: 'f:bulletin',
      what: 'rewrite seat-state/OPS/BULLETIN-NOW.md (OPS-RULES §연방 공보 7칸)',
      evidence: b.ageMin === null ? 'BULLETIN-NOW.md missing' : `BULLETIN-NOW.md last written ${b.ageMin} min ago (> ${BULLETIN_STALE_MIN})`,
      commands: ['write seat-state/OPS/BULLETIN-NOW.md (old one appended to BULLETIN-LOG) · eln msg post --from OP --to <6 sub-coordinators> --kind bulletin'],
      doneWhen: 'BULLETIN-NOW.md mtime is after this pulse' });
  } else if (!b) unmeasured.push('bulletin');

  const goals = cells ? nextGoals(cells) : [];
  // (g) nothing else → the next 3 concrete goals into the pulse note.
  if (!actions.length && goals.length) {
    actions.push({ rule: 'g', actor: 'planner', key: `g:${goals.map(g => g.split(' ')[0]).join(',')}`,
      what: 'write the next 3 release goals into the pulse note',
      evidence: `no directive/hand/idle/land/release/bulletin action · top open cells of ${v}`,
      commands: goals.map((g, i) => `goal ${i + 1}: ${g}`),
      doneWhen: 'the pulse note carries the three goal lines' });
  }
  // A no-op turn left these pending (turn-end enforcement): they lead the plan, in the order recorded, marked FORCED.
  const forcedBy = new Map((state.forced ?? []).map(f => [f.key, f.reason] as const));
  const lead = (state.forced ?? []).map(f => actions.find(a => a.key === f.key)).filter((a): a is NextAction => !!a)
    .map(a => ({ ...a, forced: a.forced ?? forcedBy.get(a.key)! }));
  const ordered = [...lead, ...actions.filter(a => !forcedBy.has(a.key))];
  const mail = unackedPlanLine(state.unacked);
  return { actions: ordered, goals, unmeasured: [...new Set(unmeasured)], ...(mail ? { mail } : {}),
    handMailsPerHour: opHandMailBudgetPerHour(poolHandCount(state.hands), state.pushPolicy) };
}

// ── execute ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Actuators for planner-owned actions. Each returns a short evidence string (mail id · run id · landed list) or throws. */
export interface NextActuators {
  /** Raise cells in priorityOrder ⊕ hint each to its hand (one ledger write per plan). */
  hint?(entries: readonly { seat: string; cell: string }[]): Promise<string> | string;
  /** One wake (one short mail ⊕ pane wake) to a hand: run `eln work next` / continue the held cell. */
  wake?(seat: string, lines: readonly string[]): Promise<string> | string;
  /** OP→hand mails left in the hourly budget (`hourlyCap` — the plan's pool-scaled budget — minus the last hour's). Absent = the full budget. */
  handMailBudget?(hourlyCap: number): Promise<number> | number;
  landTick?(): Promise<string> | string;
  releaseRun?(version: string, cutAt: string, publishAt: string): Promise<string> | string;
  /** OUTCOME-DONE-ALARMS card path: one card to the owner + OP, deduped by key. */
  alarm?(key: string, line: string): Promise<string> | string;
  writeGoals?(lines: readonly string[]): Promise<string> | string;
  /** Record a split request (cell · deadline ISO · why) — the next plans read it back as `splitRequests`. */
  requestSplit?(cell: string, deadline: string, why: string): Promise<string> | string;
}

export interface ActionResult { readonly action: NextAction; readonly status: 'did' | 'failed' | 'would' | 'todo'; readonly evidence: string }

/**
 * Run every planner-owned action through its actuator (stage live), in ladder order. Shadow/manual → «would» lines
 * only. OP/CEO-owned actions come back as `todo` (the OP turn does them). An actuator throw → `failed` (kept for OP).
 */
export async function executeNextActions(plan: NextPlan, act: NextActuators, stage: string): Promise<ActionResult[]> {
  const out: ActionResult[] = [];
  // OP-PUSH-BUDGET: pull hints go in one ledger write; each hand gets at most one wake; wakes past the hourly budget fold.
  const pulls = stage === 'live' && act.hint ? plan.actions.filter(a => a.actor === 'planner' && a.do === 'pull' && a.target?.seat && a.target.cell) : [];
  let hinted: string | null = null; let hintError: string | null = null;
  if (pulls.length) {
    try { hinted = String(await act.hint!(pulls.map(a => ({ seat: a.target!.seat!, cell: a.target!.cell! })))); }
    catch (error) { hintError = (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, ' ').slice(0, 200); }
  }
  const wakeLines = new Map<string, string[]>(); // seat → lines, in ladder order
  const wakeOf = new Map<NextAction, string>();
  for (const a of plan.actions) {
    if (a.actor !== 'planner') { out.push({ action: a, status: 'todo', evidence: a.evidence }); continue; }
    if (stage !== 'live') { out.push({ action: a, status: 'would', evidence: a.commands[0] ?? a.what }); continue; }
    if ((a.do === 'pull' && act.hint) || (a.do === 'wake' && act.wake)) {
      const seat = a.target?.seat; const cell = a.target?.cell;
      if (!seat || !cell) { out.push({ action: a, status: 'todo', evidence: `no target — ${a.evidence}` }); continue; }
      if (a.do === 'pull' && hintError) { out.push({ action: a, status: 'failed', evidence: hintError }); continue; }
      const line = a.do === 'pull' ? `${cell} is prioritized for you — run \`eln work next\`` : `you hold ${cell} and your pane is idle — continue it or hand it back`;
      wakeLines.set(seat, [...(wakeLines.get(seat) ?? []), line]);
      wakeOf.set(a, seat);
      out.push({ action: a, status: 'did', evidence: a.do === 'pull' ? `hint ${cell} → ${seat}${hinted ? ` (${hinted})` : ''}` : `holder wake ${seat} on ${cell}` });
      continue;
    }
    try {
      const ev: string[] = [];
      if (a.alarm && act.alarm) ev.push(`alarm ${await act.alarm(a.key, `${a.what} — ${a.evidence}`)}`);
      if (a.do === 'split-request' && act.requestSplit && a.target?.cell && a.target.deadline) ev.push(await act.requestSplit(a.target.cell, a.target.deadline, a.evidence));
      else if (a.rule === 'd' && act.landTick) ev.push(await act.landTick());
      else if (a.rule === 'e' && act.releaseRun && a.target?.version && a.target.cutAt && a.target.publishAt) ev.push(await act.releaseRun(a.target.version, a.target.cutAt, a.target.publishAt));
      else if (a.rule === 'g' && act.writeGoals) ev.push(await act.writeGoals(a.commands));
      else { out.push({ action: a, status: 'todo', evidence: `no actuator wired — ${a.evidence}` }); continue; }
      out.push({ action: a, status: 'did', evidence: ev.filter(Boolean).join(' · ') || a.evidence });
    } catch (error) {
      out.push({ action: a, status: 'failed', evidence: (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, ' ').slice(0, 200) });
    }
  }
  if (wakeLines.size) {
    const hourlyCap = plan.handMailsPerHour ?? OP_HAND_MAILS_PER_HOUR;
    let budget = hourlyCap;
    try { if (act.handMailBudget) budget = Math.max(0, Math.floor(await act.handMailBudget(hourlyCap))); } catch { budget = 0; } // unmeasured → no new mail
    const wakeEv = new Map<string, string>();
    for (const [seat, lines] of wakeLines) {
      if (!act.wake) { wakeEv.set(seat, 'no wake actuator'); continue; }
      if (budget <= 0) { wakeEv.set(seat, `wake folded (OP→hand budget ${hourlyCap}/h spent — the hint stands for its next work next)`); continue; }
      try { wakeEv.set(seat, `wake ${await act.wake(seat, lines)}`); budget--; }
      catch (error) { wakeEv.set(seat, `wake failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`); }
    }
    for (let i = 0; i < out.length; i++) {
      const seat = wakeOf.get(out[i]!.action);
      if (seat) out[i] = { ...out[i]!, evidence: `${out[i]!.evidence} · ${wakeEv.get(seat) ?? ''}` };
    }
  }
  return out;
}

/** Does this result set need the OP turn? Any OP/CEO action, or a planner action that failed or had no actuator. */
export function needsOpTurn(results: readonly ActionResult[]): boolean {
  return results.some(r => r.status === 'todo' || r.status === 'failed');
}

/**
 * The block at the top of OP's turn. Did-lines first (what the planner already did, with evidence), then the first
 * OP-owned action as «NEXT ACTION (do it)» with its commands and done-when, then the rest as «then». The contract
 * forbids «I will check at HH:MM» without a done action — the turn-end check flags request-only turns in the retro.
 */
export function renderNextActionBlock(results: readonly ActionResult[], goals: readonly string[], mail?: string): string {
  const did = results.filter(r => r.status === 'did' || r.status === 'would');
  const failed = results.filter(r => r.status === 'failed');
  const todo = results.filter(r => r.status === 'todo');
  const lines: string[] = [];
  for (const r of did) lines.push(`${r.status === 'did' ? 'did' : 'would do (shadow)'} (${r.action.rule}) ${r.action.what} (${r.evidence})`);
  for (const r of failed) lines.push(`failed (${r.action.rule}) ${r.action.what} (${r.evidence}) — do it by its command: ${r.action.commands[0] ?? '?'}`);
  const [first, ...rest] = todo;
  if (first) {
    lines.push('', `NEXT ACTION (do it) — (${first.action.rule}) ${first.action.what}`, ...(first.action.forced ? [`  FORCED: ${first.action.forced}`] : []), `  why: ${first.action.evidence}`,
      ...first.action.commands.map(c => `  $ ${c}`), `  done when: ${first.action.doneWhen}`);
    if (first.action.actor === 'ceo') lines.push('  (this one is a question for the CEO: ONE decision card with a recommendation — not a status mail)');
  }
  if (rest.length) lines.push('', 'then:', ...rest.map(r => `- (${r.action.rule}) ${r.action.what} · ${r.action.commands[0] ?? ''} · done when ${r.action.doneWhen}`));
  if (!lines.length) lines.push('nothing to do from state');
  if (goals.length) lines.push('', 'release goals (top open cells):', ...goals.map((g, i) => `${i + 1}. ${g}`));
  lines.push('', 'Report one line per action: «did X (evidence)». Do not reply «I will check at HH:MM» or mail a request instead of doing it — a turn with requests and no state change is flagged in the retro.');
  return ['## 다음 행동 (next-action planner)', ...(mail ? [mail] : []), ...lines].join('\n');
}

/** «TC 52 unacked · oldest 13h | UX 4 unacked · oldest 40m» — the mail line for the OP plan block. */
export function unackedPlanLine(rows: NextActionState['unacked']): string | null {
  if (!rows || !rows.length) return null;
  const age = (m: number) => (m >= 120 ? `${Math.floor(m / 60)}h` : `${m}m`);
  return `mail: ${rows.slice(0, 5).map(r => `${r.seat} ${r.count} unacked · oldest ${age(r.oldestMin)}`).join(' | ')}`;
}
