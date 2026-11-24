import type { SimWorldScenario } from '../types.js';
import { S3AgentFixture } from './s3-agent-fixture.js';
import { countSessionBackgroundFanout, dispatchAgent } from '../../../skills/tools/agent.js';
import { SessionCache } from '../../../session/cache.js';
import { dispatchAgentStop } from '../../../agent/agent-stop-tool.js';
import { globalAgentRegistry } from '../../../agent/registry.js';
import type { LLMProvider } from '../../../llm.js';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { globalTaskNotificationQueue, resolveTaskNotificationPaths } from '../../../agent/task-notification.js';
import { drainNextTuiNotifications } from '../../../turn-capsule/session-drain.js';

// The parent next-turn execution remains unmeasured.
export const simWorldScenarios: readonly SimWorldScenario[] = [{
  id: 'S3-AGENT', title: 'scripted subagent faults and production boundary',
  async run(ctx) {
    // Global notification storage is allowed only inside the explicitly stamped test universe.
    const stateRoot = process.env.ELANOUS_STATE_DIR;
    const dataRoot = process.env.ELANOUS_DATA_DIR;
    const inside = (root: string, path: string) => {
      const rel = relative(resolve(root), resolve(path));
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    };
    if (!stateRoot || !dataRoot || !inside(stateRoot, ctx.universeRoot) || !inside(stateRoot, dataRoot))
      return { ok: false, reason: 'S3 isolated notification storage not established', diff: 'Explicit isolated state and data roots required.' };
    const fixture = new S3AgentFixture(event => ctx.recorder.event('s3-fixture', event));
    fixture.start('held', 'hold', 'pending');
    fixture.stop('held');
    fixture.start('duplicate', 'duplicate', 'done');
    const releases: Array<() => void> = [];
    const payload = 'S3-result-' + 'x'.repeat(700) + '-END';
    const parentSessionId = `s3-parent-${ctx.seed}`;
    const wakes: string[] = [];
    const offWake = globalTaskNotificationQueue.onEnqueue((n) => {
      if (n.parentSessionId === parentSessionId) wakes.push(n.taskId);
    });
    const provider: LLMProvider = {
      name: 's3-gated', defaultModel: 's3-gated', available: () => true,
      async *streamChat() { const index = releases.length; await new Promise<void>(resolve => releases.push(resolve)); yield { type: 'text', delta: index === 0 ? payload : 'S3 child complete' }; },
      async *chat() {},
    };
    const cache = new SessionCache();
    const opts = { provider, sessionCache: cache, parentSessionId };
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5_000;
      while (!predicate()) { if (Date.now() >= deadline) throw new Error('S3 admission wait timed out'); await new Promise(r => setTimeout(r, 10)); }
    };
    try {
      const launches: Array<Awaited<ReturnType<typeof dispatchAgent>>> = [];
      for (let i = 0; i < 8; i++) launches.push(await dispatchAgent({ description: `s3 child ${i}`, prompt: `s3 child prompt ${i}`, run_in_background: true }, opts));
      await until(() => releases.length === 8);
      let admitted = false;
      const queued = dispatchAgent({ description: 's3 queued', prompt: 's3 queued child', run_in_background: true, wait_for_slot: true }, opts);
      void queued.then(() => { admitted = true; });
      await new Promise(r => setTimeout(r, 100));
      const before = { live: countSessionBackgroundFanout(cache), admitted, calls: releases.length };
      releases[0]!();
      await until(() => admitted && releases.length === 9);
      const after = { live: countSessionBackgroundFanout(cache), admitted, calls: releases.length };
      ctx.recorder.event('s3-admission-observed', { before, after });
      await until(() => wakes.includes(launches[0]!.taskId));
      const notices = drainNextTuiNotifications(globalTaskNotificationQueue, parentSessionId);
      const notice = notices.find((n) => n.taskId === launches[0]!.taskId);
      const resultDir = resolveTaskNotificationPaths().resultDir;
      const resultPath = notice?.resultPath;
      const preserved = !!resultPath && inside(resultDir, resultPath) && readFileSync(resultPath, 'utf8') === payload;
      const delivery = { wakes: wakes.filter(id => id === launches[0]!.taskId).length,
        matching: notices.filter(n => n.taskId === launches[0]!.taskId).length,
        state: notice?.state, truncated: notice?.truncated, summaryLength: notice?.output.length,
        preserved, secondDrain: drainNextTuiNotifications(globalTaskNotificationQueue, parentSessionId).length };
      ctx.recorder.event('s3-completion-overflow-observed', delivery);
      if (delivery.wakes !== 1 || delivery.matching !== 1 || delivery.state !== 'done' ||
          !delivery.truncated || delivery.summaryLength !== 500 || !preserved || delivery.secondDrain !== 0)
        return { ok: false, reason: 'S3 completion notification or overflow mismatch', diff: JSON.stringify(delivery) };
      if (before.live !== 8 || before.admitted || before.calls !== 8 || after.live !== 8 || !after.admitted || after.calls !== 9)
        return { ok: false, reason: 'S3 admission queue mismatch', diff: JSON.stringify({ before, after }) };
      const target = await queued;
      const deniedStop = await dispatchAgentStop({ taskId: target.taskId }, { requester: 's3-foreign-session' });
      if (deniedStop.stopStatus !== 'refused' || countSessionBackgroundFanout(cache) !== after.live)
        return { ok: false, reason: 'S3 foreign AgentStop was not refused without effect', diff: deniedStop.stopStatus };
      const stop = await dispatchAgentStop({ taskId: target.taskId }, { requester: parentSessionId });
      releases[8]!();
      await until(() => countSessionBackgroundFanout(cache) === 7);
      const state = globalAgentRegistry.get(target.taskId)?.state;
      ctx.recorder.event('s3-stop-observed', { stopStatus: stop.stopStatus, deniedStatus: deniedStop.stopStatus, state, live: countSessionBackgroundFanout(cache) });
      if (stop.stopStatus !== 'success' || state !== 'aborted' || countSessionBackgroundFanout(cache) !== 7)
        return { ok: false, reason: 'S3 AgentStop mismatch', diff: JSON.stringify({ stopStatus: stop.stopStatus, state, live: countSessionBackgroundFanout(cache) }) };
      return { ok: false, reason: 'S3 production Agent boundary unmeasured',
        diff: 'Agent admission, stop, queue wake, session drain and result preservation passed; actual next parent turn is unmeasured.' };
    } finally {
      for (const release of releases) release();
      await until(() => countSessionBackgroundFanout(cache) === 0);
      offWake();
      drainNextTuiNotifications(globalTaskNotificationQueue, parentSessionId);
    }
  },
}];
