// KIT jev-decide · circuit breaker — a 402 (credits exhausted) or 429 (rate limit) from a Jev endpoint stops EVERY site in
// every process from calling that endpoint for the policy's cooldown (jev-sites.yaml `breaker`). Sites take their fallback.
//
// S: 2026-09-20 Jev answered 402 after a day of use; each site folded it to null and asked again on the next call (the
//    memory recall site alone would re-hit it ~6,900×/day). Nobody was told.
// A: one breaker per endpoint, kept in a small state file (`<state>/jev/breaker.json`) so the TUI, the harness and the
//    daemon share it. A 402 opens it for `creditCooldownMinutes` and starts an «outage episode»: ONE OP card per episode
//    (the msg ledger's provenance key makes a second process's card the same row). After the cooldown the next call is a
//    probe: success closes the breaker and ends the episode; another 402 re-opens it in the SAME episode (no new card).
//
// 세 얼굴: 관측 = `jev.decide` lines carry reason `breaker-open` ⊕ the card · 판단 근거 = HTTP status only (402 · 429) ·
// 수복과 인계 = fallback at each site; OP tops up credits (auto-reload is a 대표 money decision); the next probe closes it.
// Fail-open: an unreadable / unwritable state file behaves as an in-memory breaker for this process.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../../autopilot/state-paths.js';

export type JevBreakerCause = 'credit' | 'rate-limit';

export interface JevBreakerEntry {
  readonly openUntil: number;
  readonly cause: JevBreakerCause;
  /** Outage episode id (stable across re-trips until a success closes it). */
  readonly episode: string;
}

export interface JevBreakerTrip { readonly episode: string; readonly firstInEpisode: boolean; readonly openUntil: number }

export interface JevBreaker {
  /** The open entry for `endpoint` at `now`, or null when calls may go out. */
  check(endpoint: string, now: number): JevBreakerEntry | null;
  trip(endpoint: string, cause: JevBreakerCause, now: number, cooldownMs: number): JevBreakerTrip;
  /** A successful call: close the breaker and end the episode. */
  reset(endpoint: string): void;
}

type Store = Record<string, JevBreakerEntry>;

function hostOf(endpoint: string): string {
  try { return new URL(endpoint).host || endpoint; } catch { return endpoint; }
}

function makeBreaker(load: () => Store, save: (s: Store) => void): JevBreaker {
  return {
    check(endpoint, now) {
      const e = load()[endpoint];
      return e && e.openUntil > now ? e : null;
    },
    trip(endpoint, cause, now, cooldownMs) {
      const s = load();
      const prev = s[endpoint];
      // Same outage while no success has closed it (a probe that hit 402 again) — or a 429 inside a credit outage.
      const sameEpisode = prev !== undefined && (prev.cause === cause || prev.cause === 'credit');
      // A bucketed id: two processes tripping in the same cooldown window name the same episode (one card).
      const episode = sameEpisode ? prev!.episode : `${cause}:${hostOf(endpoint)}:${Math.floor(now / Math.max(1, cooldownMs))}`;
      const keepCause: JevBreakerCause = prev?.cause === 'credit' ? 'credit' : cause;
      const openUntil = Math.max(prev && sameEpisode ? prev.openUntil : 0, now + cooldownMs);
      s[endpoint] = { openUntil, cause: keepCause, episode };
      save(s);
      return { episode, firstInEpisode: !sameEpisode, openUntil };
    },
    reset(endpoint) {
      const s = load();
      if (!(endpoint in s)) return;
      delete s[endpoint];
      save(s);
    },
  };
}

/** Process-local breaker (tests · sims · a caller with injected transport). */
export function memoryJevBreaker(): JevBreaker {
  let s: Store = {};
  return makeBreaker(() => ({ ...s }), (next) => { s = { ...next }; });
}

export function jevBreakerFile(root: string = join(elanousStateRoot(), 'jev')): string {
  return join(root, 'breaker.json');
}

/** File-backed breaker shared by every process of this instance. Unreadable/unwritable file → this process's memory. */
export function fileJevBreaker(file: string = jevBreakerFile()): JevBreaker {
  let mem: Store = {};
  const load = (): Store => {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      const out: Store = {};
      for (const [k, v] of Object.entries(raw)) {
        const e = v as Partial<JevBreakerEntry>;
        if (typeof e?.openUntil === 'number' && (e.cause === 'credit' || e.cause === 'rate-limit') && typeof e.episode === 'string') out[k] = { openUntil: e.openUntil, cause: e.cause, episode: e.episode };
      }
      mem = out;
      return { ...out };
    } catch { return { ...mem }; }
  };
  const save = (s: Store): void => {
    mem = { ...s };
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(s));
      renameSync(tmp, file);
    } catch { /* fail-open: this process still honours the in-memory entry */ }
  };
  return makeBreaker(load, save);
}

let live: JevBreaker | null = null;
/** The instance breaker the live path uses (lazy · one per process · state shared through the file). */
export function liveJevBreaker(): JevBreaker {
  if (!live) live = fileJevBreaker();
  return live;
}
