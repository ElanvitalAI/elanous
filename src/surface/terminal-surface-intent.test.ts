import { expect, test } from 'bun:test';
import { intentFromMouseEvent, buildTerminalMouseIntentEvent } from './terminal-surface-intent.js';

test('terminal mouse events preserve the canonical semantic intent', () => {
  const event = buildTerminalMouseIntentEvent({
    surfaceId: 'terminal-1',
    paneKind: 'terminal',
    mouseType: 'double-click',
    row: 4,
    col: 7,
    exposure: { userExposure: 'user-interactive', agentInteractive: true },
  });

  expect(event).toMatchObject({
    type: 'terminal:mouse-intent',
    transport: 'pty-forward',
    interactionPolicy: expect.any(Object),
  });
  expect(intentFromMouseEvent(event)).toMatchObject({
    kind: 'word-select',
    surfaceId: 'terminal-1',
    paneKind: 'terminal',
    row: 4,
    col: 7,
    capability: { canRead: true, canWrite: true, canInspect: true },
  });
});

test('terminal mouse motion stays out of the serializable intent chain', () => {
  const event = buildTerminalMouseIntentEvent({
    surfaceId: 'terminal-1',
    paneKind: 'terminal',
    mouseType: 'motion',
    row: 4,
    col: 7,
    exposure: { userExposure: 'observe-only', agentInteractive: false },
  });

  expect(intentFromMouseEvent(event)).toBeNull();
});
