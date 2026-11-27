// ELS-BATON-ACTING-FALLBACK (OP 11-26) — every rail on 11-26 skipped OP's migration with «acting-unhealthy (deadline
// before the acting seat was verified)» because TC's own turn boundary came after the deadline; the CEO migrated OP by
// hand. Sim: seeded restart delays, literal expectations, virtual clock only (no els server, no panes).
import { describe, expect, test } from 'bun:test';
import { BatonLease } from './baton.js';
import { updateAllElsTabs, updateAllReasonText, type UpdateAllDeps, type UpdatePane, type UpdateSeatRow } from './update-all.js';

const T0 = Date.parse('2026-11-26T12:00:00Z');
const DESIRED = 'd'.repeat(40);
const OLD = 'e'.repeat(40);
const TIMEOUT = 60_000; // 출처: #39942 baton-auto world() timeoutMs — patience 20s, OP extension 40s (min(10m, t/3) · min(20m, 2t/3))

/** mulberry32 — a deterministic seed per run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface WorldOpts {
  /** ms after its migrate request at which TC is back on the new build; null = never inside the run. */
  tcBackAfter: number | null;
  /** UX: an eln fallback that restarts after this many ms; null = no UX pane. */
  uxBackAfter?: number | null;
  /** A codex JUD pane (alive, never migrated). */
  codexJud?: boolean;
  fallbacks?: readonly string[];
}

function world(opts: WorldOpts) {
  let now = T0;
  const timeline: string[] = [];
  const down = new Set<string>();
  const restartAt = new Map<string, number>();
  let opDownWithActing = 0;
  let handedTo: string | null = null;
  let handAt = -1;
  const live: Record<string, UpdateSeatRow> = {
    OP: { id: 'op-1', seat: 'OP', ownerPid: 101, alive: true, kind: 'tui', sessionId: 's-op', workdir: '/w/OP', build: { sha: OLD, source: 'installed' } },
    TC: { id: 'tc-1', seat: 'TC', ownerPid: 201, alive: true, kind: 'tui', sessionId: 's-tc', workdir: '/w/TC', build: { sha: OLD, source: 'installed' } },
  };
  const panes: UpdatePane[] = [
    { address: 'mshq:OP', host: 'mshq', reach: 'local', seat: 'OP', state: 'idle', cwd: '/w/OP', pid: 101, kind: 'eln' },
    { address: 'mshq:TC', host: 'mshq', reach: 'local', seat: 'TC', state: 'busy', cwd: '/w/TC', pid: 201, kind: 'eln' },
  ];
  const backAfter: Record<string, number | null> = { TC: opts.tcBackAfter, OP: 3_000 };
  if (opts.uxBackAfter !== undefined && opts.uxBackAfter !== null) {
    live.UX = { id: 'ux-1', seat: 'UX', ownerPid: 301, alive: true, kind: 'tui', sessionId: 's-ux', workdir: '/w/UX', build: { sha: OLD, source: 'installed' } };
    panes.push({ address: 'mshq:UX', host: 'mshq', reach: 'local', seat: 'UX', state: 'idle', cwd: '/w/UX', pid: 301, kind: 'eln' });
    backAfter.UX = opts.uxBackAfter;
  }
  if (opts.codexJud) panes.push({ address: 'mshq:JUD', host: 'mshq', reach: 'local', seat: 'JUD', state: 'idle', cwd: '/w/JUD', pid: 401, kind: 'codex' });
  const seats = (): UpdateSeatRow[] => {
    for (const [seat, at] of restartAt) if (now >= at) {
      live[seat] = { ...live[seat]!, ownerPid: live[seat]!.ownerPid + 1, build: { sha: DESIRED, source: 'installed' } };
      down.delete(seat); restartAt.delete(seat); timeline.push(`${seat} up`);
    }
    if (down.has('OP') && handedTo && down.has(handedTo)) opDownWithActing++;
    return Object.values(live).filter(row => !down.has(row.seat!));
  };
  const deps: UpdateAllDeps = {
    sender: () => 'OP',
    target: () => ({ desired: DESIRED, installed: DESIRED }),
    list: async () => ({ panes, hosts: [{ name: 'mshq', reach: 'local' }] }),
    seats,
    migrate: async (seat) => {
      timeline.push(`${seat} migrate`);
      const after = backAfter[seat];
      // A busy TC accepts the turn-boundary wait but stays up until its turn ends.
      if (seat !== 'TC') down.add(seat);
      if (after !== null && after !== undefined) restartAt.set(seat, now + after);
      return { status: 'success', reason: 'waiting' };
    },
    sleep: async (ms) => { now += ms; },
    now: () => now,
    timeoutMs: TIMEOUT,
    baton: {
      acting: 'TC',
      fallbacks: opts.fallbacks ?? ['UX', 'JUD'],
      hand: async (_reason, _exclude, acting) => { handedTo = acting; handAt = now - T0; timeline.push(`baton hand ${acting}`); return { ok: true }; },
      giveBack: async () => { timeline.push('baton return'); return true; },
      skip: async (reason) => { timeline.push(`baton skip: ${reason}`); },
    },
  };
  return { deps, timeline, elapsed: () => now - T0, handAt: () => handAt, opDownWithActing: () => opDownWithActing };
}

const SEEDS = [11, 26, 1126, 40262];

describe('update-all OP baton — fallback acting seat and bounded extension (seeded)', () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}: TC stuck in a long turn, UX healthy → after patience UX holds the lease, OP migrates`, async () => {
      const r = rng(seed);
      const w = world({ tcBackAfter: null, uxBackAfter: 1_000 + Math.floor(r() * 15_000) });
      const result = await updateAllElsTabs(w.deps);
      expect(w.timeline.filter(line => line.startsWith('baton'))).toEqual(['baton hand UX', 'baton return']);
      expect(w.timeline.indexOf('baton hand UX')).toBeGreaterThan(w.timeline.indexOf('UX up'));
      expect(result.rows.find(row => row.seat === 'OP')).toMatchObject({ result: 'updated', detail: `${DESIRED.slice(0, 12)} · baton returned` });
      expect(result.rows.find(row => row.seat === 'TC')?.result).toBe('waiting'); // straggler, listed
      expect(w.opDownWithActing()).toBe(0);
      // The hand came right after the 20s patience window (UX already up), not at the 60s deadline.
      expect(w.handAt()).toBeGreaterThanOrEqual(20_000);
      expect(w.handAt()).toBeLessThanOrEqual(21_000);
      // The run itself still ends at the deadline: TC is a listed straggler.
      expect(w.elapsed()).toBe(TIMEOUT);
    });

    test(`seed ${seed}: TC back after the deadline but inside the extension → TC holds the lease, OP migrates`, async () => {
      const r = rng(seed);
      const w = world({ tcBackAfter: TIMEOUT + 1_000 + Math.floor(r() * 30_000), fallbacks: [] });
      const result = await updateAllElsTabs(w.deps);
      expect(w.timeline).toEqual(['TC migrate', 'TC up', 'baton hand TC', 'OP migrate', 'OP up', 'baton return']);
      expect(result.rows.map(row => [row.seat, row.result])).toEqual([['TC', 'updated'], ['OP', 'updated']]);
      expect(result.ok).toBe(true);
      expect(w.elapsed()).toBeGreaterThan(TIMEOUT);
      expect(w.elapsed()).toBeLessThanOrEqual(TIMEOUT + 40_000);
    });

    test(`seed ${seed}: TC back inside the patience window → TC is preferred over a healthy fallback`, async () => {
      const r = rng(seed);
      const w = world({ tcBackAfter: 2_000 + Math.floor(r() * 15_000), uxBackAfter: 1_000 });
      await updateAllElsTabs(w.deps);
      expect(w.timeline.filter(line => line.startsWith('baton'))).toEqual(['baton hand TC', 'baton return']);
    });
  }

  test('a live codex fallback pane holds the lease when TC is stuck and UX is absent', async () => {
    const w = world({ tcBackAfter: null, codexJud: true });
    const result = await updateAllElsTabs(w.deps);
    expect(w.timeline.filter(line => line.startsWith('baton'))).toEqual(['baton hand JUD', 'baton return']);
    expect(result.rows.find(row => row.seat === 'OP')?.result).toBe('updated');
  });

  test('no healthy candidate through the extension → OP is skipped once, after deadline + extension', async () => {
    const w = world({ tcBackAfter: null, fallbacks: [] });
    const result = await updateAllElsTabs(w.deps);
    expect(w.timeline).toEqual(['TC migrate', 'baton skip: acting-unhealthy (deadline before the acting seat was verified)']);
    expect(w.elapsed()).toBeGreaterThanOrEqual(TIMEOUT + 40_000);
    expect(result.ok).toBe(false);
  });
});

describe('baton lease — automatic hand to a fallback seat', () => {
  test('autoHand names UX or JUD; any other seat is refused', () => {
    const lease = new BatonLease(() => {}, () => T0);
    expect(lease.autoHand('update-all', 'UX')).toEqual({ handed: true, baton: { owner: 'OP', acting: 'UX', reason: 'OP restart update-all', expiresAt: '2026-11-26T12:15:00.000Z' } });
    expect(lease.autoHand('again', 'TC').handed).toBe(false);
    const other = new BatonLease(() => {}, () => T0);
    expect(() => other.autoHand('update-all', 'MK')).toThrow('acting seat must be one of TC, UX, JUD');
    expect(other.autoHand('update-all').baton.acting).toBe('TC');
  });
});

describe('update-all refusal text', () => {
  test('operator-seat-required says to run from seats/OP', () => {
    expect(updateAllReasonText('operator-seat-required', null, '/Users/x/elanous-hq/repo.git')).toBe(
      'operator-seat-required — update-all runs as OP (or RES-INFRA), but this shell is not a seat (cwd /Users/x/elanous-hq/repo.git). '
      + 'Run it from ~/elanous-hq/seats/OP (cd ~/elanous-hq/seats/OP && els update-all), or set COORD_ID=OP.');
    expect(updateAllReasonText('operator-seat-required', 'TC', '/h/seats/TC')).toContain('this shell is seat TC (cwd /h/seats/TC)');
    expect(updateAllReasonText('desired-build-not-installed', 'OP', '/h/seats/OP')).toBe('desired-build-not-installed');
  });
});
