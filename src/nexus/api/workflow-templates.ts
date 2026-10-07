// Surface-unification ROADMAP §F2 (2026-05-11) — workflow template
// catalog endpoint. PWA "+ New" modal picks one + copies into the
// user's workflow folder via the regular PUT /v1/workflows/<name>.

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { debug } from '../../debug/log.js';
import { jsonResponse } from './http-server.js';
import { checkAuth, type MetaApiOpts } from './meta-api.js';

interface WorkflowTemplateEntry {
  /** Filename stem — `chat-driven-research`. */
  id: string;
  /** Human title from `_meta.template.title` (best-effort grep). */
  title: string;
  /** Human description. */
  description: string;
  /** Tags (search / filter). */
  tags: string[];
  /** Raw YAML body — embedded so the PWA picker copies it without an
   *  extra round-trip. */
  yaml: string;
}

function findTemplateDir(): string {
  // The samples folder ships alongside the daemon. The daemon CWD
  // varies by launcher, so we resolve from `import.meta.dir` and
  // climb to repo root (../../../samples/workflows/templates).
  return join(import.meta.dir, '..', '..', '..', 'samples', 'workflows', 'templates');
}

function parseMeta(yaml: string): { title: string; description: string; tags: string[] } {
  // Lightweight grep — we don't want to pull in a full YAML parser
  // for the picker's metadata block. _meta.template entries follow a
  // stable `key: value` shape per F1 templates.
  const title = /^\s+title:\s*(.+)$/m.exec(yaml)?.[1]?.trim() ?? '';
  const description = /^\s+description:\s*(.+)$/m.exec(yaml)?.[1]?.trim() ?? '';
  const tagsRaw = /^\s+tags:\s*\[(.+)\]$/m.exec(yaml)?.[1] ?? '';
  const tags = tagsRaw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return { title, description, tags };
}

export function listTemplateCatalog(dir = findTemplateDir()): WorkflowTemplateEntry[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  } catch {
    // An installed package without this folder used to answer «No templates available» silently (10-06 · files list).
    debug.log('nexus.workflow-templates', 'template-dir-missing', { dir });
    return [];
  }
  const out: WorkflowTemplateEntry[] = [];
  for (const f of files.sort()) {
    const yaml = readFileSync(join(dir, f), 'utf-8');
    const id = f.replace(/\.yaml$/, '');
    const meta = parseMeta(yaml);
    out.push({
      id,
      title: meta.title || id,
      description: meta.description || '',
      tags: meta.tags,
      yaml,
    });
  }
  return out;
}

export async function handleWorkflowTemplatesList(
  req: Request,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  return jsonResponse({ templates: listTemplateCatalog() }, 200);
}
