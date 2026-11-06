import { Buffer } from 'node:buffer';

export interface FakeFetchRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export interface FakeFetchCall extends FakeFetchRequest {
  readonly routeId: string | null;
  readonly status: number | null;
  readonly error?: string;
}

export interface FakeFetchRoute {
  /** Match an absolute URL exactly or a URL pathname (for example `/v1/tasks`). */
  readonly url: string;
  readonly method?: string;
  readonly response: Response | ((request: FakeFetchRequest) => Response | Promise<Response>);
}

export interface FakeFetchDevice {
  calls(): FakeFetchCall[];
  restore(): void;
}

function decodeTextOrBase64(bytes: Uint8Array, prefix = 'base64:'): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    // Preserve bytes below when this is not valid UTF-8 text.
  }
  return `${prefix}${Buffer.from(bytes).toString('base64')}`;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function requestBody(request: Request, input: RequestInfo | URL, init?: RequestInit): Promise<string | null> {
  const body = init?.body;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof FormData) {
    const form = await request.clone().formData();
    const entries: Array<[string, string | { name: string; type: string; base64: string }]> = [];
    for (const [name, value] of form.entries()) {
      if (typeof value === 'string') {
        entries.push([name, value]);
      } else {
        const file = value as unknown as File;
        entries.push([name, { name: file.name, type: file.type, base64: Buffer.from(await file.arrayBuffer()).toString('base64') }]);
      }
    }
    return `form-data:${JSON.stringify(entries)}`;
  }
  if (body instanceof Blob) {
    const bytes = new Uint8Array(await body.arrayBuffer());
    return decodeTextOrBase64(bytes, `blob:${body.type}:base64:`);
  }
  if (body instanceof ArrayBuffer) return `base64:${Buffer.from(body).toString('base64')}`;
  if (ArrayBuffer.isView(body)) return `base64:${Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('base64')}`;
  if (body instanceof ReadableStream) return `stream:base64:${Buffer.from(await request.clone().arrayBuffer()).toString('base64')}`;
  if (body === null) return null;
  if (body === undefined && input instanceof Request) {
    if (request.body === null) return null;
    const bytes = Buffer.from(await request.clone().arrayBuffer());
    const contentType = request.headers.get('content-type') ?? '';
    const declaredText = /^(text\/|application\/(?:json|xml|x-www-form-urlencoded))/i.test(contentType);
    if (declaredText) return bytes.toString('utf8');
    return decodeTextOrBase64(bytes);
  }
  if (body === undefined) return null;
  throw new TypeError(`fake-fetch: unsupported RequestInit.body type ${Object.prototype.toString.call(body)}`);
}

let fakeFetchInstalled = false;

/** Install an exact-route fetch stub that records every request and cannot fall through to the network. */
export function createFakeFetchDevice(routes: readonly FakeFetchRoute[]): FakeFetchDevice {
  if (routes.length === 0) throw new Error('fake-fetch: at least one route is required');
  if (fakeFetchInstalled) throw new Error('fake-fetch: overlapping devices are not supported; restore the active device first');
  const originalFetch = globalThis.fetch;
  const observations: FakeFetchCall[] = [];
  let restored = false;

  const fakeFetch: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestObject = new Request(input, init);
    const url = requestObject.url;
    const method = requestObject.method.toUpperCase();
    const headers = requestObject.headers;
    const callIndex = observations.length;
    let request: FakeFetchRequest = {
      url,
      method,
      headers: Object.fromEntries(headers.entries()),
      body: null,
    };
    observations.push({ ...request, routeId: null, status: null });
    request = { ...request, body: await requestBody(requestObject, input, init) };
    observations[callIndex] = { ...observations[callIndex]!, ...request };
    const target = new URL(url, 'http://fake-fetch.local');
    const routeIndex = routes.findIndex((route) => {
      if ((route.method ?? 'GET').toUpperCase() !== method) return false;
      if (route.url.startsWith('/')) return target.pathname === route.url;
      return target.href === new URL(route.url).href;
    });
    if (routeIndex < 0) {
      observations[callIndex] = { ...observations[callIndex]!, error: 'unmatched route' };
      throw new TypeError(`fake-fetch: no route for ${method} ${url}`);
    }
    const route = routes[routeIndex]!;
    observations[callIndex] = { ...observations[callIndex]!, routeId: `route-${routeIndex + 1}` };
    try {
      const response = typeof route.response === 'function'
        ? await route.response(request)
        : route.response.clone();
      observations[callIndex] = { ...observations[callIndex]!, status: response.status };
      return response;
    } catch (error) {
      observations[callIndex] = {
        ...observations[callIndex]!,
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }, { preconnect: () => { throw new Error('fake-fetch: preconnect is blocked to keep the device network-free'); } });

  fakeFetchInstalled = true;
  globalThis.fetch = fakeFetch;
  return {
    calls: () => observations.map((call) => ({ ...call, headers: { ...call.headers } })),
    restore() {
      if (restored) return;
      globalThis.fetch = originalFetch;
      fakeFetchInstalled = false;
      restored = true;
    },
  };
}

/** Install route fixtures for a callback and restore the original global fetch on every exit path. */
export async function withFakeFetchDevice<T>(
  routes: readonly FakeFetchRoute[],
  run: (device: FakeFetchDevice) => T | Promise<T>,
): Promise<T> {
  const device = createFakeFetchDevice(routes);
  try {
    return await run(device);
  } finally {
    device.restore();
  }
}
