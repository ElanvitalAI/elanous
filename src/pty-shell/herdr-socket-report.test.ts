import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import type { HerdrSeqStore } from './herdr-agent-report.js';
import {
  createHerdrSocketReporter as createReporterWithDefaultStore,
  formatElapsed,
  seatTitleFromCwd,
  writeHerdrSocketSync,
  type HerdrSocketFrame,
  type HerdrSocketSchedule,
} from './herdr-socket-report.js';

/** 시험마다 메모리 seq 저장소 — 기본 파일 저장소(사용자 상태)를 건드리지 않는다. 명시 seqStore 는 그대로 쓴다. */
function createHerdrSocketReporter(deps: Parameters<typeof createReporterWithDefaultStore>[0] = {}) {
  let stored: number | undefined;
  const memoryStore: HerdrSeqStore = { read: () => stored, write: (seq) => { stored = seq; } };
  return createReporterWithDefaultStore({ seqStore: memoryStore, ...deps });
}

const activeEnv = {
  HERDR_ENV: '1',
  HERDR_PANE_ID: 'w4:pM',
  HERDR_SOCKET_PATH: '/tmp/herdr-test.sock',
};

function collecting() {
  const frames: HerdrSocketFrame[] = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  return {
    frames,
    logs,
    send: (frame: HerdrSocketFrame) => { frames.push(frame); return true; },
    log: (event: string, data: Record<string, unknown>) => { logs.push([event, data]); },
  };
}

/** 타이머를 손으로 돌린다. fire() 는 걸린 것 중 가장 이른 하나. */
function manualTimers() {
  const pending: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const schedule: HerdrSocketSchedule = (fn, ms) => {
    const entry = { fn, ms, live: true };
    pending.push(entry);
    return () => { entry.live = false; };
  };
  return {
    schedule,
    live: () => pending.filter((t) => t.live),
    fire: () => {
      const next = pending.filter((t) => t.live).sort((x, y) => x.ms - y.ms)[0];
      if (!next) throw new Error('no timer');
      next.live = false;
      next.fn();
      return next.ms;
    },
  };
}

const methods = (frames: HerdrSocketFrame[]) => frames.map((f) => f.method.replace('pane.', ''));

describe('createHerdrSocketReporter', () => {
  test('HERDR_ENV 가 없으면 연결 0 · skipped 한 줄', () => {
    const bag = collecting();
    const reporter = createHerdrSocketReporter({ env: {}, send: bag.send, log: bag.log });
    expect(reporter).toBeNull();
    expect(bag.frames).toHaveLength(0);
    expect(bag.logs).toEqual([['skipped', { reason: 'no-herdr-socket' }]]);
  });

  test('소켓 경로가 없으면 연결 0', () => {
    const bag = collecting();
    const reporter = createHerdrSocketReporter({
      env: { HERDR_ENV: '1', HERDR_PANE_ID: 'w4:pM' },
      send: bag.send,
      log: bag.log,
    });
    expect(reporter).toBeNull();
    expect(bag.frames).toHaveLength(0);
  });

  test('턴 한 번: 상태마다 report_agent 수락 뒤 report_metadata · seq 단조 · release 한 번', async () => {
    const bag = collecting();
    const timers = manualTimers();
    const reporter = createHerdrSocketReporter({
      env: activeEnv,
      send: bag.send,
      log: bag.log,
      model: 'grok-4.7',
      cwd: '/Users/x/elanous-hq/seats/HAND-GROK-1/work',
      now: () => 10_000,
      tokens: () => ({ queue: '2' }),
      schedule: timers.schedule,
    })!;
    reporter.state('working');
    await reporter.settled();
    reporter.state('blocked', 'ask');
    await reporter.settled();
    reporter.state('idle');
    await reporter.settled();
    reporter.release();
    reporter.release();
    await reporter.settled();
    expect(methods(bag.frames)).toEqual([
      'report_agent', 'report_metadata',
      'report_agent', 'report_metadata',
      'report_agent', 'report_metadata',
      'release_agent',
    ]);
    const agents = bag.frames.filter((f) => f.method === 'pane.report_agent');
    expect(agents.map((f) => f.params.state)).toEqual(['working', 'blocked', 'idle']);
    expect(agents[1]!.params.message).toBe('ask');
    const seqs = bag.frames.map((f) => f.params.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    for (const frame of agents) {
      expect(frame.params).toMatchObject({ pane_id: 'w4:pM', source: 'elanous', agent: 'elanous' });
      // PaneReportAgentParams 에는 메타 칸이 없다 — 중첩하지 않는다.
      expect(Object.keys(frame.params).sort()).toEqual(
        ['agent', 'pane_id', 'seq', 'source', 'state', ...(frame.params.message ? ['message'] : [])].sort(),
      );
    }
    const metas = bag.frames.filter((f) => f.method === 'pane.report_metadata');
    for (const meta of metas) {
      expect(meta.params).toMatchObject({
        pane_id: 'w4:pM',
        source: 'elanous',
        agent: 'elanous',
        display_agent: 'eln·grok-4.7',
        title: 'HAND-GROK-1',
        ttl_ms: 60_000,
      });
      expect((meta.params as { tokens: Record<string, string> }).tokens).toMatchObject({ model: 'grok-4.7', queue: '2' });
    }
    expect(bag.frames.at(-1)!.params).toMatchObject({ pane_id: 'w4:pM', source: 'elanous', agent: 'elanous' });
    // 반납 뒤에는 TTL 갱신 타이머가 남지 않는다.
    expect(timers.live()).toHaveLength(0);
  });

  test('report_agent 응답 전에는 report_metadata 를 안 연다', async () => {
    const frames: HerdrSocketFrame[] = [];
    const answers: Array<(ok: boolean) => void> = [];
    const reporter = createHerdrSocketReporter({
      env: activeEnv,
      send: (frame) => { frames.push(frame); return new Promise<boolean>((resolve) => answers.push(resolve)); },
      log: () => {},
      model: 'grok-4.7',
      now: () => 0,
      schedule: manualTimers().schedule,
    })!;
    reporter.metadata({ tokens: { queue: '1' } });
    reporter.state('working');
    await new Promise((r) => setTimeout(r, 5));
    expect(methods(frames)).toEqual(['report_agent']);
    // 응답을 기다리는 동안 상태가 바뀌면 다음 차례에 최신 하나만.
    reporter.state('blocked', 'ask');
    answers.shift()!(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(methods(frames)).toEqual(['report_agent', 'report_agent']);
    expect(frames[1]!.params).toMatchObject({ state: 'blocked', message: 'ask' });
    answers.shift()!(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(methods(frames)).toEqual(['report_agent', 'report_agent', 'report_metadata']);
    expect((frames[2]!.params.tokens as Record<string, string>).queue).toBe('1');
    answers.shift()!(true);
    await reporter.settled();
    const seqs = frames.slice(0, 3).map((f) => f.params.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test('같은 상태 연속 호출은 프레임 하나', async () => {
    const bag = collecting();
    const reporter = createHerdrSocketReporter({
      env: activeEnv, send: bag.send, log: bag.log, now: () => 0, schedule: manualTimers().schedule,
    })!;
    reporter.state('working');
    reporter.state('working');
    await reporter.settled();
    reporter.state('working');
    await reporter.settled();
    expect(bag.frames.filter((f) => f.method === 'pane.report_agent')).toHaveLength(1);
  });

  test('활성 동안 TTL 이 지나기 전에 메타를 다시 보낸다 (working·idle 모두)', async () => {
    const bag = collecting();
    const timers = manualTimers();
    let clock = 0;
    const reporter = createHerdrSocketReporter({
      env: activeEnv,
      send: bag.send,
      log: bag.log,
      model: 'grok-4.7',
      now: () => clock,
      schedule: timers.schedule,
    })!;
    reporter.state('working');
    await reporter.settled();
    expect(timers.live().map((t) => t.ms)).toEqual([30_000]);
    for (const [i, at] of [30_000, 60_000, 90_000].entries()) {
      clock = at;
      expect(timers.fire()).toBe(30_000);
      await reporter.settled();
      const metas = bag.frames.filter((f) => f.method === 'pane.report_metadata');
      expect(metas).toHaveLength(2 + i);
      expect(metas.at(-1)!.params).toMatchObject({ display_agent: 'eln·grok-4.7', ttl_ms: 60_000 });
      expect(timers.live()).toHaveLength(1);
    }
    expect(bag.frames.filter((f) => f.method === 'pane.report_agent')).toHaveLength(1);
    const metaSeqs = bag.frames.filter((f) => f.method === 'pane.report_metadata').map((f) => f.params.seq as number);
    expect(metaSeqs).toEqual([...metaSeqs].sort((a, b) => a - b));
    expect(new Set(metaSeqs).size).toBe(metaSeqs.length);
    reporter.state('idle');
    await reporter.settled();
    timers.fire();
    await reporter.settled();
    expect(methods(bag.frames).slice(-3)).toEqual(['report_agent', 'report_metadata', 'report_metadata']);
  });

  test('소켓 실패 뒤 같은 상태가 오래 이어져도 현재 상태를 다시 보낸다', async () => {
    const frames: HerdrSocketFrame[] = [];
    const logs: string[] = [];
    let up = false;
    const timers = manualTimers();
    const reporter = createHerdrSocketReporter({
      env: activeEnv,
      send: (frame) => { frames.push(frame); return up; },
      log: (event) => { logs.push(event); },
      model: 'grok-4.7',
      now: () => 0,
      retryMs: 1_000,
      schedule: timers.schedule,
    })!;
    reporter.state('working');
    await reporter.settled();
    expect(methods(frames)).toEqual(['report_agent']);
    // 실패한 상태는 «받은 것»이 아니다 — 같은 상태 재호출이 억제되어도 재시도 타이머가 살아 있다.
    reporter.state('working');
    await reporter.settled();
    expect(timers.live().map((t) => t.ms)).toEqual([1_000]);
    timers.fire();
    await reporter.settled();
    expect(methods(frames)).toEqual(['report_agent', 'report_agent']);
    expect(timers.live().map((t) => t.ms)).toEqual([2_000]);
    up = true;
    timers.fire();
    await reporter.settled();
    expect(methods(frames)).toEqual(['report_agent', 'report_agent', 'report_agent', 'report_metadata']);
    expect(frames[2]!.params.state).toBe('working');
    const [agentSeq, metaSeq] = frames.slice(2, 4).map((f) => f.params.seq as number);
    expect(metaSeq).toBeGreaterThan(agentSeq!);
    expect(logs).toContain('retry-scheduled');
    // 복구 뒤에는 재시도가 아니라 TTL 갱신 타이머.
    expect(timers.live().map((t) => t.ms)).toEqual([30_000]);
  });

  test('메타만 실패하면 상태는 다시 안 보내고 메타를 다시 보낸다', async () => {
    const frames: HerdrSocketFrame[] = [];
    let metaUp = false;
    const timers = manualTimers();
    const reporter = createHerdrSocketReporter({
      env: activeEnv,
      send: (frame) => { frames.push(frame); return frame.method !== 'pane.report_metadata' || metaUp; },
      log: () => {},
      model: 'grok-4.7',
      now: () => 0,
      schedule: timers.schedule,
    })!;
    reporter.state('working');
    await reporter.settled();
    expect(methods(frames)).toEqual(['report_agent', 'report_metadata']);
    metaUp = true;
    timers.fire();
    await reporter.settled();
    expect(methods(frames)).toEqual(['report_agent', 'report_metadata', 'report_metadata']);
  });

  test('모델은 메타를 보낼 때마다 다시 읽는다 · 모르면 display_agent 를 만들지 않는다', async () => {
    const bag = collecting();
    let model: string | undefined;
    const reporter = createHerdrSocketReporter({
      env: { ...activeEnv, ELANOUS_MODEL: 'env-model' },
      send: bag.send,
      log: bag.log,
      model: () => model,
      now: () => 0,
      schedule: manualTimers().schedule,
    })!;
    reporter.state('working');
    await reporter.settled();
    const first = bag.frames.find((f) => f.method === 'pane.report_metadata')!.params as Record<string, unknown>;
    // ELANOUS_MODEL 은 선택된 모델이 아니다 — 쓰지 않는다.
    expect(first.display_agent).toBeUndefined();
    expect(JSON.stringify(first)).not.toContain('eln·eln');
    expect(JSON.stringify(first)).not.toContain('env-model');
    expect(first.tokens).not.toHaveProperty('model');
    model = 'claude-opus-5.5';
    reporter.state('idle');
    await reporter.settled();
    const second = bag.frames.filter((f) => f.method === 'pane.report_metadata').at(-1)!.params as Record<string, unknown>;
    expect(second.display_agent).toBe('eln·claude-opus-5.5');
    expect((second.tokens as Record<string, string>).model).toBe('claude-opus-5.5');
  });

  test('release 는 줄 선 상태·메타를 버리고 진행 중 프레임 뒤에 한 번', async () => {
    const frames: HerdrSocketFrame[] = [];
    const answers: Array<(ok: boolean) => void> = [];
    const timers = manualTimers();
    const reporter = createHerdrSocketReporter({
      env: activeEnv,
      send: (frame) => { frames.push(frame); return new Promise<boolean>((resolve) => answers.push(resolve)); },
      log: () => {},
      now: () => 0,
      schedule: timers.schedule,
    })!;
    reporter.state('working');
    await new Promise((r) => setTimeout(r, 5));
    reporter.state('idle');
    reporter.metadata({ title: 'x' });
    reporter.release();
    reporter.state('working');
    answers.shift()!(true);
    await new Promise((r) => setTimeout(r, 5));
    answers.shift()?.(true);
    await reporter.settled();
    expect(methods(frames)).toEqual(['report_agent', 'release_agent']);
    expect(timers.live()).toHaveLength(0);
  });

  test('재기동 뒤 seq 는 직전 high-watermark 보다 크다', async () => {
    let stored: number | undefined;
    const seqStore: HerdrSeqStore = {
      read: () => stored,
      write: (seq) => { stored = seq; },
    };
    const first = collecting();
    const before = createHerdrSocketReporter({
      env: activeEnv,
      send: first.send,
      log: first.log,
      now: () => 1_700_000_000_000,
      seqStore,
      schedule: manualTimers().schedule,
    })!;
    before.state('working');
    await before.settled();
    const firstSeq = first.frames.find((f) => f.method === 'pane.report_agent')!.params.seq as number;
    const watermark = stored!;
    expect(watermark).toBeGreaterThan(firstSeq);

    const second = collecting();
    const after = createHerdrSocketReporter({
      env: activeEnv,
      send: second.send,
      log: second.log,
      now: () => 1_700_000_000_000,
      seqStore,
      schedule: manualTimers().schedule,
    })!;
    after.state('idle');
    await after.settled();
    const nextSeq = second.frames.find((f) => f.method === 'pane.report_agent')!.params.seq as number;
    expect(nextSeq).toBeGreaterThan(watermark);
  });

  test('send 가 던져도 밖으로 안 나가고 재시도를 건다', async () => {
    const bag = collecting();
    const timers = manualTimers();
    const reporter = createHerdrSocketReporter({
      env: activeEnv,
      send: () => { throw new Error('boom'); },
      log: bag.log,
      now: () => 0,
      schedule: timers.schedule,
    })!;
    expect(() => reporter.state('idle')).not.toThrow();
    await reporter.settled();
    expect(bag.logs.map(([e]) => e)).toEqual(['send-failed', 'retry-scheduled']);
    expect(timers.live()).toHaveLength(1);
  });

  test('가짜 유닉스 소켓: report_agent → report_metadata → release 순서 · error 응답은 재시도', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-sock-'));
    const sock = join(dir, 'h.sock');
    const got: HerdrSocketFrame[] = [];
    let rejectFirst = true;
    const server: Server = createServer((c) => {
      let buf = '';
      c.on('data', (chunk) => {
        buf += String(chunk);
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const frame = JSON.parse(line) as HerdrSocketFrame;
          got.push(frame);
          if (rejectFirst) {
            rejectFirst = false;
            c.write(`{"id":"${frame.id}","error":{"code":"busy","message":"x"}}\n`);
          } else {
            c.write(`{"id":"${frame.id}","result":{"type":"ok"}}\n`);
          }
          nl = buf.indexOf('\n');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    const timers = manualTimers();
    const logs: string[] = [];
    try {
      const reporter = createHerdrSocketReporter({
        env: { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: sock },
        model: 'grok-4.7',
        now: () => 0,
        log: (event) => { logs.push(event); },
        connectTimeoutMs: 1000,
        schedule: timers.schedule,
      })!;
      reporter.state('working');
      await reporter.settled();
      expect(logs).toEqual(['response-error', 'retry-scheduled']);
      timers.fire();
      await reporter.settled();
      reporter.release();
      await reporter.settled();
      expect(methods(got)).toEqual(['report_agent', 'report_agent', 'report_metadata', 'release_agent']);
      expect(got[1]!.params).toMatchObject({ state: 'working', source: 'elanous', agent: 'elanous', pane_id: 'w1:p1' });
      expect(got[1]!.params).not.toHaveProperty('metadata');
      expect(got[2]!.params).toMatchObject({ display_agent: 'eln·grok-4.7', ttl_ms: 60_000 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('releaseNow — exit 훅의 동기 반납', () => {
  test('이벤트 루프 없이 release_agent 한 프레임 · 뒤 상태는 안 보낸다', async () => {
    const c = collecting();
    const sync: HerdrSocketFrame[] = [];
    const reporter = createHerdrSocketReporter({ env: activeEnv, send: c.send, log: c.log, sendSync: (f) => { sync.push(f); return true; } })!;
    reporter.state('working');
    await reporter.settled();
    reporter.releaseNow();
    expect(sync.map((f) => f.method)).toEqual(['pane.release_agent']);
    expect(sync[0]!.params).toMatchObject({ pane_id: 'w4:pM', source: 'elanous', agent: 'elanous' });
    reporter.state('idle');
    reporter.releaseNow();
    reporter.release();
    await reporter.settled();
    expect(sync).toHaveLength(1);
    expect(c.frames.map((f) => f.method)).toEqual(['pane.report_agent', 'pane.report_metadata']);
    const seqs = [...c.frames, ...sync].map((f) => f.params.seq as number);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test('신호 지킴이가 이미 반납을 청했으면 아무것도 안 한다', async () => {
    const c = collecting();
    const sync: HerdrSocketFrame[] = [];
    const reporter = createHerdrSocketReporter({ env: activeEnv, send: c.send, log: c.log, sendSync: (f) => { sync.push(f); return true; } })!;
    reporter.release();
    reporter.releaseNow();
    await reporter.settled();
    expect(sync).toEqual([]);
    expect(c.frames.map((f) => f.method)).toEqual(['pane.release_agent']);
  });

  test('동기 전송 실패는 던지지 않고 한 줄', () => {
    const c = collecting();
    const reporter = createHerdrSocketReporter({ env: activeEnv, send: c.send, log: c.log, sendSync: () => { throw new Error('boom'); } })!;
    reporter.releaseNow();
    expect(c.logs.map(([e]) => e)).toContain('release-sync-failed');
  });

  test('writeHerdrSocketSync: 다른 프로세스의 유닉스 소켓에 보내고 result 를 기다린다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-sync-'));
    const sock = join(dir, 'h.sock');
    const server = Bun.spawn([process.execPath, '-e', [
      "const fs=require('node:fs');",
      "require('node:net').createServer(c=>{let b='';c.on('data',d=>{b+=d;if(!b.includes('\\n'))return;",
      "const f=JSON.parse(b.slice(0,b.indexOf('\\n')));console.log(JSON.stringify(f));",
      "c.end(JSON.stringify(f.params.fail?{id:f.id,error:{code:'x'}}:{id:f.id,result:{}})+'\\n')})})",
      ".listen(process.argv.at(-1),()=>console.log('ready'));",
    ].join(''), sock], { stdout: 'pipe', stderr: 'ignore' });
    try {
      const reader = server.stdout.getReader();
      let out = '';
      while (!out.includes('ready')) out += new TextDecoder().decode((await reader.read()).value);
      const frame: HerdrSocketFrame = { id: 'eln-9', method: 'pane.release_agent', params: { pane_id: 'p', seq: 7 } };
      expect(writeHerdrSocketSync(sock, frame, () => {})).toBe(true);
      const logs: string[] = [];
      expect(writeHerdrSocketSync(sock, { ...frame, params: { fail: true } }, (e) => logs.push(e))).toBe(false);
      expect(logs).toEqual(['send-sync-failed']);
      expect(writeHerdrSocketSync(join(dir, 'none.sock'), frame, () => {})).toBe(false);
      while (out.split('\n').filter((l) => l.startsWith('{')).length < 2) out += new TextDecoder().decode((await reader.read()).value);
      expect(JSON.parse(out.split('\n').find((l) => l.startsWith('{'))!)).toEqual(frame);
    } finally {
      server.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('seat title and elapsed', () => {
  test('seats/<SEAT> 를 제목으로', () => {
    expect(seatTitleFromCwd('/Users/a/elanous-hq/seats/HAND-GROK-1/eln')).toBe('HAND-GROK-1');
    expect(seatTitleFromCwd('/tmp/other')).toBe('other');
  });

  test('경과 표기', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(59_000)).toBe('59s');
    expect(formatElapsed(125_000)).toBe('2m');
    expect(formatElapsed(3_700_000)).toBe('1h');
  });
});
