import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DecisionLedger, type DecisionEntry, type SeatDecisionRecord } from './decision-ledger.js';
import { createRequire } from 'node:module';
import { listCoordEvents, type CoordEvent } from '../context-bus/coord-events.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';

/** Directive row fields this meter reads — kept local because `src/directives/directive-index` is excluded from the public export. */
export interface DirectiveRow { ts: string; text: string; source_file: string; line_no: number }

/** Loads the private directive index at run time only, so public builds (no index) bundle cleanly and report `directivesError`. */
function openDirectiveIndex(stateDir?: string): { search(q: string, f: { since?: string; until?: string; limit?: number }): DirectiveRow[]; close(): void } {
  const spec = ['..', 'directives', 'directive-index.js'].join('/');
  const mod = createRequire(import.meta.url)(spec) as { DirectiveIndex: new (o: { stateDir?: string }) => ReturnType<typeof openDirectiveIndex> };
  return new mod.DirectiveIndex(stateDir ? { stateDir } : {});
}

/** KST calendar day, matching the seat-loop ledger file name. */
export function proactKstDay(at: Date | string): string {
  const date = typeof at === 'string' ? new Date(at) : at;
  if (!Number.isFinite(date.getTime())) throw new Error('valid timestamp required');
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function proactWindow(now: Date, days = 7): { since: string; until: string; days: string[] } {
  if (!Number.isFinite(now.getTime()) || !Number.isInteger(days) || days < 1) throw new Error('valid window required');
  const today = proactKstDay(now);
  const todayStart = Date.parse(`${today}T00:00:00+09:00`);
  const list: string[] = [];
  for (let i = days - 1; i >= 0; i--) list.push(proactKstDay(new Date(todayStart - i * 86_400_000)));
  return { since: new Date(todayStart - (days - 1) * 86_400_000).toISOString(), until: now.toISOString(), days: list };
}

export type ProactKind = 'proposal' | 'alert' | 'action';
export type ProactSource = 'decision' | 'directive' | 'coord' | 'loop';
export interface ProactSample {
  readonly day: string;
  readonly bucket: 'offered' | 'adopted' | 'asked';
  readonly source: ProactSource;
  readonly id: string;
  readonly at: string;
  readonly title: string;
  /** Where the original row lives, so a count can be opened again. */
  readonly link: string;
}
export interface ProactDay {
  readonly day: string;
  /** System offered a proposal, alert, or action before the owner asked. */
  readonly offered: number;
  /** Of those, the ones the owner (or a delegated seat) adopted. */
  readonly adopted: number;
  /** Problems that stayed invisible until the owner asked first. */
  readonly asked: number;
}
export interface ProactSourceStatus { readonly read: boolean; readonly reason?: string }
export interface ProactMeter {
  readonly since: string;
  readonly until: string;
  readonly days: readonly ProactDay[];
  readonly samples: readonly ProactSample[];
  readonly sources: Readonly<Record<ProactSource, ProactSourceStatus>>;
}

export interface ProactMeterInput {
  decisions?: readonly DecisionEntry[];
  seatDecisions?: readonly SeatDecisionRecord[];
  directives?: readonly DirectiveRow[];
  coord?: readonly CoordEvent[];
  loops?: readonly ProactLoopRow[];
  decisionsError?: string;
  directivesError?: string;
  coordError?: string;
  loopsError?: string;
}
export interface ProactLoopRow {
  readonly seat: string;
  readonly at: string;
  readonly status: string;
  readonly action?: string;
  readonly id?: string;
  readonly title?: string;
  readonly file: string;
}

const ALERT = /경보|경고|장애|실패|막힘|alert|fail|blocked|stall/i;
const ACTION = /조치|실행|발사|launch|queued|launched/i;
const ASKED = /왜|문제|안 되|안돼|고장|버그|실패|막혀|뭐가|무슨 일|확인해/;

export function proactKind(text: string, action?: string): ProactKind {
  if (action === 'decision' || action === 'harness' || action === 'seat-question' || ACTION.test(text)) return 'action';
  if (ALERT.test(text)) return 'alert';
  return 'proposal';
}

function sample(day: string, bucket: ProactSample['bucket'], source: ProactSource, id: string, at: string, title: string, link: string): ProactSample {
  return { day, bucket, source, id, at, title: title.replace(/\s+/g, ' ').trim().slice(0, 160), link };
}

/** Count one row once. Adoption is a property of an offered row, never a second offered row. */
export function measureProact(input: ProactMeterInput, now: Date, days = 7): ProactMeter {
  const window = proactWindow(now, days);
  const inWindow = (at: string | undefined): at is string => !!at && at >= window.since && at <= window.until;
  const offered: ProactSample[] = [];
  const adopted: ProactSample[] = [];
  const asked: ProactSample[] = [];

  if (!input.decisionsError) {
    for (const card of input.decisions ?? []) {
      const at = card.raisedAt ?? card.importedAt;
      if (!inWindow(at)) continue;
      const day = proactKstDay(at);
      const link = `decisions://${card.id}`;
      const system = card.raisedBy.agent !== 'human' && card.raisedBy.agent !== 'owner';
      if (system) {
        offered.push(sample(day, 'offered', 'decision', card.id, at, card.title, link));
        const decidedAt = card.decidedAt;
        const adoptedDay = decidedAt ? proactKstDay(decidedAt) : '';
        if (card.status === 'decided' && decidedAt && decidedAt <= window.until) {
          adopted.push(sample(adoptedDay, 'adopted', 'decision', card.id, decidedAt, card.title, link));
        }
      } else if (ASKED.test(`${card.title} ${card.scqa.c}`)) {
        asked.push(sample(day, 'asked', 'decision', card.id, at, card.title, link));
      }
    }
    for (const seat of input.seatDecisions ?? []) {
      if (!inWindow(seat.recordedAt)) continue;
      const at = seat.decidedAt && seat.decidedAt <= window.until ? seat.decidedAt : seat.recordedAt;
      const adoptedDay = proactKstDay(at);
      const link = `decisions://${seat.id}`;
      offered.push(sample(proactKstDay(seat.recordedAt), 'offered', 'decision', seat.id, seat.recordedAt, seat.title, link));
      if (window.days.includes(adoptedDay)) adopted.push(sample(adoptedDay, 'adopted', 'decision', seat.id, at, seat.title, link));
    }
  }

  if (!input.directivesError) {
    for (const row of input.directives ?? []) {
      if (!inWindow(row.ts) || !ASKED.test(row.text)) continue;
      asked.push(sample(proactKstDay(row.ts), 'asked', 'directive', `${row.source_file}:${row.line_no}`, row.ts, row.text, `directives://${row.source_file}#L${row.line_no}`));
    }
  }

  if (!input.coordError) {
    for (const event of input.coord ?? []) {
      if (!inWindow(event.at)) continue;
      const day = proactKstDay(event.at);
      const link = event.refs.url ?? `coord://${event.id}`;
      const text = `${event.summary} ${event.kind}`;
      const systemOffered = event.refs.seat && event.refs.seat !== 'CEO' && (event.kind === '제안' || event.kind === '보고' || event.kind === '사고' || ALERT.test(text) || ACTION.test(text));
      if (systemOffered) {
        offered.push(sample(day, 'offered', 'coord', event.id, event.at, event.summary, link));
      } else if (event.refs.seat === 'CEO' && (event.kind === '요청' || ASKED.test(text))) {
        asked.push(sample(day, 'asked', 'coord', event.id, event.at, event.summary, link));
      }
    }
  }

  if (!input.loopsError) {
    const proactive = new Set(['queued', 'launched', 'asked', 'hitl', 'shadow', 'attempting']);
    for (const row of input.loops ?? []) {
      if (!inWindow(row.at)) continue;
      const day = proactKstDay(row.at);
      const id = row.id ?? `${row.seat}:${row.at}`;
      const link = `loop://${row.file}#${id}`;
      const title = row.title ?? `${row.seat} ${row.status}`;
      if (proactive.has(row.status) || row.action === 'decision' || row.action === 'harness') {
        offered.push(sample(day, 'offered', 'loop', id, row.at, `${proactKind(title, row.action)}:${title}`, link));
        if (row.status === 'launched' || row.status === 'queued' || row.action === 'decision') {
          adopted.push(sample(day, 'adopted', 'loop', id, row.at, title, link));
        }
      }
    }
  }

  const tally = new Map<string, { day: string; offered: number; adopted: number; asked: number }>(window.days.map(day => [day, { day, offered: 0, adopted: 0, asked: 0 }]));
  for (const row of offered) tally.get(row.day)!.offered += 1;
  for (const row of adopted) {
    const cell = tally.get(row.day);
    if (cell) cell.adopted += 1;
  }
  for (const row of asked) tally.get(row.day)!.asked += 1;
  const pick = (rows: ProactSample[]) => {
    const seen = new Set<string>();
    const out: ProactSample[] = [];
    for (const source of ['decision', 'directive', 'coord', 'loop'] as const) {
      for (const row of rows.filter(item => item.source === source).sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))) {
        if (seen.has(row.link)) continue;
        seen.add(row.link);
        out.push(row);
        if (out.length === 2) break;
      }
    }
    return out;
  };
  const status = (error: string | undefined, read: boolean): ProactSourceStatus => error ? { read: false, reason: error } : { read };
  return {
    since: window.since, until: window.until,
    days: window.days.map(day => tally.get(day)!),
    samples: [...pick(offered), ...pick(adopted), ...pick(asked)],
    sources: {
      decision: status(input.decisionsError, !input.decisionsError),
      directive: status(input.directivesError, !input.directivesError),
      coord: status(input.coordError, !input.coordError),
      loop: status(input.loopsError, !input.loopsError),
    },
  };
}

function readLoopRows(root: string, days: readonly string[]): ProactLoopRow[] {
  const base = join(root, 'seat-loop');
  const seats = readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  const rows: ProactLoopRow[] = [];
  for (const seat of seats) {
    for (const day of days) {
      const file = join(base, seat, `${day}.jsonl`);
      let text = '';
      try { text = readFileSync(file, 'utf8'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as { at?: string; ts?: string; status?: string; action?: string; item?: { id?: string; title?: string } };
        const at = parsed.at ?? parsed.ts;
        if (!at || !parsed.status) continue;
        rows.push({ seat, at, status: parsed.status, action: parsed.action, id: parsed.item?.id, title: parsed.item?.title, file });
      }
    }
  }
  return rows;
}

export interface ProactMeterDeps {
  readonly now?: Date;
  readonly days?: number;
  readonly stateDir?: string;
  readonly instanceRoot?: string;
  readonly readDecisions?: () => { decisions: DecisionEntry[]; seatDecisions: SeatDecisionRecord[] };
  readonly readDirectives?: (since: string, until: string) => DirectiveRow[];
  readonly readCoord?: (since: string) => CoordEvent[];
  readonly readLoops?: (days: readonly string[]) => ProactLoopRow[];
}

/** Read the four ledgers. A source that cannot be opened is reported, never counted as zero evidence. */
export function readProactMeter(deps: ProactMeterDeps = {}): ProactMeter {
  const now = deps.now ?? new Date();
  const window = proactWindow(now, deps.days ?? 7);
  const input: ProactMeterInput = {};
  const stateDir = deps.stateDir;
  try {
    const read = deps.readDecisions ?? (() => {
      const ledger = new DecisionLedger(stateDir ? { stateDir } : {});
      return { decisions: ledger.list({ status: 'all', since: window.since }), seatDecisions: ledger.seatReport({ since: window.since }) };
    });
    const got = read();
    input.decisions = got.decisions;
    input.seatDecisions = got.seatDecisions;
  } catch (error) { input.decisionsError = error instanceof Error ? error.message : String(error); }
  try {
    input.directives = (deps.readDirectives ?? ((since, until) => {
      const index = openDirectiveIndex(stateDir);
      try { return index.search('', { since, until, limit: 1000 }); }
      finally { index.close(); }
    }))(window.since, window.until);
  } catch (error) { input.directivesError = error instanceof Error ? error.message : String(error); }
  try {
    input.coord = (deps.readCoord ?? ((since) => listCoordEvents({ since, channelOnly: true })))(window.since);
  } catch (error) { input.coordError = error instanceof Error ? error.message : String(error); }
  try {
    const loopRoot = deps.instanceRoot ?? stateDir ?? effectiveInstanceRoot() ?? elanousStateRoot();
    input.loops = (deps.readLoops ?? ((days) => readLoopRows(loopRoot, days)))(window.days);
  } catch (error) { input.loopsError = error instanceof Error ? error.message : String(error); }
  return measureProact(input, now, deps.days ?? 7);
}

export function formatProactMeter(meter: ProactMeter): string {
  const lines = [`선제성 ${meter.since} ~ ${meter.until}`, '날짜 · 먼저 냄 · 채택 · 물어서야'];
  for (const day of meter.days) lines.push(`${day.day} · ${day.offered} · ${day.adopted} · ${day.asked}`);
  const unread = (Object.entries(meter.sources) as Array<[ProactSource, ProactSourceStatus]>).filter(([, status]) => !status.read);
  if (unread.length) lines.push(`못 읽음: ${unread.map(([name, status]) => `${name}(${status.reason})`).join(' · ')}`);
  if (meter.samples.length) {
    lines.push('표본:');
    for (const row of meter.samples) lines.push(`  ${row.bucket} · ${row.source} · ${row.id} · ${row.link}`);
  }
  return lines.join('\n');
}
