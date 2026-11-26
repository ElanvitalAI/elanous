/**
 * Invest Research Board — pinned runs and replay. A pin is the event list a real graph run produced
 * (scripts/demo-invest-orch/board-live.ts `--record`), so `--replay` reproduces it frame for frame with no network.
 * Synthetic variants (slow child, failed child, empty evidence, long name) are pure edits of a pin, for the sim.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drawInvestBoard } from './invest-board-view.js';
import { reduceInvestBoard, renderInvestBoard, type BoardEvent, type BoardMeta } from './invest-board.js';

export interface InvestBoardPin {
  readonly schema: 'invest-board.pin/1';
  readonly recordedAt: string;
  readonly meta: BoardMeta;
  readonly events: readonly BoardEvent[];
}

export const DEFAULT_PIN = join(import.meta.dir, '..', '..', '..', '..', 'graphs', 'demo', 'invest-orch', 'fixtures', 'board-pin.json');

export function loadPin(path: string = DEFAULT_PIN): InvestBoardPin {
  const pin = JSON.parse(readFileSync(path, 'utf8')) as InvestBoardPin;
  if (pin.schema !== 'invest-board.pin/1' || !Array.isArray(pin.events)) throw new Error(`not an invest board pin: ${path}`);
  return { ...pin, events: [...pin.events].sort((a, b) => a.t - b.t) };
}

export const pinDurationMs = (pin: InvestBoardPin): number => pin.events.at(-1)?.t ?? 0;

export type PinVariant = 'slow-child' | 'failed-child' | 'empty-evidence' | 'long-name';

/** A synthetic edit of a real pin (seeded where it picks a node), for sims and tests. */
export function variantPin(pin: InvestBoardPin, variant: PinVariant, seed = 1): InvestBoardPin {
  const panelIds = [...new Set(pin.events.flatMap((e) => (e.kind === 'node' && /^(panel-(?!join)|mentor-)/u.test(e.id) ? [e.id] : [])))].sort();
  const pick = panelIds[(seed * 7) % Math.max(1, panelIds.length)];
  let events = [...pin.events];
  let meta = pin.meta;
  if (variant === 'slow-child') {
    // x-pulse ends 60 s later than recorded; everything that waited on the join shifts with it.
    const end = events.find((e) => e.kind === 'node' && e.id === 'x-pulse' && e.phase === 'end');
    const delay = 60_000 + seed * 1000;
    if (end) events = events.map((e) => (e === end || e.t > end.t && !(e.kind === 'node' && ['news', 'event-shock', 'market', 'flows', 'score', 'conatus-research', 'conatus-ops'].includes(e.id)) ? { ...e, t: e.t + delay } : e));
  } else if (variant === 'failed-child') {
    events = events.map((e) => (e.kind === 'node' && e.phase === 'end' && (e.id === 'x-pulse' || e.id === pick) ? { ...e, outcome: 'fail' as const } : e))
      .filter((e) => !(e.kind === 'evidence' && e.source === 'x-pulse') && !(e.kind === 'note' && e.id === pick && e.verdict));
  } else if (variant === 'empty-evidence') {
    events = events.filter((e) => e.kind !== 'evidence').map((e) => (e.kind === 'result' ? { ...e, result: { ...e.result, sources: [] } } : e));
  } else {
    meta = { ...meta, name: 'Samsung Electronics Co., Ltd. Preferred Shares (Korea Exchange, KOSPI 200 constituent)', ticker: '005935.KS' };
  }
  return { ...pin, meta, events: events.sort((a, b) => a.t - b.t) };
}

/** Frame at time t (ms into the run). */
export const pinFrame = (pin: InvestBoardPin, tMs: number, width: number, rows: number): string[] =>
  renderInvestBoard(reduceInvestBoard(pin.meta, pin.events, tMs), width, rows);

export interface ReplayIo {
  readonly write: (text: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly size: () => { columns: number; rows: number };
}

/** Plays the pin in real time ÷ speed: one frame per 250 ms of play, ending on the final frame. */
export async function playPin(pin: InvestBoardPin, io: ReplayIo, speed = 1): Promise<void> {
  const end = pinDurationMs(pin);
  const stepMs = 250;
  for (let play = 0; ; play += stepMs) {
    const t = Math.min(end + 1500, play * speed);
    const { columns, rows } = io.size();
    io.write(`\x1b[H\x1b[2J${drawInvestBoard(reduceInvestBoard(pin.meta, pin.events, t), columns, rows).ansi().join('\n')}`);
    if (t >= end + 1500) break;
    await io.sleep(stepMs);
  }
  io.write('\n');
}
