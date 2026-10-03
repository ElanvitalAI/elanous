import { afterEach, expect, spyOn, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { DaemonClient } from '@/lib/daemon-client';
import { ChatPreviewPanel } from './ChatPreviewPanel';
import { safeParseWorkflowYaml } from './workflow-graph-mutations';

const token = 'owner-secret-preview-token';
const origin = 'https://daemon.example';
const config = { baseUrl: origin, token, provider: '' };
const chatConfig = { workflowName: 'hello', nodeId: 'chat', path: '/hello', streaming: false, sessionMode: 'per-session', hostedUi: { enabled: true, requiresBearer: false } };
const fetchSpy = spyOn(globalThis, 'fetch');
const logSpy = spyOn(console, 'debug');

afterEach(() => {
  fetchSpy.mockReset();
  logSpy.mockReset();
});

function json(response: unknown, status = 200) {
  return new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } });
}

async function mount() {
  const onClose = () => {};
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <DaemonContext.Provider value={{ config, client: new DaemonClient(config), sessionId: '', setSessionId: () => {}, setConfig: () => {} }}>
        <ChatPreviewPanel workflow="hello" onClose={onClose} />
      </DaemonContext.Provider>,
    );
  });
  const text = () => JSON.stringify(renderer.toJSON());
  const send = async (message: string) => {
    await act(async () => {
      renderer.root.findByProps({ 'aria-label': '대화 메시지' }).props.onChange({ target: { value: message } });
    });
    await act(async () => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} });
    });
  };
  const close = async () => act(async () => renderer.unmount());
  return { renderer, text, send, close };
}

test('loads chat-config once on opening; missing or failed config shows no-trigger notice', async () => {
  for (const response of [new Response(null, { status: 404 }), new Response(null, { status: 500 })]) {
    fetchSpy.mockImplementation((async (_url: URL | RequestInfo) => response) as typeof fetch);
    const panel = await mount();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toBe(`${origin}/v1/workflows/hello/chat-config`);
    expect(panel.text()).toContain('이 워크플로에는 채팅 트리거가 없습니다');
    expect(panel.renderer.root.findAllByType('form')).toHaveLength(0);
    await panel.close();
    fetchSpy.mockReset();
  }
});

test('buffered replies, owner header, one session id across two sends; token never appears in render, URL or log', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  fetchSpy.mockImplementation((async (url: URL | RequestInfo, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return init ? json({ response: `reply ${requests.length - 1}`, runId: 'r' }) : json(chatConfig);
  }) as typeof fetch);
  const panel = await mount();
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  await panel.send('one');
  await panel.send('two');
  expect(panel.text()).toContain('reply 1');
  expect(panel.text()).toContain('reply 2');
  expect(requests.map((r) => r.url)).toEqual([
    `${origin}/v1/workflows/hello/chat-config`,
    `${origin}/v1/workflows/chat/hello`,
    `${origin}/v1/workflows/chat/hello`,
  ]);
  const posts = requests.slice(1);
  expect(posts.map((r) => r.init?.method)).toEqual(['POST', 'POST']);
  expect(posts.map((r) => new Headers(r.init?.headers).get('authorization'))).toEqual([`Bearer ${token}`, `Bearer ${token}`]);
  const bodies = posts.map((r) => JSON.parse(String(r.init?.body)) as { message: string; sessionId: string });
  expect(bodies.map((body) => body.message)).toEqual(['one', 'two']);
  expect(bodies[0]?.sessionId).toBeTruthy();
  expect(bodies[1]?.sessionId).toBe(bodies[0]?.sessionId);
  expect(panel.text()).not.toContain(token);
  expect(requests.map((r) => r.url).join(' ')).not.toContain(token);
  expect(JSON.stringify(logSpy.mock.calls)).not.toContain(token);
  expect(logSpy.mock.calls.some((args) => String(args[0]).includes('workflows.chat-preview') && JSON.stringify(args).includes('"chars":7'))).toBe(true);
  await panel.close();
});

test('closing and reopening creates a new preview session and fetches config anew', async () => {
  const sessions: string[] = [];
  fetchSpy.mockImplementation((async (_url: URL | RequestInfo, init?: RequestInit) => {
    if (!init) return json(chatConfig);
    sessions.push((JSON.parse(String(init.body)) as { sessionId: string }).sessionId);
    return json({ response: 'ok' });
  }) as typeof fetch);
  const first = await mount();
  await first.send('one');
  await first.close();
  const second = await mount();
  await second.send('two');
  expect(sessions).toHaveLength(2);
  expect(sessions[0]).not.toBe(sessions[1]);
  expect(fetchSpy).toHaveBeenCalledTimes(4);
  await second.close();
});

test('SSE token frames append progressively and final answer is displayed', async () => {
  const encoder = new TextEncoder();
  let push!: (chunk: string) => void;
  let finish!: () => void;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (chunk) => controller.enqueue(encoder.encode(chunk));
      finish = () => controller.close();
    },
  });
  fetchSpy.mockImplementation((async (_url: URL | RequestInfo, init?: RequestInit) => init
    ? new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    : json({ ...chatConfig, streaming: true })) as typeof fetch);
  const panel = await mount();
  await act(async () => panel.renderer.root.findByProps({ 'aria-label': '대화 메시지' }).props.onChange({ target: { value: 'hi' } }));
  await act(async () => {
    panel.renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} });
    await Promise.resolve();
  });
  await act(async () => { push('event: token\ndata: Hel\n\n'); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(panel.text()).toContain('Hel');
  await act(async () => { push('event: token\ndata: lo\n\nevent: done\ndata: {}\n\n'); finish(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(panel.text()).toContain('Hello');
  expect(panel.text()).not.toContain('입력 중…');
  await panel.close();
});

test('config 401 shows the fixed permission notice rather than a no-trigger notice', async () => {
  fetchSpy.mockImplementation((async (_url: URL | RequestInfo) => new Response(null, { status: 401 })) as typeof fetch);
  const panel = await mount();
  expect(panel.text()).toContain('미리보기 권한이 없습니다 — 채팅 트리거의 hostedUi 설정을 확인하세요');
  expect(panel.text()).not.toContain('이 워크플로에는 채팅 트리거가 없습니다');
  await panel.close();
});

test('401 and 403 show the fixed permission notice without echoing server body or owner token', async () => {
  for (const status of [401, 403]) {
    fetchSpy.mockImplementation((async (_url: URL | RequestInfo, init?: RequestInit) => init
      ? new Response(`sensitive ${token}`, { status }) : json(chatConfig)) as typeof fetch);
    const panel = await mount();
    await panel.send('hello');
    expect(panel.text()).toContain('미리보기 권한이 없습니다 — 채팅 트리거의 hostedUi 설정을 확인하세요');
    expect(panel.text()).not.toContain(token);
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(token);
    await panel.close();
    fetchSpy.mockReset();
    logSpy.mockReset();
  }
});

test('editor only offers preview for parsed chatTrigger nodes and swaps the right pane', () => {
  expect(safeParseWorkflowYaml('name: hello\nnodes:\n  - id: chat\n    chatTrigger:\n      path: /hello\n')?.nodes.some((node) =>
    node.chatTrigger !== null && typeof node.chatTrigger === 'object' && !Array.isArray(node.chatTrigger),
  )).toBe(true);
  expect(safeParseWorkflowYaml('name: hello\nnodes:\n  - id: plain\n    prompt: hi\n')?.nodes.some((node) =>
    node.chatTrigger !== null && typeof node.chatTrigger === 'object' && !Array.isArray(node.chatTrigger),
  )).toBe(false);
  const source = readFileSync(join(import.meta.dir, 'WorkflowsPanel.tsx'), 'utf8');
  expect(source).toContain('safeParseWorkflowYaml(draftYaml)');
  expect(source).toContain('setDraftForName(null)');
  expect(source).toMatch(/parsedForGraph\?\.nodes\.some\(\(node\) =>\s*node\.chatTrigger/);
  expect(source).toMatch(/\{draftForName === selectedName && detail\.data\?\.name === selectedName && hasChatTrigger && \([\s\S]*?대화 미리보기/);
  expect(source).toMatch(/previewWorkflow === selectedName && draftForName === selectedName && detail\.data\?\.name === selectedName && hasChatTrigger && !creatingNew \? \([\s\S]*?<ChatPreviewPanel/);
  expect(source).toContain('onClose={() => setPreviewWorkflow(null)}');
});
