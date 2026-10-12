import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchesOverviewOwner, normalizeOverviewOwner } from './overview-owner.js';
import { collectOverview, ownerRows } from './overview-collect.js';
import type { TaskCard } from '../task-agent/task-hand.js';

describe('overview owner normalization', () => {
  test('normalizes seat, steward, orchestrator, and external owner samples', () => {
    expect(normalizeOverviewOwner('seat:TC')).toBe('seat:TC');
    expect(normalizeOverviewOwner('TC')).toBe('seat:TC');
    expect(normalizeOverviewOwner('steward')).toBe('steward:default');
    expect(normalizeOverviewOwner('orchestrator:dispatcher')).toBe('orchestrator:dispatcher');
    expect(normalizeOverviewOwner('external:partner')).toBe('external:partner');
    expect(normalizeOverviewOwner(undefined)).toBe('unassigned');
  });

  test('owner filters preserve collected row totals and independently collected capacity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ovw-owner-root-'));
    const seatEraDir = mkdtempSync(join(tmpdir(), 'ovw-owner-seat-'));
    const now = Date.parse('2026-10-08T03:00:00.000Z');
    const samples = ['TC', 'steward', 'orchestrator:dispatcher', 'external:partner'] as const;
    const cards = samples.map((seat, index) => ({ id: String(index), text: '', seat, status: 'handed', createdAt: '2026-10-08T00:00:00.000Z', history: [] } as TaskCard));
    mkdirSync(join(seatEraDir), { recursive: true });
    writeFileSync(join(seatEraDir, 'dispatcher-OP.out'), '03:00:00 Pod 10/46 · 로컬 0/0\n');
    const collect = (owner?: string) => collectOverview({ sinceMs: 3_600_000, sinceLabel: '최근 1h', now, root, seatEraDir, ...(owner ? { owner } : {}) }, {
      listSchedules: () => [], listChecklist: () => ({ version: '', released: '', dev: '', history: [], items: [] }),
      readRuns: () => [], readCards: () => cards, ledger: () => [], poolSpec: () => null, ps: () => '',
      gitLog: () => ({ lines: [], observedAt: new Date(now).toISOString() }),
    });
    const baseline = await collect();
    expect(baseline.tasks.capacity.status).toBe('ok');
    const baselineCapacity = baseline.tasks.capacity.value;
    const baselineRows = baseline.tasks.byOwner.value!;
    const originalCount = Object.values(baselineRows).reduce((count, row) => count + row.handed, 0);
    expect(originalCount).toBe(4);
    let filteredTotal = 0;
    for (const sample of samples) {
      const owner = normalizeOverviewOwner(sample);
      const kind = owner.slice(0, owner.indexOf(':'));
      const selected = await collect(kind);
      const selectedTotal = Object.values(selected.tasks.byOwner.value!).reduce((count, row) => count + row.handed, 0);
      expect(selectedTotal).toBe(1);
      filteredTotal += selectedTotal;
      expect(selected.tasks.capacity).toEqual(baseline.tasks.capacity);
      expect(selected.tasks.capacity.value).toEqual(baselineCapacity);
    }
    expect(filteredTotal).toBe(originalCount);
    expect(matchesOverviewOwner('unassigned', 'unassigned')).toBe(true);
    expect(ownerRows([{ id: 'unassigned', text: '', seat: undefined, status: 'handed', createdAt: '2026-10-08T00:00:00.000Z', history: [] } as TaskCard], '2026-10-07T15:00:00.000Z', 'unassigned')).toEqual({ unassigned: { handed: 1, launched: 0, prBound: 0, failed: 0, launchFailed: 0 } });
  });
});
