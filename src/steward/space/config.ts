// STEWARD-SPACE (행정관 · 대표 11-25 «서브 조율자에도 루프 에이전트 위성을 붙여라») — config shape and defaults.
// No imports: `src/user-config/schema.ts` imports this type, and the defaults live in code (OPS «기본값은 코드로»).

/** Which nodes an instance emphasises. The scope list itself is never declared here — it comes from the federation
 *  ladder (els journal ⊕ federation.yaml); a profile only says what a given coordinator's steward does most. */
export type StewardSpaceProfile = 'hands' | 'judge' | 'resource' | 'release' | 'hq';
export type StewardSpaceMode = 'off' | 'shadow' | 'live';

export interface StewardSpaceCaps { readonly assign: number; readonly pregate: number; readonly judge: number }

export interface StewardSpaceScopeConfig {
  readonly mode?: StewardSpaceMode;
  readonly profile?: StewardSpaceProfile;
  readonly caps?: Partial<StewardSpaceCaps>;
}

export interface StewardSpaceConfig {
  /** Per coordinator seat (e.g. `TC`, `JUD`, the HQ seat). Absent scope = `defaultMode`. */
  readonly scopes?: Record<string, StewardSpaceScopeConfig>;
  /** Mode for a scope with no entry. Default `off` — rollout turns scopes on one by one. */
  readonly defaultMode?: StewardSpaceMode;
  readonly caps?: Partial<StewardSpaceCaps>;
  /** Pre-approved pregate hosts for R2 (pregate.py still enforces the RES host ledger). */
  readonly pregateHosts?: readonly string[];
  /** Concurrent steward-dispatched pregates per host. */
  readonly hostSlots?: number;
  /** load1 / ncpu above which a host gets no new pregate. */
  readonly maxLoadPerCore?: number;
  readonly pregateTool?: string;
  readonly receiptsDir?: string;
  readonly reviewResultsDir?: string;
  readonly utilDir?: string;
  /** GitHub repo for `gh pr list`: `owner/name` or a checkout path (absent = the checkout this code runs from · its origin remote). */
  readonly repo?: string;
  /** REL readiness: cut times (HH:MM local) and the window before each in which open P0 cells become exception rows. */
  readonly cutTimes?: readonly string[];
  readonly cutWindowMinutes?: number;
}

export const STEWARD_SPACE_DEFAULT_CAPS: StewardSpaceCaps = { assign: 4, pregate: 3, judge: 2 };
export const STEWARD_SPACE_DEFAULTS = {
  pregateHosts: ['minim5', 'node-b', 'node-c'] as readonly string[],
  hostSlots: 1,
  maxLoadPerCore: 0.7,
  cutTimes: ['04:00', '16:00'] as readonly string[],
  cutWindowMinutes: 120,
  /** A hand idle at least this long is free. */
  idleMinMinutes: 10,
  /** A yellow cell untouched this long is stalled. */
  stallMinutes: 120,
  /** GREEN receipt without a verdict this long goes to R3. */
  judgeWaitMinutes: 30,
  /** The same seat / cell / PR head is not re-planned within this window. */
  cooldownMinutes: 30,
  /** A dispatched pregate without a receipt after this long is a watch exception. */
  pregateStuckMinutes: 60,
  /** A PASS verdict on an open PR older than this is a watch exception (the poller did not take it). */
  passNotLandedMinutes: 30,
  digestEveryMinutes: 30,
  /** The same exception key is not re-carded within this window. */
  cardRepeatMinutes: 120,
  /** UTIL snapshot older than this = load unknown = host closed. */
  utilMaxAgeMinutes: 30,
} as const;

/** Never a pregate host, whatever the config says (HQ_HEAVY_FORBIDDEN in pregate.py · mshq no local tests). */
export const STEWARD_SPACE_FORBIDDEN_HOSTS: ReadonlySet<string> = new Set(['mshq', 'joosungui']);

/** Default emphasis by coordinator name. Unknown coordinators get `hands`; the HQ seat always gets `hq`. */
export function defaultProfile(scope: string, hq: string): StewardSpaceProfile {
  if (scope === hq) return 'hq';
  if (/^JUD/.test(scope)) return 'judge';
  if (/^RES/.test(scope)) return 'resource';
  if (/^REL/.test(scope)) return 'release';
  return 'hands';
}

export interface ResolvedScope {
  readonly scope: string;
  readonly instanceId: string;
  readonly mode: StewardSpaceMode;
  readonly profile: StewardSpaceProfile;
  readonly caps: StewardSpaceCaps;
}

const capOf = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 50 ? value : fallback;

export function resolveScope(scope: string, hq: string, config: StewardSpaceConfig | undefined, forceShadow = false): ResolvedScope {
  const entry = config?.scopes?.[scope];
  const mode: StewardSpaceMode = forceShadow ? 'shadow' : entry?.mode ?? config?.defaultMode ?? 'off';
  const base = config?.caps ?? {};
  const own = entry?.caps ?? {};
  return {
    scope, instanceId: `steward:${scope}`, mode,
    profile: entry?.profile ?? defaultProfile(scope, hq),
    caps: {
      assign: capOf(own.assign, capOf(base.assign, STEWARD_SPACE_DEFAULT_CAPS.assign)),
      pregate: capOf(own.pregate, capOf(base.pregate, STEWARD_SPACE_DEFAULT_CAPS.pregate)),
      judge: capOf(own.judge, capOf(base.judge, STEWARD_SPACE_DEFAULT_CAPS.judge)),
    },
  };
}

/** Which nodes act for a profile. R0 (snapshot) and X (exceptions) run for every live/shadow scope. */
export const PROFILE_NODES: Record<StewardSpaceProfile, ReadonlySet<string>> = {
  hands: new Set(['r1', 'r2', 'r5', 'r6']),
  judge: new Set(['r3', 'r4', 'r5', 'r6']),
  resource: new Set(['r1', 'r2', 'r5', 'r6']),
  release: new Set(['r1', 'r4', 'r5', 'r6']),
  hq: new Set(['r1', 'r2', 'r4', 'r5', 'r6']),
};

// ── config parse ───────────────────────────────────────────────────────────────────────────────
// `eln config set loops.stewardSpace.scopes.TC.mode shadow` wrote the key, but the user-config reader rebuilt `loops`
// from named parsers only and dropped `stewardSpace` — every scope read `off` (11-25 15:37). Keep only well-typed fields.

const MODES: ReadonlySet<string> = new Set(['off', 'shadow', 'live']);
const PROFILES: ReadonlySet<string> = new Set(['hands', 'judge', 'resource', 'release', 'hq']);
const SCOPE_NAME = /^[A-Z][A-Z0-9_-]{0,63}$/;
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const strList = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : undefined);
const posNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

function parseCaps(raw: unknown): Partial<StewardSpaceCaps> | undefined {
  const c = obj(raw);
  if (!c) return undefined;
  const out: { assign?: number; pregate?: number; judge?: number } = {};
  for (const key of ['assign', 'pregate', 'judge'] as const) {
    const v = c[key];
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 50) out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** `loops.stewardSpace` from raw config JSON. Absent/invalid → undefined (every scope `off`). */
export function parseStewardSpaceConfig(raw: unknown): StewardSpaceConfig | undefined {
  const r = obj(raw);
  if (!r) return undefined;
  const scopes: Record<string, StewardSpaceScopeConfig> = {};
  for (const [name, value] of Object.entries(obj(r.scopes) ?? {})) {
    const scope = name.trim().toUpperCase();
    const s = obj(value);
    if (!SCOPE_NAME.test(scope) || !s) continue;
    const caps = parseCaps(s.caps);
    const entry: { mode?: StewardSpaceMode; profile?: StewardSpaceProfile; caps?: Partial<StewardSpaceCaps> } = {};
    if (typeof s.mode === 'string' && MODES.has(s.mode)) entry.mode = s.mode as StewardSpaceMode;
    if (typeof s.profile === 'string' && PROFILES.has(s.profile)) entry.profile = s.profile as StewardSpaceProfile;
    if (caps) entry.caps = caps;
    if (Object.keys(entry).length) scopes[scope] = entry;
  }
  const out: { -readonly [K in keyof StewardSpaceConfig]: StewardSpaceConfig[K] } = {};
  if (Object.keys(scopes).length) out.scopes = scopes;
  if (typeof r.defaultMode === 'string' && MODES.has(r.defaultMode)) out.defaultMode = r.defaultMode as StewardSpaceMode;
  const caps = parseCaps(r.caps);
  if (caps) out.caps = caps;
  const hosts = strList(r.pregateHosts);
  if (hosts) out.pregateHosts = hosts;
  if (typeof r.hostSlots === 'number' && Number.isSafeInteger(r.hostSlots) && r.hostSlots > 0) out.hostSlots = r.hostSlots;
  const load = posNum(r.maxLoadPerCore);
  if (load !== undefined) out.maxLoadPerCore = load;
  for (const key of ['pregateTool', 'receiptsDir', 'reviewResultsDir', 'utilDir', 'repo'] as const) { const v = str(r[key]); if (v) out[key] = v; }
  const cuts = strList(r.cutTimes)?.filter((t) => /^\d{2}:\d{2}$/.test(t));
  if (cuts) out.cutTimes = cuts;
  const window = posNum(r.cutWindowMinutes);
  if (window !== undefined) out.cutWindowMinutes = window;
  return Object.keys(out).length ? out : undefined;
}
