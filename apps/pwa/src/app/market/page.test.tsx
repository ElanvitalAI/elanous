import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import type { MarketIndexResponse } from '@/nexus/client';
import MarketPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
});

async function mount(index: MarketIndexResponse, failure?: 'index' | 'installed') {
  const client = {
    getPluginsIndex: async () => {
      if (failure === 'index') throw new Error('index unavailable');
      return index;
    },
    getInstalledPlugins: async () => {
      if (failure === 'installed') throw new Error('installed unavailable');
      return [{ name: 'installed-one', version: '2.0.0', market: 'verified', path: '/test/installed-one', sha256: null }];
    },
  };
  await act(async () => {
    tree = create(<NexusProvider client={client as never}><MarketPage /></NexusProvider>);
  });
  return tree!.root;
}

async function click(label: string) {
  const button = tree!.root.findAllByType('button').find(node => node.props.children === label);
  expect(button).toBeDefined();
  await act(async () => { button!.props.onClick(); });
}

test('마켓 페이지의 빈 마켓 안내와 세 탭 전환', async () => {
  const root = await mount({ markets: [] });
  expect(root.findByType('main').props['aria-label']).toBe('마켓');
  expect(JSON.stringify(tree!.toJSON())).toContain('아직 받아 둔 마켓이 없습니다');
  // 사용자 화면에 트랙 표지·저장소 내부 경로가 새지 않는다.
  expect(JSON.stringify(tree!.toJSON())).not.toMatch(/[\u{1F150}-\u{1F169}]|<state>/u);
  await click('상세');
  expect(JSON.stringify(tree!.toJSON())).toContain('찾아보기에서 플러그인을 선택하세요.');
  await click('설치됨');
  expect(JSON.stringify(tree!.toJSON())).toContain('installed-one');
  expect(JSON.stringify(tree!.toJSON())).toContain('설치 시각:');
  expect(JSON.stringify(tree!.toJSON())).toContain('알 수 없음');
  expect(root.findAllByType('time')).toHaveLength(0);
  await click('찾아보기');
  expect(JSON.stringify(tree!.toJSON())).toContain('아직 받아 둔 마켓이 없습니다');
});

test('카드 서명 배지, 상세 권한·자격 칸·해시, 비활성 설치 버튼', async () => {
  const root = await mount({ markets: [
    { name: 'unsigned', signature: 'missing', plugins: [{ name: 'unsigned-plugin', version: '1', capabilities: [], connectors: [], pricing: { model: 'free' }, sha256: 'b'.repeat(64) }] },
    { name: 'verified', signature: 'ok', plugins: [{ name: 'signed-plugin', version: '2', capabilities: ['network'], connectors: [{ id: 'api', kind: 'http', userConfig: [{ key: 'token', label: 'API token', secret: true }] }], graphs: ['sample-graph'], pricing: { model: 'free' }, sha256: 'a'.repeat(64) }] },
  ] });
  const markup = JSON.stringify(tree!.toJSON());
  expect(markup.indexOf('signed-plugin')).toBeLessThan(markup.indexOf('unsigned-plugin'));
  expect(markup).toContain('✅ 서명 확인');
  expect(markup).toContain('⚠️ 서명 없음');
  expect(markup).toContain('무료');
  await act(async () => { root.findAllByType('button').find(node => node.props.children === '상세 보기')!.props.onClick(); });
  const detail = JSON.stringify(tree!.toJSON());
  expect(detail).toContain('network');
  expect(detail).toContain('API token');
  expect(detail).toContain('sample-graph');
  expect(detail).toContain('aaaaaaaaaaaa');
  const install = root.findAllByType('button').find(node => node.props.children === '설치 · 곧');
  expect(install?.props.disabled).toBe(true);
});

test('설치 목록 조회 실패에도 찾아보기와 상세를 사용할 수 있다', async () => {
  const root = await mount({ markets: [{
    name: 'verified', signature: 'ok', plugins: [{
      name: 'available-plugin', version: '1', capabilities: ['network'], connectors: [],
      pricing: { model: 'free' }, sha256: 'c'.repeat(64),
    }],
  }] }, 'installed');
  expect(JSON.stringify(tree!.toJSON())).toContain('available-plugin');
  expect(JSON.stringify(tree!.toJSON())).not.toContain('installed unavailable');
  await act(async () => { root.findAllByType('button').find(node => node.props.children === '상세 보기')!.props.onClick(); });
  expect(JSON.stringify(tree!.toJSON())).toContain('network');
  await click('설치됨');
  expect(root.findByProps({ role: 'alert' }).children.join('')).toBe('설치 목록을 불러오지 못했습니다: installed unavailable');
  expect(JSON.stringify(tree!.toJSON())).not.toContain('설치된 플러그인이 없습니다.');
});

test('인덱스 조회 실패에도 설치 목록을 사용할 수 있다', async () => {
  const root = await mount({ markets: [] }, 'index');
  expect(root.findByProps({ role: 'alert' }).children.join('')).toBe('마켓을 불러오지 못했습니다: index unavailable');
  await click('설치됨');
  expect(JSON.stringify(tree!.toJSON())).toContain('installed-one');
  expect(JSON.stringify(tree!.toJSON())).not.toContain('index unavailable');
});
