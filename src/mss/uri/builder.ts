// ── Elanous URI builder — ULID minting, path join, tier conversion ──
//
// PLAN §7.3 + §7.4 · DD-MSS-22 / 23 / 39.
//
// Tier 1 short form uses the **last** 6 characters of the entity's ULID
// (the random portion); the timestamp-prefix collides across entities
// created in the same millisecond window and would make short-form hashes
// de-facto useless for deduplication. Callers may request a different
// suffix length (4–12 chars) via the `shortLen` option.

import { newUlid } from '../ulid.js';
import { isEntityKind, TIER1_ABBREV_REVERSE, type EntityKind, type ElanousUri, type AgentUri, type SessionUri, type MemoryUri, type SignalUri, type TurnUri, type RunUri, type PluginUri, type WidgetUri, type ModalUri } from './brand.js';
import { isUlid, parseElanousUri, type ParsedElanousUri, type ParsedUriSegment } from './parser.js';

export const DEFAULT_HOST = 'local';
const DEFAULT_SHORT_LEN = 6;

/** Runtime validation + brand cast. Throws on malformed input so a
 *  mis-typed literal at a system boundary fails loud rather than
 *  silently poisoning downstream assumptions. */
export function asElanousUri(s: string): ElanousUri {
  if (!parseElanousUri(s)) {
    throw new Error(`Invalid ElanousUri: ${s}`);
  }
  return s as ElanousUri;
}

export function asSessionUri(s: string): SessionUri {
  const parsed = parseElanousUri(s);
  if (!parsed || !parsed.segments.some(seg => seg.kind === 'session')) {
    throw new Error(`Invalid SessionUri: ${s}`);
  }
  return s as SessionUri;
}

export function asAgentUri(s: string): AgentUri {
  const parsed = parseElanousUri(s);
  if (!parsed || !parsed.segments.some(seg => seg.kind === 'agent')) {
    throw new Error(`Invalid AgentUri: ${s}`);
  }
  return s as AgentUri;
}

/** Mint a fresh Tier 2 AgentUri of the form `agent/<ULID>`. The MSS
 *  M1.2 narrow is additive: existing `AgentTask.id` (UUID) is left
 *  intact, and a separate `agentUri` field rides alongside it so
 *  downstream MSS consumers (M3 signal sender · M4 memory model) get a
 *  ULID-shaped, URI-formatted identifier without disturbing the legacy
 *  UUID-keyed task registry. */
export function mintAgentUri(): AgentUri {
  return asAgentUri(newElanousUri('agent'));
}

export function asMemoryUri(s: string): MemoryUri {
  const parsed = parseElanousUri(s);
  const kinds = new Set(parsed?.segments.map(seg => seg.kind) ?? []);
  if (!parsed || !(kinds.has('stm') || kinds.has('ltm') || kinds.has('sensory'))) {
    throw new Error(`Invalid MemoryUri: ${s}`);
  }
  return s as MemoryUri;
}

export function asSignalUri(s: string): SignalUri {
  const parsed = parseElanousUri(s);
  if (!parsed || !parsed.segments.some(seg => seg.kind === 'signal')) {
    throw new Error(`Invalid SignalUri: ${s}`);
  }
  return s as SignalUri;
}

/** Validate + brand cast for a turn identifier. Lenient on purpose — SAM S0
 *  persists bare ULIDs as `turn_id`, and richer M1.2+ code may use a
 *  `turn/<ULID>` Tier 2 form or a full `elanous://…/turn/<ULID>` Tier 3
 *  address. All three survive round-tripping through this helper. */
export function asTurnUri(s: string): TurnUri {
  if (isUlid(s)) return s as TurnUri;
  const parsed = parseElanousUri(s);
  if (parsed && parsed.segments.some(seg => seg.kind === 'turn')) {
    return s as TurnUri;
  }
  throw new Error(`Invalid TurnUri: ${s}`);
}

/** Mint a bare-ULID TurnUri. Matches the SAM S0 wire format (JSONL rows
 *  carry the ULID alone rather than the Tier 2 prefix) so persisted
 *  sessions stay byte-identical across the M1.2 narrowing. Callers that
 *  need a Tier 2 or Tier 3 form should build it explicitly via
 *  `newElanousUri('turn', parent)` + `asTurnUri`. */
export function mintTurnUri(): TurnUri {
  return newUlid() as TurnUri;
}

/** Validate + brand cast for a TOX run identifier. Strict — accepts only
 *  ElanousUri values whose entity-path includes a `run/<ULID>` segment. Run
 *  identifiers are minted fresh (no legacy wire format), so the canonical
 *  shape is enforced from day one. */
export function asRunUri(s: string): RunUri {
  const parsed = parseElanousUri(s);
  if (!parsed || !parsed.segments.some(seg => seg.kind === 'run')) {
    throw new Error(`Invalid RunUri: ${s}`);
  }
  return s as RunUri;
}

/** Mint a fresh Tier 2 RunUri of the form `run/<ULID>`. Caller may attach
 *  it under a parent (e.g. a `SessionUri` or `AgentUri`) by passing the
 *  result through `joinElanousUri()` instead. */
export function mintRunUri(): RunUri {
  return asRunUri(newElanousUri('run'));
}

/** Validate + brand cast for a plugin activation identifier. Strict —
 *  requires a ElanousUri with a `plugin/<ULID>` segment. */
export function asPluginUri(s: string): PluginUri {
  const parsed = parseElanousUri(s);
  if (!parsed || !parsed.segments.some(seg => seg.kind === 'plugin')) {
    throw new Error(`Invalid PluginUri: ${s}`);
  }
  return s as PluginUri;
}

/** Mint a fresh Tier 2 PluginUri of the form `plugin/<ULID>`. The plugin
 *  manifest's slug `id` is unaffected — this URI identifies a specific
 *  activation of the plugin, not the plugin definition itself. */
export function mintPluginUri(): PluginUri {
  return asPluginUri(newElanousUri('plugin'));
}

/** Validate + brand cast for a widget instance identifier. Strict —
 *  requires a ElanousUri with a `widget/<ULID>` segment. */
export function asWidgetUri(s: string): WidgetUri {
  const parsed = parseElanousUri(s);
  if (!parsed || !parsed.segments.some(seg => seg.kind === 'widget')) {
    throw new Error(`Invalid WidgetUri: ${s}`);
  }
  return s as WidgetUri;
}

/** Mint a fresh Tier 2 WidgetUri of the form `widget/<ULID>`. The
 *  layout-host's per-instance slug (`skills-1`, `chart-px`) stays
 *  a plain string — this URI identifies the same instance to MSS
 *  bridges that need a typed handle. */
export function mintWidgetUri(): WidgetUri {
  return asWidgetUri(newElanousUri('widget'));
}

/** Validate + brand cast for a modal handle identifier. Strict —
 *  requires a ElanousUri with a `modal/<ULID>` segment. */
export function asModalUri(s: string): ModalUri {
  const parsed = parseElanousUri(s);
  if (!parsed || !parsed.segments.some(seg => seg.kind === 'modal')) {
    throw new Error(`Invalid ModalUri: ${s}`);
  }
  return s as ModalUri;
}

/** Mint a fresh Tier 2 ModalUri of the form `modal/<ULID>`. The
 *  modal-lifecycle primitive's `<typeName>#g<generation>` surface id
 *  stays the coordinator's bookkeeping key — this URI is the typed
 *  handle for downstream MSS bridges. */
export function mintModalUri(): ModalUri {
  return asModalUri(newElanousUri('modal'));
}

/** Mint a new Tier 2 (local) URI. When `parent` is provided the new
 *  segment is appended to the parent's entity-path; otherwise the URI
 *  starts fresh at `<kind>/<ulid>`. */
export function newElanousUri(kind: EntityKind, parent?: ElanousUri): ElanousUri {
  if (!isEntityKind(kind)) throw new Error(`Unknown EntityKind: ${kind}`);
  const id = newUlid();
  if (!parent) return (`${kind}/${id}`) as ElanousUri;
  return joinElanousUri(parent, kind, id);
}

/** Append a child segment to a parent URI, generating a fresh ULID when
 *  `id` is omitted. Preserves the parent's tier (Tier 2 parent → Tier 2
 *  child; Tier 3 parent → Tier 3 child). Tier 1 cannot be joined onto —
 *  callers must upgrade to Tier 2 first via a registry lookup (future M1.5). */
export function joinElanousUri(parent: ElanousUri, kind: EntityKind, id?: string): ElanousUri {
  if (!isEntityKind(kind)) throw new Error(`Unknown EntityKind: ${kind}`);
  const parsed = parseElanousUri(parent);
  if (!parsed) throw new Error(`Cannot join onto invalid URI: ${parent}`);
  if (parsed.tier === 1) {
    throw new Error(`Cannot join onto Tier 1 short form: ${parent}`);
  }
  const childId = id ?? newUlid();
  if (parsed.tier === 2) {
    return (`${parent}/${kind}/${childId}`) as ElanousUri;
  }
  // Tier 3 — strip any fragment/query, append, restore
  const qIdx = (parent as string).indexOf('?');
  const hIdx = (parent as string).indexOf('#');
  const cut = [qIdx, hIdx].filter(i => i >= 0).sort((a, b) => a - b)[0] ?? -1;
  const base = cut >= 0 ? (parent as string).slice(0, cut) : (parent as string);
  const tail = cut >= 0 ? (parent as string).slice(cut) : '';
  return (`${base}/${kind}/${childId}${tail}`) as ElanousUri;
}

/** Collapse a Tier 2/3 URI to its Tier 1 short form — `<kind>_<suffix>`.
 *  Reflects the *last* segment only (the leaf entity) since that's what
 *  a human displays. Pass `shortLen` to control suffix length (4–12). */
export function toTier1(uri: ElanousUri, shortLen: number = DEFAULT_SHORT_LEN): string {
  const parsed = parseElanousUri(uri);
  if (!parsed || parsed.segments.length === 0) {
    throw new Error(`Cannot collapse invalid URI: ${uri}`);
  }
  const len = Math.max(4, Math.min(12, shortLen));
  const leaf = parsed.segments[parsed.segments.length - 1]!;
  const suffix = leaf.id.length >= len ? leaf.id.slice(-len) : leaf.id;
  const token = TIER1_ABBREV_REVERSE[leaf.kind] ?? leaf.kind;
  return `${token}_${suffix.toUpperCase()}`;
}

/** Render any URI as its Tier 2 (local) form. Strips host/elanous-id when
 *  present; no-op for inputs already in Tier 2. */
export function toTier2(uri: ElanousUri): string {
  const parsed = parseElanousUri(uri);
  if (!parsed) throw new Error(`Cannot render invalid URI: ${uri}`);
  if (parsed.tier === 1) {
    throw new Error(`Tier 1 → Tier 2 requires a registry lookup: ${uri}`);
  }
  return renderSegments(parsed.segments);
}

/** Render any URI as its Tier 3 (distributed) form. Supplies the caller-
 *  provided host + elanousId when the input is Tier 2 (which has no host). */
export function toTier3(uri: ElanousUri, host: string, elanousId: string): string {
  if (!isUlid(elanousId)) throw new Error(`elanousId must be a ULID: ${elanousId}`);
  const parsed = parseElanousUri(uri);
  if (!parsed) throw new Error(`Cannot render invalid URI: ${uri}`);
  if (parsed.tier === 1) {
    throw new Error(`Tier 1 → Tier 3 requires a registry lookup: ${uri}`);
  }
  const path = renderSegments(parsed.segments);
  const h = parsed.host ?? host;
  const m = parsed.elanousId ?? elanousId;
  const tail = renderQueryFragment(parsed);
  return `elanous://${h}/${m}/${path}${tail}`;
}

function renderSegments(segs: ParsedUriSegment[]): string {
  return segs.map(s => `${s.kind}/${s.id}`).join('/');
}

function renderQueryFragment(p: ParsedElanousUri): string {
  const q = p.query ? `?${Object.entries(p.query).map(([k, v]) => v === '' ? encodeURIComponent(k) : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}` : '';
  const f = p.fragment ? `#${p.fragment}` : '';
  return `${q}${f}`;
}
