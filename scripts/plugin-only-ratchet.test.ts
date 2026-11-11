import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPluginOnlyRatchet, compareInventory, declaredPluginHandlers, inventoryFromTree, PLUGIN_ONLY_BASELINE, regenerateBaseline } from './plugin-only-ratchet.js';

describe('PLUGIN-ONLY-RATCHET', () => {
  test('permits only a manifest-declared handler with an owning skill', () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-handler-declaration-'));
    try {
      mkdirSync(join(root, 'plugins/example/handlers'), { recursive: true });
      writeFileSync(join(root, 'plugins/example/handlers/approved.ts'), 'export const approved = true;\n');
      writeFileSync(join(root, 'plugins/example/handlers/hidden.ts'), 'export const hidden = true;\n');
      writeFileSync(join(root, 'plugins/example/plugin.yaml'), 'id: example\nskills:\n  - { id: example/build }\nhandlers:\n  approved: { module: handlers/approved.ts, export: approved, skill: example/build }\n  hidden: { module: handlers/hidden.ts, export: hidden, skill: wrong/skill }\n  escape: { module: ../outside.ts, export: escape, skill: example/build }\n');
      expect([...declaredPluginHandlers(root)]).toEqual(['plugins/example/handlers/approved.ts']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('rejects new plugin code and core graph identifiers, while allowing frozen entries and removals', () => {
    const baseline = {
      pluginCodeFiles: ['plugins/legacy/plugin.ts'],
      coreFeatureIdentifiers: [
        'src/graph-runner/runner.ts:comparison:graphId:release-loop',
        'src/graph-runner/runner.ts:map:RELEASE_NODE_COMMANDS:gate',
      ],
    };
    expect(compareInventory({
      pluginCodeFiles: ['plugins/legacy/plugin.ts', 'plugins/new/plugin.ts'],
      coreFeatureIdentifiers: [...baseline.coreFeatureIdentifiers,
        'src/graph-runner/runner.ts:comparison:graphId:new-feature-graph'],
    }, baseline)).toEqual([
      'plugin-code-added:plugins/new/plugin.ts',
      'core-feature-hardcode-added:src/graph-runner/runner.ts:comparison:graphId:new-feature-graph',
    ]);
    expect(compareInventory({
      pluginCodeFiles: [],
      coreFeatureIdentifiers: [baseline.coreFeatureIdentifiers[0]!],
    }, baseline)).toEqual([]);
  });

  test('real tree inventory catches both comparison directions, identity fields, and typed named-map keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-only-ratchet-test-'));
    try {
      mkdirSync(join(root, 'src/graph-runner'), { recursive: true });
      writeFileSync(join(root, 'src/graph-runner/forward.ts'), "if (state.graphId === 'special-flow') return true;\n");
      writeFileSync(join(root, 'src/graph-runner/reverse.ts'), "if ('left-hand-flow' === state.graphId) return false;\n");
      writeFileSync(join(root, 'src/graph-runner/identity.ts'), "const inline = { graph_id: 'inline-flow' };\n");
      writeFileSync(join(root, 'src/graph-runner/map.ts'), "const RELEASE_NODE_COMMANDS = { 'publish-release': { recipe: 'cmd:publish' } };\n");
      writeFileSync(join(root, 'src/graph-runner/typed-map.ts'), "const NODE_MAP: Record<string, Handler> = { newNode: handler };\n");
      writeFileSync(join(root, 'src/graph-runner/method-map.ts'), "const NODE_MAP = { methodNode() {}, get accessorNode() { return handler; } };\n");
      writeFileSync(join(root, 'src/graph-runner/camel-map.ts'), "const graphMap = { newGraph: handler } as const;\n");
      writeFileSync(join(root, 'src/graph-runner/computed.ts'), "if (state['graphId'] === 'computed-flow') return true;\n");
      writeFileSync(join(root, 'src/graph-runner/class-field.ts'), "class Graph { graphId = 'class-flow'; }\n");
      writeFileSync(join(root, 'src/graph-runner/wrapped-forward.ts'), "if ((state.graphId) === ('wrapped-right' as const)) return true;\n");
      writeFileSync(join(root, 'src/graph-runner/wrapped-reverse.ts'), "if (('wrapped-left' as const) === (state.graphId)) return false;\n");
      writeFileSync(join(root, 'src/graph-runner/shorthand-map.ts'), "const NODE_MAP = { newNode };\n");
      writeFileSync(join(root, 'src/graph-runner/prose.ts'), "const label = 'special-flow';\n// graphId === 'commented-flow'\n");
      expect(inventoryFromTree(root).coreFeatureIdentifiers).toEqual([
        'src/graph-runner/camel-map.ts:map:graphMap:newGraph',
        'src/graph-runner/class-field.ts:identity-field:graphId:class-flow',
        'src/graph-runner/computed.ts:comparison:state[\'graphId\']:computed-flow',
        'src/graph-runner/forward.ts:comparison:state.graphId:special-flow',
        'src/graph-runner/identity.ts:identity-field:graph_id:inline-flow',
        'src/graph-runner/map.ts:map:RELEASE_NODE_COMMANDS:publish-release',
        'src/graph-runner/method-map.ts:map:NODE_MAP:accessorNode',
        'src/graph-runner/method-map.ts:map:NODE_MAP:methodNode',
        'src/graph-runner/reverse.ts:comparison:state.graphId:left-hand-flow',
        'src/graph-runner/shorthand-map.ts:map:NODE_MAP:newNode',
        'src/graph-runner/typed-map.ts:map:NODE_MAP:newNode',
        'src/graph-runner/wrapped-forward.ts:comparison:state.graphId:wrapped-right',
        'src/graph-runner/wrapped-reverse.ts:comparison:state.graphId:wrapped-left',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects symlink paths in plugin and core inventory roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-only-ratchet-symlink-test-'));
    try {
      mkdirSync(join(root, 'plugins'), { recursive: true });
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src/real.ts'), 'export const helper = true;\n');
      symlinkSync('../src/real.ts', join(root, 'plugins/new.ts'));
      expect(() => inventoryFromTree(root)).toThrow('plugin-only inventory does not allow symlinks: plugins/new.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a baseline that blesses identifiers from the PR head instead of origin/main', () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-only-ratchet-baseline-test-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    try {
      git('init', '-b', 'main');
      git('config', 'user.name', 'Ratchet Test');
      git('config', 'user.email', 'ratchet-test@example.invalid');
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(join(root, 'plugins'), { recursive: true });
      writeFileSync(join(root, 'plugins/.keep'), 'fixture\n');
      writeFileSync(join(root, 'src/runner.ts'), "export const graphId = 'base-graph';\n");
      git('add', 'src/runner.ts', 'plugins/.keep');
      git('commit', '-m', 'baseline');
      const mainRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      git('update-ref', 'refs/remotes/origin/main', mainRef);
      const baseInventory = inventoryFromTree(root);
      mkdirSync(join(root, 'scripts'), { recursive: true });
      writeFileSync(join(root, 'scripts/plugin-only-ratchet-baseline.json'), JSON.stringify({
        schema: 1, sourceRef: mainRef, ...baseInventory,
      }));
      expect(checkPluginOnlyRatchet(root)).toEqual([]);
      writeFileSync(join(root, 'scripts/plugin-only-ratchet-baseline.json'), JSON.stringify({
        schema: 1, sourceRef: mainRef,
        pluginCodeFiles: [...baseInventory.pluginCodeFiles, 'plugins/invented.ts'],
        coreFeatureIdentifiers: baseInventory.coreFeatureIdentifiers,
      }));
      expect(() => checkPluginOnlyRatchet(root)).toThrow(`plugin-only baseline does not match sourceRef inventory: ${mainRef}`);

      git('checkout', '-b', 'pr');
      writeFileSync(join(root, 'src/runner.ts'), "export const graphId = 'base-graph';\nif (graphId === 'new-graph') {}\n");
      git('add', 'src/runner.ts');
      git('commit', '-m', 'PR-only identifier');
      const prHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

      git('checkout', 'main');
      writeFileSync(join(root, 'src/runner.ts'), "export const graphId = 'base-graph';\nif (graphId === 'main-added') {}\n");
      git('add', 'src/runner.ts');
      git('commit', '-m', 'main advanced after PR branch');
      const advancedMain = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      git('update-ref', 'refs/remotes/origin/main', advancedMain);
      git('checkout', 'pr');
      writeFileSync(join(root, 'scripts/plugin-only-ratchet-baseline.json'), JSON.stringify(
        regenerateBaseline(root, advancedMain),
      ));
      expect(() => checkPluginOnlyRatchet(root)).toThrow(`plugin-only baseline sourceRef is not an ancestor of HEAD: ${advancedMain}`);

      writeFileSync(join(root, 'scripts/plugin-only-ratchet-baseline.json'), JSON.stringify({
        schema: 1, sourceRef: prHead, ...inventoryFromTree(root),
      }));
      expect(() => checkPluginOnlyRatchet(root)).toThrow(`plugin-only baseline sourceRef must come from origin/main: ${prHead}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('shallow checkout accepts an unchanged main baseline but still rejects edits and new identifiers', () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-only-ratchet-shallow-test-'));
    const clone = join(tmpdir(), `plugin-only-ratchet-shallow-clone-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    try {
      git(root, 'init', '-b', 'main');
      git(root, 'config', 'user.name', 'Ratchet Test');
      git(root, 'config', 'user.email', 'ratchet-test@example.invalid');
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(join(root, 'plugins'), { recursive: true });
      mkdirSync(join(root, 'scripts'), { recursive: true });
      writeFileSync(join(root, 'plugins/.keep'), 'fixture\n');
      writeFileSync(join(root, 'src/runner.ts'), "export const graphId = 'base-graph';\n");
      git(root, 'add', 'src/runner.ts', 'plugins/.keep');
      git(root, 'commit', '-m', 'source inventory');
      const sourceRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      const inventory = inventoryFromTree(root);
      const baselinePath = join(root, PLUGIN_ONLY_BASELINE);
      writeFileSync(baselinePath, JSON.stringify({
        schema: 1, sourceRef, ...inventory,
      }));
      git(root, 'add', PLUGIN_ONLY_BASELINE);
      git(root, 'commit', '-m', 'record frozen source baseline');
      const mainRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      git(root, 'clone', '--depth=1', `file://${root}`, clone);

      expect(execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: clone, encoding: 'utf8' }).trim()).toBe('true');
      expect(execFileSync('git', ['rev-parse', 'origin/main'], { cwd: clone, encoding: 'utf8' }).trim()).toBe(mainRef);
      expect(() => execFileSync('git', ['cat-file', '-e', `${sourceRef}^{commit}`], { cwd: clone, stdio: 'ignore' })).toThrow();
      expect(checkPluginOnlyRatchet(clone)).toEqual([]);

      writeFileSync(join(clone, 'src/runner.ts'), "export const graphId = 'base-graph';\nif (graphId === 'new-graph') {}\n");
      expect(checkPluginOnlyRatchet(clone)).toEqual([
        'core-feature-hardcode-added:src/runner.ts:comparison:graphId:new-graph',
      ]);

      writeFileSync(join(clone, 'src/runner.ts'), "export const graphId = 'base-graph';\n");
      writeFileSync(join(clone, PLUGIN_ONLY_BASELINE), JSON.stringify({
        schema: 1, sourceRef,
        pluginCodeFiles: [...inventory.pluginCodeFiles, 'plugins/new.ts'],
        coreFeatureIdentifiers: inventory.coreFeatureIdentifiers,
      }));
      expect(() => checkPluginOnlyRatchet(clone)).toThrow(`plugin-only baseline sourceRef is not an ancestor of HEAD: ${sourceRef}`);

      git(clone, 'checkout', '--', PLUGIN_ONLY_BASELINE);
      git(clone, 'update-ref', '-d', 'refs/remotes/origin/main');
      expect(() => checkPluginOnlyRatchet(clone)).toThrow(`plugin-only baseline sourceRef is not an ancestor of HEAD: ${sourceRef}`);
    } finally {
      rmSync(clone, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
