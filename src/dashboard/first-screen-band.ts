export interface FirstScreenBandInput {
  readonly width: number;
  readonly daemon: boolean;
  readonly pwa?: {
    readonly tailnet?: string | null;
    readonly lan?: string | null;
    readonly loopback?: string | null;
  };
}

/** A startup transcript band; never includes credentials or a partial address. */
export function buildFirstScreenBand(input: FirstScreenBandInput): string[] {
  const width = Number.isFinite(input.width) ? Math.max(0, Math.floor(input.width)) : 0;
  const fit = (text: string): string => text.slice(0, width);
  const address = [input.pwa?.tailnet, input.pwa?.lan, input.pwa?.loopback]
    .map((candidate) => {
      if (!candidate) return null;
      try {
        const url = new URL(candidate);
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
        return `${url.origin}${url.pathname === '/app/' ? '/app/' : ''}`;
      } catch {
        return null;
      }
    })
    .find((candidate) => candidate !== null);
  const fallback = input.pwa === undefined ? 'PWA: not checked' : 'PWA: unavailable';
  const addressLine = address ? `PWA: ${address}` : fallback;

  return [
    fit(`elanous | daemon: ${input.daemon ? 'online' : 'offline'}`),
    addressLine.length <= width ? addressLine : fit(address ? 'PWA: address available' : fallback),
    fit('Type a message to begin | /help for commands'),
  ];
}
