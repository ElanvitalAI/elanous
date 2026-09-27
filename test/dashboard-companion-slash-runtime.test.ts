import { describe, expect, test } from 'bun:test';

import { createDashboardCompanionSlashRuntime } from '../src/dashboard/companion-messages-runtime.js';

describe('createDashboardCompanionSlashRuntime', () => {
  test('renders companion popup feedback lines', () => {
    const runtime = createDashboardCompanionSlashRuntime({
      muted: (text) => `muted:${text}`,
      warning: (text) => `warning:${text}`,
    });

    expect(runtime.openedLine('clipboard')).toBe('muted:  clipboard companion popup opened');
    expect(runtime.closedLine('memo')).toBe('muted:  memo companion popup closed');
    expect(runtime.toggledLine('detail', true)).toBe('muted:  detail companion popup opened');
    expect(runtime.toggledLine('detail', false)).toBe('muted:  detail companion popup closed');
    expect(runtime.usageLine('clipboard')).toBe('warning:  Usage: /clipboard open|close|toggle|clear');
    expect(runtime.usageLine('memo')).toBe('warning:  Usage: /memo open|close|toggle|save');
    expect(runtime.usageLine('detail')).toBe('warning:  Usage: /detail open|close|toggle|clear');
    expect(runtime.detailClearedLine()).toBe('muted:  detail viewer cleared');
  });
});
