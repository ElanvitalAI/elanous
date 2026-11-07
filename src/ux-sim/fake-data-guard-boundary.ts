/** Network-free HTTP boundary for DATA-GUARD L0/L1/L2 simulations.
 *
 * This device observes the destination chosen by the real policy/caller; it
 * does not classify or redact payloads itself. Only the explicitly listed
 * local and public origins receive scripted responses. Unknown destinations
 * are recorded and refused so a scenario can prove that it made no real call.
 */
export interface FakeDataGuardCall {
  readonly destination: 'local' | 'public' | 'unknown';
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export interface FakeDataGuardBoundaryOptions {
  readonly localOrigins: readonly string[];
  readonly publicOrigins: readonly string[];
  readonly localResponse?: Response | ((call: FakeDataGuardCall) => Response | Promise<Response>);
  readonly publicResponse?: Response | ((call: FakeDataGuardCall) => Response | Promise<Response>);
}

export interface FakeDataGuardBoundaryDevice {
  calls(): FakeDataGuardCall[];
  localCalls(): FakeDataGuardCall[];
  publicCalls(): FakeDataGuardCall[];
  unknownCalls(): FakeDataGuardCall[];
  restore(): void;
}

let activeDevice = false;

function origins(values: readonly string[], label: string): Set<string> {
  return new Set(values.map((value) => {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`fake-data-guard-boundary: ${label} must use HTTP or HTTPS origins`);
    }
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      throw new Error(`fake-data-guard-boundary: ${label} must contain origins only`);
    }
    return url.origin;
  }));
}

/** Install a fetch boundary which can never fall through to the real network. */
export function createFakeDataGuardBoundaryDevice(options: FakeDataGuardBoundaryOptions): FakeDataGuardBoundaryDevice {
  if (activeDevice) throw new Error('fake-data-guard-boundary: restore the active device before installing another');
  const local = origins(options.localOrigins, 'localOrigins');
  const publicOrigins = origins(options.publicOrigins, 'publicOrigins');
  if (local.size === 0 || publicOrigins.size === 0) throw new Error('fake-data-guard-boundary: local and public origins are required');
  for (const origin of local) if (publicOrigins.has(origin)) throw new Error(`fake-data-guard-boundary: origin classified as both local and public: ${origin}`);

  const originalFetch = globalThis.fetch;
  const observed: FakeDataGuardCall[] = [];
  let restored = false;
  const fakeFetch: typeof fetch = Object.assign(async (input: string | URL | Request, init?: BunFetchRequestInit) => {
    const rawUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    const parsedUrl = new URL(rawUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const call: FakeDataGuardCall = {
        destination: 'unknown',
        url: parsedUrl.href,
        method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
        headers: Object.fromEntries(headers.entries()),
        body: typeof init?.body === 'string' ? init.body : null,
      };
      observed.push(call);
      throw new TypeError(`fake-data-guard-boundary: non-HTTP(S) destination protocol ${parsedUrl.protocol}`);
    }
    const request = new Request(input, init);
    const url = new URL(request.url);
    const destination: FakeDataGuardCall['destination'] = local.has(url.origin)
      ? 'local' : publicOrigins.has(url.origin) ? 'public' : 'unknown';
    const rawBody = request.body === null ? null : await request.clone().text();
    const call: FakeDataGuardCall = {
      destination,
      url: request.url,
      method: request.method.toUpperCase(),
      headers: Object.fromEntries(request.headers.entries()),
      body: rawBody,
    };
    observed.push(call);
    if (destination === 'unknown') throw new TypeError(`fake-data-guard-boundary: unregistered destination ${url.origin}`);
    const configured = destination === 'local' ? options.localResponse : options.publicResponse;
    const response = typeof configured === 'function'
      ? await configured(call)
      : configured?.clone() ?? Response.json({ simulated: true, destination });
    return response;
  }, {
    // Bun extends fetch with preconnect; keep the simulation fully network-free.
    preconnect: (_url: string | URL, _options?: Parameters<typeof fetch.preconnect>[1]) => {},
  });

  activeDevice = true;
  globalThis.fetch = fakeFetch;
  const select = (destination: FakeDataGuardCall['destination']) => observed.filter((call) => call.destination === destination);
  return {
    calls: () => observed.map((call) => ({ ...call, headers: { ...call.headers } })),
    localCalls: () => select('local'),
    publicCalls: () => select('public'),
    unknownCalls: () => select('unknown'),
    restore() {
      if (restored) return;
      globalThis.fetch = originalFetch;
      activeDevice = false;
      restored = true;
    },
  };
}
