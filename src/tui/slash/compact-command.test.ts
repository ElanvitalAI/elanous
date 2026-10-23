import { describe, expect, test } from 'bun:test';
import { COMPACT_BUSY_STATUS, COMPACT_NO_SESSION_STATUS, isCompactCommand } from './compact-command.js';

describe('Next TUI compact command surface', () => {
  test('recognizes only the standalone /compact command', () => {
    expect(isCompactCommand('/compact')).toBe(true);
    expect(isCompactCommand('  /compact  ')).toBe(true);
    for (const text of ['/compactx', '/compact now', 'compact', '/new']) {
      expect(isCompactCommand(text)).toBe(false);
    }
  });

  test('keeps the compact command status copy available from the lightweight module', () => {
    expect(COMPACT_BUSY_STATUS).toContain('/compact');
    expect(COMPACT_NO_SESSION_STATUS).toContain('압축');
  });
});
