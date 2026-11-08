import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLatestMorningRlaScorecard, renderRlaScorecardSection } from '../../src/domains/morning-detail.js';
import { buildRlaScorecardReport, parseKnowhowPackIncidents, runRlaScorecardReportCli, type RlaEventResponseScorecardReport } from './rla-event-response-scorecard-report.js';

test('completed fake release ledger and two waiver incidents write a zero-score report for morning rendering', () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-scorecard-report-'));
  try {
    const runId = 'fake-release-run-two-incidents';
    const ledgerDir = join(root, 'graph-runs', 'release-loop');
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(join(ledgerDir, `${runId}.json`), JSON.stringify({
      runId, status: 'done', input: { version: '0.3.6' }, finishedAt: '2026-11-07T12:30:00.000Z',
    }));

    const knowledgePack = join(root, 'knowledge-pack.md');
    writeFileSync(knowledgePack, [
      '| R18 | gate | waiver retry | 코드 회귀 |',
      '| R19 | gate | waiver retried | 코드 회귀 |',
    ].join('\n'));
    const releaseSimRig = join(root, 'release-sim-rig.yaml');
    writeFileSync(releaseSimRig, 'version: 1\ncases: []\n');

    const output = runRlaScorecardReportCli([
      '--run-id', runId,
      '--release', '0.3.6',
      '--knowledge-pack', knowledgePack,
      '--release-sim-rig', releaseSimRig,
      '--state-root', root,
    ], root, 2);
    const stored = JSON.parse(readFileSync(output, 'utf8')) as RlaEventResponseScorecardReport;
    const waiverScore = stored.scores.find(({ eventId }) => eventId === 'RLA-ER-08');
    expect(stored).toMatchObject({ schema: 'elanous.rla-event-response-scorecard.v1', releaseVersion: '0.3.6', runId, liveReleaseMeasurement: false });
    expect(stored.source.knowledgePackIncidentCount).toBe(2);
    expect(waiverScore).toMatchObject({ sampleCount: 2, plannedCount: 0, unsupportedCount: 2, score: 0 });

    const priorStateDir = process.env.ELANOUS_STATE_DIR;
    const latest = (() => {
      try {
        process.env.ELANOUS_STATE_DIR = root;
        return readLatestMorningRlaScorecard();
      } finally {
        if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
        else process.env.ELANOUS_STATE_DIR = priorStateDir;
      }
    })();
    expect(latest).not.toBeNull();
    const markdown = renderRlaScorecardSection(latest!);
    expect(markdown).toContain('시뮬 사건 대응 성적(그림자 계획기 · 실발행 측정 아님)');
    expect(markdown).toContain('RLA-ER-08');
    expect(markdown).toContain('미측정(표본 없음)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preserves unclassified plans at score zero and ignores invalid records', () => {
  const pack = '| R20 | gate | unfamiliar incident | source not mapped |';
  const report = buildRlaScorecardReport({
    releaseVersion: '0.3.6',
    runId: 'fake-unclassified-run',
    generatedAt: '2026-11-07T12:00:00.000Z',
    knowledgePackPath: 'fixture.md',
    knowledgePackText: pack,
    releaseSimRigPath: 'fixture.yaml',
    releaseSimRigText: 'version: 1\ncases: []\n',
    expectedKnowledgePackIncidentCount: 1,
  });
  expect(report.source.unclassifiedKnowledgePackIncidentIds).toEqual(['R20']);
  expect(report.source.unclassifiedKnowledgePackIncidentPlans).toMatchObject([{ id: 'R20', score: 0 }]);
  expect(report.scores.every(({ sampleCount, score }) => sampleCount === 0 && score === 0)).toBe(true);
  expect(() => parseKnowhowPackIncidents('| R21 | gate | symptom only |', 1)).toThrow('malformed KNOWHOW incident row');

  const root = mkdtempSync(join(tmpdir(), 'rla-scorecard-invalid-'));
  try {
    const releaseDir = join(root, '0.3.6');
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, 'scorecard.json'), JSON.stringify({ ...report, generatedAt: 'not-a-date' }));
    expect(readLatestMorningRlaScorecard(root)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
