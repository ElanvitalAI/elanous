import { parseViewQuery, projectView, liveLedgers, type ViewLedgers } from './project-ledgers.js';
import { graphInstanceViewIssues } from '../../../scripts/validate-graph-instance-view.js';
import { graphInstanceViewVersion } from './view-model.js';

/** Read-only HTTP handler. Authentication is enforced at the Nexus dispatch boundary. */
export function handleGraphInstanceViewGet(req: Request, context: { operator: boolean }, ledgers: ViewLedgers = liveLedgers): Response {
  if (req.method !== 'GET') return Response.json({ error: 'method-not-allowed' }, { status: 405 });
  const query = parseViewQuery(new URL(req.url));
  if (!query) return Response.json({ error: 'invalid-query' }, { status: 400 });
  if (query.source === 'resource' && !context.operator) return Response.json({ error: 'forbidden' }, { status: 403 });
  try {
    const view = projectView(query, ledgers);
    if (!view) return Response.json({ error: 'not-found' }, { status: 404 });
    if (view.schemaVersion !== graphInstanceViewVersion() || graphInstanceViewIssues(view).length) return Response.json({ error: 'invalid-view' }, { status: 503 });
    const response = Response.json(view);
    response.headers.set('cache-control', 'no-store');
    response.headers.set('x-graph-instance-view-version', String(graphInstanceViewVersion()));
    return response;
  } catch {
    return Response.json({ error: 'ledger-unavailable' }, { status: 503 });
  }
}
