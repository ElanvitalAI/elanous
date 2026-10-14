import { afterEach, describe, expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { DaemonClient } from '@/lib/daemon-client';
import { TaskAgentLedgerPanel } from './TaskAgentLedgerPanel';

const config = { baseUrl: 'http://board.test', token: 'owner-token', provider: '' };
const client = new DaemonClient(config);
const wrap = () => <DaemonContext.Provider value={{ config, client, sessionId: '', setConfig: () => {}, setSessionId: () => {} }}>
  <TaskAgentLedgerPanel />
</DaemonContext.Provider>;
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('TaskAgentLedgerPanel', () => {
  test('reads the default board and shows card title, runId, PR, last status and exit reason without mutations', async () => {
    const calls: Array<{ url: string; method?: string; authorization?: string }> = [];
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method, authorization: new Headers(init?.headers).get('Authorization') ?? undefined });
      return Response.json({ board: [{ level: 'project', id: 'p', title: 'Project', children: [
        { level: 'goal', id: 'g', title: 'Goal', children: [
          { level: 'task', id: 't', title: 'Ship task', ledger: { runId: 'run-123', pr: 26321, lastStatus: 'failed', exitReason: 'exit 1' } },
        ] },
      ] }], progress: null });
    }, { preconnect: originalFetch.preconnect });
    let renderer: ReturnType<typeof create> | undefined;
    try {
      await act(async () => { renderer = create(wrap()); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(calls).toEqual([{ url: 'http://board.test/api/task-agent/board', method: undefined, authorization: 'Bearer owner-token' }]);
      const card = renderer!.root.findByType('li');
      const text = JSON.stringify(card.findAllByType('dd').map((item) => item.props.children).concat(card.findByType('h2').props.children));
      for (const value of ['Ship task', 'run-123', '#26321', 'failed', 'exit 1']) expect(text).toContain(value);
      expect(renderer!.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
    } finally { await act(async () => { renderer?.unmount(); }); }
  });

  test('distinguishes an empty ledger from a fetch error', async () => {
    globalThis.fetch = Object.assign(async () => Response.json({ board: [], progress: null }), { preconnect: originalFetch.preconnect });
    let renderer: ReturnType<typeof create> | undefined;
    try {
      await act(async () => { renderer = create(wrap()); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(renderer!.root.findByProps({ role: 'status' }).props.children).toBe('과제 원장이 비어 있습니다.');
      expect(renderer!.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
    } finally { await act(async () => { renderer?.unmount(); }); }
  });

  test('reports HTTP errors instead of rendering an empty ledger', async () => {
    globalThis.fetch = Object.assign(async () => new Response('{"error":"task-agent-ledger-unreadable"}', { status: 503 }), { preconnect: originalFetch.preconnect });
    let renderer: ReturnType<typeof create> | undefined;
    try {
      await act(async () => { renderer = create(wrap()); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(renderer!.root.findByProps({ role: 'alert' }).props.children).toEqual(['과제 원장 조회 실패: ', 'HTTP 503']);
      expect(renderer!.root.findAllByProps({ role: 'status' })).toHaveLength(0);
      expect(renderer!.root.findAllByType('li')).toHaveLength(0);
    } finally { await act(async () => { renderer?.unmount(); }); }
  });
});
