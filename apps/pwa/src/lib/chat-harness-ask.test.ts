import { describe, expect, test } from 'bun:test';
import type { DaemonClient } from './daemon-client';
import { dispatchMeta, META_HANDLERS, type ChatRuntimeContext } from './chat-runtime';
import { harnessAskSettled, harnessAskText, harnessPhaseLabel } from './chat-harness-ask';

describe('harness ask routing', () => {
  test('extracts only explicit one-line harness requests', () => {
    expect(harnessAskText('/harness 버튼 고쳐')).toBe('버튼 고쳐');
    expect(harnessAskText('하니스로 버튼 고쳐')).toBe('하니스로 버튼 고쳐');
    expect(harnessAskText('  하니스로 버튼 고쳐  ')).toBe('  하니스로 버튼 고쳐  ');
    expect(harnessAskText('하니스 좋다')).toBeNull();
    expect(harnessAskText('하니스로')).toBeNull();
    expect(harnessAskText('/harness 첫 줄\n둘째 줄')).toBeNull();
    expect(harnessAskText('/harness')).toBe('');
    expect(harnessAskText('/harness   ')).toBe('');
    expect(harnessAskText('/harnessed 버튼 고쳐')).toBeNull();
  });

  test('maps all five daemon phases and settles only on launch outcomes', () => {
    expect(['accepted', 'flow-settled', 'launch-started', 'launch-settled', 'launch-failed', 'other']
      .map(harnessPhaseLabel)).toEqual(['접수됨', '골 저작 끝', '런 도는 중', '런 끝', '발사 실패', '알 수 없는 단계']);
    for (const phase of ['accepted', 'flow-settled', 'launch-started', 'other']) expect(harnessAskSettled(phase)).toBe(false);
    expect(harnessAskSettled('launch-settled')).toBe(true);
    expect(harnessAskSettled('launch-failed')).toBe(true);
  });

  test('submits slash and natural language once without sending ordinary prose to the daemon', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const ctx: ChatRuntimeContext = {
      client: { fetchJson: async (path: string, init?: RequestInit) => {
        calls.push({ path, init });
        return { acceptanceId: '12345678-abcdef' };
      } } as unknown as DaemonClient,
      sessionId: 's', provider: 'anthropic', setSessionId: () => {},
    };
    expect(typeof META_HANDLERS[':harness']).toBe('function');
    expect(await dispatchMeta('/harness 버튼 고쳐', ctx)).toEqual({
      text: '하니스 접수 · 12345678', harnessAsk: { acceptanceId: '12345678-abcdef' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/v1/harness/ask');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ text: '버튼 고쳐' });
    expect((await dispatchMeta('/harness 버튼 고쳐', ctx))?.text).not.toContain('아직 안 됩니다');
    expect(await dispatchMeta('하니스로 버튼 고쳐', ctx)).toEqual({
      text: '하니스 접수 · 12345678', harnessAsk: { acceptanceId: '12345678-abcdef' },
    });
    expect(JSON.parse(String(calls.at(-1)!.init?.body))).toEqual({ text: '하니스로 버튼 고쳐' });
    expect(await dispatchMeta('하니스 좋다', ctx)).toBeNull();
    expect(await dispatchMeta('버튼 고쳐', ctx)).toBeNull();
    expect(await dispatchMeta('/harness 첫 줄\n둘째 줄', ctx)).toEqual({ text: '무엇을 맡길까요? /harness <한 줄>' });
    expect(calls).toHaveLength(3);
  });

  test('empty input explains usage; errors expose only the first 200 characters of the first line', async () => {
    let calls = 0;
    const ctx: ChatRuntimeContext = {
      client: { fetchJson: async () => { calls++; throw new Error(`${'x'.repeat(220)}\nsecret`); } } as unknown as DaemonClient,
      sessionId: 's', provider: '', setSessionId: () => {},
    };
    expect(await dispatchMeta('/harness', ctx)).toEqual({ text: '무엇을 맡길까요? /harness <한 줄>' });
    expect(calls).toBe(0);
    expect(await dispatchMeta('/harness 버튼 고쳐', ctx)).toEqual({ text: `하니스 접수 실패 — ${'x'.repeat(200)}` });
    expect(calls).toBe(1);
  });
});
