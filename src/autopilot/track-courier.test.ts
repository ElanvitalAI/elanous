import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../task-orchestrator/store.js';
import { createTask } from '../task-orchestrator/types.js';
import { buildUserConfig, setUserConfigOverlay } from '../user-config.js';
import { debug } from '../debug/log.js';
import { createMission } from './mission-registry.js';
import { approveMission } from './mission-engine.js';
import { deliverMissionPhases, routeMissionPhases, trackAlive } from './track-courier.js';

const now = Date.parse('2026-09-28T12:00:00Z');
const config = { enabled: true, channelPr: 20798, handoffMinutes: 60 };
function fixture() {
  const store = new TaskStore({ path: ':memory:' });
  const mission = createMission(store, { goal: '다트랙 임무', source: 'human-intent', triage: { executionModel: 'task' } });
  const tasks = [
    ['라이브 탭', 'PWA 탭'],
    ['티저 제작', '영상 티저'],
    ['미정 페이즈', '전혀 다른 작업'],
  ].map(([title, prompt], index) => {
    const task = createTask({ title: title!, description: prompt!, surface: { kind: 'subagent', definitionName: 'general-purpose', prompt: prompt! },
      goalSlug: mission.id, generatedBy: { kind: 'user', actorId: 'test' }, status: 'backlog' }, { now: now + index });
    store.saveTask(task);
    return task;
  });
  return { store, mission, tasks };
}
const comments = () => [
  { body: '**[F]** 사람이 쓴 글', created_at: new Date(now - 12 * 60_000).toISOString() },
  { body: '**[T]** 마지막 발신', created_at: new Date(now - 90 * 60_000).toISOString() },
  { body: '앞에 텍스트 **[T]** 는 내 발신 아님', created_at: new Date(now - 1_000).toISOString() },
];

describe('track courier', () => {
  test('F recent, T stale, undecided → human, agent, unassigned', async () => {
    const { store, mission, tasks } = fixture();
    try {
      const routed = await routeMissionPhases(mission.id, { store, config, now, listComments: comments });
      expect(routed[1]?.prompt).toBe('영상 티저');
      expect(routed.map(({ taskId, track, route, reason }) => ({ taskId, track, route, reason }))).toEqual([
        { taskId: tasks[0]!.id, track: 'F', route: 'human', reason: '12분 전 발신' },
        { taskId: tasks[1]!.id, track: 'T', route: 'agent', reason: '90분 무발신' },
        { taskId: tasks[2]!.id, track: null, route: 'unassigned', reason: 'none' },
      ]);
      expect(await trackAlive('T', { now, config, listComments: comments })).toEqual({ alive: false, lastPostAt: new Date(now - 90 * 60_000).toISOString(), reason: 'stale' });
      expect(await trackAlive('O', { now, config, listComments: comments })).toEqual({ alive: false, lastPostAt: null, reason: 'no-post' });
    } finally { store.close(); }
  });

  test('failed comment lookup is unmeasured and goes to the human, not agent', async () => {
    const { store, mission } = fixture();
    try {
      const routed = await routeMissionPhases(mission.id, { store, config, now, listComments: () => { throw new Error('offline'); } });
      expect(routed[0]).toMatchObject({ track: 'F', route: 'human', reason: 'unmeasured' });
      expect(routed[1]).toMatchObject({ track: 'T', route: 'human', reason: 'unmeasured' });
    } finally { store.close(); }
  });

  test('one comment has courier header, phase routes and claim instructions with task IDs', async () => {
    const { store, mission, tasks } = fixture();
    const sent: string[] = [];
    try {
      await deliverMissionPhases(mission.id, { store, config, now, listComments: comments, post: (body) => { sent.push(body); } });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.split('\n')).toEqual([
        `**[E]** {{TS}} 🧭 미션 ${mission.id} 승인됨 — 페이즈 배달`,
        `→ 🅕 라이브 탭 · human(12분 전 발신) · ${tasks[0]!.id}`,
        `→ 🅣 티저 제작 · agent(90분 무발신 · 트랙 에이전트 대기 — R5) · ${tasks[1]!.id}`,
        `→ 🅢 미정 페이즈 · unassigned(트랙 미정) · ${tasks[2]!.id}`,
        '집으면 이 코멘트에 `[<트랙>] 집음 <taskId>` 로 답',
      ]);
    } finally { store.close(); }
  });

  test('enabled track agent runs only agent routes without blocking delivery and posts an E result', async () => {
    const { store, mission, tasks } = fixture();
    const sent: string[] = [];
    let finish!: (value: { status: 'launched'; detail: string }) => void;
    const pending = new Promise<{ status: 'launched'; detail: string }>((resolve) => { finish = resolve; });
    const executed: string[] = [];
    const agentRunner = {
      decideTrackAction: async (input: { taskId: string; prompt: string; missionId: string; track: string }) => {
        expect(input.prompt).toBe('영상 티저');
        expect(input.missionId).toBe(mission.id);
        expect(input.track).toBe('T');
        return { action: 'say' as const, reason: input.taskId };
      },
      executeTrackAction: async (decision: { reason?: string }) => {
        executed.push(decision.reason!);
        return pending;
      },
    };
    try {
      await deliverMissionPhases(mission.id, { store, config, trackAgent: { enabled: true }, agentRunner,
        now, listComments: comments, post: (body) => { sent.push(body); } });
      expect(sent).toHaveLength(1);
      expect(executed).toHaveLength(0);
      expect(sent[0]).toContain(`→ 🅣 티저 제작 · agent(90분 무발신 · 트랙 에이전트 대기 — R5) · ${tasks[1]!.id}`);
      for (let i = 0; i < 10 && !executed.length; i++) await Bun.sleep(1);
      expect(executed).toEqual([tasks[1]!.id]);
      finish({ status: 'launched', detail: 'detached harness say' });
      for (let i = 0; i < 10 && sent.length < 2; i++) await Bun.sleep(1);
      expect(sent[1]).toBe(`**[E]** {{TS}} T · ${tasks[1]!.id} · launched · detached harness say`);
    } finally { store.close(); }
  });

  test('multiple independent agent routes are scheduled after the delivery post', async () => {
    const { store, mission, tasks } = fixture();
    const extra = createTask({ title: '영상 후속편', description: '영상 후속편',
      surface: { kind: 'subagent', definitionName: 'general-purpose', prompt: '영상 후속편' },
      goalSlug: mission.id, generatedBy: { kind: 'user', actorId: 'test' }, status: 'backlog' }, { now: now + 10 });
    store.saveTask(extra);
    const sent: string[] = [];
    const decisions: string[] = [];
    try {
      await deliverMissionPhases(mission.id, { store, config, trackAgent: { enabled: true }, now,
        listComments: comments, agentRunner: {
          decideTrackAction: ({ taskId }) => { decisions.push(taskId); return { action: 'say' }; },
          executeTrackAction: () => ({ status: 'launched' }),
        }, post: (body) => { sent.push(body); } });
      for (let i = 0; i < 20 && sent.length < 3; i++) await Bun.sleep(1);
      expect(decisions).toEqual([tasks[1]!.id, extra.id]);
      expect(sent).toHaveLength(3);
      expect(sent[1]).toBe(`**[E]** {{TS}} T · ${tasks[1]!.id} · launched`);
      expect(sent[2]).toBe(`**[E]** {{TS}} T · ${extra.id} · launched`);
    } finally { store.close(); }
  });

  test('agent result post failure does not change the delivered phase comment', async () => {
    const { store, mission } = fixture();
    const sent: string[] = [];
    try {
      await deliverMissionPhases(mission.id, { store, config, trackAgent: { enabled: true }, now,
        listComments: comments, agentRunner: {
          decideTrackAction: () => ({ action: 'say' }),
          executeTrackAction: () => ({ status: 'launched' }),
        }, post: (body) => { sent.push(body); if (sent.length === 2) throw new Error('offline'); } });
      for (let i = 0; i < 20 && !debug.events(20).some(({ event }) => event === 'agent-result-post-failed'); i++) await Bun.sleep(1);
      expect(sent).toHaveLength(2);
      expect(sent[0]).toContain('승인됨 — 페이즈 배달');
      expect(sent[1]).toContain('**[E]**');
      expect(debug.events(20).some(({ category, event, data }) => category === 'autopilot.track-courier'
        && event === 'agent-result-post-failed' && (data as { taskId?: string }).taskId === sent[1]!.split(' · ')[1]
        && (data as { missionId?: string }).missionId === mission.id)).toBe(true);
    } finally { store.close(); }
  });

  test('enabling track agent preserves every byte of the existing phase delivery post', async () => {
    const { store, mission } = fixture();
    const baseline: string[] = [];
    const enabled: string[] = [];
    let finish!: (result: { status: 'launched' }) => void;
    const pending = new Promise<{ status: 'launched' }>((resolve) => { finish = resolve; });
    try {
      await deliverMissionPhases(mission.id, { store, config, trackAgent: { enabled: false }, now,
        listComments: comments, post: (body) => { baseline.push(body); } });
      await deliverMissionPhases(mission.id, { store, config, trackAgent: { enabled: true }, now,
        listComments: comments, agentRunner: {
          decideTrackAction: () => ({ action: 'say' }),
          executeTrackAction: () => pending,
        }, post: (body) => { enabled.push(body); } });
      expect(enabled).toEqual(baseline);
    } finally { finish({ status: 'launched' }); await Bun.sleep(1); store.close(); }
  });

  test('the agent result line redacts secrets and stays a single line', async () => {
    const { store, mission } = fixture();
    const sent: string[] = [];
    try {
      await deliverMissionPhases(mission.id, { store, config, trackAgent: { enabled: true }, now,
        listComments: comments, agentRunner: {
          decideTrackAction: () => ({ action: 'say' }),
          executeTrackAction: () => ({ status: 'launched', detail: 'Bearer abcdefghijklmnop\nnext' }),
        }, post: (body) => { sent.push(body); } });
      for (let i = 0; i < 10 && sent.length < 2; i++) await Bun.sleep(1);
      expect(sent[1]).toContain('Bearer *** next');
      expect(sent[1]?.split('\n')).toHaveLength(1);
    } finally { store.close(); }
  });

  test('a recent human route is not dispatched while a stale agent route is', async () => {
    const { store, mission, tasks } = fixture();
    const decisions: string[] = [];
    let finish!: (value: { status: 'launched' }) => void;
    const pending = new Promise<{ status: 'launched' }>((resolve) => { finish = resolve; });
    try {
      await deliverMissionPhases(mission.id, { store, config, trackAgent: { enabled: true }, now,
        listComments: comments, agentRunner: {
          decideTrackAction: (input) => { decisions.push(input.taskId); return { action: 'say' }; },
          executeTrackAction: () => pending,
        }, post: () => {} });
      for (let i = 0; i < 10 && decisions.length === 0; i++) await Bun.sleep(1);
      expect(decisions).toEqual([tasks[1]!.id]);
      finish({ status: 'launched' });
    } finally { store.close(); }
  });

  test('unmeasured liveness never dispatches an agent even when enabled', async () => {
    const { store, mission } = fixture();
    const sent: string[] = [];
    let decisions = 0;
    try {
      await deliverMissionPhases(mission.id, { store, config, trackAgent: { enabled: true }, now,
        listComments: () => { throw new Error('lookup offline'); }, agentRunner: {
          decideTrackAction: () => { decisions++; return { action: 'say' }; },
          executeTrackAction: () => ({ status: 'launched' }),
        }, post: (body) => { sent.push(body); } });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('human(unmeasured)');
      expect(decisions).toBe(0);
    } finally { store.close(); }
  });

  test('failed phase delivery never starts a track agent', async () => {
    const { store, mission } = fixture();
    let decisions = 0;
    try {
      await deliverMissionPhases(mission.id, { store, config, trackAgent: { enabled: true }, now,
        listComments: comments, agentRunner: {
          decideTrackAction: () => { decisions++; return { action: 'say' }; },
          executeTrackAction: () => ({ status: 'launched' }),
        }, post: () => { throw new Error('delivery offline'); } });
      await Bun.sleep(1);
      expect(decisions).toBe(0);
    } finally { store.close(); }
  });

  test('agent execution failure is observed without a result post or a changed delivery', async () => {
    const { store, mission } = fixture();
    const sent: string[] = [];
    try {
      await deliverMissionPhases(mission.id, { store, config, trackAgent: { enabled: true }, now,
        listComments: comments, agentRunner: {
          decideTrackAction: () => ({ action: 'say' }),
          executeTrackAction: () => { throw new Error('agent offline'); },
        }, post: (body) => { sent.push(body); } });
      for (let i = 0; i < 20 && !debug.events(20).some(({ event, data }) => event === 'agent-failed'
        && (data as { missionId?: string }).missionId === mission.id); i++) await Bun.sleep(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('승인됨 — 페이즈 배달');
      expect(debug.events(20).some(({ category, event, data }) => category === 'autopilot.track-courier'
        && event === 'agent-failed' && (data as { error?: string }).error === 'agent offline')).toBe(true);
    } finally { store.close(); }
  });

  test('configured trackAgent.enabled is used without an injected switch', async () => {
    const { store, mission } = fixture();
    let decisions = 0;
    const sent: string[] = [];
    setUserConfigOverlay((cfg) => ({ ...cfg, autopilot: { ...cfg.autopilot,
      trackAgent: { enabled: true, maxConcurrent: 2 } } }));
    try {
      await deliverMissionPhases(mission.id, { store, config, now, listComments: comments,
        agentRunner: {
          decideTrackAction: () => { decisions++; return { action: 'say' }; },
          executeTrackAction: () => ({ status: 'launched' }),
        }, post: (body) => { sent.push(body); } });
      for (let i = 0; i < 10 && sent.length < 2; i++) await Bun.sleep(1);
      expect(decisions).toBe(1);
      expect(sent).toHaveLength(2);
    } finally { setUserConfigOverlay(null); store.close(); }
  });

  test('agent decision failure is observed without a result post', async () => {
    const { store, mission } = fixture();
    const sent: string[] = [];
    try {
      await deliverMissionPhases(mission.id, { store, config, trackAgent: { enabled: true }, now,
        listComments: comments, agentRunner: {
          decideTrackAction: () => { throw new Error('decision offline'); },
          executeTrackAction: () => { throw new Error('must not execute'); },
        }, post: (body) => { sent.push(body); } });
      for (let i = 0; i < 20 && !debug.events(20).some(({ event, data }) => event === 'agent-failed'
        && (data as { missionId?: string }).missionId === mission.id); i++) await Bun.sleep(1);
      expect(sent).toHaveLength(1);
      expect(debug.events(20).some(({ event, data }) => event === 'agent-failed'
        && (data as { error?: string }).error === 'decision offline')).toBe(true);
    } finally { store.close(); }
  });

  test('a disabled courier does not dispatch even if track agent is enabled', async () => {
    const { store, mission } = fixture();
    let decisions = 0;
    try {
      await deliverMissionPhases(mission.id, { store, config: { ...config, enabled: false },
        trackAgent: { enabled: true }, now, listComments: comments, agentRunner: {
          decideTrackAction: () => { decisions++; return { action: 'say' }; },
          executeTrackAction: () => ({ status: 'launched' }),
        }, post: () => { throw new Error('should not post'); } });
      expect(decisions).toBe(0);
    } finally { store.close(); }
  });

  test('disabled track agent leaves only the existing delivery comment', async () => {
    const { store, mission } = fixture();
    const sent: string[] = [];
    let decisions = 0;
    try {
      await deliverMissionPhases(mission.id, { store, config, trackAgent: { enabled: false }, now,
        listComments: comments, agentRunner: {
          decideTrackAction: () => { decisions++; return { action: 'say' }; },
          executeTrackAction: () => ({ status: 'launched' }),
        }, post: (body) => { sent.push(body); } });
      expect(sent).toHaveLength(1);
      expect(decisions).toBe(0);
    } finally { store.close(); }
  });

  test('disabled and channel missing post zero comments', async () => {
    const { store, mission } = fixture();
    let count = 0;
    try {
      await deliverMissionPhases(mission.id, { store, config: { ...config, enabled: false }, post: () => { count++; } });
      await deliverMissionPhases(mission.id, { store, config: { enabled: true }, post: () => { count++; } });
      expect(count).toBe(0);
    } finally { store.close(); }
  });

  test('approveMission single and multi preserve result and spawn on disabled, enabled, and failed post', async () => {
    for (const multi of [false, true]) {
      const results = [];
      for (const enabled of [false, true]) {
        const { store, mission, tasks } = fixture();
        try {
          if (!multi) { store.deleteTask(tasks[1]!.id); store.deleteTask(tasks[2]!.id); }
          const spawned: string[] = [];
          let posted = 0;
          let finishPost!: () => void;
          const postStarted = new Promise<void>((resolve) => { finishPost = resolve; });
          const result = await approveMission(mission.id, { store, now, spawnRun: (id) => { spawned.push(id); },
            courier: { config: { ...config, enabled }, listComments: comments, post: () => {
              posted++;
              finishPost();
              throw new Error('posting failed');
            } } });
          if (enabled) await postStarted;
          else await Promise.resolve();
          results.push(result);
          expect(posted).toBe(enabled ? 1 : 0);
          expect(result).toEqual(multi
            ? { ok: true, activated: 3, note: '3 root 페이즈 ready (나머지 deps 대기)' }
            : { ok: true, activated: 1 });
          expect(spawned).toEqual([mission.id]);
        } finally { store.close(); }
      }
      expect(results[1]).toEqual(results[0]);
    }
  });

  test('approval does not wait for an unresolved courier post', async () => {
    const { store, mission, tasks } = fixture();
    store.deleteTask(tasks[1]!.id);
    store.deleteTask(tasks[2]!.id);
    try {
      let started!: () => void;
      const postStarted = new Promise<void>((resolve) => { started = resolve; });
      const result = await approveMission(mission.id, { store, now, spawnRun: () => {},
        courier: { config, listComments: comments, post: () => { started(); return new Promise<void>(() => {}); } } });
      expect(result).toEqual({ ok: true, activated: 1 });
      await postStarted;
    } finally { store.close(); }
  });

  test('track agent config is opt-in and concurrency is bounded to two', () => {
    const dir = mkdtempSync(join(tmpdir(), 'courier-agent-config-'));
    try {
      const path = join(dir, 'config.json');
      writeFileSync(path, JSON.stringify({ autopilot: { trackAgent: {} } }));
      expect(buildUserConfig(path).autopilot?.trackAgent).toEqual({ enabled: false, maxConcurrent: 2 });
      writeFileSync(path, JSON.stringify({ autopilot: { trackAgent: { enabled: true, maxConcurrent: 99 } } }));
      expect(buildUserConfig(path).autopilot?.trackAgent).toEqual({ enabled: true, maxConcurrent: 2 });
      writeFileSync(path, JSON.stringify({ autopilot: { trackAgent: { enabled: true, maxConcurrent: 1 } } }));
      expect(buildUserConfig(path).autopilot?.trackAgent).toEqual({ enabled: true, maxConcurrent: 1 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('config parses enabled/channel/handoff and defaults to off/60', () => {
    const dir = mkdtempSync(join(tmpdir(), 'courier-config-'));
    try {
      const path = join(dir, 'config.json');
      writeFileSync(path, JSON.stringify({ autopilot: { trackCourier: config } }));
      expect(buildUserConfig(path).autopilot?.trackCourier).toEqual(config);
      writeFileSync(path, JSON.stringify({ autopilot: { trackCourier: { enabled: 'true', channelPr: -1, handoffMinutes: 0 } } }));
      expect(buildUserConfig(path).autopilot?.trackCourier).toEqual({ enabled: false, handoffMinutes: 60 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
