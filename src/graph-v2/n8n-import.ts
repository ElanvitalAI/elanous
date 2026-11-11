import { stringify as stringifyYaml } from 'yaml';

export interface N8nWorkflowUnitTarget {
  readonly call: string;
  readonly budget: number;
  readonly exits: readonly string[];
}

export interface N8nImportOptions {
  /** Maps an Execute Workflow node's workflowId to an installed graph unit. */
  readonly units: Readonly<Record<string, N8nWorkflowUnitTarget>>;
}

export class N8nImportError extends Error {
  constructor(message: string) { super(message); this.name = 'N8nImportError'; }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Import the deliberately small n8n Execute Workflow surface into graph-v2 authoring YAML. */
export function importN8nExecuteWorkflow(source: string, options: N8nImportOptions): string {
  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch (error) { throw new N8nImportError(`invalid n8n workflow JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const workflow = object(parsed);
  if (!workflow || typeof workflow.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workflow.id))
    throw new N8nImportError('workflow.id must be a safe graph id');
  if (typeof workflow.name !== 'string' || !workflow.name.trim()) throw new N8nImportError('workflow.name is required');
  const allowedWorkflowKeys = new Set(['id', 'name', 'nodes', 'connections', 'settings', 'active', 'pinData', 'versionId', 'meta', 'tags', 'staticData']);
  const unknownWorkflowKeys = Object.keys(workflow).filter((key) => !allowedWorkflowKeys.has(key));
  if (unknownWorkflowKeys.length) throw new N8nImportError(`unsupported n8n workflow fields: ${unknownWorkflowKeys.join(', ')}`);
  const connections = object(workflow.connections);
  if (workflow.connections !== undefined && (!connections || Object.keys(connections).length))
    throw new N8nImportError('P0 Execute Workflow import does not support workflow connections');
  const settings = object(workflow.settings);
  if (workflow.settings !== undefined && (!settings || Object.keys(settings).length))
    throw new N8nImportError('P0 Execute Workflow import does not support workflow settings');
  if (workflow.active !== undefined && typeof workflow.active !== 'boolean')
    throw new N8nImportError('n8n workflow active must be boolean');
  if (workflow.active === true) throw new N8nImportError('active n8n workflows must be deactivated before import');
  if (workflow.pinData !== undefined && (!object(workflow.pinData) || Object.keys(object(workflow.pinData)!).length))
    throw new N8nImportError('n8n pinData must be moved to a simulation fixture before import');
  if (workflow.staticData !== undefined && workflow.staticData !== null)
    throw new N8nImportError('n8n staticData is unsupported');
  // Source: C5 imports one Execute Workflow boundary per graph; composite graph composition is handled by v2 nodes.
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length !== 1)
    throw new N8nImportError('P0 supports a workflow containing exactly one Execute Workflow node');
  const node = object(workflow.nodes[0]);
  if (!node || typeof node.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(node.id))
    throw new N8nImportError('Execute Workflow node id must be safe');
  if (node.id === 'done' || node.id === 'failed')
    throw new N8nImportError(`Execute Workflow node id is reserved by graph terminals: ${node.id}`);
  if (node.type !== 'n8n-nodes-base.executeWorkflow')
    throw new N8nImportError(`unsupported n8n node type: ${String(node?.type)}`);
  // Source: the C5 mapping table and checked-in n8n samples support Execute Workflow typeVersion 1 only.
  if (node.typeVersion !== 1) throw new N8nImportError(`unsupported Execute Workflow typeVersion: ${String(node.typeVersion)}`);
  const allowedNodeKeys = new Set(['id', 'name', 'type', 'typeVersion', 'position', 'parameters']);
  const unknownNodeKeys = Object.keys(node).filter((key) => !allowedNodeKeys.has(key));
  if (unknownNodeKeys.length)
    throw new N8nImportError(`unsupported Execute Workflow node fields (including credentials/options): ${unknownNodeKeys.join(', ')}`);
  const parameters = object(node.parameters);
  if (!parameters) throw new N8nImportError('Execute Workflow parameters must be an object');
  const unknownParameterKeys = Object.keys(parameters).filter((key) => !['workflowId', 'contract'].includes(key));
  if (unknownParameterKeys.length)
    throw new N8nImportError(`unsupported Execute Workflow parameters: ${unknownParameterKeys.join(', ')}`);
  const workflowId = parameters?.workflowId;
  if (typeof workflowId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workflowId))
    throw new N8nImportError('Execute Workflow requires a literal parameters.workflowId; expressions are unsupported');
  const target = options.units[workflowId];
  if (!target) throw new N8nImportError(`Execute Workflow target is not an installed unit: ${workflowId}`);
  // Source: graph-v2 node budgets are positive safe integers; unit exits must be declared for exhaustive mapping.
  if (!Number.isSafeInteger(target.budget) || target.budget < 1 || !target.exits.length)
    throw new N8nImportError(`Execute Workflow target has an invalid unit declaration: ${workflowId}`);

  const declared = object(parameters.contract);
  if (parameters.contract !== undefined && (!declared || Object.keys(declared).some((key) => !['inputs', 'outputs'].includes(key))))
    throw new N8nImportError('Execute Workflow contract may contain only inputs and outputs');
  const validContractFields = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 &&
    value.every((item) => typeof item === 'string' && /^[A-Za-z][A-Za-z0-9_.-]*$/.test(item));
  if (declared && (!validContractFields(declared.inputs) || !validContractFields(declared.outputs)))
    throw new N8nImportError('Execute Workflow contract inputs/outputs must be non-empty lists of safe field names');
  const inputs = declared ? declared.inputs as string[] : ['ask'];
  const outputs = declared ? declared.outputs as string[] : ['result', 'evidence'];
  // The n8n node id is retained as the stable graph node identity. n8n expressions,
  // Code nodes, credential values, and unrecognized executable node surfaces are rejected.
  const terminal = 'done';
  const failureTerminal = 'failed';
  const edgeMap = Object.fromEntries(target.exits.map((exit) => [exit, exit === 'done' ? terminal : failureTerminal]));
  const workflowMetadata = Object.fromEntries(Object.entries(workflow).filter(([key]) =>
    !['id', 'name', 'nodes', 'connections'].includes(key)));
  const nodeMetadata = Object.fromEntries(Object.entries(node).filter(([key]) =>
    ['name', 'typeVersion', 'position'].includes(key)));
  return stringifyYaml({
    apiVersion: 'elanous.dev/graph/v2',
    graph: { id: workflow.id, version: '1.0.0', layer: 'flow', purpose: workflow.name,
      ext: { 'n8n.workflow': { id: workflow.id, name: workflow.name, ...workflowMetadata } } },
    entry: node.id,
    nodes: [{ id: node.id, type: 'execute', call: target.call, budget: { inner_steps: target.budget },
      contract: { inputs, tools: 'read-only', outputs }, ...(Object.keys(nodeMetadata).length ? { ext: { 'n8n.node': nodeMetadata } } : {}) }],
    edges: [{ from: node.id, on: 'outcome', map: edgeMap }],
    terminal: [terminal, failureTerminal],
  });
}
