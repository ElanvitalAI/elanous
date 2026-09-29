import { expect, test } from 'bun:test';
import type { ReleaseManifest } from '../../src/release-loop/manifest.js';
import { flipNextReleaseMarkers, renderReleaseNotes } from './release-docs.js';

const manifest: ReleaseManifest = {
  version: '9.9.9', baseline: { ref: 'v9.9.8', sha: 'baseline' }, cutoff: { sha: 'cutoff' },
  in: [
    { sha: 'feature', title: 'internal title', prNumber: 12, docs: 'present', line: 'New feature', kind: 'feat' },
    { sha: 'fix', title: 'Bug fix', prNumber: 23, docs: 'n/a', line: 'Fixed behavior', kind: 'fix' },
    { sha: 'security', title: 'Security patch', prNumber: 34, docs: 'n/a', line: 'Safer defaults', kind: 'security' },
    { sha: 'internal', title: 'Maintenance', docs: 'n/a', line: 'Internal refactor', kind: 'internal' },
    { sha: 'unknown', title: 'Uncategorized', docs: 'missing', note: 'missing', kind: 'unknown' },
  ],
  deferred: [{ sha: 'deferred', reason: 'release-target-later' }],
  escalate: [{ kind: 'command-removed', command: 'removed-command' }],
};

test('release notes include only IN lines, group behavior changes, and use flat Markdown PR links', () => {
  const notes = renderReleaseNotes(manifest, '9.9.9');
  expect(notes).toStartWith('# 9.9.9\n');
  expect(notes).toContain('## Behavior changes\n\n- New feature ([#12](https://github.com/ElanvitalAI/elanous/pull/12))\n- Fixed behavior ([#23](https://github.com/ElanvitalAI/elanous/pull/23))');
  expect(notes).toContain('## Security\n\n- Safer defaults ([#34](https://github.com/ElanvitalAI/elanous/pull/34))');
  expect(notes).toContain('## Internal\n\n- Internal refactor');
  expect(notes).toContain('## Other changes\n\n- Uncategorized');
  expect(notes).not.toContain('internal title');
  expect(notes).not.toContain('deferred');
  expect(notes).not.toContain('removed-command');
  expect(notes).not.toMatch(/\[\[[^\n]+\]\([^\n]+\)\]/);
  expect(manifest.in[0]?.line).toBe('New feature');
});

test('empty IN set produces no deferred or escalation notes', () => {
  expect(renderReleaseNotes({ ...manifest, in: [] }, '9.9.9')).toBe('# 9.9.9\n');
});

test('flip every next-release marker while preserving other statuses and unrelated text', () => {
  const text = [
    '| Status (✅ in the latest release · 🟡 on main, in the next release · 🔄 in progress · 📋 designed) |',
    '- item (🟡 on main).',
    '| new feature | 🟡 on main — next release: details · 🔄 still in progress |',
    '| second feature | 🟡 on main — next release |',
    '| shipped | ✅ in the latest release |',
    '| planned | 📋 designed |',
  ].join('\n');
  const result = flipNextReleaseMarkers(text, '9.9.9');
  expect(result).toBe(text.replaceAll('🟡 on main, in the next release', '✅ in v9.9.9')
    .replaceAll('🟡 on main — next release', '✅ in v9.9.9').replaceAll('🟡 on main', '✅ in v9.9.9'));
  expect(flipNextReleaseMarkers(result, '9.9.9')).toBe(result);
  expect(flipNextReleaseMarkers('🟡 on main — next release', 'v9.9.9')).toBe('✅ in v9.9.9');
});
