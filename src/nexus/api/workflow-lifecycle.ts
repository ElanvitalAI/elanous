/**
 * `GET/PUT /v1/workflows/:name/lifecycle` — M4-6 publish/draft surface.
 *
 * Sibling to the existing `/v1/workflows/<name>/chat-config` GET-only
 * endpoint. Reads/writes the `.lifecycle.json` side-file in the global
 * workflow dir. Default status is 'active' — missing entries mean
 * the workflow was never marked draft.
 *
 * Cross-ref:
 *   src/workflow-runtime/lifecycle.ts (read/write helpers)
 */
import {
  findWorkflow,
} from '../../workflow-runtime/index.js';
import {
  isWorkflowLifecycleStatus,
  readWorkflowLifecycle,
  setWorkflowLifecycle,
} from '../../workflow-runtime/lifecycle.js';

import { checkAuth, type MetaApiOpts } from './meta-api.js';
import { jsonResponse } from './json-response.js';

interface LifecycleBody {
  status?: string;
}

export function handleWorkflowLifecycleGet(
  req: Request,
  workflowName: string,
  opts: MetaApiOpts,
): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!workflowName) return jsonResponse({ error: 'missing_workflow_name' }, 400);
  const status = readWorkflowLifecycle(workflowName);
  return jsonResponse({ workflow: workflowName, status }, 200);
}

export async function handleWorkflowLifecyclePut(
  req: Request,
  workflowName: string,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!workflowName) return jsonResponse({ error: 'missing_workflow_name' }, 400);
  // M4-6 dogfood follow-up — PUT was accepting any name and writing
  // a dangling entry into `.lifecycle.json`, which over time would
  // bloat the side-file with names for workflows that never existed
  // (typos, half-renamed files, stale CLI snippets). Reject before
  // the write so the side-file stays in sync with the workflow set.
  if (!findWorkflow(workflowName)) {
    return jsonResponse({ error: 'workflow_not_found', workflow: workflowName }, 404);
  }
  let body: LifecycleBody;
  try {
    body = (await req.json()) as LifecycleBody;
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }
  if (!isWorkflowLifecycleStatus(body.status)) {
    return jsonResponse({
      error: 'invalid_status',
      reason: "status must be 'draft' or 'active'",
    }, 400);
  }
  const result = setWorkflowLifecycle(workflowName, body.status);
  return jsonResponse({
    workflow: workflowName,
    ...result,
  }, 200);
}
