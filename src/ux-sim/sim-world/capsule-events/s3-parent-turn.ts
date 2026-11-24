import { writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { SimWorldScenario } from '../types.js';
import { globalTaskNotificationQueue } from '../../../agent/task-notification.js';
import { dispatchAgent } from '../../../skills/tools/agent.js';
import { SessionCache } from '../../../session/cache.js';
import { ensureCliSession } from '../../../session/chat.js';
import { loadSession } from '../../../session/index.js';
import { getUserConfig } from '../../../user-config.js';
import { runRepl } from '../../../repl/index.js';
import type { LLMProvider } from '../../../llm.js';

export const simWorldScenarios: readonly SimWorldScenario[] = [{
  id: 'S3-TURN', title: 'background Agent completion reaches the next real REPL turn',
  async run(ctx) {
    const root = process.env.ELANOUS_STATE_DIR;
    const data = process.env.ELANOUS_DATA_DIR;
    const inside = (base: string, child: string) => {
      const path = relative(resolve(base), resolve(child));
      return path !== '' && !path.startsWith('..') && !isAbsolute(path);
    };
    if (!root || !data || !inside(root, data) || !inside(root, ctx.universeRoot))
      return { ok: false, reason: 'S3 isolated notification storage not established', diff: 'Explicit isolated state and data roots required.' };
    const values: Record<string, string> = {
      ELANOUS_SIM_UNIVERSE: '1', ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_LLM_MODE: 'fake',
      ELANOUS_NEXT_TUI_BG_STATUS: '1', ELANOUS_TEST_FAKE_LLM_RESPONSE: 'PARENT_DID_NOT_SEE_NOTICE',
      ELANOUS_TEST_FAKE_LLM_RESPONSE_RULES: JSON.stringify([{ when: 'S3-COMPLETION-MARKER', text: 'PARENT_SAW_NOTICE' }, { when: 'S3 child work', text: 'S3-COMPLETION-MARKER' }]),
    };
    const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    Object.assign(process.env, values);
    let offWake: (() => void) | undefined;
    try {
      const cfg = getUserConfig();
      const parent = ensureCliSession(cfg);
      const scenario = join(ctx.universeRoot, 'parent-turn.yaml');
      writeFileSync(scenario, 'turns:\n  - prompt: Continue the parent task\n');
      const wakes: string[] = [];
      const childOutputs: string[] = [];
      offWake = globalTaskNotificationQueue.onEnqueue(n => { if (n.parentSessionId === parent.id) { wakes.push(n.taskId); childOutputs.push(n.output); } });
      const provider: LLMProvider = {
        name: 's3-child', defaultModel: 's3-child', available: () => true,
        async *streamChat() { yield { type: 'text', delta: 'S3-COMPLETION-MARKER' }; }, async *chat() {},
      };
      const child = await dispatchAgent({ description: 'S3 child', prompt: 'S3 child work', run_in_background: true },
        { provider, sessionCache: new SessionCache(), parentSessionId: parent.id });
      const deadline = Date.now() + 5_000;
      while (!wakes.includes(child.taskId)) {
        if (Date.now() >= deadline) throw new Error('S3 child completion timed out');
        await new Promise(done => setTimeout(done, 10));
      }
      const opts = { cfg, initialSessionId: parent.id, forceNew: false, enableTools: false,
        scenarioPath: scenario, scriptedFromStdin: false, jsonOutput: true, exitAfterScenario: true, nextTui: true };
      const firstExit = await runRepl(opts);
      const firstMessages = loadSession(parent.id)?.messages ?? [];
      const firstReply = firstMessages.filter(m => m.role === 'assistant').at(-1)?.content;
      const secondExit = await runRepl(opts);
      const secondMessages = loadSession(parent.id)?.messages ?? [];
      const secondReply = secondMessages.filter(m => m.role === 'assistant').at(-1)?.content;
      const observed = { wakes: wakes.filter(id => id === child.taskId).length, childOutputs, firstExit, firstReply, secondExit, secondReply };
      ctx.recorder.event('s3-parent-turn-observed', observed);
      if (observed.wakes !== 1 || firstExit !== 0 || firstReply !== 'PARENT_SAW_NOTICE' ||
          secondExit !== 0 || secondReply !== 'PARENT_DID_NOT_SEE_NOTICE')
        return { ok: false, reason: 'S3 next parent turn delivery mismatch', diff: JSON.stringify(observed) };
      return { ok: true };
    } finally {
      offWake?.();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  },
}];
