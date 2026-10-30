import {
  buildSelfDevDecomposePrompt,
  decomposeSelfDevGoal,
  type SelfDevDecomposeLlm,
  type SelfDevDecomposition,
} from '../../src/self-dev/decompose.js';
import { positiveInteger, wilsonInterval, type WilsonInterval } from './nl-routing-measurement.js';

export type DecomposeArm = 'control' | 'treatment';
export type DecomposeOutcome = SelfDevDecomposition['decomposition']['outcome'];

export interface DecomposeCorpusItem {
  id: string;
  feature: string;
  /** Requests that must remain one piece in both arms. */
  negativeControl?: boolean;
}

export interface PromptReplacement {
  anchor: string;
  replacement: string;
}

export interface DecomposeAbConfig {
  corpus: readonly DecomposeCorpusItem[];
  repeats: number;
  maxTasks?: number;
  treatment: PromptReplacement;
}

export interface DecomposeMeasurement {
  actualTaskCount: number;
  dependencyEdges: number;
  outcome: DecomposeOutcome;
  recommendedMaxTasks: number;
  exceededRecommendedMax: boolean;
  truncatedAtHardMax: boolean;
  dependenciesValid: boolean;
}

interface DecomposeAbAttempt {
  id: string;
  repeat: number;
  arm: DecomposeArm;
  /** Exact prompt delivered by this arm's injected LLM seam; empty when the runner failed before calling it. */
  prompt: string;
}

interface DecomposeAbObservedRecord extends DecomposeAbAttempt {
  measurement: DecomposeMeasurement;
  error?: string;
}

interface DecomposeAbUnmeasuredRecord extends DecomposeAbAttempt {
  measurement?: never;
  error: string;
  unmeasuredReason: 'runner-exception';
}

/** A runner exception is an attempted but unmeasured slot, not an LLM outcome. */
export type DecomposeAbRecord = DecomposeAbObservedRecord | DecomposeAbUnmeasuredRecord;

export interface DecomposeAbPair {
  id: string;
  repeat: number;
  control: DecomposeAbObservedRecord;
  treatment: DecomposeAbObservedRecord;
}

export interface DecomposeAbSummary {
  expectedRecords: number;
  records: number;
  observedRecords: number;
  unmeasuredRecords: number;
  pairs: DecomposeAbPair[];
  incompletePairs: Array<{ id: string; repeat: number; unmeasuredArms: DecomposeArm[] }>;
  byArm: Record<DecomposeArm, {
    expectedRecords: number;
    records: number;
    observedRecords: number;
    unmeasuredRecords: number;
    decomposed: number;
    decompositionRate: { passes: number; runs: number; wilson: WilsonInterval | null };
    multiTaskRate: { passes: number; runs: number; wilson: WilsonInterval | null };
    outcomes: Record<DecomposeOutcome, number>;
    meanTaskCount: number;
    meanDependencyEdges: number;
    exceededRecommendedMax: number;
    truncatedAtHardMax: number;
    invalidDependencies: number;
  }>;
  negativeControls: Array<{ id: string; repeat: number; controlTaskCount: number; treatmentTaskCount: number; overSplit: boolean }>;
  rounds: Array<{ repeat: number; controlDecomposed: number; treatmentDecomposed: number; pairs: number }>;
}

export type DecomposeAbRunner = (feature: string, opts: { llm: SelfDevDecomposeLlm; maxTasks?: number }) => Promise<SelfDevDecomposition>;

export function applyPromptReplacement(prompt: string, replacement: PromptReplacement): string {
  if (!replacement.anchor) throw new Error('treatment anchor must not be empty');
  const occurrences = prompt.split(replacement.anchor).length - 1;
  if (occurrences === 0) throw new Error(`treatment anchor was not found: ${replacement.anchor}`);
  if (occurrences !== 1) throw new Error(`treatment anchor must occur exactly once; found ${occurrences}`);
  return prompt.replace(replacement.anchor, replacement.replacement);
}

export function assertDecomposeAbConfig(config: DecomposeAbConfig): void {
  if (!Array.isArray(config.corpus) || config.corpus.length === 0) throw new Error('corpus must contain at least one item');
  positiveInteger(String(config.repeats), 'repeats', 1);
  const ids = new Set<string>();
  for (const item of config.corpus) {
    if (!item.id.trim() || !item.feature.trim()) throw new Error('each corpus item requires non-empty id and feature');
    if (ids.has(item.id)) throw new Error(`corpus id must be unique: ${item.id}`);
    ids.add(item.id);
  }
  if (config.maxTasks !== undefined) positiveInteger(String(config.maxTasks), 'maxTasks', 1);
  for (const item of config.corpus) {
    try {
      applyPromptReplacement(buildSelfDevDecomposePrompt(item.feature, config.maxTasks), config.treatment);
    } catch (error) {
      throw new Error(`invalid treatment prompt for corpus item ${item.id}: ${String((error as Error).message ?? error)}`);
    }
  }
}

export function normalizeDecomposition(result: SelfDevDecomposition): DecomposeMeasurement {
  const ids = new Set(result.goals.map((goal) => goal.id ?? ''));
  const dependencies = result.goals.flatMap((goal) => goal.dependsOn ?? []);
  return {
    actualTaskCount: result.decomposition.actualTaskCount,
    dependencyEdges: dependencies.length,
    outcome: result.decomposition.outcome,
    recommendedMaxTasks: result.decomposition.recommendedMaxTasks,
    exceededRecommendedMax: result.decomposition.exceededRecommendedMax,
    truncatedAtHardMax: result.decomposition.truncatedAtHardMax,
    dependenciesValid: dependencies.every((dependency) => ids.has(dependency)),
  };
}

function observedRecord(result: SelfDevDecomposition, id: string, repeat: number, arm: DecomposeArm, prompt: string): DecomposeAbObservedRecord {
  return { id, repeat, arm, prompt, measurement: normalizeDecomposition(result), ...(result.decomposition.error ? { error: result.decomposition.error } : {}) };
}

function unmeasuredRecord(id: string, repeat: number, arm: DecomposeArm, prompt: string, error: unknown): DecomposeAbUnmeasuredRecord {
  return { id, repeat, arm, prompt, error: String((error as { message?: unknown })?.message ?? error), unmeasuredReason: 'runner-exception' };
}

function isObserved(record: DecomposeAbRecord | undefined): record is DecomposeAbObservedRecord {
  return record?.measurement !== undefined;
}

async function runArm(
  item: DecomposeCorpusItem,
  repeat: number,
  arm: DecomposeArm,
  config: DecomposeAbConfig,
  llm: SelfDevDecomposeLlm,
  runner: DecomposeAbRunner,
): Promise<DecomposeAbRecord> {
  let deliveredPrompt = '';
  const seam: SelfDevDecomposeLlm = async (prompt) => {
    const delivered = arm === 'treatment' ? applyPromptReplacement(prompt, config.treatment) : prompt;
    deliveredPrompt = delivered;
    return llm(delivered);
  };
  try {
    const result = await runner(item.feature, { llm: seam, ...(config.maxTasks === undefined ? {} : { maxTasks: config.maxTasks }) });
    return observedRecord(result, item.id, repeat, arm, deliveredPrompt);
  } catch (error) {
    return unmeasuredRecord(item.id, repeat, arm, deliveredPrompt, error);
  }
}

/** Runs both arms through the same injected LLM seam; it never permits the default LLM path. */
export async function runDecomposeAb(
  config: DecomposeAbConfig,
  llm: SelfDevDecomposeLlm | undefined,
  runner: DecomposeAbRunner = decomposeSelfDevGoal,
): Promise<DecomposeAbRecord[]> {
  assertDecomposeAbConfig(config);
  if (!llm) throw new Error('both A/B arms require the same injected llm seam');
  const records: DecomposeAbRecord[] = [];
  for (let repeat = 0; repeat < config.repeats; repeat += 1) {
    for (const item of config.corpus) {
      records.push(await runArm(item, repeat, 'control', config, llm, runner));
      records.push(await runArm(item, repeat, 'treatment', config, llm, runner));
    }
  }
  return records;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function armSummary(records: readonly DecomposeAbRecord[], expectedRecords: number): DecomposeAbSummary['byArm'][DecomposeArm] {
  const observed = records.filter(isObserved);
  const decomposed = observed.filter((record) => record.measurement.outcome === 'decomposed').length;
  const multiTask = observed.filter((record) => record.measurement.actualTaskCount >= 2).length;
  // ⛔ `Record<DecomposeOutcome, number>` 를 유지한다 — 타입이 늘면 여기가 «빨강으로» 알려 준다.
  //   as 로 우회하면 새 결말이 조용히 0 으로 세어져 A/B 가 거짓을 낸다.
  const outcomes: Record<DecomposeOutcome, number> = {
    decomposed: 0,
    'single-no-subtasks': 0,
    'missing-research-context': 0,
    'grounding-empty': 0,
    'authored-empty': 0,
    'slice-rejected': 0,
    'llm-failed': 0,
  };
  for (const record of observed) outcomes[record.measurement.outcome] += 1;
  return {
    expectedRecords,
    records: records.length,
    observedRecords: observed.length,
    unmeasuredRecords: records.length - observed.length,
    decomposed,
    decompositionRate: { passes: decomposed, runs: observed.length, wilson: wilsonInterval(decomposed, observed.length) },
    multiTaskRate: { passes: multiTask, runs: observed.length, wilson: wilsonInterval(multiTask, observed.length) },
    outcomes,
    meanTaskCount: mean(observed.map((record) => record.measurement.actualTaskCount)),
    meanDependencyEdges: mean(observed.map((record) => record.measurement.dependencyEdges)),
    exceededRecommendedMax: observed.filter((record) => record.measurement.exceededRecommendedMax).length,
    truncatedAtHardMax: observed.filter((record) => record.measurement.truncatedAtHardMax).length,
    invalidDependencies: observed.filter((record) => !record.measurement.dependenciesValid).length,
  };
}

export function summarizeDecomposeAb(config: DecomposeAbConfig, records: readonly DecomposeAbRecord[]): DecomposeAbSummary {
  assertDecomposeAbConfig(config);
  const expectedPerArm = config.corpus.length * config.repeats;
  const expectedRecords = expectedPerArm * 2;
  const recordByKey = new Map(records.map((record) => [`${record.id}:${record.repeat}:${record.arm}`, record]));
  const pairs: DecomposeAbPair[] = [];
  const incompletePairs: DecomposeAbSummary['incompletePairs'] = [];
  const negativeControls: DecomposeAbSummary['negativeControls'] = [];
  const rounds: DecomposeAbSummary['rounds'] = [];
  for (let repeat = 0; repeat < config.repeats; repeat += 1) {
    let controlDecomposed = 0;
    let treatmentDecomposed = 0;
    let completePairs = 0;
    for (const item of config.corpus) {
      const control = recordByKey.get(`${item.id}:${repeat}:control`);
      const treatment = recordByKey.get(`${item.id}:${repeat}:treatment`);
      if (!isObserved(control) || !isObserved(treatment)) {
        const unmeasuredArms: DecomposeArm[] = [];
        if (!isObserved(control)) unmeasuredArms.push('control');
        if (!isObserved(treatment)) unmeasuredArms.push('treatment');
        incompletePairs.push({ id: item.id, repeat, unmeasuredArms });
        continue;
      }
      pairs.push({ id: item.id, repeat, control, treatment });
      completePairs += 1;
      if (control.measurement.outcome === 'decomposed') controlDecomposed += 1;
      if (treatment.measurement.outcome === 'decomposed') treatmentDecomposed += 1;
      if (item.negativeControl) negativeControls.push({
        id: item.id,
        repeat,
        controlTaskCount: control.measurement.actualTaskCount,
        treatmentTaskCount: treatment.measurement.actualTaskCount,
        overSplit: control.measurement.actualTaskCount > 1 || treatment.measurement.actualTaskCount > 1,
      });
    }
    rounds.push({ repeat, controlDecomposed, treatmentDecomposed, pairs: completePairs });
  }
  const observedRecords = records.filter(isObserved).length;
  return {
    expectedRecords,
    records: records.length,
    observedRecords,
    unmeasuredRecords: records.length - observedRecords,
    pairs,
    incompletePairs,
    byArm: {
      control: armSummary(records.filter((record) => record.arm === 'control'), expectedPerArm),
      treatment: armSummary(records.filter((record) => record.arm === 'treatment'), expectedPerArm),
    },
    negativeControls,
    rounds,
  };
}
