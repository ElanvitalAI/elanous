import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { FeedEdit } from '@/lib/graph-approvals-api';
import { feedItem, sampleFeed } from './feed-fixtures';
import { FeedPreviewCard, FINAL_POST_CONFIRM, type FeedPreviewApi } from './FeedPreviewCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let tree: ReactTestRenderer | undefined;
afterEach(async () => { if (tree) await act(async () => { tree!.unmount(); }); tree = undefined; });

function fakeApi() {
  const calls: string[] = [];
  const saved: FeedEdit[] = [];
  const api: FeedPreviewApi = {
    feedMedia: async (_g, _r, path) => { calls.push(`media ${path}`); return new Blob(['x']); },
    saveFeedDraft: async (_g, _r, edit) => {
      calls.push('save'); saved.push(edit);
      return { feed: { ...sampleFeed, ...edit, cover: { ...sampleFeed.cover, ...edit.cover }, slides: edit.slides, revision: 2, updatedBy: 'human' } };
    },
    decide: async (_g, _r, decision) => { calls.push(`decide ${decision}`); return {}; },
  };
  return { api, calls, saved };
}

const text = () => JSON.stringify(tree!.toJSON());
const button = (label: string) => tree!.root.findAllByType('button').find((b) => b.props.children === label)!;

test('preview is a generic feed card: profile line, cover + included slides with dots, hook, more, hashtags, location', async () => {
  const { api } = fakeApi();
  await act(async () => { tree = create(<FeedPreviewCard item={feedItem} api={api} onDecided={() => {}} confirm={() => true} />); });
  expect(text()).toContain('Elanous');
  expect(text()).toContain('elanous.ai');
  expect(text()).toContain('브릴스 코스닥 상장');
  const dots = () => tree!.root.findAll((n) => typeof n.type === 'string' && n.props['data-dot'] !== undefined).map((n) => n.props['data-dot']);
  expect(dots()).toEqual(['on', 'off', 'off', 'off']);
  await act(async () => { tree!.root.findByProps({ 'aria-label': '다음 장' }).props.onClick(); });
  expect(dots()).toEqual(['off', 'on', 'off', 'off']);
  expect(text()).toContain('오늘 현장에서');
  expect(text()).not.toContain('상장 기념식 현장을 담았습니다.');
  await act(async () => { button('더 보기').props.onClick(); });
  expect(text()).toContain('상장 기념식 현장을 담았습니다.');
  expect(text()).toContain('#코스닥 #상장');
  expect(text()).toContain('한국거래소');
  expect(text()).not.toMatch(/instagram|인스타/i);
});

test('editing reorders, excludes and rewrites; «수정 저장» sends only the edit and keeps the card pending', async () => {
  const { api, calls, saved } = fakeApi();
  let decided = 0;
  await act(async () => { tree = create(<FeedPreviewCard item={feedItem} api={api} onDecided={() => { decided += 1; }} confirm={() => true} />); });
  expect(button('수정 저장').props.disabled).toBe(true);
  await act(async () => { button('편집').props.onClick(); });
  const hook = tree!.root.findAllByType('input').find((i) => i.props.value === '오늘 현장에서')!;
  await act(async () => { hook.props.onChange({ target: { value: '현장 스케치 공개' } }); });
  await act(async () => { tree!.root.findAllByType('button').filter((b) => b.props.children === '뒤로')[0]!.props.onClick(); });
  await act(async () => { tree!.root.findAllByType('button').filter((b) => b.props.children === '빼기')[2]!.props.onClick(); });
  expect(tree!.root.findAll((n) => typeof n.type === 'string' && n.props['data-dot'] !== undefined)).toHaveLength(3);
  await act(async () => { button('수정 저장').props.onClick(); });
  expect(saved).toHaveLength(1);
  expect(saved[0]!.caption.hook).toBe('현장 스케치 공개');
  expect(saved[0]!.slides.map((s) => [s.image, s.include])).toEqual([
    ['feed/slide-2.png', true], ['feed/slide-1.png', true], ['feed/slide-3.png', false],
  ]);
  expect(calls.filter((c) => c.startsWith('decide'))).toEqual([]);
  expect(decided).toBe(0);
  expect(text()).toContain('수정 2');
  expect(text()).toContain('아직 게시 전입니다');
});

test('«최종 게시» approves only after the confirm, saving unsaved edits first', async () => {
  const { api, calls } = fakeApi();
  let answer = false;
  const asked: string[] = [];
  let decided = 0;
  await act(async () => { tree = create(<FeedPreviewCard item={feedItem} api={api} onDecided={() => { decided += 1; }} confirm={(q) => { asked.push(q); return answer; }} />); });
  await act(async () => { button('편집').props.onClick(); });
  const cover = tree!.root.findAllByType('input').find((i) => i.props.value === '브릴스 코스닥 상장')!;
  await act(async () => { cover.props.onChange({ target: { value: '상장 첫날' } }); });
  await act(async () => { button('최종 게시').props.onClick(); });
  expect(asked).toEqual([FINAL_POST_CONFIRM]);
  expect(calls.filter((c) => !c.startsWith('media'))).toEqual([]);
  answer = true;
  await act(async () => { button('최종 게시').props.onClick(); });
  expect(calls.filter((c) => !c.startsWith('media'))).toEqual(['save', 'decide approved']);
  expect(decided).toBe(1);
});
