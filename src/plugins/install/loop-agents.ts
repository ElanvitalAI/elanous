// LOOP-AGENTS-AS-PLUGINS P3 — a loop agent installs like any plugin (대표 11-28 15:3x «기존 것 통합 및 플러그인화»).
//
// S: the 12 loop agents (graphs/loop-agents/<id>/agent.yaml) shipped only inside the elanous package; nothing outside the repo
//    could add one, and `eln plugin add` / `remove` did not know them.
// C: one definition — the agent.yaml (src/plugins/core/plugin-yaml.ts compiles the plugin id · name · version from its
//    manifest; plugins/<id>/plugin.yaml holds only the `loopAgent:` pointer) — and one ticker — the trigger registry.
// A: install bundles the agent package and its tick shim into the plugin package (graphs/loop-agents/<id> · graphs/triggers/
//    <shim>.yaml — the same layout the registry and agent-trigger.ts already read), then registers the shim's trigger (live) ·
//    remove retires it (the row stays for its history · `retired` is never ticked) · `eln loop trigger register` (no files)
//    also re-registers installed plugins' shims, so a rail re-register keeps them.
//
// 세 얼굴: 관측 = `eln plugin list --json` (loopAgents) ⊕ `eln loop trigger list` (the registered row) / 판단 근거 = the agent.yaml
//          and its shim (lint refuses a broken one at compile) / 수복과 인계 = a registration that fails rolls the install back
//          (the package is removed again, nothing half-installed) · remove retires before the package is moved away.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';

export interface ManifestLoopAgent { readonly id: string; readonly agent: string; readonly trigger: string; readonly kpis: readonly string[] }

/** `extensions["ai.elanous"].loopAgents` of a plugin.json (generated from plugin.yaml `loopAgent:`) — [] when none. */
export function manifestLoopAgents(pluginDir: string): ManifestLoopAgent[] {
  try {
    const j = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8')) as { extensions?: Record<string, { loopAgents?: unknown }> };
    const list = j.extensions?.['ai.elanous']?.loopAgents;
    return Array.isArray(list) ? list.filter((x): x is ManifestLoopAgent => !!x && typeof x === 'object' && typeof (x as ManifestLoopAgent).id === 'string'
      && typeof (x as ManifestLoopAgent).agent === 'string' && typeof (x as ManifestLoopAgent).trigger === 'string') : [];
  } catch { return []; }
}

const shimName = (a: ManifestLoopAgent): string => a.trigger.split('/').at(-1)!;
/** The bundled layout inside an installed package (what agent-trigger.ts reads: graphs/triggers/<shim> → ../loop-agents/<id>). */
export const bundledAgentDir = (pkg: string, a: ManifestLoopAgent): string => join(pkg, 'graphs', 'loop-agents', a.id);
export const bundledShim = (pkg: string, a: ManifestLoopAgent): string => join(pkg, 'graphs', 'triggers', shimName(a));

/** Copy each pointed agent package and its shim from the SOURCE plugin dir into the staged package. Already bundled = kept
 *  (a market package ships them). Throws when a pointer resolves nowhere (the install is refused, never half a plugin). */
export function bundleLoopAgents(sourceDir: string | undefined, pkg: string): string[] {
  const out: string[] = [];
  for (const a of manifestLoopAgents(pkg)) {
    const dir = bundledAgentDir(pkg, a); const shim = bundledShim(pkg, a);
    if (!existsSync(join(dir, 'agent.yaml'))) {
      const from = sourceDir ? dirname(resolve(sourceDir, a.agent)) : null;
      if (!from || !existsSync(join(from, 'agent.yaml'))) throw new Error(`loop agent ${a.id}: ${a.agent} is not in the source and not bundled`);
      mkdirSync(dirname(dir), { recursive: true }); cpSync(from, dir, { recursive: true });
    }
    if (!existsSync(shim)) {
      const from = sourceDir ? resolve(sourceDir, a.trigger) : null;
      if (!from || !existsSync(from)) throw new Error(`loop agent ${a.id}: trigger shim ${a.trigger} is not in the source and not bundled`);
      mkdirSync(dirname(shim), { recursive: true }); cpSync(from, shim);
      bundleRecipes(from, shim);
    }
    out.push(a.id);
  }
  return out;
}

/** The shim's `cmd:<recipe>` nodes need their recipes beside it (graph runner: the graph dir's recipes.yaml). Copied from the
 *  source graphs/triggers/recipes.yaml with `$ELANOUS_GRAPH_DIR/../..` (the elanous tree the shim came from) made absolute —
 *  the installed shim runs the elanous that installed it. */
function bundleRecipes(sourceShim: string, shim: string): void {
  const doc = (parse(readFileSync(sourceShim, 'utf8')) ?? {}) as { nodes?: Array<{ recipe?: unknown }> };
  const names = (doc.nodes ?? []).map(n => (typeof n.recipe === 'string' && n.recipe.startsWith('cmd:') ? n.recipe.slice(4) : null)).filter((n): n is string => !!n);
  if (!names.length) return;
  const srcRecipes = join(dirname(sourceShim), 'recipes.yaml');
  const all = (parse(readFileSync(srcRecipes, 'utf8')) ?? {}) as Record<string, { command?: unknown }>;
  const tree = resolve(dirname(sourceShim), '..', '..');
  const dest = join(dirname(shim), 'recipes.yaml');
  const mine = existsSync(dest) ? ((parse(readFileSync(dest, 'utf8')) ?? {}) as Record<string, unknown>) : {};
  for (const n of names) {
    const r = all[n];
    if (!r || typeof r.command !== 'string') throw new Error(`trigger shim ${sourceShim}: recipe ${n} not in ${srcRecipes}`);
    mine[n] = { ...r, command: r.command.split('$ELANOUS_GRAPH_DIR/../..').join(tree) };
  }
  writeFileSync(dest, stringify(mine));
}

export interface LoopAgentRegistration { readonly id: string; readonly graphId: string; readonly stage: string; readonly created: boolean; readonly revived: boolean; readonly shipped: boolean }

/** Register the installed package's loop-agent shims in the trigger registry at `stateRoot` (live · a retired row comes back). */
export function registerPluginLoopAgents(stateRoot: string, pkg: string, now = new Date()): LoopAgentRegistration[] {
  const agents = manifestLoopAgents(pkg);
  if (!agents.length) return [];
  const reg = require('../../loops/trigger-registry.js') as typeof import('../../loops/trigger-registry.js');
  const db = reg.openTriggerRegistry(stateRoot);
  try {
    return agents.map(a => {
      const decl = reg.readTriggerDecl(bundledShim(pkg, a), pkg);
      // the same trigger shipped with the elanous package (graphs/triggers/) owns its row: never repoint it at the plugin copy
      // (a rail `trigger register` would then refuse the shipped declaration) — the plugin is how OTHER installs get the agent
      const existing = reg.listTriggers(db).find(r => r.graphId === decl.graphId) ?? null;
      if (existing && !resolve(existing.file).startsWith(`${resolve(pkg)}/`)) return { id: a.id, graphId: decl.graphId, stage: existing.stage, created: false, revived: false, shipped: true };
      const r = reg.registerTrigger(db, decl, { now, update: true });
      const revived = r.row.stage === 'retired' && reg.setTriggerStage(db, decl.graphId, 'live', now);
      return { id: a.id, graphId: decl.graphId, stage: revived ? 'live' : r.row.stage, created: r.created, revived, shipped: false };
    });
  } finally { db.close(); }
}

/** Retire the package's loop-agent triggers (remove). `installedAt` = where the package was registered from (remove reads the
 *  manifest from its quarantine copy). Returns the graph ids retired now. Fail-open per row. */
export function retirePluginLoopAgents(stateRoot: string, pkg: string, now = new Date(), installedAt = pkg): string[] {
  const agents = manifestLoopAgents(pkg);
  if (!agents.length) return [];
  const reg = require('../../loops/trigger-registry.js') as typeof import('../../loops/trigger-registry.js');
  const db = reg.openTriggerRegistry(stateRoot);
  try {
    return agents.flatMap(a => {
      try {
        const id = reg.readTriggerDecl(bundledShim(pkg, a), pkg).graphId;
        const row = reg.listTriggers(db).find(r => r.graphId === id);
        // only the row this plugin registered (its file under the package) — a shipped trigger of the same id stays live
        return row && resolve(row.file).startsWith(`${resolve(installedAt)}/`) && reg.setTriggerStage(db, id, 'retired', now) ? [id] : [];
      }
      catch { return []; }
    });
  } finally { db.close(); }
}

/** Every installed plugin's loop-agent shim (absolute paths) — `eln loop trigger register` with no files adds these. */
export function installedLoopAgentShims(stateRoot: string): string[] {
  try {
    const { listInstalledPlugins } = require('./plugin-install.js') as typeof import('./plugin-install.js');
    return listInstalledPlugins(stateRoot).flatMap(p => manifestLoopAgents(p.path).map(a => bundledShim(p.path, a)).filter(f => existsSync(f)));
  } catch { return []; }
}
