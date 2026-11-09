import { execFileSync } from 'node:child_process';
import { isIP } from 'node:net';

const RESOURCE_LEDGER_PATH = '/v1/resource-ledger/pools';

export interface ResourceLedgerUrlValidationOptions {
  /** Isolates tailnet address discovery in simulations; production reads the local Tailscale status. */
  readTailnetAddresses?: () => readonly string[];
}

function isLoopback(hostname: string): boolean {
  const unwrapped = hostname.replace(/^\[|\]$/g, '');
  if (unwrapped === '::1') return true;
  return isIP(unwrapped) === 4 && Number(unwrapped.split('.')[0]) === 127;
}

function localTailnetAddresses(): string[] {
  try {
    const output = execFileSync('tailscale', ['status', '--json'], {
      encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const status = JSON.parse(output) as {
      Self?: { TailscaleIPs?: unknown };
      Peer?: Record<string, { TailscaleIPs?: unknown }>;
    };
    const candidates = [status.Self?.TailscaleIPs,
      ...Object.values(status.Peer ?? {}).map(peer => peer.TailscaleIPs)];
    return [...new Set(candidates.flatMap(value => Array.isArray(value)
      ? value.filter((address): address is string => typeof address === 'string' && isIP(address) !== 0)
      : []))];
  } catch {
    return [];
  }
}

function isTailnetAddress(hostname: string, readTailnetAddresses: () => readonly string[]): boolean {
  const unwrapped = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(unwrapped) === 0) return false;
  return readTailnetAddresses().includes(unwrapped);
}

/** Prevent machine bearer credentials from being sent to non-ledger paths or over public cleartext HTTP. */
export function assertResourceLedgerUrl(raw: string, options: ResourceLedgerUrlValidationOptions = {}): void {
  if (raw.includes('?') || raw.includes('#'))
    throw new Error('--resource-ledger-url cannot contain credentials, query, or fragment');
  const authority = raw.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1];
  if (authority?.includes('@'))
    throw new Error('--resource-ledger-url cannot contain credentials, query, or fragment');
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error('--resource-ledger-url must be a valid URL'); }
  if (url.username || url.password || url.search || url.hash)
    throw new Error('--resource-ledger-url cannot contain credentials, query, or fragment');
  if (url.pathname !== RESOURCE_LEDGER_PATH)
    throw new Error(`--resource-ledger-url must use ${RESOURCE_LEDGER_PATH}`);
  if (url.protocol === 'https:') return;
  if (url.protocol !== 'http:' || (!isLoopback(url.hostname)
      && !isTailnetAddress(url.hostname, options.readTailnetAddresses ?? localTailnetAddresses)))
    throw new Error('--resource-ledger-url must use HTTPS outside loopback or tailnet');
}
