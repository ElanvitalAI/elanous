import { expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { NewsletterPreferencePanel } from './NewsletterPreferencePanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('authenticated recheck reads and updates the same newsletter preference endpoint', async () => {
  const priorFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; credentials?: RequestCredentials; body?: unknown }> = [];
  let saved = 'declined';
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    requests.push({ url, method: init.method ?? 'GET', credentials: init.credentials,
      ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (init.method === 'PUT') {
      saved = (JSON.parse(String(init.body)) as { choice: string }).choice;
      return Response.json({ ok: true });
    }
    return Response.json({ preference: { choice: saved, revision: 'newsletter-v1' } });
  }) as typeof fetch;
  let tree: ReturnType<typeof create> | null = null;
  try {
    await act(async () => { tree = create(<NewsletterPreferencePanel baseUrl="https://api.example.test" />); await Promise.resolve(); });
    expect(JSON.stringify(tree!.toJSON())).toContain('현재 수신 거부 상태입니다');
    await act(async () => { tree!.root.findByProps({ name: 'newsletterPreference', value: 'opted_in' }).props.onChange(); });
    await act(async () => { await tree!.root.findAllByType('button').find(button => button.children.includes('선택 저장'))!.props.onClick(); });
    expect(requests).toEqual([
      { url: 'https://api.example.test/v1/members/newsletter-preference', method: 'GET', credentials: 'include' },
      { url: 'https://api.example.test/v1/members/newsletter-preference', method: 'PUT', credentials: 'include',
        body: { choice: 'opted_in', revision: 'newsletter-v1' } },
      { url: 'https://api.example.test/v1/members/newsletter-preference', method: 'GET', credentials: 'include' },
    ]);
    expect(JSON.stringify(tree!.toJSON())).toContain('현재 수신 동의 상태입니다');
  } finally {
    if (tree) await act(async () => tree!.unmount());
    globalThis.fetch = priorFetch;
  }
});

test('unrecorded preference remains unselected until a member explicitly chooses', async () => {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ preference: null })) as unknown as typeof fetch;
  let tree: ReturnType<typeof create> | null = null;
  try {
    await act(async () => { tree = create(<NewsletterPreferencePanel />); await Promise.resolve(); });
    expect(JSON.stringify(tree!.toJSON())).toContain('기록된 수신 선택이 없습니다');
    expect(tree!.root.findAllByProps({ name: 'newsletterPreference' }).every(input => !input.props.checked)).toBe(true);
    expect(tree!.root.findAllByType('button').find(button => button.children.includes('선택 저장'))!.props.disabled).toBe(true);
  } finally {
    if (tree) await act(async () => tree!.unmount());
    globalThis.fetch = priorFetch;
  }
});
