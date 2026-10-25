import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Suspense, isValidElement, type ComponentProps } from 'react';
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { act, create } from 'react-test-renderer';
import * as liveTraceModule from '@/components/inside/LiveTraceScene';
import * as graphEditorModule from '@/components/inside/GraphEditorScene';
import * as wizardMarketModule from '@/components/inside/WizardMarketScene';
import * as ptyDecisionModule from '@/components/inside/PtyDecisionScene';
import * as activityMapModule from '@/components/inside/LoopActivityMap';
import { DaemonContext } from '@/components/providers/DaemonProvider';

// LOOP-INTERACT 배선 시험 — Page() 가 만든 실제 `<InsidePage loopInteraction=…>` 요소를 렌더해서
// `InsidePageContent → <LoopAgentsScene initialLoopRef>` 가 화면 문구와 원장 조회를 같은 루프 ID 로 묶는지 잰다.
// 배선(초기 루프 ref 전달)을 지우면 «고정 루프» 문구와 `edges?ref=` 요청이 함께 사라져 이 시험이 빨개진다.
// 시험 대상이 아닌 장면(daemon 필요)과 실 DOM 을 요구하는 활동 지도(React Flow)만 stand-in 이고,
// 고정 루프 문구와 원장 조회를 만드는 LoopAgentsScene 은 실제 모듈을 쓴다.
// R-TST23: mock.module 은 프로세스 전역이라 afterAll 에서 원본 스냅샷으로 되돌린다.
const SceneStub = ({ scene }: { scene: string }) => <div data-scene-stub={scene} />;
const realLiveTrace = { ...liveTraceModule };
const realGraphEditor = { ...graphEditorModule };
const realWizardMarket = { ...wizardMarketModule };
const realPtyDecision = { ...ptyDecisionModule };
const realActivityMap = { ...activityMapModule };

await mock.module('@/components/inside/LiveTraceScene', () => ({ LiveTraceScene: () => <SceneStub scene="trace" /> }));
await mock.module('@/components/inside/GraphEditorScene', () => ({ GraphEditorScene: () => <SceneStub scene="editor" /> }));
await mock.module('@/components/inside/WizardMarketScene', () => ({ WizardMarketScene: () => <SceneStub scene="wizard" /> }));
await mock.module('@/components/inside/PtyDecisionScene', () => ({ PtyDecisionScene: () => <SceneStub scene="pty" /> }));
await mock.module('@/components/inside/LoopActivityMap', () => ({ LoopActivityMap: () => <SceneStub scene="activity-map" /> }));

const { default: Page } = await import('./page');
const { InsidePage } = await import('@/components/inside/InsidePage');

afterAll(async () => {
  await mock.module('@/components/inside/LiveTraceScene', () => realLiveTrace);
  await mock.module('@/components/inside/GraphEditorScene', () => realGraphEditor);
  await mock.module('@/components/inside/WizardMarketScene', () => realWizardMarket);
  await mock.module('@/components/inside/PtyDecisionScene', () => realPtyDecision);
  await mock.module('@/components/inside/LoopActivityMap', () => realActivityMap);
});

const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = (async () => new Response(JSON.stringify({ runs: [], entries: [] }))) as unknown as typeof fetch;
  globalThis.document = { hidden: false, addEventListener: () => {}, removeEventListener: () => {} } as unknown as Document;
  globalThis.window = {
    innerWidth: 1200,
    location: { href: 'https://pwa.test/inside' },
    history: { state: null, replaceState: () => {} },
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    Event: class { constructor(public type: string) {} },
    setInterval: () => 1,
    clearInterval: () => {},
  } as unknown as Window & typeof globalThis;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.document = originalDocument;
  globalThis.window = originalWindow;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalAct;
});

function ledgerBody(path: string): unknown {
  if (path.startsWith('/v1/loops/edges')) return { edges: [] };
  if (path.startsWith('/v1/ops/seats')) return { date: '2026-10-22', seats: [] };
  if (path.startsWith('/v1/harness/runs')) return { entries: [] };
  if (path.startsWith('/v1/schedules')) return { schedules: [], owners: [] };
  return { loops: { loops: [] } };
}

function recordingDaemon(requested: string[]): ComponentProps<typeof DaemonContext.Provider>['value'] {
  const record = (path: string) => {
    requested.push(String(path));
    return ledgerBody(String(path));
  };
  return {
    client: {
      fetchResponse: async (path: string) => new Response(JSON.stringify(record(path))),
      fetchJson: async (path: string) => record(path),
      logsStreamUrl: () => null,
    },
    config: { baseUrl: 'https://daemon.test', token: 'mock', provider: 'mock' },
  } as unknown as ComponentProps<typeof DaemonContext.Provider>['value'];
}

/** Page() 가 만든 실제 InsidePage 요소를 주소 조작(`search`)과 원장 기록기로 렌더한다. */
async function renderPageChild(search: URLSearchParams) {
  const requested: string[] = [];
  const page = Page();
  const child = page.props.children;
  if (!isValidElement(child)) throw new Error('Page() 가 InsidePage 요소를 children 으로 싣지 않았다');
  expect(child.type).toBe(InsidePage);
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(
      <SearchParamsContext.Provider value={search}>
        <DaemonContext.Provider value={recordingDaemon(requested)}>
          {child}
        </DaemonContext.Provider>
      </SearchParamsContext.Provider>,
      { createNodeMock: () => ({ getBoundingClientRect: () => ({ width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, x: 0, y: 0 }), offsetWidth: 1200, offsetHeight: 800, style: {}, addEventListener: () => {}, removeEventListener: () => {} }) },
    );
  });
  const fixedLoopNodes = () => root.root.findAllByProps({ 'aria-label': '고정 루프' });
  const edgeRequests = () => requested.filter(path => path.startsWith('/v1/loops/edges?'));
  const openMapView = async () => {
    const view = root.root.findByProps({ 'aria-label': '루프 에이전트 보기' });
    const map = view.findAllByType('button').find(node => node.children.join('') === '지도');
    if (!map) throw new Error('«지도» 버튼을 찾지 못했다');
    await act(async () => { map.props.onClick(); });
  };
  return { root, requested, fixedLoopNodes, edgeRequests, openMapView };
}

test('/inside page connects the client scene to a static-export-safe Suspense boundary', () => {
  const page = Page();
  expect(isValidElement(page)).toBe(true);
  expect(page.type).toBe(Suspense);
  const child = page.props.children;
  expect(isValidElement(child)).toBe(true);
  if (isValidElement(child)) expect(child.type).toBe(InsidePage);
});

test('LOOP-INTERACT: 조작 전후 화면 상태와 원장 기록이 같은 루프 ID 로 대조된다', async () => {
  // 조작 — `/inside?ref=loop-42` 로 조율 루프 하나를 고정한다. 화면 문구와 원장 조회가 그 ID 로 만난다.
  const focused = await renderPageChild(new URLSearchParams('ref=loop-42'));
  try {
    const nodes = focused.fixedLoopNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.children.join('')).toBe('루프 loop-42');
    expect(focused.edgeRequests().some(path => path.includes('ref=loop-42'))).toBe(true);
  } finally {
    await act(async () => focused.root.unmount());
  }

  // 조작 전 — 같은 화면을 `ref` 없이 열고 «지도»를 누른 대조: 고정 문구 없음 · 원장은 60분 창(since) 조회.
  const plain = await renderPageChild(new URLSearchParams(''));
  try {
    expect(plain.fixedLoopNodes()).toHaveLength(0);
    await plain.openMapView();
    const edges = plain.edgeRequests();
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every(path => path.includes('since='))).toBe(true);
    expect(edges.some(path => path.includes('ref='))).toBe(false);
  } finally {
    await act(async () => plain.root.unmount());
  }

  // 갈라짐 금지 — 원장 규칙(isValidRef)이 거부하는 ref 는 화면에도 고정 루프로 뜨지 않고 원장도 그 ID 를 조회하지 않는다.
  const rejected = await renderPageChild(new URLSearchParams('ref=card.1'));
  try {
    expect(rejected.fixedLoopNodes()).toHaveLength(0);
    await rejected.openMapView();
    expect(rejected.edgeRequests().some(path => path.includes('ref=card.1'))).toBe(false);
    expect(rejected.edgeRequests().every(path => path.includes('since='))).toBe(true);
  } finally {
    await act(async () => rejected.root.unmount());
  }

  // 검증 규칙 하나 — 원장 규칙이 받는 ID(121~128자 포함)는 화면과 원장이 함께 고정한다.
  const longRef = `loop-${'a'.repeat(120)}`;
  const accepted = await renderPageChild(new URLSearchParams(`ref=${longRef}`));
  try {
    const nodes = accepted.fixedLoopNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.children.join('')).toBe(`루프 ${longRef}`);
    expect(accepted.edgeRequests().some(path => path.includes(`ref=${longRef}`))).toBe(true);
  } finally {
    await act(async () => accepted.root.unmount());
  }
});
