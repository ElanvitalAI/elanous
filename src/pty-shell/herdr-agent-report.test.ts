import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createFileSeqStore, createHerdrAgentReporter, defaultHerdrRunner, guardHerdrReleaseOnSignal, herdrJsonError,
  type HerdrSignalTarget,
  type HerdrRunOpts, type HerdrRunResult, type HerdrSeqStore,
} from './herdr-agent-report.js';
import { createFakeHerdr, type FakeHerdr } from '../ux-sim/fake-herdr.js';

/** 시험마다 새 pane 기록 — 실 tmpdir 파일을 안 건드린다. */
function memorySeqStore(): HerdrSeqStore & { value: number | undefined } {
  const store = {
    value: undefined as number | undefined,
    read: () => store.value,
    write: (seq: number) => { store.value = seq; },
  };
  return store;
}

const seqOf = (argv: string[]): number => Number(argv[argv.indexOf('--seq') + 1]);

/** resolve 를 밖에서 쥐는 비동기 러너 결과. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

interface Call {
  argv: string[];
  opts: HerdrRunOpts;
}

function collecting(behavior: (call: Call) => HerdrRunResult | Promise<HerdrRunResult> = () => ({ ok: true })) {
  const calls: Call[] = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  const run = (argv: string[], opts: HerdrRunOpts) => {
    const call = { argv, opts };
    calls.push(call);
    return behavior(call);
  };
  const log = (event: string, data: Record<string, unknown>) => { logs.push([event, data]); };
  return { calls, logs, run, log };
}

function argvHas(argv: string[], ...parts: string[]): boolean {
  const joined = argv.join(' ');
  return parts.every((p) => joined.includes(p));
}

const activeEnv = { HERDR_ENV: '1', HERDR_PANE_ID: 'wM:p1' };

describe('createHerdrAgentReporter', () => {
  test('start reports idle agent and session identity for the pane', () => {
    const bag = collecting();
    const reporter = createHerdrAgentReporter({ env: activeEnv, run: bag.run, log: bag.log, seqStore: memorySeqStore(), sessionId: 'sess-1' });
    expect(reporter).not.toBeNull();
    reporter!.start();
    expect(bag.calls).toHaveLength(2);
    expect(argvHas(bag.calls[0]!.argv, 'pane', 'report-agent', '--state idle', '--agent-session-id sess-1', 'wM:p1')).toBe(true);
    expect(argvHas(bag.calls[0]!.argv, '--source custom:elanous', '--agent elanous')).toBe(true);
    expect(argvHas(bag.calls[1]!.argv, 'pane', 'report-agent-session', '--agent-session-id sess-1', '--session-start-source startup', 'wM:p1')).toBe(true);
    expect(bag.calls[0]!.opts.sync).toBe(false);
    expect(bag.calls[1]!.opts.sync).toBe(false);
  });

  test('turn maps busy→working and idle→idle and seq increases each call', () => {
    const bag = collecting();
    const reporter = createHerdrAgentReporter({ env: activeEnv, run: bag.run, log: bag.log, seqStore: memorySeqStore(), sessionId: 's', now: () => 1000 })!;
    reporter.start();
    reporter.turn('busy');
    reporter.turn('idle');
    const seqs = bag.calls.map((c) => c.argv[c.argv.indexOf('--seq') + 1]);
    expect(seqs).toEqual(['1000', '1001', '1002', '1003']);
    expect(argvHas(bag.calls[2]!.argv, 'pane', 'report-agent', '--state working', 'wM:p1')).toBe(true);
    expect(argvHas(bag.calls[3]!.argv, 'pane', 'report-agent', '--state idle', 'wM:p1')).toBe(true);
  });

  test('release runs pane release-agent sync once even if called twice', () => {
    const bag = collecting();
    const reporter = createHerdrAgentReporter({ env: activeEnv, run: bag.run, log: bag.log, seqStore: memorySeqStore(), sessionId: 's' })!;
    reporter.start();
    const before = bag.calls.length;
    reporter.release();
    reporter.release();
    const releases = bag.calls.slice(before);
    expect(releases).toHaveLength(1);
    expect(argvHas(releases[0]!.argv, 'pane', 'release-agent', 'wM:p1')).toBe(true);
    expect(releases[0]!.opts.sync).toBe(true);
    expect(releases[0]!.opts.timeoutMs).toBeLessThanOrEqual(300);
  });

  test('missing HERDR_ENV, missing HERDR_PANE_ID, or kill switch returns null with one skipped log and zero runs', () => {
    for (const env of [
      {},
      { HERDR_PANE_ID: 'wM:p1' },
      { HERDR_ENV: '1' },
      { HERDR_ENV: '1', HERDR_PANE_ID: '' },
      { HERDR_ENV: '1', HERDR_PANE_ID: 'wM:p1', ELANOUS_HERDR_REPORT: '0' },
    ]) {
      const bag = collecting();
      const reporter = createHerdrAgentReporter({ env, run: bag.run, log: bag.log, seqStore: memorySeqStore(), sessionId: 's' });
      expect(reporter).toBeNull();
      expect(bag.calls).toHaveLength(0);
      expect(bag.logs).toHaveLength(1);
      expect(bag.logs[0]![0]).toBe('skipped');
      const reason = bag.logs[0]![1].reason;
      if (env.ELANOUS_HERDR_REPORT === '0') expect(reason).toBe('kill-switch');
      else expect(reason).toBe('no-herdr-env');
    }
  });

  test('runner ok:false does not throw, logs report-failed once, and later turn makes zero runs', async () => {
    const bag = collecting(() => ({ ok: false, stderr: 'agent label rejected' }));
    const reporter = createHerdrAgentReporter({ env: activeEnv, run: bag.run, log: bag.log, seqStore: memorySeqStore(), sessionId: 's' })!;
    expect(() => reporter.start()).not.toThrow();
    await Promise.resolve();
    expect(bag.logs.filter(([e]) => e === 'report-failed')).toHaveLength(1);
    expect(bag.logs[0]![1]).toMatchObject({ cmd: 'report-agent' });
    const afterFail = bag.calls.length;
    reporter.turn('busy');
    reporter.turn('idle');
    expect(bag.calls.length).toBe(afterFail);
  });

  test('runner throw does not throw out and disables later turns', () => {
    const bag = collecting(() => { throw new Error('spawn ENOENT'); });
    const reporter = createHerdrAgentReporter({ env: activeEnv, run: bag.run, log: bag.log, seqStore: memorySeqStore(), sessionId: 's' })!;
    expect(() => reporter.start()).not.toThrow();
    expect(bag.logs.filter(([e]) => e === 'report-failed')).toHaveLength(1);
    expect(String(bag.logs[0]![1].stderrHead)).toContain('ENOENT');
    const afterFail = bag.calls.length;
    reporter.turn('busy');
    expect(bag.calls.length).toBe(afterFail);
  });

  test('async runner rejection does not throw and disables later turns', async () => {
    const bag = collecting(() => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
    const reporter = createHerdrAgentReporter({ env: activeEnv, run: bag.run, log: bag.log, seqStore: memorySeqStore(), sessionId: 's' })!;
    expect(() => reporter.start()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(bag.logs.filter(([e]) => e === 'report-failed')).toHaveLength(1);
    const afterFail = bag.calls.length;
    reporter.turn('idle');
    expect(bag.calls.length).toBe(afterFail);
  });

  test('release is skipped when start never succeeded', () => {
    const bag = collecting(() => ({ ok: false, stderr: 'no' }));
    const reporter = createHerdrAgentReporter({ env: activeEnv, run: bag.run, log: bag.log, seqStore: memorySeqStore(), sessionId: 's' })!;
    reporter.start();
    const after = bag.calls.length;
    reporter.release();
    expect(bag.calls.length).toBe(after);
  });

  test('every call uses --source custom:elanous (herdr custom agent integration)', () => {
    const bag = collecting();
    const reporter = createHerdrAgentReporter({ env: activeEnv, run: bag.run, log: bag.log, seqStore: memorySeqStore(), sessionId: 's' })!;
    reporter.start();
    reporter.turn('busy');
    reporter.release();
    expect(bag.calls.length).toBe(4);
    for (const { argv } of bag.calls) {
      expect(argv[argv.indexOf('--source') + 1]).toBe('custom:elanous');
    }
  });

  test('a later process in the same pane at the same millisecond starts above the earlier process last seq', () => {
    // 시계를 앞당기지 않는다 — 두 신고기가 같은 시각을 본다(같은 ms 재기동).
    const now = () => 5_000;
    const pane = memorySeqStore();
    const first = collecting();
    const a = createHerdrAgentReporter({ env: activeEnv, run: first.run, log: first.log, sessionId: 'a', now, seqStore: pane })!;
    a.start();
    a.turn('busy');
    a.turn('idle');
    a.release();
    const lastA = Math.max(...first.calls.map((c) => seqOf(c.argv)));
    const second = collecting();
    const b = createHerdrAgentReporter({ env: activeEnv, run: second.run, log: second.log, sessionId: 'b', now, seqStore: pane })!;
    b.start();
    expect(seqOf(second.calls[0]!.argv)).toBeGreaterThan(lastA);
  });

  test('the default file seq store carries the pane seq across reporters at the same millisecond', () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-seq-'));
    try {
      const now = () => 9_000;
      const first = collecting();
      const a = createHerdrAgentReporter({ env: activeEnv, run: first.run, log: first.log, sessionId: 'a', now, seqStore: createFileSeqStore('wM:p1', dir) })!;
      a.start();
      a.turn('busy');
      a.release();
      const lastA = Math.max(...first.calls.map((c) => seqOf(c.argv)));
      expect(Number(readFileSync(join(dir, 'wM_p1.seq'), 'utf8'))).toBe(lastA);
      const second = collecting();
      const b = createHerdrAgentReporter({ env: activeEnv, run: second.run, log: second.log, sessionId: 'b', now, seqStore: createFileSeqStore('wM:p1', dir) })!;
      b.start();
      expect(seqOf(second.calls[0]!.argv)).toBeGreaterThan(lastA);
      // 다른 pane 은 따로 센다.
      const third = collecting();
      const c = createHerdrAgentReporter({ env: { HERDR_ENV: '1', HERDR_PANE_ID: 'wM:p2' }, run: third.run, log: third.log, sessionId: 'c', now, seqStore: createFileSeqStore('wM:p2', dir) })!;
      c.start();
      expect(seqOf(third.calls[0]!.argv)).toBe(9_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a failing seq store logs once and falls back to clock and previous+1', () => {
    const bag = collecting();
    const broken: HerdrSeqStore = { read: () => { throw new Error('EACCES'); }, write: () => { throw new Error('EACCES'); } };
    const reporter = createHerdrAgentReporter({ env: activeEnv, run: bag.run, log: bag.log, sessionId: 's', now: () => 10, seqStore: broken })!;
    reporter.start();
    reporter.turn('busy');
    expect(bag.calls.map((c) => seqOf(c.argv))).toEqual([10, 11, 12]);
    expect(bag.logs.filter(([e]) => e === 'seq-store-failed')).toHaveLength(1);
  });

  test('release carries --seq greater than the preceding report', () => {
    const bag = collecting();
    const reporter = createHerdrAgentReporter({ env: activeEnv, run: bag.run, log: bag.log, seqStore: memorySeqStore(), sessionId: 's', now: () => 7 })!;
    reporter.start();
    reporter.turn('busy');
    reporter.release();
    const release = bag.calls[bag.calls.length - 1]!.argv;
    const prior = bag.calls[bag.calls.length - 2]!.argv;
    expect(release[1]).toBe('release-agent');
    expect(release).toContain('--seq');
    const seqOf = (argv: string[]) => Number(argv[argv.indexOf('--seq') + 1]);
    expect(Number.isFinite(seqOf(release))).toBe(true);
    expect(seqOf(release)).toBeGreaterThan(seqOf(prior));
  });

  test('a turn failure after a successful start still releases the agent once', () => {
    const bag = collecting((call) => (call.argv.includes('working') ? { ok: false, stderr: 'turn rejected' } : { ok: true }));
    const reporter = createHerdrAgentReporter({ env: activeEnv, run: bag.run, log: bag.log, seqStore: memorySeqStore(), sessionId: 's' })!;
    reporter.start();
    reporter.turn('busy');
    const afterFail = bag.calls.length;
    reporter.turn('idle');
    expect(bag.calls.length).toBe(afterFail);
    reporter.release();
    reporter.release();
    const releases = bag.calls.filter((c) => c.argv[1] === 'release-agent');
    expect(releases).toHaveLength(1);
    expect(releases[0]!.opts.sync).toBe(true);
    expect(bag.logs.filter(([e]) => e === 'report-failed')).toHaveLength(1);
  });

  test('idle ok but async session failure still releases once (the agent was registered)', async () => {
    const bag = collecting((call) => {
      if (call.argv[1] === 'report-agent-session') return Promise.resolve({ ok: false, stderr: 'no' });
      if (call.argv[1] === 'report-agent') return Promise.resolve({ ok: true });
      return { ok: true };
    });
    const reporter = createHerdrAgentReporter({ env: activeEnv, run: bag.run, log: bag.log, seqStore: memorySeqStore(), sessionId: 's' })!;
    reporter.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(bag.logs.filter(([e]) => e === 'report-failed')).toHaveLength(1);
    reporter.release();
    reporter.release();
    const releases = bag.calls.filter((c) => c.argv[1] === 'release-agent');
    expect(releases).toHaveLength(1);
    expect(releases[0]!.opts.sync).toBe(true);
  });

  test('idle ok but sync session failure still releases once', () => {
    const bag = collecting((call) => (call.argv[1] === 'report-agent-session' ? { ok: false, stderr: 'no' } : { ok: true }));
    const reporter = createHerdrAgentReporter({ env: activeEnv, run: bag.run, log: bag.log, seqStore: memorySeqStore(), sessionId: 's' })!;
    reporter.start();
    const afterStart = bag.calls.length;
    reporter.turn('busy');
    expect(bag.calls.length).toBe(afterStart);
    reporter.release();
    expect(bag.calls.filter((c) => c.argv[1] === 'release-agent')).toHaveLength(1);
  });

  test('an async idle failure skips release', async () => {
    const bag = collecting((call) => (call.argv[1] === 'report-agent' ? Promise.resolve({ ok: false, stderr: 'no' }) : Promise.resolve({ ok: true })));
    const reporter = createHerdrAgentReporter({ env: activeEnv, run: bag.run, log: bag.log, seqStore: memorySeqStore(), sessionId: 's' })!;
    reporter.start();
    await new Promise((r) => setTimeout(r, 0));
    const after = bag.calls.length;
    reporter.release();
    expect(bag.calls.length).toBe(after);
    expect(bag.calls.filter((c) => c.argv[1] === 'release-agent')).toHaveLength(0);
  });

  test('turn after release reports nothing (no re-registration with a larger seq)', () => {
    const bag = collecting();
    const reporter = createHerdrAgentReporter({ env: activeEnv, run: bag.run, log: bag.log, seqStore: memorySeqStore(), sessionId: 's' })!;
    reporter.start();
    reporter.release();
    const afterRelease = bag.calls.length;
    reporter.turn('busy');
    reporter.turn('idle');
    expect(bag.calls.length).toBe(afterRelease);
  });

  test('release in the same tick as a pending async start is sent at once, synchronously (result unknown → try)', () => {
    const idle = deferred<HerdrRunResult>();
    const session = deferred<HerdrRunResult>();
    const bag = collecting((call) => {
      if (call.argv[1] === 'report-agent-session') return session.promise;
      if (call.argv[1] === 'report-agent') return idle.promise;
      return { ok: true };
    });
    const reporter = createHerdrAgentReporter({ env: activeEnv, run: bag.run, log: bag.log, seqStore: memorySeqStore(), sessionId: 's' })!;
    reporter.start();
    reporter.release();
    reporter.release();
    // 같은 틱 — 비동기 결과를 기다리지 않고 반납이 이미 나갔다(exit 전에).
    const releases = bag.calls.filter((c) => c.argv[1] === 'release-agent');
    expect(releases).toHaveLength(1);
    expect(releases[0]!.opts.sync).toBe(true);
    expect(bag.logs.filter(([e]) => e === 'release-start-pending')).toHaveLength(1);
  });

  test('a release failure is logged as release-failed even after the reporter was disabled', () => {
    const bag = collecting((call) => {
      if (call.argv.includes('working')) return { ok: false, stderr: 'turn rejected' };
      if (call.argv[1] === 'release-agent') return { ok: false, stderr: 'exit 3' };
      return { ok: true };
    });
    const reporter = createHerdrAgentReporter({ env: activeEnv, run: bag.run, log: bag.log, seqStore: memorySeqStore(), sessionId: 's' })!;
    reporter.start();
    reporter.turn('busy');
    reporter.release();
    expect(bag.calls.filter((c) => c.argv[1] === 'release-agent')).toHaveLength(1);
    const failed = bag.logs.filter(([e]) => e === 'release-failed');
    expect(failed).toHaveLength(1);
    expect(String(failed[0]![1].stderrHead)).toContain('exit 3');
  });

  test('turn never touches the seq store: read once at start, written only on release', () => {
    const bag = collecting();
    const io = { reads: 0, writes: [] as number[] };
    const store: HerdrSeqStore = { read: () => { io.reads += 1; return 40; }, write: (n) => { io.writes.push(n); } };
    const reporter = createHerdrAgentReporter({ env: activeEnv, run: bag.run, log: bag.log, seqStore: store, sessionId: 's', now: () => 1 })!;
    reporter.start();
    expect(io).toEqual({ reads: 1, writes: [] });
    reporter.turn('busy');
    reporter.turn('idle');
    reporter.turn('busy');
    expect(io).toEqual({ reads: 1, writes: [] });
    reporter.release();
    const seqs = bag.calls.map((c) => seqOf(c.argv));
    expect(seqs).toEqual([41, 42, 43, 44, 45, 46]);
    expect(io).toEqual({ reads: 1, writes: [46] });
  });
});

describe('기본 러너 — stdout JSON error 는 rc 와 무관하게 실패 (r4 리뷰 mf)', () => {
  test('herdrJsonError — 실측 봉투·rc0 성공 응답·비 JSON', () => {
    expect(herdrJsonError('{"error":{"code":"pane_not_found","message":"pane wZ:p9 not found"},"id":"cli:request"}\n'))
      .toBe('pane_not_found: pane wZ:p9 not found');
    expect(herdrJsonError('{"id":"cli:request","result":{"ok":true}}')).toBeUndefined();
    expect(herdrJsonError('')).toBeUndefined();
    expect(herdrJsonError('plain text')).toBe('unparseable-json');
    expect(herdrJsonError('   \n')).toBeUndefined();
    // «{» 로 시작했는데 깨진(잘린) JSON 은 성공으로 읽지 않는다(r8 리뷰 mf).
    expect(herdrJsonError('{"error":{"code":"x"')).toBe('unparseable-json');
    expect(herdrJsonError('{"error":"denied"}')).toBe('denied');
  });

  const withFakeHerdr = async (script: string, body: (env: NodeJS.ProcessEnv) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-json-'));
    const bin = join(dir, 'herdr');
    writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    try { await body({ HERDR_ENV: '1', HERDR_PANE_ID: 'wM:p1', HERDR_BIN_PATH: bin }); } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  test('rc 0 이어도 JSON error 면 비동기·동기 둘 다 ok:false ⊕ 오류 문면', async () => {
    await withFakeHerdr(`echo '{"error":{"code":"stale_seq","message":"seq not newer"}}'; exit 0`, async (env) => {
      const run = defaultHerdrRunner(env);
      const a = await run(['pane', 'report-agent'], { sync: false, timeoutMs: 2000 });
      expect(a).toEqual({ ok: false, stderr: 'stale_seq: seq not newer' });
      const s = await run(['pane', 'release-agent'], { sync: true, timeoutMs: 300 });
      expect(s).toEqual({ ok: false, stderr: 'stale_seq: seq not newer' });
    });
  });

  test('rc 1 ⊕ JSON error 는 오류 문면을 봉투에서 가져온다 · rc 0 ⊕ 정상 응답은 ok', async () => {
    await withFakeHerdr(`echo '{"error":{"code":"pane_not_found","message":"gone"}}'; exit 1`, async (env) => {
      expect(await defaultHerdrRunner(env)(['x'], { sync: false, timeoutMs: 2000 })).toEqual({ ok: false, stderr: 'pane_not_found: gone' });
    });
    await withFakeHerdr(`echo '{"id":"cli:request","result":{}}'; exit 0`, async (env) => {
      expect(await defaultHerdrRunner(env)(['x'], { sync: false, timeoutMs: 2000 })).toEqual({ ok: true });
    });
  });

  test('신고기 — rc0 JSON error 를 실패로 보고 report-failed 한 번 ⊕ 이후 turn 꺼짐', async () => {
    await withFakeHerdr(`echo '{"error":{"code":"denied","message":"no"}}'; exit 0`, async (env) => {
      const events: Array<[string, Record<string, unknown>]> = [];
      const r = createHerdrAgentReporter({ env, sessionId: 's', seqStore: memorySeqStore(), log: (e, d) => events.push([e, d]) })!;
      r.start();
      for (let i = 0; i < 100 && !events.some(([e]) => e === 'report-failed'); i++) await new Promise((res) => setTimeout(res, 20));
      const failed = events.filter(([e]) => e === 'report-failed');
      expect(failed).toHaveLength(1);
      expect(String(failed[0]![1].stderrHead)).toContain('denied: no');
    });
  });
});

describe('r5 — 신고 순서 ⊕ release 인자 순서', () => {
  test('비동기 idle 등록이 끝나기 전의 session·turn 은 등록 «뒤»에 보낸다 (r5 리뷰 mf)', async () => {
    const idle = deferred<HerdrRunResult>();
    const started: string[] = [];
    const bag = collecting((call) => {
      started.push(call.argv[1] === 'report-agent' ? `report:${call.argv[call.argv.indexOf('--state') + 1]}` : call.argv[1]!);
      return started.length === 1 ? idle.promise : Promise.resolve({ ok: true });
    });
    const r = createHerdrAgentReporter({ env: activeEnv, run: bag.run, log: bag.log, seqStore: memorySeqStore(), sessionId: 's' })!;
    r.start();
    r.turn('busy');
    // idle 이 아직 안 끝났다 — session·turn 은 아직 안 떠야 한다.
    expect(started).toEqual(['report:idle']);
    idle.resolve({ ok: true });
    for (let i = 0; i < 20 && started.length < 3; i++) await Promise.resolve();
    await new Promise((res) => setTimeout(res, 0));
    expect(started).toEqual(['report:idle', 'report-agent-session', 'report:working']);
    // seq 는 넣은 순서대로 커진다.
    const seqs = bag.calls.map((c) => seqOf(c.argv));
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  test('반납 뒤에 차례가 온 줄 선 신고는 보내지 않는다', async () => {
    const idle = deferred<HerdrRunResult>();
    const bag = collecting((call) => (bag.calls.length === 1 ? idle.promise : { ok: true }));
    const r = createHerdrAgentReporter({ env: activeEnv, run: bag.run, log: bag.log, seqStore: memorySeqStore(), sessionId: 's' })!;
    r.start(); // idle pending → session 줄 섬
    r.release(); // 결과 모름 → 바로 동기 반납
    idle.resolve({ ok: true });
    await new Promise((res) => setTimeout(res, 0));
    // 줄 선 session 은 반납 뒤라 안 나간다 · 반납 직전 동기 재등록(EXIT-RACE) · 등록이 늦게 성공해 재반납이 한 번 더 나간다(r6 완화).
    expect(bag.calls.map((c) => c.argv[1])).toEqual(['report-agent', 'report-agent', 'release-agent', 'release-agent']);
    expect(bag.calls[1]!.opts.sync).toBe(true);
    expect(seqOf(bag.calls[2]!.argv)).toBeGreaterThan(seqOf(bag.calls[1]!.argv));
    expect(bag.calls.some((c) => c.argv[1] === 'report-agent-session')).toBe(false);
  });

  test('release-agent 는 PANE_ID 를 옵션 «앞»에 둔다 — herdr 0.9.1 은 뒤에 두면 unknown option 으로 거부한다(10-18 라이브)', () => {
    const bag = collecting();
    const r = createHerdrAgentReporter({ env: activeEnv, run: bag.run, log: bag.log, seqStore: memorySeqStore(), sessionId: 's' })!;
    r.start();
    r.release();
    const rel = bag.calls.find((c) => c.argv[1] === 'release-agent')!;
    expect(rel.argv.slice(0, 3)).toEqual(['pane', 'release-agent', 'wM:p1']);
    expect(argvHas(rel.argv, '--source custom:elanous', '--agent elanous', '--seq')).toBe(true);
  });
});

describe('r7 — 등록 결과 모르는 채 반납한 뒤 등록이 늦게 성공하면 한 번 더 반납 (r6 리뷰 완화)', () => {
  test('pending 중 release → idle 이 나중에 ok → release-agent 를 더 큰 seq 로 한 번 더 · 실패면 안 보낸다', async () => {
    for (const lateOk of [true, false]) {
      const idle = deferred<HerdrRunResult>();
      const bag = collecting((call) => (bag.calls.length === 1 ? idle.promise : { ok: true }));
      const r = createHerdrAgentReporter({ env: activeEnv, run: bag.run, log: bag.log, seqStore: memorySeqStore(), sessionId: 's' })!;
      r.start();
      r.release();
      idle.resolve({ ok: lateOk });
      await new Promise((res) => setTimeout(res, 0));
      const releases = bag.calls.filter((c) => c.argv[1] === 'release-agent');
      expect(releases).toHaveLength(lateOk ? 2 : 1);
      if (lateOk) {
        expect(seqOf(releases[1]!.argv)).toBeGreaterThan(seqOf(releases[0]!.argv));
        expect(bag.logs.some(([e]) => e === 'release-resend-after-late-start')).toBe(true);
      }
    }
  });
});

test('재반납 seq 도 pane 기록에 남는다 — 같은 ms 재기동의 첫 seq 가 재반납보다 크다 (r7 리뷰 mf)', async () => {
  const store = memorySeqStore();
  const idle = deferred<HerdrRunResult>();
  const bag = collecting((call) => (bag.calls.length === 1 ? idle.promise : { ok: true }));
  const now = () => 1_000;
  const r = createHerdrAgentReporter({ env: activeEnv, run: bag.run, log: bag.log, seqStore: store, sessionId: 's', now })!;
  r.start();
  r.release();
  idle.resolve({ ok: true });
  await new Promise((res) => setTimeout(res, 0));
  const resend = bag.calls.filter((c) => c.argv[1] === 'release-agent')[1]!;
  expect(store.value).toBe(seqOf(resend.argv));
  const bag2 = collecting();
  const r2 = createHerdrAgentReporter({ env: activeEnv, run: bag2.run, log: bag2.log, seqStore: store, sessionId: 's2', now })!;
  r2.start();
  expect(seqOf(bag2.calls[0]!.argv)).toBeGreaterThan(seqOf(resend.argv));
});

describe('r8 — stdout 상한 넘침·잘린 JSON 은 실패 (측정 불가)', () => {
  const withFakeHerdr2 = async (script: string, body: (env: NodeJS.ProcessEnv) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-cap-'));
    const bin = join(dir, 'herdr');
    writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    try { await body({ HERDR_ENV: '1', HERDR_PANE_ID: 'wM:p1', HERDR_BIN_PATH: bin }); } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  test('rc 0 이어도 4KB 를 넘는 응답은 비동기·동기 둘 다 ok:false «stdout-overflow-unmeasured»', async () => {
    // 5000자 패딩 뒤 error 봉투 — 상한 안만 보면 봉투를 못 본다.
    const script = `printf '{"pad":"%s","error":{"code":"late","message":"after cap"}}' "$(head -c 5000 /dev/zero | tr '\\0' a)"; exit 0`;
    await withFakeHerdr2(script, async (env) => {
      const run = defaultHerdrRunner(env);
      expect(await run(['x'], { sync: false, timeoutMs: 2000 })).toEqual({ ok: false, stderr: 'stdout-overflow-unmeasured' });
      expect(await run(['x'], { sync: true, timeoutMs: 300 })).toEqual({ ok: false, stderr: 'stdout-overflow-unmeasured' });
    });
  });

  test('상한 안의 정상 JSON 응답은 그대로 ok', async () => {
    await withFakeHerdr2(`echo '{"id":"cli:request","result":{"ok":true}}'; exit 0`, async (env) => {
      expect(await defaultHerdrRunner(env)(['x'], { sync: false, timeoutMs: 2000 })).toEqual({ ok: true });
    });
  });
});

describe('#29077 r1 — 비 JSON 출력·바이트 상한', () => {
  const withFake = async (script: string, body: (env: NodeJS.ProcessEnv) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-bytes-'));
    const bin = join(dir, 'herdr');
    writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    try { await body({ HERDR_ENV: '1', HERDR_PANE_ID: 'wM:p1', HERDR_BIN_PATH: bin }); } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  test('rc 0 ⊕ 비 JSON 출력은 비동기·동기 둘 다 unparseable-json 실패 · 빈 출력은 성공', async () => {
    await withFake(`echo not-json; exit 0`, async (env) => {
      const run = defaultHerdrRunner(env);
      expect(await run(['x'], { sync: false, timeoutMs: 2000 })).toEqual({ ok: false, stderr: 'unparseable-json' });
      expect(await run(['x'], { sync: true, timeoutMs: 300 })).toEqual({ ok: false, stderr: 'unparseable-json' });
    });
    await withFake(`echo '{"error":{"code":"x"'; exit 0`, async (env) => {
      expect(await defaultHerdrRunner(env)(['x'], { sync: false, timeoutMs: 2000 })).toEqual({ ok: false, stderr: 'unparseable-json' });
    });
    await withFake(`exit 0`, async (env) => {
      const run = defaultHerdrRunner(env);
      expect(await run(['x'], { sync: false, timeoutMs: 2000 })).toEqual({ ok: true });
      expect(await run(['x'], { sync: true, timeoutMs: 300 })).toEqual({ ok: true });
    });
  });

  test('상한은 바이트 — 문자 수는 4KB 아래여도 UTF-8 로 4KB 를 넘는 정상 JSON 은 넘침 실패', async () => {
    // 한글 1500자 = 4500바이트(문자 수 1500 < 4096).
    const script = `printf '{"id":"cli:request","result":{"pad":"%s"}}' "$(printf '가%.0s' $(seq 1 1500))"; exit 0`;
    await withFake(script, async (env) => {
      const run = defaultHerdrRunner(env);
      expect(await run(['x'], { sync: false, timeoutMs: 2000 })).toEqual({ ok: false, stderr: 'stdout-overflow-unmeasured' });
      expect(await run(['x'], { sync: true, timeoutMs: 300 })).toEqual({ ok: false, stderr: 'stdout-overflow-unmeasured' });
    });
  });

  test('stdout 청크 사이에서 갈린 UTF-8 오류 문자를 원문대로 디코딩한다', async () => {
    // «가»의 첫 바이트만 보낸 뒤 나머지를 보낸다. 청크마다 디코딩하면 U+FFFD가 된다.
    const script = `printf '{"error":{"code":"split_utf8","message":"\\352'; sleep 0.05; printf '\\260\\200나다"}}'; exit 0`;
    await withFake(script, async (env) => {
      const run = defaultHerdrRunner(env);
      expect(await run(['x'], { sync: false, timeoutMs: 2000 })).toEqual({ ok: false, stderr: 'split_utf8: 가나다' });
      expect(await run(['x'], { sync: true, timeoutMs: 300 })).toEqual({ ok: false, stderr: 'split_utf8: 가나다' });
    });
  });
});

describe('TUI-HERDR-EXIT-RACE — 기동 직후 종료해도 유령이 안 남는다 (쓸 장치: fake-herdr)', () => {
  /**
   * 신고기 러너 ← fake-herdr. 비동기 신고는 herdr 자식 프로세스처럼 `delayMs` 뒤에 서버에 닿는다 —
   * 부모가 죽어도(exit) 자식은 끝까지 간다. 부모가 죽은 뒤엔 결과를 부모에게 돌려주지 않는다.
   * 동기 신고(종료 경로)는 그 자리에서 닿는다.
   */
  function processRunner(herdr: FakeHerdr, delayMs: number) {
    const proc = { exited: false };
    const toResult = (r: { code: number | null; stdout: string }): HerdrRunResult => (r.code === 0 && !herdrJsonError(r.stdout) ? { ok: true } : { ok: false, stderr: r.stdout });
    const run = (argv: string[], opts: HerdrRunOpts): HerdrRunResult | Promise<HerdrRunResult> => {
      if (opts.sync) return toResult(herdr.runSync(argv));
      return new Promise<HerdrRunResult>((resolve) => {
        setTimeout(() => {
          const r = herdr.runSync(argv);
          if (!proc.exited) resolve(toResult(r));
        }, delayMs);
      });
    };
    return { proc, run };
  }
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  const env = { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' };

  test('지연 idle(500ms) ⊕ 즉시 release ⊕ 프로세스 종료 → 늦은 등록이 닿은 뒤에도 유령 0 · 다음 기동도 하나만 · 그 반납 뒤 0', async () => {
    const herdr = createFakeHerdr({ panes: [] });
    const store = memorySeqStore();
    let clock = 1_000;
    const now = () => clock;
    const first = processRunner(herdr, 500);
    const a = createHerdrAgentReporter({ env, run: first.run, log: () => {}, seqStore: store, sessionId: 'a', now })!;
    a.start();
    a.release();
    first.proc.exited = true; // ctrl+c — 부모는 여기서 끝, 비동기 idle 자식은 아직 가는 중
    await sleep(600);
    expect(herdr.reportedAgents()).toEqual([]);

    clock = 1_000; // 같은 ms 재기동(최악)
    const second = processRunner(herdr, 0);
    const b = createHerdrAgentReporter({ env, run: second.run, log: () => {}, seqStore: store, sessionId: 'b', now })!;
    b.start();
    await sleep(20);
    expect(herdr.reportedAgents()).toHaveLength(1);
    b.release();
    second.proc.exited = true;
    await sleep(20);
    expect(herdr.reportedAgents()).toEqual([]);
  });
});

describe('TUI-HERDR-EXIT-RACE — 기동 창의 ctrl+c(SIGINT 기본 죽음)도 반납한다', () => {
  // 실측(10-22 격리 세션 tf-exit-race): 대시보드가 raw 모드에 들기 «전»의 ctrl+c 는 SIGINT 기본 동작으로
  // 프로세스를 죽인다(rc130) — 'exit' 훅이 안 돌아 반납 0 · `agent list` 에 elanous idle 이 남았다.
  function fakeProc(): HerdrSignalTarget & { emit(sig: NodeJS.Signals): void; kills: Array<[number, string]> } {
    const ls = new Map<string, Array<(sig: NodeJS.Signals) => void>>();
    const kills: Array<[number, string]> = [];
    return {
      pid: 4242,
      kills,
      on(sig, fn) { ls.set(sig, [...(ls.get(sig) ?? []), fn]); return this; },
      removeListener(sig, fn) { ls.set(sig, (ls.get(sig) ?? []).filter((f) => f !== fn)); return this; },
      listenerCount: (sig) => (ls.get(sig) ?? []).length,
      kill(pid, sig) { kills.push([pid, String(sig)]); return true; },
      emit(sig) { for (const fn of [...(ls.get(sig) ?? [])]) fn(sig); },
    };
  }

  test('홀로 듣던 SIGINT 면 반납 → 자기 리스너를 걷고 같은 신호를 다시 올려 기본 죽음을 지킨다', () => {
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      const proc = fakeProc();
      let released = 0;
      guardHerdrReleaseOnSignal(() => { released += 1; }, proc);
      proc.emit(sig);
      expect(released).toBe(1);
      expect(proc.listenerCount('SIGINT') + proc.listenerCount('SIGTERM')).toBe(0);
      expect(proc.kills).toEqual([[4242, sig]]);
    }
  });

  test('다른 SIGINT 리스너가 있으면 반납만 하고 다시 올리지 않는다(그쪽이 정한다) · 해제는 리스너를 걷는다', () => {
    const proc = fakeProc();
    let released = 0;
    let other = 0;
    proc.on('SIGINT', () => { other += 1; });
    guardHerdrReleaseOnSignal(() => { released += 1; }, proc);
    proc.emit('SIGINT');
    expect([released, other]).toEqual([1, 1]);
    expect(proc.kills).toEqual([]);
    const proc2 = fakeProc();
    const off = guardHerdrReleaseOnSignal(() => { released += 1; }, proc2);
    off();
    expect(proc2.listenerCount('SIGINT') + proc2.listenerCount('SIGTERM')).toBe(0);
    proc2.emit('SIGINT');
    expect(released).toBe(1);
  });
});
