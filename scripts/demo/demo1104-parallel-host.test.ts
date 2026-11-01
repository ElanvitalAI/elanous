import { expect, test } from 'bun:test';
import { DisplayCoordinator } from '../../src/display/coordinator.js';
import { simAgentRegistry } from '../../src/ux-sim/interaction.js';
import { PreviewTerminal, type PreviewRegistryDeps } from '../../src/preview/terminal.js';
import { TerminalSessionRegistry } from '../../src/terminal/session-registry.js';
import { spawnCodingAgent } from '../../src/terminal/coding-agent.js';
import { DEMO1104_STAGE_CONFIG } from './demo1104-stage.config.js';
import { startDemo1104ParallelHost } from './demo1104-parallel-host.js';
import type { DemoSurfaceAdapter } from './demo1104-parallel-scenes.js';

const VIDEO_SOURCES = Object.fromEntries(['V1', 'V2', 'V3', 'V4', 'V5', 'V6'].map(id => [id, `file:///demo/${id}.mp4`]));
const idleSurface = (): DemoSurfaceAdapter => ({ async start() {}, async runAct() {}, async showVideo() {} });

test('host starts both real coding-agent sessions through the session registry and runs both missions', async () => {
  const ptys: Array<{ cmd: string; workdir?: string; writes: string[]; killed: string[] }> = [];
  const listeners: Array<(event: never) => void> = [];
  const previewDeps: PreviewRegistryDeps = {
    startPty(opts) {
      const pty = { cmd: opts.cmd, workdir: opts.workdir, writes: [] as string[], killed: [] as string[] };
      ptys.push(pty);
      return {
        id: `preview_${String(ptys.length).padStart(8, '0')}`,
        kind: 'preview', cmd: opts.cmd, pid: 1, workdir: opts.workdir, startedAt: 1, cols: opts.cols ?? 80, rows: opts.rows ?? 24,
        accessMode: 'write', transitionPolicy: 'open', setAccessMode: () => true, setTransitionPolicy() {}, setNickname() {},
        isAlive: () => true, canWrite: () => true,
        write(bytes: string) { pty.writes.push(bytes); }, resize() {}, kill(signal?: NodeJS.Signals) { pty.killed.push(signal ?? ''); },
      } as never;
    },
    onPtyEvent(callback) { listeners.push(callback as never); return () => {}; },
    unregisterPty() { return true; },
  };
  const registry = new TerminalSessionRegistry({
    coordinator: new DisplayCoordinator(),
    terminalFactory: (opts, spawn) => new PreviewTerminal({ ...opts, useRegistry: true }, spawn, previewDeps),
  });
  const agents = simAgentRegistry();
  const missions: string[] = [];
  const started = await startDemo1104ParallelHost({
    registry,
    cwd: '/demo',
    termSize: () => ({ cols: 120, rows: 40 }),
    videoSources: VIDEO_SOURCES,
    spawnAgent: (opts, spawnDeps) => spawnCodingAgent(opts, {
      ...spawnDeps,
      whichBinary: (binary) => `/mock-bin/${binary}`,
      wrapCommand: (command) => command,
    }),
    webRunGraph: idleSurface(),
    telegram: idleSurface(),
    async runMission(session, act) {
      const task = agents.register({ name: `mission-${session.agentBrand}`, systemPrompt: 'demo simulation' }, act.title);
      await agents.runManaged(task.id, async () => {
        missions.push(`${session.agentBrand}:${act.id}:${session.id}`);
        return session.command;
      });
    },
    async showVideo() {},
  });

  const sessions = registry.list();
  expect(sessions.map(session => session.agentBrand).sort()).toEqual(['claude-code', 'codex']);
  expect(sessions.every(session => session.kind === 'coding-agent' && session.command)).toBe(true);
  expect(ptys).toHaveLength(2);
  expect(ptys.every(pty => pty.workdir === '/demo')).toBe(true);
  expect(started.snapshot.surfaces.map(surface => surface.status)).toEqual(['ready', 'ready', 'ready', 'ready']);
  expect(started.snapshot.lanes.map(lane => lane.status)).toEqual(['started', 'started']);

  await started.stage.runActNow('act-2');
  expect(missions).toHaveLength(2);
  expect(agents.list('done')).toHaveLength(2);
  expect(started.stage.snapshot().acts.find(act => act.id === DEMO1104_STAGE_CONFIG.acts[2]!.id)?.status).toBe('live');
  for (const session of sessions) registry.kill(session.id);
  expect(ptys.every(pty => pty.killed.length === 1)).toBe(true);
});
