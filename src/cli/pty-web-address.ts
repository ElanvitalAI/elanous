import { resolveDaemonEndpoint, type ResolveDaemonEndpointOpts } from '../nexus/daemon-endpoint.js';
import { resolveNexusPwa, type NexusPwaLinkSource, type NexusPwaResolution, type NexusPwaUnavailableReason } from './nexus-show.js';

/** All three fields are present even when the PWA was not queried or is unavailable. */
export interface PtyWebAddress {
  readonly pwaUnavailableReason: NexusPwaUnavailableReason | 'remote-not-queried' | null;
  readonly webUrl: string | null;
  readonly webUrlSource: NexusPwaLinkSource | null;
  /** Set when the watch link came from the production daemon, not this universe. */
  readonly productionDaemon?: boolean;
}

export function ptyWebAddress(ptyId: string, pwa: NexusPwaResolution): PtyWebAddress {
  if ('url' in pwa) {
    // Use the resolver-selected address, which may be reachable over tailnet.
    const url = new URL('term', pwa.url);
    url.search = new URLSearchParams({ pty: ptyId }).toString();
    return { webUrl: url.toString(), webUrlSource: pwa.source, pwaUnavailableReason: null };
  }
  return { webUrl: null, webUrlSource: null, pwaUnavailableReason: pwa.reason };
}

export function formatPtyWebAddress(address: PtyWebAddress): string {
  if (address.webUrl) {
    const link = address.webUrlSource === 'tailnet' ? `${address.webUrl} (tailnet)` : address.webUrl;
    return address.productionDaemon ? `${link} (production daemon)` : link;
  }
  return `web-unavailable=${address.pwaUnavailableReason ?? 'not-resolved'}`;
}

export function resolvePtyWebAddress(
  ptyId: string,
  resolvePwa: () => NexusPwaResolution = resolveNexusPwa,
  endpointOpts?: ResolveDaemonEndpointOpts,
): PtyWebAddress {
  try {
    const address = ptyWebAddress(ptyId, resolvePwa());
    if (address.webUrl || address.pwaUnavailableReason !== 'daemon-absent') return address;
    const production = resolveDaemonEndpoint({ ...endpointOpts, purpose: 'watch' });
    if (production?.universe !== 'production') return address;
    const watched = ptyWebAddress(ptyId, {
      status: 'unregistered',
      loopback: `${production.baseUrl}/app/`,
      url: production.pwaUrl,
      pid: 0,
      source: 'local',
    });
    return { ...watched, productionDaemon: true };
  } catch {
    return { webUrl: null, webUrlSource: null, pwaUnavailableReason: 'pwa-query-failed' };
  }
}
