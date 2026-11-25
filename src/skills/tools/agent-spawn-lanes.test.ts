import { describe, expect, test } from 'bun:test';
import { AgentSpawnGuard, guardedAgentSpawn, shortLaneArgs } from './agent-spawn-guard.js';

// CAPSULE-POOL-SHORT-LANE — short lane cap 8 and long lane cap 3 counted apart; one short capsule per key; TTL / token cap.
function harness() {
  let clock = 5_000_000;
  const tasks = new Map<string, { state: string; finishedAt?: number; tokens?: number }>();
  const stopped: string[] = [];
  const reports: Array<Record<string, unknown>> = [];
  const guard = new AgentSpawnGuard({
    now: () => clock,
    taskState: (id) => tasks.get(id),
    stopTask: (id) => { stopped.push(id); tasks.set(id, { state: 'aborted', finishedAt: clock }); },
    onShortStopped: (report) => reports.push({ ...report }),
  });
  let n = 0;
  const seen: Array<Record<string, unknown>> = [];
  const spawn = (args: Record<string, unknown>) => guardedAgentSpawn(args, async () => {
    seen.push({ ...args });
    const taskId = `t${++n}`;
    tasks.set(taskId, { state: 'running', tokens: 100 });
    return { taskId, background: true };
  }, guard, 'OP');
  return { guard, spawn, tasks, stopped, reports, seen, advance: (ms: number) => { clock += ms; } };
}

const shortSpawn = (i: number) => ({ description: `reply pr ${i}`, name: `mail pr${i}`, prompt: `answer the review question on pr${i}`, reason: 'one mail action', lane: 'short', key: `pr:${i}` });
const longSpawn = (word: string) => ({ description: `${word} survey`, prompt: `survey the ${word} module`, reason: 'large output' });

describe('agent spawn lanes', () => {
  test('8 short capsules and 3 long agents run at once; the 9th short and the 4th long are refused', async () => {
    const h = harness();
    for (let i = 1; i <= 8; i++) await h.spawn(shortSpawn(i));
    for (const word of ['alpha', 'beta', 'gamma']) await h.spawn(longSpawn(word));
    expect(h.guard.runningByLane('OP')).toEqual({ short: 8, long: 3 });
    await expect(h.spawn(shortSpawn(9))).rejects.toThrow('NOT SPAWNED — 8 short-lane capsules are already running for this seat (limit 8): mail pr1, mail pr2, mail pr3, mail pr4, mail pr5, mail pr6, mail pr7, mail pr8.');
    await expect(h.spawn(longSpawn('delta'))).rejects.toThrow('NOT SPAWNED — 3 agents are already running for this seat (limit 3): alpha survey, beta survey, gamma survey.');
  });

  test('a full long lane does not block the short lane', async () => {
    const h = harness();
    for (const word of ['alpha', 'beta', 'gamma']) await h.spawn(longSpawn(word));
    await expect(h.spawn(shortSpawn(1))).resolves.toMatchObject({ taskId: 't4', background: true });
  });

  test('one short capsule per key while it runs', async () => {
    const h = harness();
    await h.spawn(shortSpawn(7));
    await expect(h.spawn({ ...shortSpawn(7), name: 'other name', description: 'other', prompt: 'a different brief for the same pull request' }))
      .rejects.toThrow('NOT SPAWNED — a short capsule already works pr:7: mail pr7. Correct it instead: AgentSend(mail pr7, …).');
    h.tasks.set('t1', { state: 'done', finishedAt: 5_000_000 });
    h.guard.markConsumed('t1');
    await expect(h.spawn({ ...shortSpawn(7), name: 'other name', description: 'other', prompt: 'a different brief for the same pull request' })).resolves.toMatchObject({ taskId: 't2' });
  });

  test('short lane runs in the background with a capped tool budget and the brief header', async () => {
    const h = harness();
    await h.spawn({ ...shortSpawn(3), run_in_background: false, max_turns: 40 });
    expect(h.seen[0]).toMatchObject({ run_in_background: true, max_turns: 12 });
    expect(String(h.seen[0]!.prompt)).toBe(
      'Short-lane task for pr:3. Finish within 10 minutes and about 40k tokens; you are stopped after that.\n' +
      'Do only what the brief asks. If you are blocked, stop at once and say why.\n' +
      'Answer with DONE or BLOCKED on the first line, then at most 5 lines of evidence (commands run, ids, links).\n\n' +
      'answer the review question on pr3',
    );
    expect(shortLaneArgs({ prompt: 'x', max_turns: 4 }, 'msg:1')).toMatchObject({ max_turns: 4, run_in_background: true });
  });

  test('a short capsule past 10 minutes is stopped and reported exactly once; the slot reopens', async () => {
    const h = harness();
    await h.spawn(shortSpawn(1));
    h.advance(9 * 60_000 + 59_999);
    expect(h.guard.sweepShortLane()).toBe(0);
    h.advance(1);
    expect(h.guard.sweepShortLane()).toBe(1);
    expect(h.guard.sweepShortLane()).toBe(0);
    expect(h.stopped).toEqual(['t1']);
    expect(h.reports).toEqual([{ seat: 'OP', name: 'mail pr1', key: 'pr:1', taskId: 't1', reason: 'ttl-killed', tokens: 100, ageMs: 600_000 }]);
    expect(h.guard.runningByLane('OP')).toEqual({ short: 0, long: 0 });
  });

  test('a short capsule over its token cap is stopped once; long agents are never swept', async () => {
    const h = harness();
    await h.spawn(shortSpawn(2));
    await h.spawn(longSpawn('alpha'));
    h.tasks.set('t1', { state: 'running', tokens: 40_000 });
    h.tasks.set('t2', { state: 'running', tokens: 900_000 });
    h.advance(60_000);
    expect(h.guard.sweepShortLane()).toBe(1);
    expect(h.stopped).toEqual(['t1']);
    expect(h.reports.map((report) => report.reason)).toEqual(['token-cap']);
  });
});
