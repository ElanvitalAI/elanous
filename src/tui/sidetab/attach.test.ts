import { describe, expect, test } from 'bun:test';
import { createSidetabAttachmentController } from './attach.js';

describe('next TUI sidetab attachments', () => {
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
});
