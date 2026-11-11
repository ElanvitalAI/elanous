import { lstatSync, readFileSync } from 'node:fs';

export interface TrustedTlsEdge { readonly origin: string; readonly secret: string }

/** Explicit local TLS terminator contract. The edge must strip caller forwarding headers. */
export function trustedTlsEdgeFromEnv(env: NodeJS.ProcessEnv = process.env): TrustedTlsEdge | undefined {
  const path = env.ELANOUS_NEXUS_TLS_EDGE_SECRET_FILE;
  const origin = env.ELANOUS_NEXUS_TLS_EDGE_ORIGIN;
  if (!path && !origin) return undefined;
  if (!path || !origin) throw new Error('TLS edge origin and secret file must be configured together');
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('TLS edge origin must be an HTTPS origin');
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (process.getuid && stat.uid !== process.getuid())) throw new Error('TLS edge secret file must be owner-only regular file');
  const secret = readFileSync(path, 'utf8').trim();
  if (secret.length < 32 || secret.length > 256 || !/^[A-Za-z0-9_-]+$/.test(secret)) {
    throw new Error('invalid TLS edge secret');
  }
  return { origin: url.origin, secret };
}
