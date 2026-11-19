// els stall alert — a supervised pane whose turn never moves: a busy screen (a tool call in flight,
// «Turn running» / «응답 중») that produces no new output for STALL_MS is stalled, and the owner should
// hear about it while it can still rescue the turn instead of finding a dead pane an hour later.
// One poller per server (src/els/server.ts starts it after the core loads). Never writes the journal:
// it only reads (`list` + `frame`); the receipt is its own append-only file next to child-results,
// and the mail is a best effort — a mail failure is logged, never thrown into the poll loop.

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { BUSY_SCREEN, type ElsCore } from './core.js';
import { paneStatus } from './pane-status.js';

/** A busy screen with no new output for this long is a stall (env ELANOUS_ELS_STALL_MS, 0 disables). */
export const DEFAULT_STALL_MS = 5 * 60_000;
/** How often busy panes are re-rendered for the stall check (cheap: one frame per busy pane). */
export const DEFAULT_POLL_MS = 30_000;
// Mirror of the server's child-results cap: past 256 KiB the alert file becomes `.1` (one older
// generation), so a long-unwatched host cannot grow it without limit.
const ALERTS_MAX_BYTES = 256 * 1024;

export interface StallAlert {
  /** Stop polling and detach (idempotent). Pending alert appends/mails still in flight are allowed to finish. */
  stop(): void;
  /** False when the watcher never started (ELANOUS_ELS_STALL_MS 0 / negative / not a number, or stallMs ≤ 0). */
  readonly enabled: boolean;
}

/** One delivered stall alert, for the receipt line and the mail body. */
export interface StallAlertPayload {
  readonly pane: string;
  readonly address: string;
  readonly workspace: string;
  readonly title: string;
  readonly stalledMs: number;
  readonly at: string;
  /** ELS-STALL-ALERT-FIX: which trigger — the screen did not move, or the same tool stayed on the working row. */
  readonly kind?: 'no-output' | 'same-tool';
  readonly tool?: string;
}

const SGR = /\u001b\[[0-9;]*m/g;
// 출처: src/tui/chat/working-row.ts — eln's working row is `<braille spinner> <Verb> (<elapsed> • esc to interrupt)`; the
// spinner and the elapsed move every second while nothing else does, so they are masked before two screens are compared.
const SPINNER = /[\u2800-\u28ff]/g;
const ELAPSED = /\((?:\d+h )?(?:\d+m )?\d+s(\s*•)/g;

/** ELS-STALL-ALERT-FIX: the screen as compared for «did anything move» — colours, the spinner and the working row's
 *  elapsed time masked (a ticking clock is not output). */
export function stallScreenKey(screen: string): string {
  return screen.replace(SGR, '').replace(SPINNER, '·').replace(ELAPSED, '(…$1');
}

export interface StallAlertDeps {
  /** Canonical receipt line (see ALERTS_MAX_BYTES for the file's own bound). */
  readonly stateRoot: string;
  /** Clock (tests); default Date.now. */
  readonly now?: () => number;
  /** Post the OP mail (tests inject); default: open the real msg store and post from TA-ELS to OP. */
  readonly post?: (payload: StallAlertPayload) => void;
  /** Stall threshold (default DEFAULT_STALL_MS; ELANOUS_ELS_STALL_MS, 0 disables). */
  readonly stallMs?: number;
  /** Poll interval (default DEFAULT_POLL_MS). */
  readonly pollMs?: number;
  /** Where the alert mail goes (default OP, from TA-ELS). */
  readonly from?: string;
  readonly to?: string;
}

/** The mail body: one line of fact, then the four rescue lines (same recipe on every alert). */
export function stallAlertBody(payload: StallAlertPayload): string {
  const minutes = Math.round(payload.stalledMs / 60_000);
  return [
    payload.kind === 'same-tool'
      ? `[els stall] ${payload.address} (${payload.title}) — busy, the same tool ${payload.tool ?? '?'} for ${minutes}min (at ${payload.at})`
      : `[els stall] ${payload.address} (${payload.title}) — busy, no new output for ${minutes}min (at ${payload.at})`,
    `1. els read ${payload.pane}  # see the last screen with your own eyes`,
    `2. els ls  # is the pane still live, which workspace is it in`,
    `3. decide: the turn may be waiting on a long tool call — check its purpose before touching it`,
    `4. rescue if needed: els send ${payload.pane} '<text>'  # or leave it running and ack this mail`,
  ].join('\n');
}

/**
 * JUD-B #103245 must: the switch really switches. Unset or empty → the default; a positive number → that many ms;
 * 0, a negative number or anything that is not a number → 0 = the watcher does not start (it used to fall back to the
 * default and run anyway, so it could not be turned off).
 */
export function stallMsFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_STALL_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Watch every live PTY pane: while a screen is busy (a turn/tool call in flight) and unchanged for
 * `stallMs`, append one receipt line to `<stateRoot>/els/stall-alerts.jsonl` and post one mail.
 * One alert per unchanged episode — the next alert only after the screen changed again (more output,
 * or a different tool call) and then stalled anew. Screen changes reset the timer even while busy.
 */
export function startStallAlert(core: ElsCore, deps: StallAlertDeps): StallAlert {
  const stallMs = deps.stallMs ?? stallMsFromEnv(process.env.ELANOUS_ELS_STALL_MS);
  const disabled = stallMs <= 0;
  const pollMs = Math.max(1, deps.pollMs ?? DEFAULT_POLL_MS);
  const now = deps.now ?? Date.now;
  const from = deps.from ?? 'TA-ELS';
  const to = deps.to ?? 'OP';
  const alertsPath = join(deps.stateRoot, 'els', 'stall-alerts.jsonl');
  const post = deps.post ?? defaultPost(from, to);

  /** pane id → this episode's screen key, when it last changed, and whether the alert already fired. */
  const watched = new Map<string, { key: string; changedAt: number; fired: boolean; tool: string | undefined; toolSince: number; toolFired: boolean }>();
  let stopped = false;

  const appendReceipt = (line: object): void => {
    try {
      mkdirSync(dirname(alertsPath), { recursive: true, mode: 0o700 });
      if (statSync(alertsPath).size > ALERTS_MAX_BYTES) renameSync(alertsPath, `${alertsPath}.1`);
    } catch { /* no file yet */ }
    try { appendFileSync(alertsPath, `${JSON.stringify(line)}\n`, { mode: 0o600 }); }
    catch (error) { process.stderr.write(`els stall: receipt not saved: ${error instanceof Error ? error.message : String(error)}\n`); }
  };

  const alert = (paneId: string, since: number, row: { address: string; workspace: string; title: string }, kind: 'no-output' | 'same-tool', tool?: string): void => {
    const payload: StallAlertPayload = { pane: paneId, address: row.address, workspace: row.workspace, title: row.title,
      stalledMs: now() - since, at: new Date(now()).toISOString(), kind, ...(tool ? { tool } : {}) };
    appendReceipt({ at: payload.at, pane: paneId, address: row.address, stalledMs: payload.stalledMs, kind, ...(tool ? { tool } : {}) });
    try { post(payload); }
    catch (error) { process.stderr.write(`els stall: mail not posted: ${error instanceof Error ? error.message : String(error)}\n`); }
  };

  const poll = async (): Promise<void> => {
    if (stopped) return;
    let panes: Array<{ readonly pane: string; readonly address: string; readonly workspace: string; readonly title: string; readonly state: string; readonly ptyId: string }>;
    try {
      const listed = JSON.parse(core.list().message) as { panes?: Array<Record<string, unknown>> };
      panes = (listed.panes ?? [])
        .filter((row) => typeof row.pane === 'string' && typeof row.ptyId === 'string' && row.ptyId !== '')
        .map((row) => ({ pane: row.pane as string, address: String(row.address ?? ''), workspace: String(row.workspace ?? ''),
          title: String(row.title ?? ''), state: String(row.state ?? ''), ptyId: row.ptyId as string }));
    } catch { return; /* the journal is unreadable this tick; the next tick retries */ }
    const live = new Set(panes.map((row) => row.pane));
    for (const paneId of [...watched.keys()]) if (!live.has(paneId)) watched.delete(paneId);
    for (const row of panes) {
      let screen: string;
      try {
        const framed = await core.frame(row.pane);
        if (framed.exitCode !== 0) continue; // render failed — not busy, not stalled, never a false alert
        screen = framed.message;
      } catch { continue; }
      const status = paneStatus({ pane: row.pane, alive: true, exited: false, screen: screen.replace(SGR, ''), lastOutputAt: undefined, now: now() });
      // Busy = what `els status` calls working (ELS-STALL-ALERT 9차-a · TC-H-POOL-3 #104667): eln's «Turn running»
      // line, or the «esc to interrupt» hint codex and Claude Code show while a tool runs. With BUSY_SCREEN alone a
      // pane showing only that hint was «working · Bash 96s» in els status yet never alerted.
      const busy = BUSY_SCREEN.test(screen) || status.state === 'working';
      const key = createHash('sha256').update(stallScreenKey(screen)).digest('hex');
      const tool = status.tool?.name;
      const entry = watched.get(row.pane);
      if (!entry) {
        // First sight — both episodes start now.
        watched.set(row.pane, { key, changedAt: now(), fired: false, tool, toolSince: now(), toolFired: false });
        continue;
      }
      // A different tool on the working row starts a new «same tool» episode; new output (outside the masked clock) starts a
      // new «no output» episode. Each episode mails at most once.
      if (tool !== entry.tool) { entry.tool = tool; entry.toolSince = now(); entry.toolFired = false; }
      if (key !== entry.key) { entry.key = key; entry.changedAt = now(); entry.fired = false; }   // no `continue`: the same-tool clock runs on
      if (!busy) continue;
      if (!entry.fired && now() - entry.changedAt >= stallMs) {
        entry.fired = true;
        entry.toolFired = true;   // one stall, one mail: the same-tool trigger does not repeat what this one said
        alert(row.pane, entry.changedAt, row, 'no-output', tool);
      } else if (tool && !entry.toolFired && now() - entry.toolSince >= stallMs) {
        entry.toolFired = true;
        alert(row.pane, entry.toolSince, row, 'same-tool', tool);
      }
    }
  };

  if (disabled) return { enabled: false, stop: () => { stopped = true; } };
  const timer = setInterval(() => { void poll(); }, pollMs);
  timer.unref?.();
  return {
    enabled: true,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/** Open the real msg store and post the alert mail (production path; wrapped by the poller, never thrown). */
function defaultPost(from: string, to: string): (payload: StallAlertPayload) => void {
  return (payload) => {
    const { defaultMsgStorePath, openMsgStore } = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
    const store = openMsgStore(defaultMsgStorePath());
    try {
      store.post({ from, to, body: stallAlertBody(payload), kind: 'stall-alert', intent: 'alert' });
    } finally { store.close(); }
  };
}