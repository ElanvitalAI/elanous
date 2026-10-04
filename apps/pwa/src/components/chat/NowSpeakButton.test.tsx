import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { NowSpeakButton } from './NowSpeakButton';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalUtterance = Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisUtterance');
let tree: ReactTestRenderer | undefined;

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: Window }).window;
  if (originalUtterance) Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', originalUtterance);
  else delete (globalThis as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance }).SpeechSynthesisUtterance;
});

async function mount(fetchResponse: (path: string, init: RequestInit) => Promise<Response>, speech = true) {
  const spoken: Array<{ text: string; lang: string }> = [];
  let cancelled = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: speech ? {
    speechSynthesis: { cancel: () => { cancelled++; }, speak: (utterance: { text: string; lang: string }) => { spoken.push(utterance); } },
  } : {} });
  if (speech) Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
    configurable: true, value: class { lang = ''; constructor(public text: string) {} },
  });
  else delete (globalThis as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance }).SpeechSynthesisUtterance;
  await act(async () => {
    tree = create(<DaemonContext.Provider value={{
      client: { fetchResponse } as never,
      config: { baseUrl: 'http://localhost:31415', token: '', provider: 'anthropic' },
      sessionId: 'session-1', setSessionId: () => {}, setConfig: () => {},
    }}><NowSpeakButton /></DaemonContext.Provider>);
  });
  return { button: tree!.root.findByType('button'), spoken, get cancelled() { return cancelled; } };
}

test('one tap requests the live voice summary with daemon auth and reads its two sentences in Korean', async () => {
  const paths: string[] = [];
  const mounted = await mount(async (path, init) => {
    paths.push(`${init.method} ${path}`);
    return { ok: true, json: async () => ({ text: '지금 CTO는 점검 중입니다。 다음은 미결정 칸을 확인해야 합니다。' }) } as Response;
  });
  expect(mounted.button.props['aria-label']).toBe('지금 상황 듣기');
  await act(async () => { await mounted.button.props.onClick(); });
  expect(paths).toEqual(['GET /v1/context/now?format=voice']);
  expect(mounted.spoken.map(({ text, lang }) => ({ text, lang }))).toEqual([{
    text: '지금 CTO는 점검 중입니다。 다음은 미결정 칸을 확인해야 합니다。', lang: 'ko-KR',
  }]);
  expect(mounted.cancelled).toBe(0);
  await act(async () => { await mounted.button.props.onClick(); });
  expect(paths).toEqual(['GET /v1/context/now?format=voice', 'GET /v1/context/now?format=voice']);
  expect(mounted.spoken).toHaveLength(2);
  expect(mounted.cancelled).toBe(1);
});

test('unavailable voice synthesis disables the button without fetching', async () => {
  let calls = 0;
  const { button, spoken } = await mount(async () => { calls++; return {} as Response; }, false);
  expect(button.props.disabled).toBe(true);
  await act(async () => { await button.props.onClick(); });
  expect(calls).toBe(0);
  expect(spoken).toEqual([]);
});

test('failed or malformed daemon responses never speak and announce a retryable error', async () => {
  let calls = 0;
  const { button, spoken } = await mount(async () => {
    calls++;
    return calls === 1 ? { ok: false, status: 401 } as Response
      : { ok: true, json: async () => ({ text: '' }) } as Response;
  });
  await act(async () => { await button.props.onClick(); });
  expect(tree!.root.findByProps({ role: 'alert' }).children.join('')).toContain('다시 시도');
  await act(async () => { await button.props.onClick(); });
  expect(calls).toBe(2);
  expect(spoken).toEqual([]);
});
