// 침묵 감시 (silence-watch) — LOOP-AGENT v2 body (SUPERVISOR-REVIVE-1127 · L0 OP).
//
// S: the old silence watcher (src/supervision/definitions/silence.supervisor.yaml · graphs/ops/silence-watch.yaml) watched
//    owner-less observations of a loop that is switched off; meanwhile mail went unanswered for hours — LAND-GRAPH→TC 0/17,
//    OP→ORCHESTRATOR ≥100 unread, RES 0/12 (census 11-27 §3a «받는 이가 아무것도 안 함» · «깨움 경로 없음»).
// C: a request nobody decides is silent failure twice: the receiver does not act and the sender believes it was heard.
// A: 세 얼굴 —
//   관측 = the msg store (src/msg/msg-store.ts listUnseenRequests stage `ack` — intent=request ⊕ needsAck, no
//          accepted/rejected/done/expired receipt and no done-ack, the same reader as SEAT-MAIL-ACK-SLA) for requests older
//          than the SLA (30 min) and younger than 24 h (older ones belong to retired/mistyped seats), minus those the
//          receiver already replied to (reply_to) · per receiver: does a reading body exist (the kit/mail-route live probe reaches it, or
//          it is a loop agent with a card) · stalled supervisors (DEAD `loop:*` beats). KPI = unanswered requests past
//          SLA, excluding the ones already bounced to their sender. A failing reader → KPI null («모름»).
//   판단 근거 = the card ⊕ the plan: a receiver with no reading body → `bounce` (one line a day per addressee to its dormant-reroute reader, else the sender, via the runtime's
//          post port); otherwise → `redeliver` once (ring the receiver's seat bell — the postoffice/TUI watchers re-read the
//          ledger); already redelivered and still silent → nothing more (the breach escalates to OP).
//   수복과 인계 = both actions are idempotent: the bell is a courtesy over the ledger (undo = none), the bounce is a deduped
//          notice (undo = none · the original stays in the ledger). Stalled supervisors are reported only — their restart is
//          watchers-check's right.
import type { BodyEnv } from '../registry.js';
import type { ActionResult, AgentBody, Observation, PlannedAction, Subject } from '../runtime.js';
import { pv } from '../policy-context.js';

export const SLA_MIN = 30;
export const LOOKBACK_H = 24;
export const SELF_ADDRESS = 'SILENCE-WATCH';

export interface OverdueMail { readonly id: number; readonly from: string; readonly to: string; readonly ageMin: number; readonly summary: string }
export interface SilenceDeps {
  /** Requests past the SLA nobody decided (null = store unreadable). */
  overdue(now: Date, slaMin: number): OverdueMail[] | null;
  /** Per address: true = a reading body exists · false = none in 24 h · missing/null = unknown. */
  readers(now: Date, addresses: readonly string[]): Map<string, boolean | null> | null;
  /** DEAD `loop:*` supervisors (null = unknown). */
  stalled(now: Date): Array<{ name: string; ageMin: number }> | null;
  /** Ring the receiver's bell for this message (idempotent). */
  ring(to: string, msgId: number): boolean;
  /** kit/mail-route dormant reroute: who reads mail sent to a reader-less address instead (null = nobody · deliver back). */
  reroute?(m: { from: string; to: string; body: string }): string | null;
  /** The runtime's deduped post port (wiring passes ports.post). */
  post(key: string, to: string, body: string, kind?: string): number | string | null;
}

export const bounceKey = (id: number): string => `bounce:${id}`;
export const redeliverKey = (id: number): string => `redeliver:${id}`;
/** SUPERVISOR-JOURNAL-DEFECTS (11-27 journal: 154 redeliveries · 38 bounces in 2 h, 8 a tick, ORCHESTRATOR 31 — one row per
 *  message): the bell and the notice are per ADDRESSEE. One ring wakes a seat for its whole inbox; one notice a day per
 *  (addressee, recipient) lists the ids. The per-message keys above still mark each mail as handled. */
export const BOUNCE_IDS_SHOWN = 10; // 출처: 우편 한 줄 = ❓🚨✅ 한 줄만(seat-message-granularity 11-04) — 나머지는 «외 N»
export const bounceNoticeKey = (to: string, recipient: string, now: Date): string => `silence-bounce:${to}:${recipient}:${now.toISOString().slice(0, 10)}`;

export function createBody(env: BodyEnv, deps: SilenceDeps = liveDeps(env.stateRoot, env.card.address)): AgentBody {
  let mails = new Map<number, OverdueMail & { reader: boolean | null }>();

  const observe = (ctx: { now: Date; state: { acted: Record<string, string> } }): Observation => {
    const all = deps.overdue(ctx.now, pv('sla_min', SLA_MIN));
    const stalled = deps.stalled(ctx.now);
    if (all === null) { mails = new Map(); return { kpi: null, subjects: [], facts: ['우편 원장 읽기 실패 → 모름'] }; }
    const rows = all.filter(m => m.to !== SELF_ADDRESS && m.to !== env.card.address);
    const readers = deps.readers(ctx.now, [...new Set(rows.map(m => m.to))]);
    mails = new Map(rows.map(m => [m.id, { ...m, reader: readers?.get(m.to) ?? null }]));
    const open = [...mails.values()].filter(m => !ctx.state.acted[bounceKey(m.id)]);
    const subjects: Subject[] = [
      ...open.sort((a, b) => b.ageMin - a.ageMin).map(m => ({ id: `msg:${m.id}`, kind: m.reader === false ? 'mail-no-reader' : 'mail-overdue',
        summary: `${m.from} → ${m.to} · ${Math.round(m.ageMin)}분 무응답${m.reader === false ? ' · 읽는 몸 없음(24h)' : ''}${ctx.state.acted[redeliverKey(m.id)] ? ' · 재배달함' : ''} · ${m.summary.slice(0, 60)}`, ageMin: m.ageMin })),
      ...(stalled ?? []).map(s => ({ id: s.name, kind: 'stalled-supervisor', summary: `감독자 정적 ${Math.round(s.ageMin)}분 · 재기동은 watchers-check 몫`, ageMin: s.ageMin })),
    ];
    const byTo = new Map<string, number>(); for (const m of open) byTo.set(m.to, (byTo.get(m.to) ?? 0) + 1);
    const facts = [
      `SLA ${pv('sla_min', SLA_MIN)}분 넘은 미결 요청 ${open.length}${byTo.size ? ` — ${[...byTo].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([to, n]) => `${to} ${n}`).join(' · ')}` : ''}`,
      `읽는 몸 없는 주소 ${[...new Set(open.filter(m => m.reader === false).map(m => m.to))].join(',') || '없음'} · 보낸 이에 되돌림 ${mails.size - open.length}`,
      `멈춘 감독자 ${stalled === null ? '모름' : stalled.length ? stalled.map(s => s.name).join(',') : 0}`,
      ...(readers === null ? ['수신자 생존 읽기 실패 → 되돌림 없이 재배달만'] : []),
    ];
    const patterns = [...byTo].filter(([, n]) => n >= 3).map(([to]) => ({ key: `silent:${to}`,
      lesson: `${to} 는 요청을 반복해서 ${pv('sla_min', SLA_MIN)}분 넘게 묵힌다 — 초인종으로는 안 깨어난다. 그 자리의 깨움 경로(탭·초인종 감시)를 OP 가 먼저 본다.` }));
    return { kpi: open.length, subjects, facts, patterns };
  };

  const plan = (obs: Observation, ctx: { state: { acted: Record<string, string> } }): PlannedAction[] => {
    // one action per addressee: `redeliver:<TO>` rings once for all its unrung mail · `bounce:<TO>` notices once for all of it
    const ring = new Map<string, OverdueMail[]>(); const bounce = new Map<string, OverdueMail[]>();
    for (const s of obs.subjects) {
      if (!s.id.startsWith('msg:')) continue;
      const m = mails.get(Number(s.id.slice(4)));
      if (!m) continue;
      if (m.reader === false) bounce.set(m.to, [...(bounce.get(m.to) ?? []), m]);
      else if (!ctx.state.acted[redeliverKey(m.id)]) ring.set(m.to, [...(ring.get(m.to) ?? []), m]);
    }
    return [
      ...[...bounce].map(([to, ms]) => ({ action: 'bounce', target: to, why: `${to} 읽는 몸 없음 · 미결 ${ms.length}통 · 가장 오래된 ${Math.round(Math.max(...ms.map(m => m.ageMin)))}분` })),
      ...[...ring].map(([to, ms]) => ({ action: 'redeliver', target: to, why: `${to} 미결 ${ms.length}통 무응답 · 가장 오래된 ${Math.round(Math.max(...ms.map(m => m.ageMin)))}분` })),
    ];
  };

  // the mail of one addressee in the last observation (target = the address · a numeric target = that one message, voice)
  const mailOf = (target: string, pred: (m: OverdueMail & { reader: boolean | null }) => boolean) => {
    const one = /^\d+$/u.test(target) ? mails.get(Number(target)) : undefined;
    return (one ? [one] : [...mails.values()].filter(m => m.to === target)).filter(pred);
  };

  const actions: AgentBody['actions'] = {
    redeliver: {
      describe: 'SLA 넘은 미결 요청이 있는 자리의 초인종을 한 번 울린다(그 자리 미결 전부 · 원장 그대로) — 되돌림 없음(멱등)',
      run(target, ctx): ActionResult {
        const ms = mailOf(target, m => m.reader !== false && !ctx.state.acted[redeliverKey(m.id)]);
        if (!ms.length) return { ok: false, line: `${target}: 방금 관측에서 다시 알릴 미결 요청이 없다` };
        const to = ms[0]!.to; const newest = ms.reduce((a, b) => (a.ageMin <= b.ageMin ? a : b));
        if (!deps.ring(to, newest.id)) return { ok: false, line: `${to} 초인종 실패(자리 주소가 아님·쓰기 실패) · 미결 ${ms.length}통`, ref: `msg:${newest.id}` };
        const at = ctx.now.toISOString();
        for (const m of ms) ctx.state.acted[redeliverKey(m.id)] = at;
        const oldest = Math.round(Math.max(...ms.map(m => m.ageMin)));
        return { ok: true, line: `${to} 초인종 한 번 — 미결 ${ms.length}통(${ms.slice(0, 3).map(m => `#${m.id}`).join(' ')}${ms.length > 3 ? ` 외 ${ms.length - 3}` : ''}) · 가장 오래된 ${oldest}분`, ref: `msg:${newest.id}`, undo: '없음 — 초인종은 멱등 알림(원장·영수 그대로)' };
      },
    },
    bounce: {
      describe: '읽는 몸이 없는 주소로 간 미결 요청을 대신 읽는 자리(kit/mail-route 잠든 수신처 경로)에, 없으면 보낸 이에게 하루 한 줄로 알린다 — 원본은 원장에 남는다 · 되돌림 없음',
      run(target, ctx): ActionResult {
        const ms = mailOf(target, m => m.reader === false && !ctx.state.acted[bounceKey(m.id)]);
        if (!ms.length) return { ok: false, line: `${target}: 방금 관측에서 읽는 몸 없는 주소로 간 미결 요청이 아니다` };
        const to = ms[0]!.to;
        const groups = new Map<string, OverdueMail[]>();
        for (const m of ms) {
          let via: string | null = null;
          try { via = deps.reroute?.({ from: m.from, to: m.to, body: m.summary }) ?? null; } catch { via = null; }
          const rcpt = via && via !== m.from ? via : m.from;
          groups.set(rcpt, [...(groups.get(rcpt) ?? []), m]);
        }
        const lines: string[] = []; const refs: string[] = []; const at = ctx.now.toISOString();
        for (const [rcpt, g] of groups) {
          const ids = g.map(m => `#${m.id}`);
          const shown = `${ids.slice(0, BOUNCE_IDS_SHOWN).join(' ')}${ids.length > BOUNCE_IDS_SHOWN ? ` 외 ${ids.length - BOUNCE_IDS_SHOWN}` : ''}`;
          const forward = g.some(m => m.from !== rcpt);
          const body = forward
            ? `[${env.card.name}] ${to} 앞 미결 요청 ${g.length}통(${shown}) — ${to} 는 읽는 몸이 없어 잠든 수신처 경로대로 ${rcpt} 가 대신 본다. 원본은 원장에 그대로.`
            : `[${env.card.name}] ${to} 앞 내 미결 요청 ${g.length}통(${shown}) — ${to} 는 읽는 몸이 없다(탭·세션 없음). 다시 묻지 말고 다른 주소로 보내거나 OP 에 묻는다. 원본은 원장에 그대로.`;
          let id: number | string | null;
          try { id = deps.post(bounceNoticeKey(to, rcpt, ctx.now), rcpt, body, 'info'); }
          catch (e) { lines.push(`${rcpt} 알림 실패 — ${e instanceof Error ? e.message : String(e)}`); continue; }
          for (const m of g) ctx.state.acted[bounceKey(m.id)] = at;
          lines.push(`${rcpt} 에 ${forward ? '넘김' : '되돌림'} ${g.length}통${id === null ? '(오늘 이미 알림)' : ` #${id}`}`);
          refs.push(id === null ? `msg:${g[0]!.id}` : `msg:${id}`);
        }
        const ok = refs.length > 0;
        return { ok, line: `${to}(읽는 몸 없음) — ${lines.join(' · ')}`, ...(refs[0] ? { ref: refs[0] } : {}), ...(ok ? { undo: '없음 — 하루 한 줄 알림(멱등 키 silence-bounce:<주소>:<받는 이>:<날>) · 원본은 원장에 남음' } : {}) };
      },
    },
  };
  return { observe, plan, actions };
}

// ── live deps ────────────────────────────────────────────────────────────────────────────────────────────────────────
export function liveDeps(stateRoot: string, address = SELF_ADDRESS): SilenceDeps {
  type MsgMod = typeof import('../../msg/msg-store.js');
  const msgMod = (): MsgMod => require('../../msg/msg-store.js') as MsgMod;
  const withStore = <T>(fn: (s: import('../../msg/msg-store.js').MsgStore) => T): T | null => {
    try {
      const m = msgMod();
      const store = m.openMsgStoreReadOnly(m.defaultMsgStorePath());
      try { return fn(store); } finally { store.close(); }
    } catch { return null; }
  };
  let posting: ((key: string, to: string, body: string, kind?: string) => number | string | null) | null = null;
  return {
    overdue: (now, slaMin) => withStore(store => {
      const rows = store.listUnseenRequests({ stage: 'ack', postedBefore: new Date(now.getTime() - slaMin * 60_000), postedAfter: new Date(now.getTime() - pv('lookback_h', LOOKBACK_H) * 3_600_000), limit: 500 });
      const replied = store.db.query('SELECT 1 FROM msg_messages WHERE reply_to = ? AND sender = ? LIMIT 1');
      return rows.filter(r => !replied.get(r.message.id, r.recipient)).map(r => ({ id: r.message.id, from: r.message.from, to: r.recipient,
        ageMin: (now.getTime() - Date.parse(r.message.createdAt)) / 60_000, summary: r.message.body.replace(/\s+/gu, ' ').slice(0, 120) }));
    }),
    readers: (_now, addresses) => {
      try {
        let loopSeats = new Set<string>();
        try { loopSeats = new Set((require('../card.js') as typeof import('../card.js')).listCards().cards.map(c => c.address)); } catch { /* unknown → by the probe only */ }
        for (const s of Object.values(msgMod().LOOP_AGENT_SEATS)) loopSeats.add(s);
        // SUPERVISOR-JOURNAL-DEFECTS: «posted anything in 24 h» counted ORCHESTRATOR (a relay posts under it · no tab) as a
        // reader → 31 bells nobody heard. A reader = a loop-agent seat or an address the kit live probe reaches (pane/session/tab).
        const isLive = (require('../../kit/mail-route/dormant.js') as typeof import('../../kit/mail-route/dormant.js')).liveByWake();
        return new Map(addresses.map(a => [a, loopSeats.has(a) || isLive(a)] as const));
      } catch { return null; }
    },
    stalled: (now) => {
      try {
        const hb = require('../../kit/heartbeat/index.js') as typeof import('../../kit/heartbeat/index.js');
        return hb.judgeWatchers(hb.readBeats(hb.beatLedgerPath(stateRoot)), now).filter(v => v.name.startsWith('loop:') && v.status === 'DEAD').map(v => ({ name: v.name, ageMin: v.ageMin }));
      } catch { return null; }
    },
    reroute: (m) => {
      const { routeDormant, liveByWake } = require('../../kit/mail-route/dormant.js') as typeof import('../../kit/mail-route/dormant.js');
      const r = routeDormant(m, { isLive: liveByWake() });
      return r ? r.to : null;
    },
    ring: (to, msgId) => {
      try { const m = msgMod(); return (require('../../msg/seat-bell.js') as typeof import('../../msg/seat-bell.js')).ringSeatBell(m.defaultMsgStorePath(), to, msgId); } catch { return false; }
    },
    // Fallback only: the wiring should pass the runtime's ports.post. This builds the same live post port lazily.
    post: (key, to, body, kind) => {
      if (!posting) {
        const { livePorts } = require('../live.js') as typeof import('../live.js');
        const { loadCard } = require('../card.js') as typeof import('../card.js');
        const card = loadCard('silence-watch');
        posting = livePorts({ ...card, address }, { stateRoot, llm: false }).post;
      }
      return posting(key, to, body, kind);
    },
  };
}
