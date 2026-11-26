/**
 * Burst Board — the live «all resources» moment (BURST-DEMO-LIVE), TEST universe only.
 * One CEO line starts an all-in burst in a test seat-state; the driver then walks the story with real side effects
 * that are local and free: hands open as real els tabs (one workspace → `els tile` shows them as a grid), review and
 * pregate step up through the burst state, the forecast catches up from synthetic landed samples (written to the
 * test universe, labelled synthetic), the burst exits early, every tab it opened is closed by its exact pane id,
 * and the receipt is filed. No paid VM, no remote host: cloud tiles stay «sim» on the board.
 * Side effects are injected (spawn/close/sleep/now) so the timeline is tested without els.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_BURST_CONFIG, exitBurst, recordLaunch, startBurst, type BurstReceipt, type BurstState } from '../../../loops/op-pulse-burst.js';
import { readActiveBurst, writeBurst } from '../../../loops/op-pulse-run.js';

/** Synthetic forecast the live board reads from a test universe (never from the real seat-state). */
export interface BurstForecastFile {
  readonly synthetic: true;
  readonly deadline: string;
  readonly forecast: string;
  readonly forecastOk: boolean;
  readonly forecastWas?: string;
  readonly landedPerHour: readonly number[];
  readonly lanes?: Partial<Record<'Hands' | 'Review' | 'Pregate', { queue: number | null; waitMin: number | null }>>;
}

export interface AllInDeps {
  /** Open one hand tab; returns its exact pane id. */
  readonly spawn: (index: number) => Promise<string>;
  /** Close one tab by its exact pane id. */
  readonly close: (paneId: string) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => Date;
  readonly log: (line: string) => void;
}

export interface AllInOptions {
  readonly seatState: string;
  readonly phrase: string;
  readonly hands: number;
  /** 1 = about 90 seconds end to end; 2 = twice as fast. */
  readonly speed: number;
}

const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const LAND_TARGET = 20;
const REMAINING_WORK = 60;

/** Forecast = now + remaining ÷ landed/h (same rule as the board's deadline card). */
export function forecastAt(now: Date, landedPerH: number): Date {
  return new Date(now.getTime() + (REMAINING_WORK / Math.max(1, landedPerH)) * 3_600_000);
}

export async function runAllIn(opts: AllInOptions, deps: AllInDeps): Promise<{ state: BurstState; receipt: BurstReceipt }> {
  const pulse = join(opts.seatState, 'OP', 'pulse');
  mkdirSync(pulse, { recursive: true });
  const burstPath = join(pulse, 'burst.json');
  const forecastPath = join(pulse, 'burst-forecast.json');
  const wait = (sec: number) => deps.sleep(Math.round((sec * 1000) / Math.max(0.25, opts.speed)));
  const t0 = deps.now();
  const deadline = new Date(t0.getTime() + 4 * 3_600_000);
  const series: number[] = Array.from({ length: 12 }, () => 8);
  let lanes: NonNullable<BurstForecastFile['lanes']> = { Hands: { queue: 31, waitMin: 22 }, Review: { queue: 2, waitMin: 6 }, Pregate: { queue: 1, waitMin: 3 } };
  const writeForecast = (landed: number, was?: string) => {
    const at = forecastAt(deps.now(), landed);
    const file: BurstForecastFile = { synthetic: true, deadline: `cut ${hhmm(deadline)}`, forecast: hhmm(at), forecastOk: at.getTime() <= deadline.getTime(),
      ...(was ? { forecastWas: was } : {}), landedPerHour: [...series], lanes };
    writeFileSync(forecastPath, `${JSON.stringify(file)}\n`);
    return file;
  };
  const before = writeForecast(8);
  deps.log(`calm: landed/h 8 · forecast ${before.forecast} vs cut ${hhmm(deadline)} — misses`);

  let state = startBurst({ goal: 'land', until: deadline.toISOString(), scope: ['ALL'], by: 'CEO', now: t0,
    preset: DEFAULT_BURST_CONFIG.presets.find((p) => p.name === '4h')!, trigger: `CEO «${opts.phrase}»`, allIn: true, baseline: { landed: 8, green: null } }, readActiveBurst(burstPath));
  state = { ...state, levels: { hands: 0, review: 0, pregate: 0 } };
  writeBurst(burstPath, state);
  deps.log(`burst ${state.id} started by CEO «${opts.phrase}» (test universe · local only · no VM)`);

  const opened: string[] = [];
  let failure: unknown = null;
  try {
    for (let i = 0; i < opts.hands; i++) {
      const pane = await deps.spawn(i);
      opened.push(pane);
      state = recordLaunch(state, { lane: 'hands', id: pane, host: 'mshq' }, deps.now(), 0);
      state = { ...state, levels: { ...state.levels, hands: i + 1 }, lastChangeAt: { ...state.lastChangeAt, hands: deps.now().toISOString() } };
      writeBurst(burstPath, state);
      deps.log(`hand ${i + 1}/${opts.hands} opened · els pane ${pane}`);
      await wait(1.5);
    }
    lanes = { Hands: { queue: 12, waitMin: 6 }, Review: { queue: 9, waitMin: 24 }, Pregate: { queue: 5, waitMin: 12 } };
    writeForecast(series.at(-1)!, before.forecast);
    deps.log('review queue 9 · wait 24m vs 20m — bottleneck behind the new hands');
    await wait(8);
    for (const lane of ['review', 'pregate'] as const) {
      for (let i = 0; i < 2; i++) state = recordLaunch(state, { lane, id: `test-${lane}-mshq-${i}`, host: 'mshq' }, deps.now(), 0);
      state = { ...state, levels: { ...state.levels, [lane]: 2 }, lastChangeAt: { ...state.lastChangeAt, [lane]: deps.now().toISOString() } };
      writeBurst(burstPath, state);
      deps.log(`${lane} +2 (queue built up behind the new hands)`);
      await wait(6);
    }
    lanes = { Hands: { queue: 6, waitMin: 3 }, Review: { queue: 3, waitMin: 8 }, Pregate: { queue: 2, waitMin: 4 } };
    for (const landed of [11, 14, 17, 20, 23]) {
      series.shift();
      series.push(landed);
      const f = writeForecast(landed, before.forecast);
      deps.log(`landed/h ${landed} · forecast ${f.forecast} ${f.forecastOk ? '✓ catches the cut' : '✗'}`);
      await wait(5);
      if (landed >= LAND_TARGET && f.forecastOk) break;
    }
  } catch (e) { failure = e; }
  // Early exit (also on any failure): close every tab this run opened, by its exact id, and file the receipt.
  if (!failure) await wait(3);
  const reason = failure ? `aborted: ${failure instanceof Error ? failure.message : String(failure)}` : 'early exit: forecast caught up';
  {
    const done = await exitBurst(state, { now: deps.now(), reason, landedNow: series.at(-1) ?? null, greenNow: null,
      closer: async (l) => { if (l.lane === 'hands' && opened.includes(l.id)) await deps.close(l.id); } });
    state = done.state;
    writeBurst(burstPath, state);
    appendFileSync(join(pulse, 'burst-receipts.jsonl'), `${JSON.stringify(done.receipt)}\n`);
    const r = done.receipt;
    deps.log(`receipt ${r.id}: trigger ${r.trigger} · launched ${r.launched} · closed ${r.closed} · close failed ${r.closeFailed.length} · cost $${r.costUsd.toFixed(2)} · ${r.reason}`);
    if (failure) throw failure;
    return done;
  }
}
