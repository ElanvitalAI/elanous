import { resolveNexusPwa, type NexusPwaLinkSource, type NexusPwaResolution, type NexusPwaUnavailableReason } from './nexus-show.js';

/** All three fields are present even when the PWA was not queried or is unavailable. */
export interface PtyWebAddress {
  readonly pwaUnavailableReason: NexusPwaUnavailableReason | 'remote-not-queried' | null;
  readonly webUrl: string | null;
  readonly webUrlSource: NexusPwaLinkSource | null;
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
    return address.webUrlSource === 'tailnet' ? `${address.webUrl} (tailnet)` : address.webUrl;
  }
  return `web-unavailable=${address.pwaUnavailableReason ?? 'not-resolved'}`;
}

export function resolvePtyWebAddress(ptyId: string, resolvePwa: () => NexusPwaResolution = resolveNexusPwa): PtyWebAddress {
  try {
    return ptyWebAddress(ptyId, resolvePwa());
  } catch {
    return { webUrl: null, webUrlSource: null, pwaUnavailableReason: 'pwa-query-failed' };
  }
}
