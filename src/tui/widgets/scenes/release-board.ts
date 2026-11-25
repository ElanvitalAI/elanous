/**
 * Release Board — the release graph as a board: header (version · profile · countdowns · mode · hard-stop banner),
 * phase lanes with steps as nodes (parallel branches side by side), the critical path in brackets, an events ticker
 * and a host strip. Pure: snapshot + ui + width + height → lines (each ≤ width cells, ≤ height lines).
 * Calm ↔ busy: running nodes turn their spinner once per real snapshot (`tick`); with nothing running the header dot
 * breathes. Nothing moves without a new snapshot.
 */
import { renderGauge, renderPulseDot, renderStatRow, renderTicker, type TickerEvent } from '../index.js';
import { cells, clean, fit, pad, wrap } from '../text.js';

export type BoardStatus = 'pending' | 'running' | 'done' | 'warn' | 'soft-fail' | 'stop' | 'skipped';

export interface BoardStep {
  readonly id: string;
  readonly phase: string;
  readonly label: string;
  readonly status: BoardStatus;
  readonly critical: boolean;
  readonly host: string;
  readonly hard: boolean;
  readonly startedAt?: string;
  readonly endedAt?: string;
  /** Clock gate (earliest start) when the step has one. */
  readonly earliestAt?: string;
  readonly cmd: string | null;
  readonly logPath: string;
  readonly ref?: string;
  readonly by?: string;
  readonly exit?: number | null;
  readonly warnings: readonly string[];
}

export interface BoardTraffic {
  readonly phase: string;
  readonly releaseHost: string;
  readonly slots: Readonly<Record<string, number>>;
}

export interface ReleaseBoardSnapshot {
  readonly version: string;
  readonly profile: 'normal' | 'quick-surgery';
  readonly mode: 'live' | 'shadow';
  /** `replay` = a test universe driven by synthetic events. */
  readonly universe: 'operating' | 'test' | 'replay';
  readonly now: string;
  readonly cutAt: string;
  readonly publishAt: string;
  readonly hardStop: { readonly step?: string; readonly reason: string; readonly noncritical?: boolean } | null;
  readonly done: boolean;
  readonly steps: readonly BoardStep[];
  readonly criticalMinutes: number;
  /** Newest first. */
  readonly events: readonly TickerEvent[];
  readonly freshEvent: boolean;
  /** Golden hosts and the step holding each (null = free). */
  readonly hosts: ReadonlyArray<{ readonly name: string; readonly busy: string | null }>;
  readonly traffic: BoardTraffic | null;
  /** Snapshot index — one per real refresh. */
  readonly tick: number;
  /** Run instances of this version (publish run · rehearsal attempts); `run` = the one shown. */
  readonly run: string;
  readonly instances: readonly string[];
  /** Following the newest instance (false = pinned with Tab). */
  readonly following: boolean;
}

export interface ReleaseBoardUi {
  readonly selected: number;
  readonly detail: boolean;
  readonly help: boolean;
  /** `p` preview: the snapshot shown is the quick-surgery projection of the run. */
  readonly preview: boolean;
  /** A confirmation / reason prompt line. */
  readonly prompt?: string;
  /** One-shot result line of the last action. */
  readonly flash?: string;
}

export const BOARD_GLYPH: Readonly<Record<Exclude<BoardStatus, 'running'>, string>> = {
  pending: '○', done: '✓', warn: '!', 'soft-fail': '~', stop: '✗', skipped: '»',
};
const SPIN = ['◐', '◓', '◑', '◒'] as const;

export const nodeGlyph = (status: BoardStatus, tick: number): string => (status === 'running' ? SPIN[tick % SPIN.length]! : BOARD_GLYPH[status]);

/** ISO → «HH:MM» KST. */
export function kstClock(iso: string | undefined): string {
  if (!iso) return '--:--';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '--:--';
  return new Date(ms + 9 * 3600_000).toISOString().slice(11, 16);
}

/** Whole minutes → «45m» · «1h05m». */
export function minutes(m: number): string {
  const v = Math.max(0, Math.round(m));
  return v < 60 ? `${v}m` : `${Math.floor(v / 60)}h${String(v % 60).padStart(2, '0')}m`;
}

/** «in 12m» before, «12m ago» after. */
function relative(targetIso: string, nowIso: string): string {
  const d = (Date.parse(targetIso) - Date.parse(nowIso)) / 60_000;
  if (Number.isNaN(d)) return '?';
  return d >= 0 ? `in ${minutes(d)}` : `${minutes(-d)} ago`;
}

/** Node timing: running → elapsed · finished → duration · pending with a clock gate → «@HH:MM». */
export function nodeTiming(step: BoardStep, nowIso: string): string {
  const span = (a: string, b: string) => minutes((Date.parse(b) - Date.parse(a)) / 60_000);
  if (step.status === 'running' && step.startedAt) return span(step.startedAt, nowIso);
  if (step.status === 'skipped') return 'skip';
  if (step.startedAt && step.endedAt) return span(step.startedAt, step.endedAt);
  if (step.status === 'pending' && step.earliestAt && Date.parse(step.earliestAt) > Date.parse(nowIso)) return `@${kstClock(step.earliestAt)}`;
  return '';
}

function node(step: BoardStep, snap: ReleaseBoardSnapshot, selected: boolean, width: number): string {
  const timing = nodeTiming(step, snap.now);
  const lead = selected ? '›' : ' ';
  const core = `${nodeGlyph(step.status, snap.tick)} ${step.id}${timing ? ` ${timing}` : ''}`;
  // Keep a space after each node so neighbours never touch; brackets survive a cut.
  const inner = fit(core, Math.max(1, width - 2 - (step.critical ? 2 : 0)));
  return pad(`${lead}${step.critical ? `[${inner}]` : inner}`, width);
}

const PHASES = ['L-0', 'L-1', 'L-2', 'L-3', 'L-4', 'L-5', 'L-6', 'L-7', 'L-8', 'L-9'] as const;

function lanes(snap: ReleaseBoardSnapshot, ui: ReleaseBoardUi, width: number): string[] {
  const out: string[] = [];
  const room = width - 5;
  for (const phase of PHASES) {
    const inPhase = snap.steps.map((s, i) => ({ s, i })).filter((x) => x.s.phase === phase);
    if (!inPhase.length) continue;
    const each = Math.max(6, Math.floor(room / inPhase.length));
    const row = inPhase.map(({ s, i }) => node(s, snap, i === ui.selected, each)).join('');
    out.push(fit(`${phase} │${row}`.trimEnd(), width));
  }
  return out;
}

function header(snap: ReleaseBoardSnapshot, ui: ReleaseBoardUi, width: number): string[] {
  const running = snap.steps.some((s) => s.status === 'running');
  const dot = renderPulseDot({ tick: snap.tick, busy: running });
  const universe = snap.universe === 'operating' ? '' : snap.universe === 'replay' ? ' · REPLAY (test universe)' : ' · test universe';
  const profile = `${snap.profile}${ui.preview ? ' (preview)' : ''}`;
  const inst = snap.instances.length > 1 ? ` · run ${snap.run} (${snap.instances.indexOf(snap.run) + 1}/${snap.instances.length}${snap.following ? ' · newest' : ' · pinned'})` : '';
  const first = `${dot} Release ${snap.version} · ${profile} · ${snap.mode.toUpperCase()}${universe}${inst} · now ${kstClock(snap.now)} KST`;
  const second = `cut ${kstClock(snap.cutAt)} (${relative(snap.cutAt, snap.now)}) · publish ${kstClock(snap.publishAt)} (${relative(snap.publishAt, snap.now)}) · critical path ${minutes(snap.criticalMinutes)}`;
  let banner: string;
  if (snap.hardStop) {
    banner = `■ HARD STOP${snap.hardStop.step ? ` at ${snap.hardStop.step}` : ''}: ${clean(snap.hardStop.reason)}${snap.hardStop.noncritical && snap.profile === 'normal' ? ` — quick-surgery at T−60m (${kstClock(new Date(Date.parse(snap.publishAt) - 3600_000).toISOString())})` : ''}`;
  } else if (snap.done) banner = '✓ Release graph finished';
  else banner = `Critical path: ${snap.steps.filter((s) => s.critical).map((s) => s.id).join(' → ')}`;
  const n = snap.steps.length;
  const count = (st: BoardStatus[]) => snap.steps.filter((x) => st.includes(x.status)).length;
  const finished = count(['done', 'warn', 'soft-fail', 'skipped']);
  const gauge = renderGauge({ label: 'Progress', value: finished, max: Math.max(1, n), unit: 'steps' }, width >= 100 ? 48 : width);
  const stats = width >= 100
    ? renderStatRow([
      { label: 'Running', value: count(['running']) },
      { label: 'Warnings', value: count(['warn', 'soft-fail']), tone: count(['warn', 'soft-fail']) ? 'warn' : 'neutral' },
      { label: 'Stops', value: count(['stop']), tone: count(['stop']) ? 'bad' : 'neutral' },
      { label: 'Skipped', value: count(['skipped']) },
    ], width - 50).map((l, i) => (i === 0 ? `${pad(gauge, 50)}${l}` : `${' '.repeat(50)}${l}`))
    : [gauge];
  return [fit(first, width), fit(second, width), fit(banner, width), ...stats.map((l) => fit(l.trimEnd(), width))];
}

function hostStrip(snap: ReleaseBoardSnapshot, width: number): string[] {
  const hosts = `Hosts  ${snap.hosts.map((h) => (h.busy ? `${h.name} ▪ ${h.busy}` : `${h.name} ·`)).join('   ')}`;
  const t = snap.traffic;
  const traffic = t
    ? `Traffic ${t.phase} · release host ${t.releaseHost} ${t.phase === 'reserve' ? 'reserved' : 'not reserved'} · pregate slots ${Object.entries(t.slots).map(([h, n]) => `${h} ${n}`).join(' · ') || '—'}`
    : 'Traffic no release-traffic audit for this version';
  return [fit(hosts, width), fit(traffic, width)];
}

export function selectedLine(snap: ReleaseBoardSnapshot, ui: ReleaseBoardUi, width: number): string {
  const s = snap.steps[ui.selected];
  if (!s) return '';
  const when = s.startedAt ? `${kstClock(s.startedAt)}→${s.endedAt ? kstClock(s.endedAt) : '…'}` : s.earliestAt ? `not before ${kstClock(s.earliestAt)}` : 'waiting on needs';
  const timing = nodeTiming(s, snap.now);
  const extra = [s.status, s.host === 'none' ? '' : `@${s.host}`, when, timing && !timing.startsWith('@') ? `(${timing})` : '',
    s.exit !== undefined && s.exit !== null ? `exit ${s.exit}` : '', s.warnings.length ? `${s.warnings.length} warning${s.warnings.length > 1 ? 's' : ''}` : ''].filter(Boolean);
  return fit(`› ${s.phase} ${s.id} · ${extra.join(' · ')}`, width);
}

function detail(snap: ReleaseBoardSnapshot, ui: ReleaseBoardUi, width: number, rows: number): string[] {
  const s = snap.steps[ui.selected];
  if (!s) return [];
  const out: string[] = [fit(`┌ ${s.id} — ${clean(s.label)}`, width)];
  out.push(...wrap(`Command: ${s.cmd ?? '(decision gate · checks only)'}`, width - 2).slice(0, 4).map((l) => `│ ${l}`));
  out.push(fit(`│ Receipt: ${s.ref ? clean(s.ref) : s.logPath}`, width));
  if (s.ref) out.push(fit(`│ Log: ${s.logPath}`, width));
  if (s.by) out.push(fit(`│ By: ${clean(s.by)}`, width));
  if (!s.warnings.length) out.push('│ Warnings: none');
  else for (const w of s.warnings) out.push(...wrap(`! ${w}`, width - 2).slice(0, 2).map((l) => `│ ${l}`));
  out.push('└ Enter or Esc closes');
  return out.slice(0, rows).map((l) => fit(l, width));
}

export const HELP_LINES: readonly string[] = [
  'Release Board — keys',
  '↑ ↓      select a step',
  'Enter    details: command, receipt path, warnings',
  'm        mark the step done (OP/REL · confirm)',
  's        skip the step with a reason (OP/REL · confirm)',
  'r        resume from the step (OP/REL · confirm)',
  'p        preview the quick-surgery profile',
  'Tab      next run instance (publish · rehearsal attempts) · f follow newest',
  '?        this help · q quit',
  '',
  'Glyphs: ○ pending · ◐ running · ✓ done · ! warn · ~ soft-fail',
  '        ✗ stop · » skipped · [ ] critical path',
  'Writes act on a test universe only; the operating universe is read-only here.',
];

export const FOOTER = '↑↓ step · Enter details · Tab run · m mark · s skip · r resume · p preview · ? help · q quit';

/** The whole board: at most `height` lines, each at most `width` cells. */
export function renderReleaseBoard(snap: ReleaseBoardSnapshot, ui: ReleaseBoardUi, width: number, height: number): string[] {
  const w = Math.max(20, width);
  const head = header(snap, ui, w);
  const rule = '─'.repeat(w);
  const foot = [fit(ui.prompt ?? ui.flash ?? FOOTER, w)];
  const tail = [
    rule,
    fit(`Events ${renderTicker({ events: snap.events, fresh: snap.freshEvent, frame: 3 }, Math.max(0, w - 7)) || '—'}`, w),
    ...hostStrip(snap, w),
  ];
  const bodyRows = Math.max(0, height - head.length - 1 - tail.length - foot.length);
  let body: string[];
  if (ui.help) body = HELP_LINES.map((l) => fit(l, w));
  else if (ui.detail) body = [selectedLine(snap, ui, w), ...detail(snap, ui, w, Math.max(0, bodyRows - 1))];
  else body = [...lanes(snap, ui, w), selectedLine(snap, ui, w)];
  const lines = [...head, rule, ...body.slice(0, bodyRows), ...Array.from({ length: Math.max(0, bodyRows - body.length) }, () => ''), ...tail, ...foot];
  return lines.slice(0, Math.max(1, height)).map((l) => (cells(l) > w ? fit(l, w) : l));
}

/** No usable state (missing · partial · corrupt): a calm «no data» board, never a crash. */
export function renderReleaseBoardNoData(version: string, reason: string, width: number, height: number): string[] {
  const w = Math.max(20, width);
  const lines = [fit(`○ Release ${clean(version) || '—'} · no data`, w), fit(clean(reason), w), '─'.repeat(w),
    fit('The board shows a run once the release graph writes its state (eln release graph run <v>).', w), '', fit('q quit · refreshes every 2s', w)];
  return lines.slice(0, Math.max(1, height));
}
