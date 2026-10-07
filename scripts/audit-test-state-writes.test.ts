import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { addedCandidates, auditTestStateWrites, august8Inventory, classifyCandidates, classifyStaticIsolation, renderAudit, unclassifiedCandidates } from './audit-test-state-writes';

describe('audit-test-state-writes static safety classification', () => {
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
