export type DeepBloomTrigger = 'research-intent' | 'deep-question' | 'high-reasoning-effort';

export type DeepBloomDecision =
  | { apply: true; reason: DeepBloomTrigger }
  | { apply: false; reason: 'lightweight' | 'no-deep-signal' };

export type DeepBloomInstruction = Extract<DeepBloomDecision, { apply: true }> & {
  levels: readonly [4, 5];
  questionCount: 3 | 4 | 5;
  prompt?: string;
  exemplarDomain?: string;
  exemplarLevels?: number[];
};

const LIGHTWEIGHT_TEXT = /^(?:hi|hello|hey|thanks|thank you|good morning|good night|안녕(?:하세요)?|고마워(?:요)?|감사합니다|잘 자(?:요)?)[.!?\s]*$/iu;
const LIGHTWEIGHT_FACT = /^(?:what(?:'s| is)\s+(?:the\s+)?(?:capital|time|date|meaning|definition)\b.*|who is\b.*|where is\b.*|몇 시(?:야|인가요)?|오늘 날짜(?:는|가)?|\S+의 뜻(?:은|이)?)[?？.!\s]*$/iu;
const LIGHTWEIGHT_COMMAND = /^(?:please\s+)?(?:open|show|list|translate|convert|print|set|turn on|turn off)\b|^(?:열어(?:줘|주세요)|보여(?:줘|주세요)|나열해(?:줘|주세요)|번역해(?:줘|주세요)|계산해(?:줘|주세요)|켜(?:줘|주세요)|꺼(?:줘|주세요))\s*$/iu;
const DEEP_QUESTION = /\b(?:analy[sz]e|analysis|evaluate|evaluation|compare|comparison|outlook|forecast|cause|causes|why|impact|trade-?offs?|pros and cons|design|strategy|scenario|counterargument|assess|judge)\b|분석|평가|비교|전망|예측|원인|영향|장단점|설계|전략|시나리오|반박|판단|어떻게 봐야|왜\b/iu;

/** Lightweight turns have precedence so effort settings never inflate greetings, simple facts, or direct commands. */
export function selectDeepBloom(
  request: string | undefined,
  options: { researchIntent?: boolean; reasoningEffort?: string } = {},
): DeepBloomDecision {
  const text = request?.trim() ?? '';
  if (!text || LIGHTWEIGHT_TEXT.test(text) || LIGHTWEIGHT_FACT.test(text) || LIGHTWEIGHT_COMMAND.test(text))
    return { apply: false, reason: 'lightweight' };
  if (options.researchIntent) return { apply: true, reason: 'research-intent' };
  if (options.reasoningEffort && ['high', 'xhigh', 'max'].includes(options.reasoningEffort))
    return { apply: true, reason: 'high-reasoning-effort' };
  if (DEEP_QUESTION.test(text)) return { apply: true, reason: 'deep-question' };
  return { apply: false, reason: 'no-deep-signal' };
}

/** Build a hidden same-call analysis/evaluation instruction with the existing KGS Bloom cells and exemplar bank. */
export async function buildDeepBloomInstruction(
  request: string,
  trigger: DeepBloomTrigger,
): Promise<DeepBloomInstruction> {
  const [{ BLOOM_2D_SCOPED }, { getBloomExemplarContext }] = await Promise.all([
    import('../knowledge/kgs/types.js'), import('../research/bloom-exemplars.js'),
  ]);
  const analyze = BLOOM_2D_SCOPED.find((cell) => cell.cognitive === 'analyze')!;
  const evaluate = BLOOM_2D_SCOPED.find((cell) => cell.cognitive === 'evaluate')!;
  const exemplar = getBloomExemplarContext(request);
  const prompt = [
    'Before answering, silently ask yourself 3–5 short questions and answer them from the available context.',
    `Analysis focus (${analyze.cognitive}/${analyze.knowledge}): break the subject into components, relationships, and causal mechanisms.`,
    `Evaluation focus (${evaluate.cognitive}/${evaluate.knowledge}): set explicit criteria, compare alternatives or claims, and test at least one counterargument.`,
    'Use those answers to produce a clear conclusion. Do not expose these internal labels or a checklist unless the user asks for the reasoning process.',
    exemplar.context,
  ].filter(Boolean).join('\n\n');
  return { apply: true, reason: trigger, levels: [4, 5], questionCount: 4,
    prompt, exemplarDomain: exemplar.domain, exemplarLevels: exemplar.levels };
}

/** Ensure the existing research ladder gives levels 4 and 5 distinct analysis/evaluation work. */
export async function buildResearchBloom45Directive(): Promise<string> {
  const { BLOOM_2D_SCOPED } = await import('../knowledge/kgs/types.js');
  const analyze = BLOOM_2D_SCOPED.find((cell) => cell.cognitive === 'analyze')!;
  const evaluate = BLOOM_2D_SCOPED.find((cell) => cell.cognitive === 'evaluate')!;
  return [
    `For Bloom level 4 (${analyze.cognitive}/${analyze.knowledge}), ask about components, relationships, and causal mechanisms.`,
    `For Bloom level 5 (${evaluate.cognitive}/${evaluate.knowledge}), ask for criteria-based judgment across alternatives and a counterargument.`,
    'Keep both questions request-specific and ensure each has search terms; do not duplicate level 3 or level 6 work.',
  ].join('\n');
}
