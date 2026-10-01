// Non-interactive wizard — drives `runOnboarding` from a fully-
// resolved answer file (no prompts). Used by:
//   - `elanous setup --config <file> --non-interactive`
//   - CI / Docker bootstrap (env var only path)
//   - dotfile re-deploy on a fresh machine
//
// Strategy: build a `WizardIO` whose structured picker and step callbacks
// consult the resolved answers map. Missing keys accept the picker default
// or return an empty string, preserving the wizard's existing fallbacks.

import type { WizardIO } from '../onboarding.js';
import type { ChoiceOption, ChooseOpts, StepSpec } from './io-extended.js';
import {
  loadAnswerFile,
  buildEnvOverrides,
  mergeLayers,
  type AnswerFile,
} from '../expression/config/index.js';

export interface NonInteractiveOptions {
  /** Path to the answer file. Defaults to `defaultAnswerFilePath()`. */
  answerFilePath?: string;
  /** Pre-resolved answer fragment. Overrides `answerFilePath` when
   *  provided — useful for tests. */
  answers?: AnswerFile;
  /** Inject a custom `process.env` for the env-bridge layer. */
  env?: NodeJS.ProcessEnv;
}

interface ResolvedAnswers {
  llm: Record<string, unknown>;
  skills: Record<string, unknown>;
  obsidian: Record<string, unknown>;
  telegram: Record<string, unknown>;
  discord: Record<string, unknown>;
}

type AnswerSection = keyof ResolvedAnswers;

type TrackedAnswer = {
  section: AnswerSection;
  field: string;
  label: string;
};

const TRACKED_ANSWERS: readonly TrackedAnswer[] = [
  { section: 'llm', field: 'provider', label: 'llm.provider' },
  { section: 'llm', field: 'apiKey', label: 'llm.apiKey' },
  { section: 'skills', field: 'activeSet', label: 'skills.activeSet' },
  { section: 'obsidian', field: 'vault', label: 'obsidian.vault' },
  { section: 'telegram', field: 'enabled', label: 'telegram.enabled' },
  { section: 'discord', field: 'enabled', label: 'discord.enabled' },
];

const STEP_SECTIONS: Record<number, AnswerSection> = {
  1: 'llm',
  2: 'skills',
  3: 'obsidian',
  4: 'telegram',
  5: 'discord',
};

/** Build a non-interactive `WizardIO` from the wizard's structured
 *  context. `showStep()` establishes the answer section from the stable
 *  step index, and `choose()` resolves the selected option from the exact
 *  choices that were presented. Prompt text and localized titles are never
 *  used for answer routing. */
export function nonInteractiveIO(opts: NonInteractiveOptions = {}): WizardIO {
  const answers = (opts.answers ?? loadAnswerFile(opts.answerFilePath)) as Record<string, unknown>;
  const envLayer = buildEnvOverrides({ env: opts.env });
  const merged = mergeLayers<Partial<ResolvedAnswers>>([
    { source: 'answer-file', value: answers as Partial<ResolvedAnswers> },
    { source: 'env', value: envLayer as Partial<ResolvedAnswers> },
  ]);

  let section: AnswerSection | undefined;
  let printedCodexSkipGuidance = false;
  const consumed = new Set<string>();

  const peek = (key: string): unknown => {
    if (!section) return undefined;
    const selected = (merged as Record<string, unknown>)[section] as Record<string, unknown> | undefined;
    const value = selected?.[key];
    if (value !== undefined && value !== null) consumed.add(`${section}.${key}`);
    return value;
  };

  const plainAnswer = (field?: string): string => field ? stringifyAnswer(peek(field)) : '';

  const secretAnswer = (field?: string): string => field ? strOr(peek(field), '') : '';

  const print = (_text: string) => {
    // Suppress output in non-interactive mode so CI logs stay quiet.
  };

  const reportUnusedAnswers = () => {
    const unused = TRACKED_ANSWERS
      .filter(({ section: trackedSection, field }) => {
        const selected = merged[trackedSection];
        return selected?.[field] !== undefined && !consumed.has(`${trackedSection}.${field}`);
      })
      .map(({ label }) => label);
    if (unused.length > 0) process.stderr.write(`non-interactive: 쓰이지 않은 답 — ${unused.join(', ')}\n`);
  };

  return {
    ask: async (_prompt, field) => plainAnswer(field),
    askSecret: async (_prompt, field) => secretAnswer(field),
    choose: async <T>(
      _prompt: string,
      choices: ChoiceOption<T>[],
      chooseOpts: ChooseOpts = {},
      stepId?: string,
      pickerId?: string,
    ) => resolveChoice(
      choices,
      chooseOpts,
      stepId,
      pickerId,
      section,
      merged,
      () => printedCodexSkipGuidance,
      () => { printedCodexSkipGuidance = true; },
      (trackedSection, field) => { consumed.add(`${trackedSection}.${field}`); },
      print,
    ),
    showStep: (spec: StepSpec) => {
      section = STEP_SECTIONS[spec.index];
    },
    print,
    nonInteractive: true,
    complete: reportUnusedAnswers,
    close: () => { /* no resources to release */ },
  };
}

function resolveChoice<T>(
  choices: ChoiceOption<T>[],
  opts: ChooseOpts,
  stepId: string | undefined,
  pickerId: string | undefined,
  section: AnswerSection | undefined,
  merged: Partial<ResolvedAnswers>,
  hasPrintedCodexSkipGuidance: () => boolean,
  markCodexSkipGuidancePrinted: () => void,
  markConsumed: (section: AnswerSection, field: string) => void,
  print: (text: string) => void,
): T {
  if (choices.length === 0) throw new Error('nonInteractiveIO.choose: options array must not be empty.');

  if (pickerId === 'codex-auth-mode') {
    if (merged.llm?.apiKey !== undefined) markConsumed('llm', 'apiKey');
    const authMode = strOr(merged.llm?.apiKey, '') ? 'apikey' : 'skip';
    if (authMode === 'skip' && !hasPrintedCodexSkipGuidance()) {
      // Choose ⓐ: use the suppressed WizardIO output to preserve quiet CI; ⓑ would add a report line outside this goal.
      print('  → skipped. Run `elanous codex setup` or `elanous login openai-codex` later.\n');
      markCodexSkipGuidancePrinted();
    }
    return choiceForValue(choices, authMode, opts);
  }

  const answerSection = sectionForPicker(stepId, pickerId, section);
  const field = answerSection === 'llm'
    ? 'provider'
    : answerSection === 'skills'
      ? 'activeSet'
      : answerSection === 'telegram' || answerSection === 'discord'
        ? 'enabled'
        : undefined;
  const configured = answerSection && field ? merged[answerSection]?.[field] : undefined;
  const selected = configured === undefined
    ? undefined
    : choices.find((choice) => choiceValueKey(choice.value) === configured);
  if (answerSection && field && selected) markConsumed(answerSection, field);

  return selected?.value ?? choiceForValue(choices, configured, opts);
}

function choiceForValue<T>(
  choices: ChoiceOption<T>[],
  configured: unknown,
  opts: ChooseOpts,
): T {
  const selected = configured === undefined
    ? undefined
    : choices.find((choice) => {
      const valueKey = choiceValueKey(choice.value);
      return valueKey !== undefined && valueKey === configured;
    });
  if (selected) return selected.value;

  const defaultIndex = Math.min(Math.max(opts.defaultIndex ?? 0, 0), choices.length - 1);
  return choices[defaultIndex]!.value;
}

function sectionForPicker(
  stepId: string | undefined,
  pickerId: string | undefined,
  activeStep: AnswerSection | undefined,
): AnswerSection | undefined {
  if (stepId === 'llm' || pickerId === 'provider') return 'llm';
  if (stepId === 'skills' || pickerId === 'preset') return 'skills';
  return activeStep;
}

function choiceValueKey(value: unknown): unknown {
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const choice = value as { key?: unknown; kind?: unknown; preset?: { key?: unknown } };
  if (typeof choice.key === 'string') return choice.key;
  if (choice.kind === 'preset') return choice.preset?.key;
  return undefined;
}

function stringifyAnswer(value: unknown): string {
  if (Array.isArray(value)) return value.join(',');
  return typeof value === 'number' || typeof value === 'string' ? String(value) : '';
}

function strOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}
