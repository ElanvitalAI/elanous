// ── Scenario LLM tool runtimes — Presentation P5c ──
//
// Surfaces the P5a scenario pipeline to the LLM. Four read/act tools:
//
//   ListScenarios           — enumerate catalog (optionally tag-filtered)
//   RunScenario             — materialize a scenario → WidgetSpec[]
//                             (fires onMount when the dashboard injected
//                             one · else returns a summary dry-run)
//   GetScenarioSchema       — inspect a scenario's shape before editing
//   ValidateScenarioYaml    — parse + materialize inline YAML, return errors
//
// Pattern mirrors `widget-schema-runtime.ts` (P3 GetWidgetSchema): one
// `createXRuntime` factory per tool, an idempotent `register...` entry
// point, and a test-only reset. Deps (catalog getter, mount callback)
// are injected — the module has no direct knowledge of dashboard,
// widget-host, or global catalog instances.
//
// Ownership note (2026-04-20 · PLAN-iul-closure-roadmap.md §0.5):
// Widget-team addition under `src/tool-runtime/`. Single-file scope ·
// no existing tool runtime is modified. Dashboard wiring is deferred
// to a follow-up PR (P5c-a).

import {
  materializeScenario,
  type ScenarioCatalog,
  type ScenarioDef,
} from '../scenarios/index.js';
import { buildWidgetSpec } from '../ui/declarative/index.js';
import type { SurfaceAddress } from '../surface/address.js';
import type {
  DeclarativeWidgetNode,
  ValidationError,
} from '../ui/declarative/index.js';
import { registerToolRuntime } from './registry.js';
import { RUN_SCENARIO_MOUNT_TARGET_KINDS, unsupportedRunScenarioTargetError } from './scenario-target-mount.js';
import type { ToolRuntime } from './types.js';

// ── deps ────────────────────────────────────────────────────────────

export interface ScenarioRuntimeDeps {
  /** Cached catalog getter · dashboard loads once at boot + passes the
   *  accessor · runtime never re-scans disk. Returning `undefined`
   *  (e.g. before load finished) yields an empty-catalog response. */
  readonly getCatalog: () => ScenarioCatalog | undefined;
  /** Optional mount callback for `RunScenario`. When provided, the
   *  runtime hands it the materialized `widgets[]`; when omitted, the
   *  tool acts as a dry-run and only returns a summary. */
  readonly onMount?: (
    widgets: readonly DeclarativeWidgetNode[],
    target?: SurfaceAddress,
  ) => void | ScenarioMountResult;
}

export interface ScenarioMountResult {
  readonly mounted: boolean;
  readonly error?: string;
}

// ── shared helpers ──────────────────────────────────────────────────

type Out = { output: string };

function stringifyOutput(payload: unknown): Out {
  return { output: JSON.stringify(payload) };
}

function summarizeNode(node: DeclarativeWidgetNode): {
  type: string;
  id?: string;
  childCount: number;
} {
  const spec = buildWidgetSpec(node);
  return {
    type: spec.type,
    ...(spec.id ? { id: spec.id } : {}),
    childCount: spec.children?.length ?? 0,
  };
}

function collectWidgetTypes(nodes: readonly DeclarativeWidgetNode[]): string[] {
  const types = new Set<string>();
  const walk = (list: readonly DeclarativeWidgetNode[]): void => {
    for (const node of list) {
      const w = buildWidgetSpec(node);
      types.add(w.type);
      if (w.children && w.children.length > 0) walk(w.children);
    }
  };
  walk(nodes);
  return [...types].sort();
}

function defSummary(def: ScenarioDef): {
  id: string;
  title: string;
  description?: string;
  meta?: Record<string, unknown>;
} {
  return {
    id: def.id,
    title: def.title,
    ...(def.description ? { description: def.description } : {}),
    ...(def.meta ? { meta: def.meta } : {}),
  };
}

function matchesTags(def: ScenarioDef, tags: readonly string[]): boolean {
  if (tags.length === 0) return true;
  const meta = def.meta;
  if (!meta) return false;
  const rawTags = meta.tags;
  if (!Array.isArray(rawTags)) return false;
  const haystack = new Set(rawTags.filter((t): t is string => typeof t === 'string'));
  return tags.every((t) => haystack.has(t));
}

// ── ListScenarios ───────────────────────────────────────────────────

type ListArgs = { tags?: readonly string[] };

export function createListScenariosRuntime(
  deps: ScenarioRuntimeDeps,
): ToolRuntime<ListArgs, Out> {
  return {
    id: 'ui_list_scenarios',
    spec: {
      name: 'ListScenarios',
      description:
        'List every loaded Presentation scenario (id + title + description + meta). Read-only · no side effects. Optional `tags` array filters to scenarios whose `meta.tags` contains every provided tag.',
      parameters: {
        type: 'object',
        properties: {
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tag filter · scenario must contain every listed tag in meta.tags.',
          },
        },
        additionalProperties: false,
      },
    },
    async run(req) {
      const catalog = deps.getCatalog();
      if (!catalog) {
        return stringifyOutput({ scenarios: [], errors: [] });
      }
      const tags = Array.isArray(req?.tags)
        ? (req.tags.filter((t): t is string => typeof t === 'string'))
        : [];
      const scenarios: ReturnType<typeof defSummary>[] = [];
      for (const def of catalog.scenarios.values()) {
        if (matchesTags(def, tags)) scenarios.push(defSummary(def));
      }
      return stringifyOutput({
        scenarios,
        errors: catalog.errors,
      });
    },
  };
}

// ── RunScenario ─────────────────────────────────────────────────────

type RunArgs = { id?: string; lax?: boolean; target?: unknown };

function parseSurfaceAddress(raw: unknown): SurfaceAddress | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  switch (obj.kind) {
    case 'window':
      return typeof obj.windowId === 'number' && Number.isInteger(obj.windowId) && obj.windowId > 0
        ? { kind: 'window', windowId: obj.windowId } : undefined;
    case 'pane': {
      if (!obj.ref || typeof obj.ref !== 'object' || Array.isArray(obj.ref)) return undefined;
      const ref = obj.ref as Record<string, unknown>;
      return typeof ref.windowId === 'string' && typeof ref.paneId === 'string'
        && (ref.runnerLabel === undefined || typeof ref.runnerLabel === 'string')
        ? { kind: 'pane', ref: {
          windowId: ref.windowId,
          paneId: ref.paneId,
          ...(ref.runnerLabel !== undefined ? { runnerLabel: ref.runnerLabel as string } : {}),
        } } : undefined;
    }
    case 'modal':
      return typeof obj.modalId === 'string' ? { kind: 'modal', modalId: obj.modalId } : undefined;
    case 'widget':
      return typeof obj.widgetId === 'string' ? { kind: 'widget', widgetId: obj.widgetId } : undefined;
    case 'popover':
      return typeof obj.popoverId === 'string' ? { kind: 'popover', popoverId: obj.popoverId } : undefined;
    case 'inline':
      return typeof obj.inlineId === 'string' ? { kind: 'inline', inlineId: obj.inlineId } : undefined;
    case 'bg':
      return typeof obj.bgId === 'string' ? { kind: 'bg', bgId: obj.bgId } : undefined;
    case 'input':
      return typeof obj.inputId === 'string' ? { kind: 'input', inputId: obj.inputId } : undefined;
    default:
      return undefined;
  }
}

export function createRunScenarioRuntime(
  deps: ScenarioRuntimeDeps,
): ToolRuntime<RunArgs, Out> {
  return {
    id: 'ui_run_scenario',
    spec: {
      name: 'RunScenario',
      description:
        'Materialize a Presentation scenario by id. When the host has wired a mount callback the widgets are mounted; otherwise returns a summary dry-run. `lax: true` (default) returns partial widgets + errors; `lax: false` requires a clean decode.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Scenario id from the catalog (required).' },
          lax: {
            type: 'boolean',
            description: 'When false, any validation error collapses the result to zero widgets. Default true.',
          },
          target: {
            type: 'object',
            description:
              'Optional SurfaceAddress mount target. Supported mount destinations are '
              + `${RUN_SCENARIO_MOUNT_TARGET_KINDS.join(', ')}. `
              + 'Window/pane targets are not supported. Non-mount surface kinds such as input/popover/inline/bg return explicit unsupported-target errors.',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
    async run(req) {
      const id = typeof req?.id === 'string' ? req.id.trim() : '';
      if (!id) {
        return stringifyOutput({ ok: false, error: 'RunScenario: `id` is required' });
      }
      const catalog = deps.getCatalog();
      if (!catalog) {
        return stringifyOutput({ ok: false, error: 'RunScenario: scenario catalog is not loaded' });
      }
      const def = catalog.scenarios.get(id);
      if (!def) {
        return stringifyOutput({
          ok: false,
          error: `RunScenario: unknown scenario id "${id}"`,
          known: [...catalog.scenarios.keys()],
        });
      }
      const lax = req?.lax ?? true;
      const targetRequested = Object.prototype.hasOwnProperty.call(req ?? {}, 'target');
      const target = targetRequested ? parseSurfaceAddress(req?.target) : undefined;
      if (targetRequested && target === undefined) {
        return stringifyOutput({
          ok: false,
          error: 'RunScenario: malformed `target` SurfaceAddress',
        });
      }
      if (target?.kind === 'window' || target?.kind === 'pane') {
        return stringifyOutput({
          ok: false,
          mounted: false,
          target,
          error: unsupportedRunScenarioTargetError(target),
        });
      }
      const decode = materializeScenario(def, { lax });
      const widgets = decode.widgets;
      let mounted = false;
      let mountError: string | undefined;
      if (decode.ok && deps.onMount) {
        try {
          const result = deps.onMount(widgets, target);
          if (result && typeof result === 'object' && 'mounted' in result) {
            mounted = result.mounted;
            mountError = result.error;
          } else {
            mounted = true;
          }
        } catch (err) {
          return stringifyOutput({
            ok: false,
            error: `RunScenario: mount callback threw: ${(err as Error).message}`,
            widgets: widgets.map(summarizeNode),
            errors: decode.errors,
            ...(target ? { target } : {}),
          });
        }
      } else if (decode.ok && target) {
        mountError = 'RunScenario: host does not support target-aware mounts yet';
      }
      return stringifyOutput({
        ok: decode.ok && mountError === undefined,
        id: def.id,
        title: def.title,
        mounted,
        widgets: widgets.map(summarizeNode),
        errors: decode.errors,
        ...(target ? { target } : {}),
        ...(mountError ? { error: mountError } : {}),
      });
    },
  };
}

// ── GetScenarioSchema ───────────────────────────────────────────────

type GetSchemaArgs = { id?: string };

export function createGetScenarioSchemaRuntime(
  deps: ScenarioRuntimeDeps,
): ToolRuntime<GetSchemaArgs, Out> {
  return {
    id: 'ui_get_scenario_schema',
    spec: {
      name: 'GetScenarioSchema',
      description:
        'Return a scenario definition + the set of widget types it references. Read-only · use before editing a scenario YAML to understand its shape.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Scenario id from the catalog.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
    async run(req) {
      const id = typeof req?.id === 'string' ? req.id.trim() : '';
      if (!id) {
        return stringifyOutput({ found: false, error: 'GetScenarioSchema: `id` is required' });
      }
      const catalog = deps.getCatalog();
      if (!catalog) {
        return stringifyOutput({ found: false, error: 'GetScenarioSchema: scenario catalog is not loaded' });
      }
      const def = catalog.scenarios.get(id);
      if (!def) {
        return stringifyOutput({ found: false, id });
      }
      // Derive widget types by dry-decoding (lax) so we surface only the
      // types that actually appear in the materialized tree. Errors are
      // reported alongside so LLM knows if the scenario is malformed.
      const decode = materializeScenario(def, { lax: true });
      return stringifyOutput({
        found: true,
        def,
        widgetTypes: collectWidgetTypes(decode.widgets),
        errors: decode.errors,
      });
    },
  };
}

// ── ValidateScenarioYaml ────────────────────────────────────────────

type ValidateArgs = { yaml?: string };

interface ValidateResultPayload {
  ok: boolean;
  widgetCount: number;
  errors: readonly ValidationError[];
  parseError?: string;
}

async function parseInlineYaml(
  raw: string,
): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
  try {
    // Dynamic import mirrors catalog.ts · keeps YAML dep lazy so the
    // module is still loadable in environments that stub `yaml`.
    const { parse } = await import('yaml');
    return { ok: true, data: parse(raw) };
  } catch (err) {
    return { ok: false, message: `YAML parse failed: ${(err as Error).message}` };
  }
}

function shapeValidationError(parsed: unknown): ValidationError | null {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { path: '$', message: 'root is not a YAML object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.trim() === '') {
    return { path: '$.id', message: 'missing `id` field (non-empty string required)' };
  }
  if (typeof obj.title !== 'string' || obj.title.trim() === '') {
    return { path: '$.title', message: 'missing `title` field (non-empty string required)' };
  }
  if (!('layout' in obj)) {
    return { path: '$.layout', message: 'missing `layout` field' };
  }
  return null;
}

function toScenarioDef(parsed: Record<string, unknown>): ScenarioDef {
  return {
    id: (parsed.id as string).trim(),
    title: (parsed.title as string).trim(),
    ...(typeof parsed.description === 'string' ? { description: parsed.description } : {}),
    layout: parsed.layout,
    ...(parsed.meta && typeof parsed.meta === 'object' && !Array.isArray(parsed.meta)
      ? { meta: parsed.meta as Record<string, unknown> }
      : {}),
  };
}

export function createValidateScenarioYamlRuntime(): ToolRuntime<ValidateArgs, Out> {
  return {
    id: 'ui_validate_scenario_yaml',
    spec: {
      name: 'ValidateScenarioYaml',
      description:
        'Parse inline YAML as a scenario + run it through the decode pipeline in lax mode. Returns `{ok, widgetCount, errors}` — use in an edit-then-validate loop before writing the YAML to disk.',
      parameters: {
        type: 'object',
        properties: {
          yaml: { type: 'string', description: 'Scenario YAML text (single document).' },
        },
        required: ['yaml'],
        additionalProperties: false,
      },
    },
    async run(req) {
      const raw = typeof req?.yaml === 'string' ? req.yaml : '';
      if (!raw.trim()) {
        const payload: ValidateResultPayload = {
          ok: false,
          widgetCount: 0,
          errors: [{ path: '$', message: 'ValidateScenarioYaml: `yaml` must be a non-empty string' }],
        };
        return stringifyOutput(payload);
      }
      const parsed = await parseInlineYaml(raw);
      if (!parsed.ok) {
        const payload: ValidateResultPayload = {
          ok: false,
          widgetCount: 0,
          errors: [{ path: '$', message: parsed.message }],
          parseError: parsed.message,
        };
        return stringifyOutput(payload);
      }
      const shapeError = shapeValidationError(parsed.data);
      if (shapeError) {
        const payload: ValidateResultPayload = {
          ok: false,
          widgetCount: 0,
          errors: [shapeError],
        };
        return stringifyOutput(payload);
      }
      const def = toScenarioDef(parsed.data as Record<string, unknown>);
      const decode = materializeScenario(def, { lax: true });
      const payload: ValidateResultPayload = {
        ok: decode.errors.length === 0,
        widgetCount: decode.widgets.length,
        errors: decode.errors,
      };
      return stringifyOutput(payload);
    },
  };
}

// ── registration ────────────────────────────────────────────────────

let registered = false;
let registeredDeps: ScenarioRuntimeDeps | null = null;

/** Idempotent registration — dashboard calls once at boot after the
 *  scenario catalog is loaded and (optionally) a mount callback is
 *  available. Re-invocation with the same deps is a no-op; calling
 *  with different deps is rejected (call `__resetScenarioRuntimesForTest`
 *  first to swap). */
export function registerScenarioRuntimes(deps: ScenarioRuntimeDeps): void {
  if (registered) {
    if (registeredDeps !== deps) {
      throw new Error(
        'registerScenarioRuntimes: already registered with different deps '
        + '— call __resetScenarioRuntimesForTest first',
      );
    }
    return;
  }
  registerToolRuntime(createListScenariosRuntime(deps));
  registerToolRuntime(createRunScenarioRuntime(deps));
  registerToolRuntime(createGetScenarioSchemaRuntime(deps));
  registerToolRuntime(createValidateScenarioYamlRuntime());
  registered = true;
  registeredDeps = deps;
}

/** Test-only · resets the local registered flag so the next
 *  `registerScenarioRuntimes` re-installs cleanly. Callers that want
 *  a clean shared registry should also call
 *  `_resetToolRuntimeRegistryForTest` from `./registry.js`. */
export function __resetScenarioRuntimesForTest(): void {
  registered = false;
  registeredDeps = null;
}
