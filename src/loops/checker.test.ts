import { afterEach, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { Command } from 'commander';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { inventoryCrontab, listSchedules, openSchedulesDb } from '../domains/schedule-registry.js';
import { buildUserConfig } from '../user-config.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { checkLoops, daemonScheduleEntries, dueBefore, entriesFromRegistry, launcherEvidence, notifyOwners, observeLoopCheck, previousLoopFire, scheduleFindings, versionEvidence, extendHealthyLauncher } from './checker.js';
import { emitLoopHeartbeat } from './neighbor-runtime.js';
import { registerLoopCommands } from './loop-cli.js';
import { listAllLoops, listLoops, type LoopEntry } from './registry.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const now = new Date('2026-10-04T12:00:00.000Z');
function root() { const dir = mkdtempSync(join(tmpdir(), 'loop-check-')); dirs.push(dir); return dir; }
const base = { enabled: true, registered: true };
function graphLoop(): LoopEntry {
  return { id: 'every-ten', title: 'Every ten', description: null, file: 'graphs/ten.yaml', enabled: true,
    jobs: [{ id: 'job', enabled: true, cron: '*/10 * * * *' }], nextRun: null,
    trigger: { cron: '*/10 * * * *', events: [] },
    lastRun: { at: '2026-10-04T11:35:00Z', status: 'done', path: 'graph-runs/ten.json',
      runId: 'run-1', failedNodes: [], durationMs: 20 } };
}
const entries = [
  { ...base, id: 'off', enabled: false, lastRunAt: '2026-10-01T00:00:00Z' },
  { ...base, id: 'missing', registered: false, lastRunAt: '2026-10-01T00:00:00Z' },
  { ...base, id: 'broken', owner: 'MK', recentStatuses: ['failed', 'failed', 'failed'], lastRunAt: '2026-10-04T11:59:00Z' },
  { ...base, id: 'slow', owner: 'TC', expectEveryMinutes: 10, lastRunAt: '2026-10-04T11:35:00Z', lastStatus: 'done' },
  { ...base, id: 'new', expectEveryMinutes: 10 },
  { ...base, id: 'healthy', expectEveryMinutes: 10, lastRunAt: '2026-10-04T11:55:00Z', lastStatus: 'done' },
];

test('observed never-fired schedule becomes late only after two actual fires, without changing CLI unknown state', () => {
  const row = { ...base, id: 'never-fired', observedSince: '2026-10-04T11:00:00Z',
    dueAt: '2026-10-04T11:45:00Z' };
  const checked = checkLoops([row], now);
  expect(checked[0]?.state).toBe('unknown');
  expect(scheduleFindings(checked, now)).toMatchObject([{ id: 'never-fired', kind: 'late' }]);
  expect(scheduleFindings(checkLoops([{ ...row, observedSince: '2026-10-04T11:46:00Z' }], now), now)).toEqual([]);
  expect(scheduleFindings(checkLoops([{ ...row, observedSince: undefined }], now), now)).toEqual([]);
});

test('healthy fresh launcher lease extends once; stale or degraded launcher is not silently healed', () => {
  const dir = root();
  emitLoopHeartbeat(dir, 'active', 'healthy', new Date('2026-10-04T11:50:00Z'), '2026-10-04T11:55:00Z');
  const finding = { id: 'active', kind: 'end-expired' as const, reason: 'expired' };
  expect(extendHealthyLauncher(dir, finding, now)).toBe(true);
  const db = new Database(join(dir, 'msg', 'messages.db'));
  try {
    expect(db.query('SELECT ends_at FROM loop_signals WHERE loop_id=?').get('active')).toEqual({ ends_at: '2026-10-04T12:15:00.000Z' });
  } finally { db.close(); }
  expect(extendHealthyLauncher(dir, finding, now)).toBe(false);
  emitLoopHeartbeat(dir, 'stale', 'healthy', new Date('2026-10-04T11:40:00Z'), '2026-10-04T11:55:00Z');
  emitLoopHeartbeat(dir, 'broken', 'degraded', new Date('2026-10-04T11:50:00Z'), '2026-10-04T11:55:00Z');
  expect(extendHealthyLauncher(dir, { ...finding, id: 'stale' }, now)).toBe(false);
  expect(extendHealthyLauncher(dir, { ...finding, id: 'broken' }, now)).toBe(false);
});

test('daemon schedule inventory adds only enabled managed rows and does not duplicate crontab ownership', () => {
  const rows = [
    { id: 'daemon-job', enabled: 1, cron: '*/15 * * * *', run_via: 'elanous', last_run: '2026-10-04T11:10:00Z', last_status: 'ok' },
    { id: 'disabled', enabled: 0, cron: '*/15 * * * *', run_via: 'trigger' },
    { id: 'cron-job', enabled: 1, cron: '*/15 * * * *', run_via: 'crontab' },
  ] as import('../domains/schedule-registry.js').ScheduleRow[];
  const adapted = daemonScheduleEntries(rows, now);
  expect(adapted.map(row => row.id)).toEqual(['daemon-job']);
  expect(checkLoops(adapted, now)[0]).toMatchObject({ state: 'late', owner: 'OP' });
});

test('graph snapshot hash gives a registry-relative version mismatch without guessing missing run versions', () => {
  const dir = root();
  mkdirSync(join(dir, 'graphs'), { recursive: true });
  mkdirSync(join(dir, 'graph-runs', 'my-graph'), { recursive: true });
  const graph = 'graph_id: my-graph\nversion: 2\n';
  writeFileSync(join(dir, 'graphs', 'my-graph.yaml'), graph);
  const hash = createHash('sha256').update('graph_id: my-graph\nversion: 1\n').digest('hex');
  writeFileSync(join(dir, 'graph-runs', 'my-graph', 'old.json'), JSON.stringify({ graphId: 'my-graph', graphSnapshot: { graphSha: hash } }));
  const entry = { ...base, id: 'my-graph', file: 'graphs/my-graph.yaml', lastRunAt: '2026-10-04T11:59:00Z', expectEveryMinutes: 15 };
  expect(scheduleFindings(checkLoops(versionEvidence([entry], dir, dir), now), now).map(f => f.kind)).toEqual(['version-mismatch']);
  expect(versionEvidence([{ ...entry, id: 'missing' }], dir, dir)[0]?.expectedVersion).toBeUndefined();
  writeFileSync(join(dir, 'graph-runs', 'my-graph', 'old.json'), JSON.stringify({ graphId: 'my-graph', variant: { overlayId: 'custom' }, graphSnapshot: { graphSha: hash } }));
  expect(versionEvidence([entry], dir, dir)[0]?.expectedVersion).toBeUndefined();
});

test('scheduler findings include grounded launcher signals and version drift without changing the six-state table', () => {
  const dir = root();
  emitLoopHeartbeat(dir, 'launcher', 'degraded', new Date('2026-10-04T11:30:00Z'), '2026-10-04T11:55:00Z');
  const adapted = launcherEvidence([{ ...base, id: 'launcher', owner: 'TC', lastRunAt: '2026-10-04T11:59:00Z',
    expectEveryMinutes: 15, installedVersion: '1', expectedVersion: '2' }], dir);
  const checked = checkLoops(adapted, now);
  expect(checked[0]!.state).toBe('alive');
  expect(scheduleFindings(checked, now).map(row => row.kind)).toEqual(['degraded', 'end-expired', 'version-mismatch']);
  expect(notifyOwners(checked, { root: dir, now }, scheduleFindings(checked, now))).toBe(3);
  expect(notifyOwners(checked, { root: dir, now }, scheduleFindings(checked, now))).toBe(0);
  expect(readFileSync(join(dir, 'seat-requests', 'requests.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3);
  expect(scheduleFindings(checkLoops([{ ...base, id: 'no-signal', expectEveryMinutes: 15 }], now), now)).toEqual([]);
});

test('OP receives only still-queued owner requests after two 15-minute ticks', () => {
  const dir = root();
  const checked = checkLoops([{ ...base, id: 'broken', owner: 'MK', expectEveryMinutes: 15, lastRunAt: '2026-10-04T11:00:00Z' }], now);
  expect(notifyOwners(checked, { root: dir, now })).toBe(1);
  expect(notifyOwners(checked, { root: dir, now: new Date('2026-10-04T12:29:59Z') }, [], true)).toBe(0);
  expect(notifyOwners(checked, { root: dir, now: new Date('2026-10-04T12:30:00Z') }, [], true)).toBe(1);
  expect(notifyOwners(checked, { root: dir, now: new Date('2026-10-04T12:45:00Z') }, [], true)).toBe(0);
  const lines = readFileSync(join(dir, 'seat-requests', 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(lines.map(row => row.seat)).toEqual(['MK', 'OP']);
  expect(lines[1].key).toBe(`${lines[0].key}:op`);
  const resolvedDir = root();
  expect(notifyOwners(checked, { root: resolvedDir, now })).toBe(1);
  const resolvedPath = join(resolvedDir, 'seat-requests', 'requests.jsonl');
  const resolved = JSON.parse(readFileSync(resolvedPath, 'utf8').trim());
  writeFileSync(resolvedPath, `${JSON.stringify(resolved)}\n${JSON.stringify({ ...resolved, status: 'done' })}\n`);
  expect(notifyOwners(checked, { root: resolvedDir, now: new Date('2026-10-04T12:45:00Z') }, [], true)).toBe(0);
  const crossing = root();
  const midnight = new Date('2026-10-04T23:45:00Z');
  notifyOwners(checked, { root: crossing, now: midnight });
  expect(notifyOwners(checked, { root: crossing, now: new Date('2026-10-05T00:15:00Z') }, [], true)).toBe(1);
  const requests = readFileSync(join(crossing, 'seat-requests', 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(requests.map(row => row.seat)).toEqual(['MK', 'OP']);
  expect(requests[1].key).toBe(`${requests[0].key}:op`);
});

test('six ordered classifications and journal idempotency, preserving existing bytes', () => {
  const dir = root();
  const results = checkLoops(entries, now);
  expect(results.map(result => result.state)).toEqual(['off', 'unregistered', 'failing', 'late', 'unknown', 'alive']);
  const path = join(dir, 'seat-requests', 'requests.jsonl');
  expect(existsSync(path)).toBe(false);
  mkdirSync(join(dir, 'seat-requests'), { recursive: true });
  const prior = '{"key":"prior","receiptId":"prior","seat":"OP","text":"earlier","queuedAt":"2026-10-03T12:00:00Z","status":"queued"}\n';
  writeFileSync(path, prior);
  expect(notifyOwners(results, { root: dir, now })).toBe(2);
  const first = readFileSync(path, 'utf8');
  expect(first.startsWith(prior)).toBe(true);
  expect(first.trim().split('\n').slice(1).map(line => JSON.parse(line))).toMatchObject([
    { key: 'loopcheck:broken:2026-10-04:failing', seat: 'MK', status: 'queued', source: 'loop-checker' },
    { key: 'loopcheck:slow:2026-10-04:late', seat: 'TC', status: 'queued', source: 'loop-checker' },
  ]);
  expect(notifyOwners(results, { root: dir, now })).toBe(0);
  expect(readFileSync(path, 'utf8')).toBe(first);
});

test('late cron-shell log mtime queues exactly one request to its owner per day', () => {
  const dir = realpathSync(root());
  const log = join(dir, 'shell.log');
  writeFileSync(log, 'log contents are not needed');
  utimesSync(log, new Date('2026-10-04T11:35:00Z'), new Date('2026-10-04T11:35:00Z'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ loops: { owners: { owner: 'TC' } } }));
  const db = openSchedulesDb(join(dir, 'schedules.db'));
  try {
    inventoryCrontab(db, { crontab: `*/5 * * * * zsh scripts/owner.sh >> ${log} 2>&1 # cron owner\n` });
    const all = listAllLoops({ root: dir, stateRoot: dir, now, schedules: listSchedules(db), config: buildUserConfig(configPath) });
    const { entries: adapted, scope } = entriesFromRegistry({ listAllLoops: () => all });
    expect(scope).toBe('registry');
    const results = checkLoops(adapted, now);
    expect(results).toMatchObject([{ state: 'late', owner: 'TC', ownerSource: 'config', evidence: 'log-mtime' }]);
    expect(notifyOwners(results, { root: dir, now })).toBe(1);
    expect(notifyOwners(results, { root: dir, now })).toBe(0);
    const lines = readFileSync(join(dir, 'seat-requests', 'requests.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ seat: 'TC', source: 'loop-checker', status: 'queued', key: `loopcheck:${all[0]!.id}:2026-10-04:late` });
  } finally { db.close(); }
});

test('CLI --all --notify preserves log-mtime evidence while an unreadable shell log stays unknown', async () => {
  const dir = realpathSync(root());
  const lateLog = join(dir, 'late.log');
  const unreadableLog = join(dir, 'unreadable.log');
  writeFileSync(lateLog, 'not inspected');
  utimesSync(lateLog, new Date('2026-10-04T11:35:00Z'), new Date('2026-10-04T11:35:00Z'));
  symlinkSync(unreadableLog, unreadableLog); // stat fails with ELOOP rather than ENOENT.
  const db = openSchedulesDb(join(dir, 'schedules.db'));
  try {
    inventoryCrontab(db, { crontab: [
      `*/5 * * * * zsh scripts/unreadable.sh >> ${unreadableLog} 2>&1`,
      `*/5 * * * * zsh scripts/late.sh >> ${lateLog} 2>&1`,
    ].join('\n') + '\n' });
    const schedules = listSchedules(db);
    const program = new Command();
    registerLoopCommands(program, { root: dir, now, listAllLoops: () => listAllLoops({
      root: dir, stateRoot: dir, now, schedules, config: buildUserConfig(join(dir, 'absent-config.json')),
    }) });
    const captured: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      captured.push(String(chunk)); callback?.(); return true;
    }) as typeof process.stdout.write;
    try {
      await program.parseAsync(['loop', 'status', '--all', '--notify', '--json'], { from: 'user' });
      await program.parseAsync(['loop', 'status', '--all', '--notify', '--json'], { from: 'user' });
    } finally { process.stdout.write = original; }
    for (const payload of captured) {
      const output = JSON.parse(payload);
      expect(output.scope).toBe('registry');
      expect(output.results.find((result: { id: string }) => result.id === schedules.find(row => row.command?.includes('unreadable.sh'))!.id))
        .toMatchObject({ state: 'unknown', owner: 'OP', ownerSource: 'default', reason: 'no valid run recorded' });
      const late = output.results.find((result: { id: string }) => result.id === schedules.find(row => row.command?.includes('late.sh'))!.id);
      expect(late).toMatchObject({ state: 'late', owner: 'OP', ownerSource: 'default', evidence: 'log-mtime', lastRunAt: '2026-10-04T11:35:00.000Z' });
    }
    expect(captured).toHaveLength(2);
    const journal = readFileSync(join(dir, 'seat-requests', 'requests.jsonl'), 'utf8').trim().split('\n');
    expect(journal).toHaveLength(1);
    expect(JSON.parse(journal[0]!)).toMatchObject({ seat: 'OP', source: 'loop-checker', status: 'queued' });
  } finally { db.close(); }
});

test('a recorded run with an unknown or unusable expected interval is not called alive', () => {
  for (const interval of [undefined, 0, Number.NaN]) {
    const [result] = checkLoops([{ ...base, id: 'unscheduled', lastRunAt: '2026-10-04T11:55:00Z',
      ...(interval !== undefined ? { expectEveryMinutes: interval } : {}) }], now);
    expect(result).toMatchObject({ state: 'unknown', reason: 'expected interval unknown' });
  }
});

test('concurrent checker processes serialize journal check and append', async () => {
  const dir = root();
  const journal = join(dir, 'seat-requests', 'requests.jsonl');
  mkdirSync(join(dir, 'seat-requests'), { recursive: true });
  const lock = new Database(`${journal}.loop-checker.lock.sqlite`);
  lock.exec('BEGIN EXCLUSIVE');
  const worker = `import { checkLoops, notifyOwners } from ${JSON.stringify(new URL('./checker.ts', import.meta.url).href)};
    const now = new Date('2026-10-04T12:00:00Z');
    console.log(notifyOwners(checkLoops([{ id: 'shared', owner: 'MK', enabled: true, registered: true,
      recentStatuses: ['failed', 'failed', 'failed'], lastRunAt: '2026-10-04T11:59:00Z' }], now),
      { root: process.argv[1], now }));`;
  const children = Array.from({ length: 2 }, () => Bun.spawn([process.execPath, '-e', worker, dir], {
    stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ELANOUS_STATE_DIR: dir, ELANOUS_CONFIG_DIR: dir },
  }));
  try {
    await Bun.sleep(300);
    expect(existsSync(journal)).toBe(false);
  } finally { lock.exec('COMMIT'); lock.close(); }
  const outputs = await Promise.all(children.map(async child => ({
    code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text(),
  })));
  expect(outputs.map(output => output.stderr)).toEqual(['', '']);
  expect(outputs.map(output => output.code)).toEqual([0, 0]);
  expect(outputs.map(output => Number(output.stdout.trim())).sort()).toEqual([0, 1]);
  expect(readFileSync(journal, 'utf8').trim().split('\n')).toHaveLength(1);
});

test('SIGKILL of a lock holder releases the journal for the next checker', async () => {
  const dir = root();
  const journal = join(dir, 'seat-requests', 'requests.jsonl');
  mkdirSync(join(dir, 'seat-requests'), { recursive: true });
  const holder = Bun.spawn([process.execPath, '-e', `
    import { Database } from 'bun:sqlite';
    const db = new Database(process.argv[1]);
    db.exec('BEGIN EXCLUSIVE');
    console.log('locked');
    setInterval(() => {}, 1000);
  `, `${journal}.loop-checker.lock.sqlite`], { stdout: 'pipe', stderr: 'pipe' });
  try {
    const reader = holder.stdout.getReader();
    const ready = await Promise.race([reader.read(), Bun.sleep(5_000).then(() => { throw new Error('lock holder never acquired lock'); })]);
    expect(new TextDecoder().decode(ready.value)).toContain('locked');
    expect(existsSync(journal)).toBe(false);
  } finally {
    holder.kill('SIGKILL');
    await holder.exited;
  }
  const results = checkLoops([{ ...base, id: 'recovered', owner: 'MK',
    recentStatuses: ['failed', 'failed', 'failed'], lastRunAt: '2026-10-04T11:59:00Z' }], now);
  expect(notifyOwners(results, { root: dir, now })).toBe(1);
  expect(notifyOwners(results, { root: dir, now })).toBe(0);
  expect(readFileSync(journal, 'utf8').trim().split('\n')).toHaveLength(1);
});

test('registry adapter measures consecutive cron fires, supports future unified registry', () => {
  const loop = graphLoop();
  const graph = entriesFromRegistry({ listLoops: () => [loop], statusForLoop: () => ({ recentRuns: [{ status: 'done' }] }), now });
  expect(graph).toMatchObject({ scope: 'graph-only', entries: [{ expectEveryMinutes: 10, registered: true, recentStatuses: ['done'] }] });
  expect(checkLoops(graph.entries, now)[0]?.state).toBe('late');
  expect(entriesFromRegistry({ listLoops: () => [loop], now }).entries[0]?.recentStatuses).toEqual(['done']);
  const unified = entriesFromRegistry({ listLoops: () => { throw Error('graph fallback called'); }, listAllLoops: () => entries });
  expect(unified.scope).toBe('registry');
  expect(unified.entries).toEqual(entries);
});

test('registry adapter does not confuse a listed graph without cron jobs with an unregistered loop', () => {
  const dir = root();
  mkdirSync(join(dir, 'graphs'), { recursive: true });
  writeFileSync(join(dir, 'graphs', 'waiting.yaml'), `graph_id: waiting
version: 1
loop:
  trigger:
    cron: '*/10 * * * *'
entry_node: step
terminal_nodes: [done]
nodes:
  - { node_id: step, kind: agent, recipe: 'cmd:step', max_visits: 1 }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: step, to: done }
`);
  const listed = listLoops({ root: dir, stateRoot: dir, schedules: [], now });
  expect(listed).toHaveLength(1);
  expect(listed[0]?.jobs).toEqual([]);
  const adapted = entriesFromRegistry({ listLoops: () => listed, now });
  expect(adapted).toMatchObject({ scope: 'graph-only', entries: [{ id: 'waiting', registered: true }] });
  expect(checkLoops(adapted.entries, now)[0]?.state).not.toBe('unregistered');
});

test('CLI status --all --json uses graph-only fallback and never queues unless --notify', async () => {
  const dir = root();
  const loop = { ...graphLoop(), id: 'graph' };
  const program = new Command();
  registerLoopCommands(program, { root: dir, now, listLoops: () => [loop], statusForLoop: () => ({ recentRuns: [{ status: 'done' }] }) });
  const captured: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
    captured.push(String(chunk));
    callback?.();
    return true;
  }) as typeof process.stdout.write;
  try { await program.parseAsync(['loop', 'status', '--all', '--json'], { from: 'user' }); }
  finally { process.stdout.write = original; }
  const output = JSON.parse(captured.join(''));
  expect(output).toMatchObject({ scope: 'graph-only', counts: { alive: 0, late: 1, failing: 0, off: 0, unregistered: 0, unknown: 0 },
    results: [{ id: 'graph', state: 'late', expectEveryMinutes: 10 }] });
  expect(existsSync(join(dir, 'seat-requests', 'requests.jsonl'))).toBe(false);
  expect(existsSync(join(dir, 'loop', 'checker', 'last.json'))).toBe(true);
});

test('CLI JSON does not claim a recorded unscheduled loop is alive', async () => {
  const dir = root();
  const program = new Command();
  registerLoopCommands(program, { root: dir, now, listAllLoops: () => [
    { ...base, id: 'no-cadence', lastRunAt: '2026-10-04T11:55:00Z' },
  ] });
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
    chunks.push(String(chunk)); callback?.(); return true;
  }) as typeof process.stdout.write;
  try { await program.parseAsync(['loop', 'status', '--all', '--json'], { from: 'user' }); }
  finally { process.stdout.write = original; }
  expect(JSON.parse(chunks.join(''))).toMatchObject({ scope: 'registry', counts: { unknown: 1, alive: 0 },
    results: [{ id: 'no-cadence', state: 'unknown', reason: 'expected interval unknown' }] });
  expect(existsSync(join(dir, 'seat-requests', 'requests.jsonl'))).toBe(false);
});

test('CLI --notify writes only owner alerts from unified registry and displays the six-state table', async () => {
  const dir = root();
  const program = new Command();
  registerLoopCommands(program, { root: dir, now, listAllLoops: () => entries });
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try { await program.parseAsync(['loop', 'status', '--all', '--notify'], { from: 'user' }); }
  finally { console.log = original; }
  expect(lines[0]).toBe('id\tstate\tlast run\texpected interval\towner\treason');
  expect(lines.at(-1)).toBe('alive 1 · late 1 · failing 1 · off 1 · unregistered 1 · unknown 1 · scope registry');
  const path = join(dir, 'seat-requests', 'requests.jsonl');
  expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
  console.log = () => {};
  try { await program.parseAsync(['loop', 'status', '--all', '--notify'], { from: 'user' }); }
  finally { console.log = original; }
  expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
});

test('state change is persisted for subsequent comparisons; unchanged state is stable', () => {
  const dir = root();
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    observeLoopCheck(checkLoops(entries, now), 'graph-only', { root: dir });
    const path = join(dir, 'loop', 'checker', 'last.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ slow: 'late', healthy: 'alive' });
    observeLoopCheck(checkLoops([{ ...entries[3]!, lastRunAt: '2026-10-04T11:58:00Z' }], now), 'registry', { root: dir });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ slow: 'alive' });
    expect(log).toHaveBeenCalledWith('loop.checker', 'checked', { counts: expect.objectContaining({ alive: 1 }), scope: 'registry' });
    expect(log).toHaveBeenCalledWith('loop.checker', 'state-change', { id: 'slow', from: 'late', to: 'alive' });
  } finally { log.mockRestore(); }
});

// Review must-fix (round 3): lateness follows the real schedule — overnight and weekend gaps are not «late».
test('schedule gaps are not lateness: overnight */15 8-23 and weekday 09:00 (KST)', () => {
  const tz = 'Asia/Seoul';
  // Steward-like */15 8-23: at 07:00 KST the last fire was 23:45 the day before.
  const morning = new Date('2026-10-04T22:00:00Z'); // 07:00 KST Mon 10-05
  expect(dueBefore('*/15 8-23 * * *', morning, tz)).toBe('2026-10-04T14:30:00.000Z'); // 23:30 KST
  const steward = (lastRunAt: string) => checkLoops([{ id: 'steward', enabled: true, registered: true, lastRunAt,
    dueAt: dueBefore('*/15 8-23 * * *', morning, tz)!, recentStatuses: ['done'] }], morning)[0]!.state;
  expect(steward('2026-10-04T14:45:00Z')).toBe('alive'); // ran at 23:45 KST
  expect(steward('2026-10-04T14:00:00Z')).toBe('late');  // last run 23:00 KST → missed 23:30 and 23:45
  // Weekday 09:00: on Monday 08:00 KST the latest fire is Friday 09:00.
  const monday = new Date('2026-10-04T23:00:00Z'); // 08:00 KST Mon 10-05
  const weekday = (lastRunAt: string) => checkLoops([{ id: 'weekday', enabled: true, registered: true, lastRunAt,
    dueAt: dueBefore('0 9 * * 1-5', monday, tz)!, recentStatuses: ['done'] }], monday)[0]!.state;
  expect(weekday('2026-10-02T00:00:00Z')).toBe('alive'); // Friday 09:00 KST ran
  expect(weekday('2026-10-01T00:00:00Z')).toBe('alive'); // Thursday ran, Friday missed: one miss is not yet late
  expect(weekday('2026-09-30T00:00:00Z')).toBe('late');  // Wednesday was the last: Thursday and Friday missed
  expect(previousLoopFire('0 9 * * 1-5', monday, tz)).toBe('2026-10-02T00:00:00.000Z');
});
