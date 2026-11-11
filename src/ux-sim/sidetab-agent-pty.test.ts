import { expect, test } from 'bun:test';
import { createSidetabAttachmentController } from '../tui/sidetab/attach.js';
import { runNextTuiBranchRoute, type SidetabRouteHost } from '../tui/branches/sidetab/route.js';
import type { TerminalSession, TerminalSessionRegistry, SessionSpawnSpec } from '../terminal/session-registry.js';
import { sidetabAgentLaunch } from '../tui-client/sidetab-agent-pty.js';

test('fake codex, claude and hermes PTYs launch in sidetab, receive input and expose screen', async () => {
  const sessions = new Map<string, TerminalSession>();
  const launches: SessionSpawnSpec[] = [];
  const registry = {
    spawn(spec: SessionSpawnSpec) {
      launches.push(spec);
      let screen = `${spec.title} ready\n`;
      let pending = '';
      const session = {
        id: spec.id!, title: spec.title, cwd: spec.cwd, kind: spec.kind,
        agentBrand: spec.agentBrand, state: 'foreground', exitCode: null,
        preview: {
          get isAlive() { return session.state !== 'exited'; },
          renderForLLM: () => screen,
          write: (bytes: string) => {
            for (const char of bytes) {
              if (char === '\r') { screen += `received:${pending}\r`; pending = ''; }
              else pending += char;
            }
            return true;
          },
        },
      } as TerminalSession;
      sessions.set(session.id, session);
      return session;
    },
    get: (id: string) => sessions.get(id),
    detach: (id: string) => { const session = sessions.get(id); if (session) session.state = 'background'; return session; },
    subscribe: () => () => {},
    list: () => [...sessions.values()],
    kill: (id: string) => { const session = sessions.get(id); if (session) session.state = 'exited'; return session; },
  } as unknown as TerminalSessionRegistry;
  const statuses: string[] = [];
  const screens: string[] = [];
  const controller = createSidetabAttachmentController({
    drawBase: () => {}, termSize: () => ({ cols: 80, rows: 24 }),
    setStatus: (message) => statuses.push(message), drawRemoteFrame: () => {}, terminalRegistry: registry,
  });
  let selectedId = '';
  const row = () => ({ id: selectedId, label: selectedId, kind: 'agent', badge: 'idle' as const, sessionId: selectedId });
  const host: SidetabRouteHost = {
    state: () => ({ open: true, viewMode: 'current', rememberedOpen: true }),
    setEnabled: () => {}, rememberOpen: () => {}, setViewMode: () => {}, setNewMode: () => {},
    clearExpandedWorkspaces: () => {}, toggle: async () => {}, refreshRows: () => {}, killSelected: async () => false,
    spawnSideAgent: async (agent) => { selectedId = controller.spawnSideAgent(agent) ?? ''; return selectedId; },
    sendSelectedAgent: async (input) => controller.sendSideAgent(row(), input),
    readSelectedAgent: async () => controller.readSideAgent(row()),
    addHelp: (...lines) => screens.push(...lines), setStatus: (message) => statuses.push(message),
  };
  try {
    for (const agent of ['codex', 'claude', 'hermes'] as const) {
      await runNextTuiBranchRoute(`/side agent ${agent}`, host);
      expect(selectedId.startsWith('next-sidetab-')).toBe(true);
      expect(sessions.get(selectedId)?.state).toBe('background');
      await runNextTuiBranchRoute(`/side send hello ${agent}`, host);
      if (agent === 'claude') {
        const submissions = await Promise.all([
          controller.sendSideAgent(row(), 'first'),
          controller.sendSideAgent(row(), 'second'),
        ]);
        expect(submissions).toEqual([true, true]);
        const screen = controller.readSideAgent(row())!;
        expect(screen).toContain('received:first\rreceived:second\r');
      }
      await runNextTuiBranchRoute('/side read', host);
      expect(screens.join('\n')).toContain(`received:hello ${agent}`);
      expect(launches.at(-1)?.agentBrand).toBe(agent === 'claude' ? 'claude-code' : agent);
    }
    expect(launches.map((spec) => spec.command?.split(' ')[0])).toEqual(["'codex'", "'claude'", "'hermes'"]);
    expect(await host.sendSelectedAgent('\0')).toBe(false);
    sessions.get(selectedId)!.state = 'exited';
    expect(await host.sendSelectedAgent('after exit')).toBe(false);
    expect(statuses.some((status) => status.includes('입력 전송'))).toBe(true);
  } finally { controller.close(); }
});

test('agent-mission auth scrub remains active for all three PTY launches', () => {
  for (const agent of ['codex', 'claude', 'hermes'] as const) {
    const spec = sidetabAgentLaunch(agent, { PATH: '/bin', HERMES_API_KEY: 'secret', OPENCLAW_API_KEY: 'secret' });
    expect(spec.env.PATH).toBe('/bin');
    for (const key of spec.unsetEnv) expect(spec.env[key]).toBeUndefined();
    if (agent === 'hermes') {
      expect(spec.unsetEnv).toContain('HERMES_API_KEY');
      expect(spec.unsetEnv).toContain('OPENCLAW_API_KEY');
    }
  }
});
