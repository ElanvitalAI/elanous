import { createHash } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseGraphTemplateYaml, type GraphTemplateSpec, type GraphUnitShape } from '../self-implement/graph-yaml.js';

export interface ShapedGraphUnit {
  readonly source: string;
  readonly template: GraphTemplateSpec;
  readonly shapeHash: string;
}

/** Apply only the shape points the unit author declared and hash the exact child source. */
export function shapeGraphUnit(source: string, unit: GraphTemplateSpec, shape: GraphUnitShape, label: string): ShapedGraphUnit {
  const points = unit.unit?.shapePoints;
  if (!points) throw new Error(`unit has no shape points: ${unit.graphId}`);
  if (shape.skip?.some(node => !points.skip?.includes(node))) throw new Error(`unit shape skip is not declared: ${unit.graphId}`);
  if (shape.recipe && Object.keys(shape.recipe).some(node => !points.recipe?.includes(node)))
    throw new Error(`unit shape recipe is not declared: ${unit.graphId}`);
  if (shape.skip?.some(node => Object.hasOwn(shape.recipe ?? {}, node)))
    throw new Error(`unit shape cannot skip and replace the same node: ${unit.graphId}`);
  if (shape.fanoutMax !== undefined && (!points.fanoutMax || shape.fanoutMax < points.fanoutMax.min || shape.fanoutMax > points.fanoutMax.max))
    throw new Error(`unit shape fanout is outside declared range: ${unit.graphId}`);

  const raw = parseYaml(source);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`unit source is not a graph map: ${label}`);
  const document = raw as Record<string, unknown>;
  if (document.apiVersion === 'elanous.dev/graph/v2') throw new Error(`unit shape requires a lowered v1 graph source: ${label}`);
  if (!Array.isArray(document.nodes) || !Array.isArray(document.edges)) throw new Error(`unit shape source has no nodes or edges: ${label}`);
  let nodes = document.nodes as Record<string, unknown>[];
  let edges = document.edges as Record<string, unknown>[];

  for (const [nodeId, recipe] of Object.entries(shape.recipe ?? {})) {
    const node = nodes.find(candidate => candidate.node_id === nodeId);
    if (!node) throw new Error(`unit shape recipe node is missing: ${label}/${nodeId}`);
    node.recipe = recipe;
  }

  for (const nodeId of shape.skip ?? []) {
    const outgoing = edges.filter(edge => edge.from === nodeId);
    const incoming = edges.filter(edge => edge.to === nodeId ||
      (edge.map && typeof edge.map === 'object' && !Array.isArray(edge.map) && Object.values(edge.map as Record<string, unknown>).includes(nodeId)));
    const next = outgoing.length === 1 && typeof outgoing[0]?.to === 'string' ? outgoing[0].to : undefined;
    if (!next || incoming.length !== 1 || outgoing[0]?.branches !== undefined || outgoing[0]?.fallback !== undefined || outgoing[0]?.when !== undefined)
      throw new Error(`unit shape skip is not a single safe bypass: ${label}/${nodeId}`);
    const edge = incoming[0]!;
    if (edge.to === nodeId) edge.to = next;
    if (edge.map && typeof edge.map === 'object' && !Array.isArray(edge.map)) {
      edge.map = Object.fromEntries(Object.entries(edge.map as Record<string, unknown>).map(([outcome, target]) =>
        [outcome, target === nodeId ? next : target]));
    }
    nodes = nodes.filter(node => node.node_id !== nodeId);
    edges = edges.filter(candidate => candidate.from !== nodeId);
  }
  document.nodes = nodes;
  document.edges = edges;
  if (shape.skip?.length && document.unit && typeof document.unit === 'object' && !Array.isArray(document.unit)) {
    const unitHeader = document.unit as Record<string, unknown>;
    const shapePoints = unitHeader.shape_points && typeof unitHeader.shape_points === 'object' && !Array.isArray(unitHeader.shape_points)
      ? unitHeader.shape_points as Record<string, unknown> : undefined;
    if (shapePoints) {
      for (const key of ['skip', 'recipe'] as const) {
        const declared = shapePoints[key];
        if (!Array.isArray(declared)) continue;
        const remaining = declared.filter(node => !shape.skip!.includes(String(node)));
        if (remaining.length === 0) delete shapePoints[key];
        else shapePoints[key] = remaining;
      }
      if (Object.keys(shapePoints).length === 0) delete unitHeader.shape_points;
    }
  }
  if (shape.fanoutMax !== undefined) document.max_parallel_nodes = shape.fanoutMax;

  const shapedSource = stringifyYaml(document);
  const parsed = parseGraphTemplateYaml(shapedSource, label);
  if (!parsed.template || parsed.errors.length) throw new Error(`shaped unit is invalid: ${parsed.errors.map(error => error.message).join('; ')}`);
  return { source: shapedSource, template: parsed.template, shapeHash: createHash('sha256').update(shapedSource).digest('hex') };
}
