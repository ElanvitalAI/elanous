import { expect, test, setDefaultTimeout, setSystemTime } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextNow, type ContextNowDeps } from './context-now.js';
import { renderTuiNow, renderVoiceNow } from './context-now-surfaces.js';
import type { QueriedRunningRunsResult } from '../self-implement/running-runs.js';
import { recordExternalEvent } from './external-events.js';
import { openSurfaceEventsDb } from '../domains/surface-events.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { add } from '../release-loop/feature-store.js';
import { seatLedgerPath } from '../seat-loop/seat-loop.js';
import { routeRequest } from '../nexus/api/http-server.js';
import { createDevProxyRuntimeRef } from '../nexus/api/admin-dev-proxy.js';
import { SELF_COGNITION_RUNTIMES } from '../tool-runtime/self-cognition-runtimes.js';
import { buildCoreTools } from '../domains/core-tools.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { openSchedulesDb } from '../domains/schedule-registry.js';
import { localLoopRows } from '../dashboard/slash-runtime/loops-table.js';

// The HTTP/chat parity test now reads the live operational sources (running runs scan the federated ledgers);
// that alone took ~6 s on a loaded host, past Bun's 5 s default.
setDefaultTimeout(30_000);

const at = '2026-10-03T04:00:00.000Z';
const noOperations: ContextNowDeps = { runningRuns: () => [], releaseRun: () => null, lateSchedules: () => null };

function ledgerRunAnswer(start: Record<string, unknown> | null) {
  const root = mkdtempSync(join(tmpdir(), 'context-run-ledger-'));
  try {
    const directory = join(root, 'run-ledger');
    mkdirSync(directory);
    writeFileSync(join(directory, 'run-now.jsonl'), start ? JSON.stringify({ runId: 'run-now', event: 'start', ...start }) + '\n' : '');
    const entry = { runId: 'run-now', status: 'running', ledgerDirectories: [directory], lastPhase: 'implement' };
    const queryRuns = () => ({ entries: [entry], countedStatuses: ['running'], completeness: 'complete',
      pty: { unreadable: [] }, phases: { unreadableTargetCount: 0 } }) as unknown as QueriedRunningRunsResult;
    return contextNow({}, { ...noOperations, runningRuns: undefined, queryRuns, now: () => new Date(at), version: () => '0.2.0',
      checklist: version => ({ version, released: '', dev: version, history: [], items: [] }),
      decisions: () => [], seatEntries: () => [], events: () => [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('TUI /now running run reads goal and elapsed minutes from start ledger', () => {
  const answer = ledgerRunAnswer({ timestamp: '2026-10-03T03:52:00.000Z', data: { feature: 'Ship ledger goal' } });
  expect(answer.facts[0]).toMatchObject({ kind: 'run', goal: 'Ship ledger goal', phase: 'implement', elapsed: '8분' });
  expect(renderTuiNow(answer).join('\n')).toContain('Ship ledger goal · implement · 8분');
});

test('TUI /now running run reports missing goal and elapsed only without ledger values', () => {
  const answer = ledgerRunAnswer({ data: {} });
  expect(answer.facts[0]).toMatchObject({ kind: 'run', goal: '골 미기록', phase: 'implement', elapsed: '경과 미관측' });
  expect(renderTuiNow(answer).join('\n')).toContain('골 미기록 · implement · 경과 미관측');
});

test('TUI /now keeps recorded goal and elapsed when another ledger directory is unreadable', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-run-partial-'));
  try {
    const broken = join(root, 'broken');
    const healthy = join(root, 'healthy');
    mkdirSync(broken);
    mkdirSync(healthy);
    writeFileSync(join(broken, 'run-now.jsonl'), '{broken}\n');
    writeFileSync(join(healthy, 'run-now.jsonl'), JSON.stringify({ runId: 'run-now', event: 'start',
      timestamp: '2026-10-03T03:52:00.000Z', data: { feature: 'Recovered goal' } }) + '\n');
    const queryRuns = () => ({ entries: [{ runId: 'run-now', status: 'running', ledgerDirectories: [broken, healthy], lastPhase: 'implement' }],
      countedStatuses: ['running'], completeness: 'complete', pty: { unreadable: [] }, phases: { unreadableTargetCount: 0 } }) as unknown as QueriedRunningRunsResult;
    const observed = contextNow({}, { ...noOperations, runningRuns: undefined, queryRuns, now: () => new Date(at),
      version: () => '0.2.0', checklist: version => ({ version, released: '', dev: version, history: [], items: [] }),
      decisions: () => [], seatEntries: () => [], events: () => [] });
    expect(observed.facts[0]).toMatchObject({ kind: 'run', goal: 'Recovered goal', elapsed: '8분' });
    const lines = renderTuiNow(observed).join('\n');
    expect(lines).toContain('Recovered goal · implement · 8분');
    expect(lines).toContain('못 읽음 · 런 원장 일부 관측 불가');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [label, start, goal, elapsed] of [
  ['goal only', { data: { feature: 'Recovered goal' } }, 'Recovered goal', '경과 관측 불가'],
  ['start only', { timestamp: '2026-10-03T03:52:00.000Z', data: {} }, '골 관측 불가', '8분'],
] as const) {
  test(`TUI /now retains ${label} from a healthy directory when another is damaged`, () => {
    const root = mkdtempSync(join(tmpdir(), 'context-run-partial-field-'));
    try {
      const broken = join(root, 'broken');
      const healthy = join(root, 'healthy');
      mkdirSync(broken);
      mkdirSync(healthy);
      writeFileSync(join(broken, 'run-now.jsonl'), '{broken}\n');
      writeFileSync(join(healthy, 'run-now.jsonl'), JSON.stringify({ runId: 'run-now', event: 'start', ...start }) + '\n');
      const queryRuns = () => ({ entries: [{ runId: 'run-now', status: 'running', ledgerDirectories: [broken, healthy], lastPhase: 'implement' }],
        countedStatuses: ['running'], completeness: 'complete', pty: { unreadable: [] }, phases: { unreadableTargetCount: 0 } }) as unknown as QueriedRunningRunsResult;
      const observed = contextNow({}, { ...noOperations, runningRuns: undefined, queryRuns, now: () => new Date(at),
        version: () => '0.2.0', checklist: version => ({ version, released: '', dev: version, history: [], items: [] }),
        decisions: () => [], seatEntries: () => [], events: () => [] });
      expect(observed.facts[0]).toMatchObject({ kind: 'run', goal, elapsed });
      const lines = renderTuiNow(observed).join('\n');
      expect(lines).toContain(`${goal} · implement · ${elapsed}`);
      expect(lines).toContain('못 읽음 · 런 원장 일부 관측 불가');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('TUI /now distinguishes unreadable run ledger from absent goal and start time', () => {
  const answer = ledgerRunAnswer({ timestamp: '2026-10-03T03:52:00.000Z', data: { feature: 'Recorded goal' } });
  const root = mkdtempSync(join(tmpdir(), 'context-run-unreadable-'));
  try {
    const directory = join(root, 'run-ledger');
    mkdirSync(directory);
    writeFileSync(join(directory, 'run-now.jsonl'), '{broken}\n');
    const queryRuns = () => ({ entries: [{ runId: 'run-now', status: 'running', ledgerDirectories: [directory], lastPhase: 'implement' }],
      countedStatuses: ['running'], completeness: 'complete', pty: { unreadable: [] }, phases: { unreadableTargetCount: 0 } }) as unknown as QueriedRunningRunsResult;
    const observed = contextNow({}, { ...noOperations, runningRuns: undefined, queryRuns, now: () => new Date(at),
      version: () => '0.2.0', checklist: version => ({ version, released: '', dev: version, history: [], items: [] }),
      decisions: () => [], seatEntries: () => [], events: () => [] });
    expect(observed.facts[0]).toMatchObject({ kind: 'run', unreadable: '런 원장 일부 관측 불가' });
    expect(renderTuiNow(observed).join('\n')).toContain('못 읽음 · 런 원장 일부 관측 불가');
    expect(renderTuiNow(observed).join('\n')).not.toContain('골 미기록');
    expect(renderTuiNow(observed).join('\n')).not.toContain('경과 미관측');
    expect(answer.facts[0]).toMatchObject({ goal: 'Recorded goal', elapsed: '8분' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Fake ledger readers exercise filtering and source preservation without creating a store.
test('topic filters cell IDs/titles and event summaries; lines carry sources and no conversation bodies', () => {
  const answer = contextNow({ topic: 'K6' }, {
    ...noOperations, now: () => new Date(at), version: () => '0.2.0',
    checklist: v => ({ version: v, released: '', dev: v, history: [], items: v === '0.2.0' ? [
      { id: 'K6', title: 'Ship the context door', status: 'red', updatedAt: at, updatedBy: 'TC' },
      { id: 'K7', title: 'Another feature', status: 'yellow', updatedAt: at, updatedBy: 'TC' },
    ] : [] }),
    decisions: () => [{ id: 'D1', title: 'Approve launch', status: 'open', raisedBy: { agent: 'TC' },
      category: 'scope', scqa: { s: 'SECRET CONVERSATION', c: 'x' }, options: [], recommendation: { skipped: true, reason: 'x' }, history: [] }],
    seatEntries: () => [
      { entry: { seat: 'TC', at, status: 'shadow', item: { source: 'checklist', id: 'K6', title: 'Ship the context door', text: 'SECRET CONVERSATION' } }, source: 'elanous://seat-loop/TC/1#1' },
      { entry: { seat: 'MK', at, status: 'shadow', item: { source: 'request', id: 'R1', title: 'Other', text: 'SECRET CONVERSATION' } }, source: 'elanous://seat-loop/MK/1#2' },
    ],
    events: () => [
      { id: 'a', at, summary: 'K6 ready', text: 'SECRET CONVERSATION', kind: '보고', refs: { seat: 'TC', recipients: [], all: false, kind: '보고', slot: null, deadline: null, url: null } },
      { id: 'b', at, summary: 'Other work', text: 'SECRET CONVERSATION', kind: '보고', refs: { seat: 'TC', recipients: [], all: false, kind: '보고', slot: null, deadline: null, url: null } },
    ],
  });
  expect(answer.facts.map(f => f.kind)).toEqual(['cell', 'seat']);
  expect(answer.facts[0]).toMatchObject({ kind: 'cell', id: 'K6', title: 'Ship the context door' });
  expect(answer.events.map(e => e.summary)).toEqual(['K6 ready']);
  expect(answer.facts.some(f => f.kind === 'decision')).toBe(false);
  expect([...answer.facts, ...answer.events].every(line => !!line.source)).toBe(true);
  expect(JSON.stringify(answer)).not.toContain('SECRET CONVERSATION');
  const byTitle = contextNow({ topic: 'another FEATURE' }, {
    ...noOperations, now: () => new Date(at), version: () => '0.2.0',
    checklist: v => ({ version: v, released: '', dev: v, history: [], items: v === '0.2.0'
      ? [{ id: 'K7', title: 'Another feature', status: 'yellow', updatedAt: at, updatedBy: 'TC' }] : [] }),
    decisions: () => [], seatEntries: () => [], events: () => [],
  });
  expect(byTitle.facts).toMatchObject([{ kind: 'cell', id: 'K7' }]);
});

test('unfiltered version facts, bounded limit and empty ledgers retain the read-only answer shape', () => {
  const answer = contextNow({ limit: 1 }, {
    ...noOperations, now: () => new Date(at), version: () => '0.2.0',
    checklist: version => ({ version, released: '', dev: version, history: [], items: [] }),
    decisions: () => [], seatEntries: () => [], events: () => [],
  });
  expect(answer).toEqual({ at, topic: null, facts: [{ kind: 'version', version: '0.2.0', source: 'elanous://release/0.2.0/checklist' }], events: [], guide: [] });
});

test('crowded ledgers retain decisions and the latest seat status within the fact limit', () => {
  const earlier = '2026-10-03T02:00:00.000Z';
  const later = '2026-10-03T03:00:00.000Z';
  const deps: ContextNowDeps = {
    ...noOperations, now: () => new Date(at), version: () => '0.2.0',
    checklist: version => ({ version, released: '', dev: version, history: [], items: version === '0.2.0'
      ? Array.from({ length: 25 }, (_, i) => ({ id: `K${i}`, title: `Open cell ${i}`, status: 'yellow' as const, updatedAt: at, updatedBy: 'TC' })) : [] }),
    decisions: () => [{ id: 'D1', title: 'Decision needed', status: 'open', raisedBy: { agent: 'TC' },
      category: 'scope', scqa: { s: 's', c: 'c' }, options: [], recommendation: { skipped: true, reason: 'x' }, history: [] }],
    seatEntries: () => [
      { entry: { seat: 'TC', at: earlier, status: 'attempting', item: { source: 'checklist', id: 'K0', title: 'Old work', text: 'private' } }, source: 'elanous://seat-loop/TC/1#1' },
      { entry: { seat: 'TC', at: later, status: 'launched', item: { source: 'checklist', id: 'K0', title: 'New work', text: 'private' } }, source: 'elanous://seat-loop/TC/1#2' },
    ],
    events: () => [],
  };
  const answer = contextNow({ limit: 6 }, deps);
  expect(answer.facts).toHaveLength(6);
  expect(answer.facts.map(f => f.kind)).toEqual(['version', 'cell', 'cell', 'cell', 'decision', 'seat']);
  expect(answer.facts).toContainEqual(expect.objectContaining({ kind: 'decision', id: 'D1' }));
  expect(answer.facts).toContainEqual(expect.objectContaining({ kind: 'seat', status: 'launched', at: later, source: 'elanous://seat-loop/TC/1#2' }));
  expect(answer.facts).not.toContainEqual(expect.objectContaining({ kind: 'seat', status: 'attempting' }));
  expect(answer.facts.every(f => !!f.source)).toBe(true);
  const defaultAnswer = contextNow({}, deps);
  expect(defaultAnswer.facts).toHaveLength(20);
  expect(defaultAnswer.facts).toContainEqual(expect.objectContaining({ kind: 'decision', id: 'D1' }));
  expect(defaultAnswer.facts).toContainEqual(expect.objectContaining({ kind: 'seat', status: 'launched', at: later }));
  expect(defaultAnswer.facts.filter(f => f.kind === 'seat').map(f => f.status)).toEqual(['launched', 'attempting']);
});

test('operational sources are independently injectable, unreadable is not zero, and topic narrows all facts', () => {
  const base: ContextNowDeps = { ...noOperations, now: () => new Date(at), version: () => '0.2.0',
    checklist: version => ({ version, released: '', dev: version, history: [], items: [] }),
    decisions: () => [], seatEntries: () => [], events: () => [] };
  const run = { kind: 'run' as const, goal: 'Ship K6', phase: 'review', elapsed: '8분', source: 'run://one' };
  const release = { kind: 'release' as const, version: '0.2.1', node: '2/4 publish', status: 'running', source: 'release://one' };
  const late = { kind: 'schedule-late' as const, count: 1, names: ['K6 cron'], source: 'cron://one' };
  const deps = { ...base, runningRuns: () => [run], releaseRun: () => release, lateSchedules: () => late };
  expect(contextNow({}, deps).facts.slice(0, 3)).toEqual([run, release, late]);
  expect(contextNow({ topic: 'K6' }, deps).facts).toEqual([run, late]);
  expect(contextNow({ topic: 'K6' }, { ...deps, releaseRun: () => { throw new Error('잠김'); } }).facts).toContainEqual(
    expect.objectContaining({ kind: 'release', unreadable: '잠김' }),
  );
  const calls: string[] = [];
  expect(contextNow({ audience: 'public-demo' }, { ...deps,
    runningRuns: () => { calls.push('run'); return [run]; },
    releaseRun: () => { calls.push('release'); return release; },
    lateSchedules: () => { calls.push('schedule-late'); return late; },
    brandCheck: () => ({ missing: false, findings: [] }) as never,
  }).facts.map(fact => fact.kind)).toEqual(['version']);
  expect(calls).toEqual([]);
  for (const failed of ['runningRuns', 'releaseRun', 'lateSchedules'] as const) {
    const broken = { ...deps, [failed]: () => { throw new Error('잠김'); } };
    const facts = contextNow({}, broken).facts;
    expect(facts.find(fact => 'unreadable' in fact && fact.unreadable)).toMatchObject({ unreadable: '잠김' });
    expect(facts.filter(fact => !('unreadable' in fact && fact.unreadable))).toEqual(expect.arrayContaining(
      [run, release, late].filter(fact => fact.kind !== ({ runningRuns: 'run', releaseRun: 'release', lateSchedules: 'schedule-late' } as const)[failed]),
    ));
  }
});

test('release adapter reads the same graph-runs/release-loop ledger as /v1/ops/release/runs and selects the latest', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-release-'));
  const previous = { config: process.env.ELANOUS_CONFIG_DIR, state: process.env.ELANOUS_STATE_DIR };
  process.env.ELANOUS_CONFIG_DIR = root;
  process.env.ELANOUS_STATE_DIR = root;
  setElanousConfigDir(root);
  try {
    const dir = join(root, 'graph-runs', 'release-loop');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'old.json'), JSON.stringify({ startedAt: '2026-10-02T00:00:00Z', status: 'done', input: { version: '0.2.0' }, path: ['prepare'], nodes: [{ nodeId: 'prepare' }] }));
    writeFileSync(join(dir, 'latest.json'), JSON.stringify({ startedAt: at, status: 'running', input: { version: '0.2.1' }, path: ['prepare', 'publish', 'verify'], nodes: [{ nodeId: 'prepare' }] }));
    const facts = contextNow({}, { ...noOperations, releaseRun: undefined, now: () => new Date(at), version: () => '0.2.0',
      checklist: version => ({ version, released: '', dev: version, history: [], items: [] }),
      decisions: () => [], seatEntries: () => [], events: () => [] }).facts;
    expect(facts[0]).toEqual({ kind: 'release', version: '0.2.1', node: '2/3 publish', status: 'running', source: 'elanous://graph-runs/release-loop/latest' });
  } finally {
    resetElanousConfigDir();
    if (previous.config === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previous.config;
    if (previous.state === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previous.state;
    rmSync(root, { recursive: true, force: true });
  }
});

test('schedule adapter reuses /loops local cron verdict over the read-only schedule registry', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-schedules-'));
  const previous = { config: process.env.ELANOUS_CONFIG_DIR, state: process.env.ELANOUS_STATE_DIR };
  process.env.ELANOUS_CONFIG_DIR = root;
  process.env.ELANOUS_STATE_DIR = root;
  setElanousConfigDir(root);
  try {
    const db = openSchedulesDb();
    db.run(`INSERT INTO schedule_registry (id, name, source, cron, interval_ms, category, enabled, last_run, last_status, run_via)
      VALUES (?, ?, 'crontab', '0 * * * *', 60000, 'maintenance', 1, ?, 'ok', 'crontab')`, ['late-cron', 'nightly', '2026-10-02T00:00:00Z']);
    expect(db.query('SELECT name FROM schedule_registry').all()).toEqual([{ name: 'nightly' }]);
    db.close();
    expect(localLoopRows(new Date(at))).toContainEqual(expect.objectContaining({ name: 'nightly', verdict: 'late' }));
    const facts = contextNow({}, { ...noOperations, lateSchedules: undefined, now: () => new Date(at), version: () => '0.2.0',
      checklist: version => ({ version, released: '', dev: version, history: [], items: [] }),
      decisions: () => [], seatEntries: () => [], events: () => [] }).facts;
    expect(facts[0]).toEqual({ kind: 'schedule-late', count: 1, names: ['nightly'], source: 'elanous://schedules' });
  } finally {
    resetElanousConfigDir();
    if (previous.config === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previous.config;
    if (previous.state === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previous.state;
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /v1/context/now?format=voice returns only rendered text while other formats keep the ledger JSON', async () => {
  setSystemTime(new Date('2026-10-03T04:00:00.000Z'));
  const root = mkdtempSync(join(tmpdir(), 'context-now-voice-'));
  const previous = { config: process.env.ELANOUS_CONFIG_DIR, state: process.env.ELANOUS_STATE_DIR };
  process.env.ELANOUS_CONFIG_DIR = root;
  process.env.ELANOUS_STATE_DIR = root;
  setElanousConfigDir(root);
  try {
    const now = new Date();
    const seatPath = seatLedgerPath('TC', root, now);
    mkdirSync(join(root, 'seat-loop', 'TC'), { recursive: true });
    writeFileSync(seatPath, JSON.stringify({ seat: 'TC', at: now.toISOString(), status: 'doing',
      item: { source: 'checklist', id: 'K6', title: 'Voice route work', text: 'PRIVATE CHAT' } }) + '\n');
    const opts = { metaApi: { bearerToken: 'owner-token' } } as Parameters<typeof routeRequest>[1];
    const run = (path: string, token = 'owner-token') => routeRequest(
      new Request(`http://localhost/v1/context/now${path}`, { headers: { authorization: `Bearer ${token}` } }),
      opts,
      { requestIP: () => ({ address: '198.51.100.1' }) } as unknown as Parameters<typeof routeRequest>[2],
      null,
      createDevProxyRuntimeRef(),
    );
    const plain = await run('');
    expect(plain?.status).toBe(200);
    const answer = await plain?.json();
    expect(Object.keys(answer).sort()).toEqual(['at', 'audience', 'events', 'facts', 'guide', 'hiddenCount', 'topic']);
    expect(answer.facts).toContainEqual(expect.objectContaining({ kind: 'seat', title: 'Voice route work' }));
    const voice = await run('?format=voice');
    expect(voice?.status).toBe(200);
    const voiceBody = await voice?.json();
    expect(voiceBody).toEqual({ text: renderVoiceNow(answer), audience: 'operator', hiddenCount: 0 });
    expect(voiceBody.text).toContain('Voice route work');
    expect(voiceBody.text).not.toContain('PRIVATE CHAT');
    expect(await (await run('?format=card'))?.json()).toEqual(answer);
    expect(await (await run('?format=voice', 'wrong-token'))?.json()).toEqual({ error: 'unauthorized' });
  } finally {
    setSystemTime();
    resetElanousConfigDir();
    if (previous.config === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previous.config;
    if (previous.state === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previous.state;
    rmSync(root, { recursive: true, force: true });
  }
});

test('authenticated HTTP and chat runtime return the same JSON from isolated release, decision, seat and context ledgers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'context-now-'));
  const previous = { config: process.env.ELANOUS_CONFIG_DIR, state: process.env.ELANOUS_STATE_DIR };
  process.env.ELANOUS_CONFIG_DIR = root;
  process.env.ELANOUS_STATE_DIR = root;
  setElanousConfigDir(root);
  try {
    const version = (await import('../release-loop/checklist.js')).devVersion().replace(/-.*$/, '');
    add(version, { id: 'K6', title: 'Context door', status: 'red', updatedAt: at, updatedBy: 'TC' });
    add(version, { id: 'K7', title: 'Unrelated feature', status: 'yellow', updatedAt: at, updatedBy: 'TC' });
    const ledger = new DecisionLedger({ stateDir: root, resolveVersion: () => ({ released: version, dev: version, codename: version }) });
    ledger.raise({ title: 'K6 decision', category: 'scope', scqa: { s: 'release', c: 'approve' },
      options: [{ key: 'a', label: 'Yes', consequence: 'go' }, { key: 'b', label: 'No', consequence: 'wait' }],
      recommendation: { skipped: true, reason: 'owner' }, raisedBy: { agent: 'TC' }, raisedAt: at });
    const now = new Date();
    const seatPath = seatLedgerPath('TC', root, now);
    mkdirSync(join(root, 'seat-loop', 'TC'), { recursive: true });
    writeFileSync(seatPath, [
      { seat: 'TC', at: now.toISOString(), status: 'shadow', item: { source: 'checklist', id: 'K6', title: 'Context door', text: 'PRIVATE CHAT' } },
      { seat: 'TC', at: now.toISOString(), status: 'shadow', item: { source: 'checklist', id: 'K7', title: 'Other', text: 'PRIVATE CHAT' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const db = openSurfaceEventsDb();
    try { recordExternalEvent({ origin: 'claude-code', kind: 'guide-changed', summary: 'K6 guide changed\nPRIVATE CHAT', source: 'https://example.org/guide' }, { db }); }
    finally { db.close(); }
    const runtime = SELF_COGNITION_RUNTIMES.find(tool => tool.id === 'context_now')!;
    expect(runtime.spec.name).toBe('context_now');
    const core = buildCoreTools();
    expect(core.names.has('context_now')).toBe(true);
    const request = (headers?: HeadersInit) => new Request('http://localhost/v1/context/now?topic=K6', { headers });
    const opts = { metaApi: { bearerToken: 'owner-token' } } as Parameters<typeof routeRequest>[1];
    const run = (req: Request) => routeRequest(req, opts, { requestIP: () => ({ address: '198.51.100.1' }) } as unknown as Parameters<typeof routeRequest>[2], null, createDevProxyRuntimeRef());
    const denied = await run(request());
    expect(denied?.status).toBe(401);
    expect((await run(request({ authorization: 'Bearer wrong-token' })))?.status).toBe(401);
    expect(await denied?.json()).toEqual({ error: 'unauthorized' });
    const response = await run(request({ authorization: 'Bearer owner-token' }));
    expect(response?.status).toBe(200);
    const http = await response?.json();
    const chat = await runtime.run({ topic: 'K6' }, { surface: 'skill' });
    // CTX5B: the daemon answer always names its audience (operator → hiddenCount 0); chat/tool surfaces return the bare answer.
    expect(http).toEqual({ ...chat, audience: 'operator', hiddenCount: 0 });
    expect(await core.dispatch('context_now', { topic: 'K6' })).toEqual(chat);
    expect(http.facts.map((fact: { kind: string }) => fact.kind)).toEqual(['cell', 'seat']);
    expect(http.events).toHaveLength(1);
    expect(http.guide).toHaveLength(1);
    expect(http.guide[0]).toContain('https://example.org/guide');
    const unfiltered = await runtime.run({}, { surface: 'skill' }) as { facts: Array<{ kind: string; id?: string }> };
    expect(unfiltered.facts).toContainEqual(expect.objectContaining({ kind: 'decision', id: expect.any(String) }));
    expect(JSON.stringify(http)).not.toContain('PRIVATE CHAT');
    expect([...http.facts, ...http.events].every((line: { source: string }) => !!line.source)).toBe(true);
  } finally {
    resetElanousConfigDir();
    if (previous.config === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previous.config;
    if (previous.state === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previous.state;
    rmSync(root, { recursive: true, force: true });
  }
});
