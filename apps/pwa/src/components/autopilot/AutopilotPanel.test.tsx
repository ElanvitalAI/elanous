import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import type { DaemonClient } from '@/lib/daemon-client';
import { AutopilotPanel } from './AutopilotPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
});

// fetchJson/fetchResponse never settle: the static render must not depend on any daemon reply.
// fetchResponse 를 포함시켜 결정 대기 칸이 쓰는 전송까지 모킹 환경이 통제한다(부작용 누수 방지).
const pendingClient = {
  fetchJson: () => new Promise(() => {}),
  fetchResponse: () => new Promise(() => {}),
} as unknown as DaemonClient;

function providerValue(client: DaemonClient) {
  return {
    client,
    config: { baseUrl: '', token: '', provider: '' },
    sessionId: '',
    setConfig: () => {},
    setSessionId: () => {},
  };
}

function renderPanel(): string {
  return renderToStaticMarkup(
    <DaemonContext.Provider value={providerValue(pendingClient)}>
      <AutopilotPanel />
    </DaemonContext.Provider>,
  );
}

/** 패널 전체를 interactive 로 마운트 — 결정 대기 칸이 패널 안에서 listOpenDecisions fetch 를
 *  발사하는 부작용·렌더 간섭을 실측한다(정적 렌더는 효과가 안 돌므로 잴 수 없는 것). */
async function mountPanel(client: DaemonClient): Promise<ReactTestRenderer> {
  await act(async () => {
    tree = create(
      <DaemonContext.Provider value={providerValue(client)}>
        <AutopilotPanel />
      </DaemonContext.Provider>,
    );
  });
  return tree!;
}

function tabLabels(renderer: ReactTestRenderer): string[] {
  const bar = renderer.root.findAllByProps({ className: 'flex gap-1 border-b border-border' });
  expect(bar).toHaveLength(1);
  return bar[0]!.findAllByType('button').map(button => String(button.props.children));
}

describe('AutopilotPanel static render', () => {
  test('shows only Missions and 자율행동 tabs, defaults to Missions, and has exactly one h1', () => {
    const html = renderPanel();
    const tabBar = html.match(/<div class="flex gap-1 border-b border-border">([\s\S]*?)<\/div>/)?.[1];

    expect(tabBar).toBeDefined();
    expect([...tabBar!.matchAll(/<button\b[^>]*>(.*?)<\/button>/g)].map((match) => match[1])).toEqual([
      'Missions', '자율행동',
    ]);
    expect(html).toContain('Missions');
    expect(html).toContain('자율행동');
    expect(html).not.toContain('Repo Watch');
    expect(html).not.toContain('루프 오케스트라');
    expect(html).not.toContain('투자 루프 오케스트라');
    // default tab = Missions (inline goal composer is rendered)
    expect(html).toContain('골 던지기');
    expect(html).toContain('<textarea');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    // 결정 대기 칸: ArmingBanner 헤더 아래·탭 바 위 — 정적 렌더(효과 없음)에서는 로딩 상태가 렌더된다
    expect(html).toContain('결정 대기');
    expect(html).toContain('결정 대기 읽는 중');
    expect(html).toContain('href="/decisions"');
  });

  test('Missions empty state points up to the composer, not down', () => {
    const src = readFileSync(join(import.meta.dir, 'AutopilotMissions.tsx'), 'utf8');
    expect(src).not.toContain('아래 &ldquo;골 던지기&rdquo;');
    expect(src).toContain('위 &ldquo;골 던지기&rdquo;');
    // composer is placed before the empty-state text in the source order
    expect(src.indexOf('골 던지기 <span')).toBeLessThan(src.indexOf('위 &ldquo;골 던지기&rdquo;'));
  });
});

const decision = {
  id: 'd-1', title: '예약된 결정', situation: '상황',
  options: [{ id: 'a', label: '진행' }], recommendation: { option: 'a', why: '이유' },
};

describe('AutopilotPanel 결정 대기 칸 (모킹 client 로 fetch 부작용 실측)', () => {
  test('데이터 있음: 결정 2건 → «결정 대기 2건» · 탭 2개·h1 1개 불변식 유지', async () => {
    const calls: string[] = [];
    const client = {
      fetchJson: () => new Promise(() => {}),
      fetchResponse: (path: string) => {
        calls.push(path);
        return path === '/v1/decisions?status=open'
          ? Promise.resolve(new Response(JSON.stringify({ decisions: [decision, { ...decision, id: 'd-2', title: '다음 결정' }] })))
          : new Promise<Response>(() => {});
      },
    } as unknown as DaemonClient;
    const renderer = await mountPanel(client);

    // 칸은 패널 안에서 목록 GET 을 정확히 1번 발사한다(decide POST 는 큐 시험이 별도 단언)
    expect(calls.filter(path => path === '/v1/decisions?status=open')).toHaveLength(1);
    const section = renderer.root.findByProps({ 'aria-label': '결정 대기' });
    expect(section.findAllByType('p').map(p => String(p.props.children))).toContain('결정 대기 2건');
    expect(tabLabels(renderer)).toEqual(['Missions', '자율행동']);
    expect(renderer.root.findAllByType('h1')).toHaveLength(1);
  });

  test('데이터 없음: 열린 결정 0건 → «열린 결정 없음» · 실패(alert) 아님', async () => {
    const client = {
      fetchJson: () => new Promise(() => {}),
      fetchResponse: (path: string) => path === '/v1/decisions?status=open'
        ? Promise.resolve(new Response(JSON.stringify({ decisions: [] })))
        : new Promise<Response>(() => {}),
    } as unknown as DaemonClient;
    const renderer = await mountPanel(client);

    const section = renderer.root.findByProps({ 'aria-label': '결정 대기' });
    expect(section.findAllByType('p').map(p => String(p.props.children))).toContain('열린 결정 없음');
    expect(section.findAllByProps({ role: 'alert' })).toHaveLength(0);
    expect(tabLabels(renderer)).toEqual(['Missions', '자율행동']);
    expect(renderer.root.findAllByType('h1')).toHaveLength(1);
  });
});
