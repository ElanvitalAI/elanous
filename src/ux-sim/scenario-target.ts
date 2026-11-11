/** Shared declaration contract for scenario target selection and real-target guards. */

export type ScenarioTarget = 'sim' | 'real';

export interface ScenarioRealBudget {
  readonly llmCalls: number;
  readonly wallClockMs: number;
  readonly externalWrites: number;
}

export interface ScenarioRealGuards {
  readonly allowWrites?: readonly string[];
  readonly budget?: ScenarioRealBudget;
  readonly syntheticMarker?: boolean;
  readonly stopFile?: string;
  readonly targets?: readonly string[];
}

export interface ScenarioTargetDeclaration {
  readonly target?: ScenarioTarget;
  readonly real?: ScenarioRealGuards;
}

export interface ScenarioTargetSelection {
  readonly target: ScenarioTarget;
  readonly source: 'scenario' | 'cli' | 'default';
}

export interface ValidatedScenarioRealGuards {
  readonly allowWrites: readonly string[];
  readonly budget: ScenarioRealBudget;
  readonly syntheticMarker: true;
  readonly stopFile: string;
  readonly targets: readonly string[];
}

const NON_NEGATIVE = 0; // Source: 내부 문서 `sim-scenario-regression-load` §A2 permits zero-use budgets.

export function resolveScenarioTarget(scenarioTarget?: unknown, cliTarget?: unknown): ScenarioTargetSelection {
  const selected = cliTarget === undefined ? scenarioTarget : cliTarget;
  const source = cliTarget !== undefined ? 'cli' : scenarioTarget !== undefined ? 'scenario' : 'default';
  if (selected === undefined) return { target: 'sim', source: 'default' };
  if (selected !== 'sim' && selected !== 'real') throw new Error(`invalid scenario target: ${String(selected)}`);
  return { target: selected, source };
}

export function assertScenarioTargetAllowed(target: ScenarioTarget, testStateRoot?: string | null): void {
  if (target === 'real' && (typeof testStateRoot !== 'string' || testStateRoot.trim() === '')) {
    throw new Error('real scenario target requires an explicit --test universe');
  }
}

export function validateRealScenarioGuards(guards: ScenarioRealGuards | undefined): ValidatedScenarioRealGuards {
  if (!guards || typeof guards !== 'object' || Array.isArray(guards)) {
    throw new Error('real target requires all four safety guard declarations');
  }
  const allowedKeys = ['allowWrites', 'budget', 'syntheticMarker', 'stopFile', 'targets'];
  const unknown = Object.keys(guards).find((key) => !allowedKeys.includes(key));
  if (unknown) throw new Error(`real.${unknown} is not a supported guard`);
  const allowWrites = validateNameList(guards.allowWrites, 'real.allowWrites');
  const targets = validateNameList(guards.targets, 'real.targets');
  const budget = guards.budget;
  if (!isScenarioRealBudget(budget)) {
    throw new Error('real.budget must declare non-negative safe integers for llmCalls, wallClockMs, and externalWrites');
  }
  if (guards.syntheticMarker !== true) throw new Error('real.syntheticMarker must be true');
  if (typeof guards.stopFile !== 'string' || guards.stopFile.trim() === '') {
    throw new Error('real.stopFile must declare a stop-file path');
  }
  return { allowWrites, targets, budget, syntheticMarker: true, stopFile: guards.stopFile };
}

export function assertRealTargetGuards(
  declaration: ScenarioTargetDeclaration,
  cliTarget?: unknown,
): ValidatedScenarioRealGuards | undefined {
  const selection = resolveScenarioTarget(declaration.target, cliTarget);
  return selection.target === 'real' ? validateRealScenarioGuards(declaration.real) : undefined;
}

/** Receipt persistence and diffing only accept JSON-safe values; JSON.stringify must not erase distinctions. */
export function assertScenarioReceiptJsonSafe(value: unknown): void {
  const ancestors = new Set<object>();
  const visit = (current: unknown, path: string): void => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return;
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) throw new Error(`${path} must contain finite JSON numbers other than negative zero`);
      return;
    }
    if (typeof current !== 'object') throw new Error(`${path} must contain only JSON values`);
    if (ancestors.has(current)) throw new Error(`${path} must not contain circular references`);
    ancestors.add(current);
    if (Array.isArray(current)) {
      if (Object.getPrototypeOf(current) !== Array.prototype) throw new Error(`${path} must be a plain JSON array`);
      const names = Object.getOwnPropertyNames(current);
      if (Object.getOwnPropertySymbols(current).length > 0
        || names.length !== current.length + 1
        || names.some((name) => name !== 'length' && (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= current.length))) {
        throw new Error(`${path} must not contain custom array properties`);
      }
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error(`${path}[${index}] must be an enumerable data property`);
        visit(descriptor.value, `${path}[${index}]`);
      }
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must contain plain JSON objects`);
      if (Object.getOwnPropertySymbols(current).length > 0) throw new Error(`${path} must not contain symbol keys`);
      for (const key of Object.getOwnPropertyNames(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error(`${path}.${key} must be an enumerable data property`);
        visit(descriptor.value, `${path}.${key}`);
      }
    }
    ancestors.delete(current);
  };
  visit(value, 'receipt');
}

function isScenarioRealBudget(value: unknown): value is ScenarioRealBudget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const budget = value as Record<string, unknown>;
  const keys = ['llmCalls', 'wallClockMs', 'externalWrites'];
  return Object.keys(budget).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(budget, key)
      && Number.isSafeInteger(budget[key]) && Number(budget[key]) >= NON_NEGATIVE);
}

function validateNameList(value: readonly string[] | undefined, where: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${where} must be a list of non-empty names`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)
      || typeof value[index] !== 'string' || value[index]!.trim() === '') {
      throw new Error(`${where} must be a dense list of non-empty names`);
    }
  }
  if (new Set(value).size !== value.length) throw new Error(`${where} must not contain duplicates`);
  return [...value];
}
