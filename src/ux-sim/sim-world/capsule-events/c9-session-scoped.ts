// C9 session-scoped completions (ELN-CAPSULE-COMPLETION-SCOPED): two seat sessions built from the tree REPL tool set
// (buildReplTools · isolated --config-dir = the universe root) run background RunShell capsules at the same time; each
// session's next-turn drain must take only its own completion. A third, idle session's supplement Agent completion
// must surface as one queued notice through the real capsule-done frame path, without opening a turn.
// Unmeasured here: the shared persisted queue file across separate REPL processes (FU ③) and the self-implement
// success notice (FU ④).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRegistry } from '../../../agent/registry.js';
import { globalTaskNotificationQueue } from '../../../agent/task-notification.js';
import { buildReplTools, watchCapsuleDone } from '../../../repl/index.js';
import { resetShellRunnerDeps } from '../../../shell-runner/dispatch.js';
import { resetShellRegistry } from '../../../shell-runner/registry.js';
import { testRunShellIssuer as issuer } from '../../../shell-primitive/runshell-test-issuer.js';
import { RUNSHELL_APPROVAL_RESULT, type RunShellApprovalCall } from '../../../tui-client/next-runshell-approval.js';
import { wireCapsuleDoneKnock } from '../../../tui/capsule-done-knock.js';
import { CAPSULE_FRAME_PREFIX, parseCapsuleFrame } from '../../../turn-capsule/capsule-frame.js';
import type { CapsuleEvent } from '../../../turn-capsule/contract.js';
import { drainNextTuiNotifications } from '../../../turn-capsule/session-drain.js';
import type { SimWorldScenario } from '../types.js';

const LABEL_A = 'c9 capsule of seat A';
const LABEL_B = 'c9 capsule of seat B';
const NOTICE_WAIT_MS = 5_000;

async function concurrentShellDrains(): Promise<{ a: string[]; b: string[] }> {
  const ours = (label: string | undefined) => label === LABEL_A || label === LABEL_B;
  let queued = 0;
  const stopCount = globalTaskNotificationQueue.onEnqueue((n) => { if (ours(n.label)) queued++; });
  try {
    const toolsA = buildReplTools({ nextTui: true, sessionId: 'c9-seat-A' });
    const toolsB = buildReplTools({ nextTui: true, sessionId: 'c9-seat-B' });
    const shell = (marker: string, description: string) => ({
      command: ['/bin/sh', '-c', `sleep 0.2; printf "${marker}\\n"`], cwd: '/tmp', mode: 'bg', description,
    });
    const started = await Promise.all([
      toolsA.dispatch('RunShell', shell('C9_A_DONE', LABEL_A)),
      toolsB.dispatch('RunShell', shell('C9_B_DONE', LABEL_B)),
    ]) as Array<{ outcome?: string }>;
    if (started.some((row) => row.outcome !== 'started')) throw new Error(`bg RunShell did not start: ${JSON.stringify(started)}`);
    // The completion notice is filed in each handle's settle continuation — wait until both are queued.
    const deadline = Date.now() + NOTICE_WAIT_MS;
    while (queued < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    stopCount();
  }
  const a = drainNextTuiNotifications(globalTaskNotificationQueue, 'c9-seat-A').filter((n) => ours(n.label)).map((n) => n.label!);
  const b = drainNextTuiNotifications(globalTaskNotificationQueue, 'c9-seat-B').filter((n) => ours(n.label)).map((n) => n.label!);
  return { a, b };
}

function idleSupplementNotice(): { notices: string[]; knocks: number } {
  const registry = new AgentRegistry();
  const listeners: Array<(event: CapsuleEvent) => void> = [];
  const watch = watchCapsuleDone('c9-seat-idle', registry, new Set(), (line) => {
    const event = parseCapsuleFrame(line.slice(CAPSULE_FRAME_PREFIX.length).trimEnd(), 'c9-seat-idle');
    if (event) for (const listener of listeners) listener(event);
  });
  const notices: string[] = [];
  let knocks = 0;
  const stop = wireCapsuleDoneKnock({
    sessionId: 'c9-seat-idle',
    subscribe: (_sessionId, listener) => { listeners.push(listener); return () => undefined; },
    enqueue: (event) => { notices.push(`${event.kind} ${event.summary}`); return true; },
    knock: () => { knocks++; },
    busy: () => false,
  });
  const task = registry.spawn({ definition: { name: 'general', description: 'd', systemPrompt: 'p' }, prompt: 'go',
    background: true, parentSessionId: 'c9-seat-idle', completionDelivery: 'supplement', label: 'c9 supplement' } as never).task;
  task.state = 'done';
  task.startedAt = 1_000;
  task.finishedAt = 3_000;
  registry.notifyTaskDone(task);
  stop();
  watch.dispose();
  return { notices, knocks };
}

const c9Scene: SimWorldScenario = {
  id: 'C9-SESSION-SCOPED',
  title: 'concurrent seat sessions each receive only their own capsule completion; an idle seat sees a supplement',
  async run(ctx) {
    const root = ctx.universeRoot;
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const saved = { config: process.env.ELANOUS_CONFIG_DIR, seat: process.env.ELANOUS_TRACK, send: process.send };
    const connected = Object.getOwnPropertyDescriptor(process, 'connected');
    process.env.ELANOUS_CONFIG_DIR = root;
    process.env.ELANOUS_TRACK = 'c9-sim-seat';
    Object.defineProperty(process, 'connected', { configurable: true, value: true });
    (process as unknown as { send: (message: RunShellApprovalCall) => boolean }).send = (message) => {
      queueMicrotask(() => process.emit('message' as never, { type: RUNSHELL_APPROVAL_RESULT, callId: message.callId,
        approval: issuer.issue(message.request) } as never));
      return true;
    };
    resetShellRunnerDeps();
    resetShellRegistry();
    try {
      const drains = await concurrentShellDrains();
      const idle = idleSupplementNotice();
      ctx.recorder.event('c9-session-scoped', { ...drains, ...idle });
      if (JSON.stringify(drains.a) !== JSON.stringify([LABEL_A]) || JSON.stringify(drains.b) !== JSON.stringify([LABEL_B]))
        return { ok: false, reason: 'a seat session drained another session\'s capsule completion',
          diff: `seat A got ${JSON.stringify(drains.a)}, seat B got ${JSON.stringify(drains.b)}` };
      if (JSON.stringify(idle.notices) !== JSON.stringify(['agent c9 supplement · ok · 2s']) || idle.knocks !== 0)
        return { ok: false, reason: 'idle seat does not see a supplement completion',
          diff: `notices ${JSON.stringify(idle.notices)}, knocks ${idle.knocks}` };
      return { ok: true };
    } finally {
      resetShellRunnerDeps();
      resetShellRegistry();
      (process as unknown as { send: unknown }).send = saved.send;
      if (connected) Object.defineProperty(process, 'connected', connected); else delete (process as unknown as { connected?: boolean }).connected;
      if (saved.config === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = saved.config;
      if (saved.seat === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = saved.seat;
    }
  },
};

export const simWorldScenarios: readonly SimWorldScenario[] = [c9Scene];
