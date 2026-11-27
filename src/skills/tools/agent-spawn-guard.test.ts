import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import { AgentSpawnGuard, guardedAgentSpawn, isVerificationSpawn, wordJaccard } from './agent-spawn-guard.js';
import { agentSpendLabel, safeAgentSpend, toolActivityLines, toolActivityTarget, updateToolActivity, type ToolActivityRow } from '../../tui/chat/tool-activity.js';

// A fake task ledger: background agents stay "running" until the test finishes them.
function harness(seat = 'TC-H-CX-1') {
  let clock = 1_000_000;
  const tasks = new Map<string, { state: string; finishedAt?: number }>();
  const guard = new AgentSpawnGuard({ now: () => clock, taskState: id => tasks.get(id), isCoordinator: s => s === 'OP' || s === 'TC' });
  let n = 0;
  const spawn = (args: Record<string, unknown>) => guardedAgentSpawn(args, async () => {
    const taskId = `t${++n}`;
    tasks.set(taskId, { state: 'running' });
    return { taskId, background: true };
  }, guard, seat);
  const finish = (taskId: string) => tasks.set(taskId, { state: 'done', finishedAt: clock });
  const advance = (ms: number) => { clock += ms; };
  return { guard, spawn, finish, advance };
}

describe('agent spawn guard rules', () => {
  test('reason is required', async () => {
    const h = harness();
    await expect(h.spawn({ description: 'list roster', prompt: 'list the roster ledger rows' }))
      .rejects.toThrow('NOT SPAWNED — Agent needs `reason`');
    await expect(h.spawn({ description: 'list roster', prompt: 'list the roster ledger rows', reason: 'large output' }))
      .resolves.toMatchObject({ taskId: 't1', background: true });
  });

  test('fourth concurrent agent is refused, a slot reopens when one finishes', async () => {
    const h = harness();
    await h.spawn({ description: 'alpha survey', prompt: 'survey alpha module tests', reason: 'large output' });
    await h.spawn({ description: 'beta survey', prompt: 'survey beta pipeline docs', reason: 'large output' });
    await h.spawn({ description: 'gamma survey', prompt: 'survey gamma release notes', reason: 'large output' });
    await expect(h.spawn({ description: 'delta survey', prompt: 'survey delta config files', reason: 'large output' }))
      .rejects.toThrow('NOT SPAWNED — 3 agents are already running for this seat (limit 3): alpha survey, beta survey, gamma survey. Wait for one and integrate its result, or do this yourself.');
    h.finish('t1');
    await expect(h.spawn({ description: 'delta survey', prompt: 'survey delta config files', reason: 'large output' }))
      .resolves.toMatchObject({ taskId: 't4', background: true });
  });

  test('COORD-RIGHTS: a coordinator seat (OP · TC) runs 8 long-lane agents; the 9th is refused', async () => {
    for (const seat of ['OP', 'TC']) {
      const h = harness(seat);
      const topics = ['alpha module', 'beta pipeline', 'gamma release', 'delta config', 'epsilon ledger', 'zeta roster', 'eta router', 'theta mail'];
      for (const [i, t] of topics.entries()) {
        await expect(h.spawn({ description: `${t} survey`, prompt: `survey ${t} ${i} files`, reason: 'parallel' })).resolves.toMatchObject({ background: true });
      }
      await expect(h.spawn({ description: 'iota survey', prompt: 'survey iota widgets', reason: 'parallel' }))
        .rejects.toThrow(`NOT SPAWNED — 8 agents are already running for this seat (limit 8): ${topics.map(t => `${t} survey`).join(', ')}.`);
    }
  });

  test('same normalized name is a duplicate until its result is consumed', async () => {
    const h = harness();
    await h.spawn({ description: 'Roster carry-over', prompt: 'move 18 roster rows to next release', reason: 'bulk' });
    await expect(h.spawn({ description: 'roster  carry over', prompt: 'something else entirely here', reason: 'bulk' }))
      .rejects.toThrow('NOT SPAWNED — same work already delegated: Roster carry-over — integrate its result, or correct it instead: AgentSend(Roster carry-over, …).');
    h.finish('t1');
    h.advance(60_000);
    await expect(h.spawn({ description: 'roster carry over', prompt: 'something else entirely here', reason: 'bulk' }))
      .rejects.toThrow('same work already delegated: Roster carry-over');
    h.guard.markConsumed('t1');
    await expect(h.spawn({ description: 'roster carry over', prompt: 'something else entirely here', reason: 'bulk' }))
      .resolves.toMatchObject({ taskId: 't2', background: true });
  });

  test('prompt Jaccard at or above 0.6 is a duplicate; finished work ages out after 15 minutes', async () => {
    const h = harness();
    // words: a b c d e  vs  a b c d f → 4 shared / 6 total = 0.667
    expect(wordJaccard('alpha bravo charlie delta echo', 'alpha bravo charlie delta foxtrot')).toBeCloseTo(0.667, 3);
    await h.spawn({ description: 'first', prompt: 'alpha bravo charlie delta echo', reason: 'r' });
    await expect(h.spawn({ description: 'second', prompt: 'alpha bravo charlie delta foxtrot', reason: 'r' }))
      .rejects.toThrow('same work already delegated: first');
    // 3 shared / 7 total = 0.43 → allowed
    await expect(h.spawn({ description: 'third', prompt: 'alpha bravo charlie golf hotel', reason: 'r' }))
      .resolves.toMatchObject({ taskId: 't2', background: true });
    h.finish('t1');
    h.advance(15 * 60_000 + 1);
    await expect(h.spawn({ description: 'fourth', prompt: 'alpha bravo charlie delta foxtrot', reason: 'r' }))
      .resolves.toMatchObject({ taskId: 't3', background: true });
  });

  test('templated fan-out workers that differ in the parameter their names carry are not duplicates', async () => {
    const h = harness();
    // 6 shared / 8 total = 0.75, but «b» is only in the new prompt and is in its name
    await h.spawn({ description: 'probe A', prompt: 'Investigate A and answer in one line', reason: 'fan-out' });
    await expect(h.spawn({ description: 'probe B', prompt: 'Investigate B and answer in one line', reason: 'fan-out' }))
      .resolves.toMatchObject({ taskId: 't2', background: true });
    // same template, the differing word is not in the name → a rephrased duplicate
    await expect(h.spawn({ description: 'another look', prompt: 'Investigate A and answer in two line', reason: 'fan-out' }))
      .rejects.toThrow('same work already delegated: probe A');
  });

  test('verifying a still-running agent of the same goal is refused; after it finishes it is allowed once', async () => {
    const h = harness();
    await h.spawn({ description: 'bulk move roster', prompt: 'move the 18 roster rows of release ledger to next release', reason: 'bulk' });
    expect(isVerificationSpawn('independent check', 'verify the roster move')).toBe(true);
    await expect(h.spawn({ description: 'independent check', prompt: 'verify the 18 roster rows moved to next release', reason: 'second opinion' }))
      .rejects.toThrow('NOT SPAWNED — wait for bulk move roster; verify once after. To change its course, correct it instead: AgentSend(bulk move roster, …).');
    // a verification of unrelated work is not a chain
    await expect(h.spawn({ description: 'check lint', prompt: 'check eslint warnings in docs folder', reason: 'side' }))
      .resolves.toMatchObject({ taskId: 't2', background: true });
    h.finish('t1');
    h.guard.markConsumed('t1');
    await expect(h.spawn({ description: 'independent check', prompt: 'verify the 18 roster rows moved to next release', reason: 'once after' }))
      .resolves.toMatchObject({ taskId: 't3', background: true });
  });

  test('a foreground spawn counts as consumed when it returns; a dispatcher refusal frees the record', async () => {
    let clock = 0;
    const guard = new AgentSpawnGuard({ now: () => clock, taskState: () => undefined });
    await guardedAgentSpawn({ description: 'fg one', prompt: 'p q r', reason: 'r' }, async () => ({ taskId: 'x1' }), guard, 'OP');
    await expect(guardedAgentSpawn({ description: 'fg one', prompt: 'p q r', reason: 'r' }, async () => ({ taskId: 'x2' }), guard, 'OP'))
      .resolves.toMatchObject({ taskId: 'x2' });
    await guardedAgentSpawn({ description: 'queued', prompt: 's t u', reason: 'r' }, async () => ({ taskId: 'dedup' }), guard, 'OP');
    await expect(guardedAgentSpawn({ description: 'queued', prompt: 's t u', reason: 'r' }, async () => ({ taskId: 'x3' }), guard, 'OP'))
      .resolves.toMatchObject({ taskId: 'x3' });
  });

  test('seats are separate', async () => {
    const guard = new AgentSpawnGuard({ now: () => 0, taskState: () => ({ state: 'running' }) });
    const run = async () => ({ taskId: 'bg', background: true });
    await guardedAgentSpawn({ description: 'same', prompt: 'a b', reason: 'r' }, run, guard, 'OP');
    await expect(guardedAgentSpawn({ description: 'same', prompt: 'a b', reason: 'r' }, run, guard, 'TC'))
      .resolves.toMatchObject({ taskId: 'bg', background: true });
  });
});

describe('spawn line shows the reason', () => {
  test('Agent row renders «🤖 name — reason»; without a reason the old Agent(desc) row stays', () => {
    const args = { description: 'roster list', name: 'roster lister', prompt: 'x', reason: 'ledger output is long' };
    let rows: ToolActivityRow[] = [];
    rows = updateToolActivity(rows, { phase: 'start', id: 'a1', name: 'Agent', target: toolActivityTarget('Agent', args) }, 0);
    rows = updateToolActivity(rows, { phase: 'start', id: 'a2', name: 'Agent', target: toolActivityTarget('Agent', { description: 'plain', prompt: 'y' }) }, 0);
    const lines = toolActivityLines(rows, 0).map(line => line.slice(2));
    expect(lines).toEqual(['\u{1F916} roster lister — ledger output is long', 'Agent(plain)']);
  });
});

describe('synthetic replay of the 07:0x OP incident', () => {
  test('four spawns in order', async () => {
    const h = harness();
    const attempts = [
      { description: '열여덟 번째 발화 확인', prompt: '로스터 원장에서 18번째 발화 칸 목록을 확인하라', reason: '원장 출력이 길다' },
      { description: '18건 일괄 로스터 반영', prompt: '로스터 원장의 18건을 다음 판으로 일괄 이동해 반영하라', reason: '일괄 이동' },
      { description: '능력 공백 기존선 확인', prompt: '18건 로스터 이동 전에 능력 공백 기존선을 확인하라', reason: '사전 점검' },
      { description: '로스터 이월 독립 검증', prompt: '18건 로스터 일괄 이월 반영 결과를 독립적으로 검증하라', reason: '독립 검증' },
    ];
    const outcome: string[] = [];
    for (const args of attempts) {
      try {
        await h.spawn(args);
        outcome.push(`allowed ${args.description}`);
      } catch (error) {
        outcome.push(`refused ${args.description} :: ${(error as Error).message}`);
      }
    }
    console.log(outcome.join('\n'));
    expect(outcome).toEqual([
      'allowed 열여덟 번째 발화 확인',
      'allowed 18건 일괄 로스터 반영',
      'allowed 능력 공백 기존선 확인',
      'refused 로스터 이월 독립 검증 :: NOT SPAWNED — wait for 18건 일괄 로스터 반영; verify once after. To change its course, correct it instead: AgentSend(18건 일괄 로스터 반영, …).',
    ]);
  });
});

describe('seat identity', () => {
  test('env first, then the innermost seats/<SEAT> directory, else local', async () => {
    const { currentSeat } = await import('./agent-spawn-guard.js');
    expect(currentSeat({ ELANOUS_TRACK: 'OPT' }, '/h/seats/OP')).toBe('OPT');
    expect(currentSeat({}, '/h/elanous-hq/seats/OP/.claude/wt/seats/tc')).toBe('TC');
    expect(currentSeat({}, '/tmp/x')).toBe('local');
  });
});

describe('token spend', () => {
  test('estimate is ~4 characters per token over prompt, conversation and result', async () => {
    const { estimateTaskTokens, formatTokens } = await import('./agent-spawn-guard.js');
    expect(estimateTaskTokens({ prompt: 'a'.repeat(400), messages: [{ content: 'b'.repeat(3600) }], result: 'c'.repeat(4000) })).toBe(2000);
    expect(formatTokens(850)).toBe('850 tok');
    expect(formatTokens(42_400)).toBe('42k tok');
  });

  test('a spawn reports its tokens and the seat total for the goal; the row shows both', async () => {
    const tasks = new Map<string, { state: string; finishedAt?: number; tokens?: number }>([
      ['old', { state: 'done', finishedAt: 0, tokens: 40_000 }],
      ['new', { state: 'done', finishedAt: 0, tokens: 3_000 }],
    ]);
    const guard = new AgentSpawnGuard({ now: () => 0, taskState: id => tasks.get(id) });
    await guardedAgentSpawn({ description: 'first pass', prompt: 'alpha', reason: 'r' }, async () => ({ taskId: 'old', output: 'A' }), guard, 'OP', 'goal-1');
    const result = await guardedAgentSpawn({ description: 'second pass', prompt: 'bravo', reason: 'r' }, async () => ({ taskId: 'new', output: 'B done' }), guard, 'OP', 'goal-1');
    expect(result.spend).toEqual({ tokens: 3000, goalTokens: 43000 });
    expect(result.output).toBe('B done');
    // another goal starts from zero
    const other = await guardedAgentSpawn({ description: 'third pass', prompt: 'charlie', reason: 'r' }, async () => ({ taskId: 'new', output: 'C' }), guard, 'OP', 'goal-2');
    expect(other.spend).toEqual({ tokens: 3000, goalTokens: 3000 });

    let rows: ToolActivityRow[] = [];
    const args = { description: 'second pass', prompt: 'bravo', reason: 'needs long ledger read' };
    rows = updateToolActivity(rows, { phase: 'start', id: 'a1', name: 'Agent', target: toolActivityTarget('Agent', args) }, 0);
    rows = updateToolActivity(rows, { phase: 'finish', id: 'a1', name: 'Agent', summary: 'B done', spend: agentSpendLabel(result) }, 0);
    expect(toolActivityLines(rows, 0)).toEqual(['✓ \u{1F916} second pass — needs long ledger read · 3k tok · goal 43k tok · B done']);
    expect(safeAgentSpend('3k tok · goal 43k tok; rm -rf')).toBeUndefined();
  });
});

describe('agent.abandoned', () => {
  function capture() {
    const seen: Array<Record<string, unknown>> = [];
    const spy = spyOn(debug, 'log').mockImplementation(((category: string, _event: string, data?: Record<string, unknown>) => {
      if (category === 'agent.abandoned') seen.push(data ?? {});
    }) as typeof debug.log);
    return { seen, restore: () => spy.mockRestore() };
  }

  test('a finished result nobody consumed within 15 minutes is logged never-consumed', async () => {
    const log = capture();
    try {
      let clock = 0;
      const tasks = new Map<string, { state: string; finishedAt?: number; tokens?: number }>();
      const guard = new AgentSpawnGuard({ now: () => clock, taskState: id => tasks.get(id) });
      await guardedAgentSpawn({ description: 'ledger scan', prompt: 'scan', reason: 'r' }, async () => {
        tasks.set('bg1', { state: 'running', tokens: 12_000 });
        return { taskId: 'bg1', background: true };
      }, guard, 'OP');
      tasks.set('bg1', { state: 'done', finishedAt: 0, tokens: 12_000 });
      clock = 15 * 60_000;
      guard.prune();
      expect(log.seen).toEqual([]);
      clock = 15 * 60_000 + 1;
      guard.prune();
      expect(log.seen).toEqual([{ seat: 'OP', name: 'ledger scan', tokens: 12000, reason: 'never-consumed' }]);
      guard.prune();
      expect(log.seen).toHaveLength(1);
    } finally { log.restore(); }
  });

  test('a consumed result is not abandoned', async () => {
    const log = capture();
    try {
      let clock = 0;
      const tasks = new Map<string, { state: string; finishedAt?: number; tokens?: number }>([['bg1', { state: 'done', finishedAt: 0, tokens: 5 }]]);
      const guard = new AgentSpawnGuard({ now: () => clock, taskState: id => tasks.get(id) });
      await guardedAgentSpawn({ description: 'read one', prompt: 'x', reason: 'r' }, async () => ({ taskId: 'bg1', background: true }), guard, 'OP');
      guard.markConsumed('bg1');
      clock = 60 * 60_000;
      guard.prune();
      expect(log.seen).toEqual([]);
    } finally { log.restore(); }
  });

  test('a near-duplicate spawn after an unread agent logs it superseded once', async () => {
    const log = capture();
    try {
      const tasks = new Map<string, { state: string; finishedAt?: number; tokens?: number }>([['bg1', { state: 'running', tokens: 7_000 }]]);
      const guard = new AgentSpawnGuard({ now: () => 0, taskState: id => tasks.get(id) });
      await guardedAgentSpawn({ description: 'roster move', prompt: 'move the 18 roster rows to next release', reason: 'r' }, async () => ({ taskId: 'bg1', background: true }), guard, 'OP');
      await expect(guardedAgentSpawn({ description: 'roster move again', prompt: 'move the 18 roster rows to the next release', reason: 'r' }, async () => ({ taskId: 'bg2', background: true }), guard, 'OP'))
        .rejects.toThrow('correct it instead: AgentSend(roster move, …)');
      await expect(guardedAgentSpawn({ description: 'roster move', prompt: 'other words', reason: 'r' }, async () => ({ taskId: 'bg3', background: true }), guard, 'OP'))
        .rejects.toThrow('same work already delegated');
      expect(log.seen).toEqual([{ seat: 'OP', name: 'roster move', tokens: 7000, reason: 'superseded' }]);
    } finally { log.restore(); }
  });
});
