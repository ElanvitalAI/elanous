// Phase B-1.a · Dashboard slash command registry.
//
// Why this exists: the inline `switch (cmdLower)` block in
// `dashboard/index.ts` (lines 17057-22463 · 102 cases · 5,405 LOC) is
// the largest single concern in the file (per AUDIT-dashboard-phase-b-
// 2026-05-04). This module defines the registry shape that lets cases
// move out one-at-a-time over multiple PRs without breaking the input
// loop's control-flow semantics.
//
// The non-obvious constraint: every case body lives inside the `while`
// input-dispatch loop and may either `continue` (skip the rest of the
// turn) or `return X` (exit `showDashboard()` entirely). Plain
// `(args, ctx) => void` doesn't capture the return path, so handlers
// return a tagged outcome — `void` for the implicit-continue case,
// `{ return: R }` for the exit case.

export type SlashHandlerReturn<R = never> = void | { return: R };

export type SlashHandler<Ctx, R = never> = (
  args: string[],
  ctx: Ctx,
) => SlashHandlerReturn<R> | Promise<SlashHandlerReturn<R>>;

export type SlashDispatchOutcome<R = never> =
  | { kind: 'unregistered' }
  | { kind: 'continue' }
  | { kind: 'return'; value: R };

export interface SlashRegistrationOptions {
  /** Enables a command to run while a chat response is streaming. */
  immediateDuringStream?: boolean;
}

export interface SlashCatalogComparison {
  registeredOnly: string[];
  listedOnly: string[];
  registeredDuplicates: string[];
  listedDuplicates: string[];
  invalidRegistered: string[];
  invalidListed: string[];
}

export interface SlashCatalogBaseline {
  registeredOnly: readonly string[];
  listedOnly: readonly string[];
}

export interface SlashCatalogBaselineCheck extends SlashCatalogComparison {
  newRegisteredOnly: string[];
  newListedOnly: string[];
  violations: string[];
}

function normalizeSlashName(name: string): string {
  return name.trim().toLowerCase();
}

function catalogNames(names: readonly string[]): { names: string[]; duplicates: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const invalid = new Set<string>();
  for (const name of names) {
    const normalized = normalizeSlashName(name);
    if (!normalized) invalid.add(name);
    else if (seen.has(normalized)) duplicates.add(normalized);
    else seen.add(normalized);
  }
  return {
    names: [...seen].sort(),
    duplicates: [...duplicates].sort(),
    invalid: [...invalid].sort(),
  };
}

/** Compares all canonical names and aliases after trim/lowercase normalization. */
export function compareSlashCatalogs(
  registeredNames: readonly string[],
  listedNames: readonly string[],
): SlashCatalogComparison {
  const registered = catalogNames(registeredNames);
  const listed = catalogNames(listedNames);
  const registeredSet = new Set(registered.names);
  const listedSet = new Set(listed.names);
  return {
    registeredOnly: registered.names.filter((name) => !listedSet.has(name)),
    listedOnly: listed.names.filter((name) => !registeredSet.has(name)),
    registeredDuplicates: registered.duplicates,
    listedDuplicates: listed.duplicates,
    invalidRegistered: registered.invalid,
    invalidListed: listed.invalid,
  };
}

/** Reports drift beyond an intentionally recorded two-way difference baseline. */
export function checkSlashCatalogBaseline(
  registeredNames: readonly string[],
  listedNames: readonly string[],
  baseline: SlashCatalogBaseline,
): SlashCatalogBaselineCheck {
  const comparison = compareSlashCatalogs(registeredNames, listedNames);
  const baselineRegistered = new Set(catalogNames(baseline.registeredOnly).names);
  const baselineListed = new Set(catalogNames(baseline.listedOnly).names);
  const newRegisteredOnly = comparison.registeredOnly.filter((name) => !baselineRegistered.has(name));
  const newListedOnly = comparison.listedOnly.filter((name) => !baselineListed.has(name));
  const violations = [
    ...newRegisteredOnly.map((name) => `registered-only: ${name}`),
    ...newListedOnly.map((name) => `listed-only: ${name}`),
    ...comparison.registeredDuplicates.map((name) => `duplicate registered name: ${name}`),
    ...comparison.listedDuplicates.map((name) => `duplicate listed name: ${name}`),
    ...comparison.invalidRegistered.map((name) => `invalid registered name: ${JSON.stringify(name)}`),
    ...comparison.invalidListed.map((name) => `invalid listed name: ${JSON.stringify(name)}`),
  ];
  return { ...comparison, newRegisteredOnly, newListedOnly, violations };
}

export class SlashCommandRegistry<Ctx, R = never> {
  private readonly handlers = new Map<string, SlashHandler<Ctx, R>>();
  private readonly immediateNames = new Set<string>();

  register(
    names: string | readonly string[],
    handler: SlashHandler<Ctx, R>,
    options: SlashRegistrationOptions = {},
  ): void {
    const list = typeof names === 'string' ? [names] : names;
    if (list.length === 0) {
      throw new Error('SlashCommandRegistry.register: at least one name required');
    }
    for (const name of list) {
      if (this.handlers.has(name)) {
        throw new Error(`SlashCommandRegistry: duplicate registration for '${name}'`);
      }
      this.handlers.set(name, handler);
      if (options.immediateDuringStream) this.immediateNames.add(name);
    }
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  /** Ordered runtime registration catalog for diagnostics and regression checks. */
  names(): readonly string[] {
    return [...this.handlers.keys()];
  }

  isImmediateDuringStream(name: string): boolean {
    return this.immediateNames.has(name);
  }

  async dispatch(name: string, args: string[], ctx: Ctx): Promise<SlashDispatchOutcome<R>> {
    const handler = this.handlers.get(name);
    if (!handler) return { kind: 'unregistered' };
    const result = await handler(args, ctx);
    if (result && typeof result === 'object' && 'return' in result) {
      return { kind: 'return', value: result.return };
    }
    return { kind: 'continue' };
  }
}
