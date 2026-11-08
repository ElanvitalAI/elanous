// `elanous nexus show` — current project's daemon overview (2026-05-13).
//
// Superset of `pwa show`: surfaces the PWA UI URLs (loopback + tailnet)
// PLUS the daemon's other consumer-facing surface endpoints (REST API
// base · SSE events stream). One command reveals every link the user
// needs to open / curl / subscribe — no more "what was the
// /v1/events path again?" lookups.
//
// Composition: `runPwaShow({format: 'json'})` is invoked under a
// capturing sink so its instance + URL pair is reused. We then
// derive the REST/SSE URLs from the same base (`http://host:port`
// stripped of `/app/`) so loopback + tailnet variants line up
// automatically.

import { runPwaShow } from './pwa-show.js';
import type { PwaShowOpts, PwaShowResult, NexusShowUrls, NexusShowResult } from './pwa-show-contract.js';
import { deriveNexusShowUrls, resolveNexusPwa } from '../nexus/pwa-resolution.js';
export { resolveNexusPwa, toLoopbackUrl } from '../nexus/pwa-resolution.js';
export type { NexusShowUrls, NexusShowResult, NexusShowStatus, NexusPwaResolution, NexusPwaUnavailableReason, NexusPwaLinkSource, ResolveNexusPwaOpts } from './pwa-show-contract.js';
import { type NexusLifecycleState } from '../nexus/supervisor/lock.js';
import { debug } from '../debug/log.js';
import { runGitCommand, type GitCommandRunner } from '../git-fs/runner.js';
import type { GitRunResult } from '../git-fs/retry.js';

export interface NexusShowOpts {
  /** Format. Default 'human'. */
  format?: 'human' | 'json';
  /** Override the cwd used for matching (tests). */
  cwd?: string;
  /** Test seam — pwa-show's listFn pass-through. */
  listFn?: PwaShowOpts['listFn'];
  /** Test seam — pwa-show's probeFn pass-through (tailnet host). */
  probeFn?: PwaShowOpts['probeFn'];
  /** Test seam — read the currently live Nexus lifecycle state. */
  lifecycleFn?: () => NexusLifecycleState | null;
  /** Test seam — resolve the lifecycle root for the current instance. */
  nexusRootFn?: () => string;
  /**
   * Test seam — probe daemon health at the URL this command constructed.
   * The seam receives the already-joined address so tests can assert it;
   * replacing the whole probe must not skip URL construction.
   */
  healthFn?: (url: string) => Promise<NexusHealthProbeResult | null | undefined>;
  /** Test seam — local-only Git commands used to compare the daemon revision. */
  gitFn?: GitCommandRunner;
  /** Output sink. */
  out?: { log: (s: string) => void; error: (s: string) => void };
}

/** Body the health probe returns when it did get a response. Missing `daemonSha` means an old daemon. */
export interface NexusHealthProbeResult {
  readonly daemonSha?: string;
}

export function joinRestHealthUrl(restBase: string, healthPath = '/health'): string {
  return `${restBase.replace(/\/+$/, '')}/${healthPath.replace(/^\/+/, '')}`;
}

const REVISION_NO_RESPONSE = 'revision  unavailable (no daemon health response)';
const REVISION_NO_SHA = 'revision  unavailable (daemon health response has no commit SHA)';

type RevisionFreshness =
  | { readonly status: 'measured'; readonly commitsBehind: number }
  | { readonly status: 'daemon-commit-missing' }
  | { readonly status: 'tracking-ref-missing' }
  | { readonly status: 'unmeasurable' };

function successfulOutput(result: GitRunResult): string | undefined {
  const output = result.status === 0 ? result.stdout.trim() : '';
  return output || undefined;
}

export function resolveRevisionFreshness(cwd: string, daemonSha: string, gitFn?: GitCommandRunner): RevisionFreshness {
  const options = { env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } };
  const run = (args: string[]) => gitFn ? gitFn(cwd, args, options) : runGitCommand(cwd, args, options);
  const commit = run(['rev-parse', '--verify', '--quiet', `${daemonSha}^{commit}`]);
  if (commit.status === 1) return { status: 'daemon-commit-missing' };
  if (commit.status !== 0) return { status: 'unmeasurable' };
  const tracking = run(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (tracking.status === 1) return { status: 'tracking-ref-missing' };
  const trackingRef = successfulOutput(tracking);
  if (!trackingRef || !/^refs\/remotes\/[^/]+\/.+$/.test(trackingRef)) return { status: 'unmeasurable' };
  const trackingCommit = run(['rev-parse', '--verify', '--quiet', `${trackingRef}^{commit}`]);
  if (trackingCommit.status === 1) return { status: 'tracking-ref-missing' };
  if (trackingCommit.status !== 0) return { status: 'unmeasurable' };
  const count = successfulOutput(run(['rev-list', '--count', `${daemonSha}..${trackingRef}`]));
  if (!count || !/^\d+$/.test(count)) return { status: 'unmeasurable' };
  return { status: 'measured', commitsBehind: Number(count) };
}

export function formatRevisionLine(
  health: NexusHealthProbeResult | null | undefined,
  freshness?: RevisionFreshness,
): string {
  if (health == null) return REVISION_NO_RESPONSE;
  const sha = typeof health.daemonSha === 'string' ? health.daemonSha.trim() : '';
  if (!sha) return REVISION_NO_SHA;
  if (!freshness) return `revision  ${sha}`;
  if (freshness.status === 'measured') return `revision  ${sha} (${freshness.commitsBehind} commits behind)`;
  if (freshness.status === 'daemon-commit-missing') return `revision  ${sha} (daemon commit unavailable locally)`;
  if (freshness.status === 'tracking-ref-missing') return `revision  ${sha} (remote default-branch tracking ref unavailable locally)`;
  return `revision  ${sha} (freshness unavailable)`;
}

export async function defaultProbeHealth(url: string): Promise<NexusHealthProbeResult | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      const body = await res.json() as { daemonSha?: unknown };
      if (typeof body.daemonSha === 'string' && body.daemonSha.trim()) {
        return { daemonSha: body.daemonSha.trim() };
      }
      return {};
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

async function readRevisionLine(
  restBase: string | undefined,
  healthFn: NexusShowOpts['healthFn'],
  cwd: string,
  gitFn: NexusShowOpts['gitFn'],
): Promise<string | undefined> {
  if (!restBase) return undefined;
  const url = joinRestHealthUrl(restBase);
  const probe = healthFn ?? defaultProbeHealth;
  const health = await probe(url);
  const sha = typeof health?.daemonSha === 'string' ? health.daemonSha.trim() : '';
  return formatRevisionLine(health, sha ? resolveRevisionFreshness(cwd, sha, gitFn) : undefined);
}

export async function runNexusShow(opts: NexusShowOpts = {}): Promise<NexusShowResult> {
  const out = opts.out ?? console;
  const format = opts.format ?? 'human';

  // Capture pwa-show's JSON output so we get the instance + URL pair
  // without re-implementing the registry lookup / tailnet probe.
  const captured: string[] = [];
  const capturingOut = {
    log: (s: string) => captured.push(s),
    error: (s: string) => captured.push(s),
  };
  const pwaShowOpts: PwaShowOpts = {
    format: 'json',
    out: capturingOut,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.listFn !== undefined ? { listFn: opts.listFn } : {}),
    ...(opts.probeFn !== undefined ? { probeFn: opts.probeFn } : {}),
  };
  const pwaResult = await runPwaShow(pwaShowOpts);

  // The PWA registry is intentionally preferred: a matching entry preserves
  // its complete established output even when the lifecycle sidecar exists.
  if (!pwaResult.instance || !pwaResult.urls) {
    const cwd = opts.cwd ?? process.cwd();
    const pwa = resolveNexusPwa({ ...opts, pwaResult });

    if (pwa.status === 'unregistered') {
      const urls = 'loopback' in pwa
        ? deriveNexusShowUrls({ loopback: pwa.loopback, ...(pwa.source === 'tailnet' ? { tailnet: pwa.url } : {}) })
        : undefined;
      const httpKnown = urls !== undefined;
      if (format === 'json') {
        out.log(JSON.stringify({
          status: 'unregistered',
          instance: null,
          urls: urls ?? null,
          cwd,
          http: httpKnown ? 'known' : 'unknown',
          link: 'url' in pwa
            ? { url: pwa.url, source: pwa.source, ...(pwa.tailnetRecordedAt ? { tailnetRecordedAt: pwa.tailnetRecordedAt } : {}) }
            : undefined,
        }, null, 2));
        return { exitCode: 0, status: 'unregistered', urls };
      }
      out.log('elanous nexus show — daemon alive but not registered for this project.');
      out.log(`  pid       ${pwa.pid}`);
      out.log(`  cwd       ${cwd}`);
      if (!urls) {
        out.log('  HTTP      unknown (runtime sidecar metadata unavailable or invalid)');
        return { exitCode: 0, status: 'unregistered' };
      }
      const revision = await readRevisionLine(urls.rest.loopback, opts.healthFn, cwd, opts.gitFn);
      if (revision) out.log(`  ${revision}`);
      out.log('');
      out.log('Links:');
      out.log('  Source    These addresses come from this daemon\'s runtime sidecar, not the registry; registry readers do not list this daemon: `elanous nexus pwa global status`');
      out.log(`  PWA UI    ${urls.pwa.loopback}`);
      if (urls.pwa.tailnet) out.log(`            ${urls.pwa.tailnet}  (tailnet)`);
      out.log(`  REST API  ${urls.rest.loopback}`);
      if (urls.rest.tailnet) out.log(`            ${urls.rest.tailnet}  (tailnet)`);
      out.log(`  SSE       ${urls.sse.loopback}`);
      if (urls.sse.tailnet) out.log(`            ${urls.sse.tailnet}  (tailnet)`);
      return { exitCode: 0, status: 'unregistered', urls };
    }

    if (format === 'json') {
      out.log(JSON.stringify({ status: 'absent', instance: null, urls: null, cwd }, null, 2));
      return { exitCode: 0, status: 'absent' };
    }
    out.log('elanous nexus show — no daemon registered for this project.');
    out.log(`  cwd: ${cwd}`);
    out.log('');
    out.log('Bring one up:');
    out.log('  elanous nexus run --hmr');
    out.log('Other instances on this host:');
    out.log('  elanous nexus pwa global status');
    return { exitCode: 0, status: 'absent' };
  }

  const resolvedPwa = resolveNexusPwa({ ...opts, pwaResult });
  // Only the resolver-validated tailnet reaches `urls`. Re-inserting the raw
  // `pwaResult.urls.tailnet` here would contradict `link.source: 'local'` on the
  // very inputs the resolver rejected, and `deriveNexusShowUrls` would then slice a
  // malformed URL into the rest/sse variants.
  const resolvedTailnet = resolvedPwa.status === 'registered' && resolvedPwa.source === 'tailnet'
    ? resolvedPwa.url
    : undefined;
  const urls = deriveNexusShowUrls({
    loopback: pwaResult.urls.loopback,
    ...(resolvedTailnet ? { tailnet: resolvedTailnet } : {}),
  });
  const instance = pwaResult.instance;

  if (format === 'json') {
    out.log(JSON.stringify({
      status: 'registered',
      instance,
      urls,
      link: resolvedPwa.status === 'registered'
        ? { url: resolvedPwa.url, source: resolvedPwa.source, ...(resolvedPwa.tailnetRecordedAt ? { tailnetRecordedAt: resolvedPwa.tailnetRecordedAt } : {}) }
        : undefined,
    }, null, 2));
    return { exitCode: 0, status: 'registered', instance, urls };
  }

  // Human format. Mirrors pwa-show's layout for the instance block,
  // then groups URLs by surface (PWA UI / REST API / SSE) with both
  // loopback + tailnet variants printed beside each.
  const aliveTag = instance.alive ? '✓ alive' : '✗ stale (pid dead)';
  out.log(`elanous nexus daemon — ${aliveTag}`);
  out.log('');
  out.log(`  pid       ${instance.pid}`);
  out.log(`  mode      ${instance.mode}${instance.kind === 'test' ? ' (test)' : ''}`);
  out.log(`  ports     ${instance.ports.join(', ')}`);
  out.log(`  cwd       ${instance.cwd}`);
  out.log(`  daemonDir ${instance.daemonDir}`);
  const shareStr = instance.shareMounted
    ? (instance.https ? 'on (--https · ad-hoc · config 비저장)' : 'on (share enable)')
    : 'off';
  out.log(`  share     ${shareStr}`);
  out.log(`  started   ${instance.startedAt}`);
  const revision = await readRevisionLine(urls.rest.loopback, opts.healthFn, opts.cwd ?? process.cwd(), opts.gitFn);
  if (revision) out.log(`  ${revision}`);
  out.log('');
  out.log('Links:');
  out.log(`  PWA UI    ${urls.pwa.loopback}`);
  if (urls.pwa.tailnet) {
    out.log(`            ${urls.pwa.tailnet}  (tailnet)`);
  } else if (instance.shareMounted) {
    out.log('            (tailnet — Tailscale unreachable; re-run when ts is up)');
  } else {
    out.log('            (tailnet off — `elanous nexus pwa share enable` to expose)');
  }
  out.log(`  REST API  ${urls.rest.loopback}`);
  if (urls.rest.tailnet) {
    out.log(`            ${urls.rest.tailnet}  (tailnet)`);
  }
  out.log(`  SSE       ${urls.sse.loopback}`);
  if (urls.sse.tailnet) {
    out.log(`            ${urls.sse.tailnet}  (tailnet)`);
  }

  // Silence the captured pwa-show output — we intentionally re-rendered
  // the relevant bits above. Surface it on debug-only paths if useful.
  void captured;

  return { exitCode: 0, status: 'registered', instance, urls };
}
