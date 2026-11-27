// 수호자 — voice (LOOP-AGENT §1 ⑤). Same contract as the judge-butler: mail to GUARDIAN / loop:guardian and the els channel
// loop-voice contract ({loop,from,channel,text,refs,messageId} → {text,evidence[],actions[]}) wake ONE call to the configured
// coordinator LLM with soul ⊕ goal ⊕ the live state (host load/ncpu · orphans · route · supply); actions run only through the
// closed L1 set below; outside its rights (paid VM · policy · money) it says so and escalates to OP/RES. Over budget / no LLM →
// a deterministic facts reply. Every turn is a `voice` case.
import { actionToken, parseVoice, type VoiceLlm, type VoiceMessage } from '../judge-butler/voice.js';
import type { ButlerMemory } from '../judge-butler/memory.js';
import { GUARDIAN_DEMOTERS, GUARDIAN_SEAT, GUARDIAN_SUPERVISOR, planGuardian, type GuardianView } from './body.js';
import { ratio } from './hosts.js';

export interface GuardianCommands {
  reap(host: string | null, apply: boolean): string;
  route(): string;
  proposeHands(): string;
  escalate(to: 'OP' | 'RES', why: string, msg: VoiceMessage): string;
  demote(to: string, by: string): string;
}

const RIGHTS = `혼자 할 수 있는 행동(이 JSON 명령만):
- {"cmd":"reap","host":"node-b|minim5|node-c|mbp|mshq|null","apply":true|false} — 만료·고아 시험 우주를 정확한 PID 로 정리(apply=false 는 목록만)
- {"cmd":"route"} — 지금 가장 한가한 로컬 호스트
- {"cmd":"propose-hands"} — 준비 칸 대비 손 늘리기/줄이기 제안(RES 에)
- {"cmd":"escalate","to":"OP|RES","why":"…"} — 유료 VM·정책·돈 = 권한 밖
- {"cmd":"demote","to":"L1|shadow|off|live"} — 보낸 이가 RES·OP·CLAUDE-OP·CEO 일 때만
하지 않는 것: 유료 VM 켜기 · 사람 세션/브라우저 종료 · 패턴 밖 프로세스 종료 · 셸 실행.`;

export function guardianFacts(view: GuardianView, worldText?: string): string {
  const plan = planGuardian(view);
  const hosts = view.probes.map(p => `${p.host} ${p.reachable && p.load1 !== null ? `${p.load1.toFixed(1)}/${p.ncpu} = ${ratio(p).toFixed(2)}` : 'unreachable'}`).join(' · ');
  const orphans = [...plan.reap].map(([h, c]) => `${h} ${c.length}`).join(' · ') || '0';
  return `${worldText ? `${worldText}\n` : ''}호스트 load/ncpu: ${hosts}\n고아·만료 시험 우주(>2h): ${orphans}\n경로(가장 한가한 로컬): ${plan.route.host ?? '없음'} — ${plan.route.why}\n준비 칸 ${view.ready?.total ?? '?'} (P0 ${view.ready?.p0 ?? '?'}) · 유휴 손 ${view.hands?.filter(h => h.state === 'idle').length ?? '?'}${plan.scaleUp ? ` · 손 늘리기 후보 ${plan.scaleUp.hosts.join(',')}` : ''}${plan.paidEscalation ? ` · 유료 VM 판단 필요(OP)` : ''}`;
}

export async function guardianVoiceTurn(msg: VoiceMessage, view: GuardianView, deps: { memory: ButlerMemory; llm: VoiceLlm | null; cmds: GuardianCommands; soulText: string; goalText: string; budgetOk: boolean; worldText?: string }):
  Promise<{ reply: string; refs: string[]; actions: string[]; folded: boolean }> {
  const level = deps.memory.level().level;
  const facts = guardianFacts(view, deps.worldText);
  const refs = [`${msg.channel}:${msg.id}`]; const actions: string[] = [];
  let reply: string; let folded = false; let model: string | null = null;
  if (level === 'off' || level === 'shadow') { reply = `[수호자 · ${level}] 지금은 판단도 행동도 하지 않는다 — RES 에 직접.\n${facts}`; folded = true; }
  else if (level !== 'live' || !deps.llm || !deps.budgetOk) {
    folded = true;
    const why = level !== 'live' ? `수준 ${level}` : !deps.llm ? 'LLM 없음' : '예산 초과';
    reply = `[수호자 · 목소리 접힘: ${why}]\n${facts}\n판단이 필요한 부분은 RES 로 올렸다 — ${deps.cmds.escalate('RES', `수호자 목소리 접힘(${why}) — ${msg.from} #${msg.id}: ${msg.body.slice(0, 160)}`, msg)}`;
    actions.push(actionToken('escalate', 'RES'));
  } else {
    const system = `${deps.soulText.trim()}\n\n## 목표 카드\n${deps.goalText.trim()}\n\n## 권한\n${RIGHTS}\n\n## 답 형식\n오직 JSON: {"reply":"<한국어 · 수호자로서 · 호스트·PID·우편 번호 근거 · 5줄 이하>","actions":[…]}. 사실은 «지금» 절에 있는 것만.`;
    const user = `## 지금 (${view.now.toISOString()})\n${facts}\n\n## 최근 기억\n${deps.memory.cases(10).map(c => `${c.at.slice(5, 16)} ${c.kind} ${c.subject} — ${c.why.slice(0, 100)}`).join('\n') || '없음'}\n\n## 받은 말 (${msg.channel} #${msg.id} · 보낸 이 ${msg.from})\n${msg.body.slice(0, 2_000)}`;
    try {
      const out = await deps.llm.complete(system, user); model = out.model;
      const parsed = parseVoice(out.text); const lines: string[] = [];
      for (const a of parsed.actions.slice(0, 5) as Array<Record<string, unknown>>) {
        const cmd = String(a.cmd);
        if (cmd === 'reap') { lines.push(deps.cmds.reap(typeof a.host === 'string' ? a.host : null, a.apply === true)); actions.push(actionToken(a.apply === true ? 'reap-apply' : 'reap-dry', typeof a.host === 'string' ? a.host : 'all')); }
        else if (cmd === 'route') { lines.push(deps.cmds.route()); actions.push('route'); }
        else if (cmd === 'propose-hands') { lines.push(deps.cmds.proposeHands()); actions.push('propose-hands'); }
        else if (cmd === 'escalate') { const to = String(a.to).toUpperCase() === 'OP' ? 'OP' : 'RES'; lines.push(deps.cmds.escalate(to, String(a.why ?? '판단 요청').slice(0, 300), msg)); actions.push(actionToken('escalate', to)); }
        else if (cmd === 'demote') { lines.push(deps.cmds.demote(String(a.to), msg.from)); actions.push(actionToken('demote', String(a.to))); }
        else { lines.push(`권한 밖 명령 ${cmd.slice(0, 20)} 실행 안 함 → RES: ${deps.cmds.escalate('RES', `권한 밖 명령 ${JSON.stringify(a).slice(0, 100)}`, msg)}`); actions.push(actionToken('refused', cmd), actionToken('escalate', 'RES')); }
      }
      reply = [parsed.reply || '(빈 답)', ...(lines.length ? [`— 행동: ${lines.join(' · ')}`] : [])].join('\n');
    } catch (e) {
      folded = true;
      reply = `[수호자 · 목소리 접힘: LLM 오류 ${(e instanceof Error ? e.message : String(e)).slice(0, 60)}]\n${facts}\n${deps.cmds.escalate('RES', `LLM 오류 — ${msg.from} #${msg.id}`, msg)}`;
      actions.push(actionToken('escalate', 'RES'));
    }
  }
  reply = `${reply}\n— 근거: ${refs.join(' ')} · 수호자(${GUARDIAN_SEAT} · L0 ${GUARDIAN_SUPERVISOR})`;
  deps.memory.appendCase({ at: view.now.toISOString(), kind: 'voice', subject: `${msg.channel}#${msg.id}`, why: reply.slice(0, 400), refs, decidedBy: GUARDIAN_SEAT, supervisedBy: GUARDIAN_SUPERVISOR, extra: { from: msg.from, folded, model, actions } });
  return { reply, refs, actions, folded };
}

export const mayDemoteGuardian = (by: string): boolean => GUARDIAN_DEMOTERS.has(by.trim().toUpperCase());
