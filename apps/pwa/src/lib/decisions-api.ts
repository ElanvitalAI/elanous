import type { DaemonClient } from './daemon-client';

export interface OpenDecision {
  id: string;
  title: string;
  situation: string;
  options: Array<{ id: string; label: string }>;
  recommendation: { option: string; why: string } | { skipped: true; reason: string };
  raisedAt?: string;
  dueAt?: string;
}

export async function listOpenDecisions(client: Pick<DaemonClient, 'fetchResponse'>): Promise<OpenDecision[]> {
  const response = await client.fetchResponse('/v1/decisions?status=open');
  if (!response.ok) throw new Error(`decisions list failed: ${response.status}`);
  const body = await response.json() as { decisions: OpenDecision[] };
  return body.decisions;
}

export async function decide(client: Pick<DaemonClient, 'fetchResponse'>, id: string, choice: string): Promise<void> {
  const response = await client.fetchResponse(`/v1/decisions/${encodeURIComponent(id)}/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ choice }),
  });
  if (!response.ok) throw new Error(`decision failed: ${response.status}`);
}
