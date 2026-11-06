/**
 * `GET/PUT/DELETE /v1/workflows/:name/pins[/:nodeId]` — M4-4 pin data
 * endpoints.
 *
 * Sibling to /lifecycle (M4-6). Pin data lets the user store a fake
 * node output for debugging — the executor seam that consumes them
 * is M4-4.2. v1 ships read/write/clear surfaces.
 *
 *   GET    /v1/workflows/:name/pins            → all pins for workflow
 *   GET    /v1/workflows/:name/pins/:nodeId    → single pin
 *   PUT    /v1/workflows/:name/pins/:nodeId    { value, note? }
 *   DELETE /v1/workflows/:name/pins            → wipe all
 *   DELETE /v1/workflows/:name/pins/:nodeId    → wipe one
 */
import {
  clearWorkflowPins,
  listWorkflowPins,
  setWorkflowPin,
  type PinValue,
} from '../../workflow-runtime/pin-data.js';

import { checkAuth, type MetaApiOpts } from './meta-api.js';
import { jsonResponse } from './json-response.js';

export function handleWorkflowPinsList(
  req: Request,
  workflowName: string,
  opts: MetaApiOpts,
): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!workflowName) return jsonResponse({ error: 'missing_workflow_name' }, 400);
  const pins = listWorkflowPins(workflowName);
  return jsonResponse({ workflow: workflowName, pins }, 200);
}

export function handleWorkflowPinGet(
  req: Request,
  workflowName: string,
  nodeId: string,
  opts: MetaApiOpts,
): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!workflowName || !nodeId) {
    return jsonResponse({ error: 'missing_workflow_or_node' }, 400);
  }
  const pins = listWorkflowPins(workflowName);
  const entry = pins[nodeId];
  if (!entry) return jsonResponse({ error: 'not_found' }, 404);
  return jsonResponse({ workflow: workflowName, pin: entry }, 200);
}

interface PutPinBody {
  value?: PinValue;
  note?: string;
}

export async function handleWorkflowPinPut(
  req: Request,
  workflowName: string,
  nodeId: string,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!workflowName || !nodeId) {
    return jsonResponse({ error: 'missing_workflow_or_node' }, 400);
  }
  let body: PutPinBody;
  try {
    body = (await req.json()) as PutPinBody;
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }
  if (body.value === undefined) {
    return jsonResponse({ error: 'value_required' }, 400);
  }
  const result = setWorkflowPin(
    workflowName,
    nodeId,
    body.value,
    body.note !== undefined ? { note: body.note } : {},
  );
  if (!result.ok) {
    return jsonResponse({ error: result.error ?? 'set_failed' }, 400);
  }
  return jsonResponse({
    workflow: workflowName,
    pin: result.entry,
  }, 200);
}

export function handleWorkflowPinDelete(
  req: Request,
  workflowName: string,
  nodeId: string | undefined,
  opts: MetaApiOpts,
): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!workflowName) return jsonResponse({ error: 'missing_workflow_name' }, 400);
  const removed = clearWorkflowPins(workflowName, nodeId);
  return jsonResponse({ workflow: workflowName, removed }, 200);
}
