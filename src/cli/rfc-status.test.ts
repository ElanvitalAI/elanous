import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { adoptedWithoutCard, readRfcRow, registerRfcStatusCommand, runRfcStatus, scanRfcs } from './rfc-status.js';

function fixture(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'rfc-status-'));
  try { mkdirSync(join(root, 'docs', 'archive'), { recursive: true }); fn(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('explicit adopted without card is detected; unknown and proposed are not mislabeled', () => {
  fixture((root) => {
    writeFileSync(join(root, 'docs', 'RFC-adopted.md'), '---\nrfc_status: adopted\nrfc_owner: "TC"\nrfc_card: null\n---\n# A\n');
    writeFileSync(join(root, 'docs', 'RFC-unknown.md'), '---\nstatus: rfc\n---\n# B\n');
    writeFileSync(join(root, 'docs', 'archive', 'RFC-proposed.md'), '---\nrfc_status: proposed\n---\n# C\n');
    const rows = scanRfcs(root);
    expect(rows).toHaveLength(3);
    expect(adoptedWithoutCard(rows).map((row) => row.path)).toEqual(['docs/RFC-adopted.md']);
    expect(rows.find((row) => row.path.endsWith('RFC-unknown.md'))).toMatchObject({ status: 'unknown', owner: null, card: null });
    let output = '';
    runRfcStatus({ json: true, missingCards: true }, root, (text) => { output += text; });
    expect(JSON.parse(output)).toMatchObject({ total: 3, adoptedWithoutCard: 1, rows: [{ path: 'docs/RFC-adopted.md', owner: 'TC' }] });
  });
});

test('replacement and handbook are read from explicit fields; invalid status does not silently become adopted', () => {
  expect(readRfcRow('---\nrfc_status: superseded\nrfc_superseded_by: "docs/RFC-new.md"\nrfc_handbook: null\n---\n', 'docs/RFC-old.md'))
    .toMatchObject({ status: 'superseded', supersededBy: 'docs/RFC-new.md', handbook: null, card: null });
  expect(readRfcRow('---\nrfc_status: finished\n---\n', 'docs/RFC-bad.md'))
    .toMatchObject({ status: 'unknown', issue: 'invalid rfc_status' });
});

test('legacy status and owner are shown verbatim as evidence, never as the lifecycle status', () => {
  const row = readRfcRow('---\nstatus: draft · 🅢 리뷰 반영\nowner: 🅣\nnotes:\n  - **text**: ***not YAML***\n---\n# legacy\n', 'docs/RFC-legacy.md');
  expect(row).toMatchObject({ status: 'unknown', owner: null, legacyStatus: 'draft · 🅢 리뷰 반영', legacyOwner: '🅣', issue: null });
  expect(readRfcRow('# no frontmatter\n', 'docs/RFC-none.md')).toMatchObject({ status: 'unknown', legacyStatus: null, legacyOwner: null, issue: 'lifecycle frontmatter missing' });
  expect(readRfcRow('---\nrfc_status: adopted\nstatus: draft\n---\n', 'docs/RFC-both.md')).toMatchObject({ status: 'adopted', legacyStatus: 'draft' });
});

test('repository RFC inventory keeps unknowns explicit and exposes the HQ adopted-without-card gap', () => {
  const rows = scanRfcs(join(import.meta.dir, '..', '..'));
  expect(rows.length).toBeGreaterThan(100);
  // Docs without lifecycle fields stay unknown (never backfilled with a guessed «unknown» declaration).
  expect(rows.filter((row) => row.issue === 'lifecycle frontmatter missing').length).toBeGreaterThan(0);
  expect(rows.find((row) => row.path === 'docs/RFC-agent-native-plugins-and-connectors-provisioning-2026-09-27.md'))
    .toMatchObject({ status: 'unknown', legacyOwner: '🅣' });
  expect(adoptedWithoutCard(rows)).toContainEqual(expect.objectContaining({
    path: 'docs/RFC-hq-one-repo-role-seats-and-house-ledger-2026-09-30.md', status: 'adopted', owner: 'TC', card: null,
  }));
  expect(rows).toContainEqual(expect.objectContaining({
    path: 'docs/RFC-tui-mid-turn-input-queue-2026-08-19.md', status: 'superseded',
    supersededBy: 'docs/archive/2026-08/RFC-turn-control-interrupt-queue-background-2026-08-19.md',
  }));
  for (const path of ['docs/RFC-scheduler-execution-observability-memory-2026-07-15.md',
    'docs/RFC-mission-arcs-2026-07-14.md', 'docs/archive/2026-05/RFC-provider-ssot-consolidation-2026-05-10.md']) {
    expect(rows.find((row) => row.path === path)?.status).toBe('completed');
  }
  expect(rows.find((row) => row.path === 'docs/RFC-author-par-parallel-goal-authoring-2026-10-04.md'))
    .toMatchObject({ card: 'AUTHOR-PAR', owner: 'MK' });
  expect(rows.find((row) => row.path === 'docs/archive/2026-08/RFC-child-boundary-hitl-and-the-parent-mailbox-2026-08-07.md')?.legacyOwner)
    .toBe('[S] (리딩롤) · 도구 축은 [T]');
});

test('docs CLI command is registered and scans only the provided repository', () => {
  fixture((root) => {
    writeFileSync(join(root, 'docs', 'RFC-A.md'), '---\nrfc_status: completed\nrfc_handbook: "docs/manual/MANUAL-A.md"\n---\n');
    const command = new Command();
    registerRfcStatusCommand(command.command('docs'));
    expect(command.commands[0]!.commands.map((sub) => sub.name())).toContain('rfc-status');
    let result = '';
    runRfcStatus({}, root, (text) => { result += text; });
    expect(result).toContain('completed\t모름\t모름\t모름\tdocs/manual/MANUAL-A.md\t-\t-\tdocs/RFC-A.md');
  });
});

test('rfc-status appends hub backlink and family omission counts', () => {
  fixture((root) => {
    writeFileSync(join(root, 'docs', 'INDEX-loop-agents-and-harness-rfcs.md'),
      '[Loop RFC](RFC-loop-backlink-gap.md)\n');
    writeFileSync(join(root, 'docs', 'RFC-loop-backlink-gap.md'), '# RFC — 루프 연결 점검\n');
    writeFileSync(join(root, 'docs', 'RFC-harness-unlisted.md'), '# RFC — 하니스 미등재 항목\n');

    let output = '';
    runRfcStatus({}, root, (text) => { output += text; });

    expect(output.trimEnd().split('\n').at(-1)).toBe('허브 연결: 되돌림 없음 1 · 미등재 1');
  });
});

test('rfc-status hub line — a hub-linked backlink and a listed family RFC are not counted; no hub is «못 셈», not 0', () => {
  fixture((root) => {
    writeFileSync(join(root, 'docs', 'INDEX-loop-agents-and-harness-rfcs.md'), '[Graph RFC](RFC-graph-linked.md)\n');
    writeFileSync(join(root, 'docs', 'RFC-graph-linked.md'),
      '# RFC — 그래프 연결됨\n> 🔗 연결 참조: [허브](INDEX-loop-agents-and-harness-rfcs.md)\n\n## 본문\n');
    let output = '';
    runRfcStatus({}, root, (text) => { output += text; });
    expect(output.trimEnd().split('\n').at(-1)).toBe('허브 연결: 되돌림 없음 0 · 미등재 0');
  });
  fixture((root) => {
    writeFileSync(join(root, 'docs', 'RFC-loop-orphan.md'), '# RFC — 루프 고아\n');
    let output = '';
    runRfcStatus({}, root, (text) => { output += text; });
    expect(output.trimEnd().split('\n').at(-1)).toContain('허브 연결: 못 셈');
  });
});
