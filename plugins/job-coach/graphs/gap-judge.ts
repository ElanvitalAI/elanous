export type GapUnit = { code: string; name: string; definition: string; level: string; elements: { name: string; criteria: string }[] };
export type GapVerdict = { code: string; name: string; status: '보유' | '부분' | '갭'; quote: string };

type Judge = (prompt: string) => Promise<string>;
export const MAX_GAP_PROMPT_CHARS = 12000;

export function gapPrompt(units: GapUnit[], interview: string): string {
  return [
    '인터뷰 원문과 공식 NCS 능력단위의 능력단위요소·수행준거·수준을 대조한다.',
    '각 단위별 보유(수행준거를 충족하는 구체적 경험), 부분(일부만 입증), 갭(근거 없음) 중 하나를 판정한다.',
    '단위 이름·보유 역량 목록만으로 보유를 추정하지 말고 원문에서 정확한 한 문장을 quote로 그대로 인용한다.',
    '반드시 JSON 객체 {"gaps":[{"code":"...","status":"보유|부분|갭","quote":"..."}]}만 출력한다. 모든 code를 각각 한 번씩 포함한다.',
    'NCS 단위:', JSON.stringify(units), '인터뷰 원문:', interview,
  ].join('\n');
}

function completeSentence(interview: string, quote: string): boolean {
  if (!quote || /[\r\n]/.test(quote) || !/[.!?。！？]$/.test(quote) || /[.!?。！？]\s*\S/.test(quote.slice(0, -1))) return false;
  let from = 0;
  while (true) {
    const index = interview.indexOf(quote, from);
    if (index < 0) return false;
    const before = interview.slice(0, index);
    if (/(?:^|[.!?。！？]|\n)[ \t]*(?:[-*][ \t]+)?$/.test(before) && !/[\p{L}\p{N}]/u.test(interview[index + quote.length] ?? '')) return true;
    from = index + 1;
  }
}

export async function judgeGaps(units: GapUnit[], interview: string, judge: Judge): Promise<GapVerdict[]> {
  const prompt = gapPrompt(units, interview);
  if (prompt.length > MAX_GAP_PROMPT_CHARS) throw new Error('gap prompt exceeds input limit; interview or NCS detail is too long');
  const answer = await judge(prompt);
  let parsed: unknown;
  try { parsed = JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()); } catch { parsed = {}; }
  const rows = (parsed && typeof parsed === 'object' && 'gaps' in parsed && Array.isArray(parsed.gaps)) ? parsed.gaps : [];
  return units.map(unit => {
    const matches = rows.filter(row => row && typeof row === 'object' && row.code === unit.code);
    const row = matches.length === 1 ? matches[0] as { status?: unknown; quote?: unknown } : {};
    const quote = typeof row.quote === 'string' ? row.quote.trim() : '';
    const isSentence = completeSentence(interview, quote);
    const status = isSentence && (row.status === '보유' || row.status === '부분') ? row.status : '갭';
    return { code: unit.code, name: unit.name, status, quote: isSentence ? quote : '' };
  });
}
