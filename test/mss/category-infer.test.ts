import { describe, test, expect } from 'bun:test';
import { inferCategoryFromPath } from '../../src/mss/category-infer.js';

describe('mss category-infer — 8-track prefix mapping', () => {
  test('pfc — conductor / cft / agent / auto-research', () => {
    expect(inferCategoryFromPath('src/conductor/classify.ts', 'classify')).toBe('pfc.classify');
    expect(inferCategoryFromPath('/abs/monad-agent/src/cft/andon.ts', 'fire')).toBe('pfc.fire');
    expect(inferCategoryFromPath('src/agent/runtime.ts')).toBe('pfc.runtime');
    expect(inferCategoryFromPath('src/auto-research/bridge.ts')).toBe('pfc.bridge');
  });

  test('idx — input-core / dashboard / log-pane', () => {
    expect(inferCategoryFromPath('src/input-core/context-keys.ts')).toBe('idx.context-keys');
    expect(inferCategoryFromPath('src/dashboard.ts', 'routeInputEvent')).toBe('idx.route-input-event');
    expect(inferCategoryFromPath('src/log-pane/view.ts')).toBe('idx.view');
  });

  test('tox — task-orchestrator / tox-* runtime', () => {
    expect(inferCategoryFromPath('src/task-orchestrator/dag.ts')).toBe('tox.dag');
    expect(inferCategoryFromPath('src/tool-runtime/tox-runtimes.ts')).toBe('tox.tox-runtimes');
  });

  test('axon — acp / hitl / telegram / discord / pushcut', () => {
    expect(inferCategoryFromPath('src/acp/server.ts')).toBe('axon.server');
    expect(inferCategoryFromPath('src/hitl/request.ts')).toBe('axon.request');
    expect(inferCategoryFromPath('src/telegram-bot.ts')).toBe('axon.telegram-bot');
    expect(inferCategoryFromPath('src/discord-bridge.ts')).toBe('axon.discord-bridge');
    expect(inferCategoryFromPath('src/pushcut/send.ts')).toBe('axon.send');
  });

  test('kgs — knowledge / kgp / obsidian', () => {
    expect(inferCategoryFromPath('src/knowledge/store.ts')).toBe('kgs.store');
    expect(inferCategoryFromPath('src/kgp/graph.ts')).toBe('kgs.graph');
    expect(inferCategoryFromPath('src/obsidian-bridge.ts')).toBe('kgs.obsidian-bridge');
  });

  test('iul — surface / panes / shell-runner / browser-cdp', () => {
    expect(inferCategoryFromPath('src/surface/registry.ts')).toBe('iul.registry');
    expect(inferCategoryFromPath('src/panes/layout.ts')).toBe('iul.layout');
    expect(inferCategoryFromPath('src/shell-runner/runner.ts')).toBe('iul.runner');
    expect(inferCategoryFromPath('src/browser-cdp/client.ts')).toBe('iul.client');
  });

  test('cap — capture', () => {
    expect(inferCategoryFromPath('src/capture/target.ts')).toBe('cap.target');
  });

  test('sched — scheduler', () => {
    expect(inferCategoryFromPath('src/scheduler/cron.ts')).toBe('sched.cron');
  });

  test('widget — widgets/ or src/widget-*', () => {
    expect(inferCategoryFromPath('widgets/playground/widget.ts')).toBe('widget.widget');
    expect(inferCategoryFromPath('src/widget-host.ts')).toBe('widget.widget-host');
  });

  test('mss — src/mss/**', () => {
    expect(inferCategoryFromPath('src/mss/identity-store.ts', 'getOrCreateElanousId')).toBe('mss.get-or-create-elanous-id');
  });

  test('plugin — plugins/**', () => {
    expect(inferCategoryFromPath('plugins/sync/plugin.ts')).toBe('plugin.plugin');
  });

  test('unknown path falls back to unknown.<basename>', () => {
    expect(inferCategoryFromPath('src/some-random-file.ts')).toBe('unknown.some-random-file');
    expect(inferCategoryFromPath('lib/third-party/foo.ts')).toBe('unknown.foo');
  });

  test('camelCase fn → kebab-case tail', () => {
    expect(inferCategoryFromPath('src/conductor/c.ts', 'routeToCompute')).toBe('pfc.route-to-compute');
  });

  test('absolute path with backslashes normalised', () => {
    expect(inferCategoryFromPath('C:\\projects\\elanous\\src\\input-core\\mode.ts', 'setMode'))
      .toBe('idx.set-mode');
  });
});
