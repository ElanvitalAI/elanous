import { basename } from 'node:path';
import { debug } from '../../debug/log.js';
import { OUTPUT_KINDS } from '../../exec-requests/default-outputs.js';
import { listOutputs } from '../../outputs/ledger.js';
import { jsonResponse } from './json-response.js';

export interface OutputsDeps {
  list?: typeof listOutputs;
}

export function handleOutputsGet(req: Request, deps: OutputsDeps = {}): Response {
  const params = new URL(req.url).searchParams;
  const rawLimit = params.get('limit');
  if (rawLimit !== null && (!/^[1-9]\d*$/.test(rawLimit) || Number(rawLimit) > 200)) {
    return jsonResponse({ error: 'invalid_limit' }, 400);
  }
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  const rawSource = params.get('source');
  if (rawSource !== null && rawSource !== 'exec' && rawSource !== 'field-reel' && rawSource !== 'field-feed') {
    return jsonResponse({ error: 'invalid_source' }, 400);
  }
  const source = rawSource ?? undefined;
  const rawSince = params.get('since');
  if (rawSince !== null && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(rawSince)
    || !Number.isFinite(Date.parse(rawSince))
    || !Number.isFinite(Date.parse(`${rawSince.slice(0, 10)}T00:00:00Z`))
    || new Date(`${rawSince.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== rawSince.slice(0, 10))) {
    return jsonResponse({ error: 'invalid_since' }, 400);
  }
  const since = rawSince ? new Date(rawSince).toISOString() : undefined;
  const rows = (deps.list ?? listOutputs)({ limit, ...(source ? { source } : {}), ...(since ? { since } : {}) });
  const outputs = rows.map(({ kind, title, path, url, source: entrySource, seat, at }) => ({
    kind,
    kindLabel: kind === 'file' ? '파일' : OUTPUT_KINDS[kind]?.cardTitle ?? '파일',
    title,
    ...(path ? { fileName: basename(path) } : {}),
    ...(url ? { url } : {}),
    source: entrySource,
    ...(seat ? { seat } : {}),
    at,
  }));
  debug.log('outputs.route', 'listed', { count: outputs.length, source, limit });
  return jsonResponse({ outputs });
}
