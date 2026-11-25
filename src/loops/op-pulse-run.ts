// OP-PULSE runner — the graph's measure step (no LLM) and the pulse-due check, over injected probes (sims use fakes;
// defaults read the existing ledgers/CLIs: release schedule · checklist · hand pool · cell-blocks · green triage · git
// log · msg store · unified usage). See op-pulse.ts for the SCQA and the three faces.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { appendPulseLedger, beatsForWindow, detectPhase, parseRhythm, pulseDue, pulseGaps, pulsePaths, readPulseState, renderPulseBrief, renderPulseTable,
  rhythmRow, writePulseInbox, writePulseState, type PhaseResult, type PulseMeasure, type Rhythm } from './op-pulse.js';
import { burstCourse, burstProposal, digestionRate, forecast, parseBurstConfig, planScale, pressures, startBurst, type BurstConfig, type BurstState,
  type Deadline, type ForecastRow, type HostSlots } from './op-pulse-burst.js';
import { burstEntry, demandSurge, urgentCeoLines, type CeoLine, type DemandSignals } from './op-pulse-urgency.js';

export interface PulseExtra {
  landed3hPerH: number | null; green3hPerH: number | null;
  readyBacklog: number | null; openInScope: number | null;
  demand: DemandSignals;
  gateWaitMin: number | null; reviewWaitMin: number | null; landQueue: number | null;
  hosts?: HostSlots[];
}

export interface PulseProbes {
  now(): Date;
  localHour(now: Date): number;
  schedules(): Array<{ version: string; cutAt?: string | null; publishAt?: string | null }>;
  measure(now: Date): Promise<{ measure: PulseMeasure; extra: PulseExtra }>;
  /** Crown mails (id · crownDirective · refs · createdAt) since an ISO time. */
  crownMails(sinceIso: string, now: Date): Array<{ id: number; crownDirective?: string | null; refs?: readonly string[] | null; createdAt: string }>;
}

export interface PulsePathsIn { seatState: string; stateRoot: string; rhythmPath: string }

export function loadRhythmAndBurst(path: string): { rhythm: Rhythm; burst: BurstConfig } {
  const text = readFileSync(path, 'utf8');
  return { rhythm: parseRhythm(text), burst: parseBurstConfig((parseYaml(text) as { burst?: unknown }).burst) };
}

function readBurst(path: string): BurstState | null {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as BurstState : null; } catch { return null; }
}
export function writeBurst(path: string, state: BurstState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`); renameSync(tmp, path);
}
export function readActiveBurst(path: string): BurstState | null { const b = readBurst(path); return b && b.status === 'active' ? b : null; }

const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The phase now (burst state + schedules + clock). */
export function currentPhase(p: PulseProbes, rhythm: Rhythm, paths: ReturnType<typeof pulsePaths>, now: Date): PhaseResult {
  return detectPhase({ now, schedules: p.schedules(), burstActive: readActiveBurst(paths.burst) !== null, localHour: p.localHour(now) }, rhythm.detection);
}

/** The pulse-due predicate (trigger-conditions `pulse-due`): phase change · cadence · urgent CEO line · demand surge fire it. */
export async function pulseDueNow(p: PulseProbes, input: PulsePathsIn): Promise<{ met: boolean; key: string; evidence: string }> {
  const now = p.now();
  const { rhythm } = loadRhythmAndBurst(input.rhythmPath);
  const paths = pulsePaths(input.seatState, input.stateRoot, localDate(now));
  const state = readPulseState(paths.state);
  const phase = currentPhase(p, rhythm, paths, now);
  const lines = urgentCeoLines(p.crownMails(state.lastPulseAt ?? new Date(now.getTime() - 3_600_000).toISOString(), now), state.lastPulseAt);
  if (lines[0]) return { met: true, key: `ceo:${lines[0].msgId}`, evidence: `CEO ${lines[0].urgency} line #${lines[0].msgId} (crown ${lines[0].crownDirective})` };
  return pulseDue({ now, phase, state, row: rhythmRow(rhythm, phase.phase) });
}

function deadlinesFrom(schedules: ReturnType<PulseProbes['schedules']>, rhythm: Rhythm, remaining: number | null): Deadline[] {
  if (remaining === null) return [];
  const out: Deadline[] = [];
  for (const s of schedules) {
    if (s.cutAt) out.push({ label: `${s.version} cut`, at: s.cutAt, source: 'release-cut', remaining });
  }
  for (const f of rhythm.detection.freezes) out.push({ label: `demo «${f.label}»`, at: f.from, source: 'demo', remaining });
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export interface PulseRunResult {
  outcome: 'turn' | 'green';
  phase: PhaseResult; phaseChanged: string | null;
  gaps: ReturnType<typeof pulseGaps>;
  forecast: ForecastRow[];
  entry: ReturnType<typeof burstEntry>;
  burstStarted: BurstState | null;
  brief: string | null;
  tablePath: string;
}

/**
 * One pulse: phase → rhythm → measure → gaps → forecast → burst entry → table/state/ledger. Returns `turn` when OP must
 * act (a gap · a phase change · a burst entry · a burst course change), `green` otherwise (heartbeat line, no turn).
 * all-in starts the burst here (state only — actuators stay OP's; VM still budget/card gated).
 */
export async function runPulse(p: PulseProbes, input: PulsePathsIn & { window: string; stage: string }): Promise<PulseRunResult> {
  const now = p.now();
  const { rhythm, burst: burstCfg } = loadRhythmAndBurst(input.rhythmPath);
  const paths = pulsePaths(input.seatState, input.stateRoot, localDate(now));
  const state = readPulseState(paths.state);
  let active = readActiveBurst(paths.burst);
  const { measure, extra } = await p.measure(now);
  const lines: CeoLine[] = urgentCeoLines(p.crownMails(state.lastPulseAt ?? new Date(now.getTime() - 3_600_000).toISOString(), now), state.lastPulseAt);
  const rate = digestionRate(measure.landedPerH, extra.landed3hPerH);
  const schedules = p.schedules();
  const rows = forecast(deadlinesFrom(schedules, rhythm, extra.openInScope), rate, now, burstCfg.presets);
  const miss = rows.find(r => r.shortfall > 0) ?? null;
  const demand = demandSurge(extra.demand);
  const entry = burstEntry({ ceoLines: lines, demand, forecastPreset: miss?.preset ?? null, forecastWhy: miss ? `${miss.label}: shortfall ${miss.shortfall}` : 'no shortfall', burstActive: active !== null });
  let burstStarted: BurstState | null = null;
  if (entry?.trigger === 'ceo-all-in' && !(active?.allIn && active.ceoLine?.msgId === entry.ceoLine.msgId)) {
    const preset = burstCfg.presets.find(x => x.name === '8h') ?? burstCfg.presets[burstCfg.presets.length - 1]!;
    const until = new Date(now.getTime() + preset.hours * 3_600_000).toISOString();
    // An all-in line replaces any running burst (its launches stay recorded and are closed on the final exit).
    const base = active ? { ...active, status: 'exited' as const } : null;
    burstStarted = { ...startBurst({ goal: 'land', until, scope: ['ALL'], by: 'pulse', now, preset, trigger: 'ceo-all-in', ceoLine: { msgId: entry.ceoLine.msgId, crownDirective: entry.ceoLine.crownDirective }, allIn: true,
      baseline: { landed: measure.landedPerH, green: measure.greenPerH } }, base), launches: active?.launches ?? [] };
    if (input.stage === 'live') writeBurst(paths.burst, burstStarted);
    active = burstStarted;
  }
  const phase = active ? { phase: 'burst' as const, evidence: `burst ${active.id} (${active.trigger}) until ${active.until}` }
    : detectPhase({ now, schedules, burstActive: false, localHour: p.localHour(now) }, rhythm.detection);
  const row = rhythmRow(rhythm, phase.phase);
  const gaps = pulseGaps(measure, row.targets);
  const phaseChanged = state.lastPhase !== null && state.lastPhase !== phase.phase ? `${state.lastPhase} → ${phase.phase}` : null;
  const table = renderPulseTable(measure, phase, row, gaps);
  // Burst planning lines (inside a burst: re-forecast course + scale plan; outside: the proposal for OP).
  const burstLines: string[] = [];
  if (active) {
    const course = burstCourse(active, miss ?? rows[0] ?? null, now, burstCfg.presets);
    const press = pressures({ targetGapRatio: measure.landedPerH && row.targets.landedPerH ? row.targets.landedPerH / Math.max(0.1, measure.landedPerH) : null,
      readyBacklog: extra.readyBacklog, hands: measure.spaces.reduce((n, s) => n + (s.hands ?? 0), 0) || null, readyPerHand: row.targets.readyPerHand ?? 2,
      judgeWaitMin: measure.judgeWaitMedianMin, judgeWaitTargetMin: row.targets.judgeWaitMedianMin ?? 30, judgeQueue: measure.judgeQueue,
      gateWaitMin: extra.gateWaitMin, gateWaitTargetMin: 10, reviewWaitMin: extra.reviewWaitMin, reviewWaitTargetMin: 20, landQueue: extra.landQueue, landQueueTarget: 6,
      hoursToDeadline: miss ? miss.hoursLeft : null });
    const plan = planScale({ levels: active.levels, lastChangeAt: active.lastChangeAt, pressures: press, now, config: burstCfg, spentUsd: active.spentUsd, budgetUsd: active.budgetUsd,
      cloudApprovedUsd: active.cloudApprovedUsd, hoursLeft: Math.max(0, (Date.parse(active.until) - now.getTime()) / 3_600_000), forecastMisses: miss !== null, allIn: active.allIn,
      ...(extra.hosts ? { hosts: extra.hosts } : {}) });
    burstLines.push(`버스트 ${active.id} (${active.trigger}${active.ceoLine ? ` · CEO #${active.ceoLine.msgId}` : ''}) · 진로: ${course.action} — ${course.why}${course.until ? ` → until ${course.until}` : ''}`,
      ...plan.map(d => `- ${d.lane}: ${d.from} → ${d.to}${d.blocked ? ` (막힘 ${d.blocked})` : ''} · ${d.why}`));
    if (course.action.startsWith('exit')) burstLines.push(`→ 종료: eln pulse burst stop --reason ${course.action}`);
  } else if (entry && entry.trigger !== 'ceo-all-in') {
    const preset = burstCfg.presets.find(x => x.name === entry.preset)!;
    const fr = miss ?? { label: 'demand', at: new Date(now.getTime() + preset.hours * 3_600_000).toISOString(), source: 'ceo' as const, remaining: extra.openInScope ?? 0, ratePerH: rate, hoursLeft: preset.hours, projectedFinish: null, shortfall: 0, preset: entry.preset, presetCloses: true, projectedWithBurst: null };
    burstLines.push(`버스트 진입(${entry.trigger}${entry.trigger === 'ceo-urgent' ? ' · OP 가 지금 시작' : ' · 제안 — OP 결정'}): ${burstProposal(fr, preset, phase.phase, burstCfg.cloudBudgetUsd)}`, `근거: ${entry.why}`);
  }
  const forecastLines = rows.map(r => `- 마감 ${r.label} ${r.at} · 남은 ${r.remaining} · 속도 ${r.ratePerH ?? '?'}/h · 예상 완료 ${r.projectedFinish ?? '측정 불가'} · 부족 ${r.shortfall}${r.preset ? ` · 권고 ${r.preset}` : ''}`);
  const fullTable = `${table}${forecastLines.length ? `\n예측:\n${forecastLines.join('\n')}\n` : ''}${burstLines.length ? `\n버스트:\n${burstLines.join('\n')}\n` : ''}`;
  const needTurn = gaps.length > 0 || phaseChanged !== null || burstLines.length > 0;
  mkdirSync(dirname(paths.table), { recursive: true });
  appendFileSync(paths.table, needTurn ? `\n${fullTable}` : `\n- ${measure.at} · 국면 ${phase.phase} · 전부 초록 (착지 ${measure.landedPerH ?? '?'}/h · 초록 ${measure.greenPerH ?? '?'}/h) — OP 턴 없음\n`);
  // The cadence clock is anchored on the fire window, not on this measure: a retry of the same window (goal deadline →
  // backoff → re-measure) must not push the next beat out by deadline+backoff (11-25 rail 47: 30m cadence beat ~hourly).
  const windowMs = Date.parse(input.window);
  // Never backwards: a late retry of an older window must not rewind a newer window's beat (burst 15m < deadline+backoff).
  const prevMs = state.lastPulseAt ? Date.parse(state.lastPulseAt) : NaN;
  const anchorMs = Number.isFinite(windowMs) && windowMs <= now.getTime() ? windowMs : now.getTime();
  const anchor = new Date(Number.isFinite(prevMs) && prevMs > anchorMs ? prevMs : anchorMs).toISOString();
  writePulseState(paths.state, { lastPulseAt: anchor, lastPhase: phase.phase });
  const brief = needTurn ? `${renderPulseBrief({ window: input.window, phase, row, gaps, table: fullTable, phaseChanged, tablePath: paths.table })}${burstLines.length ? `\n\n버스트:\n${burstLines.join('\n')}` : ''}${forecastLines.length ? `\n\n예측:\n${forecastLines.join('\n')}` : ''}` : null;
  appendPulseLedger(paths.ledger, { window: input.window, at: now.toISOString(), stage: input.stage, phase: phase.phase, gaps: gaps.length, outcome: needTurn ? 'turn' : 'green',
    entry: entry?.trigger ?? null, burst: active?.id ?? null });
  if (!needTurn) appendPulseLedger(paths.ledger, { goal: 'met', window: input.window, by: 'all-green' });
  return { outcome: needTurn ? 'turn' : 'green', phase, phaseChanged, gaps, forecast: rows, entry, burstStarted, brief, tablePath: paths.table };
}

/** The turn step: live → the pulse inbox (the OP TUI opens one origin-`pulse` turn); shadow → a receipt only. */
export function deliverPulseTurn(input: PulsePathsIn & { window: string; stage: string; brief: string; runId: string; now: Date; shadowDir: string }): { delivered: 'inbox' | 'shadow'; path: string } {
  const paths = pulsePaths(input.seatState, input.stateRoot, localDate(input.now));
  if (input.stage !== 'live') {
    const path = `${input.shadowDir}/${input.window.replace(/[^\w.-]/g, '_')}.json`;
    mkdirSync(input.shadowDir, { recursive: true });
    writeFileSync(path, `${JSON.stringify({ wouldOpenTurn: { origin: 'pulse', seat: 'OP', body: input.brief }, runId: input.runId, at: input.now.toISOString() })}\n`);
    return { delivered: 'shadow', path };
  }
  writePulseInbox(paths.inbox, { id: `${input.window}#${input.runId}`, window: input.window, body: input.brief, at: input.now.toISOString() });
  return { delivered: 'inbox', path: paths.inbox };
}

/** Goal check: beat mails for the window exist in the msg store → the goal line (`eln pulse verify`). */
export function verifyBeats(input: { ledger: string; window: string; mails: ReadonlyArray<{ id: number; from: string; to: string; body: string }>; now: Date }): { ok: boolean; beats: Array<{ id: number; to: string }> } {
  const beats = beatsForWindow(input.mails, input.window);
  if (beats.length) appendPulseLedger(input.ledger, { goal: 'met', window: input.window, beats: beats.map(b => `#${b.id}→${b.to}`), at: input.now.toISOString() });
  return { ok: beats.length > 0, beats };
}
