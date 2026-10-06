import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CardStore, type TaskCard } from '../../task-cards/card-store.js';
import { releaseLedgerRoot } from '../../instance/resolve.js';
import { createWishCard } from '../../intake-plane/wish-card.js';
import { jsonResponse } from './json-response.js';

export async function handleTaskCardsWishPost(req: Request, root?: string): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: 'bad_request' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse({ error: 'bad_request' }, 400);
  const { text, ref, sessionId } = body as Record<string, unknown>;
  if (typeof text !== 'string' || !text.trim() || typeof ref !== 'string' || !ref.trim()
    || typeof sessionId !== 'string' || !sessionId.trim()) {
    return jsonResponse({ error: 'bad_request' }, 400);
  }
  const store = new CardStore(root);
  try {
    const card = createWishCard({ text, source: 'pwa', ref, replyTo: { surface: 'pwa', sessionId } }, store);
    return jsonResponse(card, card.created ? 201 : 200);
  } finally {
    store.close();
  }
}

export async function handleTaskCardsClosePost(req: Request, id: string, root?: string): Promise<Response> {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return jsonResponse({ error: 'not_found' }, 404);
  let body: unknown;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: 'bad_request' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse({ error: 'bad_request' }, 400);
  const { reason } = body as Record<string, unknown>;
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().includes('\n') || reason.trim().includes('\r')) {
    return jsonResponse({ error: 'bad_request' }, 400);
  }
  const store = new CardStore(root);
  try {
    if (!store.getCard(id)) return jsonResponse({ error: 'not_found' }, 404);
    return jsonResponse({ card: store.closeCard(id, reason) });
  } finally {
    store.close();
  }
}

export interface WishPlacement { cellId: string; cellTitle: string; version: string; status: 'green' | 'yellow' | 'red' | 'done' }

export function isSplitCell(cell: unknown): cell is { id: string } {
  return cell !== null && typeof cell === 'object' && 'id' in cell
    && typeof cell.id === 'string' && cell.id.trim().length > 0;
}

/** Join the live checklist to the wish card by the split cell ID, never by title or card status. */
export function wishPlacements(card: TaskCard, root?: string): WishPlacement[] {
  if (!card.goalId.startsWith('wish:')) return [];
  const split = [...card.sections].reverse().find(section => section.key === 'orch:split');
  if (!split) return [];
  let cells: unknown;
  try { cells = JSON.parse(split.content); } catch { return []; }
  if (!Array.isArray(cells)) return [];
  const ids = [...new Set(cells.filter(isSplitCell).map(cell => cell.id.trim()))];
  if (!ids.length) return [];
  const ledgerRoot = root ?? releaseLedgerRoot();
  const path = join(ledgerRoot, 'release', 'features.sqlite');
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const placements: WishPlacement[] = [];
    for (const cellId of ids) {
      const rows = db.query('SELECT a.version, a.status, COALESCE(a.title_override, f.title) AS title FROM assignments a JOIN features f ON f.id = a.feature_id WHERE a.feature_id = ? ORDER BY a.version').all(cellId) as Array<{ version: string; status: string; title: string }>;
      for (const row of rows) if (['green', 'yellow', 'red', 'done'].includes(row.status)) {
        placements.push({ cellId, cellTitle: row.title, version: row.version, status: row.status as WishPlacement['status'] });
      }
    }
    return placements;
  } finally { db.close(); }
}

/** Read-only card API; route registration and authorization belong to the HTTP server. */
export function handleTaskCardsGet(pathname: string, root?: string): Response {
  if (pathname !== '/v1/task-cards' && !/^\/v1\/task-cards\/[^/]+$/.test(pathname)) {
    return jsonResponse({ error: 'not_found' }, 404);
  }

  if (pathname === '/v1/task-cards') {
    const store = new CardStore(root);
    try {
      return jsonResponse({ cards: store.listCards() });
    } finally {
      store.close();
    }
  }

  let id: string;
  try {
    id = decodeURIComponent(pathname.slice('/v1/task-cards/'.length));
  } catch {
    return jsonResponse({ error: 'not_found' }, 404);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return jsonResponse({ error: 'not_found' }, 404);

  const store = new CardStore(root);
  try {
    const card = store.getCard(id);
    return card ? jsonResponse({ card, ...(card.goalId.startsWith('wish:') ? { placements: wishPlacements(card, root) } : {}) })
      : jsonResponse({ error: 'not_found' }, 404);
  } finally {
    store.close();
  }
}
