export type AllowanceDecision =
  | { readonly kind: 'run'; readonly requested: number; readonly granted: number; readonly clamped: boolean }
  | { readonly kind: 'needs-human'; readonly requested: number; readonly remaining: 0 };

/** Resolve a child allowance against the parent's remaining steps before spawning the child. */
export function resolveChildAllowance(requested: number, parentRemaining: number): AllowanceDecision {
  if (!Number.isSafeInteger(requested) || requested < 1) throw new Error('requested allowance must be a positive safe integer');
  if (!(parentRemaining === Infinity || (Number.isSafeInteger(parentRemaining) && parentRemaining >= 0)))
    throw new Error('parent remaining allowance must be a non-negative safe integer or Infinity');
  if (parentRemaining === 0) return { kind: 'needs-human', requested, remaining: 0 };
  const granted = Math.min(requested, parentRemaining);
  return { kind: 'run', requested, granted, clamped: granted < requested };
}
