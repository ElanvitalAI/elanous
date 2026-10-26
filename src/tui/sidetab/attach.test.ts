import { describe, expect, test } from 'bun:test';
import { createSidetabAttachmentController } from './attach.js';

describe('next TUI sidetab attachments', () => {
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
