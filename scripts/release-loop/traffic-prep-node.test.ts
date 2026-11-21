import { expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as yaml } from 'yaml';
import { runGraph } from '../../src/graph-runner/runner.js';
import { readTrafficPrepMarker } from './release-countdown.js';
import { COUNTDOWN_LONG_HOLD_NOTICE_MS } from './release-readiness.js';
import { runTrafficNode, runTrafficPrepNode, type TrafficPrepNodeDeps } from './traffic-node.js';
import {
  checkTrafficPrepReceipt, runTrafficPrep, trafficPrepReceiptPath, TRAFFIC_NOT_PREPPED, TRAFFIC_PREP_HOLD_POLL_MS, TRAFFIC_PREP_LEAD_MS,
  TRAFFIC_PREP_VALID_AFTER_CUT_MS,
} from './traffic-prep.js';
import type { TrafficFile } from './traffic-transition.js';

// Real release graph runs exceed Bun's 5 s test default under gate-pod load (same bound as release-loop-graph.test.ts).
setDefaultTimeout(60_000);

// RELEASE-TRAFFIC-PREP-T1H graph node: every instant below derives from the cut and the exported window constants.
const CUT_AT = '2026-11-21T20:30:00.000Z';
const CUT = Date.parse(CUT_AT);
const WINDOW_START = CUT - TRAFFIC_PREP_LEAD_MS;
const INSIDE = WINDOW_START + TRAFFIC_PREP_LEAD_MS / 2;
const LATE = CUT + TRAFFIC_PREP_LEAD_MS / 2;
const PAST_VALID = CUT + TRAFFIC_PREP_VALID_AFTER_CUT_MS + TRAFFIC_PREP_LEAD_MS;
const RUN_ID = 'release-run-traffic-prep-node';
const GRAPH = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
const SEATS = ['OP', 'TC', 'MK', 'UX'];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'release-traffic-prep-node-'));
  const trafficFile = join(root, 'traffic.json');
  // Operator values are restored verbatim, so the baseline uses recognisable sentinels instead of rates.
  const initial: TrafficFile = { global: 'yellow', reason: 'operator-policy', seats: Object.fromEntries(SEATS.map((seat) => [seat, { perCycle: `baseline-${seat}` }])) };
  writeFileSync(trafficFile, JSON.stringify(initial));
  const deps = (now: number, extra: Partial<TrafficPrepNodeDeps> = {}): TrafficPrepNodeDeps => ({
    root, now: () => new Date(now), traffic: { trafficFile }, schedule: () => ({ cutAt: CUT_AT }), baseSha: () => null, ...extra,
  });
  const traffic = () => JSON.parse(readFileSync(trafficFile, 'utf8')) as TrafficFile;
  return { root, trafficFile, initial, deps, traffic, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function context(version: string, nodeId = 'traffic-prep', runId = RUN_ID) {
  return { graphId: 'release-loop', nodeId, runId, startedAt: CUT_AT, input: { version, previousVersion: '0.3.30' }, outputs: {} };
}

/** Runs the node in-process and returns its exit code and the one JSON result line it emits. */
async function runNode(version: string, deps: TrafficPrepNodeDeps, runId = RUN_ID) {
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
  try {
    const code = await runTrafficPrepNode({ ELANOUS_GRAPH_CONTEXT: JSON.stringify(context(version, 'traffic-prep', runId)) }, deps);
    const output = lines.map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; } })
      .filter((line): line is Record<string, unknown> => line !== null && 'outcome' in line).at(-1)!;
    return { code, output };
  } finally { log.mockRestore(); }
}

test('traffic-prep node inside cutAt−1h … cutAt applies under the run id, writes the receipt and emits its path', async () => {
  const f = fixture();
  try {
    const { code, output } = await runNode('0.3.31', f.deps(INSIDE));
    const path = trafficPrepReceiptPath('0.3.31', f.root);
    expect(code).toBe(0);
    expect(output).toMatchObject({ outcome: 'ok', receiptPath: path, cutAt: CUT_AT, appliedAt: new Date(INSIDE).toISOString(), late: false, reused: false, prepRunId: RUN_ID });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: '0.3.31', cutAt: CUT_AT, prepRunId: RUN_ID, late: false, trafficResult: 'applied' });
    expect(f.traffic()).toMatchObject({ global: 'gate', releaseLifecycle: { runId: RUN_ID, stage: 0, beforeCut: { global: 'yellow' } } });
    // The cut-branch guard (with this run id) and the countdown both accept the node's receipt.
    expect(checkTrafficPrepReceipt('0.3.31', { ...f.deps(CUT), runId: RUN_ID })).toMatchObject({ ok: true });
    expect(readTrafficPrepMarker(path, '0.3.31', { now: new Date(CUT), cutAt: CUT_AT }).prepped).toBe(true);
    // Re-entering the node (resume) is idempotent: same receipt stamp, traffic already applied.
    const again = await runNode('0.3.31', f.deps(CUT));
    expect(again.output).toMatchObject({ outcome: 'ok', appliedAt: new Date(INSIDE).toISOString(), reused: true, late: false });
  } finally { f.cleanup(); }
});

test('traffic-prep node before the window holds until windowStart (never fails), then applies', async () => {
  const f = fixture();
  try {
    const before = readFileSync(f.trafficFile, 'utf8');
    let clock = WINDOW_START - COUNTDOWN_LONG_HOLD_NOTICE_MS - TRAFFIC_PREP_HOLD_POLL_MS;
    const sleeps: number[] = [];
    const { code, output } = await runNode('0.3.31', { ...f.deps(clock), now: () => new Date(clock), sleep: async (ms) => {
      // While held, nothing was written: traffic and receipt are untouched.
      expect(readFileSync(f.trafficFile, 'utf8')).toBe(before);
      expect(existsSync(trafficPrepReceiptPath('0.3.31', f.root))).toBe(false);
      sleeps.push(ms);
      clock += ms;
    } });
    expect(code).toBe(0);
    expect(sleeps.every((ms) => ms <= TRAFFIC_PREP_HOLD_POLL_MS)).toBe(true);
    expect(clock).toBe(WINDOW_START);
    expect(output).toMatchObject({ outcome: 'ok', appliedAt: new Date(WINDOW_START).toISOString(), late: false,
      heldMs: COUNTDOWN_LONG_HOLD_NOTICE_MS + TRAFFIC_PREP_HOLD_POLL_MS });
  } finally { f.cleanup(); }
});

test('a late run (after cutAt, within validUntil) still applies and records late: true; past validUntil it fails, never skips', async () => {
  const f = fixture();
  try {
    const { code, output } = await runNode('0.3.31', f.deps(LATE));
    const path = trafficPrepReceiptPath('0.3.31', f.root);
    expect(code).toBe(0);
    expect(output).toMatchObject({ outcome: 'ok', cutAt: CUT_AT, appliedAt: new Date(LATE).toISOString(), late: true });
    expect(checkTrafficPrepReceipt('0.3.31', { ...f.deps(LATE), runId: RUN_ID })).toMatchObject({ ok: true, receipt: { late: true } });
    expect(readTrafficPrepMarker(path, '0.3.31', { now: new Date(LATE), cutAt: CUT_AT }).prepped).toBe(true);
    // Without the explicit late stamp a post-cut application is still refused (the manual window rule is unchanged).
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), late: false }));
    expect(checkTrafficPrepReceipt('0.3.31', { ...f.deps(LATE), runId: RUN_ID })).toMatchObject({ ok: false, reason: 'outside-window' });
    const g = fixture();
    try {
      const before = readFileSync(g.trafficFile, 'utf8');
      const stale = await runNode('0.3.31', g.deps(PAST_VALID));
      expect(stale.code).not.toBe(0);
      expect(stale.output).toMatchObject({ outcome: 'fail' });
      expect(String(stale.output.summary)).toStartWith(`${TRAFFIC_NOT_PREPPED}(stale)`);
      expect(String(stale.output.summary)).toContain('eln release prepare --version 0.3.31');
      expect(readFileSync(g.trafficFile, 'utf8')).toBe(before);
    } finally { g.cleanup(); }
  } finally { f.cleanup(); }
});

test('an operator T-1h prep is reused and taken over by the run, so the run owns the restore', async () => {
  const f = fixture();
  try {
    const manual = await runTrafficPrep({ version: '0.3.31' }, f.deps(INSIDE));
    expect(manual.ok).toBe(true);
    const manualRunId = manual.ok ? manual.receipt.prepRunId : '';
    const { output } = await runNode('0.3.31', f.deps(LATE));
    expect(output).toMatchObject({ outcome: 'ok', reused: true, late: false, appliedAt: new Date(INSIDE).toISOString(),
      prepRunId: RUN_ID, takenOverFrom: manualRunId });
    expect(f.traffic().releaseLifecycle).toMatchObject({ runId: RUN_ID, stage: 0, beforeCut: { global: 'yellow' } });
    expect(await runTrafficNode('traffic-failed-restore', { ELANOUS_GRAPH_CONTEXT: JSON.stringify(context('0.3.31', 'traffic-failed-restore')) },
      { options: { trafficFile: f.trafficFile }, report: () => {} })).toBe(0);
    expect(f.traffic()).toMatchObject({ global: 'yellow', seats: Object.fromEntries(SEATS.map((seat) => [seat, { perCycle: `baseline-${seat}` }])) });
  } finally { f.cleanup(); }
});

test('rc rehearsal: the run start is the cut — the base schedule is ignored and the receipt lands under the rc run version', async () => {
  const f = fixture();
  try {
    const { code, output } = await runNode('0.3.31-rc.0', f.deps(PAST_VALID));
    expect(code).toBe(0);
    expect(output).toMatchObject({ outcome: 'ok', receiptPath: trafficPrepReceiptPath('0.3.31-rc.0', f.root),
      cutAt: new Date(PAST_VALID).toISOString(), late: false });
    expect(checkTrafficPrepReceipt('0.3.31-rc.0', { ...f.deps(PAST_VALID), runId: RUN_ID })).toMatchObject({ ok: true, receipt: { prerelease: 'rc' } });
    expect(checkTrafficPrepReceipt('0.3.31', f.deps(PAST_VALID))).toMatchObject({ ok: false, reason: 'missing' });
  } finally { f.cleanup(); }
});

test('release graph order: traffic-prep is the entry and precedes cut-branch, with a plugin binding and an unbounded hold recipe', () => {
  const graph = yaml(readFileSync(GRAPH, 'utf8')) as { entry_node: string; nodes: Array<{ node_id: string; recipe: string }>; edges: Array<{ from: string; map?: Record<string, string> }> };
  expect(graph.entry_node).toBe('traffic-prep');
  const [first, second] = graph.nodes.map((node) => node.node_id);
  expect([first, second]).toEqual(['traffic-prep', 'cut-branch']);
  expect(graph.nodes.find((node) => node.node_id === 'traffic-prep')?.recipe).toBe('cmd:traffic-prep');
  expect(graph.edges.find((edge) => edge.from === 'traffic-prep')?.map).toEqual({ ok: 'cut-branch', fail: 'failed', error: 'failed' });
  const recipes = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8')) as Record<string, { command: string; timeout_ms: number }>;
  // Source: #39159 — the hold is unbounded like readiness-countdown: timeout_ms 0 disables the command timeout.
  expect(recipes['traffic-prep']).toEqual({ command: 'bun scripts/release-loop/traffic-prep-node.ts', timeout_ms: 0 });
  const bindings = JSON.parse(readFileSync(join(import.meta.dir, '../../graphs/release/node-command-bindings.json'), 'utf8')) as Record<string, unknown>;
  expect(bindings['traffic-prep']).toEqual({ recipe: 'cmd:traffic-prep', command: 'bun scripts/release-loop/traffic-prep-node.ts' });
});

test('graph: traffic-prep → cut-branch, and a run failure restores the pre-prep baseline through traffic-failed-restore', async () => {
  const f = fixture();
  const seen: string[] = [];
  try {
    const state = await runGraph(GRAPH, { input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root: f.root, runBash: async (_body, options) => {
      const env = { ELANOUS_GRAPH_CONTEXT: options.env!.ELANOUS_GRAPH_CONTEXT! };
      const nodeId = JSON.parse(readFileSync(env.ELANOUS_GRAPH_CONTEXT, 'utf8')).nodeId as string;
      seen.push(nodeId);
      const lines: string[] = [];
      const log = spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
      let code: number;
      try {
        // A stable run without a schedule row: its start is the cut, so the entry applies inside the window.
        if (nodeId === 'traffic-prep') code = await runTrafficPrepNode(env, { root: f.root, traffic: { trafficFile: f.trafficFile }, schedule: () => null, baseSha: () => null });
        else if (nodeId.startsWith('traffic-')) code = await runTrafficNode(nodeId, env, { options: { trafficFile: f.trafficFile }, report: () => {} });
        else {
          const fail = nodeId === 'checklist-gate';
          return { exitCode: fail ? 1 : 0, stdout: `${JSON.stringify({ outcome: fail ? 'fail' : 'ok', verdict: fail ? 'fail' : 'pass', summary: 'fixture' })}\n`, stderr: '' };
        }
      } finally { log.mockRestore(); }
      if (nodeId === 'traffic-cut-start') expect(f.traffic()).toMatchObject({ global: 'gate', releaseLifecycle: { stage: 0, beforeCut: { global: 'yellow' } } });
      return { exitCode: code, stdout: `${lines.join('\n')}\n`, stderr: '' };
    } } });
    const [entry, next] = state.path;
    expect([entry, next]).toEqual(['traffic-prep', 'cut-branch']);
    const [terminal, restore] = [...state.path].reverse();
    expect([restore, terminal]).toEqual(['traffic-failed-restore', 'failed']);
    const [firstRun, secondRun] = seen;
    expect([firstRun, secondRun]).toEqual(['traffic-prep', 'cut-branch']);
    const receipt = JSON.parse(readFileSync(trafficPrepReceiptPath('9.9.9', f.root), 'utf8'));
    expect(receipt).toMatchObject({ version: '9.9.9', prepRunId: state.runId, late: false });
    expect(f.traffic()).toMatchObject({ global: 'yellow', releaseLifecycle: { runId: state.runId, stage: 3 },
      seats: Object.fromEntries(SEATS.map((seat) => [seat, { perCycle: `baseline-${seat}` }])) });
  } finally { f.cleanup(); }
});
