// KIT mail-route sim seeds (CEO 11-27 «중복된 내용들 정리») — each scenario drives the real code path inside its universe:
// the real TUI bundle builder and the real repl interjection builder (fold-once), the real `msg post` CLI with a faked
// wake census (dormant reroute ⊕ live probe · sender = caller), the real MsgStore (P0 bypasses the OP machine digest).
// The real seat ledger is never opened; the host ELANOUS_TRACK is never read (callerSeat is pinned per scenario).
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { buildInterjectionMessage } from '../../../chat/interjection.js';
import { registerMsgCommands } from '../../../cli/msg-cli.js';
import { cheapHandClassifier, createMailFoldLedger, handAskAnswer, handCellLookupsFrom, mailFoldFile, msgPostArgsAsCaller, sweepDormantUnanswered, type HandCellLookups, type HandRootClassifier } from '../../../kit/mail-route/index.js';
import { MsgStore } from '../../../msg/msg-store.js';
import { createBusWakeGate } from '../../../op-context-bus/seat-turn.js';
import { seatMailBundleText } from '../../../tui/seat-mail-digest.js';
import { createNeedsHumanPush } from '../../../tui/needs-human-push.js';
import type { MessageEnvelope } from '../../../msg/msg-store.js';
import type { SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });

function cliUniverse(ctx: SimWorldScenarioContext, wakeDeps?: unknown, classifyHand?: HandRootClassifier | null, handCells?: HandCellLookups | null) {
  const msgPath = join(ctx.universeRoot, 'messages.db');
  const cwd = join(ctx.universeRoot, 'elanous-hq', 'seats', 'SIMSEAT');
  mkdirSync(cwd, { recursive: true });
  const stderr: string[] = [];
  const stdout: string[] = [];
  const exits: number[] = [];
  const program = new Command();
  registerMsgCommands(program, {
    openStore: () => new MsgStore(msgPath),
    out: { log: (line) => { stdout.push(line); }, error: (line) => { stderr.push(line); } },
    readStdin: async () => '',
    setExitCode: (code) => { exits.push(code); },
    registerLogSink: async () => undefined,
    wake: async (address, msgId) => ({ wake: 'none', source: 'unresolved', address, msgId, result: 'skipped-test-universe' }),
    postOfficeStateRoot: ctx.universeRoot,
    divertedRoot: join(ctx.universeRoot, 'diverted'),
    callerSeat: () => null,
    cwd: () => cwd,
    ...(wakeDeps === undefined ? {} : { wakeDeps: wakeDeps as never }),
    classifyHand: classifyHand ?? null,
    handCells: handCells ?? null,
  });
  const rows = (): Array<{ sender: string; recipient: string; body: string; refs_json: string | null }> => {
    const store = new MsgStore(msgPath);
    try { return store.db.query('SELECT sender, recipient, body, refs_json FROM msg_messages ORDER BY id').all() as never; } finally { store.close(); }
  };
  const post = (argv: string[]) => program.parseAsync(argv, { from: 'user' });
  return { msgPath, cwd, stderr, exits, post, rows, logs: stdout };
}

/** MR1 · 11-27 «다이제스트 경로 둘» — the same machine mail reached OP in the TUI bundle AND the repl mid-turn digest. */
const mr1: SimWorldScenario = {
  id: 'MR1',
  title: 'the same machine mail via the TUI bundle and the repl path is folded once',
  async run(ctx) {
    const file = mailFoldFile('OP', join(ctx.universeRoot, 'diverted'));
    // Two ledgers on one mirror file = the TUI process and a second process for the same seat.
    const tuiFold = createMailFoldLedger('OP', { file });
    const replFold = createMailFoldLedger('OP', { file });
    const tui = seatMailBundleText([
      { text: 'landed #40001', source: 'seat-mail', msgId: 9001, passive: true, digest: '#9001 · LAND-GRAPH · status · landed #40001', mail: { sender: 'LAND-GRAPH' } },
      { text: 'judge ok', source: 'seat-mail', msgId: 9002, passive: true, digest: '#9002 · JUDGE-BUTLER · status · judge ok', mail: { sender: 'JUDGE-BUTLER' } },
    ], tuiFold);
    const repl = buildInterjectionMessage([
      { kind: 'seat-mail', msgId: 9001, from: 'LAND-GRAPH', intent: 'info', text: 'landed #40001', viaLedger: true },
      { kind: 'seat-mail', msgId: 9003, from: 'LAND-GRAPH', intent: 'info', text: 'landed #40002', viaLedger: true },
    ], 'mid-turn', new Set(['LAND-GRAPH']), replFold) ?? '';
    const listed = (text: string, id: number) => text.split('\n').filter((line) => line.includes(`#${id} · `)).length;
    const counts = { tui9001: listed(tui, 9001), repl9001: listed(repl, 9001), repl9003: listed(repl, 9003), already: repl.includes('#9001 — not repeated') };
    ctx.recorder.event('mr1-folds', counts);
    if (counts.tui9001 === 1 && counts.repl9001 === 0 && counts.repl9003 === 1 && counts.already) return { ok: true };
    return fail('same mail listed by two digest paths', JSON.stringify(counts));
  },
};

const liveRes = { live: false, readRegistry: () => ({ status: 'ready', registry: { version: 1, seats: [{ address: 'RES', host: 'local', target: 'wR:p1', wake: 'herdr', replyBody: 'agent', optIn: true, runtime: 'codex' }] } }),
  listHerdrPanes: () => [{ paneId: 'wR:p1', status: 'idle' }], listPtys: () => [], readPane: () => null, hasOptIn: () => false };
const deadRes = { live: false, readRegistry: () => ({ status: 'ready', registry: { version: 1, seats: [] } }),
  listHerdrPanes: () => [], listPtys: () => [], readPane: () => null, hasOptIn: () => false };

/** MR2 · LA-R2 — a revived RES tab must get its mail directly; a dormant RES is rerouted (sender gets one line). */
const mr2: SimWorldScenario = {
  id: 'MR2',
  title: 'dormant reroute respects the live probe at the msg post entrance',
  async run(ctx) {
    const live = cliUniverse(ctx, liveRes);
    await live.post(['msg', 'post', '--from', 'TC', '--to', 'RES', '--kind', 'report', '--body', 'node-b load 60 (live)']);
    const liveRows = live.rows().filter((r) => r.body.includes('(live)'));
    const deadCtx = { ...ctx, universeRoot: join(ctx.universeRoot, 'dead') };
    mkdirSync(deadCtx.universeRoot, { recursive: true });
    const dead = cliUniverse(deadCtx, deadRes);
    await dead.post(['msg', 'post', '--from', 'TC', '--to', 'RES', '--kind', 'report', '--body', 'node-b load 60 (dead)']);
    const deadToRes = dead.rows().filter((r) => r.recipient === 'RES').length;
    const note = dead.stderr.some((line) => line.includes('RES has no live tab'));
    const facts = { liveRecipient: liveRows[0]?.recipient ?? null, liveRows: liveRows.length, deadToRes, note, exits: [...live.exits, ...dead.exits] };
    ctx.recorder.event('mr2-reroute', facts);
    if (facts.liveRecipient === 'RES' && facts.liveRows === 1 && deadToRes === 0 && note) return { ok: true };
    return fail('dormant reroute ignored the live probe', JSON.stringify(facts));
  },
};

/** MR3 · SIGNAL-DIET — machine mail to OP folds into the digest; P0 never waits for the window. */
const mr3: SimWorldScenario = {
  id: 'MR3',
  title: 'P0 machine mail bypasses the 30-min OP digest; plain machine mail folds into one digest',
  async run(ctx) {
    let nowMs = Date.parse('2026-11-27T03:00:00Z');
    const store = new MsgStore(join(ctx.universeRoot, 'messages.db'), { now: () => new Date(nowMs) });
    try {
      store.post({ from: 'LAND-GRAPH', to: 'OP', kind: 'status', body: 'landed #40001' });
      store.post({ from: 'LAND-GRAPH', to: 'OP', kind: 'status', body: 'landed #40002' });
      store.post({ from: 'LAND-GRAPH', to: 'OP', kind: 'status', body: 'train stuck', priority: 1 });
      const before = store.list('OP').map((m) => m.body);
      nowMs += 31 * 60_000;
      const digest = store.flushOpDigestIfDue();
      const after = store.list('OP').map((m) => m.from);
      const facts = { before, digestFrom: digest?.from ?? null, digestCounts: digest?.body.includes('LAND-GRAPH 2') ?? false, after };
      ctx.recorder.event('mr3-p0', facts);
      if (before.length === 1 && before[0] === 'train stuck' && facts.digestFrom === 'SIGNAL-DIGEST' && facts.digestCounts && after.length === 2) return { ok: true };
      return fail('P0 waited for the digest or plain machine mail did not fold', JSON.stringify(facts));
    } finally { store.close(); }
  },
};

/** MR4 · pr-cli / drift-radar posted `--from OPC` from any process — the row must carry the caller's seat. */
const mr4: SimWorldScenario = {
  id: 'MR4',
  title: 'a child msg post from the land line carries the caller seat, never a hardcoded OPC',
  async run(ctx) {
    const u = cliUniverse(ctx);
    await u.post(msgPostArgsAsCaller({ to: 'MK', body: 'conflict on #40010 (seat)', fallback: 'LAND-GRAPH', env: {} as NodeJS.ProcessEnv, cwd: u.cwd }));
    await u.post(msgPostArgsAsCaller({ to: 'MK', body: 'conflict on #40011 (no seat)', fallback: 'LAND-GRAPH', env: {} as NodeJS.ProcessEnv, cwd: ctx.universeRoot }));
    const senders = u.rows().filter((r) => r.recipient === 'MK').map((r) => r.sender);
    ctx.recorder.event('mr4-sender', { senders, exits: u.exits });
    if (senders.length === 2 && senders[0] === 'SIMSEAT' && senders[1] === 'LAND-GRAPH') return { ok: true };
    return fail('child msg post signed as someone other than the caller', JSON.stringify({ senders, exits: u.exits, err: u.stderr.slice(0, 2) }));
  },
};

/** MR5 · the other order — the repl mid-turn digest lists the mail first, the TUI idle bundle after it must not. */
const mr5: SimWorldScenario = {
  id: 'MR5',
  title: 'repl path first, TUI bundle second: the mail is still folded once',
  async run(ctx) {
    const fold = createMailFoldLedger('OP', { file: mailFoldFile('OP', join(ctx.universeRoot, 'diverted')) });
    const repl = buildInterjectionMessage([{ kind: 'seat-mail', msgId: 9101, from: 'GUARDIAN', intent: 'info', text: 'node-b ok', viaLedger: true }],
      'mid-turn', new Set(['GUARDIAN']), fold) ?? '';
    const tui = seatMailBundleText([
      { text: 'node-b ok', source: 'seat-mail', msgId: 9101, passive: true, digest: '#9101 · GUARDIAN · status · node-b ok', mail: { sender: 'GUARDIAN' } },
      { text: 'please decide on #40020', source: 'seat-mail', msgId: 9102, passive: false, digest: '#9102 · TC · request · please decide on #40020', mail: { sender: 'TC' } },
    ], fold);
    const facts = { repl: repl.includes('#9101 · GUARDIAN · info · node-b ok'), tuiLine: tui.includes('#9101 · GUARDIAN · status'), tuiAlready: tui.includes('#9101 — not repeated'), action: tui.includes('please decide on #40020') };
    ctx.recorder.event('mr5-folds', facts);
    if (facts.repl && !facts.tuiLine && facts.tuiAlready && facts.action) return { ok: true };
    return fail('reverse-order fold listed the mail twice or dropped the action mail', JSON.stringify(facts));
  },
};

/** MR6 · bus path — one wake per window; a prio:P0 item wakes at once inside the window. */
const mr6: SimWorldScenario = {
  id: 'MR6',
  title: 'bus wake: P0 bypasses the window, a normal item defers to the window end',
  async run(ctx) {
    const gate = createBusWakeGate('TC', 30 * 60_000);
    const item = (id: string, refs: string[]) => ({ id, type: 'handoff', from: 'OP', owner: 'TC', body: 'do X', refs, at: '2026-11-27T03:00:00Z', alsoFrom: [] }) as never;
    const actions = [gate.offer([item('m1', [])], 0), gate.offer([item('m2', [])], 5 * 60_000), gate.offer([item('m3', ['prio:P0'])], 6 * 60_000)];
    ctx.recorder.event('mr6-bus', { actions });
    const want = JSON.stringify([{ action: 'wake', reason: 'normal' }, { action: 'defer', dueAt: 1_800_000 }, { action: 'wake', reason: 'urgent' }]);
    return JSON.stringify(actions) === want ? { ok: true } : fail('bus wake ignored the window or the P0 bypass', JSON.stringify(actions));
  },
};

/** MR7 · #191271 — OP's own mail to a dormant RES was rerouted to the OP digest: OP woke itself, nobody got the mail. */
const mr7: SimWorldScenario = {
  id: 'MR7',
  title: 'OP mail to a dormant RES goes to GUARDIAN, never back to OP',
  async run(ctx) {
    const u = cliUniverse(ctx, deadRes);
    await u.post(['msg', 'post', '--from', 'OP', '--to', 'RES', '--kind', 'report', '--body', 'node-b disk 92% — clean?']);
    const rows = u.rows();
    const store = new MsgStore(u.msgPath);
    let parked = 0;
    try { parked = store.pendingOpDigest().length; } finally { store.close(); }
    const facts = { recipients: rows.map((r) => r.recipient), parked, note: u.stderr.find((l) => l.includes('rerouted to')) ?? null };
    ctx.recorder.event('mr7-self-target', facts);
    if (facts.recipients.join(',') === 'GUARDIAN' && parked === 0) return { ok: true };
    return fail('dormant reroute sent the sender its own mail', JSON.stringify(facts));
  },
};

/** The real ✋ producer (needs-human-push) with an in-universe mail sink. */
/** The cheap-model classifier with the provider faked: the reply text is what the model would answer. */
/** Jev (the decision model) faked: the probabilities it would return for the ✋ line (a word → 0.9 · the rest unclear). */
const fakeJev = (answer: Record<string, number> | string | Error, timeoutMs?: number): HandRootClassifier => (text) => cheapHandClassifier(text, {
  decide: answer instanceof Error ? async () => { throw answer; } : answer === 'hang' ? () => new Promise<never>(() => {})
    : async () => ({ model: 'jev-fake', answers: { owner: { type: 'choice' as const, probabilities: typeof answer === 'string' ? { [answer]: 0.9, unclear: 0.1 } : answer } } }),
  ...(timeoutMs === undefined ? {} : { timeoutMs }),
});

function handRig(seat: string, coordinator: string | null, classifyHand?: HandRootClassifier) {
  const posted: MessageEnvelope[] = [];
  const push = createNeedsHumanPush({
    seat: () => seat, paneId: () => 'sim-pane', coordinatorOf: () => coordinator,
    ...(classifyHand ? { classifyHand } : {}),
    postMail: (envelope) => { posted.push(envelope); return 7000 + posted.length; },
    raiseDecision: () => {}, resumeWith: () => {}, setTimer: () => null, clearTimer: () => {},
  });
  return { posted, push };
}

/** MR8 · hand-block routing — a WIP/owner block from an HQ seat goes to TC with the WIP takeover rule, not to OP. */
const mr8: SimWorldScenario = {
  id: 'MR8',
  title: 'WIP/owner hand block routes to TC with the OPS-RULES WIP takeover line',
  async run(ctx) {
    const r = handRig('MK', null);
    r.push.blocked('OWNER_UNKNOWN', 'uncommitted UX files in src/site/hero.tsx block my edit');
    const m = r.posted[0];
    const facts = { to: m?.to ?? null, rule: m?.body.includes('미커밋 WIP 인수 규칙') ?? false, refs: m?.refs ?? [] };
    ctx.recorder.event('mr8-wip', facts);
    if (facts.to === 'TC' && facts.rule && facts.refs.includes('hand-root:wip-handoff') && facts.refs.includes('hand-routed-from:OP')) return { ok: true };
    return fail('WIP hand block did not reach TC with the takeover rule', JSON.stringify(facts));
  },
};

/** MR9 · a JUD PARTIAL verdict hand posted through `msg post` reaches the judge butler, not the hand's coordinator. */
const mr9: SimWorldScenario = {
  id: 'MR9',
  title: 'JUD verdict hand (unstructured line) posted via msg post routes to JUDGE-BUTLER on the cheap-model root',
  async run(ctx) {
    const u = cliUniverse(ctx, undefined, fakeJev('jud'));
    await u.post(['msg', 'post', '--from', 'TC-H-1', '--to', 'TC', '--kind', 'request', '--intent', 'decision', '--ref', 'block:blk-sim-9', '--ref', 'reason:DEPENDENCY_WAIT',
      '--body', '[✋ NEED HUMAN · TC-H-1] JUD verdict PARTIAL on #40300 — fix or split?']);
    const rows = u.rows().map((r) => r.recipient);
    ctx.recorder.event('mr9-jud', { rows, exits: u.exits, err: u.stderr.slice(0, 3) });
    if (rows.length === 1 && rows[0] === 'JUDGE-BUTLER') return { ok: true };
    return fail('JUD verdict hand did not reach the judge butler', JSON.stringify({ rows, exits: u.exits, err: u.stderr.slice(0, 3) }));
  },
};

/** MR10 · an env/host/lease hand (structured cause or text) reaches GUARDIAN instead of TC. */
const mr10: SimWorldScenario = {
  id: 'MR10',
  title: 'env / host / spend-lease hand blocks route to GUARDIAN',
  async run(ctx) {
    const a = handRig('TC-H-2', 'TC');
    a.push.blocked('DEPENDENCY_WAIT', 'need a RES approval to run pregate on node-b', 'res-approval');
    const b = handRig('TC-H-3', 'TC', fakeJev('guardian'));
    b.push.blocked('DEPENDENCY_WAIT', 'node-b disk full and my spend lease expired');
    await b.push.routing();
    const facts = { cause: a.posted[0]?.to ?? null, text: b.posted[0]?.to ?? null };
    ctx.recorder.event('mr10-env', facts);
    if (facts.cause === 'GUARDIAN' && facts.text === 'GUARDIAN') return { ok: true };
    return fail('env hand block did not reach GUARDIAN', JSON.stringify(facts));
  },
};

/** MR11 · only design decisions reach OP; an unclear block keeps its old first rung. */
const mr11: SimWorldScenario = {
  id: 'MR11',
  title: 'design-decision hands still reach OP; unclear blocks keep the old rung',
  async run(ctx) {
    const design = handRig('UX', null);
    design.push.blocked('HUMAN_DECISION', 'two layouts for the member home — which one?');
    const unclear = handRig('TC-H-4', 'TC');
    unclear.push.blocked('DEPENDENCY_WAIT', 'waiting for #40310 (ELS-SHELL-TABS) to merge — cannot proceed');
    const facts = { design: design.posted[0]?.to ?? null, unclear: unclear.posted[0]?.to ?? null, unclearRefs: unclear.posted[0]?.refs ?? [] };
    ctx.recorder.event('mr11-design', facts);
    if (facts.design === 'OP' && facts.unclear === 'TC' && !facts.unclearRefs.some((r) => r.startsWith('hand-root:'))) return { ok: true };
    return fail('design/unclear hand routing changed', JSON.stringify(facts));
  },
};

/** MR12 · standing rule 11-20 — an unstructured block line is routed by the cheap model, never by keywords; model down,
 *  hung or unclear → the old rung (OP), and the hand is never held back. */
const mr12: SimWorldScenario = {
  id: 'MR12',
  title: 'unstructured hand line: model root routes it; model down / hung / unclear keeps the old rung and never blocks',
  async run(ctx) {
    const line = 'cannot continue: the box I build on keeps dying and the run budget ran out';
    const routed = handRig('UX', null, fakeJev('guardian'));
    routed.push.blocked('DEPENDENCY_WAIT', line);
    await routed.push.routing();
    const down = handRig('UX', null, fakeJev(new Error('Jev HTTP 503')));
    down.push.blocked('DEPENDENCY_WAIT', line);
    await down.push.routing();
    const hung = handRig('UX', null, fakeJev('hang', 30));
    hung.push.blocked('DEPENDENCY_WAIT', line);
    await hung.push.routing();
    const unclear = handRig('UX', null, fakeJev('unclear'));
    unclear.push.blocked('DEPENDENCY_WAIT', line);
    await unclear.push.routing();
    const facts = { routed: routed.posted[0]?.to ?? null, down: down.posted[0]?.to ?? null, hung: hung.posted[0]?.to ?? null, unclear: unclear.posted[0]?.to ?? null,
      routedRefs: routed.posted[0]?.refs ?? [] };
    ctx.recorder.event('mr12-unstructured', facts);
    if (facts.routed === 'GUARDIAN' && facts.routedRefs.includes('hand-root:env') && facts.down === 'OP' && facts.hung === 'OP' && facts.unclear === 'OP') return { ok: true };
    return fail('unstructured hand line was not routed by the model root or blocked on a dead model', JSON.stringify(facts));
  },
};

// ── HAND-RAISE-DOMAIN-ROUTING · DORMANT-SEAT-ROUTE (0.3.38 P0) ─────────────────────────────────────────────────────

/** The four reworded ✋ TC-H-POOL-1 sent TC on 11-27 08:17–08:31 (#194873 · #194909 · #194947 · #194992), one TUI turn each. */
const POOL1_ECHO = [
  'RES가 기존 발사 기록과 종료 영수의 존재 및 경로를 확인해야 하며 종료 추정과 중복 발사는 금지됨.',
  'RES 기록 회신 부재로 #194732 대기 취소; 실행 종료를 추정할 수 없음.',
  '기존 node-c 실행의 종료 기록과 새 HEAD 영수가 미확인이다. RES 기록 및 JUD 독립 판정이 필요하며 중복 pregate는 금지됐다.',
  '발사 주체의 실행 ID 및 종료 영수 미확인; OP가 RES에 기록 조회를 연결했고 중복 실행은 금지됨.',
];
const POOL1_CELL = 'TSC-AFFECTED-ROOTS-1';

/** One TUI process of TC-H-POOL-1 (a new turn = a new push, as live: the in-process fingerprint never sees the others). */
function poolHand(store: MsgStore, opts: { classifyHand?: HandRootClassifier; legacyWire?: boolean; resumed: string[] }) {
  return createNeedsHumanPush({
    seat: () => 'TC-H-POOL-1', paneId: () => 'sim-pane', coordinatorOf: () => 'TC',
    ...(opts.classifyHand ? { classifyHand: opts.classifyHand } : {}),
    ...(opts.legacyWire ? {} : { cellOf: () => POOL1_CELL, answerOf: (id: number, seat: string) => handAskAnswer(store, id, seat)?.body ?? null }),
    // legacyWire = the producer before this change: no ask identity on the row (the post layer cannot fold it).
    postMail: (e) => store.post(opts.legacyWire ? { ...e, refs: (e.refs ?? []).filter((r) => !r.startsWith('hand-ask:')) } : e, { dedupe: true }).id,
    raiseDecision: () => {}, resumeWith: (t) => { opts.resumed.push(t); }, setTimer: () => null, clearTimer: () => {},
  });
}

/** MR13 · the POOL-1↔TC echo (11-27: 56 mails) — the same «RES run record» ✋ reworded every turn. Before: every turn is a
 *  new ✋ at TC (TC can only forward it to a dormant RES). After: ONE ✋ to GUARDIAN (the owner of host/lease/run records),
 *  the re-asks fold into it by reference, and GUARDIAN's one answer resumes the next re-ask at once — one hop, TC 0. */
const mr13: SimWorldScenario = {
  id: 'MR13',
  title: 'POOL-1↔TC echo: four reworded ✋ about a dormant RES record close in one hop at GUARDIAN; TC gets none',
  async run(ctx) {
    const guardianModel = fakeJev('guardian');
    // before — the old wire (no ask identity) and the old first rung: the echo reproduced
    const before = new MsgStore(join(ctx.universeRoot, 'before.db'));
    let beforeToTc = 0;
    try {
      for (const line of POOL1_ECHO) { const p = poolHand(before, { legacyWire: true, resumed: [] }); p.blocked('DEPENDENCY_WAIT', line); await p.routing(); }
      beforeToTc = (before.db.query("SELECT COUNT(*) AS n FROM msg_messages WHERE sender = 'TC-H-POOL-1' AND recipient = 'TC'").get() as { n: number }).n;
    } finally { before.close(); }
    // after — the same four turns on this change
    const store = new MsgStore(join(ctx.universeRoot, 'messages.db'));
    try {
      const resumed: string[] = [];
      for (const line of POOL1_ECHO.slice(0, 3)) { const p = poolHand(store, { classifyHand: guardianModel, resumed }); p.blocked('DEPENDENCY_WAIT', line); await p.routing(); }
      const hands = store.db.query("SELECT id, recipient, refs_json, repeat_count FROM msg_messages WHERE sender = 'TC-H-POOL-1'").all() as Array<{ id: number; recipient: string; refs_json: string; repeat_count: number | null }>;
      const first = hands[0];
      // GUARDIAN answers the one ✋ once (its mail reply) — the 4th reworded turn is answered by reference, nothing is sent.
      if (first) store.post({ from: 'GUARDIAN', to: 'TC-H-POOL-1', replyTo: first.id, kind: 'reply', body: 'node-c run 77 exited 0 · receipt runs/77/exit.json · no relaunch' });
      const last = poolHand(store, { classifyHand: guardianModel, resumed });
      last.blocked('DEPENDENCY_WAIT', POOL1_ECHO[3]!);
      await last.routing();
      const after = store.db.query("SELECT COUNT(*) AS n FROM msg_messages WHERE sender = 'TC-H-POOL-1'").get() as { n: number };
      const toTc = (store.db.query("SELECT COUNT(*) AS n FROM msg_messages WHERE recipient = 'TC'").get() as { n: number }).n;
      const facts = { beforeToTc, handRows: after.n, toTc, firstTo: first?.recipient ?? null, firstRefs: first ? JSON.parse(first.refs_json) as string[] : [],
        repeatCount: (store.db.query('SELECT repeat_count AS r FROM msg_messages WHERE id = ?').get(first?.id ?? 0) as { r: number | null } | null)?.r ?? null, resumed };
      ctx.recorder.event('mr13-pool1-echo', facts);
      if (beforeToTc === 4 && facts.handRows === 1 && toTc === 0 && facts.firstTo === 'GUARDIAN'
        && facts.firstRefs.includes(`hand-ask:env:${POOL1_CELL}`) && facts.firstRefs.includes('hand-routed-from:TC') && facts.repeatCount === 4
        && resumed.length === 1 && resumed[0] === `[✋ answered by reference #${first!.id}] node-c run 77 exited 0 · receipt runs/77/exit.json · no relaunch`) return { ok: true };
      return fail('POOL-1↔TC echo did not close in one hop', JSON.stringify(facts));
    } finally { store.close(); }
  },
};

/** MR14 · DORMANT-SEAT-ROUTE — mail to a dormant RES goes to GUARDIAN; GUARDIAN silent 10 min → ONE OP card; an answered
 *  reroute and a young one get none; a second tick adds nothing. */
const mr14: SimWorldScenario = {
  id: 'MR14',
  title: 'dormant RES → GUARDIAN; unanswered for 10 min → one OP card (answered/young → none · idempotent)',
  async run(ctx) {
    const u = cliUniverse(ctx, deadRes);
    await u.post(['msg', 'post', '--from', 'TC-H-POOL-2', '--to', 'RES', '--kind', 'request', '--body', 'lease node-b for pregate #40502?']);
    await u.post(['msg', 'post', '--from', 'TC-H-CX-1', '--to', 'RES', '--kind', 'request', '--body', 'free slot for isolation path?']);
    await u.post(['msg', 'post', '--from', 'TC-H-CX-2', '--to', 'RES', '--kind', 'request', '--body', 'disk on minim5?']);
    const store = new MsgStore(u.msgPath);
    try {
      const rows = store.db.query("SELECT id, sender, recipient FROM msg_messages WHERE refs_json LIKE '%rerouted-from:RES%' ORDER BY id").all() as Array<{ id: number; sender: string; recipient: string }>;
      const [lease, slot, disk] = rows;
      if (!lease || !slot || !disk) return fail('dormant RES mail was not rerouted', JSON.stringify(rows));
      store.post({ from: 'GUARDIAN', to: 'TC-H-CX-1', replyTo: slot.id, kind: 'reply', body: 'slot 2 is yours until 13:00' });
      const back = (id: number, min: number): void => { store.db.query('UPDATE msg_messages SET created_at = ? WHERE id = ?').run(new Date(Date.now() - min * 60_000).toISOString(), id); };
      back(lease.id, 11); back(slot.id, 11); back(disk.id, 4);
      const tick1 = sweepDormantUnanswered(store);
      const tick2 = sweepDormantUnanswered(store);
      const card = tick1.cardId === null ? null : store.getMessage(tick1.cardId);
      const facts = { recipients: rows.map((r) => r.recipient), overdue: tick1.overdue.map((o) => o.id), cardTo: card?.to ?? null, cardRefs: card?.refs ?? [],
        priority: card?.priority ?? null, tick2: tick2.cardId, cardsToOp: (store.db.query("SELECT COUNT(*) AS n FROM msg_messages WHERE recipient = 'OP'").get() as { n: number }).n };
      ctx.recorder.event('mr14-dormant-card', facts);
      if (facts.recipients.every((r) => r === 'GUARDIAN') && facts.overdue.join(',') === String(lease.id) && facts.cardTo === 'OP'
        && facts.cardRefs.includes(`dormant-unanswered:${lease.id}`) && facts.priority === 1 && facts.tick2 === null && facts.cardsToOp === 1) return { ok: true };
      return fail('dormant reroute did not end in one OP card after 10 min', JSON.stringify(facts));
    } finally { store.close(); }
  },
};

/** MR15 · HOLD → JUDGE-BUTLER · cell scope → the cell owner · design → TC (fallback), all through the real `msg post`. */
const mr15: SimWorldScenario = {
  id: 'MR15',
  title: 'HOLD hand → JUDGE-BUTLER · cell-scope hand → the cell owner · design hand stays at TC (fallback)',
  async run(ctx) {
    const cells = handCellLookupsFrom(() => [
      { id: 'ELS-SHELL-TABS', status: 'yellow', owner: 'UX' },
      { id: 'LAND-QUEUE-1', status: 'yellow', owner: 'TC-H-CX-7' },
    ]);
    const u = cliUniverse(ctx, undefined, null, cells);
    const hand = (block: string, reason: string, extra: string[], body: string) => u.post(['msg', 'post', '--from', 'TC-H-CX-7', '--to', 'TC', '--kind', 'request', '--intent', 'decision',
      '--ref', `block:${block}`, '--ref', `reason:${reason}`, ...extra.flatMap((r) => ['--ref', r]), '--body', `[✋ NEED HUMAN · TC-H-CX-7] ${body}`]);
    await hand('blk-h', 'DEPENDENCY_WAIT', ['cause:hold'], 'is the TC HOLD from 00:44 still on LAND-QUEUE-1?');
    await hand('blk-c', 'DEPENDENCY_WAIT', ['cause:cell-scope', 'cell:ELS-SHELL-TABS'], 'is the tab strip in ELS-SHELL-TABS scope?');
    await hand('blk-d', 'HUMAN_DECISION', [], 'two queue designs — which one?');
    await hand('blk-o', 'DEPENDENCY_WAIT', ['cause:cell-scope'], 'scope of my own cell?'); // own cell (claimed LAND-QUEUE-1) → TC
    await hand('blk-e', 'DEPENDENCY_WAIT', ['cause:slot-isolation', 'cell:ENV-TEST'], 'isolated host unavailable');
    await hand('blk-u', 'DEPENDENCY_WAIT', ['cause:cell-scope', 'cell:UNKNOWN-CELL'], 'who owns this unknown cell?');
    const recipients = u.rows().map((r) => r.recipient);
    ctx.recorder.event('mr15-domains', { recipients, err: u.stderr.slice(0, 4) });
    if (recipients.join(',') === 'JUDGE-BUTLER,UX,TC,TC,GUARDIAN,TC') return { ok: true };
    return fail('domain routing did not reach the owner with decision rights', JSON.stringify({ recipients, err: u.stderr.slice(0, 4) }));
  },
};

interface Hand2130 { readonly id: number; readonly seat: string; readonly reason: string; readonly cause?: string; readonly cell: string | null; readonly jev: { readonly probabilities: Record<string, number> }; readonly detail: string }
const HANDS_2130 = (JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'hands-2130.json'), 'utf8')) as { hands: Hand2130[] }).hands;

/** Replay the 13 real ✋ of the 21:30 window (fixtures/hands-2130.json), one TUI turn each, through the real producer and
 *  the real MsgStore. `model` = the recorded live Jev probabilities, or 'down' (no answer — the live state on #40535). */
async function replay2130(ctx: SimWorldScenarioContext, name: string, model: 'recorded' | 'down') {
  const store = new MsgStore(join(ctx.universeRoot, `${name}.db`));
  try {
    for (const h of HANDS_2130) {
      const push = createNeedsHumanPush({
        seat: () => h.seat, paneId: () => 'sim-pane', coordinatorOf: () => 'TC', cellOf: () => h.cell,
        classifyHand: model === 'down' ? fakeJev(new Error('jev-no-key')) : fakeJev(h.jev.probabilities),
        postMail: (e) => store.post(e, { dedupe: true }).id,
        raiseDecision: () => {}, resumeWith: () => {}, setTimer: () => null, clearTimer: () => {},
      });
      push.blocked(h.reason as never, h.detail, h.cause as never);
      await push.routing();
    }
    const rows = store.db.query('SELECT recipient, repeat_count, refs_json FROM msg_messages ORDER BY id').all() as Array<{ recipient: string; repeat_count: number | null; refs_json: string | null }>;
    const to: Record<string, number> = {};
    for (const r of rows) to[r.recipient] = (to[r.recipient] ?? 0) + 1;
    // plan-limit ✋ the 행정관 resumes on its own (ask root auto-continue) — at TC by address, not TC's decision.
    const autoContinue = rows.filter((r) => (r.refs_json ?? '').includes('"hand-ask:auto-continue:')).length;
    return { rows: rows.length, folded: rows.reduce((n, r) => n + Math.max(0, (r.repeat_count ?? 1) - 1), 0), to, autoContinue };
  } finally { store.close(); }
}

/** MR16 · the 21:30 window after #40535 went live (classifier = Jev since 대표 22:1x) — ✋ to TC 10–14 per 30 min, JUDGE-BUTLER 0, GUARDIAN 0, folds 0: the
 *  classifier was stopped by the spend guard (every unstructured ✋ «ambiguous» → TC), APPROVAL_PENDING was not in the table
 *  and HUMAN_DECISION («plan-limit», an approval-policy ask) was pinned to design. Real texts, real reason/cause codes. */
const mr16: SimWorldScenario = {
  id: 'MR16',
  title: '2130 window replay (13 real ✋): Jev down → TC 11 · GUARDIAN 1 (+1 folded) · recorded live Jev answers → TC 6 (2 plan-limit resumed by the 행정관) · JUDGE-BUTLER 3 · GUARDIAN 2 (+2 folded by reference)',
  async run(ctx) {
    const down = await replay2130(ctx, 'down', 'down');
    const after = await replay2130(ctx, 'after', 'recorded');
    const facts = { down, after };
    ctx.recorder.event('mr16-2130-replay', facts);
    if (down.rows === 12 && down.folded === 1 && down.to.TC === 11 && down.to.GUARDIAN === 1
      && after.rows === 11 && after.folded === 2 && after.to.TC === 6 && after.autoContinue === 2 && after.to['JUDGE-BUTLER'] === 3 && after.to.GUARDIAN === 2) return { ok: true };
    return fail('2130 replay did not reach the owners with decision rights', JSON.stringify(facts));
  },
};

export const mailRouteScenarios: readonly SimWorldScenario[] = [mr1, mr2, mr3, mr4, mr5, mr6, mr7, mr8, mr9, mr10, mr11, mr12, mr13, mr14, mr15, mr16];
