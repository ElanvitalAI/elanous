import { describe, expect, test } from 'bun:test';
import { splitKeys } from '../../tui.js';
import { runVisibleAgentMission } from '../../sidetab-core/visible-agent-mission.js';
import { createSidetabAttachmentController, sidetabMissionFailureLog } from './attach.js';
import type { HerdrSidetabPortal } from './herdr-portal.js';

describe('next TUI sidetab attachments', () => {
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
