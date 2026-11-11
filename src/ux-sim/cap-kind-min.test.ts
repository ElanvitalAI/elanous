import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from '../graph-runner/runner.js';
import { CAPABILITY_NAMES, registerGraphCapabilityProvider, type GraphCapabilityProvider } from '../graph-runner/capabilities.js';

type ScrapKind = 'text' | 'web' | 'x' | 'youtube' | 'voice' | 'video' | 'photo';
interface SimScrap { id: string; memberId: string; kind: ScrapKind; raw: { text?: string; url?: string; mediaRef?: string } }
const FAKE_SCRAPS: readonly SimScrap[] = [
  { id: 'text', memberId: 'member-a', kind: 'text', raw: { text: 'fixture note' } },
  { id: 'web', memberId: 'member-a', kind: 'web', raw: { url: 'https://example.test/article' } },
  { id: 'x', memberId: 'member-a', kind: 'x', raw: { url: 'https://x.com/example/status/1' } },
  { id: 'youtube', memberId: 'member-a', kind: 'youtube', raw: { url: 'https://youtube.com/watch?v=fixture' } },
  { id: 'voice', memberId: 'member-a', kind: 'voice', raw: { mediaRef: 'member-a/audio/1' } },
  { id: 'video', memberId: 'member-a', kind: 'video', raw: { mediaRef: 'member-a/video/1' } },
  { id: 'photo', memberId: 'member-a', kind: 'photo', raw: { mediaRef: 'member-a/image/1' } },
  { id: 'private', memberId: 'member-b', kind: 'text', raw: { text: 'private fixture' } },
];

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function graphFor(root: string, capabilities: readonly string[]): string {
  const graph = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  const nodes = capabilities.map((capability, index) => `  - { node_id: invoke-${index}, kind: capability, recipe: 'cap:${capability}', max_visits: 1 }`).join('\n');
  const edges = capabilities.map((_capability, index) => {
    const next = index + 1 < capabilities.length ? `invoke-${index + 1}` : 'done';
    return `  - { from: invoke-${index}, on: outcome, map: { done: ${next}, failed: failed } }`;
  }).join('\n');
  writeFileSync(graph, `graph_id: cap-kind-min\nversion: 1\nentry_node: invoke-0\nterminal_nodes: [done, failed]\nnodes:\n${nodes}\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n${edges}\n`);
  return graph;
}

test('fake capability world runs store and extract through runGraph for all seven scraps', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cap-kind-min-sim-'));
  roots.push(root);
  const inbox = new Map<string, SimScrap>();
  const store: GraphCapabilityProvider = async ({ input }) => {
    const scrap = input as SimScrap;
    if (!inbox.has(scrap.id)) inbox.set(scrap.id, structuredClone(scrap));
    return { ok: true, outcome: 'done', evidence: { id: scrap.id } };
  };
  const extract: GraphCapabilityProvider = async ({ input }) => {
    const scrap = input as SimScrap;
    const title = scrap.raw.text?.trim().slice(0, 80) || `${scrap.kind} fixture extraction`;
    return { ok: true, outcome: 'done', evidence: { title, kind: scrap.kind } };
  };

  for (const scrap of FAKE_SCRAPS.filter((item) => item.memberId === 'member-a')) {
    const graph = graphFor(root, ['store', 'extract']);
    const capabilityProviders = registerGraphCapabilityProvider(
      registerGraphCapabilityProvider({}, 'store', store), 'extract', extract,
    );
    const state = await runGraph(graph, { input: scrap, quiet: true, deps: { root: join(root, `state-${scrap.id}`), capabilityProviders } });
    expect(state.status).toBe('done');
    expect(state.path).toEqual(['invoke-0', 'invoke-1', 'done']);
    expect(JSON.parse(state.nodes[1]!.output as string).evidence.kind).toBe(scrap.kind);
  }
  expect([...inbox.values()].filter((item) => item.memberId === 'member-a')).toHaveLength(7);
  expect([...inbox.values()].filter((item) => item.memberId === 'member-b')).toHaveLength(0);
  expect(CAPABILITY_NAMES).toHaveLength(9);
});

test('known but unprovided capability fails closed with an explicit unprovided result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cap-kind-unprovided-sim-'));
  roots.push(root);
  const graph = graphFor(root, ['stt']);
  const state = await runGraph(graph, { quiet: true, deps: { root: join(root, 'state') } });
  expect(state.status).toBe('failed');
  expect(state.path).toEqual(['invoke-0', 'failed']);
  expect(state.nodes[0]).toMatchObject({ ok: false, error: 'unprovided' });
  expect(JSON.parse(state.nodes[0]!.output as string)).toMatchObject({ outcome: 'failed', error: 'unprovided' });
});

test('unknown capability names are rejected before execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cap-kind-unknown-sim-'));
  roots.push(root);
  const graph = graphFor(root, ['absorb-specific-name']);
  await expect(runGraph(graph, { quiet: true, deps: { root: join(root, 'state') } }))
    .rejects.toThrow('unknown graph capability for invoke-0: absorb-specific-name');
});
