import { PRODUCTION_STEPS, type ProductionStep } from './production-contract.js';

export type StepReadiness =
  | { readonly step: ProductionStep; readonly status: 'wired'; readonly by: string }
  | { readonly step: ProductionStep; readonly status: 'needs-input'; readonly missing: string }
  | { readonly step: ProductionStep; readonly status: 'unwired' };

export interface ProductionReadinessInput {
  readonly dependencies?: Partial<Record<ProductionStep, readonly string[]>>;
  readonly supplied?: readonly string[];
}

export function assessProductionReadiness(input: ProductionReadinessInput = {}): readonly StepReadiness[] {
  const supplied = new Set(input.supplied);

  return PRODUCTION_STEPS.map((step) => {
    if (step === 'expand') return { step, status: 'unwired' };

    const dependencies = input.dependencies?.[step];
    if (!dependencies) return { step, status: 'unwired' };

    const missing = dependencies.find((dependency) => dependency.length === 0 || !supplied.has(dependency));
    if (missing !== undefined) return { step, status: 'needs-input', missing };

    return { step, status: 'wired', by: dependencies.join(', ') };
  });
}
