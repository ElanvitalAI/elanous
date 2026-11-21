import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addedCandidates, auditTestStateWrites, august8Inventory, classifyCandidates, classifyStaticIsolation, renderAudit, unclassifiedCandidates } from './audit-test-state-writes';

describe('audit-test-state-writes static safety classification', () => {
  test('judges copy and symlink writes by destination and rename by both paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'audit-write-target-'));
    try {
      mkdirSync(join(root, 'test'));
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'test', 'candidate.test.ts'), [
        "import { copyFileSync, symlinkSync, renameSync, mkdtempSync } from 'node:fs';",
        "import { homedir, tmpdir } from 'node:os';",
        "import { join } from 'node:path';",
        "const isolated = mkdtempSync(join(tmpdir(), 'fixture-'));",
        "const live = join(homedir(), '.elanous', 'source');",
        "copyFileSync(live, join(isolated, '.elanous', 'copy'));",
        "symlinkSync(live, join(isolated, '.elanous', 'link'));",
        "copyFileSync(join(isolated, 'fixture'), join(homedir(), '.elanous', 'unsafe-copy'));",
        "symlinkSync(join(isolated, 'fixture'), join(homedir(), '.elanous', 'unsafe-link'));",
        "renameSync(live, join(isolated, '.elanous', 'moved-from-home'));",
        "renameSync(join(isolated, 'fixture'), join(homedir(), '.elanous', 'moved-to-home'));",
        "renameSync(join(isolated, '.elanous', 'old'), join(isolated, '.elanous', 'new'));",
      ].join('\n'));
      const report = auditTestStateWrites(root);
      const issues = unclassifiedCandidates(report, new Set());
      expect(issues).toEqual([
        "test/candidate.test.ts:8 copyFileSync(join(homedir(), '.elanous', 'unsafe-copy')) — writes a real HOME path without isolation evidence",
        "test/candidate.test.ts:9 symlinkSync(join(homedir(), '.elanous', 'unsafe-link')) — writes a real HOME path without isolation evidence",
        "test/candidate.test.ts:10 renameSync(live -> join(isolated, '.elanous', 'moved-from-home')) — writes a real HOME path without isolation evidence",
        "test/candidate.test.ts:11 renameSync(join(isolated, 'fixture') -> join(homedir(), '.elanous', 'moved-to-home')) — writes a real HOME path without isolation evidence",
      ]);
      expect(report.findings[0]!.writerCalls.find(({ line }) => line === 12)?.staticSafety).toBe('isolated');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('recognizes only the three approval-safe isolation signals', () => {
    expect(classifyStaticIsolation("process.env.ELANOUS_STATE_DIR; run('--config-dir'); mkdtempSync('/tmp/a')")).toEqual({
      signals: ['ELANOUS_STATE_DIR', '--config-dir', 'mkdtemp'],
      safety: 'isolated',
    });
    expect(classifyStaticIsolation("writeFileSync(join(homedir(), '.elanous', 'unsafe'), 'x')")).toEqual({
      signals: [],
      safety: 'manual-review',
    });
  });

  test('classifies new candidates against the reviewed baseline without pinning the growing August 8 window', () => {
    const report = auditTestStateWrites();
    const reviewed = new Set(readFileSync('test/test-home-state-write-audit-baseline.txt', 'utf8').split('\n').filter((line) => line && !line.startsWith('#')));
    const window = addedCandidates(report, august8Inventory());
    const classification = classifyCandidates(report, window);
    expect(classification.findings.map(({ file }) => file).sort()).toEqual([...window].sort());
    expect(unclassifiedCandidates(report, reviewed)).toEqual([]);
    const rendered = renderAudit(report);
    expect(rendered).toContain(`August 8 candidate window: **${window.size} files**`);
    expect(rendered).toContain('## 분류기 통과(자동)');
    expect(rendered).toContain('a file is ㉡ whenever any writer call lacks a direct approved signal.');
  }, 60_000); // walks every test file — grows with the repo; >5s under release-gate load (0.2.18 gate introduced)
});
