import { readFileSync } from 'node:fs';
import { afterAll, expect, mock, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { WorkflowPublishPanel } from './WorkflowPublishPanel';

const globals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; window?: unknown; navigator?: unknown };
const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
const previousWindow = globals.window;
const previousNavigator = globals.navigator;
globals.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  if (previousAct === undefined) delete globals.IS_REACT_ACT_ENVIRONMENT;
  else globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
  if (previousWindow === undefined) delete globals.window;
  else globals.window = previousWindow;
  if (previousNavigator === undefined) delete globals.navigator;
  else globals.navigator = previousNavigator;
});

const yaml = `nodes:
  - id: incoming
    webhookTrigger:
      method: POST
      path: /hooks/demo
`;

test('publish panel shows empty guidance, closes and copies URL and curl; failed copy reports error', async () => {
  const writeText = mock(async (_value: string) => {});
  globals.navigator = { clipboard: { writeText } };
  const onClose = mock(() => {});
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(<WorkflowPublishPanel yaml="nodes: []" baseUrl="https://example.test/" onClose={onClose} />); });
  expect(JSON.stringify(renderer.toJSON())).toContain('웹훅·채팅 트리거를 넣으면 여기서 주소가 나옵니다');
  await act(async () => renderer.update(<WorkflowPublishPanel yaml={yaml} baseUrl="https://example.test/" onClose={onClose} />));
  const address = 'https://example.test/v1/workflows/webhooks/hooks/demo';
  expect(JSON.stringify(renderer.toJSON())).toContain('웹훅 POST');
  expect(JSON.stringify(renderer.toJSON())).toContain(address);
  await act(async () => renderer.root.findByProps({ 'aria-label': 'incoming 주소 복사' }).props.onClick());
  expect(writeText).toHaveBeenCalledWith(address);
  await act(async () => renderer.root.findByProps({ 'aria-label': 'incoming curl 복사' }).props.onClick());
  expect(writeText).toHaveBeenCalledWith(`curl -X POST '${address}' -H 'content-type: application/json' -d '{}'`);
  writeText.mockImplementation(async () => { throw new Error('denied'); });
  await act(async () => renderer.root.findByProps({ 'aria-label': 'incoming 주소 복사' }).props.onClick());
  expect(JSON.stringify(renderer.toJSON())).toContain('복사하지 못했습니다');
  await act(async () => renderer.root.findByProps({ 'aria-label': '게시 닫기' }).props.onClick());
  expect(onClose).toHaveBeenCalledTimes(1);
  await act(async () => renderer.unmount());
});

// WorkflowsPanel 을 통째로 렌더하면 그래프 캔버스(@xyflow/react)가 DOM 없는 시험 렌더러에서 갱신을 끝없이
// 되풀이한다(10-04 실측 · 제품이 아니라 시험 환경). 이력 시험(WorkflowHistoryPanel.test.tsx)과 같이 배선을 소스로 문다.
test('selected workflow bottom 게시 opens publish exclusive with history, from the saved YAML only', () => {
  const source = readFileSync(new URL('./WorkflowsPanel.tsx', import.meta.url), 'utf8');
  const publishView = source.match(/showPublish && selectedName && !creatingNew \? \([\s\S]*?<WorkflowPublishPanel[\s\S]*?\/>/);
  const bottomActions = source.match(/<footer className="flex items-center justify-end[\s\S]*?<\/footer>/);
  // 데몬이 받는 주소는 «저장된» 판의 트리거다 — 초안(draftYaml)이 아니라 상세 조회 값.
  expect(publishView?.[0]).toMatch(/yaml=\{detail\.data\?\.name === selectedName \? detail\.data\.yaml : ''\}/);
  expect(publishView?.[0]).not.toContain('draftYaml');
  expect(publishView?.[0]).toMatch(/onClose=\{\(\) => setShowPublish\(false\)\}/);
  expect(bottomActions?.[0]).toMatch(/onClick=\{\(\) => \{ setShowPublish\(false\); setShowHistory\(true\); \}\}/);
  expect(bottomActions?.[0]).toMatch(/\{selectedName && !creatingNew && \([\s\S]*?onClick=\{\(\) => \{ setShowHistory\(false\); setShowPublish\(true\); \}\}[\s\S]*?게시/);
  expect(bottomActions?.[0].indexOf('게시')).toBeGreaterThan(bottomActions?.[0].indexOf('이전 판') ?? 0);
});
