import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compilePluginYaml } from '../core/plugin-yaml.js';
import { installPlugin, listInstalledPlugins, removePlugin } from './plugin-install.js';
import { manifestLoopAgents } from './loop-agents.js';
import { listTriggers, openTriggerRegistry } from '../../loops/trigger-registry.js';

// Expected values are literals, independent of the product (rule 11).
const REPO = resolve(import.meta.dir, '../../..');
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const temp = () => { const r = mkdtempSync(join(tmpdir(), 'loop-agent-plugin-')); roots.push(r); return r; };
const stages = (root: string) => { const db = openTriggerRegistry(root); try { return listTriggers(db).map(r => `${r.graphId}:${r.stage}`); } finally { db.close(); } };

describe('LOOP-AGENTS-AS-PLUGINS P3 — a loop agent is a plugin', () => {
  test('plugin.yaml loopAgent compiles id · name · version · description from the agent.yaml manifest', () => {
    const j = JSON.parse(compilePluginYaml(join(REPO, 'plugins', 'guardian'))) as { id: string; name: string; version: string; extensions: Record<string, { graphs: string[] }> };
    expect([j.id, j.name, j.version, j.extensions['ai.elanous']!.graphs.length]).toEqual(['guardian', 'guardian', '1.0.0', 0]);
    expect(manifestLoopAgents(join(REPO, 'plugins', 'guardian'))).toEqual([{ id: 'guardian', agent: '../../graphs/loop-agents/guardian/agent.yaml', trigger: '../../graphs/triggers/guardian.yaml', kpis: ['unnormalized_cases', 'host_load_per_cpu', 'orphans_over_2h'] }]);
  });

  test('a plugin.yaml repeating name next to loopAgent is refused', () => {
    const tree = temp();
    for (const d of ['graphs/loop-agents/watchers-check', 'graphs/triggers', 'plugins/watchers-check']) cpSync(join(REPO, d), join(tree, d), { recursive: true });
    const py = join(tree, 'plugins', 'watchers-check', 'plugin.yaml');
    writeFileSync(py, `${readFileSync(py, 'utf8')}name: Watchers\n`);
    expect(() => compilePluginYaml(join(tree, 'plugins', 'watchers-check'))).toThrow('plugin.yaml with loopAgent must not repeat name — compiled from the agent.yaml manifest');
  });

  test('install bundles the agent and its shim, registers the trigger live; remove retires it; re-install revives it', async () => {
    const root = temp();
    const p = await installPlugin(join(REPO, 'plugins', 'watchers-check'), { root, yes: true, cwd: REPO });
    expect(['graphs/loop-agents/watchers-check/agent.yaml', 'graphs/triggers/watchers-check-agent.yaml', 'graphs/triggers/recipes.yaml'].map(f => existsSync(join(p.path, f)))).toEqual([true, true, true]);
    expect(stages(root)).toEqual(['watchers-check-agent:live']);
    expect(removePlugin('watchers-check', root)).toBe(1);
    expect([listInstalledPlugins(root).length, ...stages(root)]).toEqual([0, 'watchers-check-agent:retired']);
    await installPlugin(join(REPO, 'plugins', 'watchers-check'), { root, yes: true, cwd: REPO });
    expect(stages(root)).toEqual(['watchers-check-agent:live']);
  });
});
