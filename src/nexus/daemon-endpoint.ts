import { join } from 'node:path';
import { resolveNexusPwa, type ResolveNexusPwaOpts } from '../cli/nexus-show.js';
import { debug } from '../debug/log.js';
import { prodInstanceRoot } from '../instance/resolve.js';
import { findNexusLifecycleStateAt } from './supervisor/lock.js';

export type DaemonEndpointPurpose = 'write' | 'watch';
export type DaemonEndpointUniverse = 'current' | 'production';

export interface DaemonEndpoint {
  readonly baseUrl: string;
  readonly healthUrl: string;
  readonly pwaUrl: string;
  readonly source: 'registry' | 'lifecycle';
  /** Present only when a watch lookup used the production universe. Write results omit it. */
  readonly universe?: DaemonEndpointUniverse;
}

export interface ResolveDaemonEndpointOpts extends ResolveNexusPwaOpts {
  /** Default `'write'`: current universe only. `'watch'` may read the production daemon. */
  purpose?: DaemonEndpointPurpose;
  /** Test seam — production instance root (`~/.elanous`). */
  productionRootFn?: () => string;
  /**
   * Test seam — registry lookup that sees which universe cwd is being resolved.
   * `listFn` matches `entry.cwd === opts.cwd`, so a single injected list cannot
   * tell the current universe from production.
   */
  listForCwdFn?: (cwd: string) => ReturnType<NonNullable<ResolveNexusPwaOpts['listFn']>>;
}

function endpointFrom(opts: ResolveDaemonEndpointOpts): Omit<DaemonEndpoint, 'universe'> | null {
  const { purpose: _purpose, productionRootFn: _productionRootFn, listForCwdFn, ...resolveOpts } = opts;
  const pwa = resolveNexusPwa(listForCwdFn
    ? { ...resolveOpts, listFn: () => listForCwdFn(resolveOpts.cwd ?? '') }
    : resolveOpts);
  if (!('loopback' in pwa)) return null;

  const baseUrl = new URL(pwa.loopback).origin;
  return {
    baseUrl,
    healthUrl: `${baseUrl}/v1/health`,
    pwaUrl: pwa.url,
    source: pwa.status === 'registered' ? 'registry' : 'lifecycle',
  };
}

/** Test seam. Production callers leave this unset; tests point it at a fixed daemon or `null`. */
let resolveDaemonEndpointOverride: ((opts: ResolveDaemonEndpointOpts) => DaemonEndpoint | null) | null = null;

export function setResolveDaemonEndpointForTest(
  override: ((opts: ResolveDaemonEndpointOpts) => DaemonEndpoint | null) | null,
): void {
  resolveDaemonEndpointOverride = override;
}

/** Resolve the current daemon without guessing a port or replacing a chosen tailnet PWA link.
 *  Write callers stay in this universe. A watch link may fall back to the production daemon. */
export function resolveDaemonEndpoint(opts: ResolveDaemonEndpointOpts = {}): DaemonEndpoint | null {
  if (resolveDaemonEndpointOverride) return resolveDaemonEndpointOverride(opts);
  const purpose = opts.purpose ?? 'write';
  const current = endpointFrom(opts);
  if (current) return current;
  if (purpose !== 'watch') return null;

  const productionRoot = (opts.productionRootFn ?? prodInstanceRoot)();
  const currentRoot = opts.nexusRootFn?.();
  if (currentRoot !== undefined && currentRoot === join(productionRoot, 'nexus')) return null;

  const productionNexus = join(productionRoot, 'nexus');
  const production = endpointFrom({
    ...opts,
    cwd: productionRoot,
    nexusRootFn: () => productionNexus,
    // Read the production lock itself — the current universe's lifecycle reader only ever sees
    // this universe's lock, so the fallback found nothing even with the production daemon up.
    lifecycleFn: () => findNexusLifecycleStateAt(productionNexus),
  });
  debug.log('nexus.endpoint', 'watch-fallback', {
    reason: 'daemon-absent',
    universe: production ? 'production' : 'current',
  });
  if (!production) return null;
  return { ...production, universe: 'production' };
}
