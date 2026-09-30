import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import type { GraphApproval } from '@/lib/graph-approvals-api';
import { GraphApprovals } from './GraphApprovals';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pending: GraphApproval = {
  graphId: 'release-loop', runId: 'waiting', nodeId: 'approve-publish',
  since: new Date().toISOString(), message: '발행할까요?', path: ['prepare', 'approve-publish'],
  recent: [{ nodeId: 'prepare', ok: true, outcome: 'ready' }],
};
let tree: ReactTestRenderer | undefined;
const originalWindow = globalThis.window;
afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  globalThis.window = originalWindow;
});

async function mount(read: () => GraphApproval[], decide: (decision: string) => void, confirm: () => boolean = () => true) {
  let poll: (() => void) | undefined;
  globalThis.window = {
    setInterval: (fn: () => void, ms: number) => { expect(ms).toBe(30_000); poll = fn; return 1; },
    clearInterval: () => {}, confirm,
  } as unknown as Window & typeof globalThis;
  const client = {
    fetchResponse: async (path: string, init?: RequestInit) => {
      expect(path.startsWith('/v1/graph-approvals')).toBe(true);
      if (init?.method === 'POST') {
        decide((JSON.parse(init.body as string) as { decision: string }).decision);
        return Response.json({ graphId: 'release-loop', runId: 'waiting', decision: 'approved' });
      }
      return Response.json({ items: read() });
    },
  };
  await act(async () => {
    tree = create(<DaemonContext.Provider value={{ client } as never}><GraphApprovals /></DaemonContext.Provider>);
  });
  return { poll: () => { expect(poll).toBeDefined(); poll!(); }, root: tree!.root };
}

test('empty section stays hidden; polling shows a pending card; approve reloads and hides it', async () => {
  let items: GraphApproval[] = [];
  const decisions: string[] = [];
  const { poll, root } = await mount(() => items, (decision) => { decisions.push(decision); items = []; });
  expect(tree!.toJSON()).toBeNull();
  items = [pending];
  await act(async () => { poll(); });
  expect(root.findByProps({ 'aria-label': '실행 승인' })).toBeDefined();
  const text = JSON.stringify(tree!.toJSON());
  expect(text).toContain('릴리스 발행');
  expect(text).toContain('approve-publish');
  expect(text).toContain('✓ prepare · ready');
  expect(text).not.toMatch(/[\u{1F150}-\u{1F169}]|<state>|RFC/u);
  await act(async () => { root.findAllByType('button').find(button => button.props.children === '승인')!.props.onClick(); });
  expect(decisions).toEqual(['approved']);
  expect(tree!.toJSON()).toBeNull();
});

test('reject asks again, cancellation does not write, confirmation decides and reloads', async () => {
  let items = [pending];
  let accepted = false;
  const decisions: string[] = [];
  const prompts: string[] = [];
  const { root } = await mount(() => items, (decision) => { decisions.push(decision); items = []; }, () => {
    prompts.push('asked'); return accepted;
  });
  const reject = () => root.findAllByType('button').find(button => button.props.children === '거절')!.props.onClick();
  await act(async () => { reject(); });
  expect(prompts).toHaveLength(1);
  expect(decisions).toEqual([]);
  expect(root.findAllByType('article')).toHaveLength(1);
  accepted = true;
  await act(async () => { reject(); });
  expect(prompts).toHaveLength(2);
  expect(decisions).toEqual(['rejected']);
  expect(tree!.toJSON()).toBeNull();
});
