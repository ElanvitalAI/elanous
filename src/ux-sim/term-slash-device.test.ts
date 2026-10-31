import { describe, expect, test } from 'bun:test';
import { runTermSlashMockScenarios } from './term-slash-device.js';

describe('ux-sim /term mock-device stage', () => {
  test('subcommand combinations use the production handler without spawning a PTY', async () => {
    const result = await runTermSlashMockScenarios();
    expect(result).toHaveLength(17);
    for (const row of result) {
      expect(row.evidence, `/term ${row.subcommand}`).toContain(row.expected);
    }
  });
});
