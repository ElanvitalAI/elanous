// 침묵 감시 (silence-watch) — LOOP-AGENT v2 body (SUPERVISOR-REVIVE-1127 · L0 OP).
//
// S: the old silence watcher (src/supervision/definitions/silence.supervisor.yaml · graphs/ops/silence-watch.yaml) watched
//    owner-less observations of a loop that is switched off; meanwhile mail went unanswered for hours — LAND-GRAPH→TC 0/17,
//    OP→ORCHESTRATOR ≥100 unread, RES 0/12 (census 11-27 §3a «받는 이가 아무것도 안 함» · «깨움 경로 없음»).
// C: a request nobody decides is silent failure twice: the receiver does not act and the sender believes it was heard.
// A: 세 얼굴 —
//   관측 = the msg store (src/msg/msg-store.ts listUnseenRequests stage `ack` — intent=request ⊕ needsAck, no
//          accepted/rejected/done/expired receipt and no done-ack, the same reader as SEAT-MAIL-ACK-SLA) for requests older
//          than the SLA (30 min · 15 min for a request from OP — policy sla_min_op) and younger than 24 h (older ones belong to retired/mistyped seats), minus those the
//          receiver already replied to (reply_to) · per receiver: does a reading body exist (the kit/mail-route live probe reaches it, or
//          it is a loop agent with a card) · stalled supervisors (DEAD `loop:*` beats). KPI = unanswered requests past
//          SLA, excluding the ones already bounced to their sender. A failing reader → KPI null («모름»).
//   판단 근거 = the card ⊕ the plan: a receiver with no reading body → `bounce` (one line a day per addressee to its dormant-reroute reader, else the sender, via the runtime's
//          post port); otherwise → `redeliver` once (ring the receiver's seat bell — the postoffice/TUI watchers re-read the
//          ledger); already redelivered and still silent → nothing more (the breach escalates to OP).
//   수복과 인계 = both actions are idempotent: the bell is a courtesy over the ledger (undo = none), the bounce is a deduped
//          notice (undo = none · the original stays in the ledger). Stalled supervisors are reported only — their restart is
//          watchers-check's right.
//   DETECT-TO-ACTION (대표 11-28 07:2x «루프 에이전트 v3 잘 돌아가나요» · journal 11-27: KPI 158 flat 18 h · «행동 1/6 · 거절 5»):
//          140 of the 159 were already SEEN and hand-ACKED by a live receiver and rung once — the redeliver ladder had no next
//          step, so the KPI could never move. A request whose structured `cell:<ID>` ref shows its answer in the cell ledger
//          (the receiver wrote that cell after the mail · the cell is green/done · its owner moved to someone else) was decided
//          there, not in the mail. `settle` writes the receipt the ledger already proves: one `done` per such mail
//          (source = ledger · evidence = the ledger event) — never for a mail whose cell says nothing (that stays the
//          receiver's decision · the KPI breach card goes to OP).
//   SILENCE-NOTICE-NOT-REQUEST (대표 11-28 17:3x «루프 에이전트 임무 완수» · KPI 123 in breach 27 h): the live census of the
//          24 h window found 2,300 waiting rows — the reader stopped at the newest 500 BEFORE the reply filter, so the KPI
//          (123) was a page-size artifact and settle never saw the older half — and 189 of the 511 really open ones were
//          work-block NOTICES stored as requests. Now: the reader walks every page (page_rows × pages_max · policy) ·
//          what is a notice is ONE shared reader of kit/mail-route/notice-policy.yaml (passive kinds ⊕ the work-block
//          shape · structured fields only) — the KPI never counts a notice, no notice is rung or bounced, and a notice
//          stored before the policy (needsAck=1) is closed by `close-notice` (the per-id ack `done` · at most
//          notice_close_max per seat a run · journaled with the prior ack state · undo = `reopen-notice` puts it back).
import type { BodyEnv } from '../registry.js';
import type { ActionResult, AgentBody, Observation, PlannedAction, Subject } from '../runtime.js';
import { pn } from '../policy-context.js';
import { mayCloseNoticeFor, noticeReason, passiveStoredKinds } from '../../kit/mail-route/notice.js';


export interface OverdueMail {
  readonly id: number; readonly from: string; readonly to: string; readonly ageMin: number; readonly summary: string;
  /** Structured `cell:<ID>` refs of the envelope (refs_json) — never parsed from the body. */
  readonly cells?: readonly string[];
  /** Envelope kind (assign · steward-exception · request …). */
  readonly kind?: string;
  /** Posted at (ISO) — the ledger answer must come after it. */
  readonly at?: string;
}
/** A notice (kit/mail-route/notice-policy.yaml) still stored as waiting — posted before the policy with needsAck=1. */
export interface OpenNotice { readonly id: number; readonly from: string; readonly to: string; readonly ageMin: number; readonly reason: string }
/** The explicit per-id ack row before close-notice wrote `done` (none = there was no row). */
export type PriorAck = 'acked' | 'none';
/** Where the cell ledger already answered this request (null = it says nothing · the receiver still owes the decision). */
export interface LedgerAnswer { readonly cell: string; readonly why: 'receiver-wrote' | 'cell-closed' | 'owner-moved'; readonly evidence: string }
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
  /** DETECT-TO-ACTION: the cell ledger's answer to this request (null = none · throws/absent = unknown → not settled). */
  ledgerAnswer?(m: OverdueMail): LedgerAnswer | null;
  /** DETECT-TO-ACTION: write the `done` receipt the ledger proves (source ledger · evidence) — true = recorded. */
  settle?(to: string, msgId: number, reason: string, evidence: string): boolean;
  /** NOTICE-NOT-REQUEST: notices past the SLA still stored as waiting (null = store unreadable · absent = none). */
  notices?(now: Date, slaMin: number): OpenNotice[] | null;
  /** Close one notice for its recipient (per-id ack `done`) — the prior ack state, or null when nothing was written. */
  closeNotice?(to: string, msgId: number): PriorAck | null;
  /** The exact undo of closeNotice: the ack row back to its prior state — true = restored. */
  reopenNotice?(to: string, msgId: number, prior: PriorAck): boolean;
  /** The last overdue() read stopped at pages_max with more rows left (the KPI is then a lower bound). */
  truncated?(): boolean;
}

export const bounceKey = (id: number): string => `bounce:${id}`;
export const redeliverKey = (id: number): string => `redeliver:${id}`;
export const settleKey = (id: number): string => `settle:${id}`;
const noticeKey = (id: number): string => `notice:${id}`;
const noticePriorKey = (id: number): string => `notice-prior:${id}`;
const reopenKey = (id: number): string => `reopen:${id}`;
const ANSWER_LINE: Readonly<Record<LedgerAnswer['why'], string>> = { 'receiver-wrote': '받는 이가 칸 원장에 씀', 'cell-closed': '칸이 끝남', 'owner-moved': '칸 주인이 바뀜' };
/** SUPERVISOR-JOURNAL-DEFECTS (11-27 journal: 154 redeliveries · 38 bounces in 2 h, 8 a tick, ORCHESTRATOR 31 — one row per
 *  message): the bell and the notice are per ADDRESSEE. One ring wakes a seat for its whole inbox; one notice a day per
 *  (addressee, recipient) lists the ids. The per-message keys above still mark each mail as handled. */
export const BOUNCE_IDS_SHOWN = 10; // 출처: 우편 한 줄 = ❓🚨✅ 한 줄만(seat-message-granularity 11-04) — 나머지는 «외 N»
export const bounceNoticeKey = (to: string, recipient: string, now: Date): string => `silence-bounce:${to}:${recipient}:${now.toISOString().slice(0, 10)}`;

export function createBody(env: BodyEnv, deps: SilenceDeps = liveDeps(env.stateRoot, env.card.address)): AgentBody {
  let mails = new Map<number, OverdueMail & { reader: boolean | null; answer: LedgerAnswer | null }>();
  let notices = new Map<number, OpenNotice>();
  const answerOf = (m: OverdueMail): LedgerAnswer | null => {
    if (!m.cells?.length || !deps.ledgerAnswer) return null;
    try { return deps.ledgerAnswer(m); } catch { return null; }
  };

  const noticesByTo = (): Map<string, OpenNotice[]> => {
    const by = new Map<string, OpenNotice[]>();
    for (const n of notices.values()) by.set(n.to, [...(by.get(n.to) ?? []), n]);
    return by;
  };

  const observe = (ctx: { now: Date; state: { acted: Record<string, string> } }): Observation => {
    // YAML-OPS-SCRIPTS-ABSORB: a request from OP is due after sla_min_op (the retired op-overdue-doorbell.py's 15 min) · any
    // other sender after sla_min — the store read uses the smaller one, the filter below decides per mail.
    const slaAll = pn('sla_min'); const slaOp = pn('sla_min_op');
    const all = deps.overdue(ctx.now, Math.min(slaAll, slaOp));
    const stalled = deps.stalled(ctx.now);
    if (all === null) { mails = new Map(); notices = new Map(); return { kpi: null, subjects: [], facts: ['우편 원장 읽기 실패 → 모름'] }; }
    let noticeRows: OpenNotice[] | null = [];
    try { noticeRows = deps.notices ? deps.notices(ctx.now, pn('sla_min')) : []; } catch { noticeRows = null; }
    // a notice the L0 reopened stays open (its classification is the policy file's · this agent never closes it twice)
    notices = new Map((noticeRows ?? []).filter(n => n.to !== env.card.address && mayCloseNoticeFor(n.to) && !ctx.state.acted[reopenKey(n.id)]).map(n => [n.id, n]));
    const rows = all.filter(m => m.to !== env.card.address && m.ageMin >= (m.from === 'OP' ? slaOp : slaAll));
    const readers = deps.readers(ctx.now, [...new Set(rows.map(m => m.to))]);
    mails = new Map(rows.map(m => [m.id, { ...m, reader: readers?.get(m.to) ?? null, answer: answerOf(m) }]));
    const open = [...mails.values()].filter(m => !ctx.state.acted[bounceKey(m.id)]);
    const subjects: Subject[] = [
      ...open.sort((a, b) => b.ageMin - a.ageMin).map(m => ({ id: `msg:${m.id}`, kind: m.answer ? 'mail-answered-in-ledger' : m.reader === false ? 'mail-no-reader' : 'mail-overdue',
        summary: `${m.from} → ${m.to} · ${Math.round(m.ageMin)}분 무응답${m.reader === false ? ' · 읽는 몸 없음(24h)' : ''}${ctx.state.acted[redeliverKey(m.id)] ? ' · 재배달함' : ''}${m.answer ? ` · 원장 답: ${ANSWER_LINE[m.answer.why]}(${m.answer.cell})` : ''} · ${m.summary.slice(0, 60)}`, ageMin: m.ageMin })),
      ...(stalled ?? []).map(s => ({ id: s.name, kind: 'stalled-supervisor', summary: `감독자 정적 ${Math.round(s.ageMin)}분 · 재기동은 watchers-check 몫`, ageMin: s.ageMin })),
      // one subject per addressee — notices are not requests: never counted, rung or bounced (close-notice only)
      ...[...noticesByTo()].map(([to, ns]) => ({ id: `notice:${to}`, kind: 'mail-notice', summary: `${to} 앞 알림(회신 불필요) ${ns.length}통이 아직 요청처럼 열림 · 가장 오래된 ${Math.round(Math.max(...ns.map(n => n.ageMin)))}분`, ageMin: Math.max(...ns.map(n => n.ageMin)) })),
    ];
    const byTo = new Map<string, number>(); for (const m of open) byTo.set(m.to, (byTo.get(m.to) ?? 0) + 1);
    const facts = [
      `SLA ${pn('sla_min')}분(OP 발신 ${pn('sla_min_op')}분) 넘은 미결 요청 ${open.length}${byTo.size ? ` — ${[...byTo].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([to, n]) => `${to} ${n}`).join(' · ')}` : ''}`,
      `칸 원장이 이미 답한 요청 ${open.filter(m => m.answer).length} (정리 대상 · settle)`,
      `알림(회신 불필요 · notice-policy) 열린 ${notices.size}통 — KPI 에 안 셈 · 정리 대상(close-notice)${noticeRows === null ? ' · 알림 읽기 실패 → 정리 없음' : ''}`,
      ...(deps.truncated?.() ? [`우편 원장 쪽 상한(pages_max) 도달 — KPI ${open.length} 는 하한`] : []),
      `읽는 몸 없는 주소 ${[...new Set(open.filter(m => m.reader === false).map(m => m.to))].join(',') || '없음'} · 보낸 이에 되돌림 ${mails.size - open.length}`,
      `멈춘 감독자 ${stalled === null ? '모름' : stalled.length ? stalled.map(s => s.name).join(',') : 0}`,
      ...(readers === null ? ['수신자 생존 읽기 실패 → 되돌림 없이 재배달만'] : []),
    ];
    const patterns = [...byTo].filter(([, n]) => n >= 3).map(([to]) => ({ key: `silent:${to}`,
      lesson: `${to} 는 요청을 반복해서 ${pn('sla_min')}분 넘게 묵힌다 — 초인종으로는 안 깨어난다. 그 자리의 깨움 경로(탭·초인종 감시)를 OP 가 먼저 본다.` }));
    return { kpi: open.length, subjects, facts, patterns };
  };

  const plan = (obs: Observation, ctx: { state: { acted: Record<string, string> } }): PlannedAction[] => {
    // one action per addressee: `redeliver:<TO>` rings once for all its unrung mail · `bounce:<TO>` notices once for all of it
    const ring = new Map<string, OverdueMail[]>(); const bounce = new Map<string, OverdueMail[]>(); const settle = new Map<string, OverdueMail[]>();
    const close: string[] = [];
    for (const s of obs.subjects) {
      if (s.id.startsWith('notice:')) { if (deps.closeNotice) close.push(s.id.slice(7)); continue; }
      if (!s.id.startsWith('msg:')) continue;
      const m = mails.get(Number(s.id.slice(4)));
      if (!m) continue;
      if (m.answer && deps.settle) settle.set(m.to, [...(settle.get(m.to) ?? []), m]);
      else if (m.reader === false) bounce.set(m.to, [...(bounce.get(m.to) ?? []), m]);
      else if (!ctx.state.acted[redeliverKey(m.id)]) ring.set(m.to, [...(ring.get(m.to) ?? []), m]);
    }
    return [
      ...close.map(to => { const ns = noticesByTo().get(to) ?? []; return { action: 'close-notice', target: to, why: `${to} 앞 알림 ${ns.length}통은 회신을 기다리지 않는다(notice-policy · ${[...new Set(ns.map(n => n.reason))].slice(0, 2).join(' · ')}) — 요청 SLA 에서 닫는다` }; }),
      ...[...settle].map(([to, ms]) => ({ action: 'settle', target: to, why: `${to} 앞 ${ms.length}통은 칸 원장이 이미 답함(${ms.slice(0, 3).map(m => `#${m.id} ${m.cells![0]}`).join(' · ')}${ms.length > 3 ? ` 외 ${ms.length - 3}` : ''})` })),
      ...[...bounce].map(([to, ms]) => ({ action: 'bounce', target: to, why: `${to} 읽는 몸 없음 · 미결 ${ms.length}통 · 가장 오래된 ${Math.round(Math.max(...ms.map(m => m.ageMin)))}분` })),
      ...[...ring].map(([to, ms]) => ({ action: 'redeliver', target: to, why: `${to} 미결 ${ms.length}통 무응답 · 가장 오래된 ${Math.round(Math.max(...ms.map(m => m.ageMin)))}분` })),
    ];
  };

  // the mail of one addressee in the last observation (target = the address · a numeric target = that one message, voice)
  const mailOf = (target: string, pred: (m: OverdueMail & { reader: boolean | null; answer: LedgerAnswer | null }) => boolean) => {
    const one = /^\d+$/u.test(target) ? mails.get(Number(target)) : undefined;
    return (one ? [one] : [...mails.values()].filter(m => m.to === target)).filter(pred);
  };

  const actions: AgentBody['actions'] = {
    redeliver: {
      describe: 'SLA 넘은 미결 요청이 있는 자리의 초인종을 한 번 울린다(그 자리 미결 전부 · 원장 그대로) — 되돌림 없음(멱등)',
      run(target, ctx): ActionResult {
        const ms = mailOf(target, m => m.reader !== false && !m.answer && !ctx.state.acted[redeliverKey(m.id)]);
        if (!ms.length) return { ok: false, line: `${target}: 방금 관측에서 다시 알릴 미결 요청이 없다` };
        const to = ms[0]!.to; const newest = ms.reduce((a, b) => (a.ageMin <= b.ageMin ? a : b));
        if (!deps.ring(to, newest.id)) return { ok: false, line: `${to} 초인종 실패(자리 주소가 아님·쓰기 실패) · 미결 ${ms.length}통`, ref: `msg:${newest.id}` };
        const at = ctx.now.toISOString();
        for (const m of ms) ctx.state.acted[redeliverKey(m.id)] = at;
        const oldest = Math.round(Math.max(...ms.map(m => m.ageMin)));
        return { ok: true, line: `${to} 초인종 한 번 — 미결 ${ms.length}통(${ms.slice(0, 3).map(m => `#${m.id}`).join(' ')}${ms.length > 3 ? ` 외 ${ms.length - 3}` : ''}) · 가장 오래된 ${oldest}분`, ref: `msg:${newest.id}`, undo: '없음 — 초인종은 멱등 알림(원장·영수 그대로)' };
      },
    },
    settle: {
      describe: '칸 원장이 이미 답한 미결 요청(받는 이가 그 칸에 씀 · 칸이 끝남 · 칸 주인이 바뀜)에 원장이 증명하는 done 영수를 쓴다(근거 = 원장 사건) — 칸이 아무 말도 안 하는 요청은 건드리지 않는다 · 되돌림 없음(영수는 앞으로만)',
      run(target, ctx): ActionResult {
        const ms = mailOf(target, m => !!m.answer && !ctx.state.acted[settleKey(m.id)]);
        if (!ms.length || !deps.settle) return { ok: false, line: `${target}: 방금 관측에서 칸 원장이 답한 미결 요청이 없다` };
        const at = ctx.now.toISOString(); const done: number[] = []; const failed: number[] = [];
        for (const m of ms) {
          let ok = false;
          try { ok = deps.settle(m.to, m.id, `silence-watch: ${ANSWER_LINE[m.answer!.why]} — 우편 대신 칸 원장에서 결정됨`, m.answer!.evidence); } catch { ok = false; }
          if (ok) { ctx.state.acted[settleKey(m.id)] = at; done.push(m.id); } else failed.push(m.id);
        }
        const to = ms[0]!.to;
        const why = [...new Set(ms.filter(m => done.includes(m.id)).map(m => ANSWER_LINE[m.answer!.why]))].join('·');
        const line = `${to} 미결 ${done.length}통 정리(done · 원장 근거: ${why || '-'})${done.length ? ` ${done.slice(0, 3).map(n => `#${n}`).join(' ')}${done.length > 3 ? ` 외 ${done.length - 3}` : ''}` : ''}${failed.length ? ` · 영수 실패 ${failed.length}(${failed.slice(0, 3).map(n => `#${n}`).join(' ')})` : ''}`;
        return { ok: done.length > 0, line, ...(done[0] !== undefined ? { ref: `msg:${done[0]}` } : {}), ...(done.length ? { undo: '없음 — 영수는 앞으로만(근거 = 칸 원장 사건 · 원본 우편 그대로)' } : {}) };
      },
    },
    'close-notice': {
      describe: 'notice-policy(kit/mail-route/notice-policy.yaml)가 알림으로 정한 우편 중 아직 요청처럼 열린 것(정책 전 needsAck=1)을 그 자리 대신 닫는다(우편별 ack done · 한 번에 자리당 notice_close_max 통 · 일지에 이전 ack 상태) — 요청은 건드리지 않는다 · 되돌림 = reopen-notice',
      run(target, ctx): ActionResult {
        const ns = (/^\d+$/u.test(target) ? [notices.get(Number(target))].filter((n): n is OpenNotice => !!n) : (noticesByTo().get(target) ?? []))
          .filter(n => !ctx.state.acted[noticeKey(n.id)]).sort((a, b) => a.id - b.id).slice(0, pn('notice_close_max')); // oldest first (id order · stable)
        if (!ns.length || !deps.closeNotice) return { ok: false, line: `${target}: 방금 관측에서 닫을 알림이 없다` };
        const at = ctx.now.toISOString(); const done: Array<{ id: number; prior: PriorAck }> = []; const failed: number[] = [];
        for (const n of ns) {
          let prior: PriorAck | null = null;
          try { prior = deps.closeNotice(n.to, n.id); } catch { prior = null; }
          if (prior === null) { failed.push(n.id); continue; }
          ctx.state.acted[noticeKey(n.id)] = at; ctx.state.acted[noticePriorKey(n.id)] = `${prior}|${n.to}`; done.push({ id: n.id, prior });
        }
        const to = ns[0]!.to; const left = (noticesByTo().get(to) ?? []).length - done.length - failed.length;
        const shown = `${done.slice(0, BOUNCE_IDS_SHOWN).map(d => `#${d.id}`).join(' ')}${done.length > BOUNCE_IDS_SHOWN ? ` 외 ${done.length - BOUNCE_IDS_SHOWN}` : ''}`;
        const line = `${to} 알림 ${done.length}통 닫음(ack done · 회신 불필요)${done.length ? ` ${shown}` : ''}${left > 0 ? ` · 남은 ${left}통은 다음 차례` : ''}${failed.length ? ` · 쓰기 실패 ${failed.length}(${failed.slice(0, 3).map(n => `#${n}`).join(' ')})` : ''}`;
        return { ok: done.length > 0, line, ...(done[0] ? { ref: `msg:${done[0].id}` } : {}),
          ...(done.length ? { after: `closed ${to} ${done.map(d => `${d.id}:${d.prior}`).join(',')}`, undo: `reopen-notice ${done.map(d => d.id).join(',')} — 우편별 ack 를 이전 상태(${[...new Set(done.map(d => d.prior))].join('·')})로 되돌림 · 원본·영수 그대로` } : {}) };
      },
    },
    'reopen-notice': {
      describe: 'close-notice 의 정확한 되돌림 — 닫은 알림의 우편별 ack 를 일지에 적힌 이전 상태로 되돌린다(L0 이 목소리로 부를 때만 · 대상 = 우편 번호, 쉼표로 여럿) · 다시 닫지 않는다',
      run(target, ctx): ActionResult {
        const ids = target.split(',').map(x => Number(x.trim().replace(/^#/u, ''))).filter(n => Number.isSafeInteger(n) && n > 0 && !!ctx.state.acted[noticeKey(n)]);
        if (!ids.length || !deps.reopenNotice) return { ok: false, line: `${target}: 이 감시가 닫은 알림이 아니다` };
        const at = ctx.now.toISOString(); const back: number[] = []; const failed: number[] = [];
        for (const id of ids) {
          const [was, to] = (ctx.state.acted[noticePriorKey(id)] ?? '').split('|');
          const prior: PriorAck = was === 'acked' ? 'acked' : 'none';
          let ok = false;
          try { ok = !!to && deps.reopenNotice(to, id, prior); } catch { ok = false; }
          if (ok) { delete ctx.state.acted[noticeKey(id)]; ctx.state.acted[reopenKey(id)] = at; back.push(id); } else failed.push(id);
        }
        return { ok: back.length > 0, line: `알림 ${back.length}통 다시 엶(ack 이전 상태로)${back.length ? ` ${back.slice(0, BOUNCE_IDS_SHOWN).map(n => `#${n}`).join(' ')}` : ''}${failed.length ? ` · 실패 ${failed.length}` : ''}`, ...(back[0] ? { ref: `msg:${back[0]}` } : {}) };
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
export function liveDeps(stateRoot: string, address: string, storePath?: string): SilenceDeps {
  type MsgMod = typeof import('../../msg/msg-store.js');
  const msgMod = (): MsgMod => require('../../msg/msg-store.js') as MsgMod;
  const withStore = <T>(fn: (s: import('../../msg/msg-store.js').MsgStore) => T): T | null => {
    try {
      const m = msgMod();
      const store = m.openMsgStoreReadOnly(storePath ?? m.defaultMsgStorePath());
      try { return fn(store); } finally { store.close(); }
    } catch { return null; }
  };
  const writable = <T>(fn: (s: import('../../msg/msg-store.js').MsgStore) => T): T => {
    const m = msgMod(); const store = m.openMsgStore(storePath ?? m.defaultMsgStorePath());
    try { return fn(store); } finally { store.close(); }
  };
  /** Every waiting row of the window, page by page (SILENCE-NOTICE-NOT-REQUEST: one 500-row page before the reply filter
   *  made the KPI a page-size artifact) — at most pages_max pages; `cut` remembers a stop with rows left. */
  let cut = false;
  const waiting = (store: import('../../msg/msg-store.js').MsgStore, now: Date, slaMin: number, excludedKinds?: readonly string[]) => {
    const q = { stage: 'ack' as const, postedBefore: new Date(now.getTime() - slaMin * 60_000), postedAfter: new Date(now.getTime() - pn('lookback_h') * 3_600_000), ...(excludedKinds ? { excludedKinds } : {}), limit: pn('page_rows') };
    const out: ReturnType<typeof store.listUnseenRequests> = []; let beforeId: number | undefined; cut = false;
    for (let page = 0; page < pn('pages_max'); page++) {
      const rows = store.listUnseenRequests({ ...q, ...(beforeId === undefined ? {} : { beforeId }) });
      out.push(...rows);
      if (rows.length < q.limit) return out;
      beforeId = rows[rows.length - 1]!.message.id;
    }
    cut = true;
    return out;
  };
  let posting: ((key: string, to: string, body: string, kind?: string) => number | string | null) | null = null;
  return {
    truncated: () => cut,
    overdue: (now, slaMin) => withStore(store => {
      const rows = waiting(store, now, slaMin, passiveStoredKinds()).filter(r => noticeReason({ kind: r.message.kind ?? null, refs: r.message.refs ?? null }) === null);
      const replied = store.db.query('SELECT 1 FROM msg_messages WHERE reply_to = ? AND sender = ? LIMIT 1');
      return rows.filter(r => !replied.get(r.message.id, r.recipient)).map(r => ({ id: r.message.id, from: r.message.from, to: r.recipient,
        ageMin: (now.getTime() - Date.parse(r.message.createdAt)) / 60_000, summary: r.message.body.replace(/\s+/gu, ' ').slice(0, 120),
        at: r.message.createdAt, ...(r.message.kind ? { kind: r.message.kind } : {}),
        cells: (r.message.refs ?? []).filter(x => x.startsWith('cell:')).map(x => x.slice(5)).filter(Boolean) }));
    }),
    notices: (now, slaMin) => withStore(store => waiting(store, now, slaMin).flatMap((r): OpenNotice[] => {
      const reason = noticeReason({ kind: r.message.kind ?? null, refs: r.message.refs ?? null });
      return reason === null ? [] : [{ id: r.message.id, from: r.message.from, to: r.recipient, ageMin: (now.getTime() - Date.parse(r.message.createdAt)) / 60_000, reason }];
    })),
    closeNotice: (to, msgId) => {
      try {
        return writable(store => {
          const prior = store.explicitAck(to, msgId);
          if (prior === 'done') return null; // already closed by someone — nothing to write, nothing to undo
          store.ackMessage(to, msgId, 'done');
          return prior === 'acked' ? 'acked' : 'none';
        });
      } catch { return null; }
    },
    reopenNotice: (to, msgId, prior) => {
      try { return writable(store => store.restoreAck(to, msgId, prior === 'acked' ? 'acked' : null)); } catch { return false; }
    },
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
    ledgerAnswer: (m) => {
      const cl = require('../../release-loop/checklist.js') as typeof import('../../release-loop/checklist.js');
      return ledgerAnswerFrom(m, id => cl.checklistHistory(id));
    },
    settle: (to, msgId, reason, evidence) => {
      try {
        return writable(store => store.recordReceipt({ messageId: msgId, recipient: to, state: 'done', source: 'ledger', reason, evidence }).recorded);
      } catch { return false; }
    },
    ring: (to, msgId) => {
      try { const m = msgMod(); return (require('../../msg/seat-bell.js') as typeof import('../../msg/seat-bell.js')).ringSeatBell(storePath ?? m.defaultMsgStorePath(), to, msgId); } catch { return false; }
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

/** One cell-ledger event (checklistHistory row · only the fields the answer reads). */
export interface CellEvent { readonly at: string; readonly by: string; readonly field: string; readonly from?: unknown; readonly to: unknown }
/** DETECT-TO-ACTION: the ledger's answer to a request that names `cell:<ID>` refs — structured events only, never the body.
 *  · receiver-wrote = the receiver wrote that cell after the mail (claim · block line · evidence · status) — its reply
 *  · cell-closed   = the cell's latest status is green/done — nothing is left to decide
 *  · owner-moved   = after the mail someone else took the cell (claim to another seat, not by the receiver) — the ask is superseded */
export function ledgerAnswerFrom(m: Pick<OverdueMail, 'to' | 'at' | 'cells'>, history: (cell: string) => readonly CellEvent[]): LedgerAnswer | null {
  const since = m.at ? Date.parse(m.at) : NaN;
  if (!m.cells?.length || !Number.isFinite(since)) return null;
  for (const cell of m.cells) {
    const h = history(cell);
    const after = h.filter(e => Date.parse(e.at) > since);
    const mine = after.find(e => e.by === m.to && e.field !== 'move' && e.field !== 'add'); // a release carry-over is not a reply
    if (mine) return { cell, why: 'receiver-wrote', evidence: `cell:${cell} ${mine.field} by ${mine.by} @${mine.at}` };
    const status = [...h].reverse().find(e => e.field === 'status');
    if (status && (status.to === 'green' || status.to === 'done')) return { cell, why: 'cell-closed', evidence: `cell:${cell} status ${String(status.to)} by ${status.by} @${status.at}` };
    const moved = [...after].reverse().find(e => e.field === 'claim' && typeof e.to === 'string' && e.to !== m.to);
    if (moved) return { cell, why: 'owner-moved', evidence: `cell:${cell} claim → ${String(moved.to)} by ${moved.by} @${moved.at}` };
  }
  return null;
}
