import { parsePublicAppHost } from '../../relay/relay-server.js';

export type ConsoleAddressTarget =
  | { readonly kind: 'hosted' }
  | { readonly kind: 'local'; readonly nexusOrigin: string };

const HOSTED_CONSOLE_ORIGIN = 'https://console.elanous.ai';
const PUBLIC_APP_DOMAIN = 'elanous.app';

/** Hosted management stays on the cookie-isolated console domain; local consoles use their Nexus PWA origin. */
export function consoleAddress(target: ConsoleAddressTarget): string {
  if (target.kind === 'hosted') return HOSTED_CONSOLE_ORIGIN;

  let origin: URL;
  try {
    origin = new URL(target.nexusOrigin);
  } catch {
    throw new Error('local Nexus origin must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) {
    throw new Error('local Nexus origin must be an absolute HTTP(S) URL without credentials');
  }
  return origin.origin;
}

/**
 * Address proposal from user-simulation-kit §5c. The -sim suffix is not reserved by this helper:
 * collision rejection remains pending the D2 decision and must be enforced by a later policy layer.
 */
export function simulationPreviewAddress(input: { readonly appSlug: string; readonly userSlug: string }): string {
  const productionHost = `${input.appSlug}--${input.userSlug}.${PUBLIC_APP_DOMAIN}`;
  if (!parsePublicAppHost(productionHost)) throw new Error('appSlug or userSlug cannot form a public app address');

  const previewHost = `${input.appSlug}-sim--${input.userSlug}.${PUBLIC_APP_DOMAIN}`;
  if (!parsePublicAppHost(previewHost)) throw new Error('appSlug or userSlug cannot form a simulation preview address');
  return `https://${previewHost}`;
}
