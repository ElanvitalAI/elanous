import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeSeatRequests, listSeatRequests } from '../../src/seat-dispatch/seat-request-ledger.js';
import type { ReleaseManifest } from '../../src/release-loop/manifest.js';
import { calculateDocsFollow, flipNextReleaseMarkers, foldPreLandedNotes, recordDocsFollow, renderReleaseNotes } from './release-docs.js';

const publicExposure = { verdict: 'public' as const, judge: 'MK' as const,
  rubric: 'release/public/expose-rubric.yaml', verifiedAt: '2026-10-05T00:00:00Z' };
const internalExposure = { ...publicExposure, verdict: 'internal' as const };
const betaExposure = { ...publicExposure, verdict: 'beta' as const };

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

test('docs-follow reports missing per-surface evidence and never counts unknown or internal as published', () => {
  const evidence = { location: 'https://docs.elanous.ai/feature', verifiedAt: '2026-10-05T00:00:00Z', publishedAt: '2026-10-04T23:00:00Z' };
  const homepage = { elanous: evidence, elanvital: evidence };
  const release = { ...manifest, in: [manifest.in[0]!, { ...manifest.in[0]!, sha: 'second' }] };
  const report = calculateDocsFollow(release, [
    { id: 'F1', status: 'green', sha: 'feature', exposure: publicExposure, docs: evidence, homepage, readme: evidence },
    { id: 'F2', status: 'green', sha: 'second', exposure: publicExposure, docs: evidence },
    { id: 'not-landed', status: 'green', sha: 'future', exposure: publicExposure, docs: evidence, homepage, readme: evidence },
    { id: 'internal', status: 'green', sha: 'feature', exposure: internalExposure, docs: evidence, homepage, readme: evidence },
    { id: 'beta', status: 'green', sha: 'feature', exposure: betaExposure },
  ]);
  expect(report.ratio).toBeNull();
  expect(report.coverage).toMatchObject([{ id: 'F1', missing: [] }, { id: 'F2', missing: ['homepage', 'readme'] }, { id: 'beta', missing: ['docs', 'homepage', 'readme'] }]);
  expect(report.pending.map((item) => item.id)).toEqual(['F2', 'beta']);
  expect(report.unassessed).toEqual(['not-landed']);
  expect(calculateDocsFollow(release, [{ id: 'F1', status: 'green', sha: 'feature',
    exposure: { ...publicExposure, rubric: '' }, docs: evidence, homepage, readme: evidence }]).coverage).toEqual([]);
  expect(calculateDocsFollow(release, [
    { id: 'F1', status: 'green', sha: 'feature', exposure: publicExposure, docs: evidence, homepage, readme: evidence },
    { id: 'F2', status: 'green', sha: 'second', exposure: publicExposure, docs: evidence },
  ], '2026-10-04T00:00:00Z', '2026-10-05T00:00:00Z').ratio).toBe(0.5);
  expect(report.verdict).toBe('unmeasured');
  expect(calculateDocsFollow(release, []).ratio).toBeNull();
  expect(calculateDocsFollow(release, [{ id: 'F1', status: 'green', sha: 'feature', exposure: publicExposure,
    docs: evidence, homepage: { elanous: evidence, elanvital: { location: '', verifiedAt: evidence.verifiedAt, publishedAt: evidence.publishedAt } }, readme: evidence }])
    .coverage[0]?.homepage).toBe(false);
  expect(calculateDocsFollow(release, []).unassessed).toContain('landing:feature');
  expect(calculateDocsFollow(release, [{ id: 'F1', status: 'green', sha: 'feature', exposure: publicExposure,
    docs: { location: 'somewhere', verifiedAt: 'invalid', publishedAt: evidence.publishedAt } }]).coverage[0]?.docs).toBe(false);
});

test('24-hour coverage passes only when all three surfaces are evidenced and backlog is zero', () => {
  const proof = { location: 'https://elanous.ai/feature', verifiedAt: '2026-10-05T00:00:00Z', publishedAt: '2026-10-04T23:00:00Z' };
  const items = [{ id: 'F1', sha: 'feature', status: 'green', exposure: publicExposure, docs: proof,
    homepage: { elanous: proof, elanvital: proof }, readme: proof }];
  const release = { ...manifest, in: [manifest.in[0]!] };
  expect(calculateDocsFollow(release, items, '2026-10-04T23:00:00Z', '2026-10-05T00:00:00Z'))
    .toMatchObject({ ratio: 1, pending: [], unassessed: [], verdict: 'pass' });
  expect(calculateDocsFollow(release, items, '2026-10-03T00:00:00Z', '2026-10-05T00:00:00Z').verdict).toBe('unmeasured');
  expect(calculateDocsFollow(release, items).verdict).toBe('unmeasured');
  const root = mkdtempSync(join(tmpdir(), 'docs-follow-expired-'));
  try {
    expect(recordDocsFollow(root, release, items, new Date('2026-10-07T00:00:00Z'), '2026-10-04T23:00:00Z').verdict).toBe('pass');
    expect(recordDocsFollow(root, release, [{ ...items[0]!, docs: undefined }],
      new Date('2026-10-07T00:00:00Z'), '2026-10-04T23:00:00Z').verdict).toBe('unmeasured');
    expect(recordDocsFollow(root, release, [{ ...items[0]!, docs: { ...proof, publishedAt: '2026-10-06T00:00:00Z', verifiedAt: '2026-10-06T01:00:00Z' } }],
      new Date('2026-10-07T00:00:00Z'), '2026-10-04T23:00:00Z').verdict).toBe('fail');
    expect(recordDocsFollow(root, release, [{ ...items[0]!, docs: { ...proof, verifiedAt: '2026-10-06T01:00:00Z' } }],
      new Date('2026-10-07T00:00:00Z'), '2026-10-04T23:00:00Z').verdict).toBe('unmeasured');
    expect(recordDocsFollow(root, release, [{ ...items[0]!, docs: { ...proof, publishedAt: '2026-10-06T00:00:00Z', verifiedAt: '2026-10-06T01:00:00Z' } }],
      new Date('2026-10-07T00:00:00Z')).verdict).toBe('unmeasured');
  } finally { rmSync(root, { recursive: true, force: true }); }
  const future = { ...proof, verifiedAt: '2026-10-06T00:00:00Z' };
  expect(calculateDocsFollow(release, [{ ...items[0]!, readme: future }],
    '2026-10-04T23:00:00Z', '2026-10-05T00:00:00Z').coverage[0]?.readme).toBe(false);
  expect(calculateDocsFollow(release, [{ ...items[0]!, docs: { ...proof, publishedAt: '2026-10-06T00:00:00Z' } }],
    '2026-10-04T23:00:00Z', '2026-10-05T00:00:00Z').coverage[0]?.docs).toBe(false);
});

test('late README evidence fails only when the 80% deadline is impossible even if unknowns were timely', () => {
  const publishedAt = '2026-10-04T00:00:00Z';
  const deadline = '2026-10-05T00:00:00Z';
  const timely = { location: 'https://elanous.ai/release', publishedAt: '2026-10-04T12:00:00Z', verifiedAt: deadline };
  const late = { ...timely, publishedAt: '2026-10-05T12:00:00Z', verifiedAt: '2026-10-06T00:00:00Z' };
  const release: ReleaseManifest = { ...manifest, in: Array.from({ length: 10 }, (_, i) =>
    ({ sha: `sha-${i}`, title: `Feature ${i}`, kind: 'feat' as const, line: `Feature ${i}`, docs: 'present' as const })) };
  const items = release.in.map((entry, i) => ({ id: `F${i}`, sha: entry.sha, status: 'green',
    exposure: publicExposure, docs: timely, homepage: { elanous: timely, elanvital: timely },
    readme: i < 7 ? timely : i === 7 ? late : undefined }));
  const after = '2026-10-07T00:00:00Z';
  expect(calculateDocsFollow(release, items, publishedAt, after)).toMatchObject({
    ratio: 0.8, pending: [], unassessed: [], verdict: 'unmeasured',
  });
  expect(calculateDocsFollow(release, items, publishedAt, '2026-10-08T00:00:00Z').verdict).toBe('unmeasured');
  expect(calculateDocsFollow(release, items.map((item, i) => i === 8 ? { ...item, readme: timely } : item),
    publishedAt, after).verdict).toBe('pass');
  expect(calculateDocsFollow(release, items.map((item, i) => i >= 8 ? { ...item, readme: late } : item),
    publishedAt, after).verdict).toBe('fail');
});

test('docs-follow writes measured report and idempotent MK queue only after verified landing input', () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-follow-'));
  try {
    const items = [{ id: 'F1', status: 'green', sha: 'feature', exposure: publicExposure }];
    const first = recordDocsFollow(root, manifest, items, new Date('2026-10-05T00:00:00Z'));
    expect(first.pending).toHaveLength(1);
    recordDocsFollow(root, manifest, items, new Date('2026-10-05T01:00:00Z'));
    const row = listSeatRequests(root, { seat: 'MK', status: 'queued' });
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ key: 'docs-follow:9.9.9:F1', seat: 'MK', status: 'queued' });
    expect(row[0]!.text).toContain('docs, homepage, readme');
    closeSeatRequests(root, [row[0]!.key], { reason: 'MK verified', status: 'done' });
    recordDocsFollow(root, manifest, items, new Date('2026-10-05T02:00:00Z'));
    expect(listSeatRequests(root).filter((entry) => entry.key === row[0]!.key)).toHaveLength(1);
    expect(listSeatRequests(root).find((entry) => entry.key === row[0]!.key)?.status).toBe('done');
    const saved = JSON.parse(readFileSync(join(root, 'release/9.9.9/docs-follow.json'), 'utf8'));
    expect(saved.pending).toMatchObject([{ id: 'F1' }]);
    expect(saved.verdict).toBe('unmeasured');
    expect(saved.unassessed).toEqual(['landing:fix', 'landing:security']);
    expect(listSeatRequests(root, { seat: 'MK' }).map((entry) => entry.key)).toEqual(['docs-follow:9.9.9:F1']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unassessed-only follow-up remains in the per-release report without MK work, even on retry', () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-follow-unassessed-'));
  try {
    const release = { ...manifest, in: [manifest.in[0]!] };
    const items = [{ id: 'F1', status: 'green', sha: 'feature' }];
    const first = recordDocsFollow(root, release, items, new Date('2026-10-05T00:00:00Z'));
    expect(first).toMatchObject({ pending: [], unassessed: ['F1'], verdict: 'unmeasured' });
    recordDocsFollow(root, release, items, new Date('2026-10-05T01:00:00Z'));
    expect(listSeatRequests(root)).toEqual([]);
    const saved = JSON.parse(readFileSync(join(root, 'release/9.9.9/docs-follow.json'), 'utf8'));
    expect(saved).toMatchObject({ pending: [], unassessed: ['F1'], verdict: 'unmeasured', measuredAt: '2026-10-05T01:00:00.000Z' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
