import { isRecord } from '../../primitives/guards.js';
import type { NexusEvent } from '../state/state.js';
import type { MembersApi } from '../members/members-api.js';
import { projectMiniBoard } from '../../../apps/pwa/src/lib/mini-board-projection.js';
import type { TaskCardEntry, TaskCardSection } from '../../../apps/pwa/src/lib/task-card-model.js';
import { jsonResponse } from './json-response.js';

export type BoardCardState = 'suggested' | 'approved' | 'building' | 'testing' | 'released' | 'failed';
export type BoardCardApiState = 'proposed' | 'approved' | 'developing' | 'testing' | 'deployed' | 'failed';

export interface BoardCardAttachment {
  kind: 'diagram' | 'diagram-source' | 'pdf' | 'html';
  title: string;
  url: string;
  mime: string;
  sha256: string;
  producedBy: string;
}

export interface BoardCardEvent {
  type: 'board.card';
  cardId: string;
  memberId: string;
  state: BoardCardState;
  title: string;
  summary?: string;
  runId?: string;
  appSlug?: string;
  acceptanceId?: string;
  result?: { publicUrl?: string; simulationReceipt?: string; resultUrl?: string };
  attachments?: BoardCardAttachment[];
  at: string;
}

export interface BoardEventStore {
  /** Structural adapter for the shared store.events@1 provider instance injected by Nexus at startup. */
  query(request: { memberId: string; type: string }): Promise<readonly unknown[]>;
  scan?(request: { type: string }): Promise<readonly unknown[]>;
  append(event: unknown): Promise<void>;
  /** Emits journal changes so Nexus SSE can forward graph-produced card states. */
  subscribe?(listener: (event: unknown) => void): () => void;
}

export interface BoardApiDeps {
  store?: BoardEventStore;
  resolveOwner(request: Request): Promise<{ memberId: string; appSlug?: string } | null>;
  /** The member action is persisted before this plugin-owned dispatch seam runs. */
  dispatchApproved?: (card: BoardCardEvent, owner: { memberId: string; appSlug?: string }, existingRunId?: string) => Promise<{ acceptanceId: string; start: () => Promise<void> }>;
  publish?: (event: NexusEvent) => void;
  now?: () => number;
}

export interface BoardCardResponse {
  id: string;
  memberId: string;
  title: string;
  state: BoardCardApiState;
  progress?: string;
  summary?: string;
  reason?: string;
  runId?: string;
  resultUrl?: string;
  publicUrl?: string;
  acceptanceId?: string;
  retryable?: boolean;
  attachments?: BoardCardAttachment[];
  updatedAt: string;
}

const CARD_ID = /^[A-Za-z0-9_-]{1,160}$/;
const STATE_SECTIONS: Record<BoardCardState, TaskCardSection> = {
  suggested: 'intake', approved: 'landing', building: 'workspace', testing: 'release', released: 'release', failed: 'release',
};
const API_STATES: Record<BoardCardState, BoardCardApiState> = {
  suggested: 'proposed', approved: 'approved', building: 'developing', testing: 'testing', released: 'deployed', failed: 'failed',
};

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function safeUrl(value: unknown): string | undefined {
  const candidate = text(value);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function parseAttachments(value: unknown): BoardCardAttachment[] | undefined {
  if (!Array.isArray(value) || !value.every(item => isRecord(item)
    && ['diagram', 'diagram-source', 'pdf', 'html'].includes(String(item.kind))
    && text(item.title) && safeUrl(item.url) && text(item.mime)
    && typeof item.sha256 === 'string' && /^[a-fA-F0-9]{64}$/.test(item.sha256)
    && text(item.producedBy))) return undefined;
  return value.map(item => ({
    kind: item.kind as BoardCardAttachment['kind'], title: text(item.title)!,
    url: safeUrl(item.url)!, mime: text(item.mime)!, sha256: item.sha256 as string,
    producedBy: text(item.producedBy)!,
  }));
}

function parseBoardCardEvent(value: unknown): BoardCardEvent | undefined {
  if (!isRecord(value) || value.type !== 'board.card' || !CARD_ID.test(text(value.cardId) ?? '')
    || !text(value.memberId) || !['suggested', 'approved', 'building', 'testing', 'released', 'failed'].includes(String(value.state))
    || !text(value.title) || !text(value.at) || !Number.isFinite(Date.parse(String(value.at)))) return undefined;
  const attachments = value.attachments === undefined ? undefined : parseAttachments(value.attachments);
  if (value.attachments !== undefined && !attachments) return undefined;
  const result = value.result;
  if (result !== undefined && !isRecord(result)) return undefined;
  if (isRecord(result) && Object.entries(result).some(([key, item]) =>
    !['publicUrl', 'simulationReceipt', 'resultUrl'].includes(key) || typeof item !== 'string')) return undefined;
  for (const key of ['summary', 'runId', 'acceptanceId', 'appSlug'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return undefined;
  }
  return {
    type: 'board.card', cardId: value.cardId as string, memberId: value.memberId as string,
    state: value.state as BoardCardState, title: value.title as string,
    ...(text(value.summary) ? { summary: text(value.summary) } : {}),
    ...(text(value.runId) ? { runId: text(value.runId) } : {}),
    ...(text(value.appSlug) ? { appSlug: text(value.appSlug) } : {}),
    ...(text(value.acceptanceId) ? { acceptanceId: text(value.acceptanceId) } : {}),
    ...(attachments ? { attachments } : {}),
    ...(isRecord(result) ? { result: {
      ...(typeof result.publicUrl === 'string' ? { publicUrl: result.publicUrl } : {}),
      ...(typeof result.simulationReceipt === 'string' ? { simulationReceipt: result.simulationReceipt } : {}),
      ...(typeof result.resultUrl === 'string' ? { resultUrl: result.resultUrl } : {}),
    } } : {}),
    at: new Date(Date.parse(value.at as string)).toISOString(),
  };
}

export function boardCardNexusEvent(value: unknown): NexusEvent | undefined {
  const event = parseBoardCardEvent(value);
  if (!event) return undefined;
  const released = event.state === 'released';
  return {
    ts: Date.parse(event.at), kind: 'board.card', memberId: event.memberId,
    detail: {
      cardId: event.cardId, state: event.state, title: event.title,
      ...(event.summary ? { summary: event.summary } : {}),
      ...(event.runId ? { runId: event.runId } : {}),
      ...(event.acceptanceId ? { acceptanceId: event.acceptanceId } : {}),
      ...(event.attachments ? { attachments: event.attachments } : {}),
      ...(event.result ? { result: {
        ...(released && event.result.publicUrl ? { publicUrl: event.result.publicUrl } : {}),
        ...(released && event.result.resultUrl ? { resultUrl: event.result.resultUrl } : {}),
        ...(event.result.simulationReceipt ? { simulationReceipt: event.result.simulationReceipt } : {}),
      } } : {}),
    },
  };
}

function entryFor(event: BoardCardEvent, projectionTs = Date.parse(event.at)): TaskCardEntry {
  return {
    ts: projectionTs, taskId: event.cardId, section: STATE_SECTIONS[event.state],
    owner: event.memberId, key: `board.card:${event.state}:${event.at}`,
    ...(event.runId ? { runId: event.runId } : {}),
    data: {
      title: event.title,
      ...(event.summary ? { summary: event.summary } : {}),
      ...(event.state === 'testing' ? { status: 'testing' } : {}),
      ...(event.state === 'released' ? { status: 'done' } : {}),
      ...(event.result?.publicUrl ? { publicUrl: event.result.publicUrl } : {}),
      ...(event.result?.resultUrl ? { resultUrl: event.result.resultUrl } : {}),
    },
  };
}

function responseCards(events: readonly BoardCardEvent[]): BoardCardResponse[] {
  let projectionTs = Number.NEGATIVE_INFINITY;
  const projectionEntries = events.map(event => {
    projectionTs = Math.max(Date.parse(event.at), projectionTs + 1);
    return entryFor(event, projectionTs);
  });
  const projected = projectMiniBoard(projectionEntries);
  const latestById = new Map<string, BoardCardEvent>();
  for (const event of events) latestById.set(event.cardId, event);
  return Object.values(projected.columns).flatMap(cards => cards.map(projectedCard => {
    const latest = latestById.get(projectedCard.taskId)!;
    const cardEvents = events.filter(event => event.cardId === latest.cardId);
    const latestText = (field: 'summary' | 'runId') =>
      [...cardEvents].reverse().map(event => text(event[field])).find(Boolean);
    const released = latest.state === 'released';
    const publicUrl = released
      ? [...cardEvents].reverse().map(event => safeUrl(event.result?.publicUrl)).find(Boolean)
      : undefined;
    const attachments = [...cardEvents].reverse().find(event => event.attachments)?.attachments;
    const acceptanceId = [...cardEvents].reverse().map(event => event.acceptanceId).find(Boolean);
    const summary = latestText('summary');
    const runId = latestText('runId');
    return {
      id: latest.cardId,
      memberId: latest.memberId,
      title: projectedCard.title,
      state: API_STATES[latest.state],
      ...(summary ?? projectedCard.summary ? { summary: summary ?? projectedCard.summary } : {}),
      ...(runId ? { runId } : {}),
      ...(released && projectedCard.resultUrl ? { resultUrl: projectedCard.resultUrl } : {}),
      ...(publicUrl ? { publicUrl } : {}),
      ...(attachments ? { attachments } : {}),
      ...(acceptanceId ? { acceptanceId } : {}),
      ...(latest.state === 'failed' && !acceptanceId && !cardEvents.some(event => ['building', 'testing', 'released'].includes(event.state)) ? { retryable: true } : {}),
      updatedAt: latest.at,
    };
  })).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
}

async function ownerEvents(request: Request, deps: BoardApiDeps): Promise<{ memberId: string; events: BoardCardEvent[] } | Response> {
  const owner = await deps.resolveOwner(request);
  if (!owner?.memberId) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!deps.store) return jsonResponse({ error: 'board-store-unavailable' }, 503);
  const values = await deps.store.query({ memberId: owner.memberId, type: 'board.card' });
  const events = values.map(parseBoardCardEvent).filter((event): event is BoardCardEvent => event !== undefined && event.memberId === owner.memberId);
  return { memberId: owner.memberId, events };
}

const approvalQueues = new Map<string, Promise<void>>();

async function serializeApproval<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = approvalQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => turn);
  approvalQueues.set(key, queued);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (approvalQueues.get(key) === queued) approvalQueues.delete(key);
  }
}

async function readLimitedBody(request: Request, maxBytes: number): Promise<string> {
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('body-too-large');
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new Error('body-too-large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function getBoard(request: Request, deps: BoardApiDeps): Promise<Response> {
  try {
    const result = await ownerEvents(request, deps);
    return result instanceof Response ? result : jsonResponse({ cards: responseCards(result.events) });
  } catch {
    return jsonResponse({ error: 'board-store-unavailable' }, 503);
  }
}

async function approveBoardCard(request: Request, cardId: string, deps: BoardApiDeps): Promise<Response> {
  if (!CARD_ID.test(cardId)) return jsonResponse({ error: 'not_found' }, 404);
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') return jsonResponse({ error: 'application_json_required' }, 415);
  if (request.headers.has('cookie')) {
    const origin = request.headers.get('origin');
    const sameOrigin = origin
      ? origin === new URL(request.url).origin
      : request.headers.get('sec-fetch-site') === 'same-origin';
    if (!sameOrigin) return jsonResponse({ error: 'same_origin_required' }, 403);
  }
  try {
    const owner = await deps.resolveOwner(request);
    if (!owner?.memberId) return jsonResponse({ error: 'unauthorized' }, 401);
    const store = deps.store;
    if (!store) return jsonResponse({ error: 'board-store-unavailable' }, 503);
    let body: unknown;
    try { body = JSON.parse(await readLimitedBody(request, 4_096)); }
    catch (error) { return jsonResponse({ error: error instanceof Error && error.message === 'body-too-large' ? 'payload_too_large' : 'bad_request' }, error instanceof Error && error.message === 'body-too-large' ? 413 : 400); }
    if (!isRecord(body) || Object.keys(body).length !== 1 || body.decision !== 'approved') {
      return jsonResponse({ error: 'explicit_approval_required' }, 400);
    }
    return await serializeApproval(`${owner.memberId}:${cardId}`, async () => {
      const result = await ownerEvents(request, { ...deps, resolveOwner: async () => owner });
      if (result instanceof Response) return result;
      const cardEvents = result.events.filter(event => event.cardId === cardId);
      const latest = cardEvents.at(-1);
      if (!latest) return jsonResponse({ error: 'not_found' }, 404);
      // Only a failed preflight without a recorded run may be retried.
      if (cardEvents.some(event => event.state === 'approved')
        || cardEvents.some(event => event.acceptanceId)
        || cardEvents.some(event => ['building', 'testing', 'released'].includes(event.state))
        || (latest.state !== 'suggested' && !(latest.state === 'failed' && !cardEvents.some(event => event.state === 'approved')))) {
        return jsonResponse({ error: 'card_not_approvable' }, 409);
      }
      const at = new Date(Math.max((deps.now ?? Date.now)(), Date.parse(latest.at) + 1)).toISOString();
      const approved: BoardCardEvent = { ...latest, state: 'approved', ...(owner.appSlug ? { appSlug: owner.appSlug } : {}), summary: cardEvents.find(event => event.state === 'suggested')?.summary, at };
      delete approved.result;
      delete approved.acceptanceId;
      const appendWithRetry = async (event: BoardCardEvent) => {
        for (;;) {
          try { await store.append(event); return; }
          catch { await new Promise<void>(resolve => setTimeout(resolve, 100)); }
        }
      };
      if (!deps.dispatchApproved) {
        await appendWithRetry(approved);
        if (!store.subscribe) deps.publish?.(boardCardNexusEvent(approved)!);
        return jsonResponse({ card: responseCards([...result.events, approved]).find(card => card.id === cardId) });
      }
      let prepared: Awaited<ReturnType<NonNullable<BoardApiDeps['dispatchApproved']>>>;
      try {
        prepared = await deps.dispatchApproved(approved, owner);
        if (!CARD_ID.test(prepared.acceptanceId) || typeof prepared.start !== 'function') throw new Error('invalid graph dispatch');
      } catch {
        const failed: BoardCardEvent = { ...approved, state: 'failed', summary: '그래프 접수 실패' };
        await appendWithRetry(failed);
        if (!store.subscribe) deps.publish?.(boardCardNexusEvent(failed)!);
        return jsonResponse({ error: 'harness-dispatch-failed', card: responseCards([...result.events, failed]).find(card => card.id === cardId) }, 503);
      }
      const accepted: BoardCardEvent = { ...approved, acceptanceId: prepared.acceptanceId };
      await appendWithRetry(accepted);
      if (!store.subscribe) deps.publish?.(boardCardNexusEvent(accepted)!);
      // The durable acceptance precedes every graph progress event. Runtime failure
      // is recorded on the same card; graph-owned progress remains in the plugin.
      void Promise.resolve().then(prepared.start).catch(async () => {
        const failed: BoardCardEvent = { ...accepted, state: 'failed', summary: '그래프 실행 실패',
          at: new Date(Math.max((deps.now ?? Date.now)(), Date.parse(accepted.at) + 1)).toISOString() };
        await appendWithRetry(failed);
        if (!store.subscribe) deps.publish?.(boardCardNexusEvent(failed)!);
      });
      return jsonResponse({ card: responseCards([...result.events, accepted]).find(card => card.id === cardId),
        dispatch: { acceptanceId: prepared.acceptanceId } }, 202);
    });
  } catch {
    return jsonResponse({ error: 'board-store-unavailable' }, 503);
  }
}

/** Replay durable approvals after Nexus restart with their original run identity. */
export async function recoverBoardApprovals(
  store: BoardEventStore,
  dispatch: NonNullable<BoardApiDeps['dispatchApproved']>,
  onError?: (error: unknown) => void,
): Promise<void> {
  if (!store.scan) return;
  const values = await store.scan({ type: 'board.card' });
  const histories = new Map<string, BoardCardEvent[]>();
  for (const value of values) {
    const event = parseBoardCardEvent(value);
    if (!event) continue;
    const key = `${event.memberId}:${event.cardId}`;
    const events = histories.get(key) ?? [];
    events.push(event);
    histories.set(key, events);
  }
  await Promise.all([...histories.values()].map(async events => {
    const latest = events.at(-1)!;
    const accepted = [...events].reverse().find(event => event.state === 'approved' && event.acceptanceId && event.appSlug);
    if (!accepted || latest.state === 'released' || latest.state === 'failed') return;
    try {
      const prepared = await dispatch(accepted, { memberId: accepted.memberId, appSlug: accepted.appSlug }, accepted.acceptanceId);
      if (prepared.acceptanceId !== accepted.acceptanceId) throw new Error('recovered graph run id changed');
      await prepared.start();
    } catch (error) { onError?.(error); }
  }));
}

export async function handleBoardRoute(request: Request, pathname: string, deps: BoardApiDeps): Promise<Response | undefined> {
  if (pathname === '/v1/board') {
    if (request.method === 'GET') return getBoard(request, deps);
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }
  const approval = /^\/v1\/board\/([^/]+)\/approve$/.exec(pathname);
  if (approval) {
    if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);
    let cardId: string;
    try { cardId = decodeURIComponent(approval[1]!); }
    catch { return jsonResponse({ error: 'not_found' }, 404); }
    return approveBoardCard(request, cardId, deps);
  }
  return undefined;
}

/** Resolve member identity through the same member session and app-owner verifier used by /v1/members/owner. */
export async function resolveVerifiedMemberOwner(
  request: Request,
  membersApi: MembersApi | null | undefined,
  appSlugs: readonly string[] = [],
): Promise<{ memberId: string; appSlug?: string } | null> {
  if (!membersApi) return null;
  const origin = new URL(request.url).origin;
  const headers = new Headers();
  for (const name of ['authorization', 'cookie', 'origin', 'sec-fetch-site']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const profileResponse = await membersApi.handle(new Request(`${origin}/v1/members`, { headers }), 'board-api');
    if (profileResponse?.ok) {
      const profile = await profileResponse.json() as { member?: { id?: unknown }; appSlot?: { appSlug?: unknown } };
      const memberId = profile.member?.id;
      const appSlug = profile.appSlot?.appSlug;
      if (typeof memberId !== 'string' || !memberId || typeof appSlug !== 'string' || !appSlug) return null;
      const ownerUrl = new URL('/v1/members/owner', origin);
      ownerUrl.searchParams.set('appSlug', appSlug);
      const ownerResponse = await membersApi.handle(new Request(ownerUrl, { headers }), 'board-api');
      if (!ownerResponse?.ok) return null;
      const owner = await ownerResponse.json() as { memberId?: unknown };
      return owner.memberId === memberId ? { memberId, appSlug } : null;
    }

    // App-bound owner sessions (Android/TUI) have no member web cookie. Ask
    // the existing owner verifier for each configured app slug; never infer
    // identity from the bearer contents or an operator token.
    for (const appSlug of appSlugs) {
      if (!appSlug) continue;
      const ownerUrl = new URL('/v1/members/owner', origin);
      ownerUrl.searchParams.set('appSlug', appSlug);
      const ownerResponse = await membersApi.handle(new Request(ownerUrl, { headers }), 'board-api');
      if (!ownerResponse?.ok) continue;
      const owner = await ownerResponse.json() as { memberId?: unknown };
      if (typeof owner.memberId === 'string' && owner.memberId) return { memberId: owner.memberId, appSlug };
    }
    return null;
  } catch {
    return null;
  }
}
