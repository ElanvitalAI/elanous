import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestIntakeItems, listIntakeItems, markIntakeItem } from './items.js';
import { buildIntakeDigest, renderDigestTelegram } from './digest.js';

test('filtered digest excludes unowned queues and MK notes; empty user briefing is a one-line arrival receipt', () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-digest-'));
  const at = '2026-10-04T16:00:00Z';
  try {
    for (const [seat, title] of [['user', 'first'], ['MK', 'other'], ['user', 'second']]) {
      ingestIntakeItems(root, 'github', [{ seat, url: `https://example.com/${title}`, title, kind: 'repo' }], at);
      markIntakeItem(root, listIntakeItems(root).find(item => item.title === title)!.id,
        { status: 'absorbed', output: { kind: 'note', ref: `/notes/${title}.md` } }, at);
    }
    ingestIntakeItems(root, 'github', [{ seat: 'user', url: 'https://example.com/fresh', title: 'fresh', kind: 'repo' }], at);
    expect(buildIntakeDigest(root, '2026-10-05').absorbed).toHaveLength(3);
    const user = buildIntakeDigest(root, '2026-10-05', undefined, undefined, 'user');
    expect(user.absorbed.map(entry => entry.oneLiner ?? entry.noteName)).toEqual(['first', 'second', 'fresh']);
    expect(user.goals).toEqual([]);
    expect(user.news).toBeUndefined();
    expect(renderDigestTelegram(user)).toContain('흡수 3');
    expect(renderDigestTelegram(user)).toContain('fresh');
    expect(renderDigestTelegram(user)).toContain('first');
    expect(renderDigestTelegram(user)).toContain('second');
    expect(renderDigestTelegram(user)).not.toContain('other');
    expect(renderDigestTelegram(buildIntakeDigest(root, '2026-10-06', undefined, undefined, 'user'))).toBe('오늘 새 소식 없음');
    expect(renderDigestTelegram(buildIntakeDigest(root, '2026-10-06'))).toBe('흡수 0 → 우리에게 닿는 것 0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
