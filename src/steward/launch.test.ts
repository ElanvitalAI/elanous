import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectOutcomes, launch, planLaunches, raiseHitl, readLaunchLedger, type LaunchDeps } from './launch.js';
import type { ScheduledDecision, TriageIssue } from './triage.js';

const runId = 'run-12345678-1234-1234-1234-123456789abc';
const issues: TriageIssue[] = Array.from({ length: 5 }, (_, n) => ({ identifier: `ELA-${n + 1}`, ref: `ref-${n + 1}`, title: `Build ${n + 1}`, body: `Body ${n + 1}\n출처: telegram` }));
const rows: ScheduledDecision[] = issues.map((issue, n) => ({ issue: issue.identifier, rung: 4, dependsOn: [], priority: n, why: 'build', disposition: 'now' }));
const root = () => mkdtempSync(join(tmpdir(), 'steward-launch-'));

test('shadow records the exact command once without calling budget, decisions or spawn', () => {
  const dir = root();
  try {
    const ledger = readLaunchLedger(dir);
    const settings = { launch: 'shadow' as const, maxParallel: 3 };
    const planned = planLaunches(rows, issues, ledger, settings);
    expect(planned.launches).toHaveLength(3);
    const deps: LaunchDeps = { root: dir, settings, ledger, command: () => { throw new Error('no command'); }, spawn: () => { throw new Error('no spawn'); } };
    const entry = launch(planned.launches[0]!, deps);
    expect(entry.status).toBe('shadow');
    expect(entry.command).toContain('--substrate');
    expect(entry.command).toContain('pool-node-b@node-b:8');
    expect(entry.command).toContain('"Build 1\\nBody 1');
    expect(readLaunchLedger(dir).launches['ELA-1']).toEqual(entry);
    expect(planLaunches(rows, issues, ledger, settings).launches.map(item => item.issue.identifier)).toEqual(['ELA-2', 'ELA-3', 'ELA-4']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shadow simulation can become one live launch after switching mode, but not launch twice', () => {
  const dir = root();
  try {
    const ledger = readLaunchLedger(dir);
    const shadow = { launch: 'shadow' as const };
    const item = planLaunches(rows.slice(0, 1), issues, ledger, shadow).launches[0]!;
    launch(item, { root: dir, ledger, settings: shadow, command: () => { throw new Error('shadow called command'); }, spawn: () => { throw new Error('shadow spawned'); } });
    const live = { launch: 'live' as const };
    expect(planLaunches(rows.slice(0, 1), issues, readLaunchLedger(dir), live).launches).toHaveLength(1);
    let spawned = 0;
    launch(planLaunches(rows.slice(0, 1), issues, ledger, live).launches[0]!, { root: dir, ledger, settings: live,
      command: () => ({ exitCode: 0, stdout: '{"outcome":"proceed","reasons":[]}' }),
      spawn: (_args, log) => { spawned++; writeFileSync(log, `starting ${runId}`); return { pid: 99999999 }; },
    });
    expect(spawned).toBe(1);
    expect(ledger.launches['ELA-1']?.status).toBe('launched');
    expect(planLaunches(rows.slice(0, 1), issues, readLaunchLedger(dir), live).launches).toHaveLength(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('live launches only three of five; two completed slots release the remaining two', () => {
  const dir = root();
  try {
    const ledger = readLaunchLedger(dir);
    const settings = { launch: 'live' as const, maxParallel: 3, podPool: 'test-pool' };
    let spawned = 0;
    const deps: LaunchDeps = { root: dir, settings, ledger,
      command: args => args.includes('budget') ? { exitCode: 0, stdout: '{"outcome":"proceed","reasons":[]}' } : { exitCode: 0, stdout: '{"event":"run-status","data":{"runStatus":"completed"}}\n' },
      spawn: (args, log) => { spawned++; expect(args).toContain('test-pool'); writeFileSync(log, `started ${runId.slice(0, -1)}${spawned}`); return { pid: 99999999 }; } };
    for (const item of planLaunches(rows, issues, ledger, settings).launches) launch(item, deps);
    expect(spawned).toBe(3);
    expect(planLaunches(rows, issues, ledger, settings).launches).toHaveLength(0);
    deps.command = args => args.includes('budget') ? { exitCode: 0, stdout: '{"outcome":"proceed","reasons":[]}' }
      : args.includes(ledger.launches['ELA-1']!.runId!) ? { exitCode: 0, stdout: '{"event":"merged","data":{"number":42,"merged":true}}' }
      : args.includes(ledger.launches['ELA-2']!.runId!) ? { exitCode: 0, stdout: '{"event":"run-status","data":{"runStatus":"failed"}}' }
      : { exitCode: 0, stdout: '{"event":"start","data":{}}' };
    expect(collectOutcomes(ledger, deps).map(entry => entry.status)).toEqual(['merged', 'failed']);
    expect(planLaunches(rows, issues, ledger, settings).launches.map(item => item.issue.identifier)).toEqual(['ELA-4', 'ELA-5']);
    expect(readFileSync(join(dir, 'steward', 'launches.json'), 'utf8')).toContain(runId.slice(0, -1));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shadow outcome collection never calls a process even with an old live run in the ledger', () => {
  const dir = root();
  try {
    const ledger = readLaunchLedger(dir);
    ledger.launches['ELA-1'] = { issue: 'ELA-1', title: 'Build', source: 'cli', command: 'say', status: 'launched', runId };
    expect(collectOutcomes(ledger, { root: dir, ledger, settings: { launch: 'shadow' }, command: () => { throw new Error('process called'); } })).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('off mode neither plans nor raises HITL or launches work', () => {
  const ledger = { launches: {}, hitl: {} };
  expect(planLaunches([rows[0]!, { ...rows[1]!, rung: 'hitl', disposition: 'hitl' }], issues, ledger, { launch: 'off' })).toMatchObject({ launches: [], hitl: [] });
});

test('shadow HITL records only a handoff; first live cycle raises once and later cycles do not', () => {
  const dir = root();
  try {
    const ledger = readLaunchLedger(dir);
    const hitl = { ...rows[0]!, rung: 'hitl' as const, hitlReason: 'money' as const, disposition: 'hitl' as const };
    const issue = issues[0]!;
    const shadow = { launch: 'shadow' as const };
    let calls = 0;
    const command = () => { calls++; return { exitCode: 0, stdout: '{}' }; };
    expect(planLaunches([hitl], [issue], ledger, shadow).hitl).toHaveLength(1);
    raiseHitl(issue, hitl, { root: dir, ledger, settings: shadow, command });
    expect(calls).toBe(0);
    const live = { launch: 'live' as const };
    expect(planLaunches([hitl], [issue], ledger, live).hitl).toHaveLength(1);
    expect(raiseHitl(issue, hitl, { root: dir, ledger, settings: live, command }).raised).toBe(true);
    expect(planLaunches([hitl], [issue], ledger, live).hitl).toHaveLength(0);
    expect(calls).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HITL never launches; decisions raise is attempted exactly once, including when unavailable', () => {
  const dir = root();
  try {
    const ledger = readLaunchLedger(dir);
    const settings = { launch: 'live' as const };
    const hitl = { ...rows[0]!, disposition: 'hitl' as const, rung: 'hitl' as const, hitlReason: 'money' as const };
    const issue = issues[0]!;
    expect(planLaunches([hitl], [issue], ledger, settings).launches).toHaveLength(0);
    let calls = 0;
    const deps: LaunchDeps = { root: dir, settings, ledger, command: args => { calls++; expect(args).toContain('raise'); expect(args.slice(args.indexOf('--category') + 1)[0]).toBe('money'); return { exitCode: 1, stdout: '' }; }, spawn: () => { throw new Error('HITL spawned'); } };
    expect(raiseHitl(issue, hitl, deps).raised).toBe(false);
    expect(raiseHitl(issue, hitl, deps).raised).toBe(false);
    expect(calls).toBe(1);
    expect(readLaunchLedger(dir).hitl['ELA-1']?.reason).toBe('money');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed decisions command leaves only a HITL card handoff on the next schedule', () => {
  const dir = root();
  try {
    const ledger = readLaunchLedger(dir);
    const hitl = { ...rows[0]!, rung: 'hitl' as const, hitlReason: 'security' as const, disposition: 'hitl' as const };
    const deps: LaunchDeps = { root: dir, ledger, settings: { launch: 'live' }, command: () => { throw new Error('decisions unavailable'); } };
    const plan = planLaunches([hitl], issues, ledger, deps.settings);
    expect(plan.launches).toHaveLength(0);
    expect(raiseHitl(issues[0]!, hitl, deps).raised).toBe(false);
    expect(readLaunchLedger(dir).hitl['ELA-1']).toBeDefined();
    expect(planLaunches([hitl], issues, ledger, deps.settings).hitl).toHaveLength(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('blocked budget records reason and does not spawn; next cycle can retry', () => {
  const dir = root();
  try {
    const ledger = readLaunchLedger(dir);
    const settings = { launch: 'live' as const };
    const deps: LaunchDeps = { root: dir, ledger, settings, command: () => ({ exitCode: 0, stdout: '{"outcome":"wait-reset","reasons":["quota"]}' }), spawn: () => { throw new Error('budget bypassed'); } };
    const result = launch(planLaunches(rows.slice(0, 1), issues, ledger, settings).launches[0]!, deps);
    expect(result.status).toBe('skipped-budget');
    expect(result.reason).toContain('quota');
    expect(readLaunchLedger(dir).launches['ELA-1']?.status).toBe('skipped-budget');
    expect(planLaunches(rows.slice(0, 1), issues, ledger, settings).launches).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('latest failed terminal overrides an earlier merged observation', () => {
  const dir = root();
  try {
    const ledger = readLaunchLedger(dir);
    ledger.launches['ELA-1'] = { issue: 'ELA-1', title: 'Build', source: 'cli', command: 'say', status: 'running', runId };
    const deps: LaunchDeps = { root: dir, ledger, settings: { launch: 'live' }, command: () => ({ exitCode: 0,
      stdout: '{"event":"merged","data":{"number":3,"merged":true}}\n{"event":"run-status","data":{"runStatus":"failed"}}' }) };
    expect(collectOutcomes(ledger, deps).map(entry => entry.status)).toEqual(['failed']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a later merged event takes precedence over an earlier failed terminal', () => {
  const dir = root();
  try {
    const ledger = readLaunchLedger(dir);
    ledger.launches['ELA-1'] = { issue: 'ELA-1', title: 'Build', source: 'cli', command: 'say', status: 'running', runId };
    const deps: LaunchDeps = { root: dir, ledger, settings: { launch: 'live' }, command: () => ({ exitCode: 0,
      stdout: '{"event":"run-status","data":{"runStatus":"failed"}}\n{"event":"merged","data":{"number":3,"merged":true}}' }) };
    expect(collectOutcomes(ledger, deps).map(entry => entry.status)).toEqual(['merged']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('late log runId is collected on a subsequent report', () => {
  const dir = root();
  try {
    const ledger = readLaunchLedger(dir);
    const log = join(dir, 'late.log');
    ledger.launches['ELA-1'] = { issue: 'ELA-1', title: 'Build', source: 'cli', command: 'say', status: 'launched', log, pid: 99999999 };
    writeFileSync(log, `started ${runId}`);
    const deps: LaunchDeps = { root: dir, ledger, settings: { launch: 'live' }, command: () => ({ exitCode: 0, stdout: '{"event":"merged","data":{"number":3,"merged":true}}' }) };
    expect(collectOutcomes(ledger, deps).map(entry => [entry.runId, entry.status])).toEqual([[runId, 'merged']]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('completed run with an open PR waits for merge, then reports its landing once', () => {
  const dir = root();
  try {
    const ledger = readLaunchLedger(dir);
    ledger.launches['ELA-1'] = { issue: 'ELA-1', title: 'Build', source: 'cli', command: 'say', status: 'launched', runId, pid: 99999999 };
    const events: Array<{ event: string; data: { number?: number; runStatus?: string; merged?: boolean } }> = [
      { event: 'pr-opened', data: { number: 9 } },
      { event: 'run-status', data: { runStatus: 'completed' } },
    ];
    const deps: LaunchDeps = { root: dir, ledger, settings: { launch: 'live' }, command: () => ({ exitCode: 0, stdout: events.map(event => JSON.stringify(event)).join('\n') }) };
    expect(collectOutcomes(ledger, deps)).toEqual([]);
    expect(readLaunchLedger(dir).launches['ELA-1']).toMatchObject({ status: 'running', awaitingMerge: true, prNumber: 9 });
    expect(planLaunches(rows, issues, ledger, { launch: 'live', maxParallel: 1 }).launches.map(item => item.issue.identifier)).toEqual(['ELA-2']);
    expect(collectOutcomes(ledger, deps)).toEqual([]);
    events.push({ event: 'merged', data: { number: 9, merged: true } });
    const done = collectOutcomes(ledger, deps);
    expect(done.map(entry => [entry.status, entry.prNumber])).toEqual([['merged', 9]]);
    done[0]!.reported = true;
    expect(collectOutcomes(ledger, deps)).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an opened PR with a definitive failed terminal is reported as failed', () => {
  const dir = root();
  try {
    const ledger = readLaunchLedger(dir);
    ledger.launches['ELA-1'] = { issue: 'ELA-1', title: 'Build', source: 'cli', command: 'say', status: 'launched', runId, pid: 99999999 };
    const deps: LaunchDeps = { root: dir, ledger, settings: { launch: 'live' }, command: () => ({ exitCode: 0,
      stdout: '{"event":"pr-opened","data":{"number":9}}\n{"event":"run-status","data":{"runStatus":"failed"}}' }) };
    expect(collectOutcomes(ledger, deps).map(entry => [entry.status, entry.prNumber])).toEqual([['failed', 9]]);
    expect(ledger.launches['ELA-1']?.awaitingMerge).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('completed run without an opened PR is `completed` — neither a claimed landing nor a failure', () => {
  const dir = root();
  try {
    const ledger = readLaunchLedger(dir);
    ledger.launches['ELA-1'] = { issue: 'ELA-1', title: 'Build', source: 'cli', command: 'say', status: 'launched', runId, pid: 99999999 };
    const deps: LaunchDeps = { root: dir, ledger, settings: { launch: 'live' }, command: () => ({ exitCode: 0, stdout: '{"event":"run-status","data":{"runStatus":"completed"}}' }) };
    expect(collectOutcomes(ledger, deps).map(entry => entry.status)).toEqual(['completed']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a temporarily unavailable run ledger is not misreported as a failed landing', () => {
  const dir = root();
  try {
    const ledger = readLaunchLedger(dir);
    ledger.launches['ELA-1'] = { issue: 'ELA-1', title: 'Build', source: 'cli', command: 'say', status: 'launched', runId, pid: 99999999 };
    const deps: LaunchDeps = { root: dir, ledger, settings: { launch: 'live' }, command: () => ({ exitCode: 1, stdout: '', stderr: 'ledger not yet available' }) };
    expect(collectOutcomes(ledger, deps)).toEqual([]);
    expect(ledger.launches['ELA-1']?.status).toBe('running');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an exited child with no runId is a failed launch, never silently occupies a slot forever', () => {
  const dir = root();
  try {
    const ledger = readLaunchLedger(dir);
    ledger.launches['ELA-1'] = { issue: 'ELA-1', title: 'Build', source: 'cli', command: 'say', status: 'launched', pid: 99999999, log: join(dir, 'missing.log') };
    const deps: LaunchDeps = { root: dir, ledger, settings: { launch: 'live' }, command: () => { throw new Error('no runId to inspect'); } };
    expect(collectOutcomes(ledger, deps).map(entry => entry.status)).toEqual(['failed']);
    expect(ledger.launches['ELA-1']?.status).toBe('failed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('run ledger JSONL merged, failed and running are distinguished and reported once', () => {
  const dir = root();
  try {
    const ledger = readLaunchLedger(dir);
    const settings = { launch: 'live' as const };
    for (const [index, issue] of issues.slice(0, 3).entries()) ledger.launches[issue.identifier] = {
      issue: issue.identifier, title: issue.title, source: 'telegram', status: 'launched', command: 'say', runId: `${runId.slice(0, -1)}${index}`, pid: 99999999,
    };
    const deps: LaunchDeps = { root: dir, settings, ledger, command: args => {
      const index = Number(args.find(arg => /^run-[0-9a-f]{8}-/.test(arg))?.at(-1));
      const events = index === 0 ? [{ event: 'pr-opened', data: { number: 42 } }, { event: 'merged', data: { number: 42, merged: true } }, { event: 'run-status', data: { runStatus: 'completed' } }]
        : index === 1 ? [{ event: 'run-status', data: { runStatus: 'failed' } }] : [{ event: 'start', data: {} }];
      return { exitCode: 0, stdout: events.map(event => JSON.stringify(event)).join('\n') };
    } };
    const done = collectOutcomes(ledger, deps);
    expect(done.map(item => [item.status, item.prNumber ?? null])).toEqual([['merged', 42], ['failed', null]]);
    for (const entry of done) entry.reported = true;
    expect(collectOutcomes(ledger, deps)).toHaveLength(0);
    expect(ledger.launches['ELA-3']?.status).toBe('running');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no launch setting means shadow: nothing is spawned and no command runs', () => {
  const dir = root();
  try {
    const ledger = readLaunchLedger(dir);
    const settings = {};
    const deps: LaunchDeps = { root: dir, settings, ledger, command: () => { throw new Error('default ran a command'); }, spawn: () => { throw new Error('default spawned'); } };
    for (const item of planLaunches(rows, issues, ledger, settings).launches) expect(launch(item, deps).status).toBe('shadow');
    expect(collectOutcomes(ledger, deps)).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the sentence goes after `--`, so a title starting with a dash is not read as an option', () => {
  const dir = root();
  try {
    const ledger = readLaunchLedger(dir);
    const dashed: TriageIssue[] = [{ identifier: 'ELA-9', ref: 'ref-9', title: '--base evil', body: 'b' }];
    const settings = { launch: 'live' as const };
    let argv: string[] = [];
    launch(planLaunches([{ ...rows[0]!, issue: 'ELA-9' }], dashed, ledger, settings).launches[0]!, { root: dir, ledger, settings,
      command: () => ({ exitCode: 0, stdout: '{"outcome":"next-provider","reasons":[]}' }),
      spawn: args => { argv = args; return { pid: 99999999 }; } });
    const sep = argv.indexOf('--');
    expect(sep).toBeGreaterThan(argv.indexOf('--json'));
    expect(argv[sep + 1]).toBe('--base evil\nb');
    expect(argv.filter(arg => arg === '--base')).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
