import { CardStore } from '../../task-cards/card-store.js';
import { jsonResponse } from './json-response.js';

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
