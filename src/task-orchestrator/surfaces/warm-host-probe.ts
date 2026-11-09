import { isIP } from 'node:net';

function privateAddress(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  const version = isIP(host);
  if (version === 4) {
    const octets = host.split('.').map(Number);
    const [a, b] = octets;
    return a === 10 || a === 127 || (a === 172 && b! >= 16 && b! <= 31)
      || (a === 192 && b === 168) || (a === 169 && b === 254)
      || (a === 100 && b! >= 64 && b! <= 127);
  }
  if (version === 6) return host === '::1' || /^f[cd]/i.test(host) || /^fe[89ab]/i.test(host);
  return false;
}

/** Accept the OrbStack alias or a private/ULA address, requiring an explicitly written port. */
export function validateWarmHostProbeUrl(value: string, label = 'host probe URL'): string {
  try {
    const explicitPort = /^https?:\/\/(?:\[[^\]]+\]|[^/:?#]+):(\d+)(?:[/?#]|$)/i.exec(value)?.[1];
    const port = Number(explicitPort);
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (url.protocol !== 'http:' || !explicitPort || !Number.isInteger(port) || port < 1 || port > 65535
      || url.username || url.password || url.search || url.hash
      || (host !== 'host.orb.internal' && !privateAddress(host))) throw new Error();
    return url.href;
  } catch {
    throw new Error(label + ' must be an http URL on host.orb.internal or a private node address with an explicit port');
  }
}
