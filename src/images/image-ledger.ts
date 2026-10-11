/**
 * IMAGE-LEDGER-TAGS (RFC-adaptive-graph-ops §9.11) — first slice: the image ledger.
 *
 * The registry tag itself carries only the 12-char commit (docker/harness/build.sh:276), so the
 * identity of an image (why it exists, how long to keep it) lives in a small append-only ledger
 * next to the config that pins it (`<config dir>/image-ledger.jsonl`). Writers append events;
 * readers fold them per tag. A registry tag with no ledger row is `transient` (RFC §9.11).
 *
 * Writers in this slice: the baseline pin (`config set harness.imageCommit <commit>` — the rail
 * pins through that command). Launch · gate · release writers and `image tag` are later slices.
 *
 * Unreadable is never "none": a ledger line that fails to parse is counted, and a registry that
 * cannot be read is reported as `null` (not as an empty tag list).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';

export const IMAGE_ROLES = ['baseline', 'release', 'gate', 'demo', 'candidate', 'transient'] as const;
export type ImageRole = typeof IMAGE_ROLES[number];
export const IMAGE_KEEPS = ['pin', 'long', 'short', 'gc'] as const;
export type ImageKeep = typeof IMAGE_KEEPS[number];
export const IMAGE_ORIGIN_REASONS = ['rail', 'launch', 'gate', 'release', 'manual', 'config-set'] as const;
export type ImageOriginReason = typeof IMAGE_ORIGIN_REASONS[number];

export interface ImageLedgerEvent {
  readonly v: 1;
  readonly ts: string;
  /** Registry tag = first 12 hex chars of the commit (build.sh:276). */
  readonly tag: string;
  readonly commit: string;
  readonly role: ImageRole;
  readonly keep: ImageKeep;
  readonly origin: { readonly host: string; readonly reason: ImageOriginReason };
}

export interface ImageLedgerRead {
  readonly path: string;
  readonly exists: boolean;
  readonly events: readonly ImageLedgerEvent[];
  /** Lines that were present but did not parse as a ledger event. */
  readonly unreadableLines: number;
}

export interface ImageLedgerRow {
  readonly tag: string;
  readonly commit: string;
  readonly role: ImageRole;
  readonly keep: ImageKeep;
  /** Origin of the first event for this tag · null for a registry-only (unledgered) tag — its origin is unknown. */
  readonly origin: { readonly host: string; readonly reason: ImageOriginReason } | null;
  readonly firstTs: string;
  readonly lastTs: string;
  /** For `baseline`: true only for the most recently pinned baseline. */
  readonly current: boolean;
  /** true when the tag is on the registry · false when not · null when the registry was not read. */
  readonly inRegistry: boolean | null;
  /** true when the row comes only from the registry (no ledger event) — always role `transient`. */
  readonly unledgered: boolean;
}

const HEX = /^[0-9a-f]{12,40}$/u;

export function imageLedgerPath(configDir: string = getElanousConfigDir()): string {
  return join(configDir, 'image-ledger.jsonl');
}

export function imageTag(commit: string): string {
  return commit.trim().toLowerCase().slice(0, 12);
}

function isEvent(value: unknown): value is ImageLedgerEvent {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  const origin = e.origin as Record<string, unknown> | undefined;
  return e.v === 1 && typeof e.ts === 'string' && typeof e.tag === 'string' && /^[0-9a-f]{12}$/u.test(e.tag)
    && typeof e.commit === 'string' && HEX.test(e.commit)
    && (IMAGE_ROLES as readonly unknown[]).includes(e.role) && (IMAGE_KEEPS as readonly unknown[]).includes(e.keep)
    && !!origin && typeof origin.host === 'string' && (IMAGE_ORIGIN_REASONS as readonly unknown[]).includes(origin.reason);
}

export function readImageLedger(path: string = imageLedgerPath()): ImageLedgerRead {
  if (!existsSync(path)) return { path, exists: false, events: [], unreadableLines: 0 };
  const events: ImageLedgerEvent[] = [];
  let unreadableLines = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isEvent(parsed)) events.push(parsed); else unreadableLines += 1;
    } catch { unreadableLines += 1; }
  }
  return { path, exists: true, events, unreadableLines };
}

export function appendImageLedgerEvent(event: ImageLedgerEvent, path: string = imageLedgerPath()): void {
  if (!isEvent(event)) throw new Error(`invalid image ledger event: ${JSON.stringify(event)}`);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

/** The baseline pin event — what `config set harness.imageCommit <commit>` records. */
export function baselinePinEvent(commit: string, deps: { now?: () => Date; host?: string } = {}): ImageLedgerEvent {
  const c = commit.trim().toLowerCase();
  if (!HEX.test(c)) throw new Error(`not a commit (hex 12~40): ${commit}`);
  return {
    v: 1,
    ts: (deps.now?.() ?? new Date()).toISOString(),
    tag: imageTag(c),
    commit: c,
    role: 'baseline',
    keep: 'pin',
    origin: { host: deps.host ?? hostname(), reason: 'config-set' },
  };
}

/**
 * Fold events per tag (the last event decides role and keep), then add registry tags that have no
 * ledger event as `transient`. `registryTags === null` means the registry was not read.
 * Non-commit registry tags (`latest`) are moving aliases and are not rows.
 */
export function foldImageLedger(events: readonly ImageLedgerEvent[], registryTags: readonly string[] | null): ImageLedgerRow[] {
  const byTag = new Map<string, { first: ImageLedgerEvent; last: ImageLedgerEvent }>();
  // Events for one tag may carry the 12-char tag or the full 40-char commit; the row keeps the longest one seen.
  const fullCommit = new Map<string, string>();
  for (const e of events) {
    const seen = byTag.get(e.tag);
    if (!seen) byTag.set(e.tag, { first: e, last: e });
    else if (e.ts >= seen.last.ts) seen.last = e;
    if (e.commit.length > (fullCommit.get(e.tag)?.length ?? 0)) fullCommit.set(e.tag, e.commit);
  }
  let currentBaseline: string | null = null;
  let currentTs = '';
  for (const e of events) if (e.role === 'baseline' && e.ts >= currentTs) { currentBaseline = e.tag; currentTs = e.ts; }
  const registry = registryTags === null ? null : new Set(registryTags.filter((t) => /^[0-9a-f]{12}$/u.test(t)));
  const rows: ImageLedgerRow[] = [...byTag.values()].map(({ first, last }) => ({
    tag: last.tag,
    commit: fullCommit.get(last.tag) ?? last.commit,
    role: last.role,
    keep: last.keep,
    origin: first.origin,
    firstTs: first.ts,
    lastTs: last.ts,
    current: last.role === 'baseline' && last.tag === currentBaseline,
    inRegistry: registry === null ? null : registry.has(last.tag),
    unledgered: false,
  }));
  if (registry) for (const tag of [...registry].sort()) {
    if (byTag.has(tag)) continue;
    rows.push({ tag, commit: tag, role: 'transient', keep: 'short', origin: null, firstTs: '', lastTs: '', current: false, inRegistry: true, unledgered: true });
  }
  return rows.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || '') || a.tag.localeCompare(b.tag));
}

export type RegistryRead = { readonly ok: true; readonly tags: readonly string[] } | { readonly ok: false; readonly reason: string };

/**
 * Read `elanous-harness` tags from the registry the way the rail does (`/v2/elanous-harness/tags/list`
 * on the registry node's localhost port). `sshHost` runs it on that node; otherwise on this machine.
 */
export function readRegistryTags(opts: { port: string; sshHost?: string; run?: (cmd: string, args: readonly string[]) => { status: number | null; stdout: string; stderr?: string } }): RegistryRead {
  const url = `http://localhost:${opts.port}/v2/elanous-harness/tags/list`;
  const run = opts.run ?? ((cmd, args) => {
    const r = spawnSync(cmd, [...args], { encoding: 'utf8', timeout: 25_000 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error) : '') };
  });
  const r = opts.sshHost
    ? run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', opts.sshHost, `curl -fsS --max-time 15 ${url}`])
    : run('curl', ['-fsS', '--max-time', '15', url]);
  if (r.status !== 0) return { ok: false, reason: `registry read failed (exit ${r.status ?? 'timeout'})${r.stderr ? `: ${r.stderr.trim().slice(0, 200)}` : ''}` };
  try {
    const tags = (JSON.parse(r.stdout) as { tags?: unknown }).tags;
    if (tags === null) return { ok: true, tags: [] };
    if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) return { ok: false, reason: 'registry answered without a tags list' };
    return { ok: true, tags };
  } catch { return { ok: false, reason: 'registry answered non-JSON' }; }
}
