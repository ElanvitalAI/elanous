import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adminProbe, buildDashboard, costSpeedProbe, dashboardLines, hostsProbe, retroDashboardLines, writeSnapshot,
  type DashboardSnapshot, type ProbeContext,
} from './operating-dashboard.js';
import { formatSeatRetroPrompt } from '../seat/seat-retro.js';
import { buildCoordinatorProfileAddendum } from '../prompt-library/universal-preamble.js';

const NOW = new Date('2026-11-24T10:08:00.000Z');
const ctx = (over: Partial<ProbeContext> = {}): Omit<ProbeContext, 'metrics'> & { metrics?: Record<string, number> } => ({
  now: NOW, version: '0.3.35', hqRoot: '/nonexistent-hq',
  run: async () => { throw new Error('no run'); },
  eln: async () => { throw new Error('no eln'); },
  ...over,
});

describe('OP-CEO-ALLOCATION-LOOP operating dashboard', () => {
  test('rows come from probes without an LLM; a failing probe shows unmeasured(reason)', async () => {
    const s = await buildDashboard({
      ctx: ctx(),
      probes: [
        { axis: 'throughput', probe: async () => ({ value: 'landed 1h 3', metrics: { landed1h: 3 } }) },
        { axis: 'hosts', probe: async () => { throw new Error('ssh timeout'); } },
      ],
      previous: null, ledgerLines: [],
    });
    expect(dashboardLines(s)).toEqual([
      'operating dashboard @ 2026-11-24T10:08Z (runtime-built, no LLM)',
      'throughput: landed 1h 3',
      'hosts: unmeasured(ssh timeout)',
      'last decisions: first snapshot (no before)',
    ]);
  });

  test('cost↔speed: cost per landing and per green from the usage ledger', async () => {
    const eln = async () => JSON.stringify([
      { model: 'gpt-6.1-terra', calls: 30, inputTokens: 90_000, outputTokens: 10_000, apiEquivalentUsd: 5 },
      { model: 'glm-5.3', calls: 10, inputTokens: 40_000, outputTokens: 10_000, apiEquivalentUsd: 1 },
    ]);
    const r = await costSpeedProbe({ ...ctx({ eln }), metrics: { landed1h: 2, green1h: 0 } } as ProbeContext);
    expect(r.value).toBe('1h $6 · 150k tok · per landing $3 · per green n/a (0 green) · tier mix gpt-6.1-terra 75%, glm-5.3 25%');
  });

  test('hosts: load per core, an unreachable host is unmeasured', async () => {
    const run = async (command: string, args: readonly string[]) => {
      if (command === 'sh') return '10\n 10:08  up 3 days, load averages: 5.00 4.00 3.00\n';
      if (args.includes('node-b')) return '20\n 10:08  up 1 day, load averages: 6.00 5.00 4.00\n';
      throw new Error('Connection timed out');
    };
    const r = await hostsProbe({ ...ctx({ run }), metrics: {} } as ProbeContext);
    // the probe list is the registry's pregate hosts (code defaults when no ledger: minim5 · mbp · node-b · node-c)
    expect(r.value).toBe('local 0.50/core · minim5 unmeasured(Connection timed out) · mbp unmeasured(Connection timed out) · node-b 0.30/core · node-c unmeasured(Connection timed out)');
  });

  test('last decisions: decisions appended since the previous snapshot with before→after numbers', async () => {
    const previous: DashboardSnapshot = { at: '2026-11-24T09:08:00.000Z', rows: [], metrics: { landed1h: 0, seatsIdle: 16 }, decisionLines: 1 };
    const s = await buildDashboard({
      ctx: ctx(),
      probes: [{ axis: 'throughput', probe: async () => ({ value: 'x', metrics: { landed1h: 3, seatsIdle: 9 } }) }],
      previous,
      ledgerLines: ['OLD\tline', 'JUD-PARALLEL\tassign idle judges', 'HOST-MOVE\tpregate to node-b'],
    });
    expect(s.rows.at(-1)).toEqual({ axis: 'last decisions', value: '2 since 09:08 (JUD-PARALLEL, HOST-MOVE) · before→after: landed 1h 0→3 · idle seats 16→9' });
    expect(s.decisionLines).toBe(3);
  });

  test('admin row lists missing plan, stale ledgers and renewals', async () => {
    const hq = mkdtempSync(join(tmpdir(), 'op-dash-'));
    try {
      mkdirSync(join(hq, 'seat-state', 'OP'), { recursive: true });
      writeFileSync(join(hq, 'seat-state', 'OP', 'DECISIONS-OP.tsv'), 'x\n');
      const eln = async () => JSON.stringify({ rows: [{ provider: 'codex', accountName: 'default', credits: { status: 'error' } }] });
      const r = await adminProbe({ ...ctx({ hqRoot: hq, now: new Date(), eln }), metrics: {} } as ProbeContext);
      expect(r.value).toBe('missing 3: plans/PLAN-0.3.35.md · scheduled.tsv not touched 24h · renew login codex/default');
    } finally { rmSync(hq, { recursive: true, force: true }); }
  });

  test('the retro turn carries a fresh snapshot in its metrics slot; missing or stale says unmeasured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'op-dash-'));
    try {
      expect(retroDashboardLines(dir, NOW)).toEqual(['operating dashboard: unmeasured(no snapshot yet)']);
      writeSnapshot(dir, { at: '2026-11-24T09:00:00.000Z', rows: [{ axis: 'seats', value: 'IDLE 16' }], metrics: {}, decisionLines: 0 });
      expect(retroDashboardLines(dir, NOW)).toEqual(['operating dashboard: unmeasured(stale snapshot 2026-11-24T09:00Z)']);
      writeSnapshot(dir, { at: '2026-11-24T10:06:00.000Z', rows: [{ axis: 'seats', value: 'IDLE 16' }], metrics: {}, decisionLines: 0 });
      const prompt = formatSeatRetroPrompt({ seat: 'OP', intervalMin: 60, metrics: retroDashboardLines(dir, NOW) });
      expect(prompt).toContain('Metrics for this period:\n- operating dashboard @ 2026-11-24T10:06Z (runtime-built, no LLM)\n- seats: IDLE 16');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('the coordinator profile (session-stable prefix) carries the COO paragraph and no per-turn numbers', () => {
    const text = String(buildCoordinatorProfileAddendum()[0]!.content);
    expect(text).toContain("You are the federation's COO, operating on the CEO's behalf: you own outcomes, continuously reallocate seats, models, hosts and roster to the biggest bottleneck, balance LLM cost against delivery speed with numbers, proactively propose decisions (options + recommendation + deadline) and bring only direction, money and irreversible choices to the CEO; you also keep administration complete (schedules, plans, ledgers, renewals).");
    expect(text).not.toContain('operating dashboard @');
    expect(buildCoordinatorProfileAddendum()[0]!.content).toBe(buildCoordinatorProfileAddendum()[0]!.content);
  });
});
