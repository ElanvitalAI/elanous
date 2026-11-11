import type { InProcessHandlerContext } from '../../in-process-registry.js';

export type StockFetch = (url: string, init?: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export function stockInput(context: InProcessHandlerContext, market: 'US' | 'KR'): { symbol: string; from?: string; to?: string } {
  const value = context.nodeInput ?? context.input;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_input');
  const input = value as Record<string, unknown>;
  const symbol = input.symbol;
  const pattern = market === 'US' ? /^[A-Z][A-Z0-9.-]{0,19}$/ : /^\d{6}$/;
  if (input.market !== market || typeof symbol !== 'string' || !pattern.test(symbol)) throw new Error('invalid_input');
  if (input.from !== undefined && !isoDate(input.from)) throw new Error('invalid_input');
  if (input.to !== undefined && !isoDate(input.to)) throw new Error('invalid_input');
  return { symbol, ...(typeof input.from === 'string' ? { from: input.from } : {}),
    ...(typeof input.to === 'string' ? { to: input.to } : {}) };
}

export function isoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function dateRange(input: { from?: string; to?: string }): { from: string; to: string } {
  if (!input.from || !input.to || input.from > input.to) throw new Error('invalid_input');
  return { from: input.from, to: input.to };
}

export async function responseJson(fetcher: StockFetch, url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetcher(url, init);
  if (!response.ok) throw new Error('provider_http_error');
  return object(await response.json());
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_response');
  return value as Record<string, unknown>;
}

export function number(value: unknown): number {
  const result = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(result)) throw new Error('invalid_response');
  return result;
}

export function positive(value: unknown): number {
  const result = number(value);
  if (result <= 0) throw new Error('invalid_response');
  return result;
}

export function failed(error: unknown) {
  return { ok: false, outcome: 'failed', error: error instanceof Error && error.message === 'invalid_input' ? 'invalid_input' : 'provider_failed' } as const;
}
