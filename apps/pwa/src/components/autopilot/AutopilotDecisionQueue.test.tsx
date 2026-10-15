import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { DaemonClient } from '@/lib/daemon-client';
import { AutopilotDecisionQueue } from './AutopilotDecisionQueue';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
});

const pending = {
  id: 'one', title: '결정할 일', situation: '맥락', raisedAt: '2026-10-13T01:00:00Z',
  options: [{ id: 'yes', label: '진행' }], recommendation: { option: 'yes', why: '우선' },
};
const later = { ...pending, id: 'two', title: '뒤 결정', dueAt: '2026-10-14T09:00:00Z' };

/** 스텁은 전체 시그니처(path, init?)로만 받는다 — 인자 0개 리터럴을 그대로 캐스팅하면
 *  DaemonClient 와 구조적 겹침이 안 된다(TS2352). ChatDecisionsChip.test 의 setup(request) 패턴. */
function mockDaemonClient(fetchResponse: (path: string, init?: RequestInit) => Promise<Response>): DaemonClient {
  return { fetchResponse } as DaemonClient;
}

async function mount(client: DaemonClient) {
  await act(async () => { tree = create(<AutopilotDecisionQueue client={client} />); });
  return tree!.root.findByProps({ 'aria-label': '결정 대기' });
}

test('N건(3 초과): 총 열린 결정 수(4건)를 세고 상위 3건만 마감-오름순으로 보여준다 · decide는 부르지 않는다', async () => {
  const decisions = [pending, later, { ...pending, id: 'three', title: '셋' }, { ...pending, id: 'four', title: '넷' }];
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = mockDaemonClient(async (path, init) => { calls.push({ path, init }); return new Response(JSON.stringify({ decisions })); });
  const section = await mount(client);
  const items = section.findAllByType('li');
  expect(items).toHaveLength(3);
  const titles = items.map(li => li.findAllByType('span').map(span => String(span.props.children)).join(''));
  expect(titles[0]).toBe('뒤 결정 · 기한 2026-10-14T09:00:00Z');
  expect(titles.map(t => t.split(' · ')[0])).toEqual(['뒤 결정', '결정할 일', '셋']);
  // N 은 slice 후 길이가 아니라 «총» 열린 결정 수다 — 4건 입력이 «3건»으로 잘리면 안 된다.
  expect(section.findAllByType('p').map(p => String(p.props.children))).toContain('결정 대기 4건 · 상위 3건 표시');
  expect(section.findByProps({ href: '/decisions' })).toBeTruthy();
  // 읽기 전용 — 목록 GET 정확히 1건, decide(POST)는 0건
  expect(calls.map(call => call.path)).toEqual(['/v1/decisions?status=open']);
  expect(calls.every(call => call.init === undefined)).toBe(true);
});

test('N건(3 이하): 잘림 없이 총수를 그대로 보여준다(«상위 3건 표시» 문구 없음)', async () => {
  const client = mockDaemonClient(async () => new Response(JSON.stringify({ decisions: [pending, later] })));
  const section = await mount(client);
  expect(section.findAllByType('li')).toHaveLength(2);
  const texts = section.findAllByType('p').map(p => String(p.props.children));
  expect(texts).toContain('결정 대기 2건');
  expect(texts.join('\n')).not.toContain('상위');
});

test('0건: «열린 결정 없음»을 렌더하고 실패 상태와 구별된다', async () => {
  const client = mockDaemonClient(async () => new Response(JSON.stringify({ decisions: [] })));
  const section = await mount(client);
  expect(section.findAllByType('li')).toHaveLength(0);
  expect(section.findAllByProps({ role: 'alert' })).toHaveLength(0);
  expect(section.findAllByType('p').map(p => String(p.props.children))).toContain('열린 결정 없음');
  expect(section.findByProps({ href: '/decisions' })).toBeTruthy();
});

test('실패: fetch가 던지면 0건과 구별된 «못 읽음» 상태를 렌더한다', async () => {
  const client = mockDaemonClient(async () => new Response('nope', { status: 409 }));
  const section = await mount(client);
  expect(section.findAllByType('li')).toHaveLength(0);
  const alertNodes = section.findAllByProps({ role: 'alert' });
  expect(alertNodes).toHaveLength(1);
  expect(String(alertNodes[0].props.children)).toContain('결정 대기 못 읽음');
  expect(section.findAllByType('p').map(p => String(p.props.children))).not.toContain('열린 결정 없음');
});
