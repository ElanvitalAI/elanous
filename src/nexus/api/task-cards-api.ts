import { CardStore } from '../../task-cards/card-store.js';
import { createWishCard } from '../../intake-plane/wish-card.js';
import { jsonResponse } from './json-response.js';

export async function handleTaskCardsWishPost(req: Request, root?: string): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: 'bad_request' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse({ error: 'bad_request' }, 400);
  const { text, ref } = body as Record<string, unknown>;
  if (typeof text !== 'string' || !text.trim() || typeof ref !== 'string' || !ref.trim()) {
    return jsonResponse({ error: 'bad_request' }, 400);
  }
  const store = new CardStore(root);
  try {
    const card = createWishCard({ text, source: 'pwa', ref }, store);
    return jsonResponse(card, card.created ? 201 : 200);
  } finally {
    store.close();
  }
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
    return card ? jsonResponse({ card }) : jsonResponse({ error: 'not_found' }, 404);
  } finally {
    store.close();
  }
}
