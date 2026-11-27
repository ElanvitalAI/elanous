// HAND-NAME-NEUTRAL-DYNAMIC ① (대표 11-25 · demo 0.3.37) — a hand seat's els tab title says what the hand is doing NOW.
// S: hand ids (TC-H-CX-1 · TC-H-CC-2 · TC-H-POOL-3) baked in a home space and a runtime; every hand now runs eln on the same
//    model and moves across spaces through the hand pool / `eln work next`, so the name on the tab lied.
// C: the id stays (mail address · seat memory dir · ledger owner · crons key on it) — only the DISPLAYED tab title changes.
// A: «<id> · <space> · <cell ≤18> · <model tail>» while it holds a cell, «<id> · idle · <model tail>» when it holds none.
//    The eln in the hand's pane computes it and reports it as an agent-event `meta { title }` (its own, pane-verified
//    channel); els applies it to the hand's own one-pane tab (core.agentEvent). Leaders and OP never send one.
//    When: every turn start and end of the hand's eln — a `work next` claim/return or a `seat assign` (its mail wakes the
//    hand into a turn) shows up within that turn.
// 세 얼굴: 관측 = `els ls` tab label · 판단 근거 = the release checklist (owner ⊕ yellow) ⊕ federation ladder (rules, no LLM) ·
//          수복과 인계 = any failure leaves the previous title (fail-soft · never touches the turn).

/** A hand seat id: `<SPACE>-H-<…>` (TC-H-CX-1 · UX-H-POOL-3). Leaders (TC · UX · OP) and judge hands (JUD-*) are not hands. */
export function isHandSeat(seat: string): boolean {
  return /^[A-Z][A-Z0-9]*-H-[A-Z0-9][A-Z0-9_-]*$/.test(seat.trim().toUpperCase());
}

/** The model's short tail: the last alphabetic word of the id (gpt-6.1-terra → terra · claude-opus-5-5 → opus · glm-5 → glm). */
export function modelTail(model: string | undefined): string | undefined {
  const words = (model ?? '').trim().split(/[-/:@\s]+/).filter((w) => /^[a-z][a-z]+$/i.test(w));
  const tail = words.at(-1)?.toLowerCase();
  return tail ? tail.slice(0, 12) : undefined;
}

/** A cell id cut to `max` characters (the last one an ellipsis). */
export function shortCell(id: string, max = 18): string {
  const chars = [...id.trim()];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}

export interface HandTitleInput {
  readonly seat: string;
  /** The space the hand works in now (its coordinator scope); omitted when unknown. */
  readonly space?: string;
  /** The cell the hand holds; undefined = idle. */
  readonly cell?: string;
  readonly model?: string;
}

/** Pure: the displayed title. */
export function formatHandTabTitle(input: HandTitleInput): string {
  const seat = input.seat.trim().toUpperCase();
  const tail = modelTail(input.model);
  const parts = input.cell?.trim()
    ? [seat, ...(input.space?.trim() ? [input.space.trim().toUpperCase()] : []), shortCell(input.cell), ...(tail ? [tail] : [])]
    : [seat, 'idle', ...(tail ? [tail] : [])];
  return parts.join(' · ');
}

interface CellRow { readonly id: string; readonly status: string; readonly owner?: string; readonly updatedAt?: string }

/** Pure: the yellow cell `seat` owns (owner may read `SEAT/note`); several → the most recently changed. */
export function claimedCellOf(seat: string, cells: readonly CellRow[]): string | undefined {
  const me = seat.trim().toUpperCase();
  const mine = cells.filter((c) => c.status === 'yellow' && (c.owner ?? '').split('/')[0]!.trim().toUpperCase() === me);
  mine.sort((a, b) => (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0));
  return mine[0]?.id;
}

export interface HandTitleDeps {
  readonly seat: () => string | null;
  readonly cells: () => readonly CellRow[];
  readonly spaceOf: (seat: string) => string | undefined;
  readonly model: () => Promise<string | undefined> | string | undefined;
  readonly emit: (meta: { title: string; model?: string }) => void;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}

/**
 * Report the hand's title once (only when it changed since the last report of this process). A non-hand seat sends nothing.
 * Returns the title it sent, or null.
 */
export function createHandTitleReporter(deps: HandTitleDeps): { refresh(reason: string): Promise<string | null> } {
  let last: string | null = null;
  return {
    async refresh(reason) {
      try {
        const seat = deps.seat();
        if (!seat || !isHandSeat(seat)) return null;
        const cell = claimedCellOf(seat, deps.cells());
        const model = await deps.model();
        const title = formatHandTabTitle({ seat, ...(cell ? { cell } : {}), ...(cell ? { space: deps.spaceOf(seat) } : {}), ...(model ? { model } : {}) });
        if (title === last) return null;
        last = title;
        deps.emit({ title, ...(model ? { model } : {}) });
        deps.log?.('hand-title', { seat, reason, title });
        return title;
      } catch (error) {
        try { deps.log?.('hand-title-failed', { reason, error: String(error).slice(0, 200) }); } catch { /* fail-soft */ }
        return null;
      }
    },
  };
}

/** Live wiring for the eln TUI in an els pane: checklist ⊕ federation ladder ⊕ the session's model. */
export function liveHandTitleReporter(input: {
  readonly cwd: string;
  readonly emit: (meta: { title: string; model?: string }) => void;
  readonly model: () => Promise<string | undefined> | string | undefined;
}): { refresh(reason: string): Promise<string | null> } {
  /* eslint-disable @typescript-eslint/no-require-imports */
  return createHandTitleReporter({
    seat: () => {
      const { resolveSeatId } = require('../tui/seat-mail-boot.js') as typeof import('../tui/seat-mail-boot.js');
      return (process.env.ELANOUS_TRACK?.trim().toUpperCase() || resolveSeatId(input.cwd)) ?? null;
    },
    cells: () => {
      const { listChecklist } = require('../release-loop/checklist.js') as typeof import('../release-loop/checklist.js');
      const { activeBoardVersion } = require('../ops-dashboard/current-version.js') as typeof import('../ops-dashboard/current-version.js');
      return listChecklist(activeBoardVersion()).items;
    },
    spaceOf: (seat) => {
      const { loadFederationLadder } = require('../msg/hand-raise-ladder.js') as typeof import('../msg/hand-raise-ladder.js');
      const ladder = loadFederationLadder({ cwd: input.cwd });
      const parent = ladder.parentOf(seat);
      // A hand with no space in the ladder falls back to the HQ — say nothing rather than «OP».
      return parent && parent !== ladder.hq && parent !== 'CEO' ? parent : seat.split('-H-')[0];
    },
    model: input.model,
    emit: input.emit,
    log: (event, data) => {
      const { debug } = require('../debug/log.js') as typeof import('../debug/log.js');
      debug.log('seat', event, data);
    },
  });
}

/**
 * ELS-MODEL-META-ALL-SEATS (FU of ELS-PANE-LABEL-MODEL-FIRST): every eln — OP, leaders, coaches, not only hands — reports its
 * live model to els as agent-event `meta { model }`, only when it changed since this process last sent it. Fail-soft: a lookup
 * that throws or finds no model sends nothing and the next refresh tries again.
 */
export function createModelReporter(deps: { readonly model: () => Promise<string | undefined> | string | undefined; readonly emit: (meta: { model: string }) => void }): { refresh(): Promise<string | null> } {
  let last: string | null = null;
  return {
    async refresh() {
      try {
        const model = (await deps.model())?.trim();
        if (!model || model === last) return null;
        deps.emit({ model });
        last = model;
        return model;
      } catch { return null; }
    },
  };
}
