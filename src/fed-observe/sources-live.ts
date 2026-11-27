// FED-OBSERVE — the I/O half of `eln fed snapshot|chatlog`. Read-only; every reader fails open: a source that cannot be
// read is named in `unmeasured` and its field is null (never read as zero). Each reader is the existing first-class one:
//   panes · build · unread mail     els ls (federationListing)
//   session per pane                the eln TUI's own PTY-manifest row (process tree) or its `--resume` argv (seat-peek)
//   turns                           the eln session store transcript (tail)
//   errors · Cap refusals · queue   the log store reader (LogStore.openReadOnly — the `eln logs` local reader)
//   unacked · ✋                    msg store (read-only) · hand-raise-ladder openHands
//   blocks                          steward cell-block ledger (open) ⊕ fed-state `work:block` facts
//   freeze · land holds · land      landing-freeze · land-graph ledger/holds
//   commitments                     commitment ledger ⊕ wakers (pulse-digest classifyDigest)
//   judge queue                     green triage (as the pulse measures it)
//   loops                           graph trigger registry fires (read-only open)
//   release cells · KPIs · hands    checklist · fed-state KPI · hand pool
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SerializedMessage } from '../session/index.js';
import type { BlockIn, ErrorIn, FedSources, MailIn, PaneIn, PoolIn, QueueIn, TurnIn } from './snapshot.js';
import { turnsOf, type MailRow, type OutcomeFacts, type SeatSession } from './chatlog.js';

const req = <T>(p: string): T => require(p) as T;
const short = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 60);

// ── panes and their sessions ─────────────────────────────────────────────────────────────────────────────────────────

export interface LivePane extends PaneIn { readonly pid?: number; readonly title?: string; readonly host?: string }

/** Raw `els ls` rows → panes with a seat (eln seats and loop tabs), with the eln session each one runs. */
export function panesFromListing(listing: { panes: Record<string, unknown>[]; workspaces: Record<string, unknown>[] },
  sessionFor: (row: Record<string, unknown>) => string | null): LivePane[] {
  const coordinators = new Set(listing.workspaces.map(w => String(w.coordinatorSeat ?? (w.role === 'coordinator' ? w.name : '') ?? '').toUpperCase()).filter(Boolean));
  const out: LivePane[] = [];
  for (const row of listing.panes) {
    const title = typeof row.title === 'string' ? row.title : '';
    const seat = (typeof row.seat === 'string' && row.seat) ? row.seat : title.startsWith('↻') ? title : '';
    if (!seat) continue;
    const status = row.status as { state?: string; since?: number } | undefined;
    const build = row.build as { sha?: string; age?: string; stamp?: string } | undefined;
    const unread = row.unreadMail as { count?: number; oldestCreatedAt?: string | null } | undefined;
    out.push({
      seat: seat.startsWith('↻') ? seat : seat.toUpperCase(),
      ...(typeof row.workspace === 'string' ? { workspace: row.workspace } : {}),
      ...(typeof row.kind === 'string' ? { kind: row.kind } : {}),
      ...(status ? { status: { ...(status.state ? { state: status.state } : {}), ...(typeof status.since === 'number' ? { since: status.since } : {}) } } : {}),
      ...(build ? { build } : {}), stalled: row.stalled === true,
      ...(unread ? { unreadMail: unread } : {}),
      ...(typeof row.reach === 'string' ? { reach: row.reach } : {}),
      ...(typeof row.pid === 'number' ? { pid: row.pid } : {}), title, ...(typeof row.host === 'string' ? { host: row.host } : {}),
      sessionId: row.kind === 'eln' ? sessionFor(row) : null,
      coordinator: coordinators.has(seat.toUpperCase()),
    });
  }
  // One row per seat: a live pane beats an exited one.
  const best = new Map<string, LivePane>();
  for (const p of out) { const prev = best.get(p.seat); if (!prev || (prev.status?.state === 'EXITED' && p.status?.state !== 'EXITED')) best.set(p.seat, p); }
  return [...best.values()];
}

/** The session resolver for many panes: `ps` and the PTY manifest are read once. */
export function sessionResolver(): (row: Record<string, unknown>) => string | null {
  const { paneSession, parsePsParents } = req<typeof import('../seat-peek/peek.js')>('../seat-peek/peek.js');
  let parents = new Map<number, number>();
  try { parents = parsePsParents(spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5_000 }).stdout ?? ''); } catch { /* argv only */ }
  let manifest: ReturnType<typeof import('../pty-shell/pty-manifest.js').listPtyManifestRowsAt> = [];
  try { const m = req<typeof import('../pty-shell/pty-manifest.js')>('../pty-shell/pty-manifest.js'); manifest = m.listPtyManifestRowsAt(m.ptyManifestDbPath()); } catch { /* argv only */ }
  return (row) => {
    const fg = Array.isArray(row.fgCommand) ? row.fgCommand.map(String) : undefined;
    // A remote pane's pid and manifest live on its own host: only peek's argv path (`--resume <id>`) applies there.
    const local = typeof row.reach !== 'string' || row.reach === 'local';
    const s = paneSession({ ...(local && typeof row.pid === 'number' ? { panePid: row.pid } : {}), parents: local ? parents : new Map(), manifest: local ? manifest : [], ...(fg ? { fgCommand: fg } : {}) });
    return s?.sessionId ?? null;
  };
}

/** Each eln seat pane's transcript tail. A seat whose session or transcript cannot be read is NAMED (unmeasured), never
 *  silently skipped: no session reported → `session(SEAT)` · remote host without a local copy → `transcript(SEAT@host)`. */
export function seatTranscripts(panes: readonly LivePane[], maxBytes: number, read: (id: string, max: number) => SerializedMessage[] | null = readTranscriptTail):
  { sessions: SeatSession[]; unmeasured: string[] } {
  const sessions: SeatSession[] = []; const unmeasured: string[] = [];
  for (const p of panes) {
    if (p.seat.startsWith('↻') || p.kind !== 'eln' || p.status?.state === 'EXITED') continue;
    const remote = typeof p.reach === 'string' && p.reach !== 'local';
    if (!p.sessionId) { unmeasured.push(`session(${p.seat}${remote ? `@${p.host ?? 'remote'}` : ''})`); continue; }
    const messages = read(p.sessionId, maxBytes);
    if (messages) sessions.push({ seat: p.seat, sessionId: p.sessionId, messages });
    else unmeasured.push(`transcript(${p.seat}${remote ? `@${p.host ?? 'remote'}` : ''})`);
  }
  return { sessions, unmeasured };
}

/** The last `maxBytes` of a session transcript (a partial first line is dropped). null = no transcript. */
export function readTranscriptTail(sessionId: string, maxBytes = 4 * 1024 * 1024): SerializedMessage[] | null {
  if (!/^[A-Za-z0-9._-]{4,128}$/.test(sessionId)) return null;
  try {
    const { sessionFile } = req<typeof import('../session/index.js')>('../session/index.js');
    const { parseTranscript } = req<typeof import('../seat-peek/peek.js')>('../seat-peek/peek.js');
    const file = sessionFile(sessionId);
    if (!existsSync(file)) return null;
    const fd = openSync(file, 'r');
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      const from = start > 0 ? buf.indexOf(0x0a) + 1 : 0;
      return parseTranscript(buf.subarray(from)).messages;
    } finally { closeSync(fd); }
  } catch { return null; }
}

// ── log store (the `eln logs` local reader) ──────────────────────────────────────────────────────────────────────────

export interface LogRowLite { readonly ts: string; readonly ts_ms: number; readonly level: string; readonly category: string; readonly event: string; readonly session_id: string | null; readonly data: string | null }

// 출처: 11-26 21:41 / 22:45 OP «✘ Could not process the request» = session.compact over-budget · llm.request
// request-size-limit-blocked · agent.error failed (eln logs --level error --since 2h, 11-26 23:2x).
const FATAL = /over-budget|request-size-limit-blocked|could not process|요청을 처리하지 못했습니다/iu;

/** A log row → (session or tui pid, kind, what). Pure. */
export function classifyLogRow(r: LogRowLite): { session: string | null; pid: number | null; kind: ErrorIn['kind']; what: string } | null {
  let data: Record<string, unknown> = {};
  try { data = r.data ? JSON.parse(r.data) as Record<string, unknown> : {}; } catch { /* text data */ }
  const session = r.session_id ?? (typeof data.tuiSession === 'string' ? data.tuiSession : null);
  const pid = typeof data.tuiPid === 'number' ? data.tuiPid : null;
  // A Cap refusal with a retry time is pacing (the turn opens later); without one the turn was dropped — a Cap miss.
  // CAP-ECHO (11-27 · «OP 16 turns dropped by Cap» after #40312: 15 were `op.requirements continue-rejected` and the rest
  // `autopilot drive-refused` — callers echoing the gate's own `tui.autoturn rejected` row, which carried retryAt = pacing).
  // Only the gate's row (`tui.autoturn rejected`) and a producer's own `missed` (retro · resource optimize gave up) count.
  if (data.reason === 'Cap') {
    const gate = r.category === 'tui.autoturn' && r.event === 'rejected';
    if (typeof data.retryAt === 'number' || (!gate && r.event !== 'missed')) return null;
    return { session, pid, kind: 'cap', what: `${r.category} ${r.event} Cap${typeof data.detail === 'string' ? ` (${data.detail})` : ''}` };
  }
  if (r.level !== 'error' && r.level !== 'critical') return null;
  const text = `${r.category} ${r.event} ${r.data ?? ''}`;
  const fatal = FATAL.test(text) || r.category === 'agent.error';
  return { session, pid, kind: fatal ? 'fatal' : 'error', what: `${r.category} ${r.event}` };
}

/** Queue depth per session from `tui.queue` rows: items held and not yet joined since the last release. Pure. */
export function queueDepths(rows: readonly LogRowLite[]): Map<string, number> {
  const held = new Map<string, Set<string>>();
  for (const r of rows.slice().sort((a, b) => a.ts_ms - b.ts_ms)) {
    let d: Record<string, unknown> = {};
    try { d = r.data ? JSON.parse(r.data) as Record<string, unknown> : {}; } catch { continue; }
    const s = typeof d.tuiSession === 'string' ? d.tuiSession : r.session_id;
    if (!s) continue;
    const set = held.get(s) ?? new Set<string>();
    const item = typeof d.itemId === 'string' ? d.itemId : null;
    if (r.event === 'held' && item) set.add(item);
    else if (r.event === 'p1-joined' && item) set.delete(item);
    else if (r.event === 'released' || r.event === 'idle-stall-release' || r.event === 'resumed') set.clear();
    held.set(s, set);
  }
  return new Map([...held].map(([s, set]) => [s, set.size]));
}

export function readLogRows(q: { sinceMs: number; minLevel?: string; grep?: string; categories?: string[]; limit: number }, dbPath?: string): LogRowLite[] {
  const { LogStore, logsDbPath } = req<typeof import('../mss/logging/log-store.js')>('../mss/logging/log-store.js');
  const path = dbPath ?? logsDbPath();
  // A missing store is a read failure (the caller names it unmeasured), never «no errors».
  if (!existsSync(path)) throw new Error('log store missing');
  const store = LogStore.openReadOnly(path);
  try {
    return store.query({ sinceMs: q.sinceMs, limit: q.limit, ...(q.minLevel ? { minLevel: q.minLevel as never } : {}), ...(q.grep ? { grep: q.grep } : {}), ...(q.categories ? { categories: q.categories } : {}) }) as LogRowLite[];
  } finally { try { (store as unknown as { close?: () => void }).close?.(); } catch { /* read-only */ } }
}

// ── mail ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function readMailWindow(sinceIso: string, untilIso: string): MailRow[] | null {
  try {
    const { openMsgStoreReadOnly } = req<typeof import('../msg/msg-store.js')>('../msg/msg-store.js');
    const store = openMsgStoreReadOnly();
    try { return store.listCreatedBetween(sinceIso, untilIso).map(m => ({ id: m.id, from: m.from, to: m.to, kind: m.kind ?? null, body: m.body, createdAt: m.createdAt })); }
    finally { store.close(); }
  } catch { return null; }
}

// ── one snapshot's sources ───────────────────────────────────────────────────────────────────────────────────────

const ENFORCE_TAIL = 400;
export function readEnforceRows(stateRoot: string): { since: number; noop: boolean; promise?: boolean }[] {
  try {
    const p = join(stateRoot, 'loops', 'op-turn-enforce.jsonl');
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(-ENFORCE_TAIL).flatMap((l) => {
      try { const r = JSON.parse(l) as { since?: string; noop?: boolean; promise?: boolean }; const t = Date.parse(r.since ?? ''); return Number.isFinite(t) ? [{ since: t, noop: !!r.noop, ...(r.promise ? { promise: true } : {}) }] : []; } catch { return []; }
    });
  } catch { return []; }
}

const SEAT_TOKEN = /^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\b/u;

/** Open cell blocks (this version) ⊕ `work:block` facts in [sinceMs, nowMs] — shared by the snapshot and the judge-butler. Throws on read faults. */
export function readLiveBlocks(stateRoot: string | null, version: string | null, sinceMs: number, nowMs: number): BlockIn[] {
  const blocks: BlockIn[] = [];
  if (version && stateRoot) {
    const { cellBlocksPath, openBlocks, readCellBlockRows } = req<typeof import('../steward/space/cell-block.js')>('../steward/space/cell-block.js');
    for (const b of openBlocks(readCellBlockRows(cellBlocksPath(stateRoot)), version).values()) blocks.push({ by: b.by, on: b.on, cell: b.cell, reason: b.reason ?? '', at: b.at });
  }
  const { readFacts } = req<typeof import('../fed-state/ledger.js')>('../fed-state/ledger.js');
  for (const f of readFacts({ since: new Date(sinceMs), until: new Date(nowMs + 1) }).facts) {
    if (f.type !== 'work' || f.state !== 'block' || !f.seat) continue;
    const on = f.to ?? SEAT_TOKEN.exec((f.kind ?? '').trim())?.[1] ?? null;
    blocks.push({ by: f.seat, on, cell: f.cell ?? '?', reason: f.kind ?? '', at: f.ts });
  }
  return blocks;
}

// OP-OBSERVE-LANDED neighbour (11-27 22:39): on an install the code root `versions/<dir>/node_modules/elanous` has no
// .git, so the git marker was null and the header read «build ?» while every pane showed its build. The install record
// next to it (`versions/<dir>/install.json` · `commit`) names the same build — the git marker first, then that record.
export function installedBuildSha(
  codeRoot: string = resolve(import.meta.dir, '..', '..'),
  deps: { gitSha?: () => string | null; readFile?: (p: string) => string } = {},
): string | null {
  try {
    const sha = (deps.gitSha ?? (() => req<typeof import('../mss/logging/log-store.js')>('../mss/logging/log-store.js').resolveInstalledSha()))();
    if (sha) return sha;
  } catch { /* fall through to the install record */ }
  try {
    const record = JSON.parse((deps.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(join(codeRoot, '..', '..', 'install.json'))) as { commit?: unknown };
    return typeof record.commit === 'string' && /^[0-9a-f]{7,40}$/u.test(record.commit) ? record.commit : null;
  } catch { return null; }
}

export async function collectFedSources(now: Date = new Date(), opts: { windowMin?: number } = {}): Promise<{ sources: FedSources; panes: LivePane[] }> {
  const unmeasured: string[] = [];
  const nowMs = now.getTime();
  const windowMin = opts.windowMin ?? 60;
  const sinceMs = nowMs - windowMin * 60_000;
  const { effectiveInstanceRoot } = req<typeof import('../instance/resolve.js')>('../instance/resolve.js');
  const stateRoot = (() => { try { return effectiveInstanceRoot(); } catch { return ''; } })();

  const installedSha = installedBuildSha();

  // panes
  let panes: LivePane[] | null = null; let rawPanes: Record<string, unknown>[] | null = null;
  try {
    const listing = await req<typeof import('../cli/els-cli.js')>('../cli/els-cli.js').federationListing();
    if (listing) { rawPanes = listing.panes; panes = panesFromListing(listing, sessionResolver()); } else unmeasured.push('panes(els ls)');
  } catch (e) { unmeasured.push(`panes(${short(e)})`); }
  const seatOfSession = new Map<string, string>(); const seatOfPid = new Map<number, string>();
  for (const p of panes ?? []) { if (p.sessionId) seatOfSession.set(p.sessionId, p.seat); if (p.pid) seatOfPid.set(p.pid, p.seat); }

  // log rows → errors · queue
  let errors: ErrorIn[] | null = null; let queues: QueueIn[] | null = null;
  const fatalBySeat = new Map<string, { at: number; what: string }[]>();
  try {
    const rows = [...readLogRows({ sinceMs, minLevel: 'error', limit: 3_000 }), ...readLogRows({ sinceMs, grep: '"reason":"Cap"', limit: 3_000 })];
    const seen = new Set<string>();
    errors = [];
    // Pid → seat through the pane's process tree is costly; the TUI's own pid is the manifest owner, which equals the
    // session mapping in practice — rows carry tuiSession too.
    for (const r of rows) {
      const key = `${r.ts_ms}|${r.category}|${r.event}|${r.data ?? ''}`.slice(0, 400);
      if (seen.has(key)) continue; seen.add(key);
      const c = classifyLogRow(r);
      if (!c) continue;
      const seat = (c.session ? seatOfSession.get(c.session) : undefined) ?? (c.pid ? seatOfPid.get(c.pid) : undefined);
      if (!seat) continue;
      errors.push({ seat, at: r.ts, kind: c.kind, what: c.what });
      if (c.kind === 'fatal') fatalBySeat.set(seat.toUpperCase(), [...(fatalBySeat.get(seat.toUpperCase()) ?? []), { at: r.ts_ms, what: c.what }]);
    }
    const depth = queueDepths(readLogRows({ sinceMs: nowMs - 2 * 3_600_000, categories: ['tui.queue'], limit: 5_000 }));
    queues = [...depth].flatMap(([s, n]) => { const seat = seatOfSession.get(s); return seat ? [{ seat, held: n }] : []; });
  } catch (e) { unmeasured.push(`logs(${short(e)})`); }

  // last turn per seat (from the transcripts)
  const facts: OutcomeFacts = { fatal: fatalBySeat, enforce: stateRoot ? readEnforceRows(stateRoot) : [] };
  let turns: TurnIn[] | null = null;
  if (panes) {
    turns = [];
    const read = seatTranscripts(panes, 512 * 1024);
    unmeasured.push(...read.unmeasured);
    for (const { seat, sessionId, messages } of read.sessions) {
      const p = { seat, sessionId };
      const last = turnsOf({ seat: p.seat, sessionId: p.sessionId, messages }, { now: nowMs, clip: 120, facts }).at(-1);
      if (last) turns.push({ seat: p.seat, at: last.at, outcome: last.outcome, why: last.why ?? last.reply.slice(0, 90) });
    }
  }

  // mail · ✋
  let mail: MailIn[] | null = null; let hands: FedSources['hands'] = null;
  try {
    const { openMsgStoreReadOnly } = req<typeof import('../msg/msg-store.js')>('../msg/msg-store.js');
    const store = openMsgStoreReadOnly();
    try {
      mail = [];
      const seats = new Set([...(panes ?? []).filter(p => !p.seat.startsWith('↻')).map(p => p.seat), 'OP', 'TC', 'JUD', 'UX', 'MK']);
      for (const seat of seats) {
        try {
          const unacked = store.unreadCount(seat);
          const oldest = unacked > 0 ? store.list(seat, 0, 1)[0]?.createdAt ?? null : null;
          mail.push({ seat, unacked, oldestAt: oldest });
        } catch { /* one seat unreadable */ }
      }
      try {
        const { openHands } = req<typeof import('../msg/hand-raise-ladder.js')>('../msg/hand-raise-ladder.js');
        hands = openHands(store, { now: nowMs }).map(h => ({ id: h.id, from: h.sender, to: h.receiver, blockedSeat: h.blockedSeat, reason: h.reason, waitedMs: h.waitedMs }));
      } catch (e) { unmeasured.push(`hands-raised(${short(e)})`); }
    } finally { store.close(); }
  } catch (e) { unmeasured.push(`mail(${short(e)})`); }

  // release checklist (cells · version)
  let version: string | null = null; let items: import('../release-loop/checklist.js').ChecklistItem[] | null = null;
  try {
    // OP-WORLD-LENS: the release in play (release.graph.version), not main's package version — the snapshot read the
    // published 0.3.37 board while 0.3.38 was live (11-27 · same fix as #40450 for the board readers).
    const { listChecklist } = req<typeof import('../release-loop/checklist.js')>('../release-loop/checklist.js');
    const { activeBoardVersion } = req<typeof import('../ops-dashboard/current-version.js')>('../ops-dashboard/current-version.js');
    version = activeBoardVersion(); items = listChecklist(version).items;
  } catch (e) { unmeasured.push(`checklist(${short(e)})`); }
  const release = version && items ? { version, green: items.filter(i => i.status === 'green' || i.status === 'done').length, yellow: items.filter(i => i.status === 'yellow').length, total: items.length } : null;

  // blocks: open cell blocks ⊕ recent work:block facts
  let blocks: BlockIn[] | null = null;
  try {
    blocks = readLiveBlocks(stateRoot, version, sinceMs, nowMs);
  } catch (e) { unmeasured.push(`blocks(${short(e)})`); }

  // HOLD ledger (HOLD-AS-LEDGER-OBJECT) — the hold-freeze rule reads registered HOLDs; null = unreadable (words fallback)
  let holdLedger: FedSources['holdLedger'] = null;
  try { holdLedger = req<typeof import('../hold-ledger/hold-ledger.js')>('../hold-ledger/hold-ledger.js').readHolds(stateRoot, now); }
  catch (e) { unmeasured.push(`hold-ledger(${short(e)})`); }

  // freeze · land
  let landingFreeze: FedSources['landingFreeze'] = null;
  try { const f = req<typeof import('../release-loop/landing-freeze.js')>('../release-loop/landing-freeze.js').readLandingFreeze(); landingFreeze = f ? { reason: f.reason, by: f.by, until: f.until } : null; }
  catch (e) { unmeasured.push(`freeze(${short(e)})`); }
  let landHolds: FedSources['landHolds'] = null; let land: FedSources['land'] = null;
  try {
    const lg = req<typeof import('../land-graph/land-graph.js')>('../land-graph/land-graph.js');
    landHolds = Object.entries(lg.readHolds(stateRoot)).map(([pr, h]) => ({ pr, reason: h.reason, by: h.by }));
    const rows = lg.readLedger(stateRoot).filter(r => !r.synthetic);
    const today = now.toISOString().slice(0, 10);
    const latest = new Map<number, (typeof rows)[number]>();
    for (const r of rows) if (r.event === 'decision' || r.event === 'refused' || r.event === 'landed') latest.set(r.pr, r);
    let mode = 'shadow';
    try { mode = req<typeof import('../cli/land-graph-cli.js')>('../cli/land-graph-cli.js').defaultLandDeps().mode; } catch { /* default */ }
    land = { lastAt: rows.at(-1)?.at ?? null, landedToday: rows.filter(r => r.event === 'landed' && r.at.startsWith(today)).length,
      pending: [...latest.values()].filter(r => r.event !== 'landed').length, mode };
  } catch (e) { unmeasured.push(`land-graph(${short(e)})`); }

  // commitments (OP)
  let commitments: FedSources['commitments'] = null;
  try {
    const { CommitmentLedger } = req<typeof import('../commitment/ledger.js')>('../commitment/ledger.js');
    const { listWakers } = req<typeof import('../msg/self-timer-watch.js')>('../msg/self-timer-watch.js');
    const { classifyDigest } = req<typeof import('../op-control/pulse-digest.js')>('../op-control/pulse-digest.js');
    const ledger = new CommitmentLedger();
    const list = ledger.list('OP');
    const rows = classifyDigest(list, listWakers('OP', { ledger }), nowMs, nowMs);
    commitments = { seat: 'OP', open: list.filter(c => c.status === 'open').length, overdue: rows.filter(r => r.bucket === 'overdue').length, action: rows.filter(r => r.bucket === 'action').length };
  } catch (e) { unmeasured.push(`commitments(${short(e)})`); }

  // judge queue (as the pulse measures it)
  let judge: FedSources['judge'] = null;
  try {
    if (version && items) {
      const { PREGATE_GREEN_DIR, readGreenTriageSources, triageGreen } = req<typeof import('../release-loop/green-triage.js')>('../release-loop/green-triage.js');
      const { readdirSync } = req<typeof import('node:fs')>('node:fs');
      const lanes = existsSync(PREGATE_GREEN_DIR) ? readdirSync(PREGATE_GREEN_DIR) : [];
      const triage = triageGreen(version, items, readGreenTriageSources({ greenLanes: () => lanes }));
      const updated = new Map(items.map(i => [i.id, Date.parse(i.updatedAt)] as const));
      const ages = triage.rows.judge.map(r => Math.max(0, (nowMs - (updated.get(r.id) ?? nowMs)) / 60_000));
      const { median } = req<typeof import('../loops/op-pulse.js')>('../loops/op-pulse.js');
      judge = { queue: ages.length, medianWaitMin: median(ages) };
    }
  } catch (e) { unmeasured.push(`judge(${short(e)})`); }

  // loops (trigger fires in the window) — read-only open; the registry's own reader
  let loops: FedSources['loops'] = null;
  try {
    const tr = req<typeof import('../loops/trigger-registry.js')>('../loops/trigger-registry.js');
    const path = tr.triggerRegistryPath(stateRoot);
    if (existsSync(path)) {
      const { Database } = req<typeof import('bun:sqlite')>('bun:sqlite');
      const db = new Database(path, { readonly: true });
      try {
        const fires = tr.listFires(db, undefined, 2_000).filter(f => { const t = Date.parse(f.dispatchedAt ?? f.window); return Number.isFinite(t) && t >= sinceMs; });
        const n = (s: string) => fires.filter(f => f.status === s).length;
        loops = { windowMin, ok: n('done'), goalNotMet: n('retry-wait'), failed: n('exception'), stale: n('stale-skipped'), running: n('running') + n('dispatched'),
          failing: [...new Set(fires.filter(f => f.status === 'exception' || f.status === 'retry-wait').map(f => f.graphId))] };
      } finally { db.close(); }
    } else unmeasured.push('loops(no registry)');
  } catch (e) { unmeasured.push(`loops(${short(e)})`); }

  // WORLD-REGISTRY — one line from the lease ledger (every actor: live · zombie · unregistered · no-owner).
  let world: FedSources['world'] = null;
  try {
    const d = req<typeof import('../resource-ledger/world-summary.js')>('../resource-ledger/world-summary.js').liveWorldDigest(now);
    if (d) world = { line: d.line, stale: d.stale, zombie: d.summary.zombie, unregistered: d.summary.unregistered, noOwner: d.summary.noOwner };
    else unmeasured.push('world(lease ledger)');
  } catch (e) { unmeasured.push(`world(${short(e)})`); }

  // KPIs · hand pool
  let kpi: FedSources['kpi'] = null;
  try { const k = req<typeof import('../fed-state/kpi.js')>('../fed-state/kpi.js').fedKpi({ window: '1h', now }); kpi = { landedPerHour: k.landedPerHour, opInboundPerHour: k.opInboundPerHour, idleWithWork: k.idleWithWorkSeats }; }
  catch (e) { unmeasured.push(`kpi(${short(e)})`); }
  let pool: PoolIn[] | null = null;
  try {
    const entries = await req<typeof import('../seat/hand-pool-live.js')>('../seat/hand-pool-live.js').liveHandPool({ now: nowMs, ...(rawPanes ? { panes: rawPanes } : {}) });
    pool = entries.map(h => ({ seat: h.seat, home: h.home, state: h.state, ...(h.cell ? { cell: h.cell } : {}), ...(h.since ? { since: h.since } : {}) }));
  } catch (e) { unmeasured.push(`hand-pool(${short(e)})`); }

  // ALLOCATION-BUDGET — the one budget line (lease ledger fold ⊕ usage snapshot · LLM 0)
  let budget: string | null = null;
  try {
    const a = req<typeof import('../allocation/alloc.js')>('../allocation/alloc.js');
    const f = req<typeof import('../allocation/fold.js')>('../allocation/fold.js');
    const p = req<typeof import('../allocation/policy.js')>('../allocation/policy.js');
    const r = req<typeof import('../resource-ledger/resource-ledger.js')>('../resource-ledger/resource-ledger.js');
    const events = r.readResourceLedger(r.resourceLedgerPath());
    budget = f.allocSummaryLine(f.foldAllocations(events, now), p.effectivePolicy(events), a.liveUsageSnapshot(), now);
  } catch (e) { unmeasured.push(`budget(${short(e)})`); }

  return { panes: panes ?? [], sources: { now, installedSha, panes, pool, turns, errors, queues, mail, hands, blocks, holdLedger, landingFreeze, landHolds, commitments, land, judge, loops, release, kpi, world, budget, unmeasured } };
}

// TRANSCRIPT-WINDOW (11-27 · «OP ran only 2 turns in the 00:18 window»): OP's transcript rows are large (mail bundles · tool
// output), so a fixed 4 MB tail held only the last ~2 turns of the hour — the chatlog undercounted OP while the log store
// shows a turn every 1–3 min. The chatlog read now grows (×2) until its first user row is before the window start.
// 출처: 64 MB — an OP session holds ~1–3 MB per turn hour at peak; 64 MB covers a day without reading whole archives.
export const TRANSCRIPT_WINDOW_MAX_BYTES = 64 * 1024 * 1024;

/** The transcript tail that reaches back to `sinceMs` (doubling from `startBytes`, at most TRANSCRIPT_WINDOW_MAX_BYTES). */
export function readTranscriptSince(sessionId: string, sinceMs: number, startBytes: number, read: (id: string, max: number) => SerializedMessage[] | null = readTranscriptTail): SerializedMessage[] | null {
  let bytes = Math.max(1, startBytes);
  for (;;) {
    const messages = read(sessionId, bytes);
    if (!messages) return null;
    const firstUser = messages.find(m => m.role === 'user');
    const reached = !firstUser || Date.parse(firstUser.ts) <= sinceMs;
    if (reached || bytes >= TRANSCRIPT_WINDOW_MAX_BYTES) return messages;
    const next = Math.min(TRANSCRIPT_WINDOW_MAX_BYTES, bytes * 2);
    const longer = read(sessionId, next);
    if (!longer || longer.length <= messages.length) return longer ?? messages; // the whole file was already read
    bytes = next;
    if (bytes >= TRANSCRIPT_WINDOW_MAX_BYTES) return longer;
  }
}

/** The chatlog's inputs: each live eln pane's transcript tail and the mails of the window. */
export async function collectChatSources(input: { now: Date; sinceMs: number; maxBytes: number }): Promise<{ sessions: SeatSession[]; mails: MailRow[]; facts: OutcomeFacts; unmeasured: string[] }> {
  const unmeasured: string[] = [];
  const listing = await req<typeof import('../cli/els-cli.js')>('../cli/els-cli.js').federationListing().catch(() => null);
  const panes = listing ? panesFromListing(listing, sessionResolver()) : [];
  if (!listing) unmeasured.push('panes(els ls)');
  const { sessions, unmeasured: unread } = seatTranscripts(panes, input.maxBytes, (id, max) => readTranscriptSince(id, input.sinceMs, max));
  unmeasured.push(...unread);
  const mails = readMailWindow(new Date(input.sinceMs).toISOString(), new Date(input.now.getTime() + 1_000).toISOString());
  if (!mails) unmeasured.push('mail');
  const seatOfSession = new Map(panes.flatMap(p => (p.sessionId ? [[p.sessionId, p.seat] as const] : [])));
  const fatal = new Map<string, { at: number; what: string }[]>();
  try {
    for (const r of readLogRows({ sinceMs: input.sinceMs, minLevel: 'error', limit: 3_000 })) {
      const c = classifyLogRow(r);
      const seat = c?.session ? seatOfSession.get(c.session) : undefined;
      if (c?.kind === 'fatal' && seat) fatal.set(seat.toUpperCase(), [...(fatal.get(seat.toUpperCase()) ?? []), { at: r.ts_ms, what: c.what }]);
    }
  } catch (e) { unmeasured.push(`logs(${short(e)})`); }
  let enforce: OutcomeFacts['enforce'] = [];
  try { enforce = readEnforceRows(req<typeof import('../instance/resolve.js')>('../instance/resolve.js').effectiveInstanceRoot()); } catch { /* none */ }
  return { sessions, mails: mails ?? [], facts: { fatal, enforce }, unmeasured };
}
