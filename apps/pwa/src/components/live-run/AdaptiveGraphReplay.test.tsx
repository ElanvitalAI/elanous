import { expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { graphDesignReplayFixture } from '@/test-devices/graph-design-replay';
import { AdaptiveGraphReplayView } from './AdaptiveGraphReplay';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('graph-design replay shows add, replace, remove, conclusion and Bloom origin on the fold screen', async () => {
  const initial = renderToStaticMarkup(<AdaptiveGraphReplayView replay={graphDesignReplayFixture} />);
  expect(initial).toContain('시뮬레이션 재생');
  expect(initial).toContain('r1 변경분');
  expect(initial).toContain('그래프 보기');
  expect(initial).toContain('분석');
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(<AdaptiveGraphReplayView replay={graphDesignReplayFixture} />); });
    const frame = (index: number) => renderer!.root.findByProps({ 'data-testid': `adaptive-frame-${index}` });
    await act(async () => { frame(1).props.onClick(); });
    let tree = JSON.stringify(renderer!.toJSON());
    expect(renderer!.root.findByProps({ 'data-testid': 'adaptive-graph-replay' }).props['data-revision']).toBe('r2');
    expect(tree).toContain('교체');
    expect(tree).toContain('새 전문가 견해가 기존 조사 범위를 무효화했습니다.');
    expect(renderer!.root.findByProps({ 'data-testid': 'adaptive-node-map' }).props['data-node-state']).toBe('invalidated');
    await act(async () => { frame(2).props.onClick(); });
    tree = JSON.stringify(renderer!.toJSON());
    expect(tree).toContain('제거');
    expect(tree).toContain('새 견해를 반영한 조건부 결론');
    expect(tree).toContain('정보 제공·판단 보조이며 투자 권유 아님');
    const bloomOrigin = renderer!.root.findAllByType('button').find((button) => button.children.includes('낳은 노드 보기'))!;
    await act(async () => { bloomOrigin.props.onClick(); });
    expect(renderer!.root.findByProps({ 'data-testid': 'adaptive-node-conclude' }).props.className).toContain('ring-2');
    expect(renderer!.root.findByProps({ 'aria-label': '그래프 판' }).props.className).toContain('block');
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
  }
});
