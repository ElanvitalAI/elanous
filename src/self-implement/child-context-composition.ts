import { debug } from '../debug/log.js';

export const SMALL_CHILD_CONTEXT_TOKEN_BUDGET = 32_000;

export const CHILD_CONTEXT_COMPONENT_NAMES = [
  'systemPrompt',
  'agentsMd',
  'claudeMd',
  'toolSchemas',
  'goal',
  'ledger',
] as const;

export type ChildContextComponentName = typeof CHILD_CONTEXT_COMPONENT_NAMES[number];
export type ChildContextProfile = 'default' | 'small';

export interface ChildContextComponents {
  readonly systemPrompt?: string;
  readonly agentsMd?: string;
  readonly claudeMd?: string;
  readonly toolSchemas?: string;
  readonly goal?: string;
  readonly ledger?: string;
}

export interface ChildContextComponentMeasurement {
  readonly inputBytes: number;
  readonly includedBytes: number;
  readonly truncated: boolean;
}

export interface ChildContextComposition {
  readonly text: string;
  readonly profile: ChildContextProfile;
  readonly budgetTokens: number | null;
  /** UTF-8 bytes are a conservative upper bound on tokenizer tokens. */
  readonly tokenUpperBound: number;
  readonly components: Readonly<Record<ChildContextComponentName, ChildContextComponentMeasurement>>;
}

export interface ComposeChildContextOptions {
  readonly profile?: ChildContextProfile;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}

const JOINER = '\n\n';

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function prefixWithinUtf8Budget(value: string, byteBudget: number): string {
  if (byteBudget <= 0) return '';
  let included = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8Bytes(character);
    if (bytes + characterBytes > byteBudget) break;
    included += character;
    bytes += characterBytes;
  }
  return included;
}

function emptyMeasurements(): Record<ChildContextComponentName, ChildContextComponentMeasurement> {
  return {
    systemPrompt: { inputBytes: 0, includedBytes: 0, truncated: false },
    agentsMd: { inputBytes: 0, includedBytes: 0, truncated: false },
    claudeMd: { inputBytes: 0, includedBytes: 0, truncated: false },
    toolSchemas: { inputBytes: 0, includedBytes: 0, truncated: false },
    goal: { inputBytes: 0, includedBytes: 0, truncated: false },
    ledger: { inputBytes: 0, includedBytes: 0, truncated: false },
  };
}

function emitCompositionEvent(
  log: ((event: string, data: Record<string, unknown>) => void) | undefined,
  data: Record<string, unknown>,
): void {
  try {
    if (log) log('child.context-composition', data);
    else debug.log('self-implement', 'child.context-composition', data);
  } catch {
    // Context composition must not fail because an observation sink is unavailable.
  }
}

/**
 * Composes the implementation child's first-turn context and records the byte
 * contribution of every input component. The small profile spends its hard cap
 * on executable context first and trims repository instruction files last.
 */
export function composeChildContext(
  components: ChildContextComponents,
  options: ComposeChildContextOptions = {},
): ChildContextComposition {
  const profile = options.profile ?? 'default';
  const budgetBytes = profile === 'small' ? SMALL_CHILD_CONTEXT_TOKEN_BUDGET : null;
  const measurements = emptyMeasurements();
  const included: Partial<Record<ChildContextComponentName, string>> = {};
  const order: readonly ChildContextComponentName[] = profile === 'small'
    ? ['systemPrompt', 'toolSchemas', 'goal', 'ledger', 'agentsMd', 'claudeMd']
    : CHILD_CONTEXT_COMPONENT_NAMES;
  let usedBytes = 0;
  let includedCount = 0;

  for (const name of order) {
    const value = components[name] ?? '';
    const inputBytes = utf8Bytes(value);
    const separatorBytes = includedCount > 0 && value.length > 0 ? utf8Bytes(JOINER) : 0;
    const availableBytes = budgetBytes === null ? Number.POSITIVE_INFINITY : Math.max(0, budgetBytes - usedBytes - separatorBytes);
    const includedValue = inputBytes <= availableBytes ? value : prefixWithinUtf8Budget(value, availableBytes);
    const includedBytes = utf8Bytes(includedValue);
    measurements[name] = { inputBytes, includedBytes, truncated: includedBytes < inputBytes };
    if (includedValue.length === 0) continue;
    included[name] = includedValue;
    usedBytes += separatorBytes + includedBytes;
    includedCount += 1;
  }

  const text = CHILD_CONTEXT_COMPONENT_NAMES
    .flatMap((name) => included[name] === undefined ? [] : [included[name]!])
    .join(JOINER);
  const tokenUpperBound = utf8Bytes(text);
  const result: ChildContextComposition = {
    text,
    profile,
    budgetTokens: budgetBytes === null ? null : SMALL_CHILD_CONTEXT_TOKEN_BUDGET,
    tokenUpperBound,
    components: measurements,
  };
  emitCompositionEvent(options.log, {
    profile,
    budgetTokens: result.budgetTokens,
    tokenUpperBound,
    components: measurements,
  });
  return result;
}
