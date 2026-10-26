import { streamLLM } from '../llm.js';
import { invokeResearchAxes } from '../research-bridge/index.js';
import type { AxisFanoutResult } from '../research/axis-fanout.js';
import { attachResearchEvidence, buildResearchQuestionLadderPrompt,
  parseSixLevelResearchQuestionLadder, type ResearchEvidenceEnvelope,
  type SixLevelResearchQuestionLadder } from './question-ladder-contract.js';

export interface ResearchQuestionLadderRunOptions {
  generate?: (prompt: string) => Promise<string>;
  invokeAxes?: (questions: SixLevelResearchQuestionLadder['questions']) => Promise<AxisFanoutResult>;
}

export interface ResearchGroundingResult {
  ok: boolean;
  output: string;
}

export interface ResearchQuestionLadderRunResult {
  ok: boolean;
  ladder: SixLevelResearchQuestionLadder;
  output: string;
  error?: string;
}

/** Generate Bloom axes, search each axis natively, and attach its source evidence. */
export async function runResearchQuestionLadder(
  request: string,
  options: ResearchQuestionLadderRunOptions = {},
): Promise<ResearchQuestionLadderRunResult> {
  const initial: SixLevelResearchQuestionLadder = { request, questions: [], evidence: [] };
  let raw: string;
  try {
    raw = await (options.generate ?? defaultGenerate)(buildResearchQuestionLadderPrompt(request));
  } catch (error) {
    return { ok: false, ladder: initial, output: '', error: `question generation failed: ${errorText(error)}` };
  }

  let generated: unknown;
  try {
    generated = JSON.parse(extractJson(raw));
  } catch (error) {
    return { ok: false, ladder: initial, output: '', error: `question generation returned invalid JSON: ${errorText(error)}` };
  }
  const parsed = parseSixLevelResearchQuestionLadder(withRequest(generated, request));
  if (!parsed.ok) return { ok: false, ladder: initial, output: '', error: parsed.reason };

  const ladder = parsed.value;
  const observedAt = new Date().toISOString();
  let fanout: AxisFanoutResult;
  try {
    fanout = await (options.invokeAxes ?? invokeResearchAxes)(ladder.questions);
  } catch (error) {
    fanout = {
      plan: [],
      axes: ladder.questions.map((question) => ({ questionId: question.id, error: errorText(error), evidence: [{
        questionId: question.id, sourceKind: 'search-query', source: question.searchTerms[0] ?? question.id,
        ...(question.requestedWindow ? { requestedWindow: question.requestedWindow } : {}),
        observedAt, content: errorText(error), outcome: 'failed', truncated: false,
      }] })),
    };
  }

  let allOk = true;
  const sections: string[] = [`# Research: ${request}`, ''];
  const byQuestion = new Map(fanout.axes.map((axis) => [axis.questionId, axis]));
  for (const question of ladder.questions) {
    const axis = byQuestion.get(question.id);
    const axisEvidence = axis?.evidence ?? [];
    const envelopes: ResearchEvidenceEnvelope[] = axisEvidence.length ? axisEvidence : [{
      questionId: question.id, sourceKind: 'search-query', source: question.searchTerms[0] ?? question.id,
      ...(question.requestedWindow ? { requestedWindow: question.requestedWindow } : {}),
      observedAt, content: axis?.error ?? 'axis evidence missing', outcome: 'failed', truncated: false,
    }];
    const snippets: string[] = [];
    for (const envelope of envelopes) {
      const attached = attachResearchEvidence(ladder, envelope);
      if (!attached.ok) {
        allOk = false;
        snippets.push(`Evidence rejected: ${attached.reason}`);
        continue;
      }
      ladder.evidence = attached.value.evidence;
      if (envelope.outcome !== 'complete') allOk = false;
      snippets.push(`- [${envelope.outcome}] ${envelope.sourceKind} · ${envelope.source}: ${envelope.content}`);
    }
    sections.push(`## ${question.id} · Bloom ${question.level}: ${question.prompt}`,
      `Search terms: ${question.searchTerms.join(', ')}`,
      ...snippets);
  }

  const incompleteQuestions = ladder.questions.filter((question) => {
    const evidence = ladder.evidence.filter((item) => item.questionId === question.id);
    return evidence.length === 0 || evidence.some((item) => item.outcome !== 'complete');
  }).length;
  return {
    ok: allOk,
    ladder,
    output: sections.join('\n\n'),
    ...(allOk ? {} : { error: `${incompleteQuestions} of ${ladder.questions.length} question searches were incomplete` }),
  };
}

/** Preserve usable partial findings when the grounding seam has only an ok/output contract. */
export function researchTurnForGrounding(result: ResearchQuestionLadderRunResult): ResearchGroundingResult {
  const output = result.output.trim() || result.error || 'Research question ladder failed.';
  return {
    ok: result.ladder.evidence.some((item) => item.outcome === 'complete') && result.output.trim().length > 0,
    output,
  };
}

async function defaultGenerate(prompt: string): Promise<string> {
  return streamLLM([{ role: 'user', content: prompt }], () => {}, {
    usageSite: 'research-question-ladder',
    usagePhase: 'research',
  });
}

function withRequest(value: unknown, request: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return { ...(value as Record<string, unknown>), request };
}

function extractJson(raw: string): string {
  const unfenced = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object found');
  return unfenced.slice(start, end + 1);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
