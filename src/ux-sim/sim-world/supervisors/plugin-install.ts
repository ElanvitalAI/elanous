// SIM-WORLD supervisors · LOOP-AGENTS-AS-PLUGINS P3 — a loop agent is a plugin (대표 11-28 15:3x «기존 것 통합 및 플러그인화»):
//   SUP-PLUGIN-GUARDIAN: an EMPTY test universe (no registry rows · no plugins) → the real installer (`installPlugin`, the door
//                        of `eln plugin add plugins/guardian --yes`) bundles graphs/loop-agents/guardian ⊕ its tick shim ⊕ the
//                        shim's recipe, registers trigger `guardian` live → a registry tick runs the pulse → last-pulse.json
//                        (goal) ⊕ the 7 sub KPI rows · `removePlugin` retires the row (a later tick runs nothing) · re-install
//                        revives it.
//   SUP-PLUGIN-FAULTS:   failure paths — plugin.yaml repeating the version (compiled from agent.yaml) is refused · a pointer
//                        to a missing agent is refused · an agent.yaml whose wake is broken rolls the install back (no
//                        package, no ledger row, no registry row) · a shipped trigger of the same id is never repointed.
//   SUP-PLUGIN-ALL:      every graphs/loop-agents/<id> has plugins/<id>/plugin.yaml and its committed plugin.json equals the
//                        compiled one (id · name · version = the agent.yaml manifest).
// Literal expectations (OPS-RULES 11) · LLM 0 · no ssh · the guardian pulse runs on fake hosts and mail.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { installPlugin, listInstalledPlugins, removePlugin } from '../../../plugins/install/plugin-install.js';
import { compilePluginYaml } from '../../../plugins/core/plugin-yaml.js';
import { listTriggers, openTriggerRegistry, readTriggerDecl, registerTrigger, tickTriggers, type TriggerTickDeps } from '../../../loops/trigger-registry.js';
import { registerPluginLoopAgents } from '../../../plugins/install/loop-agents.js';
import type { ConditionProbes } from '../../../loops/trigger-conditions.js';
import { fileMemory } from '../../../judge-butler/memory.js';
import { GUARDIAN_DEMOTERS, GUARDIAN_ID, GUARDIAN_SUPERVISOR, type GuardianPorts, type GuardianView } from '../../../guardian-agent/body.js';
import { resetGuardianDef } from '../../../guardian-agent/def.js';
import { runResidentPulse, type PulseDeps } from '../../../guardian-agent/pulse.js';
import type { SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const REPO = resolve(import.meta.dir, '../../../..');
const MIN = 60_000; // 출처: one minute in ms (scenario clock unit, not a bound)
const fail = (reason: string, diff: unknown): SimWorldScenarioOutcome => ({ ok: false, reason, diff: typeof diff === 'string' ? diff : JSON.stringify(diff) });
const quietProbes = (now: () => Date): ConditionProbes => ({
  now, watch: async () => null, mtimeMs: () => null, readJson: () => undefined, readLines: () => [],
  cells: async () => [], idleSeats: async () => [], landedCount: async () => 0, handsUpCount: async () => 0,
  publishedVersions: async () => [], installedVersion: async () => null,
});
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function guardianInstall(ctx: SimWorldScenarioContext): Promise<SimWorldScenarioOutcome> {
  const root = join(ctx.universeRoot, 'state'); mkdirSync(root, { recursive: true });
  const before = { plugins: listInstalledPlugins(root).length, rows: (() => { const db = openTriggerRegistry(root); try { return listTriggers(db).length; } finally { db.close(); } })() };
  const installed = await installPlugin(join(REPO, 'plugins', 'guardian'), { root, yes: true, cwd: REPO });
  const pkg = installed.path;
  const bundled = ['graphs/loop-agents/guardian/agent.yaml', 'graphs/triggers/guardian.yaml', 'graphs/triggers/recipes.yaml'].filter(f => existsSync(join(pkg, f)));
  const recipe = readFileSync(join(pkg, 'graphs/triggers/recipes.yaml'), 'utf8');
  const db = openTriggerRegistry(root);
  try {
    const row = () => listTriggers(db).find(r => r.graphId === installed.name) ?? null; // the shim graph id = the agent id
    const stageAfterInstall = row()?.stage ?? null;
    // the registry tick runs the shim; the shim's recipe would run `eln loop guardian pulse` — here the real pulse, in-process
    resetGuardianDef();
    const memory = fileMemory(root, { agent: GUARDIAN_ID, supervisor: GUARDIAN_SUPERVISOR, demoters: GUARDIAN_DEMOTERS });
    let clock = Date.now() - 5 * MIN; // the goal is file-mtime: the pulse writes last-pulse.json now (≥ the window)
    const runs: string[] = []; let kpiRows = 0;
    const deps: TriggerTickDeps = {
      now: () => new Date(clock), vars: { seatState: join(ctx.universeRoot, 'seat-state'), stateRoot: root }, probes: quietProbes(() => new Date(clock)),
      runGraph: async (d, _input, runId) => {
        runs.push(d.graphId);
        const now = new Date(clock);
        const view: GuardianView = { now, probes: [{ host: 'sim-host-1', reachable: true, load1: 2, ncpu: 18 }], procs: new Map(), registry: new Map(), ready: null, hands: null };
        const ports: GuardianPorts = { memory, kill: () => ({ killed: [], skipped: [] }), writeRoute: () => {}, post: () => 1, audit: () => {} };
        const pd: PulseDeps = { stateRoot: root, now, memory, probes: () => [...view.probes], fuelSnapshot: () => null, refreshFuel: () => {}, credentials: () => [], scanSecrets: () => [],
          supervisors: () => [], restart: () => {}, post: () => 1, heavy: () => ({ view, ports, close: () => {} }), beat: () => {} } as PulseDeps;
        kpiRows = runResidentPulse(pd).kpi.length;
        return { status: 'done', runId };
      },
      postCard: async () => 'card-0', scheduleAction: async () => {},
    };
    for (let m = 0; m < 3; m += 1) { clock += MIN; await tickTriggers(db, deps); }
    const goal = existsSync(join(root, 'loop-agents', 'guardian', 'last-pulse.json'));
    const runsInstalled = runs.length;
    const removed = removePlugin('guardian', root);
    const stageAfterRemove = row()?.stage ?? null;
    for (let m = 0; m < 3; m += 1) { clock += MIN; await tickTriggers(db, deps); }
    const runsAfterRemove = runs.length - runsInstalled;
    const again = await installPlugin(join(REPO, 'plugins', 'guardian'), { root, yes: true, cwd: REPO });
    const stageAfterReinstall = row()?.stage ?? null;
    ctx.recorder.event('plugin:guardian', { before, plugin: `${installed.name}@${installed.version}`, bundled, stageAfterInstall, runsInstalled, goal, kpiRows, removed, stageAfterRemove, runsAfterRemove, stageAfterReinstall, again: again.version });
    if (before.plugins !== 0 || before.rows !== 0) return fail('universe-not-empty', before);
    if (`${installed.name}@${installed.version}` !== 'guardian@1.0.0') return fail('plugin-identity', `${installed.name}@${installed.version}`);
    if (bundled.length !== 3) return fail('not-bundled', bundled);
    if (recipe.includes('$ELANOUS_GRAPH_DIR') || !recipe.includes(`${REPO}/bin/elanous.mjs`)) return fail('recipe-not-localized', recipe.slice(0, 200));
    if (stageAfterInstall !== 'live') return fail('not-registered', stageAfterInstall);
    if (runsInstalled < 1 || !goal || kpiRows !== 7) return fail('guardian-did-not-tick', { runsInstalled, goal, kpiRows });
    if (removed !== 1 || stageAfterRemove !== 'retired' || runsAfterRemove !== 0) return fail('remove-not-retired', { removed, stageAfterRemove, runsAfterRemove });
    if (stageAfterReinstall !== 'live') return fail('reinstall-not-revived', stageAfterReinstall);
    return { ok: true };
  } finally { db.close(); }
}

async function faults(ctx: SimWorldScenarioContext): Promise<SimWorldScenarioOutcome> {
  const tree = join(ctx.universeRoot, 'tree'); const out: Record<string, string> = {};
  for (const d of ['graphs/loop-agents/guardian', 'graphs/triggers', 'plugins/guardian']) cpSync(join(REPO, d), join(tree, d), { recursive: true });
  const py = join(tree, 'plugins', 'guardian', 'plugin.yaml'); const original = readFileSync(py, 'utf8');
  // (a) plugin.yaml repeats the version → refused (one definition: agent.yaml)
  writeFileSync(py, `${original}version: 9.9.9\n`);
  try { compilePluginYaml(join(tree, 'plugins', 'guardian')); out.repeat = 'accepted'; } catch (e) { out.repeat = errText(e); }
  // (b) the pointer names an agent that is not there → refused
  writeFileSync(py, original.replace('graphs/loop-agents/guardian/agent.yaml', 'graphs/loop-agents/no-such-agent/agent.yaml'));
  try { compilePluginYaml(join(tree, 'plugins', 'guardian')); out.missing = 'accepted'; } catch (e) { out.missing = errText(e); }
  // (c) the agent.yaml wake is broken → the install rolls back: no package · no ledger row · no registry row
  writeFileSync(py, original);
  writeFileSync(join(tree, 'plugins', 'guardian', 'plugin.json'), compilePluginYaml(join(tree, 'plugins', 'guardian')));
  const ay = join(tree, 'graphs', 'loop-agents', 'guardian', 'agent.yaml');
  writeFileSync(ay, readFileSync(ay, 'utf8').replace(/  trigger:\n    condition:\n/u, '  trigger:\n    nonsense:\n'));
  const root = join(ctx.universeRoot, 'state'); mkdirSync(root, { recursive: true });
  try { await installPlugin(join(tree, 'plugins', 'guardian'), { root, yes: true, cwd: tree }); out.broken = 'installed'; } catch (e) { out.broken = errText(e).slice(0, 160); }
  const db = openTriggerRegistry(root);
  try {
    out.after = `plugins=${listInstalledPlugins(root).length} rows=${listTriggers(db).length}`;
    // (d) a shipped `guardian` row (graphs/triggers/guardian.yaml of the package) is never repointed at a plugin copy
    registerTrigger(db, readTriggerDecl('graphs/triggers/guardian.yaml', REPO));
  } finally { db.close(); }
  const good = await installPlugin(join(REPO, 'plugins', 'guardian'), { root, yes: true, cwd: REPO });
  const db2 = openTriggerRegistry(root);
  try { out.shipped = listTriggers(db2).find(r => r.graphId === good.name)?.file ?? '-'; } finally { db2.close(); }
  out.again = registerPluginLoopAgents(root, good.path).map(r => `${r.graphId}:${r.shipped ? 'shipped' : r.stage}`).join(',');
  ctx.recorder.event('plugin:faults', { seed: ctx.seed, ...out });
  if (out.repeat !== 'plugin.yaml with loopAgent must not repeat version — compiled from the agent.yaml manifest') return fail('repeat', out.repeat);
  if (out.missing !== 'plugin.yaml loopAgent not found: ../../graphs/loop-agents/no-such-agent/agent.yaml') return fail('missing', out.missing);
  if (out.broken === 'installed' || out.after !== 'plugins=0 rows=0') return fail('broken-not-rolled-back', `${out.broken} · ${out.after}`);
  if (out.shipped !== 'graphs/triggers/guardian.yaml' || out.again !== 'guardian:shipped') return fail('shipped-repointed', `${out.shipped} · ${out.again}`);
  return { ok: true };
}

async function all(ctx: SimWorldScenarioContext): Promise<SimWorldScenarioOutcome> {
  const agents = readdirSync(join(REPO, 'graphs', 'loop-agents')).filter(id => existsSync(join(REPO, 'graphs', 'loop-agents', id, 'agent.yaml'))).sort();
  const rows = agents.map(id => {
    const dir = join(REPO, 'plugins', id);
    if (!existsSync(join(dir, 'plugin.yaml'))) return `${id}:no-plugin`;
    try {
      const compiled = compilePluginYaml(dir); const j = JSON.parse(compiled) as { id: string; version: string };
      const committed = existsSync(join(dir, 'plugin.json')) ? readFileSync(join(dir, 'plugin.json'), 'utf8') : '';
      return `${id}:${j.id}@${j.version}${committed === compiled ? '' : ':stale'}`;
    } catch (e) { return `${id}:refused ${errText(e).slice(0, 80)}`; }
  });
  ctx.recorder.event('plugin:all', { rows });
  const bad = rows.filter(r => !/^[a-z-]+:[a-z-]+@\d+\.\d+\.\d+$/u.test(r) || r.split(':')[0] !== r.split(':')[1]!.split('@')[0]);
  if (agents.length !== 15 || bad.length) return fail('not-all-packaged', { n: agents.length, bad });
  return { ok: true };
}

export const simWorldScenarios: readonly SimWorldScenario[] = [
  { id: 'SUP-PLUGIN-GUARDIAN', title: 'P3: empty test universe → eln plugin add plugins/guardian (real installer) bundles agent ⊕ shim ⊕ recipe · trigger live · a registry tick runs the pulse (goal ⊕ 7 KPI rows) · remove retires (no run) · re-install revives', run: guardianInstall },
  { id: 'SUP-PLUGIN-FAULTS', title: 'P3: plugin.yaml repeating the version · a pointer to no agent → refused · a broken agent wake → install rolled back (no package · no row) · a shipped trigger of the same id is never repointed', run: faults },
  { id: 'SUP-PLUGIN-ALL', title: 'P3: every graphs/loop-agents/<id> (15 · ⊕ supervisor-auditor ⊕ rail-canary) has plugins/<id>/plugin.yaml compiling to <id>@<agent.yaml version> and its committed plugin.json is fresh', run: all },
];
