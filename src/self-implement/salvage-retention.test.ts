import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { classifySalvageRetention, formatSalvageRetention, listDatedSalvageRefs, listOpenPrRefs, salvageBranchReferenced } from './salvage-retention.js';
import { installHarnessSalvageRetentionCommand } from '../harness/harness-salvage-cli.js';

const now = new Date('2026-10-08T00:00:00Z');
const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
const none = { openPrs: [], cards: [] };

describe('SALVAGE-RETENTION', () => {
  test('older than 14 days with no PR/card reference is a candidate; young, referenced, unknown-age are not', () => {
    const refs = [
      { branch: 'salvage/run-aaaaaa/self-impl-a-raaaaaa', committedAt: day(20) },
      { branch: 'salvage/run-bbbbbb/self-impl-b-rbbbbbb', committedAt: day(20) },
      { branch: 'salvage/si-task-1/self-impl-c-rcccccc', committedAt: day(30) },
      { branch: 'salvage/run-dddddd/self-impl-d-rdddddd', committedAt: day(3) },
      { branch: 'salvage/run-eeeeee/self-impl-e-reeeeee', committedAt: null },
      { branch: 'salvage/run-ffffff/self-impl-f-rffffff', committedAt: day(15) },
    ];
    const report = classifySalvageRetention({
      refs, now, mode: 'shadow',
      sources: {
        openPrs: [{ number: 1, headRefName: 'salvage/run-bbbbbb/self-impl-b-rbbbbbb' }, { number: 2, headRefName: 'x', body: 'see salvage/run-ffffff/self-impl-f-rffffff' }],
        cards: [{ id: 'ta-1', runId: 'run-cccccc12-0000', text: '{}' }],
      },
    });
    expect(report).toMatchObject({ mode: 'shadow', total: 6, older: 4, referenced: 3, candidates: 1, unknownAge: 1, deleted: 0 });
    expect(report.sample).toEqual(['salvage/run-aaaaaa/self-impl-a-raaaaaa']);
    expect(formatSalvageRetention(report)).toContain('지울 후보(참조 0) 1');
    expect(formatSalvageRetention(report)).toContain('지운 것 0');
  });

  test('card text that names the branch counts as a reference', () => {
    expect(salvageBranchReferenced('salvage/x/y', { openPrs: [], cards: [{ id: 'ta', text: 'kept salvage/x/y for later' }] })).toBe(true);
    expect(salvageBranchReferenced('salvage/x/y', none)).toBe(false);
  });

  test('open PR listing that reaches its limit is incomplete, not «no reference»', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ number: i + 1, headRefName: `h${i}`, body: '' }));
    expect(() => listOpenPrRefs('o/r', () => JSON.stringify(many))).toThrow('limit');
    expect(listOpenPrRefs('o/r', () => JSON.stringify(many.slice(0, 3)))).toHaveLength(3);
  });

  test('GraphQL listing pages through and throws on a broken page (no partial «total»)', () => {
    const pages = [
      { data: { repository: { refs: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [{ name: 'run-a/x', target: { committedDate: day(1) } }] } } } },
      { data: { repository: { refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ name: 'run-b/y', target: {} }] } } } },
    ];
    const calls: string[][] = [];
    const refs = listDatedSalvageRefs('o/r', (args) => { calls.push(args); return JSON.stringify(pages[calls.length - 1]); });
    expect(refs).toEqual([{ branch: 'salvage/run-a/x', committedAt: day(1) }, { branch: 'salvage/run-b/y', committedAt: null }]);
    expect(calls[1]).toContain('after=c1');
    expect(() => listDatedSalvageRefs('o/r', () => JSON.stringify({ data: { repository: null } }))).toThrow('incomplete');
  });

  test('CLI prints the shadow count and never deletes; a failed listing exits 1 without a number', async () => {
    const lines: string[] = [];
    const program = new Command().exitOverride();
    const harness = program.command('harness');
    installHarnessSalvageRetentionCommand(harness, {
      repository: () => 'o/r', mode: () => 'shadow', now: () => now, print: (line) => lines.push(line),
      listRefs: () => [{ branch: 'salvage/run-aaaaaa/z', committedAt: day(40) }], listOpenPrs: () => [], listCards: () => [],
    });
    await program.parseAsync(['node', 'x', 'harness', 'salvage-retention', '--json']);
    expect(JSON.parse(lines[0]!)).toMatchObject({ total: 1, candidates: 1, deleted: 0 });
    const failedLines: string[] = [];
    const failing = new Command().exitOverride();
    installHarnessSalvageRetentionCommand(failing.command('harness'), {
      repository: () => 'o/r', mode: () => 'shadow', print: (line) => failedLines.push(line),
      listRefs: () => { throw new Error('gh down'); }, listOpenPrs: () => [], listCards: () => [],
    });
    const previous = process.exitCode;
    try {
      await failing.parseAsync(['node', 'x', 'harness', 'salvage-retention']);
      expect(failedLines[0]).toContain('못 잼 — gh down');
      expect(process.exitCode).toBe(1);
    } finally { process.exitCode = previous ?? 0; }
  });
});
