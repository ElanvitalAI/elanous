// ── Presentation P5c · scenario LLM tool runtimes ──

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  createListScenariosRuntime,
  createRunScenarioRuntime,
  createGetScenarioSchemaRuntime,
  createValidateScenarioYamlRuntime,
  registerScenarioRuntimes,
  __resetScenarioRuntimesForTest,
  type ScenarioRuntimeDeps,
} from '../../src/tool-runtime/scenario-runtimes.js';
import {
  getToolRuntime,
  _resetToolRuntimeRegistryForTest,
} from '../../src/tool-runtime/registry.js';
import {
  type ScenarioCatalog,
  type ScenarioDef,
} from '../../src/scenarios/index.js';
import type { DeclarativeWidgetNode } from '../../src/ui/declarative/index.js';

const CTX = { surface: 'skill' as const };

function makeCatalog(defs: ScenarioDef[], errors: ScenarioCatalog['errors'] = []): ScenarioCatalog {
  const scenarios = new Map<string, ScenarioDef>();
  for (const d of defs) scenarios.set(d.id, d);
  return { scenarios, errors };
}

const HELLO_DEF: ScenarioDef = {
  id: 'hello',
  title: 'Hello',
  description: 'simple single widget',
  layout: { widget: 'log', config: { lines: ['hi'] } },
  meta: { tags: ['demo', 'intro'] },
};

const PAIR_DEF: ScenarioDef = {
  id: 'pair',
  title: 'Log + List',
  layout: [
    { widget: 'log', config: {} },
    { widget: 'list', id: 'items', config: { items: ['a', 'b'] } },
  ],
  meta: { tags: ['demo'] },
};

const BROKEN_DEF: ScenarioDef = {
  id: 'broken',
  title: 'malformed',
  // layout missing `widget` field — decode should emit errors
  layout: [{ config: {} }],
};

beforeEach(() => {
  _resetToolRuntimeRegistryForTest();
  __resetScenarioRuntimesForTest();
});

// ── ListScenarios ───────────────────────────────────────────────────

describe('ListScenarios runtime', () => {
  test('spec surfaces canonical id + name', () => {
    const rt = createListScenariosRuntime({ getCatalog: () => undefined });
    expect(rt.id).toBe('ui_list_scenarios');
    expect(rt.spec.name).toBe('ListScenarios');
    expect(rt.spec.parameters).toBeDefined();
  });

  test('undefined catalog → empty list · no throw', async () => {
    const rt = createListScenariosRuntime({ getCatalog: () => undefined });
    const res = await rt.run({}, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.scenarios).toEqual([]);
    expect(payload.errors).toEqual([]);
  });

  test('populated catalog → summary objects in insertion order', async () => {
    const catalog = makeCatalog([HELLO_DEF, PAIR_DEF]);
    const rt = createListScenariosRuntime({ getCatalog: () => catalog });
    const res = await rt.run({}, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.scenarios).toHaveLength(2);
    expect(payload.scenarios[0].id).toBe('hello');
    expect(payload.scenarios[0].title).toBe('Hello');
    expect(payload.scenarios[0].description).toBe('simple single widget');
    expect(payload.scenarios[0].meta.tags).toEqual(['demo', 'intro']);
    expect(payload.scenarios[1].id).toBe('pair');
  });

  test('tag filter keeps scenarios containing every requested tag', async () => {
    const catalog = makeCatalog([HELLO_DEF, PAIR_DEF]);
    const rt = createListScenariosRuntime({ getCatalog: () => catalog });
    const res = await rt.run({ tags: ['intro'] }, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.scenarios).toHaveLength(1);
    expect(payload.scenarios[0].id).toBe('hello');
  });

  test('tag filter that matches no scenarios → empty list', async () => {
    const catalog = makeCatalog([HELLO_DEF]);
    const rt = createListScenariosRuntime({ getCatalog: () => catalog });
    const res = await rt.run({ tags: ['missing'] }, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.scenarios).toHaveLength(0);
  });

  test('errors from catalog load are surfaced verbatim', async () => {
    const catalog = makeCatalog([], [{ path: '/x.yaml', message: 'boom' }]);
    const rt = createListScenariosRuntime({ getCatalog: () => catalog });
    const res = await rt.run({}, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.errors).toHaveLength(1);
    expect(payload.errors[0].message).toBe('boom');
  });
});

// ── RunScenario ─────────────────────────────────────────────────────

describe('RunScenario runtime', () => {
  test('missing id → error payload', async () => {
    const rt = createRunScenarioRuntime({ getCatalog: () => makeCatalog([]) });
    const res = await rt.run({}, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/required/);
  });

  test('unknown id → error payload with known-id listing', async () => {
    const catalog = makeCatalog([HELLO_DEF]);
    const rt = createRunScenarioRuntime({ getCatalog: () => catalog });
    const res = await rt.run({ id: 'nope' }, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/unknown scenario id/);
    expect(payload.known).toEqual(['hello']);
  });

  test('valid id · no onMount → widgets summary · mounted: false', async () => {
    const catalog = makeCatalog([HELLO_DEF]);
    const rt = createRunScenarioRuntime({ getCatalog: () => catalog });
    const res = await rt.run({ id: 'hello' }, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.ok).toBe(true);
    expect(payload.mounted).toBe(false);
    expect(payload.widgets).toHaveLength(1);
    expect(payload.widgets[0].type).toBe('log');
  });

  test('valid id · onMount wired → callback invoked with materialized widgets', async () => {
    const catalog = makeCatalog([PAIR_DEF]);
    let captured: readonly DeclarativeWidgetNode[] | null = null;
    let capturedTarget: unknown = null;
    const deps: ScenarioRuntimeDeps = {
      getCatalog: () => catalog,
      onMount: (widgets, target) => { captured = widgets; capturedTarget = target ?? null; },
    };
    const rt = createRunScenarioRuntime(deps);
    const res = await rt.run({ id: 'pair' }, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.ok).toBe(true);
    expect(payload.mounted).toBe(true);
    expect(captured).not.toBeNull();
    expect(captured!).toHaveLength(2);
    expect(captured![0]!.type).toBe('log');
    expect(captured![1]!.type).toBe('list');
    expect(capturedTarget).toBeNull();
  });

  test('parsed target is passed to onMount', async () => {
    const catalog = makeCatalog([HELLO_DEF]);
    let capturedTarget: unknown = null;
    const rt = createRunScenarioRuntime({
      getCatalog: () => catalog,
      onMount: (_widgets, target) => {
        capturedTarget = target ?? null;
        return { mounted: true };
      },
    });
    const res = await rt.run({ id: 'hello', target: { kind: 'modal', modalId: 'picker' } }, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.ok).toBe(true);
    expect(payload.target).toEqual({ kind: 'modal', modalId: 'picker' });
    expect(capturedTarget).toEqual({ kind: 'modal', modalId: 'picker' });
  });

  test('well-formed window and pane targets are unsupported, malformed addresses are not mislabeled', async () => {
    const catalog = makeCatalog([HELLO_DEF]);
    let mounts = 0;
    const rt = createRunScenarioRuntime({
      getCatalog: () => catalog,
      onMount: () => { mounts++; return { mounted: true }; },
    });
    for (const target of [
      { kind: 'window', windowId: 7 },
      { kind: 'pane', ref: { windowId: '7', paneId: 'p-1', runnerLabel: 'runner' } },
    ]) {
      const payload = JSON.parse((await rt.run({ id: 'hello', target }, CTX)).output);
      expect(payload.ok).toBe(false);
      expect(payload.mounted).toBe(false);
      expect(payload.target).toEqual(target);
      expect(payload.error).toBe(`RunScenario: target kind "${target.kind}" is not a scenario mount destination`);
    }
    for (const target of [
      { kind: 'window', windowId: '7' },
      { kind: 'pane', ref: { windowId: 7, paneId: 'p-1' } },
      { kind: 'pane', ref: { windowId: '7', paneId: 'p-1', runnerLabel: 2 } },
    ]) {
      const payload = JSON.parse((await rt.run({ id: 'hello', target }, CTX)).output);
      expect(payload.ok).toBe(false);
      expect(payload.error).toBe('RunScenario: malformed `target` SurfaceAddress');
    }
    expect(mounts).toBe(0);
  });

  test('target requested without onMount support → explicit unsupported-target error', async () => {
    const catalog = makeCatalog([HELLO_DEF]);
    const rt = createRunScenarioRuntime({ getCatalog: () => catalog });
    const res = await rt.run({ id: 'hello', target: { kind: 'widget', widgetId: 'wd-log' } }, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.ok).toBe(false);
    expect(payload.mounted).toBe(false);
    expect(payload.error).toMatch(/does not support target-aware mounts/);
    expect(payload.target).toEqual({ kind: 'widget', widgetId: 'wd-log' });
  });

  test('onMount can return mounted:false with explicit unsupported reason', async () => {
    const catalog = makeCatalog([HELLO_DEF]);
    const rt = createRunScenarioRuntime({
      getCatalog: () => catalog,
      onMount: () => ({ mounted: false, error: 'unsupported target kind "widget"' }),
    });
    const res = await rt.run({ id: 'hello', target: { kind: 'widget', widgetId: 'wd-log' } }, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.ok).toBe(false);
    expect(payload.mounted).toBe(false);
    expect(payload.error).toMatch(/unsupported target kind/);
  });

  test('non-mount target kinds can surface explicit unsupported reasons through onMount', async () => {
    const catalog = makeCatalog([HELLO_DEF]);
    const rt = createRunScenarioRuntime({
      getCatalog: () => catalog,
      onMount: (_widgets, target) => {
        if (!target || target.kind !== 'input') return { mounted: false, error: 'unexpected target' };
        return { mounted: false, error: 'RunScenario: target kind "input" is not a mount container' };
      },
    });
    const res = await rt.run({ id: 'hello', target: { kind: 'input', inputId: 'chat-main' } }, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.ok).toBe(false);
    expect(payload.mounted).toBe(false);
    expect(payload.target).toEqual({ kind: 'input', inputId: 'chat-main' });
    expect(payload.error).toMatch(/not a mount container/);
  });

  test('onMount throw → ok:false · error surfaced · widgets summary still returned', async () => {
    const catalog = makeCatalog([HELLO_DEF]);
    const rt = createRunScenarioRuntime({
      getCatalog: () => catalog,
      onMount: () => { throw new Error('mount blew up'); },
    });
    const res = await rt.run({ id: 'hello' }, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/mount blew up/);
    expect(payload.widgets).toHaveLength(1);
  });

  test('lax: false + malformed layout → zero widgets + errors', async () => {
    const catalog = makeCatalog([BROKEN_DEF]);
    const rt = createRunScenarioRuntime({ getCatalog: () => catalog });
    const res = await rt.run({ id: 'broken', lax: false }, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.ok).toBe(false);
    expect(payload.widgets).toHaveLength(0);
    expect(payload.errors.length).toBeGreaterThan(0);
  });

  test('lax: true (default) on malformed layout → decode errors surface', async () => {
    const catalog = makeCatalog([BROKEN_DEF]);
    const rt = createRunScenarioRuntime({ getCatalog: () => catalog });
    const res = await rt.run({ id: 'broken' }, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.errors.length).toBeGreaterThan(0);
  });
});

// ── GetScenarioSchema ───────────────────────────────────────────────

describe('GetScenarioSchema runtime', () => {
  test('missing id → found: false + error', async () => {
    const rt = createGetScenarioSchemaRuntime({ getCatalog: () => makeCatalog([]) });
    const res = await rt.run({}, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.found).toBe(false);
    expect(payload.error).toMatch(/required/);
  });

  test('unknown id → found: false · id echoed', async () => {
    const rt = createGetScenarioSchemaRuntime({ getCatalog: () => makeCatalog([HELLO_DEF]) });
    const res = await rt.run({ id: 'nope' }, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.found).toBe(false);
    expect(payload.id).toBe('nope');
  });

  test('valid id → def + widgetTypes enumerated', async () => {
    const rt = createGetScenarioSchemaRuntime({ getCatalog: () => makeCatalog([PAIR_DEF]) });
    const res = await rt.run({ id: 'pair' }, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.found).toBe(true);
    expect(payload.def.id).toBe('pair');
    expect(payload.widgetTypes).toEqual(['list', 'log']);
  });
});

// ── ValidateScenarioYaml ────────────────────────────────────────────

describe('ValidateScenarioYaml runtime', () => {
  test('valid scenario YAML → ok: true · widgetCount matches', async () => {
    const rt = createValidateScenarioYamlRuntime();
    const yaml = [
      'id: inline',
      'title: inline title',
      'layout:',
      '  - widget: log',
      '    config: {}',
    ].join('\n');
    const res = await rt.run({ yaml }, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.ok).toBe(true);
    expect(payload.widgetCount).toBe(1);
    expect(payload.errors).toHaveLength(0);
  });

  test('missing yaml arg → ok: false · error surfaces', async () => {
    const rt = createValidateScenarioYamlRuntime();
    const res = await rt.run({}, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.ok).toBe(false);
    expect(payload.errors[0].message).toMatch(/non-empty string/);
  });

  test('malformed YAML → ok: false + parseError present', async () => {
    const rt = createValidateScenarioYamlRuntime();
    const res = await rt.run({ yaml: 'id: oops\n  bad: [unterminated' }, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.ok).toBe(false);
    expect(typeof payload.parseError).toBe('string');
  });

  test('shape error (missing title) → path + message surface', async () => {
    const rt = createValidateScenarioYamlRuntime();
    const yaml = 'id: inline\nlayout: []\n';
    const res = await rt.run({ yaml }, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.ok).toBe(false);
    expect(payload.errors[0].path).toBe('$.title');
  });

  test('decode error (missing widget type in node) → errors present', async () => {
    const rt = createValidateScenarioYamlRuntime();
    const yaml = [
      'id: inline',
      'title: inline',
      'layout:',
      '  - config: {}',
    ].join('\n');
    const res = await rt.run({ yaml }, CTX);
    const payload = JSON.parse(res.output);
    expect(payload.ok).toBe(false);
    expect(payload.errors.length).toBeGreaterThan(0);
  });
});

// ── registration helpers ────────────────────────────────────────────

describe('registerScenarioRuntimes', () => {
  test('installs all four runtimes into the shared registry', () => {
    const deps: ScenarioRuntimeDeps = { getCatalog: () => makeCatalog([]) };
    registerScenarioRuntimes(deps);
    expect(getToolRuntime('ui_list_scenarios')).toBeDefined();
    expect(getToolRuntime('ui_run_scenario')).toBeDefined();
    expect(getToolRuntime('ui_get_scenario_schema')).toBeDefined();
    expect(getToolRuntime('ui_validate_scenario_yaml')).toBeDefined();
  });

  test('idempotent for the same deps · no throw on re-call', () => {
    const deps: ScenarioRuntimeDeps = { getCatalog: () => makeCatalog([]) };
    registerScenarioRuntimes(deps);
    expect(() => registerScenarioRuntimes(deps)).not.toThrow();
  });

  test('different deps without reset → throws to flag the bug loudly', () => {
    const depsA: ScenarioRuntimeDeps = { getCatalog: () => makeCatalog([]) };
    const depsB: ScenarioRuntimeDeps = { getCatalog: () => makeCatalog([]) };
    registerScenarioRuntimes(depsA);
    expect(() => registerScenarioRuntimes(depsB)).toThrow(/different deps/);
  });

  test('__resetScenarioRuntimesForTest clears flag so re-register succeeds', () => {
    const depsA: ScenarioRuntimeDeps = { getCatalog: () => makeCatalog([]) };
    const depsB: ScenarioRuntimeDeps = { getCatalog: () => makeCatalog([]) };
    registerScenarioRuntimes(depsA);
    __resetScenarioRuntimesForTest();
    _resetToolRuntimeRegistryForTest();
    expect(() => registerScenarioRuntimes(depsB)).not.toThrow();
  });
});
