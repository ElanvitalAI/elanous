/**
 * PWA intake 첫 입구 I0 — 이미 있는 데몬 입구 셋만 부른다.
 *   POST /v1/intake-ledger/items
 *   GET  /v1/intake-ledger/items/:id   (원문은 응답에 없다)
 *   POST /v1/task-cards/wish
 *   POST /v1/harness/ask
 *   GET  /v1/harness/ask-status?acceptanceId=
 *   GET  /v1/harness/run-events?runId=
 * 인증·URL 조립은 DaemonClient.fetchJson / fetchResponse 그대로.
 */

import type { DaemonClient } from './daemon-client';

const URL_RE = /https?:\/\/[^\s<>"']+/g;
/** 원문은 저장·로그에 통째로 남기지 않는다. */
export const INTAKE_TEXT_PREVIEW_CHARS = 40;

export interface AbsorbItem {
  url?: string;
  text?: string;
  title?: string;
}

export interface AbsorbResult {
  ids: string[];
  added: number;
  merged: number;
}

export interface GraphAcceptResult {
  acceptanceId: string;
}

export interface GraphStatus {
  phase: string;
  runId?: string;
  acceptanceId?: string;
  [field: string]: unknown;
}

export interface RunEvent {
  ts: string;
  event: string;
  runId: string;
  payload?: { runStatus?: string; stage?: string; error?: string; ok?: boolean };
}

export interface AbsorbStatus {
  id: string;
  status: string;
  outputs?: { kind: 'note' | 'goal' | 'manual' | 'release' | 'grounding'; ref: string }[];
  [field: string]: unknown;
}

export type IntakeRouteTrack = 'absorb' | 'tasks' | 'graph' | 'ask-human';

export interface IntakeRouteDecision {
  track: IntakeRouteTrack;
  confidence: number;
  reason: string;
  decidedBy: string;
  dryRun?: boolean;
}

/** `https?://` URL 을 뽑는다. 여러 개면 URL 마다 한 항목, 없으면 text 한 항목. */
export function absorbItemsFromText(text: string): AbsorbItem[] {
  const urls = text.match(URL_RE) ?? [];
  if (urls.length === 0) return [{ text }];
  return urls.map((url) => ({ url }));
}

/** 로그·최근 목록에 남길 앞 40자. 원문 전체를 넘기지 않는다. */
export function intakeTextPreview(text: string): string {
  return text.slice(0, INTAKE_TEXT_PREVIEW_CHARS);
}

export async function submitAbsorb(client: DaemonClient, text: string): Promise<AbsorbResult> {
  const items = absorbItemsFromText(text);
  const body = await client.fetchJson<AbsorbResult>('/v1/intake-ledger/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items, source: 'pwa' }),
  });
  return { ids: body.ids, added: body.added, merged: body.merged };
}

export interface WishCardResult { cardId: string; title: string; created: boolean }

export function submitWishCard(client: DaemonClient, text: string, sessionId: string, ref: string): Promise<WishCardResult> {
  return client.fetchJson<WishCardResult>('/v1/task-cards/wish', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, sessionId, ref }),
  });
}

export async function submitGraph(client: DaemonClient, text: string): Promise<GraphAcceptResult> {
  const body = await client.fetchJson<GraphAcceptResult>('/v1/harness/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return { acceptanceId: body.acceptanceId };
}

export function getGraphStatus(client: DaemonClient, acceptanceId: string): Promise<GraphStatus> {
  return client.fetchJson<GraphStatus>(
    `/v1/harness/ask-status?acceptanceId=${encodeURIComponent(acceptanceId)}`,
  );
}

export function getRunEvents(client: DaemonClient, runId: string): Promise<RunEvent[]> {
  return client.fetchJson<RunEvent[]>(`/v1/harness/run-events?runId=${encodeURIComponent(runId)}`);
}

/** GET 그대로. 서버가 원문(text)을 싣지 않는다. */
export function getAbsorbStatus(client: DaemonClient, id: string): Promise<AbsorbStatus> {
  return client.fetchJson<AbsorbStatus>(`/v1/intake-ledger/items/${encodeURIComponent(id)}`);
}

/** 판정만 묻는다. 실행은 하지 않는다. */
export function routeIntake(client: DaemonClient, text: string, opts?: { classify?: boolean }): Promise<IntakeRouteDecision> {
  return client.fetchJson<IntakeRouteDecision>('/v1/intake/route', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, consent: 'route', source: 'pwa', ...(opts?.classify !== undefined ? { classify: opts.classify } : {}) }),
  });
}
