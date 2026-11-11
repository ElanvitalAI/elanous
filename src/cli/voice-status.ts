// M1-4 (PLAN-friction-free-model-selection-ux-2026-05-12 · Phase 1) —
// `elanous voice status` CLI surface.
//
// Prints the current voice tier configuration so a user (or a friend
// debugging "is elanous even using the model I asked for?") can verify
// the friction-free selection in one shell command:
//
//   $ elanous voice status
//   ✓ Smart defaults active
//     STT: Balanced (~$0.30/mo · 100 min/mo at $0.003/min)
//          gpt-4o-mini-transcribe via openai-realtime-stt
//          source = default
//     Usage: 5.2 min/day · 14-day rolling avg · 12 STT calls
//     Month so far: $1.20 of no cap
//   [run `elanous preset list` to explore alternatives]
//
// Reads:
//   - ~/.elanous/config.json → user-config.modelTier (override)
//   - ~/.elanous/voice-cost-events.jsonl → recent usage for cost preview
//
// Side effects: stdout only. Returns process exit code 0.
//
// Wired into `elanous voice` subcommand in src/index.ts.

import { existsSync, readFileSync } from 'node:fs';

import { getUserConfig } from '../user-config/reader.js';
import type { UserConfig } from '../user-config/types.js';
import {
  MODEL_TIER_LABELS,
  projectSttAllTiers,
  resolveSttTier,
  sttTierEffectiveUsdPerMin,
  type UsageSample,
} from '../model-tier/index.js';
import { defaultVoiceCostEventPath } from '../voice/cost-tracker.js';

const MS_PER_DAY = 86_400_000;
const DEFAULT_WINDOW_DAYS = 14;

interface RawCostEvent {
  kind?: string;
  ts?: number;
  durationMs?: number;
  usd?: number;
}

function readUsageSamples(eventPath: string, now: number): UsageSample[] {
  if (!existsSync(eventPath)) return [];
  const samples: UsageSample[] = [];
  const cutoff = now - DEFAULT_WINDOW_DAYS * MS_PER_DAY;
  try {
    const raw = readFileSync(eventPath, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let ev: RawCostEvent;
      try { ev = JSON.parse(line) as RawCostEvent; } catch { continue; }
      if (ev.kind !== 'stt') continue;
      if (typeof ev.ts !== 'number' || ev.ts < cutoff) continue;
      const durationMs = typeof ev.durationMs === 'number' ? ev.durationMs : 0;
      const usd = typeof ev.usd === 'number' ? ev.usd : 0;
      if (durationMs <= 0) continue;
      samples.push({
        surface: 'stt',
        audioMinutes: durationMs / 60_000,
        usd,
        at: ev.ts,
      });
    }
  } catch {
    // Disk read failure — treat as no data.
  }
  return samples;
}

function formatUsd(n: number, opts: { signed?: boolean; min?: number } = {}): string {
  if (!Number.isFinite(n)) return '$0.00';
  const sign = opts.signed && n > 0 ? '+' : '';
  if (Math.abs(n) < (opts.min ?? 0.005)) return `${sign}$0.00`;
  if (Math.abs(n) < 10) return `${sign}$${n.toFixed(2)}`;
  if (Math.abs(n) < 100) return `${sign}$${n.toFixed(1)}`;
  return `${sign}$${Math.round(n)}`;
}

function sumStt(events: RawCostEvent[], monthKey: string): number {
  let total = 0;
  for (const ev of events) {
    if (ev.kind !== 'stt' && ev.kind !== 'tts') continue;
    if (typeof ev.ts !== 'number') continue;
    const d = new Date(ev.ts);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (k !== monthKey) continue;
    if (typeof ev.usd === 'number') total += ev.usd;
  }
  return total;
}

function readMonthlyTotal(eventPath: string, now: number): number {
  if (!existsSync(eventPath)) return 0;
  const d = new Date(now);
  const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  try {
    const raw = readFileSync(eventPath, 'utf-8');
    const events: RawCostEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { events.push(JSON.parse(line) as RawCostEvent); } catch { /* skip */ }
    }
    return sumStt(events, monthKey);
  } catch {
    return 0;
  }
}

// ── Status report shape (pure · testable) ──────────────────────────

export interface VoiceStatusReport {
  /** Selected STT tier (after resolver precedence). */
  tier: string;
  tierLabel: string;
  source: string;
  provider: string;
  model: string;
  status: string;
  /** Effective USD per audio-minute at this tier. */
  ratePerMin: number;
  /** Daily avg audio minutes over last 14 days (0 when no usage). */
  audioMinPerDay: number;
  sttSampleCount: number;
  /** Projected monthly USD at the current tier. */
  projectedMonthlyUsd: number;
  /** Actual USD already spent this calendar month (from cost-tracker). */
  monthSoFarUsd: number;
  /** Monthly cap (from user-config.budget.monthlyUsdCap). null = no cap. */
  monthlyCapUsd: number | null;
  /** All five tiers' monthly cost projections — used for "explore"
   *  alternatives lines. */
  allTierProjections: Record<string, number>;
}

export interface BuildVoiceStatusOpts {
  /** Inject a user-config directly (tests). Falls back to `getUserConfig()`. */
  cfg?: UserConfig;
  /** Override the JSONL path for the cost-tracker (tests). */
  eventPath?: string;
  /** Inject the reference now (tests). */
  now?: number;
}

/** Build the report from the current user-config + cost-tracker state.
 *  Pure function (deterministic given inputs · injectable now/eventPath). */
export function buildVoiceStatusReport(
  opts: BuildVoiceStatusOpts = {},
): VoiceStatusReport {
  const cfg = opts.cfg ?? getUserConfig();
  const resolved = resolveSttTier(cfg.modelTier);
  const eventPath = opts.eventPath ?? defaultVoiceCostEventPath();
  const now = opts.now ?? Date.now();

  const samples = readUsageSamples(eventPath, now);
  const totalAudioMin = samples.reduce((acc, s) => acc + (s.audioMinutes ?? 0), 0);
  const audioMinPerDay = samples.length === 0 ? 0 : totalAudioMin / DEFAULT_WINDOW_DAYS;

  const allTierProjections = projectSttAllTiers({ samples, now });
  const projectedMonthlyUsd = allTierProjections[resolved.tier].monthlyUsd;
  const monthSoFarUsd = readMonthlyTotal(eventPath, now);

  const monthlyCapUsd = cfg.budget?.monthlyUsdCap ?? null;

  const projectionsBare: Record<string, number> = {};
  for (const [tier, est] of Object.entries(allTierProjections)) {
    projectionsBare[tier] = est.monthlyUsd;
  }

  return {
    tier: resolved.tier,
    tierLabel: MODEL_TIER_LABELS[resolved.tier],
    source: resolved.source,
    provider: resolved.provider,
    model: resolved.model,
    status: resolved.status,
    ratePerMin: sttTierEffectiveUsdPerMin(resolved.tier),
    audioMinPerDay,
    sttSampleCount: samples.length,
    projectedMonthlyUsd,
    monthSoFarUsd,
    monthlyCapUsd,
    allTierProjections: projectionsBare,
  };
}

// ── Formatter (pure · testable) ────────────────────────────────────

export function formatVoiceStatusReport(report: VoiceStatusReport): string {
  const lines: string[] = [];
  const headerIcon = report.source === 'default' ? '✓ Smart defaults active' : '⚙ Custom voice tier';
  lines.push(headerIcon);
  lines.push('');

  const rateStr = report.ratePerMin === 0 ? 'free' : `$${report.ratePerMin.toFixed(3)}/min`;
  const costSuffix = report.audioMinPerDay > 0
    ? `~${formatUsd(report.projectedMonthlyUsd)}/mo (${report.audioMinPerDay.toFixed(1)} min/day · ${rateStr})`
    : `${rateStr} (no usage data yet)`;
  lines.push(`  STT: ${report.tierLabel} · ${costSuffix}`);
  lines.push(`       ${report.model} via ${report.provider}`);
  lines.push(`       source = ${report.source}${report.status === 'wip' ? ' · WIP (install local binary)' : ''}`);
  lines.push('');

  if (report.audioMinPerDay > 0) {
    lines.push(`  Usage: ${report.audioMinPerDay.toFixed(2)} min/day · 14-day rolling · ${report.sttSampleCount} STT calls`);
  }
  const capText = report.monthlyCapUsd === null
    ? 'no cap'
    : `${formatUsd(report.monthlyCapUsd)} cap`;
  lines.push(`  Month so far: ${formatUsd(report.monthSoFarUsd)} of ${capText}`);

  // If user is on default, offer one alternative to show what changing
  // the slider would cost. Pick "best" as the canonical compare.
  if (report.source === 'default' && report.audioMinPerDay > 0) {
    const bestCost = report.allTierProjections.best ?? 0;
    if (bestCost > 0) {
      const delta = bestCost - report.projectedMonthlyUsd;
      lines.push('');
      lines.push(`  💡 Best tier would cost ~${formatUsd(bestCost)}/mo (${formatUsd(delta, { signed: true })} vs current).`);
    }
  }

  lines.push('');
  lines.push('  [PWA settings · drag the slider to switch tiers]');
  return lines.join('\n');
}

// ── CLI entry ──────────────────────────────────────────────────────

export function runVoiceStatusCommand(): void {
  const report = buildVoiceStatusReport();
  // eslint-disable-next-line no-console
  console.log(formatVoiceStatusReport(report));
}
