import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { checkReleaseEventTrace } from './release-event-trace.js';
import { runReleaseSimRigIfFile } from './release-sim-rig.js';
import { resolveScenarioFilePath } from './scenario.js';

const FIXTURE = resolve(import.meta.dir, '../../scenarios/ux-sim/release-incident-events.yaml');
const EXECUTION_FIXTURE = resolve(import.meta.dir, '../../scenarios/ux-sim/release-incident-events-execution.yaml');

test('release incident catalog declares nine incidents and three event subscription scenarios', () => {
  const scenario = parse(readFileSync(FIXTURE, 'utf8')) as { cases?: Array<{ id?: string; intendedEvents?: Array<{ event?: string }>; expect?: { events?: Array<{ event?: string }> } }> };
  const execution = parse(readFileSync(EXECUTION_FIXTURE, 'utf8')) as { cases?: Array<{ id: string; expect: { events: unknown[] } }> };
  expect(scenario.cases).toHaveLength(12);
  expect(scenario.cases?.slice(0, 9).map((item) => item.id)).toEqual(Array.from({ length: 9 }, (_, index) => `incident-${String(index + 1).padStart(2, '0')}-${[
    'tip-moved', 'pod-4-receipt-corrupt', 'gate-waiver-approval-mismatch', 'approval-graph-path-mismatch',
    'known-issues-ascii-fixed', 'pwa-costly-opt-in', 'install-consent-missing', 'version-dev-merge-marker-missing',
    'verify-self-update-consent',
  ][index]}`));
  for (const item of scenario.cases ?? []) {
    expect(item.expect?.events?.length, `${item.id} has expected event rows`).toBeGreaterThan(0);
    expect(item.expect?.events?.every((event) => typeof event.event === 'string')).toBe(true);
  }
  for (const item of scenario.cases?.slice(0, 9) ?? []) {
    expect(item.intendedEvents?.length, `${item.id} keeps its intended domain event rows`).toBeGreaterThan(0);
    const runs = execution.cases?.filter((run) => run.id === item.id || run.id.startsWith(`${item.id}-`)) ?? [];
    if (item.id === 'incident-07-install-consent-missing') {
      expect(JSON.stringify(item.expect?.events?.slice(0, 2))).toBe(JSON.stringify(runs.find((run) => run.id.endsWith('-prepare'))?.expect.events));
      expect(JSON.stringify(item.expect?.events?.slice(2))).toBe(JSON.stringify(runs.find((run) => run.id.endsWith('-upgrade'))?.expect.events));
    } else {
      expect(runs).toHaveLength(1);
      expect(JSON.stringify(runs[0]?.expect.events)).toBe(JSON.stringify(item.expect?.events));
    }
  }
});

test('nine release incidents execute the real release graph and match GraphEventBus lifecycle traces', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'release-incident-events-test-'));
  const previous = getTestStateRoot();
  setTestStateRoot(root);
  try {
    const result = await runReleaseSimRigIfFile(resolveScenarioFilePath(EXECUTION_FIXTURE));
    expect(result).not.toBeNull();
    if (!result) throw new Error('release incident execution fixture was not classified');
    expect(result.pass, JSON.stringify(result.cases.map(({ id, pass, checks, status, refusal, path, unexpectedEdges, injectedEvidence }) => ({ id, pass, checks, status, refusal, path, unexpectedEdges, ...(id === 'incident-02-pod-4-receipt-corrupt' || id === 'incident-06-pwa-costly-opt-in' ? { injectedEvidence } : {}) })))).toBe(true);
    expect(result.cases).toHaveLength(10);
    expect(new Set(result.cases.map((item) => item.id.replace(/-install-consent-missing-(?:prepare|upgrade)$/, '-install-consent-missing'))).size).toBe(9);
    const catalog = parse(readFileSync(FIXTURE, 'utf8')) as { cases: Array<{ id: string; expect: { events: unknown[] } }> };
    const execution = parse(readFileSync(EXECUTION_FIXTURE, 'utf8')) as { cases: Array<{ id: string; expect: { events: unknown[] } }> };
    const executedIds = new Set(result.cases.map((item) => item.id.replace(/-install-consent-missing-(?:prepare|upgrade)$/, '-install-consent-missing')));
    expect(executedIds).toEqual(new Set(catalog.cases.slice(0, 9).map(({ id }) => id)));
    expect(result.cases.map((item) => item.id)).toEqual(execution.cases.map(({ id }) => id));
    const pwaCase = result.cases.find((item) => item.id === 'incident-06-pwa-costly-opt-in');
    const pwaEvidence = pwaCase?.injectedEvidence.pwaNode as { costlyRequested?: boolean; externalResult?: { warning?: string; withCostly?: boolean } } | undefined;
    expect(pwaEvidence?.costlyRequested).toBe(false);
    expect(pwaEvidence?.externalResult?.withCostly).toBe(false);
    expect(pwaEvidence?.externalResult?.warning).toContain('opt-in required');
    for (const item of catalog.cases.slice(0, 9)) {
      const rows = result.cases.filter((run) => run.id === item.id || run.id.startsWith(`${item.id}-`));
      const actual = rows.flatMap((run) => run.ledgerEvents);
      const trace = checkReleaseEventTrace(actual as never, item.expect.events as never);
      expect(trace.pass, `${item.id} observed GraphEventBus events: ${JSON.stringify(trace.missing)}`).toBe(true);
    }
    for (const item of result.cases) {
      expect(item.checks.events, item.id).toBe(true);
      expect(item.ledgerEvents.some((event) => event.observedBy === 'GraphEventBus'), item.id).toBe(true);
    }
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000); // Real graph execution exceeded 60s on shared train hosts.
