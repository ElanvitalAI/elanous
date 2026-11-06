import { describe, expect, test } from 'bun:test';

import {
  classifyBackgroundTerminalExposure,
  classifyModalTerminalExposure,
  classifyTerminalSessionExposure,
  classifyVwTerminalExposure,
} from '../src/dashboard/terminal-exposure.js';

describe('terminal exposure classifier', () => {
  test('foreground session is user-interactive and agent-interactive', () => {
    expect(classifyTerminalSessionExposure('foreground')).toEqual({
      userExposure: 'user-interactive',
      agentInteractive: true,
    });
  });

  test('background session is hidden to user but still agent-interactive', () => {
    expect(classifyTerminalSessionExposure('background')).toEqual({
      userExposure: 'hidden',
      agentInteractive: true,
    });
  });

  test('exited session is unavailable to both user and agent', () => {
    expect(classifyTerminalSessionExposure('exited')).toEqual({
      userExposure: 'unavailable',
      agentInteractive: false,
    });
  });

  test('vw output-only is observe-only to user but agent-interactive', () => {
    expect(classifyVwTerminalExposure('output-only', 'running')).toEqual({
      userExposure: 'observe-only',
      agentInteractive: true,
    });
  });

  test('modal running is user-interactive and agent-interactive', () => {
    expect(classifyModalTerminalExposure('running')).toEqual({
      userExposure: 'user-interactive',
      agentInteractive: true,
    });
  });

  test('background runner is hidden to user but agent-interactive', () => {
    expect(classifyBackgroundTerminalExposure('running')).toEqual({
      userExposure: 'hidden',
      agentInteractive: true,
    });
  });
  // 상호작용 정책 표(resolveTerminalInteractionPolicy)는 src/terminal/tui-policy.ts 소유 —
  // dashboard 는 재수출만 한다. 그 4×5 표는 test/terminal/tui-policy.test.ts 가 잠근다.
});
