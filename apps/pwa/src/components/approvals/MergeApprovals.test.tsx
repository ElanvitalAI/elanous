import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { MergeApprovals } from './MergeApprovals';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let tree: ReactTestRenderer | undefined;
const originalWindow = globalThis.window;
afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  globalThis.window = originalWindow;
});

async function mount(role: string | null) {
  globalThis.window = {
    localStorage: { getItem: () => role, setItem: () => {} },
    location: { search: '', pathname: '/app/approvals/' }, history: { replaceState: () => {} },
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
    setInterval: () => 1, clearInterval: () => {}, confirm: () => false,
  } as unknown as Window & typeof globalThis;
  const client = { fetchResponse: async () => Response.json({ items: [] }) };
  await act(async () => {
    tree = create(<DaemonContext.Provider value={{ client } as never}><MergeApprovals /></DaemonContext.Provider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

test('TXT2 — an empty code-change queue is folded away for a device without the owner role', async () => {
  await mount(null);
  expect(tree!.toJSON()).toBeNull();
});

test('TXT2 — the owner sees the Korean heading and the empty sentence', async () => {
  await mount('owner');
  const text = JSON.stringify(tree!.toJSON());
  expect(text).toContain('코드 변경 승인');
  expect(text).toContain('승인을 기다리는 코드 변경이 없습니다.');
  expect(text).not.toMatch(/Approvals|아이디어 PR/);
});
