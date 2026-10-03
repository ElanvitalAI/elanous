import { realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, sep } from 'node:path';
import { ExecRequestRunner } from '../../exec-requests/runner.js';
import type { ExecAttachment } from '../../exec-requests/store.js';
import { getElanousConfigDir } from '../../elanous-config-dir.js';
import { defaultAttachmentBaseDir } from '../../boot/attachment-store.js';
import { jsonResponse } from './json-response.js';

const mime: Record<string, string> = {
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

function resolveAttachment(path: string, roots: string[]): string | null {
  if (!isAbsolute(path)) return null;
  try {
    const real = realpathSync(path);
    if (!statSync(real).isFile()) return null;
    return roots.some(root => {
      try {
        const base = realpathSync(root);
        return real.startsWith(`${base}${sep}`);
      } catch { return false; }
    }) ? real : null;
  } catch { return null; }
}

export async function handleExecRequests(req: Request, runner: ExecRequestRunner, uploadDir = defaultAttachmentBaseDir(), fieldDir = join(getElanousConfigDir(), 'field')): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path === '/v1/exec-requests') {
    if (req.method === 'POST') {
      let body: unknown;
      try { body = await req.json(); } catch { return jsonResponse({ error: 'bad_request' }, 400); }
      const text = body && typeof body === 'object' && !Array.isArray(body) ? (body as { text?: unknown }).text : undefined;
      if (typeof text !== 'string' || !text.trim()) return jsonResponse({ error: 'bad_request', reason: 'text required' }, 400);
      const supplied = (body as { attachments?: unknown }).attachments;
      if (supplied !== undefined && (!Array.isArray(supplied) || supplied.some(entry =>
        !entry || typeof entry !== 'object' || Array.isArray(entry)
        || typeof entry.name !== 'string' || !entry.name.trim() || typeof entry.path !== 'string'))) {
        return jsonResponse({ error: 'bad_request', reason: 'attachments must be [{name,path}]' }, 400);
      }
      const roots = [uploadDir, fieldDir];
      const resolved: Array<{ name: string; path: string | null }> | undefined = supplied?.map((entry: ExecAttachment) => ({
        name: entry.name, path: resolveAttachment(entry.path, roots),
      }));
      if (resolved?.some(entry => !entry.path)) return jsonResponse({ error: 'attachment-outside' }, 400);
      const attachments: ExecAttachment[] | undefined = resolved?.map(entry => ({ name: entry.name, path: entry.path! }));
      const item = runner.submit(text.trim(), attachments);
      return jsonResponse({ id: item.id, status: 'planning' }, 202);
    }
    if (req.method === 'GET') return jsonResponse({ items: runner.store.list().map(item => {
      const current = runner.get(item.id) ?? item;
      return { id: current.id, text: current.text, createdAt: current.createdAt, status: current.status,
        seats: current.seats.map(({ seat, title, status }) => ({ seat, title, status })), resultCount: current.results.length };
    }) });
    return jsonResponse({ error: 'method-not-allowed' }, 405);
  }
  const file = /^\/v1\/exec-requests\/([^/]+)\/files\/([^/]+)$/.exec(path);
  if (file) {
    if (req.method !== 'GET') return jsonResponse({ error: 'method-not-allowed' }, 405);
    let id: string, name: string;
    try { id = decodeURIComponent(file[1]!); name = decodeURIComponent(file[2]!); }
    catch { return jsonResponse({ error: 'not-found' }, 404); }
    const path = runner.file(id, name);
    if (!path) return jsonResponse({ error: 'not-found' }, 404);
    return new Response(Bun.file(path), { headers: { 'content-type': mime[extname(path).toLowerCase()] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' } });
  }
  const detail = /^\/v1\/exec-requests\/([^/]+)$/.exec(path);
  if (detail) {
    if (req.method !== 'GET') return jsonResponse({ error: 'method-not-allowed' }, 405);
    let id: string;
    try { id = decodeURIComponent(detail[1]!); } catch { return jsonResponse({ error: 'not-found' }, 404); }
    const item = runner.get(id);
    if (!item) return jsonResponse({ error: 'not-found' }, 404);
    const { seats, ...rest } = item;
    return jsonResponse({ ...rest, seats: seats.map(({ seat, title, status, graphId, runId, reason }) =>
      ({ seat, title, status, graphId, runId, ...(reason ? { reason } : {}) })) });
  }
  return jsonResponse({ error: 'not-found' }, 404);
}
