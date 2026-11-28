// Land graph voice — deterministic, evidence-first answers about one land plan (CODE-BODY-TO-KIND · was the land steward's
// agent.ts answer): «왜 #N 안 들어가?» · «지금 막힌 것?» · «다음 1시간 몇 건?» · «노하우?». No LLM: every word comes from
// the records. The agent's names come from its own package (soul card · id · L0), never from this file.
import type { LedgerRow, PrInfo, TickResult } from './land-graph.js';
import type { LandMetrics } from './metrics.js';

export interface LandVoiceInput { now: Date; plan: TickResult; prs: readonly PrInfo[]; rows: readonly LedgerRow[]; kpi: LandMetrics; slots: number }
/** The agent answering: package id (card paths) · L0 seat (fallback «who») · soul / knowhow text. */
export interface LandVoiceCards { id: string; l0: string; soulText?: string; knowhowText?: string }

export interface VoiceAnswer { text: string; evidence: string[]; kind: 'why' | 'blocked' | 'next-hour' | 'knowhow' | 'help' }

const fmt = (d: TickResult['decisions'][number]) => `#${d.pr} @${d.head.slice(0, 12)} ${d.action}${d.cls ? ` ${d.cls}` : ''} — ${d.why.slice(0, 140)}${d.next ? ` · 다음: ${d.next.owner} (${d.next.action})` : ''}`;

/** Deterministic, evidence-first answers to the three questions the CEO asks (no LLM: every word comes from the records). */
export function answer(text: string, v: LandVoiceInput, cards: LandVoiceCards): VoiceAnswer {
  const t = text.trim();
  if (/노하우|knowhow|규칙|rule/iu.test(t) && cards.knowhowText) {
    const rows = cards.knowhowText.split('\n').filter(l => /^\| T\d+ \|/u.test(l)).map(l => l.split('|').map(x => x.trim()));
    return { kind: 'knowhow', evidence: [`card:graphs/loop-agents/${cards.id}/knowhow.md`], text: ['기차 매니저 노하우(knowhow.md):', ...rows.map(r => `${r[1]} ${r[2]} → ${r[4]}`)].join('\n') };
  }
  const m = /#(\d{1,7})\b|\b(\d{4,7})\b/u.exec(t); const pr = m?.[1] ?? m?.[2]; // «#12» or a bare 4–7 digit number
  if (pr && /왜|why|안 ?들어|안 ?가|막혀|blocked|stuck|상태/iu.test(t)) {
    const n = Number(pr);
    const d = v.plan.decisions.find(x => x.pr === n);
    const hist = v.rows.filter(r => r.pr === n && !r.synthetic).slice(-4);
    const ev = [`pr:#${n}`, ...hist.map(r => `ledger:${r.at}:${r.event}${r.cls ? `:${r.cls}` : ''}`)];
    if (!d) {
      const p = v.prs.find(x => x.number === n);
      if (!p) {
        const last = hist[hist.length - 1];
        const landed = hist.some(r => r.event === 'landed');
        return { kind: 'why', evidence: ev, text: landed ? `#${n} 은 원장상 착지됨(${hist.find(r => r.event === 'landed')!.at.slice(5, 16)}) — 열린 목록에 없다.`
          : `#${n} 은 열린 PR 목록에 없다 — 상태 미확인(닫힘·병합·없는 번호 중 하나 · gh pr view ${n}).${last ? ` 마지막 기록: ${last.at.slice(5, 16)} ${last.event}${last.cls ? ` ${last.cls}` : ''}` : ''}` };
      }
      return { kind: 'why', evidence: ev, text: `#${n} 은 판단 대상이 아니다: ${p.draft ? 'draft — 작성자가 ready 로 바꾸면 다음 틱에 본다' : 'skip'}` };
    }
    const fin = (v.plan.finisher ?? []).filter(f => f.pr === n).map(f => `마무리꾼 ${f.kind} ${f.state} (${f.why})`);
    return { kind: 'why', evidence: ev, text: [fmt(d), ...fin].join('\n') };
  }
  if (/막힌|막혀|blocked|stuck|지금/iu.test(t)) {
    const non = v.plan.decisions.filter(d => d.action !== 'land');
    if (!non.length) return { kind: 'blocked', evidence: [], text: `막힌 PR 없음 — 준비 ${v.kpi.ready} · 착지 ${v.kpi.landsLastHour}/h` };
    const by = new Map<string, typeof non>();
    for (const d of non) { const k = `${d.next?.owner ?? '주인 없음'} · ${d.cls ?? d.action}`; by.set(k, [...(by.get(k) ?? []), d]); }
    const lines = [...by.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8)
      .map(([k, ds]) => `${k}: ${ds.length} (${ds.slice(0, 6).map(d => `#${d.pr}`).join(' ')})`);
    return { kind: 'blocked', evidence: non.slice(0, 12).map(d => `pr:#${d.pr}`), text: [`막힌 ${non.length} · 준비 ${v.kpi.ready}/${v.kpi.judged}`, ...lines].join('\n') };
  }
  if (/다음 ?1?\s*시간|몇 ?건|next hour|how many|forecast/iu.test(t)) {
    const running = (v.plan.finisher ?? []).filter(f => f.state === 'queued' || f.state === 'running' || f.state === 'resolving' || f.state === 'would-run').length;
    const capacity = Math.max(v.kpi.landsLastHour, v.slots * 3); // a live land ≈ 20 min on the merge result → ≤ 3 per slot per hour
    const est = Math.min(v.kpi.ready + running, capacity);
    return { kind: 'next-hour', evidence: v.plan.decisions.filter(d => d.action === 'land').slice(0, 12).map(d => `pr:#${d.pr}`),
      text: `다음 1시간 예상 ${est}건 = min(준비 ${v.kpi.ready} + 마무리 중 ${running}, 용량 ${capacity} = max(지난 1시간 ${v.kpi.landsLastHour}, 슬롯 ${v.slots}×3))` };
  }
  const soul = (cards.soulText ?? '').split('\n');
  const who = soul.find(l => l.includes('**자리**'))?.replace(/^-\s*\*\*자리\*\*:\s*/u, '') ?? `L0 = ${cards.l0}`;
  const name = soul.find(l => l.includes('**이름**'))?.replace(/^-\s*\*\*이름\*\*:\s*/u, '').split(' (')[0]?.trim() || cards.id;
  return { kind: 'help', evidence: [`card:graphs/loop-agents/${cards.id}/soul.md`], text: `${name}(${who}) — 착지 ${v.kpi.landsLastHour}/h(오늘 ${v.kpi.landsToday}) · 준비 ${v.kpi.ready}/${v.kpi.judged} · 마무리 대기 p50 ${v.kpi.needsFinisherWaitP50Min === null ? '—' : Math.round(v.kpi.needsFinisherWaitP50Min)}분\n묻기: «왜 #N 안 들어가?» · «지금 막힌 것?» · «다음 1시간 몇 건?» · «노하우?»` };
}
