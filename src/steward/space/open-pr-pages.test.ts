import { describe, expect, test } from 'bun:test';
import { flattenOpenPrPages } from '../../kit/work-pull/open-pr-pages.js';
import { parsePrs } from './sources.js';

const page = (nodes: unknown[]) => ({ data: { repository: { pullRequests: { nodes } } } });
const pr = (n: number) => ({ number: n, headRefOid: `head${n}`, headRefName: `branch${n}`, body: n === 201 ? '칸: CELL-A' : '', isDraft: true, updatedAt: '2026-11-28T06:00:00Z', files: { nodes: [{ path: 'src/a.ts' }] } });

describe('open PR pagination', () => {
  test('retains old-numbered PRs on later pages, including drafts and files', () => {
    const prs = parsePrs(flattenOpenPrPages([page(Array.from({ length: 100 }, (_, i) => pr(i + 1))), page(Array.from({ length: 100 }, (_, i) => pr(i + 101))), page([pr(201)])]));
    expect(prs).toHaveLength(201);
    expect(prs[200]).toMatchObject({ number: 201, body: '칸: CELL-A', draft: true, files: ['src/a.ts'] });
  });
  test('rejects incomplete pages instead of returning partial results', () => {
    expect(() => flattenOpenPrPages([page([pr(1)]), { data: {} }])).toThrow();
  });
});
