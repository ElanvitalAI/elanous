/** Host graph-run transport for the small C2 map. No Pod or write authority is implied. */
import { resolve } from 'node:path';
import { lastJsonObject, runGraph, type GraphRunOptions, type GraphRunState } from '../graph-runner/runner.js';
import type { MapCard, MapContext, MapItem } from './map-reduce.js';
import type { MapRecipe, MapRunRow } from './map-run-ledger.js';

export interface HostMapItem extends MapItem {
  /** Immutable, complete recipe input captured with the inventory, not a display title. */
  graphInput: Record<string, unknown>;
}
export interface MapHostPorts {
  recipeRoot: string;
  run?: (path: string, options: GraphRunOptions) => Promise<GraphRunState>;
}

const EMITTERS: Record<MapRecipe, ReadonlySet<string>> = {
  'green-close': new Set(['result']),
  'draft-close': new Set(['harvest', 'close-candidate', 'hold']),
};
const SHA = /^[a-f0-9]{40}$/i;
function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((part) => typeof part === 'string') ? value as string[] : null;
}
function hold(card: MapCard, reason: string, graph?: GraphRunState): MapRunRow {
  return { event: 'row', mapRunId: card.mapRunId, itemId: card.itemId, recipe: card.recipe,
    kind: 'hold', verdict: 'hold', reason, evidence: [],
    ...(graph ? { startedAt: graph.startedAt ?? null, endedAt: graph.finishedAt ?? null,
      result: { cardId: card.id, transport: 'host-graph-run', graphRunId: graph.runId,
        graphStatePath: graph.statePath, sourceHash: graph.sourceHash ?? null } } : {}) };
}
function validInput(card: MapCard, item: HostMapItem): boolean {
  const input = item.graphInput;
  if (card.itemId !== item.id || !input || typeof input !== 'object' || Array.isArray(input)) return false;
  if (card.recipe === 'green-close') {
    const main = obj(input.main);
    return input.cellId === item.id && typeof input.version === 'string' && !!input.version
      && main?.ref === 'origin/main' && typeof main.sha === 'string' && SHA.test(main.sha)
      && Array.isArray(input.paths) && input.paths.length > 0 && strings(input.paths) !== null
      && Array.isArray(input.candidates) && input.candidates.length === 1;
  }
  const draft = obj(input.item);
  const inventory = obj(input.inventory);
  return input.mapRunId === card.mapRunId && input.inventoryComplete === true
    && typeof input.snapshotTime === 'string' && !!input.snapshotTime
    && typeof input.mainSha === 'string' && SHA.test(input.mainSha)
    && inventory?.complete === true && inventory.snapshotTime === input.snapshotTime
    && inventory.mainSha === input.mainSha && draft !== null
    && Number.isSafeInteger(draft.pr) && Number(draft.pr) > 0
    && item.id === `pr-${draft.pr}` && typeof draft.headOid === 'string' && SHA.test(draft.headOid);
}
function emitterResult(graph: GraphRunState, recipe: MapRecipe): Record<string, unknown> | null {
  const emitter = [...graph.nodes].reverse().find((node) => node.executed && EMITTERS[recipe].has(node.nodeId));
  if (!emitter?.ok || emitter.exit !== 0) return null;
  return lastJsonObject(emitter.output) ?? obj(emitter.output);
}
function convertGreen(card: MapCard, input: Record<string, unknown>, graph: GraphRunState, output: Record<string, unknown>): MapRunRow | null {
  if (output.outcome !== 'ok' || output.cellId !== card.itemId || output.version !== input.version
    || typeof output.reason !== 'string' || !strings(output.evidence)) return null;
  const kind = output.kind;
  if (kind !== 'green-candidate' && kind !== 'mock-pr' && kind !== 'implementation-remains' && kind !== 'hold') return null;
  const base: MapRunRow = { event: 'row', mapRunId: card.mapRunId, itemId: card.itemId, recipe: card.recipe,
    kind, verdict: kind, reason: output.reason, evidence: output.evidence as string[] };
  if (kind !== 'green-candidate') return base;
  const e1 = graph.nodes.find((node) => node.nodeId === 'e1');
  const e2 = graph.nodes.find((node) => node.nodeId === 'e2');
  const e3 = graph.nodes.find((node) => node.nodeId === 'e3');
  const produce = graph.nodes.find((node) => node.nodeId === 'produce');
  const boundary = graph.nodes.find((node) => node.nodeId === 'boundary');
  const p1 = e1 && (lastJsonObject(e1.output) ?? obj(e1.output));
  const p2 = e2 && (lastJsonObject(e2.output) ?? obj(e2.output));
  const p3 = e3 && (lastJsonObject(e3.output) ?? obj(e3.output));
  const produced = produce && (lastJsonObject(produce.output) ?? obj(produce.output));
  const p4 = boundary && (lastJsonObject(boundary.output) ?? obj(boundary.output));
  const candidate = obj((input.candidates as unknown[])[0]);
  const prUrl = candidate?.prUrl;
  if (p1?.outcome !== 'pass' || p2?.outcome !== 'pass' || p3?.outcome !== 'pass'
    || produced?.outcome !== 'pass' || p4?.outcome !== 'pass'
    || produced.proofRef !== `boundary-proofs/${card.itemId}/${graph.runId}.json`
    || input.mapRunId !== card.mapRunId || input.cardId !== card.id
    || !SHA.test(String(p1.mergeSha ?? '')) || p1.mergeSha !== output.mergeSha
    || !Number.isSafeInteger(p1.pr) || p1.pr !== output.pr || candidate?.pr !== p1.pr
    || typeof prUrl !== 'string' || !prUrl
    || typeof p2.command !== 'string' || !p2.command.trim() || p2.exitCode !== 0
    || typeof p3.reason !== 'string' || !p3.reason.trim()) return null;
  return { ...base, pr: p1.pr as number, prUrl,
    e1: { verdict: 'pass', mergeSha: p1.mergeSha as string, mainAncestor: true },
    e2: { verdict: 'pass', command: p2.command, exitCode: 0 }, e2Source: 'completion-boundary',
    e3: { verdict: 'pass', reason: p3.reason } };
}
function convertDraft(card: MapCard, input: Record<string, unknown>, output: Record<string, unknown>): MapRunRow | null {
  const row = obj(output.result);
  const item = obj(input.item);
  if (output.outcome !== 'done' || !row || !item || row.mapRunId !== card.mapRunId
    || row.snapshotTime !== input.snapshotTime || row.pr !== item.pr || row.headOid !== item.headOid
    || !strings(row.evidence) || typeof row.reason !== 'string') return null;
  const kind = row.kind;
  if (kind !== 'harvest' && kind !== 'close-candidate' && kind !== 'hold') return null;
  return { event: 'row', mapRunId: card.mapRunId, itemId: card.itemId, recipe: card.recipe,
    kind, verdict: kind, reason: row.reason, evidence: row.evidence as string[],
    pr: row.pr as number, headOid: row.headOid as string };
}

/** mapInventory owns the two-worker bound and the only ledger append. */
export function createMapHostLauncher(ports: MapHostPorts):
  (card: MapCard, item: HostMapItem, context: MapContext) => Promise<MapRunRow> {
  return async (card, item, context) => {
    if (context.dryRun || context.mapRunId !== card.mapRunId || context.recipe !== card.recipe || !validInput(card, item))
      return hold(card, 'host-map-input-mismatch');
    const recipePath = resolve(ports.recipeRoot, `${card.recipe}.yaml`);
    let graph: GraphRunState;
    const boundInput = card.recipe === 'green-close'
      ? { ...item.graphInput, mapRunId: card.mapRunId, cardId: card.id } : item.graphInput;
    try { graph = await (ports.run ?? runGraph)(recipePath, { input: boundInput, quiet: true, dryRun: false }); }
    catch { return hold(card, 'host-graph-launch-failed'); }
    const expectedGraphId = card.recipe === 'green-close' ? 'green-close' : 'work-draft-close';
    if (graph.graphId !== expectedGraphId || graph.graphPath !== recipePath || !graph.runId
      || graph.dryRun || JSON.stringify(graph.input) !== JSON.stringify(boundInput))
      return hold(card, 'host-graph-provenance-mismatch', graph);
    if (graph.status !== 'done') return hold(card, 'host-graph-not-done', graph);
    const output = emitterResult(graph, card.recipe);
    if (!output) return hold(card, 'host-graph-result-missing', graph);
    const row = card.recipe === 'green-close'
      ? convertGreen(card, boundInput, graph, output)
      : convertDraft(card, item.graphInput, output);
    if (!row || (row.kind !== 'hold' && row.evidence.length === 0) || (row.kind === 'hold' && !row.reason.trim()))
      return hold(card, 'host-graph-result-invalid', graph);
    return { ...row, startedAt: graph.startedAt ?? null, endedAt: graph.finishedAt ?? null, rc: 0,
      result: { cardId: card.id, transport: 'host-graph-run', graphRunId: graph.runId,
        graphStatePath: graph.statePath, sourceHash: graph.sourceHash ?? null, recipePath } };
  };
}
