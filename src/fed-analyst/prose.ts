// FED-ANALYST-LOOP-AGENT — the ONE LLM node: the facts sentence of each of the six lines rephrased as one Korean sentence
// (cheap tier · role `classify` · one call per window). The numbers stay the deterministic ones: a prose line that carries a
// number the facts line does not is dropped (that line keeps its template), so the LLM can reword but never renumber.
// No LLM configured / the call fails / malformed JSON → every line keeps its template (fail-open · recorded in the row).
import type { Analysis, FindingKey } from './analyze.js';
import type { VoiceLlm } from '../loop-agent/role-llm.js';

export const PROSE_SITE = 'loop-agent:fed-analyst';

const NUM_RE = /\d+(?:\.\d+)?/gu;
/** Every number in `prose` must appear in `facts` (as a token). */
export function numbersPreserved(facts: string, prose: string): boolean {
  const have = new Set(facts.match(NUM_RE) ?? []);
  return (prose.match(NUM_RE) ?? []).every(n => have.has(n));
}

export function prosePrompt(a: Analysis): { system: string; user: string } {
  return {
    system: [
      '너는 연방 분석관(loop:fed-analyst)이다. 아래 여섯 줄은 결정적으로 계산된 숫자 줄이다.',
      '각 줄을 OP 가 3초에 읽을 한국어 한 문장으로 바꿔라. 규칙: 숫자는 원문에 있는 것만 그대로 쓴다(새 숫자·반올림·합계 금지) · 원인 추측 금지 · 존댓말 없이 «~다» 체.',
      '[breach] 줄은 문제를 문제로 말한다 — «없다/정상» 같은 부정·안심 표현으로 바꾸지 않는다. [ok] 줄은 짧게 «기준 안» 이라고 말한다.',
      '출력은 JSON 한 줄: {"hands":"…","loops":"…","throughput":"…","board":"…","mail-path":"…","op-topology":"…"}',
    ].join('\n'),
    user: a.findings.map(f => `${f.key}: [${f.status}] ${f.title} — ${f.facts}`).join('\n'),
  };
}

export async function proseLines(a: Analysis, llm: VoiceLlm | null): Promise<{ prose: Partial<Record<FindingKey, string>>; model: string | null; used: boolean; why: string }> {
  if (!llm) return { prose: {}, model: null, used: false, why: 'no classify-role LLM' };
  try {
    const { system, user } = prosePrompt(a);
    const r = await llm.complete(system, user);
    const m = /\{[\s\S]*\}/u.exec(r.text);
    if (!m) return { prose: {}, model: r.model, used: false, why: 'no JSON in reply' };
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const prose: Partial<Record<FindingKey, string>> = {};
    let dropped = 0;
    for (const f of a.findings) {
      const v = j[f.key];
      if (typeof v !== 'string' || !v.trim()) continue;
      const line = v.trim().replace(/\s+/gu, ' ').slice(0, 300);
      // a breach must not read as «fine» (the 11-28 dry run: «멈춘 루프는 없고 … 예외는 release-traffic»)
      const reassures = f.status === 'breach' && /없[고다음]|정상(이다|입니다)|문제 ?없/u.test(line) && !/없/u.test(f.facts);
      if (numbersPreserved(f.facts, line) && !reassures) prose[f.key] = line; else dropped += 1;
    }
    return { prose, model: r.model, used: Object.keys(prose).length > 0, why: dropped ? `${dropped} line(s) dropped — a number not in the facts, or a breach worded as fine` : 'ok' };
  } catch (e) {
    return { prose: {}, model: null, used: false, why: `LLM failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}` };
  }
}

/** The live cheap-tier LLM (role `classify` · same router as the ✋ classifier). */
export function liveProseLlm(): VoiceLlm | null {
  try {
    const { roleLlm } = require('../loop-agent/role-llm.js') as typeof import('../loop-agent/role-llm.js');
    return roleLlm('classify', { maxTokens: 700, site: PROSE_SITE, timeoutMs: 60_000 });
  } catch { return null; }
}
