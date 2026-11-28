// 수호자 서브 — detector ladders on kit/case-ledger (GUARDIAN-SUBS · DETECT-TO-ACTION · 대표 11-27 «1. 본다 2. 문제가 있을 경우
// 정상화를 한다» · «보기만 하고 액션이 없으면 완료가 안 된다»).
//
// S: the seven subs saw things (dead supervisors · overloaded hosts · orphans · low fuel · stale keys) and acted or mailed,
//    but nothing said what «normal» is, which steps are tried in what order and when it stops being the guardian's job.
// C: a seen problem had no case: it could stay «seen» forever, or be mailed every window, and the «미정상화 사건» KPI did not
//    count the guardian's own subjects.
// A: every detector of a sub (graphs/loop-agents/guardian/agent.yaml subs[].detectors · normal · normalize · escalate ·
//    out_of_policy) runs through ONE reconcile per spawn: each subject the sub looked at is either normal (an open case on it
//    is resolved — only an observation closes a case) or not (a case is opened, the sub's own normalize step it ran this
//    spawn is recorded as `acting`). Escalation is the last resort: out of policy → at once · the SLA since detection passed
//    → one card to `to` (owner | l0 | seat). A sub whose own code already sends the card (reattach · fuel ≥ 90 % · stale key ·
//    exposure) only reports it (`escalated`) — the ladder never sends a second one.
//
// 세 얼굴: 관측 = `<stateRoot>/cases/guardian-<sub>.jsonl` (kit/case-ledger · counted by the guardian KPI «미정상화 사건») /
//          판단 근거 = the detector (agent.yaml) ⊕ the case history (attempts · detectedAt) / 수복과 인계 = the sub's normalize
//          step (existing guardian code) · one deduped card per case (key = case id ⊕ detectedAt) · fail-open (a ledger write
//          that fails returns null — the next spawn sees the same subject again).
import { attemptsOf, moveCase, openCase, readCases, type Case } from '../kit/case-ledger/index.js';
import type { AgentSubDetector } from '../loop-agent/v3/agent-yaml.js';

export const caseDomain = (sub: string): string => `guardian-${sub}`;
/** Same step on the same case within this window = the same attempt (ledger hygiene · not a policy: no behaviour hangs on it). */
const ACT_ROW_MIN = 10; // not-policy: ledger-row dedupe window (no behaviour hangs on it) · 출처: the 임대관 re-spawns on host-overload every event_respawn_min (2) — one row per ~5 spawns
export const caseId = (detector: string, subject: string): string => `${detector}:${subject}`;

export interface DetectorObs {
  readonly subject: string;
  /** true = the detector's normal state holds for this subject now */
  readonly normal: boolean;
  /** what the sub sees (one line) */
  readonly why: string;
  /** the subject's owner seat (escalate.to = owner) */
  readonly owner?: string | null;
  /** the normalize step the sub ran on this subject this spawn (an action id) and its result */
  readonly acted?: { readonly action: string; readonly ok: boolean; readonly line: string } | null;
  /** the sub's own code sent the escalation card this spawn (mail ref) */
  readonly escalated?: string | null;
}
export interface LadderPorts {
  readonly stateRoot: string;
  readonly now: Date;
  /** the agent's L0 seat now (escalate.to = l0) */
  readonly l0: string;
  readonly by: string;
  post(key: string, to: string, body: string): number | null;
}
export interface LadderResult { opened: string[]; acting: string[]; resolved: string[]; escalated: string[]; cards: number[] }

const target = (to: string, owner: string | null | undefined, l0: string): string => (to === 'owner' ? (owner || l0) : to === 'l0' ? l0 : to);

/**
 * One reconcile of one detector over what the sub just observed.
 * `complete` = `obs` covers every subject the detector can see (a case whose subject is gone is resolved) · `ownCard` = the
 * sub's own code sends the escalation card (the ladder only records it, never mails).
 */
export function reconcileDetector(i: { sub: { id: string; name: string }; det: AgentSubDetector; obs: readonly DetectorObs[]; ports: LadderPorts; complete?: boolean; ownCard?: boolean }): LadderResult {
  const { sub, det, ports } = i; const { stateRoot, now } = ports;
  const out: LadderResult = { opened: [], acting: [], resolved: [], escalated: [], cards: [] };
  if (det.by) return out; // executed by another loop agent (its own policies · its own case domain)
  const domain = caseDomain(sub.id);
  const mine = new Map<string, Case>(readCases(stateRoot, domain).filter(c => c.id.startsWith(`${det.id}:`)).map(c => [c.id, c] as const));
  const seen = new Set<string>();
  for (const o of i.obs) {
    const id = caseId(det.id, o.subject); seen.add(id);
    const cur = mine.get(id);
    if (o.normal) {
      if (cur && cur.state !== 'resolved' && moveCase(stateRoot, domain, id, 'resolved', { by: ports.by, why: `정상 관측: ${o.why}`.slice(0, 300) }, now)) out.resolved.push(id);
      continue;
    }
    const to = target(det.escalate?.to ?? 'l0', o.owner, ports.l0);
    const slaMin = det.escalate?.slaMin ?? 60;
    const c = openCase(stateRoot, { domain, id, subject: o.subject, owner: to, slaMin, by: ports.by, why: `${det.id}: ${o.why}`.slice(0, 300) }, now);
    if (!c) continue;
    if (!cur || cur.state === 'resolved') out.opened.push(id);
    if (c.state === 'escalated') continue; // the owner's now — it resolves when the normal state is observed again
    if (o.escalated) {
      if (moveCase(stateRoot, domain, id, 'escalated', { by: ports.by, why: `${det.outOfPolicy ? `정책 밖(${det.outOfPolicy.slice(0, 120)})` : '서브가 올림'} · ${o.escalated}`.slice(0, 300), refs: [o.escalated] }, now)) out.escalated.push(id);
      continue;
    }
    let cs: Case = c;
    // one `acting` row per step per ACT_ROW_MIN (a route rewritten every 2-min event spawn is one attempt, not thirty)
    const recent = (a: string) => c.history.some(h => h.state === 'acting' && h.why.startsWith(a) && now.getTime() - Date.parse(h.at) < ACT_ROW_MIN * 60_000);
    if (o.acted && det.normalize.includes(o.acted.action) && !recent(o.acted.action)) {
      const m = moveCase(stateRoot, domain, id, 'acting', { by: ports.by, why: `${o.acted.action}${o.acted.ok ? '' : ' 실패'}: ${o.acted.line}`.slice(0, 300) }, now);
      if (m) { cs = m; out.acting.push(id); }
    }
    if (!det.escalate || i.ownCard) continue;
    const overdue = now.getTime() - Date.parse(cs.detectedAt) >= slaMin * 60_000;
    if (!det.outOfPolicy && !overdue) continue;
    const why = det.outOfPolicy ? `정책 밖 — ${det.outOfPolicy}` : `${slaMin}분 안에 정상으로 돌아오지 않음`;
    const body = `[수호자·${sub.name} → ${to} · 사건 ${id}] ${why}. 정상: ${det.normal} · 지금: ${o.why} · 사다리 ${det.normalize.join(' → ') || '없음(정책 안 수리 없음)'} ${attemptsOf(cs)}회 시도. 판단 부탁 — 정상이 다시 보이면 사건은 저절로 닫힌다(eln loop guardian status · cases/${domain}).`;
    const ref = ports.post(`guardian-case:${domain}:${id}:${cs.detectedAt}`, to, body);
    if (ref === null) continue; // mail not written — the next spawn tries again
    if (ref) out.cards.push(ref);
    if (moveCase(stateRoot, domain, id, 'escalated', { by: ports.by, why: `${why} → ${to}${ref ? ` msg:${ref}` : ''}`.slice(0, 300), ...(ref ? { refs: [`msg:${ref}`] } : {}) }, now)) out.escalated.push(id);
  }
  if (i.complete !== false) for (const [id, c] of mine) if (!seen.has(id) && c.state !== 'resolved') {
    if (moveCase(stateRoot, domain, id, 'resolved', { by: ports.by, why: '대상이 더 이상 보이지 않음(사라짐 = 정상)' }, now)) out.resolved.push(id);
  }
  return out;
}

/** Fold of every ladder result of one pulse (the pulse report ⊕ the KPI line). */
export function mergeLadder(rows: readonly LadderResult[]): LadderResult {
  return { opened: rows.flatMap(r => r.opened), acting: rows.flatMap(r => r.acting), resolved: rows.flatMap(r => r.resolved), escalated: rows.flatMap(r => r.escalated), cards: rows.flatMap(r => r.cards) };
}
