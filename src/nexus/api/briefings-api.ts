export interface BriefingApiRecord {
  readonly id: string;
  readonly memberId: string;
  readonly day: string;
  readonly topics: readonly { readonly title: string; readonly scrapIds: readonly string[]; readonly summary: string }[];
  readonly todos: readonly string[];
  readonly suggestionIds: readonly string[];
  readonly createdAt: string;
}

export interface BriefingsApiOptions {
  /** Must resolve the authenticated server session; request fields and query params are never identity. */
  readonly ownerForRequest: (request: Request) => Promise<string | null> | string | null;
  readonly getByDay: (memberId: string, day: string) => Promise<BriefingApiRecord | null> | BriefingApiRecord | null;
  readonly getById: (memberId: string, id: string) => Promise<BriefingApiRecord | null> | BriefingApiRecord | null;
}

export interface AbsorbBriefingRepository {
  getByDay(memberId: string, day: string): BriefingApiRecord | null;
  getById(memberId: string, id: string): BriefingApiRecord | null;
}

/** Read the ABSORB-2 append-only briefing JSONL without exposing suggestion rows or other members. */
export function createAbsorbBriefingRepository(root: string): AbsorbBriefingRepository {
  const file = join(root, 'intake', 'absorb-brief.jsonl');
  const read = (): BriefingApiRecord[] => {
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line): BriefingApiRecord[] => {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (typeof row.id !== 'string' || typeof row.memberId !== 'string' || typeof row.day !== 'string'
          || !Array.isArray(row.topics) || !Array.isArray(row.todos) || !Array.isArray(row.suggestionIds)
          || typeof row.createdAt !== 'string' || !('trigger' in row)) return [];
        return [row as unknown as BriefingApiRecord];
      } catch { return []; }
    });
  };
  return {
    getByDay(memberId, day) {
      return read().reverse().find((row) => row.memberId === memberId && row.day === day) ?? null;
    },
    getById(memberId, id) {
      return read().reverse().find((row) => row.memberId === memberId && row.id === id) ?? null;
    },
  };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Owner-scoped GET /v1/briefings?day= and GET /v1/briefings/:id app route. */
export function createBriefingsApi(options: BriefingsApiOptions): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    if (request.method !== 'GET') return undefined;
    const url = new URL(request.url);
    if (url.pathname !== '/v1/briefings' && !url.pathname.startsWith('/v1/briefings/')) return undefined;
    const memberId = await options.ownerForRequest(request);
    if (!memberId) return Response.json({ error: 'unauthorized' }, { status: 401 });
    let record: BriefingApiRecord | null;
    if (url.pathname === '/v1/briefings') {
      const day = url.searchParams.get('day');
      if (!day || !DAY_RE.test(day)) return Response.json({ error: 'invalid-day' }, { status: 400 });
      record = await options.getByDay(memberId, day);
      return Response.json({ briefings: record?.memberId === memberId ? [record] : [] });
    } else {
      let id: string;
      try { id = decodeURIComponent(url.pathname.slice('/v1/briefings/'.length)); }
      catch { return Response.json({ error: 'not-found' }, { status: 404 }); }
      if (!id || id.includes('/')) return Response.json({ error: 'not-found' }, { status: 404 });
      record = await options.getById(memberId, id);
    }
    return record?.memberId === memberId ? Response.json(record) : Response.json({ error: 'not-found' }, { status: 404 });
  };
}
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchAppMemberOwner } from '../apps/app-site-deploy.js';


/** Ready-to-register Nexus appRoute: supply the server-verified session owner and ABSORB state root. */
export function createAbsorbBriefingsAppRoute(input: {
  readonly root: string;
  readonly ownerForRequest: BriefingsApiOptions['ownerForRequest'];
}): (request: Request) => Promise<Response | undefined> {
  const repository = createAbsorbBriefingRepository(input.root);
  return createBriefingsApi({ ownerForRequest: input.ownerForRequest, ...repository });
}

/** Production route using the server-verified #36071 app-owner session endpoint.
 * Requests include `appSlug` as app-session scope; it selects which app-bound
 * credential is checked and never supplies the returned member identity. */
export function createVerifiedAbsorbBriefingsAppRoute(input: {
  readonly root: string;
  readonly endpointOrigin: () => string | null;
  /** Injectable only for the in-process resolver integration test. */
  readonly fetcher?: typeof fetch;
}): (request: Request) => Promise<Response | undefined> {
  const repository = createAbsorbBriefingRepository(input.root);
  return createBriefingsApi({
    ...repository,
    ownerForRequest: async (request) => {
      const appSlug = new URL(request.url).searchParams.get('appSlug')?.trim();
      const endpointOrigin = input.endpointOrigin();
      if (!appSlug || !endpointOrigin) return null;
      const owner = await fetchAppMemberOwner(request, appSlug, endpointOrigin, input.fetcher);
      return owner?.memberId ?? null;
    },
  });
}
