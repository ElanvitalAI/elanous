import type { SkillIndexEntry } from '../skills/index.js';
import { getSkillIndex } from '../skills/index.js';

export type ResearchQuestionWeight = 'light' | 'medium' | 'heavy';
export type ResearchOutputFormat = 'text' | 'table' | 'card' | 'web-article' | 'diagram';
export type ResearchOutputFallbackReason = 'no-matching-skill-in-registry';

export interface ResearchOutputRouteInput {
  question: string;
  synthesizedResult: string;
  weight?: ResearchQuestionWeight;
  axes?: readonly string[];
  skills?: readonly SkillIndexEntry[];
}

export interface ResearchOutputRouteDecision {
  weight: ResearchQuestionWeight;
  weightSource: 'caller' | 'estimated';
  format: ResearchOutputFormat;
  skillCallPlan?: { skill: string; args: string };
  fallbackReason?: ResearchOutputFallbackReason;
  observation: {
    resultChars: number;
    axisCount: number;
    estimatedWeight: ResearchQuestionWeight;
    selectedSkill?: string;
    fallback?: ResearchOutputFallbackReason;
  };
}

const OUTPUT_FORMAT_SIGNALS: Record<Exclude<ResearchOutputFormat, 'text'>, readonly string[]> = {
  table: ['comparison table', 'research table', 'data table', 'tabular report', '비교 표', '조사 표'],
  card: ['knowledge card', 'research card', 'summary card', 'flashcard', '지식 카드', '요약 카드'],
  'web-article': ['web article', 'web publishing', 'html article', 'article publishing', '웹 아티클'],
  diagram: ['diagram', '다이어그램', 'visualization', '시각화', 'chart'],
};

const normalizeMetadata = (value: string): string => value.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

function countAxes(axes: readonly string[] | undefined): number {
  return new Set((axes ?? []).map((axis) => normalizeMetadata(axis)).filter(Boolean)).size;
}

export function estimateResearchQuestionWeight(resultChars: number, axisCount: number): ResearchQuestionWeight {
  if (resultChars >= 4_000 || axisCount >= 4) return 'heavy';
  if (resultChars >= 1_200 || axisCount >= 2) return 'medium';
  return 'light';
}

function chooseFormat(weight: ResearchQuestionWeight, axisCount: number): ResearchOutputFormat {
  if (weight === 'light') return 'text';
  if (weight === 'medium') return axisCount >= 2 ? 'table' : 'card';
  return axisCount >= 4 ? 'diagram' : 'web-article';
}

function skillScore(format: Exclude<ResearchOutputFormat, 'text'>, skill: SkillIndexEntry): number {
  const metadata = normalizeMetadata([
    skill.name,
    skill.category ?? '',
    skill.description,
    ...skill.triggers,
    ...skill.extractedTriggers,
  ].join(' '));
  return OUTPUT_FORMAT_SIGNALS[format].reduce((score, signal) => {
    const normalizedSignal = normalizeMetadata(signal);
    return metadata.includes(normalizedSignal) ? score + normalizedSignal.length : score;
  }, 0);
}

function findOutputSkill(
  format: Exclude<ResearchOutputFormat, 'text'>,
  skills: readonly SkillIndexEntry[],
): SkillIndexEntry | undefined {
  return skills
    .map((skill) => ({ skill, score: skillScore(format, skill) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))[0]?.skill;
}

function buildSkillArgs(question: string, synthesizedResult: string, format: ResearchOutputFormat): string {
  return [
    `Format the synthesized research output as ${format}.`,
    `Question: ${escapeSkillArgument(question)}`,
    'Research synthesis:',
    escapeSkillArgument(synthesizedResult),
  ].join('\n\n');
}

/** Keep untrusted research text from closing the XML-like prefill argument block. */
function escapeSkillArgument(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Deterministic output routing. Weight may be supplied by an upstream axis; otherwise it is inferred from synthesis size and distinct axes. */
export function routeResearchOutput(input: ResearchOutputRouteInput): ResearchOutputRouteDecision {
  const resultChars = input.synthesizedResult.length;
  const axisCount = countAxes(input.axes);
  const estimatedWeight = estimateResearchQuestionWeight(resultChars, axisCount);
  const weight = input.weight ?? estimatedWeight;
  const desiredFormat = chooseFormat(weight, axisCount);
  const observation = { resultChars, axisCount, estimatedWeight };

  if (desiredFormat === 'text') {
    return { weight, weightSource: input.weight ? 'caller' : 'estimated', format: 'text', observation };
  }

  const registry = input.skills ?? getSkillIndex();
  const selected = findOutputSkill(desiredFormat, registry);
  if (!selected) {
    const fallbackReason: ResearchOutputFallbackReason = 'no-matching-skill-in-registry';
    return {
      weight,
      weightSource: input.weight ? 'caller' : 'estimated',
      format: 'text',
      fallbackReason,
      observation: { ...observation, fallback: fallbackReason },
    };
  }

  return {
    weight,
    weightSource: input.weight ? 'caller' : 'estimated',
    format: desiredFormat,
    skillCallPlan: { skill: selected.name, args: buildSkillArgs(input.question, input.synthesizedResult, desiredFormat) },
    observation: { ...observation, selectedSkill: selected.name },
  };
}
