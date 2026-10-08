// RELEASE-LEDGER-UNIVERSE (0.2.20 P0) — a node subprocess launched by a graph from a non-leader tree writes its
// ledger and logs into the run's (parent's) universe when the run pins it, and re-resolves its own tree-derived
// universe when it does not (the 10-07 incident: wt-release nodes wrote to ⟨test:wt-release⟩ while the run was prod).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runGraph } from './runner.js';
import { releaseRunUniverse } from '../../scripts/release-loop/release-universe.js';

setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, '../..');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(): { graph: string; parent: string; tree: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'graph-child-universe-')));
  dirs.push(base);
  const parent = join(base, 'parent-universe');
  const tree = join(base, 'wt-release');
  mkdirSync(parent, { recursive: true });
  mkdirSync(join(tree, '.git'), { recursive: true }); // a non-leader source tree
  mkdirSync(join(tree, 'scripts'), { recursive: true });
  // The node resolves its universe the way release-loop nodes do (effectiveInstanceRoot / config dir = log store).
  writeFileSync(join(tree, 'scripts', 'probe-node.ts'), `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveInstanceRoot, releaseLedgerRoot, resolveInstance } from ${JSON.stringify(join(REPO, 'src/instance/resolve.ts'))};
import { getElanousConfigDir } from ${JSON.stringify(join(REPO, 'src/elanous-config-dir.ts'))};
const root = effectiveInstanceRoot();
const dir = join(root, 'release', '0.0.0');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'manifest.json'), '{}');
console.log(JSON.stringify({ outcome: 'ok', root, configDir: getElanousConfigDir(), releaseLedger: releaseLedgerRoot(), kind: resolveInstance({ stampedStateDir: process.env.ELANOUS_STATE_DIR }).kind }));
`);
  const graphDir = join(base, 'graph');
  mkdirSync(graphDir, { recursive: true });
  writeFileSync(join(graphDir, 'recipes.yaml'), `probe:\n  command: ${JSON.stringify(`cd ${tree} && bun scripts/probe-node.ts`)}\n`);
  const graph = join(graphDir, 'graph.yaml');
  writeFileSync(graph, `graph_id: probe-graph\nversion: 1\nentry_node: probe\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: probe, kind: agent, recipe: 'cmd:probe', max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - from: probe\n    on: outcome\n    map: { ok: done, fail: failed }\n`);
  return { graph, parent, tree };
}

async function withoutStamp<T>(body: () => Promise<T>): Promise<T> {
  // Reproduce a parent that resolved its universe without a stamp (installed copy): children inherit no ELANOUS_STATE_DIR.
  const previous = process.env.ELANOUS_STATE_DIR;
  delete process.env.ELANOUS_STATE_DIR;
  try { return await body(); } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previous;
  }
}

type Probe = { root: string; configDir: string; releaseLedger: string; kind: string };
function probeOutput(output: unknown): Probe {
  return JSON.parse(String(output).trim().split('\n').at(-1)!) as Probe;
}

test('RELEASE-LEDGER-UNIVERSE: a pinned node from a non-leader tree writes ledger and logs into the run universe', async () => {
  const { graph, parent, tree } = setup();
  const state = await withoutStamp(() => runGraph(graph, { pinChildUniverse: true, deps: { root: parent } }));
  expect(state.status).toBe('done');
  const seen = probeOutput(state.nodes.find((node) => node.nodeId === 'probe')!.output);
  expect(seen.root).toBe(parent);
  expect(seen.configDir).toBe(parent); // logs.db follows the config dir
  expect(existsSync(join(parent, 'release', '0.0.0', 'manifest.json'))).toBe(true);
  expect(existsSync(join(tree, '.elanous-test'))).toBe(false);
  expect(readFileSync(join(parent, 'release', '0.0.0', 'manifest.json'), 'utf8')).toBe('{}');
});

test('RELEASE-LEDGER-UNIVERSE: without the pin the same node re-resolves its own tree universe (the incident; other graphs unchanged)', async () => {
  const { graph, parent, tree } = setup();
  const state = await withoutStamp(() => runGraph(graph, { deps: { root: parent } }));
  expect(state.status).toBe('done');
  const seen = probeOutput(state.nodes.find((node) => node.nodeId === 'probe')!.output);
  expect(realpathSync(seen.root)).toBe(realpathSync(join(tree, '.elanous-test')));
  expect(existsSync(join(parent, 'release'))).toBe(false);
});

test('RELEASE-LEDGER-UNIVERSE: the release entry decides prod once — a wt-release node writes into the prod release ledger', async () => {
  const { graph, tree } = setup();
  const home = join(tree, '..', 'home');
  const prod = join(home, '.elanous');
  mkdirSync(prod, { recursive: true });
  const previousHome = process.env.HOME;
  process.env.HOME = home; // the node's own prodInstanceRoot() / releaseLedgerRoot() read the same machine root
  try {
    const root = releaseRunUniverse({ override: () => undefined, prodRoot: () => prod, effectiveRoot: () => prod });
    expect(root).toBe(prod);
    const state = await withoutStamp(() => runGraph(graph, { pinChildUniverse: true, deps: { root } }));
    expect(state.status).toBe('done');
    const seen = probeOutput(state.nodes.find((node) => node.nodeId === 'probe')!.output);
    expect(seen).toMatchObject({ root: prod, configDir: prod, releaseLedger: prod, kind: 'prod' });
    expect(existsSync(join(prod, 'release', '0.0.0', 'manifest.json'))).toBe(true);
    expect(existsSync(join(prod, 'graph-runs', 'probe-graph'))).toBe(true); // run ledger in the same universe
    expect(existsSync(join(tree, '.elanous-test'))).toBe(false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  }
});

test('RELEASE-LEDGER-UNIVERSE: a release entry that resolved a non-prod universe without --config-dir is refused before any node', () => {
  expect(() => releaseRunUniverse({ override: () => undefined, prodRoot: () => '/h/.elanous', effectiveRoot: () => '/h/wt-release/.elanous-test' }))
    .toThrow('release run refused');
  // An explicit --config-dir picks its own universe (isolated tests); an injected root is used as is.
  expect(releaseRunUniverse({ override: () => '/t/iso', prodRoot: () => '/h/.elanous', effectiveRoot: () => '/t/iso' })).toBe('/t/iso');
  expect(releaseRunUniverse({ root: '/t/injected', effectiveRoot: () => { throw new Error('not read'); } })).toBe('/t/injected');
});
