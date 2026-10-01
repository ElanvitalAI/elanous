import { expect, test } from 'bun:test';
import { classifyImages, IMAGE_LOAD_STATE_SOURCE, type ImageLoadState } from './image-load-state.js';

const lazy = (inViewport: boolean, complete = false, naturalWidth = 0): ImageLoadState => ({ complete, naturalWidth, loading: 'lazy', inViewport });

test('화면 밖 lazy 셋은 실패가 아닌 pending', () => {
  expect(classifyImages([lazy(false), lazy(false), lazy(false)])).toEqual({ broken: 0, pendingLazy: 3 });
});

test('화면 안 미완료 lazy는 broken', () => {
  expect(classifyImages([lazy(true)])).toEqual({ broken: 1, pendingLazy: 0 });
});

test('완료되었지만 너비 0이면 lazy 여부와 무관하게 broken', () => {
  expect(classifyImages([lazy(false, true), { complete: true, naturalWidth: 0, loading: 'eager', inViewport: true }])).toEqual({ broken: 2, pendingLazy: 0 });
});

test('lazy 아닌 미완료는 broken, 완료 정상 그림은 제외', () => {
  expect(classifyImages([
    { complete: false, naturalWidth: 0, loading: 'eager', inViewport: false },
    { complete: true, naturalWidth: 120, loading: 'lazy', inViewport: false },
  ])).toEqual({ broken: 1, pendingLazy: 0 });
});

test('브라우저 삽입 소스와 Node 판정이 동일', () => {
  const inPage = new Function(`return (${IMAGE_LOAD_STATE_SOURCE})`)() as typeof classifyImages;
  const images = [lazy(false), lazy(true), lazy(false, true)];
  expect(inPage(images)).toEqual(classifyImages(images));
});
