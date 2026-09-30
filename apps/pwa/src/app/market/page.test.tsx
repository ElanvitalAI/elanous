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

async function mount(index: MarketIndexResponse, failure?: 'index' | 'installed', actions: {
  onRefresh?: (name: string) => void;
  onInstall?: (spec: string, capabilities: string[]) => void;
  onInstallLine?: (line: string) => void;
  onRemove?: (name: string) => void;
  installFailure?: string;
  installedRefreshFailure?: boolean;
} = {}) {
  let currentIndex = index;
  let removed = false;
  let installedReads = 0;
  const client = {
    refreshPluginMarket: async (name: string) => {
      actions.onRefresh?.(name);
      currentIndex = { markets: [{ name: 'elanous', signature: 'ok' as const, plugins: [] }] };
      return { ok: true, plugins: [] };
    },
    installMarketPlugin: async (spec: string, caps: string[], onLine: (line: string) => void) => {
      actions.onInstall?.(spec, caps);
      const events = actions.installFailure ? ['resolve', 'verify', 'consent', 'failed'] : ['resolve', 'verify', 'consent', 'credentials', 'registered', 'done'];
      const [pluginName, marketName] = spec.split('@');
      const plugin = currentIndex.markets.find(market => market.name === marketName)?.plugins.find(item => item.name === pluginName);
      const required = plugin?.connectors.some(connector => connector.userConfig.length > 0) ?? false;
      for (const event of events) {
        const line = JSON.stringify({ event, ...(event === 'credentials' ? { required } : {}), ...(event === 'failed' ? { reason: actions.installFailure } : {}) });
        actions.onInstallLine?.(line);
        onLine(line);
      }
    },
    removeMarketPlugin: async (name: string) => { actions.onRemove?.(name); removed = true; return { removed: 1 }; },
    getPluginsIndex: async () => {
      if (failure === 'index') throw new Error('index unavailable');
      return currentIndex;
    },
    getPluginCredentials: async () => ({ fields: [] }),
    putPluginCredentials: async () => ({ set: [] }),
    getInstalledPlugins: async () => {
      installedReads++;
      if (failure === 'installed' || (actions.installedRefreshFailure && installedReads > 1)) throw new Error('installed unavailable');
      if (removed) return [];
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
  expect(root.findAllByType('button').some(node => node.props.children === '공식 마켓 받기')).toBe(true);
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

test('카드 서명 배지, 상세 권한·자격 칸·해시와 동의 뒤 설치 진행', async () => {
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
  const install = root.findAllByType('button').find(node => node.props.children === '설치');
  expect(install?.props.disabled).toBe(false);
  await click('설치');
  expect(JSON.stringify(tree!.toJSON())).toContain('이 플러그인이 요청하는 권한을 확인하세요.');
  await click('동의하고 설치');
  const completed = JSON.stringify(tree!.toJSON());
  expect(root.findByProps({ 'aria-label': '설치 진행' }).findAllByType('li').map(item => item.children.join('')))
    .toEqual(['받는 중', '서명 확인', '권한 동의', '자격 필요 — 이 플러그인은 연결 정보가 필요합니다.', '등록', '완료']);
  expect(completed).toContain('이 플러그인은 연결 정보가 필요합니다.');
  expect(completed).not.toContain('설정에서 입력');
});

test('설치 완료 뒤 설치 목록 조회가 실패해도 완료 상태를 유지하고 목록 오류를 따로 알린다', async () => {
  const installLines: string[] = [];
  const root = await mount({ markets: [{ name: 'elanous', signature: 'ok', plugins: [{
    name: 'signed-plugin', version: '1.0.0', capabilities: ['network'], connectors: [],
    pricing: { model: 'free' }, sha256: 'a'.repeat(64),
  }] }] }, undefined, { installedRefreshFailure: true, onInstallLine: line => installLines.push(line) });
  await click('상세 보기');
  await click('설치');
  await click('동의하고 설치');
  expect(installLines.map(line => JSON.parse(line)).find(item => item.event === 'credentials')).toEqual({ event: 'credentials', required: false });
  const steps = root.findByProps({ 'aria-label': '설치 진행' }).findAllByType('li');
  expect(steps.map(step => step.children.join(''))).toEqual([
    '받는 중', '서명 확인', '권한 동의', '등록', '완료',
  ]);
  expect(JSON.stringify(tree!.toJSON())).not.toContain('이 플러그인은 연결 정보가 필요합니다');
  expect(root.findAllByProps({ role: 'alert' }).map(node => node.children.join('')))
    .toEqual(['설치는 완료됐지만 설치 목록을 불러오지 못했습니다.']);
  await click('설치됨');
  expect(JSON.stringify(tree!.toJSON())).not.toContain('설치된 플러그인이 없습니다.');
});

test('제거 성공 뒤 설치 목록 조회 실패는 제거 실패로 표시하지 않고 확인 상태를 닫는다', async () => {
  const removed: string[] = [];
  await mount({ markets: [] }, undefined, {
    onRemove: name => removed.push(name), installedRefreshFailure: true,
  });
  await click('설치됨');
  await click('제거');
  await click('제거 확인');
  expect(removed).toEqual(['installed-one']);
  const markup = JSON.stringify(tree!.toJSON());
  expect(markup).toContain('플러그인은 제거됐지만 설치 목록을 불러오지 못했습니다.');
  expect(markup).not.toContain('플러그인을 제거하지 못했습니다.');
  expect(markup).not.toContain('제거 확인');
  expect(markup).not.toContain('제거할까요?');
});

test('빈 마켓에서 공식 마켓을 받고 설치된 항목을 한 번 확인한 뒤 제거한다', async () => {
  const refreshed: string[] = [];
  const removed: string[] = [];
  await mount({ markets: [] }, undefined, { onRefresh: name => refreshed.push(name), onRemove: name => removed.push(name) });
  await click('공식 마켓 받기');
  expect(refreshed).toEqual(['elanous']);
  expect(JSON.stringify(tree!.toJSON())).toContain('등록된 플러그인이 없습니다.');
  await click('설치됨');
  await click('제거');
  expect(removed).toEqual([]);
  expect(JSON.stringify(tree!.toJSON())).toContain('제거할까요?');
  await click('취소');
  expect(removed).toEqual([]);
  await click('제거');
  await click('제거 확인');
  expect(removed).toEqual(['installed-one']);
  expect(JSON.stringify(tree!.toJSON())).toContain('설치된 플러그인이 없습니다.');
  expect(JSON.stringify(tree!.toJSON())).not.toContain('installed-one');
});

test('서명된 상세에서 동의 전 설치하지 않고 실패를 한 줄로 표시한다', async () => {
  const installs: Array<{ spec: string; capabilities: string[] }> = [];
  const root = await mount({ markets: [{ name: 'elanous', signature: 'ok', plugins: [{
    name: 'failing-plugin', version: '1.0.0', capabilities: ['network', 'filesystem'],
    connectors: [], pricing: { model: 'free' }, sha256: 'a'.repeat(64),
  }] }] }, undefined, {
    onInstall: (spec, capabilities) => installs.push({ spec, capabilities }), installFailure: 'consent-denied',
  });
  await click('상세 보기');
  await click('설치');
  expect(installs).toEqual([]);
  expect(JSON.stringify(tree!.toJSON())).toContain('filesystem');
  await click('동의하고 설치');
  expect(installs).toEqual([{ spec: 'failing-plugin@elanous', capabilities: ['network', 'filesystem'] }]);
  const steps = root.findByProps({ 'aria-label': '설치 진행' }).findAllByType('li');
  expect(steps.map(step => step.children.join(''))).toEqual([
    '받는 중', '서명 확인', '권한 동의', '실패: 필요한 권한에 동의하지 않았습니다.',
  ]);
  expect(steps.at(-1)?.props.role).toBe('alert');
  expect(JSON.stringify(tree!.toJSON())).not.toContain('consent-denied');
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
  expect(root.findByProps({ role: 'alert' }).children.join('')).toBe('설치 목록을 불러오지 못했습니다.');
  expect(JSON.stringify(tree!.toJSON())).not.toContain('설치된 플러그인이 없습니다.');
});

test('인덱스 조회 실패에도 설치 목록을 사용할 수 있다', async () => {
  const root = await mount({ markets: [] }, 'index');
  expect(root.findByProps({ role: 'alert' }).children.join('')).toBe('마켓을 불러오지 못했습니다.');
  await click('설치됨');
  expect(JSON.stringify(tree!.toJSON())).toContain('installed-one');
  expect(JSON.stringify(tree!.toJSON())).not.toContain('index unavailable');
});
