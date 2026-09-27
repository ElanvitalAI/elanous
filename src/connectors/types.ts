export interface ExternalTaskEvent {
  provider: 'linear' | 'asana';
  eventId: string;
  kind: 'created' | 'updated';
  ref: string;
  identifier?: string;
  title: string;
  body: string;
  url: string;
  priority: 'urgent' | 'high' | 'medium' | 'low' | null;
  occurredAt: string;
}

export interface TaskConnector {
  provider: ExternalTaskEvent['provider'];
  verify(req: { rawBody: string | Uint8Array; signature: string; secret: string; now?: number }): { ok: true } | { ok: false; reason: string };
  parse(body: unknown, deliveryId: string): ExternalTaskEvent | null;
  idempotencyKey(event: ExternalTaskEvent): string;
}
