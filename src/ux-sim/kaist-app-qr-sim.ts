import { parsePublicAppHost } from '../relay/relay-server.js';
import type { NexusAppHost } from '../nexus/apps/app-host.js';

export interface FakePublicAppResolution {
  readonly appSlug: string;
  readonly userSlug: string;
  readonly publicHost: string;
}

/** Resolves QR public names inside the simulator without DNS or network access. */
export function resolveFakePublicAppName(value: string): FakePublicAppResolution | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'https:') return undefined;
  const parsed = parsePublicAppHost(url.host, 'elanous.app');
  return parsed ? { appSlug: parsed.app, userSlug: parsed.user, publicHost: url.host.toLowerCase() } : undefined;
}

/** Sends the resolved QR request through the real Nexus app-host handler. */
export async function fetchFakePublicAppQr(
  appHost: NexusAppHost,
  qrUrl: string,
  options: { readonly method?: string; readonly cookie?: string; readonly body?: string } = {},
): Promise<Response | undefined> {
  const resolution = resolveFakePublicAppName(qrUrl);
  if (!resolution) return undefined;
  const url = new URL(qrUrl);
  return appHost.handle(new Request(`https://${resolution.publicHost}${url.pathname}${url.search}`, {
    method: options.method ?? 'GET',
    headers: {
      host: resolution.publicHost,
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.method === 'POST' ? { origin: `https://${resolution.publicHost}`, 'content-type': 'application/json' } : {}),
    },
    ...(options.body ? { body: options.body } : {}),
  }));
}

/** Browser storage is keyed by the full public origin, matching app-origin isolation. */
export class FakeQrBrowserStorage {
  readonly #origins = new Map<string, Map<string, string>>();

  set(url: string, key: string, value: string): void {
    const origin = new URL(url).origin;
    const entries = this.#origins.get(origin) ?? new Map<string, string>();
    entries.set(key, value);
    this.#origins.set(origin, entries);
  }

  get(url: string, key: string): string | undefined {
    return this.#origins.get(new URL(url).origin)?.get(key);
  }
}
