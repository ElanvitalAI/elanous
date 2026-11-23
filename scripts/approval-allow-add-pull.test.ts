import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { addScopedPull } from './approval-allow-add-pull.js';
import { parseSeatAllowList } from '../src/security/shell-argv-policy.js';
import { seatApprovalDecision } from '../src/tui/seat-approval-policy.js';

function seal(body: string): string {
  return `${body}\nlock ${createHash('sha256').update(body).digest('hex')}\n`;
}
describe('OP scoped pull preparation', () => {
  test('preserves rules, advances version, and admits only the requested shape', () => {
    const result = addScopedPull(seal('version 4\nallow status git status'));
    const parsed = parseSeatAllowList(result);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.list.version).toBe(5);
    expect(parsed.list.shapes.map(s => s.id)).toEqual(['status', 'gh-api-pull-scoped']);
    for (const [command, expected] of [
      ['gh api repos/a/b/pulls/123', 'allow'],
      ['gh api repos/a/b/pulls/123/files', 'ask-op'],
      ['gh api --method PATCH repos/a/b/pulls/123', 'ask-op'],
      ['gh api repos/a/b/pulls/abc', 'ask-op'],
    ] as const) expect(seatApprovalDecision(command, 'bash', parsed.list.shapes).decision).toBe(expected);
  });
  test('refuses corrupt seal, collisions, tombstones and unsafe versions', () => {
    expect(() => addScopedPull('version 1\nlock ' + '0'.repeat(64))).toThrow();
    expect(() => addScopedPull(seal('version 1\nallow gh-api-pull-scoped gh api other'))).toThrow();
    expect(() => addScopedPull(seal('version 1\nrevoke gh-api-pull-scoped 1'))).toThrow();
    expect(() => addScopedPull(seal('version 9007199254740991'))).toThrow();
  });
});
