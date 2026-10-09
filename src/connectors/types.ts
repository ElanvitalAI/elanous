export interface ExternalTaskEvent<Provider extends string = 'linear' | 'asana'> {
  provider: Provider;
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

export interface TaskConnector<Provider extends string = ExternalTaskEvent['provider']> {
  provider: Provider;
  verify(req: { rawBody: string | Uint8Array; signature: string; secret: string; now?: number }): { ok: true } | { ok: false; reason: string };
  parse(body: unknown, deliveryId: string): ExternalTaskEvent<Provider> | null;
  idempotencyKey(event: ExternalTaskEvent<Provider>): string;
}
