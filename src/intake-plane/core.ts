import { join } from 'node:path';

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|igshid|si|feature|ref_src|ref_url|s|mc_cid|mc_eid)$/i;

/** Normalize URLs so equivalent links share one intake identity. */
export function canonicalUrl(raw: string): string | undefined {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return undefined; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
  const path = u.pathname.replace(/\/+$/, '');
  const yt = host === 'youtu.be' ? path.slice(1)
    : /(^|\.)youtube\.com$/.test(host)
      ? (u.searchParams.get('v') ?? path.match(/^\/(?:shorts|live|embed|v)\/([^/]+)/)?.[1])
      : undefined;
  if (yt && /^[A-Za-z0-9_-]{11}$/.test(yt)) return `https://www.youtube.com/watch?v=${yt}`;
  if (host === 'x.com' || host === 'twitter.com') {
    const id = path.match(/\/status(?:es)?\/(\d+)/)?.[1];
    if (id) return `https://x.com/i/status/${id}`;
  }
  if (host === 'github.com') {
    const m = path.match(/^\/([^/]+)\/([^/]+)/);
    if (m && !['orgs', 'topics', 'search', 'settings', 'marketplace', 'features'].includes(m[1].toLowerCase())) {
      return `https://github.com/${m[1].toLowerCase()}/${m[2].toLowerCase().replace(/\.git$/, '')}`;
    }
  }
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k)).sort(([a], [b]) => a.localeCompare(b));
  const q = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  return `https://${host}${path}${q}`;
}

export function intakeLedgerDir(instanceRoot: string): string { return join(instanceRoot, 'intake'); }
