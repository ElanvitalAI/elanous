// NEXUS · /v1/nexus/templates routes (Phase N-3 PR κ)

import type { TabRegistry } from '../state/tab-registry.js';
import { jsonResponse } from './json-response.js';
import {
  listTemplates,
  loadTemplate,
  saveTemplate,
  type NexusTemplate,
  TEMPLATE_VERSION,
} from '../templates/loader.js';
import { snapshotRegistryAsEntries } from '../templates/apply.js';

export function handleTemplatesList(): Response {
  return jsonResponse({ templates: listTemplates() }, 200);
}

export function handleTemplateGet(name: string): Response {
  const template = loadTemplate(name);
  if (!template) return jsonResponse({ error: 'template-not-found', name }, 404);
  return jsonResponse({ template }, 200);
}

interface SaveTemplateBody {
  name?: string;
  description?: string;
  /** When false, only the registry snapshot is used. When omitted,
   *  defaults to true → snapshot the live registry. */
  fromRegistry?: boolean;
  /** Optional explicit tabs override (e.g., for a curated save). */
  tabs?: NexusTemplate['tabs'];
}

export async function handleTemplateSave(req: Request, registry: TabRegistry): Promise<Response> {
  let body: SaveTemplateBody;
  try {
    body = (await req.json()) as SaveTemplateBody;
  } catch {
    return jsonResponse({ error: 'invalid-json' }, 400);
  }
  if (!body.name || body.name.length === 0) {
    return jsonResponse({ error: 'name-required' }, 400);
  }
  const tabs = body.tabs ?? (body.fromRegistry === false ? [] : snapshotRegistryAsEntries(registry));
  const template: NexusTemplate = {
    version: TEMPLATE_VERSION,
    name: body.name,
    description: body.description ?? '',
    tabs,
  };
  const result = saveTemplate(template);
  if (result.outcome === 'invalid-name') {
    return jsonResponse({ error: 'invalid-name', hint: '[A-Za-z0-9_-]{1,64}' }, 400);
  }
  if (result.outcome === 'builtin-conflict') {
    return jsonResponse({ error: 'builtin-conflict', name: body.name }, 409);
  }
  return jsonResponse({ saved: true, name: body.name, path: result.path }, 201);
}
