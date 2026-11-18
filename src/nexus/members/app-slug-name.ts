// The name a member chooses for their app (MEMBER-APP-SLUG-CHOOSE). It becomes the first label of the public address
// `<appSlug>--<userSlug>.elanous.app`, so the rules are the host parser's rules (relay-server parsePublicAppHost) plus the ones only
// a chosen name needs: reserved words, no look-alike of a simulation preview or a PR preview, and the legacy hash space stays closed.
import { parsePublicAppHost } from '../../relay/relay-server.js';

export const APP_SLUG_MIN = 3;
export const APP_SLUG_MAX = 24;

/** Words that name something of ours (hosts, routes, roles) or that people would trust on sight. Compared after normalisation. */
export const RESERVED_APP_SLUGS: ReadonlySet<string> = new Set([
  // already refused by the host parser — repeated so this list is the whole picture
  'www', 'docs', 'api', 'admin', 'relay', 'mail',
  'app', 'apps', 'kaist', 'elanous', 'nexus', 'console', 'dashboard', 'portal', 'status', 'static', 'assets', 'cdn', 'files',
  'auth', 'oauth', 'login', 'logout', 'signin', 'signup', 'account', 'accounts', 'member', 'members', 'owner', 'owners', 'user', 'users',
  'root', 'system', 'support', 'help', 'security', 'billing', 'pay', 'payment', 'payments', 'store', 'shop',
  'blog', 'news', 'ftp', 'smtp', 'imap', 'ns1', 'ns2', 'dev', 'test', 'staging', 'prod', 'preview', 'sim', 'null', 'undefined', 'localhost',
]);

export type AppSlugNameVerdict =
  | { readonly ok: true; readonly slug: string }
  | { readonly ok: false; readonly reason: 'invalid-format' | 'reserved' | 'legacy-space' };

/**
 * One chosen name → the slug it would become, or why it cannot be. Case and surrounding space are normalised here (so `Ticketing `
 * and `ticketing` are the same name); everything else must already be right — nothing is "fixed up" silently.
 */
export function checkAppSlugName(input: unknown): AppSlugNameVerdict {
  if (typeof input !== 'string') return { ok: false, reason: 'invalid-format' };
  const slug = input.trim().toLowerCase();
  if (slug.length < APP_SLUG_MIN || slug.length > APP_SLUG_MAX) return { ok: false, reason: 'invalid-format' };
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) || slug.includes('--')) return { ok: false, reason: 'invalid-format' };
  // The legacy slug is 24 hex characters derived from the member id; keeping that whole space closed means a chosen name can never equal
  // anyone's existing slug, whatever the id hash turns out to be.
  if (/^[a-f0-9]{24}$/.test(slug)) return { ok: false, reason: 'legacy-space' };
  if (RESERVED_APP_SLUGS.has(slug)) return { ok: false, reason: 'reserved' };
  // `<name>-sim` is the simulation preview address of `<name>`; `<name>-pr<N>` is a PR preview. A name cannot pose as either.
  if (/-sim$/.test(slug) || /-pr\d+$/.test(slug)) return { ok: false, reason: 'reserved' };
  // The host parser has the last word: if it would not accept this label, no address could ever be formed.
  if (!parsePublicAppHost(`${slug}--abc.elanous.app`)) return { ok: false, reason: 'invalid-format' };
  return { ok: true, slug };
}
