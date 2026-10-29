/** A run-scoped registry keeps in-process graph effects out of YAML and shell recipes. */
export interface InProcessHandlerContext {
  readonly graphId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly input: unknown;
  readonly outputs: Readonly<Record<string, unknown>>;
}

export interface InProcessHandlerResult {
  readonly ok: boolean;
  /** Named edge outcome from the graph's declared map. */
  readonly outcome: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

export type InProcessHandler = (context: InProcessHandlerContext) =>
  InProcessHandlerResult | Promise<InProcessHandlerResult>;

export type InProcessHandlerRegistry = Readonly<Record<string, InProcessHandler>>;

function inProcessHandlerName(recipe: string): string | undefined {
  if (!recipe.startsWith('handler:')) return undefined;
  const name = recipe.slice('handler:'.length);
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`invalid in-process handler recipe: ${recipe}`);
  return name;
}

export function requireInProcessHandler(recipe: string, nodeId: string,
  registry: InProcessHandlerRegistry | undefined): InProcessHandler | undefined {
  const name = inProcessHandlerName(recipe);
  if (name === undefined) return undefined;
  const handler = registry && Object.hasOwn(registry, name) ? registry[name] : undefined;
  if (typeof handler !== 'function') throw new Error(`unknown in-process handler for ${nodeId}: ${name}`);
  return handler;
}
