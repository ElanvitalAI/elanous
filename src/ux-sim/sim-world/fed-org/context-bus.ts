// SIM-WORLD fed-org · CONTEXT-BUS-FEDERATION (0.3.39 P0 · CEO 11-28 08:4x «맥락 버스가 주요 서브 조율자 사이에도 · 나중에는
// 주요 루프 에이전트(수호자 등) 사이에도»). Each scene drives the real code in its own universe: the real `eln bus` CLI
// (identity claim checked · callerSeat pinned per scene · the host ELANOUS_TRACK is never read), the real seat digest and wake
// gate, the real kit/bus-post over the repo's own agent.yaml files and a real MsgStore with the loop agents' appendOnce port.
// Expectations are literals (block headers · section lines · counts), never re-derived from the product functions.
//
// 조율자 3 장면: CTX-BUS-DECIDE (A 결정 → B 다음 턴) · CTX-BUS-HQ-HANDOFF (HQ 인계 → 둘 다) · CTX-BUS-RAW-CONTEXT (원문 = 맥락만)
// 루프 에이전트 2 장면: CTX-BUS-LOOP-STATUS (status → L0 digest · 반복 알림 우편 대체) · CTX-BUS-FALLBACK (버스 실패 → 우편 한 번)
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerBusCommands } from '../../../cli/bus-cli.js';
import { busNoticePort, liveBusPostConfig, type BusPostConfig } from '../../../kit/bus-post/index.js';
import { appendOnce } from '../../../msg/hand-raise-ladder.js';
import { MsgStore } from '../../../msg/msg-store.js';
import { busAck, busPost, readBus, type BusItem } from '../../../op-context-bus/bus.js';
import { ackSeatDigests, busWakeKind, createBusWakeGate, seatBusDigests } from '../../../op-context-bus/seat-turn.js';
import { busSpacesForSeat } from '../../../op-context-bus/spaces.js';
import { DEFAULT_ORG } from '../../../org/org-map.js';
import type { SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const NOW = Date.parse('2026-11-28T09:00:00.000Z');
/** The four conversational space leaders below HQ in DEFAULT_ORG (literal — not read from the org map). */
const COORDINATORS = ['TC', 'UX', 'MK', 'JUD'] as const;

function pickTwo(ctx: SimWorldScenarioContext): [string, string, string] {
  const pool: string[] = [...COORDINATORS];
  const a = pool.splice(Math.floor(ctx.random() * pool.length), 1)[0]!;
  const b = pool.splice(Math.floor(ctx.random() * pool.length), 1)[0]!;
  const c = pool[Math.floor(ctx.random() * pool.length)]!;
  return [a, b, c];
}

/** The real `eln bus` CLI in the universe, as `seat` (or the granted Claude OP proxy). */
function busCli(stateRoot: string, seat: string | null, proxy = false) {
  const out: string[] = []; const err: string[] = []; const exits: number[] = [];
  const program = new Command();
  program.exitOverride();
  registerBusCommands(program, {
    out: (l) => { out.push(l); }, err: (l) => { err.push(l); }, setExitCode: (c) => { exits.push(c); },
    stateRoot: () => stateRoot, callerSeat: () => seat,
    verifyProxy: () => (proxy ? { ok: true } : { ok: false, line: 'bus: not the CLAUDE-OP session (sim)' }),
    now: () => NOW, remember: () => undefined, org: () => DEFAULT_ORG,
  });
  return { out, err, exits, run: (argv: string[]) => program.parseAsync(argv, { from: 'user' }) };
}

const digestOf = (stateRoot: string, seat: string, now = NOW) => seatBusDigests(stateRoot, { seat, now, spaces: busSpacesForSeat(seat, DEFAULT_ORG) });
const blockText = (d: ReturnType<typeof digestOf>, space: string): string => d.blocks.find((b) => b.space === space)?.text ?? '';

function universe(ctx: SimWorldScenarioContext): string {
  const root = join(ctx.universeRoot, 'state');
  mkdirSync(root, { recursive: true });
  return root;
}

/** A deduped mail port on a real MsgStore — the shape livePorts / guardian live use (appendOnce on the key). */
function mailPort(store: MsgStore, from: string) {
  return (key: string, to: string, body: string, kind = 'request'): number | null => {
    const w = appendOnce(store, key, () => ({ from, to, body, kind, intent: kind === 'info' || kind === 'status' ? 'info' : 'decision', refs: [key] }));
    return w.fresh ? w.mail.id : null;
  };
}
const mailCount = (store: MsgStore): number => (store.db.query('SELECT COUNT(*) AS n FROM msg_messages').get() as { n: number }).n;

/** Literal copy of the two agent.yaml opt-ins (graphs/loop-agents/{silence-watch,guardian}/agent.yaml `bus.notices`). */
const EXPECTED_NOTICES: Readonly<Record<string, readonly string[]>> = { 'silence-watch': ['info'], guardian: ['status'] };

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'CTX-BUS-DECIDE',
    title: 'coordinator A posts a decision to HQ → coordinator B\'s next turn digest shows it once; A is not shown its own write; a hand never reads HQ',
    async run(ctx) {
      const root = universe(ctx);
      const [a, b] = pickTwo(ctx);
      const body = `seed ${ctx.seed}: ${a} 판은 TA 신규 발사 0 — 착지 수리 먼저`;
      const cli = busCli(root, a);
      await cli.run(['bus', 'post', '--as', a, '--type', 'decision', '--space', 'HQ', '--ref', `cell:SIM-${ctx.seed}`, body]);
      if (cli.exits.length) return fail('post-refused', cli.err.join(' | '));
      if (!/^bus: b-[0-9a-z]{10}-[0-9a-f]{6} decision @HQ$/u.test(cli.out[0] ?? '')) return fail('post-line', cli.out.join(' | '));
      const db = digestOf(root, b);
      const hq = blockText(db, 'HQ');
      if (!hq.startsWith(`<op_context_bus space="HQ" seat="${b}" new="1">`)) return fail('B-no-HQ-block', hq || '(none)');
      if (!hq.includes('참고:') || !hq.includes(`decision ${a}: ${body}`)) return fail('B-misses-decision', hq);
      if (hq.includes('할 일(소화됨):')) return fail('decision-became-todo', hq);
      const da = digestOf(root, a);
      if (blockText(da, 'HQ') !== '') return fail('own-write-echoed', blockText(da, 'HQ'));
      // a hand (not a space leader) reads its own space ⊕ OP addressed — never HQ
      const hand = busSpacesForSeat('TC-1', DEFAULT_ORG).map((s) => `${s.space}:${s.view}`).join(',');
      if (hand !== 'TC-1:full,OP:addressed') return fail('hand-spaces', hand);
      // the turn acks: B's next digest does not show it again
      const acked = ackSeatDigests(root, b, db);
      if (!acked.includes('HQ')) return fail('ack-missing', acked.join(','));
      if (blockText(digestOf(root, b), 'HQ') !== '') return fail('re-shown-after-ack', blockText(digestOf(root, b), 'HQ'));
      ctx.recorder.event('ctx-bus:decide', { a, b, seed: ctx.seed });
      return { ok: true };
    },
  },
  {
    id: 'CTX-BUS-HQ-HANDOFF',
    title: 'OP hands off to two coordinators in HQ → both get it as 할 일 and a wake; the third coordinator sees it as 참고 and is not woken',
    async run(ctx) {
      const root = universe(ctx);
      const [a, b, c] = pickTwo(ctx);
      const cli = busCli(root, 'OP');
      const body = `seed ${ctx.seed}: 0.3.39 컷 전 착지 수리 ${a}·${b} 공동 — 판 노트에 한 줄씩`;
      await cli.run(['bus', 'post', '--as', 'OP', '--type', 'handoff', '--space', 'HQ', '--ref', `seat:${a}`, '--ref', `seat:${b}`, body]);
      if (cli.exits.length) return fail('post-refused', cli.err.join(' | '));
      const items = readBus(root, 'HQ');
      if (items.length !== 1) return fail('hq-count', String(items.length));
      for (const s of [a, b]) {
        const hq = blockText(digestOf(root, s), 'HQ');
        if (!hq.includes('할 일(소화됨):') || !hq.includes(`handoff OP: ${body}`)) return fail('handoff-missing', `${s}: ${hq}`);
        const gate = createBusWakeGate(s, 30 * 60_000);
        const w = gate.offer(items, NOW);
        if (w.action !== 'wake' || w.reason !== 'normal') return fail('no-wake', `${s}: ${JSON.stringify(w)}`);
      }
      const third = blockText(digestOf(root, c), 'HQ');
      if (third.includes('할 일(소화됨):') || !third.includes('참고:')) return fail('third-view', third);
      if (createBusWakeGate(c, 30 * 60_000).offer(items, NOW).action !== 'none') return fail('third-woken', c);
      // OP, the writer, is not shown its own handoff
      if (blockText(digestOf(root, 'OP'), 'HQ') !== '') return fail('own-write-echoed', blockText(digestOf(root, 'OP'), 'HQ'));
      ctx.recorder.event('ctx-bus:hq-handoff', { a, b, c, seed: ctx.seed });
      return { ok: true };
    },
  },
  {
    id: 'CTX-BUS-RAW-CONTEXT',
    title: 'a raw CEO line is context only (no wake · no 할 일 · coordinators below HQ never see it); only the digested handoff that refs it acts',
    async run(ctx) {
      const root = universe(ctx);
      const [a] = pickTwo(ctx);
      const claude = busCli(root, 'OP', true);
      const words = `seed ${ctx.seed} — ${a} 쪽 착지 줄을 오늘 안에 비워 주세요`;
      await claude.run(['bus', 'post', '--as', 'CLAUDE-OP', '--type', 'ceo-request', '--source', 'telegram', words]);
      if (claude.exits.length) return fail('ceo-post-refused', claude.err.join(' | '));
      const raw = readBus(root, 'OP')[0]!;
      for (const s of ['OP', a]) if (busWakeKind(raw, s) !== null) return fail('raw-wakes', s);
      const op1 = blockText(digestOf(root, 'OP'), 'OP');
      if (!op1.includes('CEO 원문(맥락 · Claude OP 소화 중 — 이것만 보고 행동하지 말 것):') || op1.includes('할 일(소화됨):')) return fail('op-raw-view', op1);
      const a1 = digestOf(root, a);
      if (a1.text !== null) return fail('raw-reached-coordinator', a1.text);
      // the digested item: Claude OP hands off to A in the OP space, ref bus:<raw id>
      await claude.run(['bus', 'post', '--as', 'CLAUDE-OP', '--type', 'handoff', '--owner', a, '--ref', `bus:${raw.id}`, `${a}: 착지 줄 비우기 — 오늘 18:00 까지 (CEO ${raw.id})`]);
      const items = readBus(root, 'OP');
      const handoff = items.find((i) => i.type === 'handoff')!;
      const a2 = blockText(digestOf(root, a), 'OP');
      if (!a2.startsWith(`<op_context_bus space="OP" seat="${a}" new="2">`) || !a2.includes(`handoff CLAUDE-OP: ${a}: 착지 줄 비우기`)) return fail('digested-missing', a2);
      if (a2.includes('CEO 원문')) return fail('raw-in-coordinator-view', a2);
      const w = createBusWakeGate(a, 30 * 60_000).offer(items, NOW);
      if (w.action !== 'wake') return fail('digested-no-wake', JSON.stringify(w));
      const op2 = blockText(digestOf(root, 'OP'), 'OP');
      if (!op2.includes(`처리됨(접음 · 행동 불필요): ${raw.id}→${handoff.id}`)) return fail('op-not-folded', op2);
      ctx.recorder.event('ctx-bus:raw-context', { a, seed: ctx.seed });
      return { ok: true };
    },
  },
  {
    id: 'CTX-BUS-LOOP-STATUS',
    title: 'silence-watch and guardian notices (their agent.yaml bus-post opt-in) reach the L0 bus digest as status; requests and non-reading recipients stay mail; repeat ticks add nothing',
    async run(ctx) {
      const root = universe(ctx);
      for (const id of ['silence-watch', 'guardian']) {
        const cfg = liveBusPostConfig(id);
        if (!cfg) return fail('no-bus-post-node', id);
        if (cfg.notices.join(',') !== EXPECTED_NOTICES[id]!.join(',')) return fail('notice-kinds', `${id}: ${cfg.notices.join(',')}`);
      }
      // OP reads the bus (acked a digest an hour ago); TC never acked (its turns do not carry the bus)
      const seed0 = busPost(root, { type: 'status', from: 'CLAUDE-OP', body: 'sim: OP reads the bus' }, { space: 'OP', now: NOW - 3_600_000 });
      if (seed0.kind !== 'posted') return fail('seed-post', seed0.kind);
      busAck(root, seed0.entry.id, 'OP', { space: 'OP', now: NOW - 3_600_000 });
      // the live 24 h shape (11-28 msg ledger): silence-watch → OP info 26 lesson candidates ⊕ 18 «읽는 몸 없음» · → TC 2 ·
      // 2 kpi-breach requests · guardian → RES 15 «30분» status ⊕ 15 scale-up requests
      type Post = { agent: 'silence-watch' | 'guardian'; key: string; to: string; kind: string; body: string };
      const day: Post[] = [
        ...Array.from({ length: 26 }, (_, i) => ({ agent: 'silence-watch' as const, key: `lesson-candidate:silence-watch:L${i}`, to: 'OP', kind: 'info', body: `[침묵 감시 · 교훈 후보 L${i}] 같은 꼴 3회` })),
        ...Array.from({ length: 18 }, (_, i) => ({ agent: 'silence-watch' as const, key: `silence-bounce:REL:OP:d${i}`, to: 'OP', kind: 'info', body: `[침묵 감시] #${190000 + i} → REL: 읽는 몸 없음` })),
        ...Array.from({ length: 2 }, (_, i) => ({ agent: 'silence-watch' as const, key: `silence-bounce:REL:TC:d${i}`, to: 'TC', kind: 'info', body: `[침묵 감시] #${191000 + i} → REL: 읽는 몸 없음` })),
        ...Array.from({ length: 2 }, (_, i) => ({ agent: 'silence-watch' as const, key: `kpi-breach:silence-watch:${i}`, to: 'OP', kind: 'request', body: `[침묵 감시 → L0 OP] KPI 위반 ${60 + i}분` })),
        ...Array.from({ length: 15 }, (_, i) => ({ agent: 'guardian' as const, key: `guardian-digest:2026-11-28T${String(i).padStart(2, '0')}:00`, to: 'RES', kind: 'status', body: `[수호자 · 30분] 정리 0 · 경로 node-b #${i}` })),
        ...Array.from({ length: 15 }, (_, i) => ({ agent: 'guardian' as const, key: `scale-up:2026-11-28T${String(i).padStart(2, '0')}`, to: 'RES', kind: 'request', body: `[수호자 · 손 늘리기 제안] #${i}` })),
      ];
      const order = day.map((p, i) => ({ p, r: ctx.random(), i })).sort((x, y) => x.r - y.r || x.i - y.i).map((x) => x.p);
      const run = (wrapped: boolean): { mail: number; store: MsgStore } => {
        const store = new MsgStore(join(ctx.universeRoot, `messages-${wrapped ? 'after' : 'before'}.db`));
        const ports = new Map<string, (k: string, t: string, b: string, kind?: string) => unknown>();
        for (const id of ['silence-watch', 'guardian'] as const) {
          const address = id === 'guardian' ? 'GUARDIAN' : 'SILENCE-WATCH';
          const mail = mailPort(store, address);
          ports.set(id, wrapped ? busNoticePort(mail, liveBusPostConfig(id) as BusPostConfig, { stateRoot: root, from: address, org: () => DEFAULT_ORG, now: () => NOW, mailHas: (k) => store.findByProvenanceKey(k) !== null }) : mail);
        }
        for (let tick = 0; tick < 2; tick++) for (const p of order) ports.get(p.agent)!(p.key, p.to, p.body, p.kind); // two ticks: the second repeats every key
        return { mail: mailCount(store), store };
      };
      const before = run(false);
      const after = run(true);
      before.store.close();
      const statusRows = readBus(root, 'OP').filter((i: BusItem) => i.type === 'status' && i.from !== 'CLAUDE-OP');
      after.store.close();
      if (before.mail !== 78) return fail('before-mail', String(before.mail));
      if (after.mail !== 19) return fail('after-mail', String(after.mail));
      if (statusRows.length !== 59) return fail('bus-status', String(statusRows.length));
      if (statusRows.filter((i) => i.from === 'GUARDIAN').length !== 15) return fail('guardian-status', String(statusRows.filter((i) => i.from === 'GUARDIAN').length));
      if (!statusRows.every((i) => i.refs.some((r) => r.startsWith('seat:')))) return fail('status-unaddressed', statusRows.find((i) => !i.refs.some((r) => r.startsWith('seat:')))!.id);
      // the L0 digest carries them (참고 · bounded) — no 할 일, no wake
      const op = blockText(digestOf(root, 'OP'), 'OP');
      if (!op.startsWith('<op_context_bus space="OP" seat="OP" new="59">') || !op.includes('참고:') || !op.includes('외 56건')) return fail('l0-digest', op.split('\n').slice(0, 3).join(' | '));
      if (createBusWakeGate('OP', 30 * 60_000).offer(statusRows, NOW).action !== 'none') return fail('status-woke-op', 'OP');
      ctx.recorder.event('ctx-bus:loop-status', { seed: ctx.seed, mailBefore: before.mail, mailAfter: after.mail, busStatus: statusRows.length });
      return { ok: true };
    },
  },
  {
    id: 'CTX-BUS-FALLBACK',
    title: 'a bus write that fails falls back to mail once; the same key later is not posted to the bus again; a new key after recovery goes to the bus',
    async run(ctx) {
      const root = universe(ctx);
      const seed0 = busPost(root, { type: 'status', from: 'CLAUDE-OP', body: 'sim: OP reads the bus' }, { space: 'OP', now: NOW - 600_000 });
      if (seed0.kind !== 'posted') return fail('seed-post', seed0.kind);
      busAck(root, seed0.entry.id, 'OP', { space: 'OP', now: NOW - 600_000 });
      const store = new MsgStore(join(ctx.universeRoot, 'messages.db'));
      try {
        const failFirst = 1 + Math.floor(ctx.random() * 3); // 1..3 broken writes, per seed
        let calls = 0;
        const port = busNoticePort(mailPort(store, 'SILENCE-WATCH'), liveBusPostConfig('silence-watch') as BusPostConfig, {
          stateRoot: root, from: 'SILENCE-WATCH', org: () => DEFAULT_ORG, now: () => NOW,
          busPost: (r, input, opts) => { calls++; if (calls <= failFirst) throw new Error('bus: write lock busy'); return busPost(r, input, opts); },
          mailHas: (k) => store.findByProvenanceKey(k) !== null,
        });
        const keys = Array.from({ length: failFirst }, (_, i) => `lesson-candidate:silence-watch:F${i}`);
        for (let tick = 0; tick < 3; tick++) for (const k of keys) port(k, 'OP', `[침묵 감시 · 교훈 후보] ${k}`, 'info');
        const mailed = mailCount(store);
        if (mailed !== failFirst) return fail('fallback-mail-count', `${mailed} ≠ ${failFirst}`);
        const busNotices = () => readBus(root, 'OP').filter((i) => i.from === 'SILENCE-WATCH');
        if (busNotices().length !== 0) return fail('fallback-key-reposted', String(busNotices().length));
        const fresh = port('lesson-candidate:silence-watch:NEW', 'OP', '[침묵 감시 · 교훈 후보] NEW', 'info');
        if (typeof fresh !== 'string' || !fresh.startsWith('bus:b-')) return fail('recovered-not-bus', String(fresh));
        if (busNotices().length !== 1 || mailCount(store) !== failFirst) return fail('after-recovery', `bus ${busNotices().length} · mail ${mailCount(store)}`);
        ctx.recorder.event('ctx-bus:fallback', { seed: ctx.seed, failFirst });
        return { ok: true };
      } finally { store.close(); }
    },
  },
];
