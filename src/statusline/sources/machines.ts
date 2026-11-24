// STATUSLINE-SOURCES-RESPONSIVE slice 1 — the `machines` source (DESIGN-MESSAGE-SOURCE-AND-STATUSLINE-1117 §2c·§2d).
// One value for the whole fleet, exception first: healthy = a single «●»; otherwise the worst host and how many more.
// The numbers come from the Nexus (`/v1/ops/resources`, folded from the resource ledger's heartbeats): the status line
// never runs ssh or kubectl and never waits on the network while it draws — a poller keeps the last answer in memory.
import type { ResourcesMap } from '../../ops/resources.js';

export type FleetLevel = 'ok' | 'warn' | 'danger' | 'unknown';

export interface FleetValue {
  readonly level: FleetLevel;
  /** What the segment draws: «●» when healthy, else the worst host first («⚑ node-c 1.4×», «node-b ?»). */
  readonly text: string;
  readonly hot: number;
  readonly warm: number;
  readonly idle: number;
  readonly unknown: number;
}

// 출처: §2c load/ncpu bands (대표 11-17) — <0.3 idle · 0.3–0.9 ok · 0.9–1.2 warn · >1.2 danger (the overload line).
const IDLE_BELOW = 0.3;
const WARN_FROM = 0.9;
const DANGER_ABOVE = 1.2;
// A heartbeat older than this is not a measurement any more: five missed refreshes means the host stopped reporting.
// 출처: §2c remote refresh TTL 60 s × 5 missed beats.
export const FLEET_STALE_MS = 5 * 60_000;

type HostVerdict = { name: string; band: 'idle' | 'ok' | 'warn' | 'danger' | 'unknown'; ratio: number | null };

function verdictFor(host: ResourcesMap['hosts'][number], now: number): HostVerdict {
  const load = host.load1.value;
  const cpus = host.cpuCount.value;
  const at = host.load1.observedAt ? Date.parse(host.load1.observedAt) : NaN;
  if (load === null || cpus === null || cpus <= 0 || !Number.isFinite(at) || now - at > FLEET_STALE_MS) {
    return { name: host.name, band: 'unknown', ratio: null };
  }
  const ratio = load / cpus;
  const band = ratio > DANGER_ABOVE ? 'danger' : ratio >= WARN_FROM ? 'warn' : ratio < IDLE_BELOW ? 'idle' : 'ok';
  return { name: host.name, band, ratio };
}

const times = (ratio: number) => `${ratio.toFixed(1)}×`;

/** Fold the Nexus resources view into the fleet value. No hosts at all is «unknown», never «healthy». */
export function fleetFromResources(map: ResourcesMap | null, now: number): FleetValue {
  if (!map || map.hosts.length === 0) return { level: 'unknown', text: 'fleet ?', hot: 0, warm: 0, idle: 0, unknown: 0 };
  const rows = map.hosts.map((host) => verdictFor(host, now));
  const count = (band: HostVerdict['band']) => rows.filter((row) => row.band === band).length;
  const hot = count('danger');
  const warm = count('warn');
  const idle = count('idle');
  const unknown = count('unknown');
  const worst = [...rows].filter((row) => row.ratio !== null).sort((a, b) => b.ratio! - a.ratio!)[0];
  if (hot > 0 && worst) {
    return { level: 'danger', text: `⚑ ${worst.name} ${times(worst.ratio!)}${hot > 1 ? ` +${hot - 1} hot` : ''}`, hot, warm, idle, unknown };
  }
  if (warm > 0 && worst) {
    return { level: 'warn', text: `▲ ${worst.name} ${times(worst.ratio!)}${warm > 1 ? ` +${warm - 1}` : ''}`, hot, warm, idle, unknown };
  }
  if (unknown > 0) {
    const first = rows.find((row) => row.band === 'unknown')!;
    return { level: 'unknown', text: `${first.name} ?${unknown > 1 ? ` +${unknown - 1}` : ''}`, hot, warm, idle, unknown };
  }
  // Quiet health: one dot. Idle capacity is not an exception for the status line (the guardian handles it).
  return { level: 'ok', text: '●', hot, warm, idle, unknown };
}

/** One host's load as the status rows draw it (TUI-STATUS-3ROW row 3): `node-b 25⚠` · `minim5 4` · `mbp ?`. */
export interface HostLoad {
  readonly name: string;
  /** load1 rounded; null = not measured or older than FLEET_STALE_MS. */
  readonly load: number | null;
  /** load1 / cpus at or above the warn band (§2c 0.9). */
  readonly warn: boolean;
  readonly text: string;
}

/** Per-host loads from the same Nexus answer the fleet fold uses (no second read, no ssh). */
export function hostLoads(map: ResourcesMap | null, now: number): HostLoad[] {
  if (!map) return [];
  return map.hosts.map((host) => {
    const verdict = verdictFor(host, now);
    if (verdict.ratio === null || host.load1.value === null) return { name: host.name, load: null, warn: false, text: `${host.name} ?` };
    const load = Math.round(host.load1.value);
    const warn = verdict.ratio >= WARN_FROM;
    return { name: host.name, load, warn, text: `${host.name} ${load}${warn ? '⚠' : ''}` };
  });
}

/** The snapshot fields the definition reads (`machines.level`, `machines.text`, …). */
export function machinesSnapshot(value: FleetValue): Record<string, string | number> {
  return { level: value.level, text: value.text, hot: value.hot, warm: value.warm, idle: value.idle, unknown: value.unknown };
}

export interface FleetPoller {
  /** The last fold; «unknown» until the first answer, and after a failed read. Never blocks. */
  current(): FleetValue;
  stop(): void;
}

/**
 * Ask the Nexus every `intervalMs` (off the render path) and keep the fold. A failed or refused read keeps the status
 * line drawing with «fleet ?»; `onChange` fires only when the drawn value changes.
 */
export function startFleetPoller(options: {
  readonly read: () => Promise<ResourcesMap | null>;
  readonly onChange?: (value: FleetValue) => void;
  readonly intervalMs?: number;
  readonly now?: () => number;
}): FleetPoller {
  // 출처: §2c «원격 60s» refresh for remote measurements.
  const intervalMs = options.intervalMs ?? 60_000;
  const now = options.now ?? Date.now;
  let value = fleetFromResources(null, now());
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    let next: FleetValue;
    try { next = fleetFromResources(await options.read(), now()); } catch { next = fleetFromResources(null, now()); }
    if (stopped) return;
    const changed = next.text !== value.text || next.level !== value.level;
    value = next;
    if (changed) options.onChange?.(value);
    timer = setTimeout(() => { void tick(); }, intervalMs);
    // A poller must never keep the process alive on its own.
    (timer as { unref?: () => void }).unref?.();
  };
  void tick();
  return {
    current: () => value,
    stop: () => { stopped = true; if (timer) clearTimeout(timer); },
  };
}

// 출처: one status-line refresh must not hold a socket longer than a frame budget would notice; the Nexus answers
// this cached view in milliseconds.
const READ_TIMEOUT_MS = 3_000;

/** What a read found — «no Nexus here» and «the Nexus refused us» are different things (#38260 REVIEW-2 ①). */
export type FleetRead =
  | { readonly kind: 'ok'; readonly map: ResourcesMap }
  | { readonly kind: 'no-nexus' }
  /** The token works but this Nexus does not serve ops views to it (operator mode off): no fleet here, quietly. */
  | { readonly kind: 'not-operator' }
  /** The Nexus refuses the token itself: a mismatch worth showing. */
  | { readonly kind: 'refused'; readonly status: number }
  | { readonly kind: 'failed' };

/**
 * Read the fleet view from the local Nexus, found the way the CLI finds it (src/nexus/local-endpoint.ts: the address
 * and the token path are shared, read-only).
 */
export async function readNexusResources(deps: {
  readonly baseUrl?: () => string | undefined;
  readonly token?: () => string | undefined;
  readonly fetchImpl?: typeof fetch;
} = {}): Promise<FleetRead> {
  let baseUrl: string | undefined;
  let token: string | undefined;
  try {
    const endpoint = deps.baseUrl && deps.token ? undefined : await import('../../nexus/local-endpoint.js');
    baseUrl = deps.baseUrl ? deps.baseUrl() : endpoint!.localNexusBaseUrl();
    token = deps.token ? deps.token() : endpoint!.readLocalNexusToken();
  } catch { return { kind: 'no-nexus' }; }
  if (!baseUrl) return { kind: 'no-nexus' };
  try {
    const response = await (deps.fetchImpl ?? fetch)(`${baseUrl.replace(/\/+$/, '')}/v1/ops/resources`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      // The ops view answers 401 to every non-operator caller, valid token or not (ops-api.ts). Ask a plain owner route
      // with the same token to tell «operator mode off» (quiet) from «token refused» (shown).
      const probe = await (deps.fetchImpl ?? fetch)(`${baseUrl.replace(/\/+$/, '')}/v1/nexus`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      return probe.ok ? { kind: 'not-operator' } : { kind: 'refused', status: response.status };
    }
    if (!response.ok) return { kind: 'failed' };
    const body = await response.json() as Partial<ResourcesMap>;
    return Array.isArray(body.hosts) ? { kind: 'ok', map: body as ResourcesMap } : { kind: 'failed' };
  } catch { return { kind: 'failed' }; }
}

/** The segment when the Nexus answers but refuses this TUI's token: shown, so a token mismatch never hides it silently. */
const REFUSED: FleetValue = { level: 'unknown', text: 'fleet auth?', hot: 0, warm: 0, idle: 0, unknown: 0 };

/**
 * The fleet segment as the Next TUI uses it: `value()` for the footer, `start()` after the first paint.
 *   • no Nexus here (no URL, no runtime), or a Nexus that tracks no hosts → no segment;
 *   • the Nexus refuses the token (401/403) → «fleet auth?» (#38260 REVIEW-2 ①: never a silent forever-hidden segment);
 *   • after a first good answer, a failed read is «?».
 */
export function createFleetSegment(options: {
  readonly onChange: () => void;
  readonly read?: () => Promise<FleetRead>;
  readonly intervalMs?: number;
  readonly now?: () => number;
}): { value(): FleetValue | undefined; hosts(): readonly HostLoad[]; start(): void; stop(): void } {
  let poller: FleetPoller | undefined;
  let seen = false;
  let lastMap: ResourcesMap | null = null;
  let hostsKey = '';
  const now = options.now ?? Date.now;
  let refused = false;
  let stopped = false;
  const read = options.read ?? (() => readNexusResources());
  return {
    value: () => (refused ? REFUSED : seen ? poller?.current() : undefined),
    hosts: () => (refused || !seen ? [] : hostLoads(lastMap, now())),
    start: () => {
      if (poller) return;
      poller = startFleetPoller({
        read: async () => {
          const answer = await read();
          if (stopped) return null; // An answer that lands after stop() changes nothing.
          const wasRefused = refused;
          refused = answer.kind === 'refused';
          if (answer.kind === 'ok' && answer.map.hosts.length > 0) seen = true;
          if (answer.kind === 'ok') lastMap = answer.map;
          // TUI-STATUS-3ROW row 3 draws each host's load: repaint when those numbers move, not only the fleet fold.
          const nextKey = hostLoads(lastMap, now()).map((host) => host.text).join(' ');
          const hostsChanged = nextKey !== hostsKey;
          hostsKey = nextKey;
          // When the fold changes too, the poller's own onChange repaints — one repaint per answer, not two.
          const fold = answer.kind === 'ok' ? fleetFromResources(answer.map, now()) : null;
          const foldChanges = fold !== null && poller !== undefined
            && (fold.text !== poller.current().text || fold.level !== poller.current().level);
          if (refused !== wasRefused || (hostsChanged && seen && !refused && !foldChanges)) options.onChange();
          return answer.kind === 'ok' ? answer.map : null;
        },
        onChange: () => { if (seen && !refused) options.onChange(); },
        ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
    },
    stop: () => { stopped = true; poller?.stop(); },
  };
}
