// SIM-WORLD-SEAT-MAIL — mail-exchange defects first seen only on live seats (11-18 · seat-state/OP/evidence/20261118/
// ELN-SEAT-LIVE-1118.tsv), replayed on the kernel contract. Each scenario calls the real code path (real MsgStore on a
// ledger file inside the scenario universe, real queue, real watcher, real `msg post` action); only the outside
// (clock · LLM · herdr · a lock that hits after the commit) is faked. The real seat ledger is never opened.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerMsgCommands } from '../../../cli/msg-cli.js';
import { MsgStore } from '../../../msg/msg-store.js';
import { dispatchMsgAck, dispatchMsgPost } from '../../../skills/tools/ops-ledger.js';
import { createNextTuiQueue } from '../../../tui/core/queue.js';
import { noticeOneDispatch, openExternalEventOne, resetExternalEventOneWire } from '../../../tui/external-event-one-wire.js';
import { createIdleWakeDoor } from '../../../tui/idle-wake-door.js';
import { createSeatMailArrivalWatcher } from '../../../tui/seat-mail-arrival.js';
import { createSeatMailAdapter, MAIL_BACKOFF_BASE_MS } from '../../../tui/turn-events/mail-adapter.js';
import { createLedgerReceiptWriter, readSeatMailMessages } from '../../../tui/seat-message-receipts.js';
import { runCoreTurn } from '../../../core-turn/run-core-turn.js';
import type { LLMProvider } from '../../../llm.js';
import { wakeRecipient } from '../../../loops/msg-wake.js';
import { setUserConfigOverlay } from '../../../user-config.js';
import { createFakeHerdr } from '../../fake-herdr.js';
import type { SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const SEAT = 'SIMSEAT';

function seatUniverse(ctx: SimWorldScenarioContext) {
  // env {} : the seat comes from the universe cwd only — a host ELANOUS_SEAT must never point a scenario at a real seat.
  const home = join(ctx.universeRoot, 'home');
  mkdirSync(join(home, 'elanous-hq', 'seat-state', SEAT), { recursive: true });
  const cwd = join(ctx.universeRoot, 'seats', SEAT);
  mkdirSync(cwd, { recursive: true });
  const msgPath = join(ctx.universeRoot, 'messages.db');
  const withStore = <T>(fn: (store: MsgStore) => T): T => {
    const store = new MsgStore(msgPath);
    try { return fn(store); } finally { store.close(); }
  };
  return { home, cwd, msgPath, withStore };
}

const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });

/** M2 · 12:44 JUD «Queue 10» (REL «Queue 3641» with 8 unread): a new session replays acknowledged history. */
const m2: SimWorldScenario = {
  id: 'M2',
  title: 'a fresh session queues only unacknowledged seat mail',
  async run(ctx) {
    const u = seatUniverse(ctx);
    const acknowledged = 300;
    u.withStore((store) => store.db.transaction(() => {
      for (let i = 0; i < acknowledged; i += 1) store.post({ from: 'OP', to: SEAT, body: `old report ${i}` });
    }).immediate());
    u.withStore((store) => store.ack(SEAT, acknowledged));
    const fresh = u.withStore((store) => [store.post({ from: 'OP', to: SEAT, body: 'new request a' }).id, store.post({ from: 'OP', to: SEAT, body: 'new request b' }).id]);
    const queue = createNextTuiQueue({ log: () => {} });
    const watcher = createSeatMailArrivalWatcher(u.cwd, queue, {
      messages: { read: (cwd, afterId) => readSeatMailMessages(cwd, afterId, { home: u.home, msgPath: u.msgPath, env: {} as NodeJS.ProcessEnv }), receipts: createLedgerReceiptWriter(u.msgPath) },
    });
    const polls = [watcher.poll(), watcher.poll()];
    const queued = queue.items.filter((item) => item.source === 'seat-mail').map((item) => item.msgId ?? null);
    ctx.recorder.event('m2-queued', { count: queued.length, first: queued[0] ?? null, last: queued.at(-1) ?? null });
    if (JSON.stringify(queued) === JSON.stringify(fresh)) return { ok: true };
    const reason = queued.length > fresh.length ? 'acknowledged mail replayed into the queue' : 'unacknowledged mail not queued';
    return fail(reason, `queued ${queued.length} seat-mail notices (first ${queued[0]} · last ${queued.at(-1)}), expected exactly ${JSON.stringify(fresh)} · polls ${JSON.stringify(polls)}`);
  },
};

/** A real store whose close() fails the way a busy ledger did on 11-18 13:11 — after the write already committed. */
class LockedAfterCommitStore extends MsgStore {
  override close(): void {
    super.close();
    throw new Error('database is locked');
  }
}

/** M4 · 13:09–13:11 JUD: `msg post` said «DB 잠김» although the row was stored → the seat retried → 9+ copies. */
const m4: SimWorldScenario = {
  id: 'M4',
  title: 'msg post that committed before a lock reports success, and a retry does not duplicate',
  async run(ctx) {
    const u = seatUniverse(ctx);
    const exits: number[] = [];
    const stderr: string[] = [];
    const program = new Command();
    registerMsgCommands(program, {
      openStore: () => new LockedAfterCommitStore(u.msgPath),
      out: { log: () => {}, error: (line) => { stderr.push(line); } },
      readStdin: async () => '',
      setExitCode: (code) => { exits.push(code); },
      registerLogSink: async () => undefined,
      wake: async (address, msgId) => ({ wake: 'none', source: 'unresolved', address, msgId, result: 'skipped-test-universe' }),
      postOfficeStateRoot: ctx.universeRoot,
    });
    const body = 'JUD 판정 영수증 #1';
    // The seat's rule on a failed post is «retry»; a success is posted once.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = exits.length;
      await program.parseAsync(['msg', 'post', '--from', 'JUD', '--to', 'OP', '--body', body, '--kind', 'report'], { from: 'user' });
      if (exits.length === before) break;
    }
    const rows = u.withStore((store) => store.db.query('SELECT id FROM msg_messages WHERE body = ?').all(body) as Array<{ id: number }>);
    ctx.recorder.event('m4-posted', { rows: rows.length, failures: exits.length });
    if (exits.length === 0 && rows.length === 1) return { ok: true };
    return fail('committed post reported as failure', `exit codes ${JSON.stringify(exits)} · stored rows ${rows.length} · first error ${JSON.stringify(stderr[0] ?? null)}`);
  },
};

/** M5 · 11:48 eln-main: the turn that took a mail notice failed («인증에 실패») yet the mail was marked seen. Fixed by #38483. */
const m5: SimWorldScenario = {
  id: 'M5',
  title: 'a failed turn leaves its mail unseen and offers it again',
  async run(ctx) {
    const u = seatUniverse(ctx);
    const queue = createNextTuiQueue({ log: () => {} });
    // CAPSULE-FLAGS-REMOVE-DEFAULT R4: the mail owner is always on — a failed turn's mail comes back after the back-off.
    let at = 1_000_000;
    const watcher = createSeatMailArrivalWatcher(u.cwd, queue, {
      messages: { read: (cwd, afterId) => readSeatMailMessages(cwd, afterId, { home: u.home, msgPath: u.msgPath, env: {} as NodeJS.ProcessEnv }), receipts: createLedgerReceiptWriter(u.msgPath) },
      mailAdapter: createSeatMailAdapter({ now: () => at }),
    });
    try {
      watcher.poll();
      const posted = u.withStore((store) => store.post({ from: 'OP', to: SEAT, body: '노크 우편 — 받으면 한 줄', intent: 'request' }));
      watcher.poll();
      queue.dequeue();
      watcher.noteTurnFinished(false);
      at += MAIL_BACKOFF_BASE_MS;
      watcher.poll();
      const states = u.withStore((store) => store.listReceipts({ messageId: posted.id }).map((row) => row.state));
      const reoffered = queue.items.filter((item) => item.source === 'seat-mail').map((item) => item.msgId ?? null);
      ctx.recorder.event('m5-after-failed-turn', { states, reoffered });
      if (!states.includes('seen') && JSON.stringify(reoffered) === JSON.stringify([posted.id])) return { ok: true };
      return fail('failed turn swallowed the mail', `receipts ${JSON.stringify(states)} · queued again ${JSON.stringify(reoffered)} (expected no seen · [${posted.id}])`);
    } finally { watcher.stop(); }
  },
};

/** M7 · 10:36 HAND-ELN-ELS-API: one mail became two turns (herdr typed the notice ⊕ the seat-mail queue). Fixed by #38449. */
const m7: SimWorldScenario = {
  id: 'M7',
  title: 'one mail to an eln seat is never typed into its pane',
  async run(ctx) {
    const typed: string[] = [];
    const herdr = createFakeHerdr({ panes: [{ paneId: 'wS:p1', agent: 'elanous', status: 'idle' }], onRun: (run) => { typed.push(run.text); } });
    const outcome = await wakeRecipient(SEAT, 1, { from: 'OP' }, {
      stateRoot: ctx.universeRoot, seatStateRoot: join(ctx.universeRoot, 'seat-state'), live: true, now: () => 1_000_000,
      readRegistry: () => ({ status: 'ready', registry: { version: 1, seats: [{ address: SEAT, host: 'local', target: 'wS:p1', wake: 'herdr', replyBody: 'agent', optIn: true, runtime: 'eln' }] } }),
      listHerdrPanes: () => [{ paneId: 'wS:p1', status: 'idle' }], listPtys: () => [], readPane: () => null, hasOptIn: () => false,
      herdrRun: herdr.run, warn: () => {},
    });
    ctx.recorder.event('m7-wake', { result: outcome.result, reason: outcome.reason ?? null, typed: typed.length });
    if (typed.length === 0 && outcome.result === 'eln-mail-watch') return { ok: true };
    return fail('mail typed into an eln pane', `wake ${outcome.result}/${outcome.reason ?? '-'} · typed ${JSON.stringify(typed)}`);
  },
};

/** M6 — MsgAck moves only the cursor; the answered turn records seen with its queue identity (#122460). */
const m6: SimWorldScenario = {
  id: 'M6',
  title: 'tool ack moves the cursor and the answered turn records seen',
  async run(ctx) {
    const u = seatUniverse(ctx);
    const ids = u.withStore((store) => [store.post({ from: 'OP', to: SEAT, body: 'a' }).id, store.post({ from: 'OP', to: SEAT, body: 'b' }).id]);
    await dispatchMsgAck({ to: SEAT, id: ids.at(-1)! }, { openStore: () => new MsgStore(u.msgPath) });
    const before = u.withStore((store) => ({ cursor: store.getCursor(SEAT), seen: ids.map((id) => store.listReceipts({ messageId: id }).some((row) => row.state === 'seen')) }));
    const receipts = createLedgerReceiptWriter(u.msgPath);
    for (const id of ids) receipts.record({ messageId: id, recipient: SEAT, state: 'seen', queueItemId: `sim-m6-${id}` });
    const seen = u.withStore((store) => ids.map((id) => store.listReceipts({ messageId: id }).some((row) => row.state === 'seen' && row.queueItemId === `sim-m6-${id}`)));
    ctx.recorder.event('m6-ack', { ids, before, seen });
    if (before.cursor === ids.at(-1) && before.seen.every(value => !value) && seen.every(Boolean)) return { ok: true };
    return fail('ack or answered-turn receipt differs', `before ${JSON.stringify(before)} · seen ${JSON.stringify(seen)}`);
  },
};

/** M1 · 12:44 HAND-ELN-MSG: «Turn idle · Queue 1» for minutes — the knock that should start the queued mail never reached the
 * loop (the terminal refused the key), yet the door reported it delivered and left no trace. Fix #38510. */
const m1: SimWorldScenario = {
  id: 'M1',
  title: 'an idle knock the terminal refuses is reported as not delivered and leaves an event',
  async run(ctx) {
    const queue = createNextTuiQueue({ log: () => {} });
    queue.enqueue('[seat-mail] OP → SIMSEAT #1');
    const events: string[] = [];
    const door = createIdleWakeDoor({
      busy: () => false,
      injectKey: () => false,
      queueWake: { name: 'queueWake' },
      // `log` is #38510's seam; on main the door ignores it (that silence is the defect).
      log: (event: string) => { events.push(event); },
    } as Parameters<typeof createIdleWakeDoor>[0]);
    door.register({ id: 'seat-mail' });
    const delivered = door.knock('seat-mail');
    ctx.recorder.event('m1-knock', { delivered, events, queued: queue.items.length });
    if (!delivered && events.includes('wake-knock-refused')) return { ok: true };
    return fail('refused knock reported as delivered', `knock() = ${delivered} · events ${JSON.stringify(events)} · queue still ${queue.items.length}`);
  },
};

/** M3 · 12:44 JUD-B: a stream that only «thinks» (reasoning deltas, no text, no tool) kept the seat «Responding» 1h03m.
 * With a no-output limit set the turn must end by itself; the scenario's own cap (not the turn) stops it on main. Fix #38515.
 * The turn offers one tool, as every seat turn does: a tool-less turn takes another stream path (#38515 covers the tool loop). */
const m3: SimWorldScenario = {
  id: 'M3',
  title: 'a stream with reasoning but no output ends the turn by itself',
  async run(ctx) {
    const limitMs = 80;
    const capMs = 3_000;
    const aborter = new AbortController();
    const thinker: LLMProvider = {
      name: 'sim-reasoning-only', defaultModel: 'sim-reasoning-only-model', available: () => true,
      async *chat() { yield 'unused'; },
      async *streamChat(_messages, opts) {
        while (!opts?.signal?.aborted && !aborter.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          yield { type: 'reasoning', kind: 'inline_delta', delta: '…' };
        }
      },
    };
    const previous = setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto', fallbackChain: [], turnNoProgressMs: limitMs } }));
    const started = Date.now();
    let cap: ReturnType<typeof setTimeout> | undefined;
    try {
      const ended = await Promise.race([
        runCoreTurn({ sessionId: 'sim-m3', messages: [{ role: 'user', content: 'do the work' }], tools: [{ name: 'probe', description: 'a tool the turn may call', parameters: { type: 'object', properties: {} } }], dispatchTool: async () => ({ ok: true }), signal: aborter.signal, initialProvider: thinker },
          // stallSeat/stallMailer are #38515's seam: on that head the stall notice goes to this fake, never the real ledger.
          { stallSeat: SEAT, stallMailer: async () => {} } as Parameters<typeof runCoreTurn>[1])
          .then(() => 'answered', () => 'ended-with-error'),
        new Promise<'still-responding'>((resolve) => { cap = setTimeout(() => resolve('still-responding'), capMs); }),
      ]);
      const elapsedMs = Date.now() - started;
      ctx.recorder.event('m3-turn', { ended, elapsedMs, limitMs, capMs });
      if (ended !== 'still-responding') return { ok: true };
      return fail('silent stream never ended the turn', `turn still Responding after ${capMs} ms with turnNoProgressMs ${limitMs}`);
    } finally {
      if (cap) clearTimeout(cap);
      aborter.abort();
      setUserConfigOverlay(previous);
    }
  },
};

/** M1b · 10:20 HAND-TUI-D: a duplicate (or refused) queue notice opened no turn and woke nothing, so the next queued
 * notice sat until a human typed. Fixed by #38501 (minimal split of #38443). Same dispatch rule entry.ts runs. */
const m1b: SimWorldScenario = {
  id: 'M1b',
  title: 'a duplicate queue notice opens no turn but wakes the next queued item',
  async run(ctx) {
    resetExternalEventOneWire();
    try {
      const queue = createNextTuiQueue({ log: () => {} });
      queue.enqueue('[seat-mail] OP → SIMSEAT #1 (copy)');
      queue.enqueue('[seat-mail] OP → SIMSEAT #2');
      openExternalEventOne({ id: 'mail-1', text: 'first delivery', source: 'seat-mail', receivedAt: 1_000 });
      queue.dequeue();
      const copy = openExternalEventOne({ id: 'mail-1', text: 'first delivery', source: 'seat-mail', receivedAt: 2_000 });
      const dispatch = noticeOneDispatch({ injected: copy.injected, remaining: queue.items.length });
      const next = dispatch.wakeQueue ? queue.dequeue().kind : 'not-woken';
      ctx.recorder.event('m1b-duplicate', { injected: copy.injected, dispatch, next });
      if (!dispatch.startTurn && next === 'submit') return { ok: true };
      return fail('duplicate notice left the queue asleep', `injected ${copy.injected} · dispatch ${JSON.stringify(dispatch)} · next ${next}`);
    } finally { resetExternalEventOneWire(); }
  },
};

/** M8 · 11-23 ELN-RESEARCH-TURN-SEAT-REPLY: a seat mail «look this up and reply to MK» became a research turn, and the
 * research allowlist stripped MsgPost — the seat researched but could not reply. The turn runs the real core turn with a
 * fake LLM (research evidence faked); its MsgPost goes through the real tool into this universe's ledger. */
const m8: SimWorldScenario = {
  id: 'M8',
  title: 'a seat research turn from seat mail replies by MsgPost into the ledger',
  async run(ctx) {
    const u = seatUniverse(ctx);
    const request = u.withStore((store) => store.post({ from: 'MK', to: SEAT, body: 'Research recent battery policy updates using current sources.', intent: 'request' }));
    const replyBody = `battery policy summary for #${request.id}`;
    const offered: string[][] = [];
    let replyDispatched = false;
    let researchRuns = 0;
    const replier: LLMProvider = {
      name: 'sim-seat-researcher', defaultModel: 'sim-seat-researcher-model', available: () => true,
      async *chat() { yield 'unused'; },
      async *streamChat(_messages, opts) {
        const names = (opts?.tools ?? []).map((tool) => tool.name);
        offered.push(names);
        if (!replyDispatched && names.includes('MsgPost')) {
          yield { type: 'tool_call', id: 'sim-m8-reply', name: 'MsgPost', args: { from: SEAT, to: 'MK', body: replyBody, replyTo: request.id } };
          return;
        }
        yield { type: 'text', delta: 'replied to MK' };
      },
    };
    const mailTool = (name: string) => ({ name, description: `${name} seat mail`, parameters: { type: 'object', properties: {} } });
    const previous = setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto', fallbackChain: [] } }));
    try {
      await runCoreTurn({
        sessionId: 'sim-m8', messages: [{ role: 'user', content: `[seat-mail] MK → ${SEAT} #${request.id}: ${request.body}` }], userText: request.body,
        tools: [mailTool('WebSearch'), mailTool('WebFetch'), mailTool('MsgList'), mailTool('MsgPost'), mailTool('MsgAck')],
        dispatchTool: async (name, args) => {
          if (name !== 'MsgPost') return { ok: true };
          replyDispatched = true;
          return dispatchMsgPost(args as Record<string, unknown>, { openStore: () => new MsgStore(u.msgPath) });
        },
        signal: new AbortController().signal, initialProvider: replier,
      }, { runResearch: async () => { researchRuns++; return { ok: true, output: 'research evidence' }; }, stallSeat: SEAT, stallMailer: async () => {} });
    } finally { setUserConfigOverlay(previous); }
    const rows = u.withStore((store) => store.list('MK').filter(row => row.body === replyBody));
    ctx.recorder.event('m8-reply', { rows: rows.length, researchRuns, offered: offered[0] ?? [] });
    if (researchRuns === 1 && rows.length === 1 && rows[0]!.from === SEAT && rows[0]!.to === 'MK' && rows[0]!.replyTo === request.id) return { ok: true };
    return fail('seat research turn could not reply', `reply rows ${JSON.stringify(rows)} · first tool set ${JSON.stringify(offered[0] ?? [])}`);
  },
};

export const simWorldScenarios: readonly SimWorldScenario[] = [m1, m1b, m2, m3, m4, m5, m6, m7, m8];
