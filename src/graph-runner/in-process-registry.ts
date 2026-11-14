import type { GraphEvent } from './graph-events.js';

/** A run-scoped registry keeps in-process graph effects out of YAML and shell recipes. */
export interface InProcessHandlerContext {
  readonly graphId: string;
  readonly runId: string;
  readonly nodeId: string;
  /** Authenticated owner supplied by the execution host, never copied from graph input. */
  readonly verifiedOwnerId?: string;
  /** Node-scoped resolved secret values; never copied into graph input or ledger output. */
  readonly secrets?: Readonly<Record<string, string>>;
  /** Contract identifiers lowered from graph-v2 node requires. */
  readonly requires?: `${string}.${string}@${number}`;
  readonly input: unknown;
  /** Original run input retained when `input` is narrowed to a capability request. */
  readonly graphInput?: unknown;
  /** Optional node-scoped payload used by dynamically appended repair steps. */
  readonly nodeInput?: unknown;
  readonly outputs: Readonly<Record<string, unknown>>;
  /** Providers may stop work when a contract execution deadline is reached. */
  readonly signal?: AbortSignal;
  /** A code node may publish only the event kinds declared in its YAML `emits` allowlist. */
  readonly emitEvent?: (type: string, data?: Readonly<Record<string, unknown>>) => Promise<GraphEvent>;
}

export interface InProcessHandlerResult {
  readonly ok: boolean;
  /** Named edge outcome from the graph's declared map. */
  readonly outcome: string;
  /** Data passed to downstream `result.*` references; evidence remains audit metadata. */
  readonly result?: unknown;
  readonly evidence?: Readonly<Record<string, unknown>>;
  /** Execute-unit compensation plan. Only declared `undo` outputs reach the run ledger. */
  readonly undo?: unknown;
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
