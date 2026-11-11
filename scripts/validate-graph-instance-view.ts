/** JSON v1 schema plus cross-field identity checks that JSON Schema cannot express. */
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

const schemaPath = new URL('../plugins/graph-instance-view/schema/view-model.v1.schema.json', import.meta.url);
const schema: unknown = JSON.parse(readFileSync(schemaPath, 'utf8'));
const validateSchema = new Ajv2020({ strict: true }).compile(schema);

interface ViewRefs {
  nodes: Array<{ id: string }>;
  edges: Array<{ id: string; from: string; to: string }>;
  progress: { activeNodeIds: string[] };
  logs: Array<{ nodeId?: string }>;
}

export function graphInstanceViewIssues(value: unknown): string[] {
  if (!validateSchema(value)) return (validateSchema.errors ?? []).map(issue => `schema:${issue.instancePath || '/'}:${issue.keyword}`);
  const view = value as ViewRefs;
  const issues: string[] = [];
  const nodeIds = new Set<string>();
  for (const node of view.nodes) {
    if (nodeIds.has(node.id)) issues.push(`duplicate-node-id:${node.id}`);
    nodeIds.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of view.edges) {
    if (edgeIds.has(edge.id)) issues.push(`duplicate-edge-id:${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.from)) issues.push(`missing-edge-from:${edge.id}`);
    if (!nodeIds.has(edge.to)) issues.push(`missing-edge-to:${edge.id}`);
  }
  for (const id of view.progress.activeNodeIds) if (!nodeIds.has(id)) issues.push(`missing-active-node:${id}`);
  for (const [index, log] of view.logs.entries()) if (log.nodeId !== undefined && !nodeIds.has(log.nodeId)) issues.push(`missing-log-node:${index}`);
  return issues;
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) { console.error('usage: bun scripts/validate-graph-instance-view.ts <view.json>...'); process.exitCode = 2; }
  for (const path of paths) {
    try {
      const issues = graphInstanceViewIssues(JSON.parse(readFileSync(path, 'utf8')));
      if (issues.length) { console.error(`${path}: ${issues.join(', ')}`); process.exitCode = 1; }
      else console.log(`${path}: ok`);
    } catch { console.error(`${path}: unreadable or invalid JSON`); process.exitCode = 1; }
  }
}
