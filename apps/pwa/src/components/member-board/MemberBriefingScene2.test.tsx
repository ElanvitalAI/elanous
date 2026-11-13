import { expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MemberMiniBoardScreen } from './MemberMiniBoardView';
import { runScene2PwaWorld } from '../../../../../src/ux-sim/fake-absorb-ingest';
import { recheckedBriefing } from './member-board-model';
import type { MemberMiniBoardApi } from '@/lib/member-mini-board-api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('Scene 2 shows the three ticketing issues only for the verified PWA member', async () => {
  const briefingCalls: Array<{ day: string; appSlug: string }> = [];
  const detailCalls: Array<{ id: string; appSlug: string }> = [];
  const api: MemberMiniBoardApi = {
    getVerifiedOwner: async () => ({ memberId: 'member-a', appSlug: 'lecture-scrap' }),
    getBoard: async () => ({ cards: [] }),
    getBriefings: async (day, appSlug) => {
      briefingCalls.push({ day, appSlug });
      return { briefings: [
        { id: 'ticket-brief', memberId: 'member-a', day },
        { id: 'other-brief', memberId: 'member-b', day, topics: [{ title: '다른 회원의 브리핑' }] },
      ] };
    },
    getBriefing: async (id, appSlug) => {
      detailCalls.push({ id, appSlug });
      return { id, memberId: 'member-a', day: briefingCalls[0]?.day, topics: [
          { title: '동시 접속', summary: '예매 시작 시 접속 폭주' },
          { title: '중복 예매', summary: '같은 좌석 중복 요청', scrapIds: ['article-1'] },
          { title: '공정 대기열', summary: '순서 보존 필요', scrapIds: ['article-1', 'article-2'] },
      ] };
    },
    subscribe: () => () => {},
  };
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<MemberMiniBoardScreen api={api} />); });
  const rendered = JSON.stringify(tree.toJSON());
  for (const issue of ['동시 접속', '중복 예매', '공정 대기열']) expect(rendered).toContain(issue);
  expect(rendered).not.toContain('다른 회원의 브리핑');
  expect(rendered).toContain('브리핑 ID · ');
  expect(rendered).toContain('ticket-brief');
  expect(rendered).toContain('출처 스크랩 · ');
  expect(rendered).toContain('article-1, article-2');
  expect(briefingCalls).toHaveLength(1);
  expect(detailCalls).toEqual([{ id: 'ticket-brief', appSlug: 'lecture-scrap' }]);
  expect(briefingCalls[0]?.appSlug).toBe('lecture-scrap');
  expect(briefingCalls[0]?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await act(async () => tree.unmount());
});

test('Scene 2 refuses mismatched or unlinked detail provenance', () => {
  const listed = { id: 'ticket-brief', memberId: 'member-a', day: '2026-11-14', runId: 'run-a' };
  const detail = { ...listed, topics: [{ title: '동시 접속', scrapIds: ['article-1'] }] };
  expect(recheckedBriefing(listed, detail, 'member-a').sourceScrapIds).toEqual(['article-1']);
  expect(recheckedBriefing(listed, { ...detail, runId: 'run-b' }, 'member-a')).toBe(listed);
  expect(recheckedBriefing(listed, { ...detail, memberId: 'member-b' }, 'member-a')).toBe(listed);
  expect(recheckedBriefing(listed, { ...detail, topics: [{ title: '무출처', scrapIds: [] }] }, 'member-a')).toBe(listed);
});

test('Scene 2 PWA consumes the same catalog-world graph briefing IDs and hides extractor failure', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  for (const failExtraction of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'scene2-pwa-projection-'));
    let tree: ReactTestRenderer | undefined;
    try {
      const runId = failExtraction ? 's2-pwa-extract-failed' : 's2-pwa-same-run';
      const receipt = await runScene2PwaWorld({ root, runId, failExtraction });
      const detail = receipt.briefings[0];
      // This is an explicit fake API projection, not the production briefing-store bridge.
      const api: MemberMiniBoardApi = {
        getVerifiedOwner: async () => ({ memberId: 'scene2-member', appSlug: 'scene2-fake' }),
        getBoard: async () => ({ cards: [] }),
        getBriefings: async () => ({ briefings: detail ? [{ ...detail, topics: undefined }] : [] }),
        getBriefing: async () => detail,
        subscribe: () => () => {},
      };
      await act(async () => { tree = create(<MemberMiniBoardScreen api={api} />); });
      const rendered = JSON.stringify(tree!.toJSON());
      if (failExtraction) {
        expect(rendered).not.toContain('브리핑 ID · ');
        expect(rendered).not.toContain(`${runId}:briefing`);
      } else {
        expect(rendered).toContain(`${runId}:briefing`);
        expect(rendered).toContain(`${runId}:scrap`);
        expect(rendered).toContain(runId);
        expect(rendered).toContain('Web article');
      }
    } finally {
      if (tree) await act(async () => tree!.unmount());
      rmSync(root, { recursive: true, force: true });
    }
  }
});
