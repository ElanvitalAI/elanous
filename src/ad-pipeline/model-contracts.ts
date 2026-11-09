import { isRecord } from '../primitives/guards.js';
import type { DurationRule, ReferenceDelivery } from './shoot-plan.js';

export interface MeasuredModelContracts {
  readonly durationRules: Readonly<Record<string, DurationRule>>;
  readonly creditsPerSecond: Readonly<Record<string, number>>;
  readonly referenceDelivery: Readonly<Record<string, ReferenceDelivery>>;
  /** Models named in the file's _unknown section; callers must not fill these silently. */
  readonly unknown: readonly string[];
}

type ParseError = { readonly error: string };

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

interface UnknownDeclarations {
  readonly models: readonly string[];
  readonly axes: ReadonlySet<string>;
}

type JsonRecord = Readonly<Record<string, unknown>>;

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function positiveNumber(value: unknown): number | undefined {
  return isPositiveNumber(value) ? value : undefined;
}

function durationRule(value: unknown): DurationRule | undefined {
  if (!isRecord(value)) return undefined;
  if (isPositiveNumber(value.minimumSeconds)) return { minimumSeconds: value.minimumSeconds };
  if (Array.isArray(value.allowedSeconds) && value.allowedSeconds.length > 0 && value.allowedSeconds.every(isPositiveNumber)) {
    return { allowedSeconds: value.allowedSeconds };
  }
  return undefined;
}

function referenceDelivery(value: unknown): ReferenceDelivery | undefined {
  if (!isRecord(value) || (value.kind !== 'repeated' && value.kind !== 'single') || typeof value.flag !== 'string' || value.flag.trim() === '') {
    return undefined;
  }
  return { kind: value.kind, flag: value.flag };
}

function contractEntries<T>(
  value: unknown,
  axis: string,
  unknownAxes: ReadonlySet<string>,
  parse: (candidate: unknown) => T | undefined,
): ParseResult<Record<string, T>> {
  if (!isRecord(value)) return { ok: false, error: 'expected a contract axis object' };
  const contracts: Record<string, T> = Object.create(null);
  for (const [model, candidate] of Object.entries(value)) {
    if (!model.startsWith('_') && !unknownAxes.has(`${model}.${axis}`)) {
      const parsed = parse(candidate);
      if (parsed !== undefined) contracts[model] = parsed;
    }
  }
  return { ok: true, value: contracts };
}

function unknownDeclarations(value: unknown): ParseResult<UnknownDeclarations> {
  if (value === undefined) return { ok: true, value: { models: [], axes: new Set() } };
  if (!isRecord(value)) return { ok: false, error: 'expected _unknown to be an object' };
  const entries = Object.keys(value).filter((entry) => !entry.startsWith('_'));
  return {
    ok: true,
    value: {
      models: [...new Set(entries.map((entry) => entry.split('.', 1)[0]).filter((model) => model.length > 0))],
      axes: new Set(entries.filter((entry) => entry.includes('.'))),
    },
  };
}

export function parseMeasuredModelContracts(json: string): MeasuredModelContracts | ParseError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : 'invalid JSON';
    return { error: `invalid measured model contracts JSON: ${reason}` };
  }
  if (!isRecord(parsed)) return { error: 'expected measured model contracts to be an object' };

  const unknown = unknownDeclarations(parsed._unknown);
  if (!unknown.ok) return { error: unknown.error };
  const durationRules = contractEntries(parsed.durationRules, 'durationRules', unknown.value.axes, durationRule);
  if (!durationRules.ok) return { error: `invalid durationRules: ${durationRules.error}` };
  const creditsPerSecond = contractEntries(parsed.creditsPerSecond, 'creditsPerSecond', unknown.value.axes, positiveNumber);
  if (!creditsPerSecond.ok) return { error: `invalid creditsPerSecond: ${creditsPerSecond.error}` };
  const referenceDeliveryContracts = contractEntries(parsed.referenceDelivery, 'referenceDelivery', unknown.value.axes, referenceDelivery);
  if (!referenceDeliveryContracts.ok) return { error: `invalid referenceDelivery: ${referenceDeliveryContracts.error}` };

  return {
    durationRules: durationRules.value,
    creditsPerSecond: creditsPerSecond.value,
    referenceDelivery: referenceDeliveryContracts.value,
    unknown: unknown.value.models,
  };
}
