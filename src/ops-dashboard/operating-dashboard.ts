// ── OP-CEO-ALLOCATION-LOOP (0.3.35 P0) — the operating dashboard: one runtime-built table for the COO seat ──
//
// S: OP re-allocates seats, models and hosts rarely and never measures the effect; the signals are scattered
//    (els states · git/gh funnel · checklist · llm usage/cache · subscriptions · host load · decision ledger).
// C: gathering them inside an OP turn makes the turn long and breaks the prompt cache.
// Q: how does OP see one table every retro without an LLM and without touching the session-stable prefix?
// A: the runtime builds the table from CLIs and ledgers (no LLM), stores a snapshot per refresh, and the OP retro
//    turn carries the rows in its «Metrics for this period» slot — the tail of the conversation, never the prefix.
//    A probe that fails shows «unmeasured(<reason>)»: an observation gap is a visible defect, not a blank.
//
// Three faces: observe = these rows ⊕ debug.log('ops.dashboard', 'built', {unmeasured}) · recognize = the
// before/after line for last period's decisions · heal = OP pulls the lever on the worst row (COORDINATOR_PROFILE).

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CurrentVersion } from './current-version.js';
import { hostsFor } from '../kit/resource-facts/index.js';

export interface DashboardRow { axis: string; value: string }
export interface DashboardSnapshot {
  at: string;
  rows: DashboardRow[];
  /** Numbers the next snapshot compares against (before/after). */
  metrics: Record<string, number>;
  /** Line count of the decision ledger when this snapshot was taken — the next one shows decisions appended since. */
  decisionLines: number;
}

export interface ProbeResult { value: string; metrics?: Record<string, number> }
export type Probe = (ctx: ProbeContext) => Promise<ProbeResult>;

export interface ProbeContext {
  now: Date;
  /** Runs a command with a timeout; resolves stdout or rejects. */
  run: (command: string, args: readonly string[], timeoutMs?: number) => Promise<string>;
  /** Runs the installed elanous CLI in this instance's universe. */
  eln: (args: readonly string[], timeoutMs?: number) => Promise<string>;
  /** Metrics gathered by probes that ran earlier in this build (throughput runs first). */
  metrics: Record<string, number>;
  hqRoot: string;
  version: string;
  /** OP-CURRENT-VERSION-AWARE: the resolver result for this build — the 판 row reads it; a probe without it resolves again. */
  current?: CurrentVersion;
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;
const n1 = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

// ── probes (each owns one row; order matters only for metrics used by later rows) ─────────────────────

const isoMinute = (value: string): string => /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.exec(value) ? `${value.slice(0, 16).replace('T', ' ')}Z` : value;

/** OP-CURRENT-VERSION-AWARE — the current-release pointer: 판 · source(+⚠ when published) · 테마 · 컷/발행 시각 · 로스터 수, one line ≤300자. */
export const versionProbe: Probe = async (ctx) => {
  const current = ctx.current ?? (await import('./current-version.js')).resolveCurrentVersion({ hqRoot: ctx.hqRoot });
  const parts = [`${current.version} (${current.source})`];
  if (current.published) parts.push('⚠ 발행 완료 판');
  if (current.theme) parts.push(`테마 ${current.theme}`);
  if (current.schedule) {
    parts.push(`컷 ${isoMinute(current.schedule.cutAt)}`);
    if (current.schedule.publishAt) parts.push(`발행 ${isoMinute(current.schedule.publishAt)}`);
  }
  if (current.rosterCount !== null) parts.push(`로스터 ${current.rosterCount} 칸`);
  return { value: parts.join(' · ').slice(0, 300) };
};

export const throughputProbe: Probe = async (ctx) => {
  const since = new Date(ctx.now.getTime() - 60 * 60_000).toISOString();
  const merged = JSON.parse(await ctx.run('gh', ['pr', 'list', '--state', 'merged', '--search', `merged:>=${since}`, '--json', 'number', '--limit', '200'])) as unknown[];
  const open = JSON.parse(await ctx.run('gh', ['pr', 'list', '--state', 'open', '--json', 'isDraft', '--limit', '500'])) as Array<{ isDraft: boolean }>;
  const ready = open.filter((p) => !p.isDraft).length;
  return { value: `landed 1h ${merged.length} · open ready ${ready} · draft ${open.length - ready}`,
    metrics: { landed1h: merged.length, readyOpen: ready, draftOpen: open.length - ready } };
};

export const rosterProbe: Probe = async (ctx) => {
  const { listChecklist } = await import('../release-loop/checklist.js');
  const { releaseLedgerRoot } = await import('../instance/resolve.js');
  const list = listChecklist(ctx.version, releaseLedgerRoot());
  const nowMs = ctx.now.getTime();
  const items = list.items;
  const finished = (s: string) => s === 'green' || s === 'done';
  const green = items.filter((i) => finished(i.status)).length;
  const unowned = items.filter((i) => !finished(i.status) && !i.owner).length;
  const stale = items.filter((i) => !finished(i.status) && nowMs - Date.parse(i.updatedAt) > 2 * 60 * 60_000).length;
  const green1h = list.history.filter((h) => h.field === 'status' && (h.to === 'green' || h.to === 'done') && nowMs - Date.parse(h.at) <= 60 * 60_000).length;
  return { value: `${ctx.version} cells ${items.length} · green/done ${green} · +green 1h ${green1h} · unowned ${unowned} · no progress 2h ${stale}`,
    metrics: { cells: items.length, greenTotal: green, green1h, unowned, stale2h: stale } };
};

export const seatsProbe: Probe = async (ctx) => {
  const data = JSON.parse(await ctx.eln(['side', 'ls', '--json'])) as { panes?: Array<{ status?: { state?: string } | string; workspace?: string }> };
  const counts: Record<string, number> = {};
  for (const p of data.panes ?? []) {
    const state = typeof p.status === 'object' && p.status ? p.status.state ?? 'UNKNOWN' : 'UNKNOWN';
    counts[state] = (counts[state] ?? 0) + 1;
  }
  const order = ['WORKING', 'IDLE', 'WAITING_REPLY', 'WAITING_APPROVAL', 'BLOCKED', 'STALLED', 'EXITED', 'UNKNOWN'];
  return { value: order.filter((s) => counts[s]).map((s) => `${s} ${counts[s]}`).join(' · ') || 'no panes',
    metrics: { seatsWorking: counts.WORKING ?? 0, seatsIdle: counts.IDLE ?? 0, seatsBlocked: (counts.BLOCKED ?? 0) + (counts.STALLED ?? 0) } };
};

export const costSpeedProbe: Probe = async (ctx) => {
  const rows = JSON.parse(await ctx.eln(['usage', 'runs', '--by', 'model', '--since', '1h', '--json'])) as Array<{ model: string; calls: number; inputTokens: number; outputTokens: number; apiEquivalentUsd?: number; usdKnown?: number }>;
  const usd = rows.reduce((s, r) => s + (r.usdKnown || r.apiEquivalentUsd || 0), 0);
  const tokens = rows.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
  const calls = rows.reduce((s, r) => s + r.calls, 0);
  const landed = ctx.metrics.landed1h ?? 0;
  const greens = ctx.metrics.green1h ?? 0;
  const mix = [...rows].sort((a, b) => b.calls - a.calls).slice(0, 3).map((r) => `${r.model} ${calls ? pct(r.calls / calls) : '0%'}`).join(', ');
  return { value: `1h $${n1(usd)} · ${Math.round(tokens / 1000)}k tok · per landing ${landed ? `$${n1(usd / landed)}` : 'n/a (0 landed)'} · per green ${greens ? `$${n1(usd / greens)}` : 'n/a (0 green)'} · tier mix ${mix || 'none'}`,
    metrics: { usd1h: usd, tokens1h: tokens } };
};

export const cacheProbe: Probe = async (ctx) => {
  const data = JSON.parse(await ctx.eln(['usage', 'cache', '--since', '1h', '--json'])) as { total?: { hitRate?: number }; groups?: Array<{ key: string; hitRate?: number; calls: number }> };
  const total = data.total?.hitRate;
  if (typeof total !== 'number') throw new Error('no hitRate');
  const worst = (data.groups ?? []).filter((g) => typeof g.hitRate === 'number' && g.calls >= 10).sort((a, b) => a.hitRate! - b.hitRate!).slice(0, 2)
    .map((g) => `${g.key} ${pct(g.hitRate!)}`).join(', ');
  return { value: `hit ${pct(total)}${worst ? ` · lowest ${worst}` : ''}`, metrics: { cacheHit: total } };
};

export const subscriptionProbe: Probe = async (ctx) => {
  const data = JSON.parse(await ctx.eln(['usage', '--json'])) as { rows: Array<{ provider: string; accountName: string; credits?: { status: string; usedPercent?: number | null }; subscription?: { status: string; remainingPercent?: number; resetsAt?: number } }> };
  const parts = data.rows.flatMap((r) => {
    const sub = r.subscription;
    if (sub?.status === 'available' && typeof sub.remainingPercent === 'number') {
      const hours = sub.resetsAt ? Math.max(0, Math.round((sub.resetsAt - ctx.now.getTime()) / 3_600_000)) : null;
      return [`${r.provider}/${r.accountName} ${sub.remainingPercent}% left${hours === null ? '' : ` · reset ${hours}h`}`];
    }
    if (r.credits?.status === 'error') return [`${r.provider}/${r.accountName} unreadable`];
    return [];
  });
  return { value: parts.join(' · ') || 'no subscription windows' };
};

/** Hosts the dashboard probes — the registry's pregate hosts (RESOURCE-FACTS-FROM-LEDGER · no fixed list). */
export const dashboardHosts = (): string[] => hostsFor('pregate');
export const hostsProbe: Probe = async (ctx) => {
  const one = async (host: string | null): Promise<string> => {
    const cmd = 'sysctl -n hw.ncpu; uptime';
    try {
      const out = host ? await ctx.run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', host, cmd], 8_000) : await ctx.run('sh', ['-c', cmd], 4_000);
      const [cpuLine, uptimeLine] = out.trim().split('\n');
      const cores = Number(cpuLine);
      const load = Number(/load averages?:\s*([\d.]+)/.exec(uptimeLine ?? '')?.[1]);
      if (!(cores > 0) || !Number.isFinite(load)) return `${host ?? 'local'} unmeasured(parse)`;
      return `${host ?? 'local'} ${(load / cores).toFixed(2)}/core`;
    } catch (error) { return `${host ?? 'local'} unmeasured(${(error as Error).message.split('\n')[0]!.slice(0, 40)})`; }
  };
  const lines = await Promise.all([one(null), ...dashboardHosts().map((h) => one(h))]);
  return { value: lines.join(' · ') };
};

/** Missing administration: plan for this release · schedule and decision ledgers touched in 24h · renewals due in 72h. */
export const adminProbe: Probe = async (ctx) => {
  const op = join(ctx.hqRoot, 'seat-state', 'OP');
  const missing: string[] = [];
  const fresh = (path: string) => existsSync(path) && ctx.now.getTime() - statSync(path).mtimeMs < 24 * 60 * 60_000;
  if (!existsSync(join(op, 'plans', `PLAN-${ctx.version}.md`))) missing.push(`plans/PLAN-${ctx.version}.md`);
  if (!fresh(join(op, 'scheduled.tsv'))) missing.push('scheduled.tsv not touched 24h');
  if (!fresh(join(op, 'DECISIONS-OP.tsv'))) missing.push('DECISIONS-OP.tsv not touched 24h');
  try {
    const data = JSON.parse(await ctx.eln(['usage', '--json'])) as { rows: Array<{ provider: string; accountName: string; credits?: { status: string }; resetCredits?: { expiresAt?: string } }> };
    for (const r of data.rows) {
      if (r.credits?.status === 'error') missing.push(`renew login ${r.provider}/${r.accountName}`);
      const exp = r.resetCredits?.expiresAt ? Date.parse(r.resetCredits.expiresAt) : NaN;
      if (Number.isFinite(exp) && exp - ctx.now.getTime() < 72 * 3_600_000) missing.push(`credits expire ${r.provider}/${r.accountName} ${r.resetCredits!.expiresAt!.slice(0, 10)}`);
    }
  } catch { missing.push('renewals unmeasured(usage)'); }
  return { value: missing.length ? `missing ${missing.length}: ${missing.join(' · ')}` : 'complete', metrics: { adminMissing: missing.length } };
};

export const DEFAULT_PROBES: ReadonlyArray<{ axis: string; probe: Probe }> = [
  { axis: '판', probe: versionProbe },
  { axis: 'throughput', probe: throughputProbe },
  { axis: 'roster', probe: rosterProbe },
  { axis: 'seats', probe: seatsProbe },
  { axis: 'cost↔speed', probe: costSpeedProbe },
  { axis: 'cache', probe: cacheProbe },
  { axis: 'subscriptions', probe: subscriptionProbe },
  { axis: 'hosts', probe: hostsProbe },
  { axis: 'admin', probe: adminProbe },
];

// ── build · compare · store ───────────────────────────────────────────────────────────────

const COMPARED: ReadonlyArray<[string, string]> = [['landed1h', 'landed 1h'], ['green1h', '+green 1h'], ['seatsIdle', 'idle seats'], ['cacheHit', 'cache'], ['usd1h', '$ 1h']];

/** «last decisions → before/after»: decisions appended since the previous snapshot, with the compared numbers. */
export function decisionsRow(previous: DashboardSnapshot | null, current: Record<string, number>, ledgerLines: readonly string[]): DashboardRow {
  if (!previous) return { axis: 'last decisions', value: 'first snapshot (no before)' };
  const added = ledgerLines.slice(previous.decisionLines).filter((l) => l.trim());
  const deltas = COMPARED.filter(([k]) => k in previous.metrics && k in current)
    .map(([k, label]) => `${label} ${k === 'cacheHit' ? pct(previous.metrics[k]!) : n1(previous.metrics[k]!)}→${k === 'cacheHit' ? pct(current[k]!) : n1(current[k]!)}`).join(' · ');
  const heads = added.slice(-3).map((l) => l.split('\t').slice(0, 1)[0]!.slice(0, 40)).join(', ');
  return { axis: 'last decisions', value: `${added.length} since ${previous.at.slice(11, 16)}${heads ? ` (${heads})` : ''} · before→after: ${deltas || 'no comparable numbers'}` };
}

export async function buildDashboard(input: {
  ctx: Omit<ProbeContext, 'metrics'>;
  probes?: ReadonlyArray<{ axis: string; probe: Probe }>;
  previous: DashboardSnapshot | null;
  ledgerLines: readonly string[];
}): Promise<DashboardSnapshot> {
  const metrics: Record<string, number> = {};
  const rows: DashboardRow[] = [];
  for (const { axis, probe } of input.probes ?? DEFAULT_PROBES) {
    try {
      const result = await probe({ ...input.ctx, metrics });
      Object.assign(metrics, result.metrics ?? {});
      rows.push({ axis, value: result.value });
    } catch (error) {
      rows.push({ axis, value: `unmeasured(${String((error as Error)?.message ?? error).split('\n')[0]!.slice(0, 60)})` });
    }
  }
  rows.push(decisionsRow(input.previous, metrics, input.ledgerLines));
  return { at: input.ctx.now.toISOString(), rows, metrics, decisionLines: input.ledgerLines.length };
}

/** The retro «Metrics for this period» lines. */
export function dashboardLines(s: DashboardSnapshot): string[] {
  return [`operating dashboard @ ${s.at.slice(0, 16)}Z (runtime-built, no LLM)`, ...s.rows.map((r) => `${r.axis}: ${r.value}`)];
}

export const dashboardDir = (hqRoot: string): string => join(hqRoot, 'seat-state', 'OP', 'dashboard');

export function readLatest(dir: string): DashboardSnapshot | null {
  try { return JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')) as DashboardSnapshot; } catch { return null; }
}

export function writeSnapshot(dir: string, s: DashboardSnapshot): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `latest.json.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(tmp, join(dir, 'latest.json'));
  appendFileSync(join(dir, 'history.jsonl'), `${JSON.stringify(s)}\n`);
}

/** Lines for the retro turn — only a snapshot younger than `maxAgeMs`; an older one says so instead of passing stale numbers. */
export function retroDashboardLines(dir: string, now: Date, maxAgeMs = 30 * 60_000): string[] {
  const s = readLatest(dir);
  if (!s) return ['operating dashboard: unmeasured(no snapshot yet)'];
  if (now.getTime() - Date.parse(s.at) > maxAgeMs) return [`operating dashboard: unmeasured(stale snapshot ${s.at.slice(0, 16)}Z)`];
  return dashboardLines(s);
}

function defaultCtx(now: Date, version: string, hqRoot: string, current?: CurrentVersion): Omit<ProbeContext, 'metrics'> {
  const run = (command: string, args: readonly string[], timeoutMs = 20_000, env?: NodeJS.ProcessEnv) => new Promise<string>((resolve, reject) => {
    execFile(command, [...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, ...(env ? { env } : {}) }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
  return {
    now, version, hqRoot, ...(current ? { current } : {}),
    run: (c, a, t) => run(c, a, t),
    eln: async (args, t) => {
      const { elanousInvocation } = await import('../instance/spawn-elanous.js');
      const inv = elanousInvocation(args);
      return run(inv.command, inv.args, t ?? 30_000, inv.env);
    },
  };
}

/** Build from the real sources and store it. Fail-soft: a thrown build leaves the previous snapshot in place. */
export async function refreshOperatingDashboard(opts: { now?: Date; hqRoot?: string; log?: (event: string, data: Record<string, unknown>) => void } = {}): Promise<DashboardSnapshot> {
  const now = opts.now ?? new Date();
  const hqRoot = opts.hqRoot ?? join(homedir(), 'elanous-hq');
  // OP-CURRENT-VERSION-AWARE — the version follows the current release (plan/schedule), not package.json alone.
  const { resolveCurrentVersion } = await import('./current-version.js');
  const current = resolveCurrentVersion({ hqRoot });
  const version = current.version;
  const dir = dashboardDir(hqRoot);
  const ledgerPath = join(hqRoot, 'seat-state', 'OP', 'DECISIONS-OP.tsv');
  const ledgerLines = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n') : [];
  const snapshot = await buildDashboard({ ctx: defaultCtx(now, version, hqRoot, current), previous: readLatest(dir), ledgerLines });
  writeSnapshot(dir, snapshot);
  opts.log?.('built', { unmeasured: snapshot.rows.filter((r) => r.value.startsWith('unmeasured(')).map((r) => r.axis) });
  return snapshot;
}
