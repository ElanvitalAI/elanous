import { describe, expect, test } from 'bun:test';
import { extractApprovalBrief, extractLineage, handleMergeApprovals, IDEA_APPROVAL_LABEL } from './merge-approvals';

const body = `아이디어: c7e…

## 승인 요약

원문: [아이디어](https://example.com/original)

**SCQA** — 원문에서 출발해 과정을 거쳐 좋아지는 것과 위험을 판단한다.

## 요청

이 절은 승인 카드에 나오면 안 된다.`;

describe('approval brief from the PR body', () => {
  test('extracts lineage on the first line and preserves Markdown only until the next H2', () => {
    expect(extractLineage(body)).toBe('c7e…');
    const brief = extractApprovalBrief(body);
    expect(brief).toContain('**SCQA**');
    expect(brief).toContain('[아이디어](https://example.com/original)');
    expect(brief).not.toContain('## 요청');
    expect(extractApprovalBrief('## 승인 요약\n내용\n---\n비공개')).toBe('내용');
    const indented = extractApprovalBrief('  ## 승인 요약\n**SCQA**\n   ## 요청\n이 절은 승인 카드에 나오면 안 된다.');
    expect(indented).toBe('**SCQA**');
  });

  test('missing or empty approval brief and missing first-line lineage are null', () => {
    expect(extractApprovalBrief('본문에 승인 요약이 없다')).toBeNull();
    expect(extractApprovalBrief('## 승인 요약\n\n## 요청')).toBeNull();
    expect(extractLineage('본문\n아이디어: c7e…')).toBeNull();
  });

  test('caps a 9,000-character brief at 8,000 including the ellipsis', () => {
    const brief = extractApprovalBrief(`## 승인 요약\n${'가'.repeat(9_000)}`);
    expect(brief).toHaveLength(8_000);
    expect(brief?.endsWith('…')).toBe(true);
  });

  test('GET /v1/approvals/merges/1 includes the parsed brief and lineage from fake gh', async () => {
    const pr = {
      number: 1, title: 'Idea', url: 'https://github.com/o/r/pull/1', headRefOid: 'aaa',
      baseRefName: 'main', isDraft: false, mergeable: 'UNKNOWN', additions: 1, deletions: 0,
      changedFiles: 1, files: [{ path: 'src/a.ts' }], body, createdAt: '2026-09-27T00:00:00Z',
      state: 'OPEN', labels: [{ name: IDEA_APPROVAL_LABEL }], statusCheckRollup: [],
    };
    const calls: string[][] = [];
    const response = await handleMergeApprovals(new Request('http://localhost/v1/approvals/merges/1'), {
      authorize: () => true, repo: () => 'o/r',
      // No network: the default base tip would call the real GitHub API (it used to block synchronously).
      baseTip: async () => null,
      gh: (args) => {
        calls.push(args);
        return { ok: true, stdout: JSON.stringify(pr), stderr: '', code: 0 };
      },
    });
    expect(response.status).toBe(200);
    const detail = await response.json();
    expect(detail.brief).toContain('**SCQA**');
    expect(detail.brief).not.toContain('## 요청');
    expect(detail.lineage).toBe('c7e…');
    expect(detail.summary).toBe(body.split(/\n\s*\n/)[0]);
    expect(detail.mergeable).toBe('UNKNOWN');
    expect(calls).toEqual([['pr', 'view', '1', '--repo', 'o/r', '--json', expect.stringContaining('body')]]);
  });
});

test('closing hashes on the heading are the same heading (CommonMark ATX)', async () => {
  const { extractApprovalBrief } = await import('./merge-approvals');
  expect(extractApprovalBrief('## 승인 요약 ##\n**한 줄** — 된다\n\n## 요청\n안 싣는다')).toBe('**한 줄** — 된다');
  expect(extractApprovalBrief('##   승인 요약   ###\n내용')).toBe('내용');
});
