import type { DaemonClient } from './daemon-client';

export interface OpenDecision {
  id: string;
  title: string;
  situation: string;
  options: Array<{ id: string; label: string; consequence?: string }>;
  recommendation: { option: string; why: string } | { skipped: true; reason: string };
  raisedAt?: string;
  dueAt?: string;
  scqa?: { s: string; c: string; q?: string; a?: string };
  category?: string;
  irreversible?: boolean;
  raisedBy?: { agent: string; track?: string };
  alternative?: string;
  dissent?: string;
  crossCheck?: Array<{ seat: string; at: string; note: string }>;
  crossCheckSkipped?: string;
  pendingQuestion?: string;
}

export async function listOpenDecisions(client: Pick<DaemonClient, 'fetchResponse'>): Promise<OpenDecision[]> {
  const response = await client.fetchResponse('/v1/decisions?status=open');
  if (!response.ok) throw new Error(`decisions list failed: ${response.status}`);
  const body = await response.json() as { decisions: OpenDecision[] };
  return body.decisions;
}

export async function decide(client: Pick<DaemonClient, 'fetchResponse'>, id: string, choice: string, note?: string): Promise<{ decidedAt?: string }> {
  const response = await client.fetchResponse(`/v1/decisions/${encodeURIComponent(id)}/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ choice, ...(note === undefined ? {} : { note }) }),
  });
  if (!response.ok) throw new Error(`decision failed: ${response.status}`);
  return response.json() as Promise<{ decidedAt?: string }>;
}
