// 판정 집사 — v3 smartness on its HOLD-narrowing mail (LOOP-AGENT-V3-SMART · 대표 11-27 12:5x).
// S/C: the butler mails a HOLD owner «narrow this» and, 30 min later, the judge — every time, to the same owners, whether
//      or not they ever act. Measured 11-27: receivers acted on 0 of the loop agents' mails.
// A: agent.yaml (graphs/loop-agents/judge-butler) declares reflect · plan · learn-knowhow and three actions for one proposal
//    (mail the owner · go to the L0 at once · fold into the digest). The wrapper below is the only touch on the body: the
//    body's `post` port, for `propose:` keys only. Security-4, L0 escalations, ✋ answers and the digest pass through untouched.
// 세 얼굴: 관측 = WakeResult.smart (choices · lessons · resolved) · <home>/v3/ / 판단 근거 = agent.yaml policies ⊕ actions ⊕
//          lessons / 수복과 인계 = fail-open (any error → the plain post) · an escalate-l0 goes to the L0 by org duty.
import { lintAgentDir } from '../loop-agent/v3/agent-yaml.js';
import { beginSmart, fileSmartStore, type ActionRow, type Choice, type KnowhowSink, type OutcomePort, type Router, type SmartConfig, type SmartSession, smartConfig } from '../loop-agent/v3/smart.js';
import { join } from 'node:path';
import type { ButlerPorts, ButlerView } from './body.js';
import { cardsDir } from './cards.js';

export const PROPOSE_INTENT = 'propose-narrow';

/** The butler's v3 config from its agent.yaml (null = absent or refused → plain v2 behaviour · errors for the status line). */
export function loadButlerSmart(dir = cardsDir()): { cfg: SmartConfig | null; errors: string[] } {
  const r = lintAgentDir(dir, { triggersDir: join(dir, '..', '..', 'triggers') });
  if (!r.present) return { cfg: null, errors: [] };
  return r.compiled ? { cfg: smartConfig(r.compiled), errors: [] } : { cfg: null, errors: r.errors };
}

/** Outcome of a proposal from the world itself: the HOLD was narrowed / lifted / expired since → acted · unchanged → not. */
export function holdOutcome(view: ButlerView): OutcomePort {
  return (row: ActionRow) => {
    const m = /^propose:([^:]+):(\d+)/u.exec(row.key);
    if (!m) return null;
    const h = view.holds.find(x => x.id === m[1]);
    if (!h || h.state !== 'active' || h.narrowed > Number(m[2]) || Date.parse(h.expiresAt) <= view.now.getTime()) return true;
    return false;
  };
}

export interface ButlerSmartInput {
  readonly cfg: SmartConfig;
  readonly l0: string;
  readonly router?: Router | null;
  /** Extra outcome evidence (live: the mail was acked / replied) — consulted before the HOLD state. */
  readonly mailOutcome?: OutcomePort;
  readonly knowhow?: KnowhowSink | null;
}
export interface ButlerSmartReport { choices: Array<{ key: string; to: string; action: string; why: string; judgedBy: Choice['judgedBy']; fallback?: string }>; lessons: number; created: string[]; promoted: string[]; resolved: { acted: number; unacted: number } }

/** Open the session and wrap `post` (propose: keys only). Lessons' receivers get their LLM-judged choice up front (async). */
export async function smartButlerPorts(view: ButlerView, ports: ButlerPorts, s: ButlerSmartInput, frozenHands: number): Promise<{ ports: ButlerPorts; session: SmartSession; report: ButlerSmartReport } | null> {
  let session: SmartSession;
  try {
    const holds = holdOutcome(view);
    const outcome: OutcomePort = row => { const m = s.mailOutcome?.(row) ?? null; return m === true ? true : holds(row); };
    session = beginSmart({ cfg: s.cfg, store: fileSmartStore(ports.memory.root), now: view.now, l0: s.l0, outcome, knowhow: s.knowhow ?? null,
      readings: [{ name: 'frozen_hands', value: frozenHands }] });
  } catch { return null; }
  const pre = new Map<string, Choice>();
  for (const l of session.lessons) {
    if (l.status !== 'active' || l.intent !== PROPOSE_INTENT || pre.has(l.to)) continue;
    try { pre.set(l.to, await session.chooseJudged({ intent: PROPOSE_INTENT, to: l.to, kpis: ['frozen_hands'] }, s.router ?? null, `frozen hands ${frozenHands}`)); } catch { /* deterministic below */ }
  }
  const report: ButlerSmartReport = { choices: [], lessons: session.lessons.filter(l => l.status === 'active').length, created: session.learned.created, promoted: session.learned.promoted, resolved: session.reflection.resolved };
  const post: ButlerPorts['post'] = (key, to, body, kind) => {
    if (!key.startsWith('propose:')) return ports.post(key, to, body, kind);
    let ch: Choice;
    try { ch = pre.get(to) ?? session.choose({ intent: PROPOSE_INTENT, to, kpis: ['frozen_hands'] }); } catch { return ports.post(key, to, body, kind); }
    const row = { intent: PROPOSE_INTENT, key, kpi: 'frozen_hands', base: frozenHands };
    report.choices.push({ key, to: ch.to, action: ch.action, why: ch.why, judgedBy: ch.judgedBy, ...(ch.fallback ? { fallback: ch.fallback } : {}) });
    if (ch.action === 'fold-digest') { session.record({ ...row, action: ch.action, to: 'none' }); return null; }
    if (ch.action === 'escalate-l0') {
      const id = ports.post(`${key}:v3-l0`, ch.to, `[판정 집사 → ${ch.to} · v3 직행] ${to} 는 HOLD 좁히기 제안에 반응이 없었다(${ch.why}) — 주인을 거치지 않고 바로 판단 요청. ${body}`, kind);
      session.record({ ...row, action: ch.action, to: ch.to, ...(id ? { ref: `msg:${id}` } : {}) });
      return id;
    }
    const id = ports.post(key, to, body, kind);
    session.record({ ...row, action: 'mail', to, ...(id ? { ref: `msg:${id}` } : {}) });
    return id;
  };
  return { ports: { ...ports, post }, session, report };
}
