import { expect, test } from 'bun:test';
import type { ReleaseManifest } from '../../src/release-loop/manifest.js';
import { flipNextReleaseMarkers, foldPreLandedNotes, renderReleaseNotes } from './release-docs.js';

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

test('release notes show only curated public IN lines without private PR links', () => {
  const notes = renderReleaseNotes(manifest, '9.9.9');
  expect(notes).toBe('# 9.9.9\n\n## Behavior changes\n\n- New feature\n- Fixed behavior\n\n## Security\n\n- Safer defaults\n\nPlus 2 internal changes.\n');
  expect(notes).not.toContain('internal title');
  expect(notes).not.toContain('Uncategorized');
  expect(notes).not.toContain('Internal refactor');
  expect(notes).not.toContain('deferred');
  expect(notes).not.toContain('removed-command');
  expect(notes).not.toContain('github.com');
  expect(manifest.in[0]?.line).toBe('New feature');
});

test('title-only fix and non-public kinds count as omitted, without exposing private text or PR numbers', () => {
  const m: ReleaseManifest = { ...manifest, in: [
    { sha: 'feat', title: 'private title', line: 'Adds X', kind: 'feat', docs: 'present', prNumber: 21896 },
    { sha: 'fix', title: '게이트 파서 수리', kind: 'fix', docs: 'n/a' },
    { sha: 'internal', title: '인계 §P12', kind: 'internal', docs: 'n/a' },
    { sha: 'unknown', title: 'docs: 인계', kind: 'unknown', docs: 'n/a' },
  ] };
  const notes = renderReleaseNotes(m, '0.2.5');
  expect(notes).toBe('# 0.2.5\n\n## Behavior changes\n\n- Adds X\n\nPlus 3 internal changes.\n');
  expect(notes).not.toContain('github.com');
  expect(notes).not.toContain('21896');
  expect(notes).not.toContain('인계');
  expect(notes).not.toContain('게이트');
});

test('one omitted entry renders a singular footer and folding pre-landed notes keeps it once', () => {
  const m: ReleaseManifest = { ...manifest, in: [
    { sha: 'feat', title: 'private title', line: 'Adds X', kind: 'feat', docs: 'present' },
    { sha: 'internal', title: 'private maintenance', kind: 'internal', docs: 'n/a' },
  ] };
  const rendered = renderReleaseNotes(m, '0.2.5');
  expect(rendered).toBe('# 0.2.5\n\n## Behavior changes\n\n- Adds X\n\nPlus 1 internal change.\n');
  const folded = foldPreLandedNotes(rendered, rendered);
  expect(folded.text).toBe(rendered);
  expect(folded.text.match(/^Plus 1 internal change\.$/gm)).toHaveLength(1);
  expect(folded.folded).toBe(0);
  expect(foldPreLandedNotes(folded.text, rendered).text).toBe(rendered);
});

test('empty IN set produces no deferred or escalation notes', () => {
  expect(renderReleaseNotes({ ...manifest, in: [] }, '9.9.9')).toBe('# 9.9.9\n');
});

test('title-only IN lines omit the empty section and leave only the count', () => {
  expect(renderReleaseNotes({ ...manifest, in: [{ sha: 'fix', title: 'private fix', docs: 'n/a', kind: 'fix' }] }, '9.9.9'))
    .toBe('# 9.9.9\n\nPlus 1 internal change.\n');
});

test('pre-landed headline and hand-written lines survive before the omission count, including a second fold', () => {
  const existing = '# 0.2.5\n\nLaunch headline.\n\n## Known issues\n\n- Restart after install.\n';
  const rendered = renderReleaseNotes(manifest, '0.2.5');
  const folded = foldPreLandedNotes(existing, rendered).text;
  expect(folded).toContain('# 0.2.5\n\nLaunch headline.\n');
  expect(folded).toContain('## Known issues\n\n- Restart after install.\n');
  expect(folded).toEndWith('Plus 2 internal changes.\n');
  expect(foldPreLandedNotes(folded, rendered).text).toBe(folded);
});

test('pre-landed linked and unlinked manual lines survive in the generated headings', () => {
  const rendered = renderReleaseNotes({ ...manifest, in: [] }, '0.2.5');
  const existing = '# 0.2.5\n\nLaunch headline.\n\n## Behavior changes\n\n- Hand-written fix ([#21896](https://github.com/ElanvitalAI/elanous/pull/21896))\n- Hand-written unlinked fix.\n';
  const folded = foldPreLandedNotes(existing, rendered).text;
  expect(folded).toBe(existing);
  expect(foldPreLandedNotes(folded, rendered).text).toBe(folded);
});

test('hand-written unlinked line with the same wording as an omitted title survives', () => {
  const m: ReleaseManifest = { ...manifest, in: [{ sha: 'fix', title: '게이트 파서 수리', docs: 'n/a', kind: 'fix' }] };
  const rendered = renderReleaseNotes(m, '0.2.5');
  const existing = '# 0.2.5\n\nLaunch headline.\n\n## Behavior changes\n\n- 게이트 파서 수리\n';
  const folded = foldPreLandedNotes(existing, rendered).text;
  expect(folded).toBe('# 0.2.5\n\nLaunch headline.\n\n## Behavior changes\n\n- 게이트 파서 수리\n\nPlus 1 internal change.\n');
  expect(foldPreLandedNotes(folded, rendered).text).toBe(folded);
});

test('unverified links and unlinked lines under Other changes stay intact', () => {
  const rendered = renderReleaseNotes({ ...manifest, in: [] }, '0.2.5');
  const existing = '# 0.2.5\n\n## Other changes\n\n- Hand-written link ([#21899](https://github.com/ElanvitalAI/elanous/pull/21899))\n- Hand-written note.\n';
  expect(foldPreLandedNotes(existing, rendered).text).toBe(existing);
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
