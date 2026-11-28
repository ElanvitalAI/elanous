// KIT mail-route — expectations are literals written here, never built from the product's own constants or renderers.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInterjectionMessage } from '../../chat/interjection.js';
import { seatMailBundleText } from '../../tui/seat-mail-digest.js';
import { coachNoteLine } from '../../msg/diverted-mail.js';
import { createBusWakeGate } from '../../op-context-bus/seat-turn.js';
import { dormantReroute } from '../../msg/dormant-reroute.js';
import { MsgStore } from '../../msg/msg-store.js';
import {
  callerSeat, cheapHandClassifier, classifyHandBlock, createMailFoldLedger, digestLine, foldMailDigests, mailBypassesWindow, mailDigestBlock, mailRoutePolicyFrom,
  msgPostArgsAsCaller, pickHandRoot, readMailRoutePolicy, resolveHandRoot, routeDormant, routeHandBlock, routeHandMail, windowDue,
  BUILTIN_HAND_ROUTES_FILE, EMPTY_HAND_ROUTES, handAskCell, handAskRef, handAskReference, handJevQuestion, handRoutesFrom, readHandRoutes, sweepDormantUnanswered,
} from './index.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'kit-mail-route-')); dirs.push(d); return d; };

test('policy: 30-min default · file minutes override · invalid field keeps the default', () => {
  expect(mailRoutePolicyFrom(undefined)).toEqual({ windowMs: 1_800_000, foldedWindowMs: 600_000 });
  expect(mailRoutePolicyFrom({ windowMinutes: 15, foldedWindowMinutes: 'x' })).toEqual({ windowMs: 900_000, foldedWindowMs: 600_000 });
  const dir = tmp();
  const file = join(dir, 'mail-route-policy.json');
  expect(readMailRoutePolicy(file)).toEqual({ windowMs: 1_800_000, foldedWindowMs: 600_000 });
  writeFileSync(file, JSON.stringify({ windowMinutes: 5 }));
  expect(readMailRoutePolicy(file).windowMs).toBe(300_000);
});

test('P0 bypasses the window: crown · priority · 🚨 · prio:P0 ref; plain mail waits', () => {
  expect(mailBypassesWindow({ crownDirective: 'D-1127-01' })).toBe(true);
  expect(mailBypassesWindow({ priority: 1 })).toBe(true);
  expect(mailBypassesWindow({ body: '[rerouted from REL · no live tab] 🚨 release blocked' })).toBe(true);
  expect(mailBypassesWindow({ refs: ['prio:P0'] })).toBe(true);
  expect(mailBypassesWindow({ body: 'status ok', refs: ['cell:A1'] })).toBe(false);
  expect(windowDue(null, 5, 10)).toBe(true);
  expect(windowDue(0, 9, 10)).toBe(false);
  expect(windowDue(0, 10, 10)).toBe(true);
});

test('bus wake gate: P0 item wakes at once inside the window; a normal one defers to the window end', () => {
  const gate = createBusWakeGate('TC', 1_800_000);
  const item = (id: string, refs: string[]) => ({ id, type: 'handoff', from: 'OP', owner: 'TC', body: 'b', refs, at: '2026-11-27T00:00:00Z', alsoFrom: [] }) as never;
  expect(gate.offer([item('b1', [])], 0)).toEqual({ action: 'wake', reason: 'normal' });
  expect(gate.offer([item('b2', [])], 60_000)).toEqual({ action: 'defer', dueAt: 1_800_000 });
  expect(gate.offer([item('b3', ['prio:P0'])], 120_000)).toEqual({ action: 'wake', reason: 'urgent' });
});

test('coach note: one line per policy window', () => {
  const e = [{ seat: 'OP', from: 'OPC', kind: 'coach', body: 'look at #12', at: '2026-11-27T03:04:00.000Z' }];
  expect(coachNoteLine(e, 1_000_000, 900_000, 1_800_000)).toBeNull();
  expect(coachNoteLine(e, 2_800_000, 900_000, 1_800_000)).toBe('[coach note · 1 since 03:04Z · no reply needed] look at #12');
});

test('one digest builder: line · block · fold', () => {
  expect(digestLine({ id: 7, from: 'TC', field: 'status', body: 'a\n  b   c' }, 3)).toBe('#7 · TC · status · a b…');
  const one = mailDigestBlock(['- #1 · TC · info · x'], undefined, 'NOTE');
  const two = mailDigestBlock(['- #2 · UX · info · y'], 4, 'NOTE');
  expect(foldMailDigests(`${one}\n\n${two}`)).toBe('<mail_digest count="2" unread="4">\nNOTE\n- #1 · TC · info · x\n- #2 · UX · info · y\n</mail_digest>');
});

test('fold-once: the same mail via the TUI bundle then the repl path is listed once', () => {
  const fold = createMailFoldLedger('OP', { now: () => 1_000 });
  const notice = { text: 'full', source: 'seat-mail', msgId: 41, passive: true, digest: '#41 · LAND-GRAPH · status · landed', mail: { sender: 'LAND-GRAPH' } };
  const tui = seatMailBundleText([notice], fold);
  expect(tui).toContain('#41 · LAND-GRAPH · status · landed');
  const repl = buildInterjectionMessage([{ kind: 'seat-mail', msgId: 41, from: 'LAND-GRAPH', intent: 'info', text: 'landed', viaLedger: true }], 'mid-turn', new Set(['LAND-GRAPH']), fold) ?? '';
  expect(repl).not.toContain('#41 · LAND-GRAPH · info · landed');
  expect(repl).toContain('[mail already in an earlier digest this turn window: #41 — not repeated]');
  // and the other order: a second TUI bundle with the same id lists it once more as «already», never as a line
  expect(seatMailBundleText([notice], fold)).toBe('[mail already in an earlier digest this turn window: #41 — not repeated]');
});

test('fold-once mirror file: a second process for the same seat sees the claim', () => {
  const file = join(tmp(), 'OP.json');
  expect(createMailFoldLedger('OP', { file, now: () => 1 }).claim([5, 6])).toEqual({ fresh: [5, 6], repeat: [] });
  expect(createMailFoldLedger('OP', { file, now: () => 2 }).claim([6, 7])).toEqual({ fresh: [7], repeat: [6] });
});

test('dormant reroute respects isLive: a live RES keeps its mail; a dormant one reroutes', () => {
  expect(routeDormant({ from: 'TC', to: 'RES', body: 'host slow' }, { isLive: () => true })).toBeNull();
  expect(routeDormant({ from: 'TC', to: 'REL', body: 'cut note' }, { isLive: () => false })?.refs).toEqual(['rerouted-from:REL']);
  expect(dormantReroute({ from: 'TC', to: 'TC', body: 'self' })).toBeNull();
});

test('sender = caller: ELANOUS_TRACK · seat folder · machine fallback — never a hardcoded seat', () => {
  expect(callerSeat({ ELANOUS_TRACK: 'tc' } as NodeJS.ProcessEnv, '/x')).toBe('TC');
  expect(callerSeat({} as NodeJS.ProcessEnv, '/Users/u/elanous-hq/seats/JUD/wt')).toBe('JUD');
  expect(callerSeat({} as NodeJS.ProcessEnv, '/tmp/land')).toBeNull();
  expect(msgPostArgsAsCaller({ to: 'MK', body: 'b', fallback: 'LAND-GRAPH', env: {} as NodeJS.ProcessEnv, cwd: '/tmp/land' }))
    .toEqual(['msg', 'post', '--from', 'LAND-GRAPH', '--to', 'MK', '--kind', 'report', '--body', 'b']);
  expect(msgPostArgsAsCaller({ to: 'MK', body: 'b', fallback: 'LAND-GRAPH', env: { ELANOUS_TRACK: 'JUD' } as NodeJS.ProcessEnv, cwd: '/tmp' })[3]).toBe('JUD');
});

test('#191271 dormant reroute never targets the sender: OP → dormant RES goes to GUARDIAN; OP → dormant REL stays at REL', () => {
  const dead = () => false;
  expect(routeDormant({ from: 'OP', to: 'RES', body: 'disk?' }, { isLive: dead })).toEqual({
    to: 'GUARDIAN', refs: ['rerouted-from:RES'], body: '[rerouted from RES · no live tab] disk?', digest: false, note: 'RES has no live tab — rerouted to GUARDIAN' });
  expect(routeDormant({ from: 'OP', to: 'REL', body: 'cut?' }, { isLive: dead })).toBeNull();
  expect(routeDormant({ from: 'TC', to: 'RES', body: 'x' }, { isLive: (a) => a === 'RES-INFRA' })?.to).toBe('RES-INFRA');
  expect(routeDormant({ from: 'GUARDIAN', to: 'RES-INFRA', body: 'x' }, { isLive: dead })).toBeNull();
});

test('hand-block root: structured cause/reason codes only — no keyword rules on the text', () => {
  expect(classifyHandBlock({ cause: 'writer-handover', detail: 'who owns src/a.ts' })).toEqual({ root: 'wip-handoff', by: 'cause' });
  expect(classifyHandBlock({ cause: 'res-approval', detail: 'x' })).toEqual({ root: 'env', by: 'cause' });
  expect(classifyHandBlock({ reason: 'HUMAN_DECISION', detail: 'JUD PARTIAL' })).toEqual({ root: 'design-decision', by: 'reason' });
  expect(classifyHandBlock({ reason: 'OWNER_UNKNOWN', detail: 'x' })).toEqual({ root: 'wip-handoff', by: 'reason' });
  expect(classifyHandBlock({ reason: 'DEPENDENCY_WAIT', detail: 'JUD verdict PARTIAL on #40300 — what now' })).toEqual({ root: 'ambiguous', by: 'none' });
});

test('Jev classifier: max-probability word → root · below threshold / unclear / throw / timeout / no injected call → null (old rung)', async () => {
  const jev = (probabilities: Record<string, number>) => async () => ({ model: 'jev-test', answers: { owner: { type: 'choice' as const, probabilities } } });
  expect(pickHandRoot({ type: 'choice', probabilities: { jud: 0.81, hold: 0.1, unclear: 0.09 } })).toEqual({ root: 'jud-verdict', word: 'jud', p: 0.81 });
  expect(pickHandRoot({ type: 'choice', probabilities: { approval: 0.7, guardian: 0.2 } })).toEqual({ root: 'env', word: 'approval', p: 0.7 });
  expect(pickHandRoot({ type: 'choice', probabilities: { hold: 0.42, jud: 0.4 } })).toEqual({ root: null, word: 'hold', p: 0.42 }); // < 0.5
  expect(pickHandRoot({ type: 'choice', probabilities: { unclear: 0.9 } })).toEqual({ root: null, word: 'unclear', p: 0.9 });
  expect(pickHandRoot({ type: 'choice', probabilities: { other: 0.9 } })).toEqual({ root: null, word: 'other', p: 0.9 });
  expect(pickHandRoot(undefined)).toEqual({ root: null, word: null, p: 0 });
  expect(await cheapHandClassifier('JUD said PARTIAL on #40300', { decide: jev({ jud: 0.93, unclear: 0.07 }) })).toBe('jud-verdict');
  expect(await cheapHandClassifier('hmm', { decide: jev({ unclear: 0.8, wip: 0.2 }) })).toBeNull();
  expect(await cheapHandClassifier('x', { decide: async () => { throw new Error('Jev HTTP 402'); } })).toBeNull();
  expect(await cheapHandClassifier('x', { decide: () => new Promise<never>(() => {}), timeoutMs: 20 })).toBeNull();
  expect(await cheapHandClassifier('x')).toBeNull(); // bun test: no live Jev without an injected call
  const seen: unknown[] = [];
  await cheapHandClassifier('token=sk-abcdefghijkl leaked', { decide: async (req) => { seen.push(req); return { model: 'm', answers: {} }; } });
  expect(JSON.stringify(seen)).not.toContain('sk-abcdefghijkl'); // the line is redacted before it leaves the process
  expect(await resolveHandRoot({ reason: 'DEPENDENCY_WAIT', detail: 'disk full on node-b' }, async () => 'env')).toEqual({ root: 'env', by: 'classifier' });
  // HUMAN_DECISION is a refinable default (hand-routes.yaml refineReasons); PROVIDER_ERROR is decisive · TOOL_DENIED is no
  // code any more (HAND-ROUTE-GUARDIAN-MISROUTE · #204425 «panel access denied» is a coordinator's question) → the classifier
  expect(await resolveHandRoot({ reason: 'HUMAN_DECISION', detail: 'plan-limit' }, async () => 'env')).toEqual({ root: 'env', by: 'classifier' });
  expect(await resolveHandRoot({ reason: 'HUMAN_DECISION', detail: 'which layout' }, async () => null)).toEqual({ root: 'design-decision', by: 'reason' });
  expect(await resolveHandRoot({ reason: 'PROVIDER_ERROR', detail: 'x' }, async () => 'jud-verdict')).toEqual({ root: 'env', by: 'reason' });
  expect(await resolveHandRoot({ reason: 'TOOL_DENIED', detail: 'panel access denied' }, async () => 'design-decision')).toEqual({ root: 'design-decision', by: 'classifier' });
  expect(await resolveHandRoot({ reason: 'TOOL_DENIED', detail: 'x' }, async () => null)).toEqual({ root: 'ambiguous', by: 'none' });
  expect(classifyHandBlock({ reason: 'APPROVAL_PENDING', detail: 'x' })).toEqual({ root: 'env', by: 'reason' });
});

test('hand-block route: only OP/TC are relieved; design and unclear keep the old rung; WIP to TC carries the takeover rule', async () => {
  expect(routeHandBlock({ seat: 'UX', defaultTo: 'OP', reason: 'DEPENDENCY_WAIT', detail: 'x' }, { root: 'jud-verdict', by: 'classifier' })).toEqual({ to: 'JUDGE-BUTLER', root: 'jud-verdict', by: 'classifier', rerouted: true });
  expect(routeHandBlock({ seat: 'UX', defaultTo: 'OP', reason: 'DEPENDENCY_WAIT', detail: 'JUD verdict PARTIAL' }).to).toBe('OP');
  expect(routeHandBlock({ seat: 'UX', defaultTo: 'OP', reason: 'HUMAN_DECISION', detail: 'which layout' }).to).toBe('OP');
  expect(routeHandBlock({ seat: 'JUD-B', defaultTo: 'JUD', reason: 'TOOL_DENIED', detail: 'host down' }).to).toBe('JUD');
  const wip = routeHandBlock({ seat: 'MK', defaultTo: 'OP', reason: 'OWNER_UNKNOWN', detail: 'uncommitted files of UX in my path' });
  expect(wip.to).toBe('TC');
  expect(wip.attach).toContain('30분 무응답이면 보존 사본');
  const hand = { from: 'TC-H-1', to: 'TC', body: 'node-b disk full', refs: ['block:b1', 'reason:DEPENDENCY_WAIT'] };
  expect((await routeHandMail(hand, async () => 'env'))?.to).toBe('GUARDIAN');
  // unclear / no classifier: the address stays (TC = the fallback) and the ✋ still gets its ask identity
  expect(await routeHandMail(hand, async () => null)).toMatchObject({ to: 'TC', rerouted: false, refs: ['block:b1', 'reason:DEPENDENCY_WAIT', 'hand-ask:ambiguous:*'] });
  expect(await routeHandMail(hand, null)).toMatchObject({ to: 'TC', rerouted: false });
  expect(await routeHandMail({ ...hand, replyTo: 9 }, async () => 'env')).toBeNull();
  expect(await routeHandMail({ ...hand, refs: ['seat:TC-H-1'] }, async () => 'env')).toBeNull();
  expect(await routeHandMail({ ...hand, refs: ['block:b1', 'reason:PROVIDER_ERROR'] }, null)).toMatchObject({ to: 'GUARDIAN', root: 'env', rerouted: true });
  expect(await routeHandMail({ ...hand, refs: ['block:b1', 'reason:TOOL_DENIED'] }, null)).toMatchObject({ to: 'TC', root: 'ambiguous', rerouted: false });
  expect(await routeHandMail({ ...hand, refs: ['block:b1', 'reason:DEPENDENCY_WAIT', 'hand-ask:env:*'] }, async () => 'env')).toBeNull(); // already routed
});

// ── HAND-RAISE-DOMAIN-ROUTING · DORMANT-SEAT-ROUTE (0.3.38) ─────────────────────────────────────────────────────────

test('routing table: the built-in hand-routes.yaml reads with no problems and names each owner', () => {
  const t = readHandRoutes([BUILTIN_HAND_ROUTES_FILE]);
  expect(t.problems).toEqual([]);
  expect([...t.relievedRungs].sort()).toEqual(['OP', 'TC']);
  expect(t.roots.hold).toEqual({ owner: { kind: 'address', address: 'JUDGE-BUTLER' } });
  expect(t.roots.env).toEqual({ owner: { kind: 'address', address: 'GUARDIAN' } });
  expect(t.roots['cell-scope']).toEqual({ owner: { kind: 'cell-owner', otherwise: { kind: 'keep' } } });
  expect(t.roots['design-decision']).toEqual({ owner: { kind: 'keep' } });
  expect(t.causes.hold).toBe('hold');
  expect(t.dedupeWindowMs).toBe(1_800_000);
  expect(t.dormant.routes.RES).toBe('GUARDIAN');
  expect(t.dormant.unansweredMs).toBe(600_000);
  expect(t.dormant.cardTo).toBe('OP');
});

test('routing table: an override replaces a section · a broken file or wrong version is an empty table (never blocks)', () => {
  const d = tmp();
  const over = join(d, 'hand-routes.yaml');
  writeFileSync(over, 'roots:\n  env: { owner: RES-INFRA }\n');
  const t = readHandRoutes([BUILTIN_HAND_ROUTES_FILE, over]);
  expect(t.roots.env).toEqual({ owner: { kind: 'address', address: 'RES-INFRA' } });
  expect(t.roots.hold).toBeUndefined(); // the override's `roots` replaced the whole section
  expect(t.causes.hold).toBe('hold');
  const broken = join(d, 'broken.yaml');
  writeFileSync(broken, 'version: 1\nroots: [unclosed\n');
  const b = readHandRoutes([broken]);
  expect(b.problems.length).toBeGreaterThan(0);
  expect(handRoutesFrom({ version: 2, roots: { env: { owner: 'GUARDIAN' } } }).roots).toEqual({});
  expect(handRoutesFrom({ version: 1, roots: { env: { owner: 'not an address!' }, nope: { owner: 'OP' } } }).problems).toEqual(['roots.env: owner not an address! is not an address', 'roots.nope: unknown root']);
  // empty table: the ✋ keeps its rung
  expect(routeHandBlock({ seat: 'TC-H-1', defaultTo: 'TC', reason: 'TOOL_DENIED', detail: 'x' }, undefined, { table: EMPTY_HAND_ROUTES })).toMatchObject({ to: 'TC', rerouted: false });
});

test('HOLD → JUDGE-BUTLER · cell scope → the cell owner (asking seat owns it → TC fallback) · design keeps TC', () => {
  const owners: Record<string, string> = { 'CELL-A': 'UX', 'CELL-B': 'TC-H-POOL-1/note' };
  const cellOwnerOf = (c: string): string | null => owners[c] ?? null;
  expect(routeHandBlock({ seat: 'TC-H-POOL-1', defaultTo: 'TC', cause: 'hold', detail: 'is the TC HOLD on my cell still on?' })).toMatchObject({ to: 'JUDGE-BUTLER', root: 'hold', by: 'cause', rerouted: true });
  expect(routeHandBlock({ seat: 'TC-H-POOL-1', defaultTo: 'TC', cause: 'cell-scope', detail: 'is the PWA path in scope?', cell: 'CELL-A' }, undefined, { cellOwnerOf }))
    .toMatchObject({ to: 'UX', root: 'cell-scope', rerouted: true });
  expect(routeHandBlock({ seat: 'TC-H-POOL-1', defaultTo: 'TC', cause: 'cell-scope', detail: 'scope?', cell: 'CELL-B' }, undefined, { cellOwnerOf }))
    .toMatchObject({ to: 'TC', rerouted: false });
  expect(routeHandBlock({ seat: 'TC-H-POOL-1', defaultTo: 'TC', cause: 'cell-scope', detail: 'scope?', cell: 'CELL-X' }, undefined, { cellOwnerOf }).to).toBe('TC');
  expect(routeHandBlock({ seat: 'TC-H-POOL-1', defaultTo: 'TC', reason: 'HUMAN_DECISION', detail: 'which design' }).to).toBe('TC');
  expect(handAskRef('env', 'cell-a')).toBe('hand-ask:env:CELL-A');
  expect(handAskRef('hold', null)).toBe('hand-ask:hold:*');
});

test('classifier words come from the table: the Jev choice criteria are the YAML words ⊕ unclear', () => {
  const q = handJevQuestion();
  expect(q.type).toBe('choice');
  expect(Object.keys((q as { criteria: Record<string, string> }).criteria)).toEqual(['wip', 'jud', 'hold', 'guardian', 'autocontinue', 'approval', 'runstate', 'policy', 'cell', 'decision', 'unclear']);
  expect((q as { criteria: Record<string, string> }).criteria.hold).toContain('a HOLD / freeze');
  expect(readHandRoutes([BUILTIN_HAND_ROUTES_FILE]).classifierMinProbability).toBe(0.5);
});

test('same ✋ ask inside 30 min: no new row, the first row answers by reference (any recipient)', () => {
  const store = new MsgStore(join(tmp(), 'messages.db'));
  try {
    const ask = { from: 'TC-H-POOL-1', kind: 'request', intent: 'decision' as const };
    const first = store.post({ ...ask, to: 'GUARDIAN', body: '[✋] RES run record for node-c?', refs: ['block:b1', 'reason:DEPENDENCY_WAIT', 'hand-ask:env:CELL-A'] }, { dedupe: true });
    const again = store.post({ ...ask, to: 'TC', body: '[✋] still no RES record — need the exit receipt', refs: ['block:b2', 'reason:DEPENDENCY_WAIT', 'hand-ask:env:CELL-A'] }, { dedupe: true });
    expect(again.id).toBe(first.id);
    expect(again.handAskRepeat).toBe(true);
    expect(again.repeatReason).toContain('answered by reference');
    expect(handAskReference(store, again).line).toBe(`✋ by reference: same ask as #${first.id} is still open at GUARDIAN — its answer resumes you; nothing new was sent`);
    const other = store.post({ ...ask, to: 'TC', body: '[✋] other cell', refs: ['block:b3', 'reason:DEPENDENCY_WAIT', 'hand-ask:env:CELL-B'] }, { dedupe: true });
    expect(other.id).not.toBe(first.id);
    const answer = store.post({ from: 'GUARDIAN', to: 'TC-H-POOL-1', replyTo: first.id, body: 'node-c run 77 exited 0 · receipt at runs/77' });
    const third = store.post({ ...ask, to: 'TC', body: '[✋] RES record?', refs: ['block:b4', 'reason:DEPENDENCY_WAIT', 'hand-ask:env:CELL-A'] }, { dedupe: true });
    expect(third.id).toBe(first.id);
    expect(handAskReference(store, third).line).toBe(`✋ answered by reference: same ask as #${first.id} — GUARDIAN answered #${answer.id}: node-c run 77 exited 0 · receipt at runs/77`);
    // a programmatic append (no dedupe) is never folded
    expect(store.post({ ...ask, to: 'TC', body: 'x', refs: ['block:b5', 'reason:DEPENDENCY_WAIT', 'hand-ask:env:CELL-A'] }).id).not.toBe(first.id);
  } finally { store.close(); }
});

test('dormant watch: rerouted mail unanswered for 10 min → ONE OP card; answered or young → none; idempotent', () => {
  const store = new MsgStore(join(tmp(), 'messages.db'));
  try {
    const old = store.post({ from: 'TC-H-POOL-2', to: 'GUARDIAN', kind: 'request', body: '[rerouted from RES · no live tab] lease for node-b?', refs: ['rerouted-from:RES'] });
    const answered = store.post({ from: 'TC-H-CX-1', to: 'GUARDIAN', kind: 'request', body: '[rerouted from RES · no live tab] slot?', refs: ['rerouted-from:RES'] });
    store.post({ from: 'GUARDIAN', to: 'TC-H-CX-1', replyTo: answered.id, body: 'slot 2 is yours' });
    const young = store.post({ from: 'TC-H-CX-2', to: 'GUARDIAN', kind: 'request', body: '[rerouted from RES · no live tab] disk?', refs: ['rerouted-from:RES'] });
    const back = (id: number, min: number): void => { store.db.query('UPDATE msg_messages SET created_at = ? WHERE id = ?').run(new Date(Date.now() - min * 60_000).toISOString(), id); };
    back(old.id, 12); back(answered.id, 12); back(young.id, 3);
    const shadow = sweepDormantUnanswered(store, { live: false });
    expect(shadow.overdue.map((o) => o.id)).toEqual([old.id]);
    expect(shadow.cardId).toBeNull();
    const r = sweepDormantUnanswered(store);
    expect(r.overdue.map((o) => o.id)).toEqual([old.id]);
    const card = store.getMessage(r.cardId!)!;
    expect(card.to).toBe('OP');
    expect(card.from).toBe('GUARDIAN');
    expect(card.priority).toBe(1);
    expect(card.refs).toEqual(['dormant-card', `dormant-unanswered:${old.id}`]);
    expect(card.body).toContain(`#${old.id} TC-H-POOL-2→RES→GUARDIAN 12m «lease for node-b?»`);
    expect(sweepDormantUnanswered(store).cardId).toBeNull(); // carded once
  } finally { store.close(); }
});

test('ask identity cell: explicit cell · named cells (not mail ids · not the seat · real cells only) · claimed · *', () => {
  expect(handAskCell({ seat: 'TC-H-1', cell: 'CELL-Z', claimed: 'CELL-A', detail: 'ELS-B2 gone' })).toBe('CELL-Z');
  expect(handAskCell({ seat: 'TC-H-1', claimed: 'CELL-A', detail: 'the demo branch for ELS-B2 is gone' })).toBe('ELS-B2');
  expect(handAskCell({ seat: 'TC-H-1', claimed: 'CELL-A', detail: 'RES record missing; waited #194732 · TC-H-1 blocked' })).toBe('CELL-A');
  expect(handAskCell({ seat: 'TC-H-1', claimed: null, detail: 'JUD-C verdict and ELS-B2', isCell: (id) => id === 'ELS-B2' })).toBe('ELS-B2');
  expect(handAskCell({ seat: 'TC-H-1', detail: 'nothing named' })).toBeNull();
});

test('plan-limit is structured: cause plan-limit → auto-continue root (no classifier) · stays at the leader for the 행정관', async () => {
  const input = { seat: 'TC-H-CX-7', defaultTo: 'TC', reason: 'HUMAN_DECISION', cause: 'plan-limit', detail: 'plan-limit · auto-continue cap 10/10' };
  expect(classifyHandBlock(input)).toEqual({ root: 'auto-continue', by: 'cause' });
  expect(await resolveHandRoot(input, async () => 'env')).toEqual({ root: 'auto-continue', by: 'cause' }); // Jev never asked
  expect(routeHandBlock(input)).toMatchObject({ to: 'TC', root: 'auto-continue', rerouted: false });
  expect(pickHandRoot({ type: 'choice', probabilities: { autocontinue: 0.9, guardian: 0.1 } })).toEqual({ root: 'auto-continue', word: 'autocontinue', p: 0.9 });
});
