import { expect, test } from 'bun:test';
import { runVisibleAgentMissionPair } from './visible-agent-mission-pair.js';
import type { VisibleMissionPty, VisibleMissionResult } from './visible-agent-mission.js';

const result = (path: string): VisibleMissionResult => ({
  ok: true, path, firstLine: '# result', promptReady: true, missionVisible: true, promptReturned: true, completionMarker: true,
});

test('spawns both visible agents before dispatch and returns both verified result files', async () => {
  const events: string[] = [];
  const pty = (agent: string): VisibleMissionPty => ({ snapshot: () => agent, write: () => {}, isAlive: () => true });
  let releaseCodex: () => void = () => {};
  const codexGate = new Promise<void>((resolve) => { releaseCodex = resolve; });
  let markClaudeStarted: () => void = () => {};
  const claudeStarted = new Promise<void>((resolve) => { markClaudeStarted = resolve; });
  const completion = runVisibleAgentMissionPair({
    spawn: (agent) => { events.push(`spawn:${agent}`); return pty(agent); },
    run: async (agent, mission) => {
      events.push(`run:${agent}:${mission}`);
      if (agent === 'codex') await codexGate;
      else markClaudeStarted();
      return result(`/${agent}.md`);
    },
  }, 'codex', 'implement', 'review');

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const secondStarted = await Promise.race([
    claudeStarted.then(() => true),
    new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 2_000); }),
  ]);
  if (timeout) clearTimeout(timeout);
  releaseCodex();
  const pair = await completion;

  expect(secondStarted).toBe(true);
  expect(events.slice(0, 2)).toEqual(['spawn:codex', 'spawn:claude']);
  expect(events.slice(2)).toEqual(['run:codex:implement', 'run:claude:review']);
  expect(pair).toMatchObject({ ok: true, codex: { path: '/codex.md' }, claude: { path: '/claude.md' } });
});

test('does not dispatch either mission when one visible agent PTY cannot start', async () => {
  const events: string[] = [];
  const pty: VisibleMissionPty = { snapshot: () => '', write: () => {}, isAlive: () => true };
  const pair = await runVisibleAgentMissionPair({
    spawn: (agent) => { events.push(`spawn:${agent}`); return agent === 'codex' ? pty : null; },
    run: async () => { events.push('run'); return result('/unexpected.md'); },
    dispose: () => events.push('dispose'),
  }, 'codex', 'implement', 'review');

  expect(pair).toMatchObject({ ok: false, error: 'claude sidetab PTY could not start; neither mission was dispatched' });
  expect(events).toEqual(['spawn:codex', 'spawn:claude', 'dispose']);
});

test('cleans up the first PTY and dispatches neither mission when the second spawn throws', async () => {
  const events: string[] = [];
  const pty: VisibleMissionPty = { snapshot: () => '', write: () => {}, isAlive: () => true };
  const pair = await runVisibleAgentMissionPair({
    spawn: (agent) => {
      events.push(`spawn:${agent}`);
      if (agent === 'claude') throw new Error('startup exploded');
      return pty;
    },
    run: async () => { events.push('run'); return result('/unexpected.md'); },
    dispose: () => { events.push('dispose'); throw new Error('cleanup reported after disposal'); },
  }, 'codex', 'implement', 'review');

  expect(pair).toMatchObject({ ok: false, error: 'claude sidetab PTY could not start; neither mission was dispatched: startup exploded' });
  expect(events).toEqual(['spawn:codex', 'spawn:claude', 'dispose']);
});

test('does not start the other agent when the first PTY cannot spawn', async () => {
  const events: string[] = [];
  const pair = await runVisibleAgentMissionPair({
    spawn: (agent) => { events.push(`spawn:${agent}`); return null; },
    run: async () => { events.push('run'); return result('/unexpected.md'); },
  }, 'claude', 'review', 'implement');

  expect(pair).toMatchObject({ ok: false, error: 'claude sidetab PTY could not start; neither mission was dispatched' });
  expect(events).toEqual(['spawn:claude']);
});
