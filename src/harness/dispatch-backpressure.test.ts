import { describe, expect, test } from 'bun:test';
import { BUILD_SLOW, BUILD_STOP, QUEUE_SLOW, QUEUE_STOP, UNKNOWN_CAP, decideBackpressure, readBackpressureSignals, type BackpressureSignals, type BackpressureReadDeps } from './dispatch-backpressure.js';
import { Command } from 'commander';
import { debug } from '../debug/log.js';
import { installHarnessCliCommand } from './harness-cli-command.js';
import { renderLogJsonLine, limitReachedJsonMeta } from '../cli/logs-cli.js';

const NOW = Date.parse('2026-10-10T00:00:00Z');
const admission = (minutesAgo: number, runId: string, recommended: number) => ({
  ts_ms: NOW - minutesAgo * 60_000, data: JSON.stringify({ runId, recommended }),
});
const observed = (more: BackpressureReadDeps = {}): BackpressureReadDeps => ({
  now: () => NOW, queue: () => [{ status: 'queued' }, { status: 'launching' }, { status: 'finished' }],
  podRecommended: () => 9, logs: () => [], ps: () => 'docker build .\ndocker buildx build .\ndocker ps\n',
  currentVersion: () => 'current-v', parentHost: () => null, ...more,
});

const roomy = (): BackpressureSignals => ({ queueDepth: 0, admitWaiting: 2, admitStarvedOver30m: 0,
  dockerBuilds: { local: 0, remote: 1 }, podRecommended: 5, staleParents: 3 });

describe('dispatch backpressure decision', () => {
  test('fixed thresholds and pod headroom with stale parents only as an observation', () => {
    expect([BUILD_STOP, BUILD_SLOW, QUEUE_STOP, QUEUE_SLOW, UNKNOWN_CAP]).toEqual([4, 2, 8, 4, 1]);
    const result = decideBackpressure(roomy(), { maxPerCycle: 6 });
    expect(result.launchBudget).toBe(3);
    expect(result.reasons).toContain('podRecommended−admitWaiting');
    expect(result.reasons).toContain('stale-parents:3');
  });
  test('starvation and remote build storm both stop launches despite pod capacity', () => {
    const result = decideBackpressure({ ...roomy(), admitStarvedOver30m: 1, podRecommended: 27,
      dockerBuilds: { local: 0, remote: 12 } });
    expect(result.launchBudget).toBe(0);
    expect(result.reasons).toEqual(expect.arrayContaining(['admit-starved', 'docker-builds']));
  });
  test('slow and stop thresholds combine by minimum, with default max 6', () => {
    expect(decideBackpressure({ ...roomy(), admitWaiting: 0, podRecommended: 30, staleParents: 0,
      dockerBuilds: { local: 2, remote: 0 } }).launchBudget).toBe(3);
    expect(decideBackpressure({ ...roomy(), admitWaiting: 0, podRecommended: 30, staleParents: 0,
      queueDepth: 4 }).launchBudget).toBe(3);
    expect(decideBackpressure({ ...roomy(), queueDepth: 8 }).launchBudget).toBe(0);
    expect(decideBackpressure({ ...roomy(), dockerBuilds: { local: 2, remote: 2 }, podRecommended: 30, admitWaiting: 0 }).launchBudget).toBe(0);
    expect(decideBackpressure({ ...roomy(), podRecommended: 0, dockerBuilds: { local: 0, remote: 0 } }).launchBudget).toBe(0);
  });
  test('invalid values become named unknowns; a measured stop still wins', () => {
    const input = { ...roomy(), queueDepth: NaN, admitWaiting: -1, podRecommended: undefined,
      dockerBuilds: { local: 0.5, remote: 0 }, staleParents: -2 } as unknown as BackpressureSignals;
    const result = decideBackpressure(input);
    expect(result.launchBudget).toBe(1);
    expect(result.reasons).toEqual(expect.arrayContaining(['unknown:queueDepth', 'unknown:admitWaiting',
      'unknown:podRecommended', 'unknown:dockerBuilds.local', 'unknown:staleParents']));
    expect(JSON.stringify(result)).not.toContain('NaN');
    expect(decideBackpressure({ ...input, admitStarvedOver30m: 1 }).launchBudget).toBe(0);
    // Measured saturation on one side wins over an unknown other side.
    const halfKnownBuilds = decideBackpressure({ ...roomy(), dockerBuilds: { local: 4, remote: 'unknown' } });
    expect(halfKnownBuilds.launchBudget).toBe(0);
    expect(halfKnownBuilds.reasons).toEqual(expect.arrayContaining(['docker-builds', 'unknown:dockerBuilds.remote']));
    const zeroPodUnknownWait = decideBackpressure({ ...roomy(), podRecommended: 0, admitWaiting: 'unknown' });
    expect(zeroPodUnknownWait.launchBudget).toBe(0);
    expect(zeroPodUnknownWait.reasons).toEqual(expect.arrayContaining(['podRecommended−admitWaiting', 'unknown:admitWaiting']));
    expect(decideBackpressure({ ...roomy(), dockerBuilds: { local: 'unknown', remote: 0 } }).launchBudget).toBe(1);
    const huge = decideBackpressure({ ...roomy(), dockerBuilds: { local: Number.MAX_SAFE_INTEGER, remote: 1 } });
    expect(huge.launchBudget).toBe(0);
    expect(huge.reasons).toContain('docker-builds');
    expect(decideBackpressure({ ...roomy(), queueDepth: 0, admitWaiting: 0, podRecommended: 50 }, { maxPerCycle: 3 }).launchBudget).toBe(3);
  });
});

describe('read-only backpressure signals', () => {
  test('queue states, builds, current link version and no remote host', () => {
    const signals = readBackpressureSignals(observed({ ps: () => [
      'bun /home/u/.local/share/elanous/versions/old-v/bin/elanous.mjs harness say x',
      'bun /home/u/.local/share/elanous/versions/current-v/bin/elanous.mjs harness ask x',
      'docker build .', 'docker buildx build .', 'docker ps',
    ].join('\n') }));
    expect(signals).toEqual({ queueDepth: 2, admitWaiting: 0, admitStarvedOver30m: 0,
      dockerBuilds: { local: 2, remote: 0 }, podRecommended: 9, staleParents: 1 });
  });
  test('last zero within five minutes, first continuous zero older than 30; query scope and limit', () => {
    let query: unknown;
    const signals = readBackpressureSignals(observed({ logs: (q) => { query = q; return [
      admission(34, 'run-a', 0), admission(3, 'run-a', 0), admission(32, 'run-b', 0),
      admission(2, 'run-b', 3), admission(6, 'run-c', 0), admission(10, 'run-d', 3),
      admission(31, 'run-d', 0), admission(1, 'run-d', 0),
    ]; } }));
    expect(query).toEqual({ exactCategories: ['pod-lease'], events: ['admit-by-usage'], sinceMs: NOW - 35 * 60_000, limit: 1000 });
    expect(signals.admitWaiting).toBe(2);
    // run-a starved (34→3 all zero); run-d recovered at 10 min (recommended 3) so its streak restarted at 1 min.
    expect(signals.admitStarvedOver30m).toBe(1);
    expect(readBackpressureSignals(observed({ logs: () => Array.from({ length: 1000 }, () => admission(1, 'run-x', 0)) })).admitWaiting).toBe('unknown');
    expect(readBackpressureSignals(observed({ logs: () => [{ ts_ms: NOW, data: '{bad-json' }] })).admitWaiting).toBe('unknown');
    expect(readBackpressureSignals(observed({ queue: () => [{ status: 'mystery' }] })).queueDepth).toBe('unknown');
  });
  test('rows without runId or with null recommendation are not parent waits (not unknown)', () => {
    const signals = readBackpressureSignals(observed({ logs: () => [
      { ts_ms: NOW - 60_000, data: JSON.stringify({ recommended: 0, limitedBy: 'memory' }) },
      { ts_ms: NOW - 60_000, data: JSON.stringify({ runId: 'run-n', recommended: null, limitedBy: null }) },
      admission(31, 'run-z', 0), admission(1, 'run-z', 0),
    ] }));
    expect(signals.admitWaiting).toBe(1);
    expect(signals.admitStarvedOver30m).toBe(1);
  });
  test('builds count docker client processes only, once each, and skip rail-labelled bakes', () => {
    const signals = readBackpressureSignals(observed({ ps: () => [
      'bash -c DOCKER_CONFIG=~/.docker-fleet docker build -q --label elanous.commit=abc -t img - >/dev/null',
      'docker build -q --label elanous.commit=abc -t img -',
      '/usr/local/bin/docker buildx build --label elanous.builder=launch .',
      '/usr/libexec/docker/cli-plugins/docker-buildx buildx build --label elanous.builder=launch .',
      'docker build --label elanous.builder=rail -t rail .',
      'vim notes-about-docker build',
    ].join('\n') }));
    expect(signals.dockerBuilds.local).toBe(2);
  });
  test('remote logs and ps ride one ssh with timeout; errors and saturated logs remain unknown', () => {
    const calls: unknown[] = [];
    const remote = observed({ parentHost: () => ({ host: 'node-b' }), ssh: (host, script, timeout) => {
      calls.push({ host, script, timeout });
      return { status: 0, stderr: '', stdout: `${JSON.stringify({ _meta: 'opened-stores' })}\n${JSON.stringify({ category: 'pod-lease', event: 'admit-by-usage', ...admission(33, 'run-r', 0) })}\n${JSON.stringify({ category: 'pod-lease', event: 'admit-by-usage', ...admission(1, 'run-r', 0) })}\n__ELANOUS_BACKPRESSURE_PS__\ndocker buildx build .\n` };
    } });
    const signals = readBackpressureSignals(remote);
    expect(signals.admitWaiting).toBe(1);
    expect(signals.admitStarvedOver30m).toBe(1);
    expect(signals.dockerBuilds.remote).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ host: 'node-b', timeout: 15_000 });
    expect(JSON.stringify(calls[0])).toContain('logs --event admit-by-usage --since 35m --json --limit 1000');
    expect(JSON.stringify(calls[0])).toContain('ps -Ao command');
    for (const output of [null, `${JSON.stringify({ _meta: { type: 'log-query-limit', limitReached: true } })}\n__ELANOUS_BACKPRESSURE_PS__\nPID COMMAND\n`]) {
      const failed = readBackpressureSignals(observed({ parentHost: () => ({ host: 'node-b' }), ssh: () =>
        output === null ? { status: null, stdout: '', stderr: 'timeout' } : { status: 0, stdout: output, stderr: '' } }));
      expect(failed.unmeasured).toContain('admitWaiting.remote');
      expect(failed.dockerBuilds.remote).toBe('unknown');
    }
  });
  test('multiple remote hosts aggregate measured signals and retain unknown partials', () => {
    const calls: string[] = [];
    const read = (failed: boolean) => readBackpressureSignals(observed({ parentHost: () => [{ host: 'node-b' }, { host: 'node-c' }], ssh: (host) => {
      calls.push(host);
      if (failed && host === 'node-c') return { status: 255, stdout: '', stderr: 'timeout' };
      return { status: 0, stderr: '', stdout: `${JSON.stringify({ category: 'pod-lease', event: 'admit-by-usage', ...admission(1, `run-${host}`, 0) })}\n__ELANOUS_BACKPRESSURE_PS__\ndocker build .\n` };
    } }));
    const all = read(false);
    expect(calls).toEqual(['node-b', 'node-c']);
    expect([all.admitWaiting, all.dockerBuilds.remote]).toEqual([2, 2]);
    const partial = read(true);
    expect(partial.admitWaiting).toBe(1);
    expect(partial.unmeasured).toContain('admitWaiting.remote');
    expect(partial.dockerBuilds.remote).toBe('unknown');
  });
  test('remote output in the real `elanous logs --json` line format parses', () => {
    const real = (minutesAgo: number, runId: string, recommended: number, id: number) => renderLogJsonLine({
      id, ts: new Date(NOW - minutesAgo * 60_000).toISOString(), ts_ms: NOW - minutesAgo * 60_000, level: 'debug',
      instance: 'default', surface: 'cli', category: 'pod-lease', event: 'admit-by-usage', session_id: null, trace_id: null,
      data: JSON.stringify({ samples: 3, recommended, limitedBy: 'memory', runId }),
    }, 'default', false, '/home/u/.elanous/logs.db');
    const lines = [real(32, 'run-q', 0, 1), real(2, 'run-q', 0, 2)];
    const ok = readBackpressureSignals(observed({ parentHost: () => ({ host: 'node-b' }), ssh: () => ({ status: 0, stderr: '',
      stdout: `${lines.join('\n')}\n__ELANOUS_BACKPRESSURE_PS__\nPID COMMAND\n` }) }));
    expect(ok.admitWaiting).toBe(1);
    expect(ok.admitStarvedOver30m).toBe(1);
    expect(ok.dockerBuilds.remote).toBe(0);
    const meta = limitReachedJsonMeta(1000, 1000, 1000, 1);
    expect(meta).not.toBeNull();
    const capped = readBackpressureSignals(observed({ parentHost: () => ({ host: 'node-b' }), ssh: () => ({ status: 0, stderr: '',
      stdout: `${lines.join('\n')}\n${JSON.stringify(meta)}\n__ELANOUS_BACKPRESSURE_PS__\nPID COMMAND\n` }) }));
    expect(capped.unmeasured).toContain('admitWaiting.remote');
  });
  test('ssh failure keeps a measured local starvation/wait as a lower bound and still names the unknown half', () => {
    const signals = readBackpressureSignals(observed({ parentHost: () => ({ host: 'node-b' }),
      ssh: () => ({ status: null, stdout: '', stderr: 'timeout' }),
      logs: () => [admission(33, 'run-l', 0), admission(1, 'run-l', 0)] }));
    expect(signals.admitWaiting).toBe(1);
    expect(signals.admitStarvedOver30m).toBe(1);
    expect(signals.dockerBuilds.remote).toBe('unknown');
    expect(signals.unmeasured).toEqual(['admitWaiting.remote', 'admitStarvedOver30m.remote']);
    const verdict = decideBackpressure(signals);
    expect(verdict.launchBudget).toBe(0);
    expect(verdict.reasons).toEqual(expect.arrayContaining(['admit-starved', 'unknown:admitWaiting.remote',
      'unknown:admitStarvedOver30m.remote', 'unknown:dockerBuilds.remote']));
    // Only a lower bound on waits: still capped at 1 by the unknown half.
    expect(decideBackpressure({ ...roomy(), admitWaiting: 1, podRecommended: 10, unmeasured: ['admitWaiting.remote'] }).launchBudget).toBe(1);
  });
  test('a measured 0 half is kept with the missing half named; a failed host read is unknown, not exit 1', () => {
    const zeroLocal = readBackpressureSignals(observed({ parentHost: () => ({ host: 'node-b' }),
      ssh: () => ({ status: null, stdout: '', stderr: 'timeout' }) }));
    expect(zeroLocal.admitWaiting).toBe(0);
    expect(zeroLocal.unmeasured).toEqual(['admitWaiting.remote', 'admitStarvedOver30m.remote']);
    expect(decideBackpressure(zeroLocal).reasons).toContain('unknown:admitWaiting.remote');
    const hostFail = readBackpressureSignals(observed({ parentHost: () => { throw Error('config unreadable'); } }));
    expect(hostFail.dockerBuilds.remote).toBe('unknown');
    expect(hostFail.unmeasured).toEqual(['admitWaiting.remote', 'admitStarvedOver30m.remote']);
    expect(decideBackpressure(hostFail).launchBudget).toBeLessThanOrEqual(1);
  });
  test('failed individual probes do not manufacture zero', () => {
    const fail = () => { throw Error('unavailable'); };
    const result = readBackpressureSignals(observed({ queue: fail, podRecommended: fail, logs: fail, ps: fail, currentVersion: fail }));
    expect(result).toEqual({ queueDepth: 'unknown', admitWaiting: 'unknown', admitStarvedOver30m: 'unknown',
      dockerBuilds: { local: 'unknown', remote: 0 }, podRecommended: 'unknown', staleParents: 'unknown' });
  });
});

describe('harness queue backpressure CLI', () => {
  async function invoke(args: string[], deps: BackpressureReadDeps) {
    const program = new Command().exitOverride();
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', backpressure: deps });
    const lines: string[] = [], errors: string[] = [], verdicts: unknown[] = [];
    const log = console.log, error = console.error, record = debug.log, exitCode = process.exitCode;
    console.log = (line: string) => { lines.push(line); };
    console.error = (line: string) => { errors.push(line); };
    debug.log = ((category: string, event: string, data?: unknown) => {
      if (category === 'traffic.backpressure') verdicts.push({ category, event, data });
    }) as typeof debug.log;
    process.exitCode = undefined;
    try {
      await program.parseAsync(['harness', 'queue', 'backpressure', ...args], { from: 'user' });
      return { lines, errors, verdicts, exitCode: process.exitCode };
    } finally {
      console.log = log; console.error = error; debug.log = record; process.exitCode = exitCode;
    }
  }
  test('json with timeout and capped local logs emits one verdict, budget 1 and exit 0', async () => {
    const outcome = await invoke(['--json'], observed({ parentHost: () => ({ host: 'node-b' }),
      ssh: () => ({ status: null, stdout: '', stderr: 'timeout' }),
      logs: () => Array.from({ length: 1000 }, () => admission(1, 'run-x', 0)),
      ps: () => 'docker ps\n', queue: () => [], podRecommended: () => 10 }));
    expect(outcome.lines).toHaveLength(1);
    expect(JSON.parse(outcome.lines[0]!)).toMatchObject({ launchBudget: 1 });
    expect(outcome.lines[0]).toContain('unknown:');
    expect(outcome.lines[0]).not.toContain('NaN');
    expect(outcome.verdicts).toEqual([expect.objectContaining({ category: 'traffic.backpressure', event: 'verdict' })]);
    expect(outcome.exitCode).toBeUndefined();
  }, 30_000);
  test('text output and --max validation/exit codes', async () => {
    const text = await invoke(['--max', '2'], observed({ ps: () => 'docker ps\n', queue: () => [] }));
    expect(text.lines).toEqual([expect.stringMatching(/^발사 예산 2 · 이유 /)]);
    expect(text.verdicts).toHaveLength(1);
    for (const max of ['1.5', '-1', 'NaN', '999999999999999999999']) {
      const invalid = await invoke(['--max', max], observed());
      expect(Number(invalid.exitCode)).toBe(2);
      expect(invalid.lines).toHaveLength(0);
      expect(invalid.verdicts).toHaveLength(0);
    }
  });
  test('reader exception is exit 1 and emits no verdict', async () => {
    const outcome = await invoke(['--json'], observed({ now: () => { throw Error('clock failure'); } }));
    expect(Number(outcome.exitCode)).toBe(1);
    expect(outcome.errors[0]).toContain('clock failure');
    expect(outcome.verdicts).toHaveLength(0);
  });
});
