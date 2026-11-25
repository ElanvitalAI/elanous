import { describe, expect, test } from 'bun:test';
import { liveWorkNextDeps } from './work-next-cli.js';

// KNOCK-USES-WORK-NEXT — the extracted live wiring (shared by `eln work next` and the TUI knock) keeps the caller's clock/version.
describe('liveWorkNextDeps', () => {
  test('passes version and now through and exposes the full claim wiring', () => {
    const deps = liveWorkNextDeps('tc-h-1', { version: '9.9.9', now: 1_700_000_000_000 });
    expect(deps.version).toBe('9.9.9');
    expect(deps.now()).toBe(1_700_000_000_000);
    for (const key of ['cells', 'scopeOf', 'lastActiveMs', 'waitOf', 'swap', 'record', 'isCoordinator', 'isJudge', 'priorityOrder', 'blockOf', 'resume'] as const) {
      expect(typeof deps[key]).toBe('function');
    }
  });
});
