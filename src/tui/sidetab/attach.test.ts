import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getSessionCwd, initSessionWorkingDir } from '../../session/working-dir.js';
import { splitKeys } from '../../tui.js';
import { runVisibleAgentMission, type VisibleMissionPty, type VisibleMissionResult } from '../../sidetab-core/visible-agent-mission.js';
import { createSidetabAttachmentController, sidetabMissionFailureLog, visibleMissionPtyForTerminalSession } from './attach.js';
import type { TerminalSession, TerminalSessionRegistry } from '../../terminal/session-registry.js';
import type { HerdrSidetabPortal } from './herdr-portal.js';

describe('next TUI sidetab attachments', () => {
  test('updates a returned mission result and logs the real child exit when its session ends later', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    let session: TerminalSession;
    let notify: ((event: { type: 'exited'; session: TerminalSession }) => void) | undefined;
    let exitSubscriptionClosed = false;
    const modal = {
      id: 'test-modal', snapshot: () => '\n› Ask Codex to do anything\n', write: () => {}, isAlive: () => true, dispose: () => {},
    };
    session = {
      id: 'test-session', title: 'codex', cwd: '/tmp/sidetab-lifecycle', kind: 'coding-agent',
      startedAt: 0, state: 'foreground', lastFocusedAt: 0, exitCode: null, attentionLevel: 0,
      preview: { renderForLLM: () => '\n› Ask Codex to do anything\n', write: () => true, isAlive: true },
      modal,
    } as unknown as TerminalSession;
    const registry = {
      spawn: (spec: { id?: string }) => { if (spec.id) Object.defineProperty(session, 'id', { value: spec.id }); return session; },
      subscribe: (listener: typeof notify) => { notify = listener; return () => { exitSubscriptionClosed = true; }; },
      list: () => [session],
      kill: () => true,
      detach: () => true,
    } as unknown as TerminalSessionRegistry;
    const controller = createSidetabAttachmentController({
      drawBase: () => {}, termSize: () => ({ cols: 80, rows: 24 }), setStatus: () => {}, drawRemoteFrame: () => {},
      terminalRegistry: registry,
      logEvent: (category, event, data) => events.push({ category, event, data }),
      visibleMissionRunner: async ({ pty }) => {
        expect(pty.exitCode?.()).toBeNull();
        return { ok: true, path: '/tmp/result.md', promptReady: true, missionVisible: true, missionTyped: true,
          missionSubmitted: true, exitCode: null, promptReturned: true, completionMarker: true };
      },
    });
    let controllerClosed = false;
    try {
      const result = await controller.runMission('codex', 'write a short result');
      expect(result.exitCode).toBeNull();
      controller.close();
      controllerClosed = true;
      expect(exitSubscriptionClosed).toBe(false);
      session.state = 'exited';
      session.exitCode = 17;
      notify?.({ type: 'exited', session });
      expect(result.exitCode).toBe(17);
      expect(exitSubscriptionClosed).toBe(true);
      expect(events.at(-1)).toEqual({
        category: 'agent-mission.sidetab', event: 'pty-exit', data: { agent: 'codex', exitCode: 17 },
      });
    } finally { if (!controllerClosed) controller.close(); }
  });

  test('releases an exit observation when a mission session exits before its result exists', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    let session: TerminalSession;
    let notify: ((event: { type: 'exited'; session: TerminalSession }) => void) | undefined;
    let exitSubscriptionClosed = false;
    let startRunner!: () => void;
    let finishRunner!: () => void;
    const runnerStarted = new Promise<void>(resolve => { startRunner = resolve; });
    const runnerResult = new Promise<void>(resolve => { finishRunner = resolve; });
    const modal = { id: 'test-modal', snapshot: () => 'screen', write: () => {}, isAlive: () => true, dispose: () => {} };
    session = {
      id: 'test-session-no-result', title: 'codex', cwd: '/tmp/sidetab-no-result', kind: 'coding-agent',
      startedAt: 0, state: 'foreground', lastFocusedAt: 0, exitCode: null, attentionLevel: 0,
      preview: { renderForLLM: () => 'screen', write: () => true, isAlive: true }, modal,
    } as unknown as TerminalSession;
    const registry = {
      spawn: (spec: { id?: string }) => { if (spec.id) Object.defineProperty(session, 'id', { value: spec.id }); return session; },
      subscribe: (listener: typeof notify) => { notify = listener; return () => { exitSubscriptionClosed = true; notify = undefined; }; },
      list: () => [session],
      kill: () => {
        session.state = 'exited';
        session.exitCode = 19;
        notify?.({ type: 'exited', session });
        return session;
      },
      detach: () => true,
    } as unknown as TerminalSessionRegistry;
    const controller = createSidetabAttachmentController({
      drawBase: () => {}, termSize: () => ({ cols: 80, rows: 24 }), setStatus: () => {}, drawRemoteFrame: () => {},
      terminalRegistry: registry,
      logEvent: (category, event, data) => events.push({ category, event, data }),
      visibleMissionRunner: async ({ pty }) => {
        startRunner();
        await runnerResult;
        return { ok: false, path: '/tmp/no-result.md', promptReady: true, missionVisible: false,
          missionTyped: true, missionSubmitted: true, exitCode: pty.exitCode?.(), promptReturned: false,
          completionMarker: false, failureStage: 'mission-completion', error: 'child exited before writing result' };
      },
    });
    try {
      const pendingResult = controller.runMission('codex', 'write a result');
      await runnerStarted;
      controller.close();
      expect(exitSubscriptionClosed).toBe(true);
      expect(events.filter(entry => entry.event === 'pty-exit')).toEqual([{
        category: 'agent-mission.sidetab', event: 'pty-exit', data: { agent: 'codex', exitCode: 19 },
      }]);
      finishRunner();
      await expect(pendingResult).resolves.toMatchObject({ ok: false, exitCode: 19 });
      expect(events.filter(entry => entry.event === 'pty-exit')).toHaveLength(1);
    } finally {
      finishRunner();
      controller.close();
    }
  });

  test('logs the real exit when a spawned mission session already exited before tracking', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const session = {
      id: 'already-exited', title: 'codex', cwd: '/tmp/sidetab-fast-exit', kind: 'coding-agent',
      startedAt: 0, state: 'exited', lastFocusedAt: 0, exitCode: 23, attentionLevel: 0,
      preview: { renderForLLM: () => 'screen', write: () => true, isAlive: false },
      modal: { id: 'fast-exit-modal', snapshot: () => 'screen', write: () => {}, isAlive: () => false, dispose: () => {} },
    } as unknown as TerminalSession;
    const registry = {
      spawn: () => session,
      subscribe: () => () => {},
      list: () => [session],
      kill: () => true,
      detach: () => true,
    } as unknown as TerminalSessionRegistry;
    const controller = createSidetabAttachmentController({
      drawBase: () => {}, termSize: () => ({ cols: 80, rows: 24 }), setStatus: () => {}, drawRemoteFrame: () => {},
      terminalRegistry: registry,
      logEvent: (category, event, data) => events.push({ category, event, data }),
      visibleMissionRunner: async ({ pty }) => ({ ok: true, path: '/tmp/result.md', promptReady: true, missionVisible: true,
        missionTyped: true, missionSubmitted: true, exitCode: pty.exitCode?.() ?? null, promptReturned: true, completionMarker: true }),
    });
    try {
      const result = await controller.runMission('codex', 'write a short result');
      expect(result.exitCode).toBe(23);
      expect(events.filter(entry => entry.event === 'pty-exit')).toEqual([{
        category: 'agent-mission.sidetab', event: 'pty-exit', data: { agent: 'codex', exitCode: 23 },
      }]);
    } finally { controller.close(); }
  });

  test('routes Codex, Claude, and Grok missions through the controller with submitted input, result files, and exit codes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sidetab-three-agent-controller-'));
    const originalCwd = getSessionCwd();
    initSessionWorkingDir(root);
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const sessions = new Map<string, TerminalSession & { submitted: string }>();
    let notify: ((event: { type: 'exited'; session: TerminalSession }) => void) | undefined;
    const registry = {
      spawn: (spec: { id?: string; title?: string; cwd?: string; agentBrand?: 'codex' | 'claude-code' | 'grok' }) => {
        const id = spec.id ?? `mission-${sessions.size}`;
        let submitted = '';
        const modal = {
          id: `${id}-modal`, snapshot: () => 'prompt ready',
          write: (bytes: string) => { submitted += bytes; }, isAlive: () => true, dispose: () => {},
        };
        const session = {
          id, title: spec.title ?? id, cwd: spec.cwd ?? root, kind: 'coding-agent' as const,
          agentBrand: spec.agentBrand, startedAt: 0, state: 'foreground' as const, lastFocusedAt: 0,
          exitCode: null, attentionLevel: 0,
          preview: { renderForLLM: () => 'prompt ready', write: (bytes: string) => { submitted += bytes; return true; }, isAlive: true },
          modal, submitted,
        } as unknown as TerminalSession & { submitted: string };
        Object.defineProperty(session, 'submitted', { get: () => submitted, enumerable: true });
        sessions.set(id, session);
        return session;
      },
      subscribe: (listener: typeof notify) => { notify = listener; return () => { notify = undefined; }; },
      list: () => [...sessions.values()],
      kill: () => true,
      detach: () => true,
    } as unknown as TerminalSessionRegistry;
    const controller = createSidetabAttachmentController({
      drawBase: () => {}, termSize: () => ({ cols: 80, rows: 24 }), setStatus: () => {}, drawRemoteFrame: () => {},
      terminalRegistry: registry,
      logEvent: (category, event, data) => events.push({ category, event, data }),
      visibleMissionRunner: async ({ agent, mission, outputPath, pty }) => {
        pty.write(mission);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, `# ${agent}\n${mission}\n`, 'utf8');
        return { ok: true, path: outputPath, promptReady: true, missionVisible: true, missionTyped: true,
          missionSubmitted: true, exitCode: null, promptReturned: true, completionMarker: true };
      },
    });
    try {
      for (const [agent, exitCode] of [['codex', 0], ['claude', 0], ['grok', 7]] as const) {
        const mission = `Write a ${agent} result.`;
        const result = await controller.runMission(agent, mission);
        const session = [...sessions.values()].at(-1)!;
        expect(session.agentBrand).toBe(agent === 'claude' ? 'claude-code' : agent);
        expect(session.submitted).toBe(mission);
        expect(result).toMatchObject({ ok: true, missionTyped: true, missionSubmitted: true, exitCode: null });
        expect(readFileSync(result.path, 'utf8')).toBe(`# ${agent}\n${mission}\n`);
        session.state = 'exited';
        (session as TerminalSession & { exitCode: number }).exitCode = exitCode;
        notify?.({ type: 'exited', session });
        expect(result.exitCode).toBe(exitCode);
      }
      expect(events.filter(entry => entry.event === 'pty-exit').map(entry => entry.data)).toEqual([
        { agent: 'codex', exitCode: 0 }, { agent: 'claude', exitCode: 0 }, { agent: 'grok', exitCode: 7 },
      ]);
    } finally {
      controller.close();
      initSessionWorkingDir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runs all three fake CLI/PTy stages through production controller, spawn routing, and mission runner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sidetab-three-agent-production-pty-'));
    const originalCwd = getSessionCwd();
    initSessionWorkingDir(root);
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const sessions = new Map<string, TerminalSession & { agent: string; input: string; screen: string }>();
    let notify: ((event: { type: 'exited'; session: TerminalSession }) => void) | undefined;
    const registry = {
      spawn: (spec: { id?: string; cwd?: string; command?: string; agentBrand?: string }) => {
        const id = spec.id ?? `fake-${sessions.size}`;
        const agent = spec.agentBrand === 'claude-code' ? 'claude' : spec.agentBrand ?? '';
        const exitCode = agent === 'grok' ? 7 : 0;
        let session!: TerminalSession & { agent: string; input: string; screen: string };
        session = {
          id, title: agent, cwd: spec.cwd ?? root, command: spec.command, kind: 'coding-agent' as const,
          agentBrand: spec.agentBrand, startedAt: Date.now(), state: 'foreground', lastFocusedAt: Date.now(),
          exitCode: null, attentionLevel: 0, input: '', screen: '\n› Ask anything\n',
          preview: { renderForLLM: () => session.screen, write: (bytes: string) => { write(bytes); return true; }, get isAlive() { return session.state !== 'exited'; } },
          modal: {
            id: `${id}-modal`,
            snapshot: () => session.screen,
            isAlive: () => session.state !== 'exited',
            dispose: () => {},
            write,
          },
        } as unknown as TerminalSession & { agent: string; input: string; screen: string };
        function write(bytes: string): void {
          for (const character of bytes) {
            if (character !== '\r') {
              session.input += character;
              session.screen += character;
              continue;
            }
            const line = session.input;
            session.input = '';
            const mission = line.match(/exact file path (.+?) \(create parent directories if needed\)\./);
            if (mission) {
              const resultPath = mission[1];
              mkdirSync(dirname(resultPath), { recursive: true });
              writeFileSync(resultPath, `# ${agent} fake result\n${line}\n`, 'utf8');
              session.screen = '\n› Ask anything\n';
              continue;
            }
            const marker = line.match(/Say (M-[a-f0-9]{12}) alone and write it to the exact file path (.+)\./);
            if (marker) {
              writeFileSync(marker[2], `${marker[1]}\n`, 'utf8');
              session.screen = `\n${marker[1]}\n`;
              session.state = 'exited';
              session.exitCode = exitCode;
              notify?.({ type: 'exited', session });
            }
          }
        }
        sessions.set(id, session);
        return session;
      },
      subscribe: (listener: typeof notify) => { notify = listener; return () => { notify = undefined; }; },
      list: () => [...sessions.values()],
      kill: (id: string) => {
        const session = sessions.get(id);
        if (session) { session.state = 'exited'; notify?.({ type: 'exited', session }); }
        return session;
      },
      detach: () => true,
    } as unknown as TerminalSessionRegistry;
    const controller = createSidetabAttachmentController({
      drawBase: () => {}, termSize: () => ({ cols: 100, rows: 32 }), setStatus: () => {}, drawRemoteFrame: () => {},
      terminalRegistry: registry,
      logEvent: (category, event, data) => events.push({ category, event, data }),
      // This delegates to the real mission runner; the injected PTY stage only
      // simulates prompt echo, result-file creation, marker output, and exit.
      visibleMissionRunner: deps => runVisibleAgentMission({
        ...deps, readyTimeoutMs: 5_000, visibilityTimeoutMs: 5_000, completionTimeoutMs: 10_000, pollMs: 10,
      }),
    });
    try {
      for (const [agent, exitCode] of [['codex', 0], ['claude', 0], ['grok', 7]] as const) {
        const mission = 'same three-hand production-path acceptance request';
        const result = await controller.runMission(agent, mission);
        expect(result).toMatchObject({ ok: true, promptReady: true, missionVisible: true, missionTyped: true,
          missionSubmitted: true, promptReturned: true, completionMarker: true });
        expect(sessions.get([...sessions.keys()].at(-1)!)?.command).toContain(`'${agent}'`);
        const content = readFileSync(result.path, 'utf8');
        expect(content).toContain(`# ${agent} fake result`);
        expect(content).toContain(mission);
        // The fake PTY writes the completion marker and changes session state synchronously.
        // Assert that event contract directly instead of polling wall-clock time.
        expect(registry.list().at(-1)?.state).toBe('exited');
        expect(registry.list().at(-1)?.exitCode).toBe(exitCode);
        expect(result.exitCode).toBe(exitCode);
      }
      expect(events.filter(entry => entry.event === 'pty-exit').map(entry => entry.data)).toEqual([
        { agent: 'codex', exitCode: 0 }, { agent: 'claude', exitCode: 0 }, { agent: 'grok', exitCode: 7 },
      ]);
    } finally {
      controller.close();
      initSessionWorkingDir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test('adapts registry process exit code into the visible mission PTY', () => {
    const session = {
      exitCode: null,
      modal: { snapshot: () => 'screen', write: () => {}, isAlive: () => false },
    } as unknown as TerminalSession;
    const pty = visibleMissionPtyForTerminalSession(session);
    expect(pty.exitCode?.()).toBeNull();
    session.exitCode = 17;
    expect(pty.exitCode?.()).toBe(17);
  });

  test('logs a post-readiness failure as a mission failure, not a blocked startup screen', () => {
    const log = sidetabMissionFailureLog('codex', {
      ok: false, path: '/tmp/result.md', promptReady: true, missionVisible: false,
      promptReturned: false, completionMarker: false, startupScreen: 'codex-update-choice',
      error: 'Mission text was not visible in the agent PTY before submission',
    });
    expect(log).toEqual({
      event: 'mission-failed',
      data: { agent: 'codex', screen: 'none', error: 'mission-or-result-failed' },
    });
  });

  test('routes a real post-readiness failure through controller logging and status', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    let status = '';
    const controller = createSidetabAttachmentController({
      drawBase: () => {},
      termSize: () => ({ cols: 80, rows: 24 }),
      setStatus: message => { status = message; },
      drawRemoteFrame: () => {},
      logEvent: (category, event, data) => events.push({ category, event, data }),
      visibleMissionRunner: missionDeps => runVisibleAgentMission({ ...missionDeps, visibilityTimeoutMs: 1, pollMs: 0 }),
      createVisibleMissionPty: () => ({
        cwd: '/tmp/sidetab-attach-test',
        pty: {
          snapshot: () => 'Update available · esc skip\n› Ask Codex to do anything',
          write: () => {},
          isAlive: () => true,
        },
      }),
    });
    try {
      const result = await controller.runMission('codex', 'Write a short note.');
      expect(result).toMatchObject({ ok: false, promptReady: true, missionVisible: false, startupScreen: 'codex-update-choice' });
      expect(events.at(-1)).toEqual({
        category: 'agent-mission.sidetab', event: 'mission-failed',
        data: { agent: 'codex', screen: 'none', error: 'mission-or-result-failed' },
      });
      expect(events.some(entry => entry.data.error === 'known-startup-screen-blocked')).toBe(false);
      expect(status).toContain('미션 확인 실패 · codex · Mission text was not visible');
      expect(status).not.toContain('codex-update-choice');
    } finally { controller.close(); }
  });

  test('checks OPT agent CLI detection before creating a visible mission PTY', async () => {
    const checks: string[] = [];
    let status = '';
    const controller = createSidetabAttachmentController({
      drawBase: () => {},
      termSize: () => ({ cols: 80, rows: 24 }),
      setStatus: (message) => { status = message; },
      drawRemoteFrame: () => {},
      detectAgentCli: async (agent) => {
        checks.push(agent);
        return { agent, installed: false, version: null, login: 'unknown', message: 'Codex CLI가 설치되지 않았습니다' };
      },
    });

    try {
      const result = await controller.runMission('codex', 'write a short result file');
      expect(checks).toEqual(['codex']);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('설치 확인 후 미션을 다시 요청하세요');
      expect(status).toContain('Codex CLI가 설치되지 않았습니다');
      expect(controller.hasModal()).toBe(false);
    } finally {
      controller.close();
    }
  });

  test('starts both visible agent PTYs before dispatch and routes both files through pair synthesis', async () => {
    const events: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), 'sidetab-pair-'));
    writeFileSync(join(cwd, 'codex.md'), 'codex base\n');
    writeFileSync(join(cwd, 'claude.md'), 'claude base\n');
    execFileSync('git', ['-C', cwd, 'init', '--quiet']);
    execFileSync('git', ['-C', cwd, 'add', 'codex.md', 'claude.md']);
    execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'base']);
    const baseSha = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const candidate = (agent: 'codex' | 'claude', file: string, before: string) =>
      `# ${agent}\n<SIDETAB-CANDIDATE-V1 base-sha="${baseSha}">\n` +
      `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${before}\n+# ${agent}\n` +
      '</SIDETAB-CANDIDATE-V1>';
    let releaseCodex: () => void = () => {};
    const codexGate = new Promise<void>((resolve) => { releaseCodex = resolve; });
    let markClaudeStarted: () => void = () => {};
    const claudeStarted = new Promise<void>((resolve) => { markClaudeStarted = resolve; });
    const controller = createSidetabAttachmentController({
      drawBase: () => {}, termSize: () => ({ cols: 80, rows: 24 }), setStatus: () => {}, drawRemoteFrame: () => {},
      detectAgentCli: async (agent) => ({ agent, installed: true, version: 'test', login: 'ready', message: `${agent} ready` }),
      createVisibleMissionPty: (agent) => {
        events.push(`spawn:${agent}`);
        const pty: VisibleMissionPty = { snapshot: () => '', write: () => {}, isAlive: () => true };
        return { pty, cwd };
      },
      visibleMissionRunner: async ({ agent, mission, outputPath }): Promise<VisibleMissionResult> => {
        events.push(`run:${agent}:${mission}`);
        if (agent === 'codex') await codexGate;
        else if (agent === 'claude') markClaudeStarted();
        else throw new Error(`unexpected pair agent: ${agent}`);
        const pairAgent = agent;
        const content = candidate(pairAgent, `${pairAgent}.md`, `${pairAgent} base`);
        return { ok: true, path: outputPath, content, firstLine: content.split('\n')[0], promptReady: true, missionVisible: true, promptReturned: true, completionMarker: true };
      },
    });

    try {
      const completion = controller.runMissionPair('codex', 'implement', 'review');
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
      const result = pair as { ok: boolean; pair: string; finalFile: string; graph: Array<{ id: string; state: string; resultFile?: string }> };
      expect(result).toMatchObject({ pair: 'codex+claude', graph: [
        { id: 'plan', state: 'complete' },
        { id: 'codex', state: 'complete' },
        { id: 'claude', state: 'complete' },
        { id: 'synthesis', state: 'complete' },
      ] });
      expect(result.finalFile).toContain(join(cwd, '.elanous', 'mission-results', 'classic-pair-synthesis-'));
      const synthesis = readFileSync(result.finalFile, 'utf8');
      expect(synthesis).toContain('## 비교·채택 표');
      expect(synthesis).toContain('| Codex | implement |');
      expect(synthesis).toContain('| Claude Code | review |');
      expect(synthesis).toContain('# codex');
      expect(synthesis).toContain('# claude');
    } finally {
      controller.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('refuses to kill the current TUI process', () => {
    let status = '';
    const controller = createSidetabAttachmentController({
      drawBase: () => {},
      termSize: () => ({ cols: 80, rows: 24 }),
      setStatus: (message) => { status = message; },
      drawRemoteFrame: () => {},
    });

    expect(controller.kill({ id: 'tui:current', label: 'current', kind: 'tui', badge: 'idle', currentProcess: true })).toBe(false);
    expect(status).toContain('현재 TUI 세션');
    controller.close();
  });

  test('spawns and closes an isolated shell PTY modal', () => {
    const controller = createSidetabAttachmentController({
      drawBase: () => {},
      termSize: () => ({ cols: 80, rows: 24 }),
      setStatus: () => {},
      drawRemoteFrame: () => {},
    });

    try {
      expect(controller.spawn('shell')).toBe(true);
      expect(controller.hasModal()).toBe(true);
    } finally {
      controller.close();
    }
    expect(controller.hasModal()).toBe(false);
  });

  test('Herdr takeover routes escape sequences as keys and leaves global quit available', async () => {
    const frames: string[] = [];
    const inputs: string[] = [];
    let status = '';
    const portal: HerdrSidetabPortal = {
      enabled: () => true,
      refreshRows: async () => [],
      rows: () => [],
      readPane: async () => 'Herdr screen',
      sendText: async (_paneId, text) => { inputs.push(`text:${text}`); },
      sendKey: async (_paneId, key) => { inputs.push(`key:${key}`); },
    };
    const controller = createSidetabAttachmentController({
      drawBase: () => {},
      termSize: () => ({ cols: 80, rows: 24 }),
      setStatus: (message) => { status = message; },
      drawRemoteFrame: (frame) => { frames.push(frame); },
      herdrPortal: portal,
    });
    const row = { id: 'herdr:w2:p7', label: 'pane', kind: 'herdr', badge: 'busy' as const };
    try {
      expect(controller.select(row)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(frames).toContain('Herdr screen');
      expect(controller.hasRemoteView()).toBe(true);
      expect(controller.handleKey({ name: 't', raw: 't', ctrl: false, shift: false })).toBe(true);
      expect(controller.handleKey(splitKeys('\x1b[A')[0]!)).toBe(true);
      expect(controller.handleKey({ name: 'x', raw: 'x', ctrl: false, shift: false })).toBe(true);
      const nulKey = splitKeys('\x00')[0]!;
      expect(nulKey.raw).toBe('\x00');
      expect(controller.handleKey(nulKey)).toBe(true);
      expect(status).toContain('NUL');
      expect(controller.handleKey(splitKeys('\x7f')[0]!)).toBe(true);
      expect(controller.handleKey(splitKeys('\x1b')[0]!)).toBe(true);
      expect(frames.at(-1)).toBe('');
      expect(controller.hasRemoteView()).toBe(false);
      expect(controller.select(row)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(controller.handleKey({ name: 't', raw: 't', ctrl: false, shift: false })).toBe(true);
      expect(controller.handleKey(splitKeys('\x11')[0]!)).toBe(false);
      expect(frames.at(-1)).toBe('');
      expect(controller.select(row)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(controller.handleKey({ name: 't', raw: 't', ctrl: false, shift: false })).toBe(true);
      expect(controller.handleKey(splitKeys('\x1c')[0]!)).toBe(false);
      expect(frames.at(-1)).toBe('');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(inputs).toEqual(['key:\x1b[A', 'text:x', 'key:\x7f']);
    } finally {
      controller.close();
    }
  });

  test('serializes delayed Herdr key and text sends in the order received', async () => {
    const started: string[] = [];
    const completed: string[] = [];
    let activeInputs = 0;
    let maxActiveInputs = 0;
    let releaseFirst: () => void = () => {};
    let markFirstStarted: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const portal: HerdrSidetabPortal = {
      enabled: () => true,
      refreshRows: async () => [],
      rows: () => [],
      readPane: async () => 'Herdr screen',
      sendText: async (_paneId, text) => {
        await runInput(`text:${text}`, false);
      },
      sendKey: async (_paneId, key) => {
        const label = key === '\x1b[A' ? 'key:up' : key === '\r' || key === '\n' ? 'key:enter' : `key:${key}`;
        await runInput(label, key === '\x1b[A');
      },
    };
    async function runInput(label: string, block: boolean): Promise<void> {
      started.push(label);
      activeInputs += 1;
      maxActiveInputs = Math.max(maxActiveInputs, activeInputs);
      if (block) {
        markFirstStarted();
        await firstGate;
      }
      completed.push(label);
      activeInputs -= 1;
    }
    const controller = createSidetabAttachmentController({
      drawBase: () => {},
      termSize: () => ({ cols: 80, rows: 24 }),
      setStatus: () => {},
      drawRemoteFrame: () => {},
      herdrPortal: portal,
    });
    try {
      const row = { id: 'herdr:w2:p8', label: 'pane', kind: 'herdr', badge: 'busy' as const };
      expect(controller.select(row)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(controller.handleKey({ name: 't', raw: 't', ctrl: false, shift: false })).toBe(true);
      expect(controller.handleKey(splitKeys('\x1b[A')[0]!)).toBe(true);
      expect(controller.handleKey({ name: 'x', raw: 'x', ctrl: false, shift: false })).toBe(true);
      expect(controller.handleKey(splitKeys('\r')[0]!)).toBe(true);
      await firstStarted;
      expect(started).toEqual(['key:up']);
      releaseFirst();
      for (let attempt = 0; attempt < 100 && completed.length < 3; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(started).toEqual(['key:up', 'text:x', 'key:enter']);
      expect(completed).toEqual(started);
      expect(maxActiveInputs).toBe(1);
    } finally {
      releaseFirst();
      controller.close();
    }
  });

  test('releases a remote takeover that succeeds after the selected host and PTY changed', async () => {
    const calls: string[] = [];
    let finishTakeover: () => void = () => {};
    let markTakeoverStarted: () => void = () => {};
    const takeoverStarted = new Promise<void>((resolve) => { markTakeoverStarted = resolve; });
    const takeover = new Promise<void>((resolve) => { finishTakeover = resolve; });
    const controller = createSidetabAttachmentController({
      drawBase: () => {}, termSize: () => ({ cols: 80, rows: 24 }), setStatus: () => {}, drawRemoteFrame: () => {},
      remotePtyCommand: async (host, args) => {
        calls.push(`${host}:${args.join('|')}`);
        if (args[1] === 'takeover') { markTakeoverStarted(); await takeover; }
        return args[1] === 'snapshot' ? 'remote screen' : '';
      },
    });
    const first = { id: 'remote:aws1:pty-a', ptyId: 'pty-a', remoteHost: 'aws1', host: 'aws1', label: 'aws1:a', kind: 'tui' as const, badge: 'idle' as const };
    const second = { id: 'remote:gcp1:pty-a', ptyId: 'pty-a', remoteHost: 'gcp1', host: 'gcp1', label: 'gcp1:a', kind: 'tui' as const, badge: 'idle' as const };
    try {
      expect(controller.select(first)).toBe(true);
      controller.handleKey({ name: 't', raw: 't', ctrl: false, shift: false });
      await takeoverStarted;
      expect(controller.select(second)).toBe(true);
      finishTakeover();
      for (let attempt = 0; attempt < 100 && !calls.some((call) => call === 'aws1:pty|release|pty-a'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
      expect(calls).toContain('aws1:pty|release|pty-a');
      expect(calls).not.toContain('gcp1:pty|release|pty-a');
    } finally { finishTakeover(); controller.close(); }
  });

  test('serializes same-target takeover after stale takeover release on reselect', async () => {
    const calls: string[] = [];
    let finishFirstTakeover: () => void = () => {};
    let markFirstTakeoverStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => { markFirstTakeoverStarted = resolve; });
    const firstTakeover = new Promise<void>((resolve) => { finishFirstTakeover = resolve; });
    const controller = createSidetabAttachmentController({
      drawBase: () => {}, termSize: () => ({ cols: 80, rows: 24 }), setStatus: () => {}, drawRemoteFrame: () => {},
      remotePtyCommand: async (_host, args) => {
        calls.push(args.join('|'));
        if (args[1] === 'takeover' && calls.filter((call) => call === 'pty|takeover|pty-same').length === 1) {
          markFirstTakeoverStarted(); await firstTakeover;
        }
        return args[1] === 'snapshot' ? 'screen' : '';
      },
    });
    const same = { id: 'remote:aws1:pty-same', ptyId: 'pty-same', remoteHost: 'aws1', host: 'aws1', label: 'aws1:same', kind: 'tui' as const, badge: 'idle' as const };
    const other = { id: 'remote:aws1:pty-other', ptyId: 'pty-other', remoteHost: 'aws1', host: 'aws1', label: 'aws1:other', kind: 'tui' as const, badge: 'idle' as const };
    try {
      controller.select(same);
      controller.handleKey({ name: 't', raw: 't', ctrl: false, shift: false });
      await firstStarted;
      controller.select(other);
      controller.select(same);
      controller.handleKey({ name: 't', raw: 't', ctrl: false, shift: false });
      finishFirstTakeover();
      for (let attempt = 0; attempt < 100 && calls.filter((call) => call === 'pty|takeover|pty-same').length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
      const controls = calls.filter((call) => call === 'pty|takeover|pty-same' || call === 'pty|release|pty-same');
      expect(controls[0]).toBe('pty|takeover|pty-same');
      expect(controls.at(-1)).toBe('pty|takeover|pty-same');
      expect(controls.slice(1, -1).every((call) => call === 'pty|release|pty-same')).toBe(true);
      controller.handleKey({ name: 'z', raw: 'z', ctrl: false, shift: false });
      for (let attempt = 0; attempt < 100 && !calls.includes('pty|text|pty-same|z|--actor|human'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
      expect(calls.at(-1)).toBe('pty|text|pty-same|z|--actor|human');
    } finally { finishFirstTakeover(); controller.close(); }
  });

  test('orders remote input before release and a fast same-target takeover', async () => {
    const calls: string[] = [];
    const statuses: string[] = [];
    let finishText: () => void = () => {};
    let markTextStarted: () => void = () => {};
    const textStarted = new Promise<void>((resolve) => { markTextStarted = resolve; });
    const textGate = new Promise<void>((resolve) => { finishText = resolve; });
    const controller = createSidetabAttachmentController({
      drawBase: () => {}, termSize: () => ({ cols: 80, rows: 24 }), setStatus: (status) => statuses.push(status), drawRemoteFrame: () => {},
      remotePtyCommand: async (_host, args) => {
        calls.push(args.join('|'));
        if (args[1] === 'text' && args[3] === 'a') { markTextStarted(); await textGate; }
        return args[1] === 'snapshot' ? 'screen' : '';
      },
    });
    const same = { id: 'remote:aws1:pty-order', ptyId: 'pty-order', remoteHost: 'aws1', host: 'aws1', label: 'aws1:order', kind: 'tui' as const, badge: 'idle' as const };
    const other = { id: 'remote:gcp1:pty-order-next', ptyId: 'pty-order-next', remoteHost: 'gcp1', host: 'gcp1', label: 'gcp1:next', kind: 'tui' as const, badge: 'idle' as const };
    try {
      controller.select(same);
      controller.handleKey({ name: 't', raw: 't', ctrl: false, shift: false });
      for (let attempt = 0; attempt < 100 && !statuses.some((status) => status.includes('takeover 완료')); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
      controller.handleKey({ name: 'a', raw: 'a', ctrl: false, shift: false });
      await textStarted;
      controller.select(other);
      controller.select(same);
      controller.handleKey({ name: 't', raw: 't', ctrl: false, shift: false });
      finishText();
      for (let attempt = 0; attempt < 100 && calls.filter((call) => call === 'pty|takeover|pty-order').length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
      const input = calls.indexOf('pty|text|pty-order|a|--actor|human');
      const release = calls.indexOf('pty|release|pty-order');
      const secondTakeover = calls.lastIndexOf('pty|takeover|pty-order');
      expect(input).toBeGreaterThanOrEqual(0);
      expect(release).toBeGreaterThan(input);
      expect(secondTakeover).toBeGreaterThan(release);
    } finally { finishText(); controller.close(); }
  });

  test('reports an in-flight input error even after switching away from its PTY', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const statuses: string[] = [];
    let failText: () => void = () => {};
    let markTextStarted: () => void = () => {};
    const textStarted = new Promise<void>((resolve) => { markTextStarted = resolve; });
    const textGate = new Promise<void>((_resolve, reject) => { failText = () => reject(new Error('remote timeout')); });
    const controller = createSidetabAttachmentController({
      drawBase: () => {}, termSize: () => ({ cols: 80, rows: 24 }), setStatus: (status) => statuses.push(status), drawRemoteFrame: () => {},
      logEvent: (_category, event, data) => events.push({ event, data }),
      remotePtyCommand: async (_host, args) => {
        if (args[1] === 'snapshot' || args[1] === 'takeover') return 'screen';
        if (args[1] === 'text') { markTextStarted(); await textGate; }
        return '';
      },
    });
    const row = { id: 'remote:aws1:pty-error', ptyId: 'pty-error', remoteHost: 'aws1', host: 'aws1', label: 'aws1:error', kind: 'tui' as const, badge: 'idle' as const };
    const other = { id: 'remote:gcp1:pty-error-next', ptyId: 'pty-error-next', remoteHost: 'gcp1', host: 'gcp1', label: 'gcp1:next', kind: 'tui' as const, badge: 'idle' as const };
    try {
      controller.select(row);
      controller.handleKey({ name: 't', raw: 't', ctrl: false, shift: false });
      for (let attempt = 0; attempt < 100 && !statuses.some((status) => status.includes('takeover 완료')); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
      controller.handleKey({ name: 'q', raw: 'q', ctrl: false, shift: false });
      await textStarted;
      controller.select(other);
      failText();
      for (let attempt = 0; attempt < 100 && !events.some((event) => event.event === 'send-failed'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
      expect(events.find((event) => event.event === 'send-failed')?.data).toMatchObject({ ptyId: 'pty-error', attachmentChanged: true, outcome: 'unknown' });
      expect(statuses.some((status) => status.includes('결과 불명') && status.includes('pty-error'))).toBe(true);
    } finally { failText(); controller.close(); }
  });

  test('serializes remote PTY text and sends Enter through the --enter option', async () => {
    const started: string[][] = [];
    const completed: string[][] = [];
    let active = 0;
    let maxActive = 0;
    let finishFirst: () => void = () => {};
    let markFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const first = new Promise<void>((resolve) => { finishFirst = resolve; });
    const controller = createSidetabAttachmentController({
      drawBase: () => {}, termSize: () => ({ cols: 80, rows: 24 }), setStatus: () => {}, drawRemoteFrame: () => {},
      remotePtyCommand: async (_host, args) => {
        if (args[1] === 'snapshot' || args[1] === 'takeover') return 'screen';
        if (args[1] !== 'text') return '';
        started.push([...args]); active += 1; maxActive = Math.max(maxActive, active);
        if (args[3] === 'a') { markFirstStarted(); await first; }
        completed.push([...args]); active -= 1;
        return '';
      },
    });
    const row = { id: 'remote:aws1:pty-input', ptyId: 'pty-input', remoteHost: 'aws1', host: 'aws1', label: 'aws1:input', kind: 'tui' as const, badge: 'idle' as const };
    try {
      expect(controller.select(row)).toBe(true);
      controller.handleKey({ name: 't', raw: 't', ctrl: false, shift: false });
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.handleKey({ name: 'a', raw: 'a', ctrl: false, shift: false });
      controller.handleKey({ name: 'b', raw: 'b', ctrl: false, shift: false });
      controller.handleKey({ name: 'return', raw: '\r', ctrl: false, shift: false });
      await firstStarted;
      expect(started).toHaveLength(1);
      finishFirst();
      for (let attempt = 0; attempt < 100 && completed.length < 3; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
      expect(started).toEqual([
        ['pty', 'text', 'pty-input', 'a', '--actor', 'human'],
        ['pty', 'text', 'pty-input', 'b', '--actor', 'human'],
        ['pty', 'text', 'pty-input', '', '--enter', '--actor', 'human'],
      ]);
      expect(completed).toEqual(started);
      expect(maxActive).toBe(1);
    } finally { finishFirst(); controller.close(); }
  });

  test('reports queued remote input cancelled when its attachment changes', async () => {
    const calls: string[][] = [];
    const statuses: string[] = [];
    let finishFirst: () => void = () => {};
    let markFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const first = new Promise<void>((resolve) => { finishFirst = resolve; });
    const controller = createSidetabAttachmentController({
      drawBase: () => {}, termSize: () => ({ cols: 80, rows: 24 }), setStatus: (status) => statuses.push(status), drawRemoteFrame: () => {},
      remotePtyCommand: async (_host, args) => {
        if (args[1] === 'snapshot' || args[1] === 'takeover') return 'screen';
        if (args[1] === 'text') { calls.push([...args]); if (args[3] === 'a') { markFirstStarted(); await first; } }
        return '';
      },
    });
    const row = { id: 'remote:aws1:pty-cancel', ptyId: 'pty-cancel', remoteHost: 'aws1', host: 'aws1', label: 'aws1:cancel', kind: 'tui' as const, badge: 'idle' as const };
    const other = { id: 'remote:gcp1:pty-next', ptyId: 'pty-next', remoteHost: 'gcp1', host: 'gcp1', label: 'gcp1:next', kind: 'tui' as const, badge: 'idle' as const };
    try {
      controller.select(row);
      controller.handleKey({ name: 't', raw: 't', ctrl: false, shift: false });
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.handleKey({ name: 'a', raw: 'a', ctrl: false, shift: false });
      controller.handleKey({ name: 'b', raw: 'b', ctrl: false, shift: false });
      await firstStarted;
      controller.select(other);
      finishFirst();
      for (let attempt = 0; attempt < 100 && !statuses.some((status) => status.includes('입력 취소')); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
      expect(calls.map((args) => args[3])).toEqual(['a']);
      expect(statuses.some((status) => status.includes('대상 전환') && status.includes('pty-cancel'))).toBe(true);
    } finally { finishFirst(); controller.close(); }
  });

  test('showMain stops the Herdr snapshot view', async () => {
    const portal: HerdrSidetabPortal = {
      enabled: () => true,
      refreshRows: async () => [],
      rows: () => [],
      readPane: async () => 'screen',
      sendText: async () => {},
      sendKey: async () => {},
    };
    const controller = createSidetabAttachmentController({
      drawBase: () => {},
      termSize: () => ({ cols: 80, rows: 24 }),
      setStatus: () => {},
      drawRemoteFrame: () => {},
      herdrPortal: portal,
    });
    try {
      expect(controller.select({ id: 'herdr:w1:p1', label: 'pane', kind: 'herdr', badge: 'idle' })).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(controller.hasRemoteView()).toBe(true);
      controller.showMain();
      expect(controller.hasRemoteView()).toBe(false);
    } finally { controller.close(); }
  });
});
