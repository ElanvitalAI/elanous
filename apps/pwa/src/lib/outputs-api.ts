import type { DaemonClient } from './daemon-client';

export interface OutputItem {
  kind: string;
  kindLabel: string;
  title: string;
  fileName?: string;
  url?: string;
  source: 'exec' | 'field-reel' | 'field-feed';
  seat?: string;
  at: string;
}

export function getOutputs(client: DaemonClient, { limit, source }: { limit?: number; source?: OutputItem['source'] } = {}): Promise<{ outputs: OutputItem[] }> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set('limit', String(limit));
  if (source !== undefined) params.set('source', source);
  const query = params.toString();
  return client.fetchJson(`/v1/outputs${query ? `?${query}` : ''}`);
}
