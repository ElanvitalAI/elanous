import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { ChecklistContent, ChecklistView } from './ChecklistView';
import ChecklistPage from '../../app/ops/checklist/page';
import type { OpsChecklist, OpsResult } from '@/lib/ops-api';

const data: OpsChecklist = {
  version: '0.2.9', green: 2, yellow: 1, red: 3, done: 4,
  items: [
    { id: 'K1', title: '길고 긴 판정 제목', owner: 'OP', status: 'yellow', updatedAt: 'now', evidence: '근거 첫 줄\n근거 둘째 줄' },
    { id: 'K2', title: '녹색', owner: 'MK', status: 'green', updatedAt: 'now' },
    { id: 'K3', title: '빨간색', owner: 'OP', status: 'red', updatedAt: 'now' },
  ],
};
function render(result: OpsResult<OpsChecklist> | null, owner = '', status = '', pendingOnly = false, expandedId: string | null = null) {
  return renderToStaticMarkup(<ChecklistContent result={result} version="0.2.9" owner={owner} status={status} pendingOnly={pendingOnly} expandedId={expandedId}
    onVersion={() => {}} onOwner={() => {}} onStatus={() => {}} onPending={() => {}} onExpand={() => {}} />);
}
describe('OPS2 checklist', () => {
  test('direct checklist route mounts the checklist view', () => {
    const page = ChecklistPage();
    expect(page).toMatchObject({ type: ChecklistView });
  });
  test('renders all four summary counts, suggested versions, row owner/id/status and clipped title', () => {
    const html = render({ kind: 'ready', data });
    for (const count of ['🟢 2', '🟡 1', '🔴 3', '✅ 4']) expect(html).toContain(count);
    for (const v of ['0.2.8', '0.2.9', '0.2.10']) expect(html).toContain(v);
    expect(html).toContain('K1'); expect(html).toContain('OP · yellow'); expect(html).toContain('truncate');
  });
  test('owner, status and pending-only filters compose against real rows', () => {
    const ready = { kind: 'ready', data } as const;
    const byOwner = render(ready, 'MK');
    expect(byOwner).toContain('K2'); expect(byOwner).not.toContain('K1');
    const byStatus = render(ready, '', 'red');
    expect(byStatus).toContain('K3'); expect(byStatus).not.toContain('K2');
    const pending = render(ready, 'OP', '', true);
    expect(pending).toContain('K1'); expect(pending).not.toContain('K3');
    expect(render(ready, 'MK', 'red', true)).toContain('해당하는 칸이 없습니다.');
  });
  test('opening a row shows the full title and multiline evidence', () => {
    const html = render({ kind: 'ready', data }, '', '', false, 'K1');
    expect(html).toContain('근거 첫 줄\n근거 둘째 줄');
    expect(html).toContain('whitespace-pre-wrap');
    expect(html.match(/길고 긴 판정 제목/g)?.length).toBe(2);
    expect(render({ kind: 'ready', data })).not.toContain('근거 첫 줄');
  });
  test('403 renders exactly one sentence and prevents further requests on rerender', async () => {
    expect(render({ kind: 'forbidden' })).toBe('<p>운영자만 볼 수 있습니다</p>');
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const calls: string[] = [];
    const client = { fetchResponse: async (path: string) => {
      calls.push(path);
      return new Response('{}', { status: 403 });
    } };
    const daemon = { config: { baseUrl: '', token: '', provider: '' }, setConfig: () => {}, client: client as never, sessionId: 'test', setSessionId: () => {} };
    let tree: ReturnType<typeof create> | undefined;
    try {
      await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ChecklistView /></DaemonContext.Provider>); });
      expect(tree!.toJSON()).toMatchObject({ type: 'p', children: ['운영자만 볼 수 있습니다'] });
      expect(calls).toEqual(['/v1/ops/checklist?version=0.2.9']);
      await act(async () => { tree!.update(<DaemonContext.Provider value={daemon}><ChecklistView /></DaemonContext.Provider>); });
      expect(calls).toHaveLength(1);
    } finally {
      if (tree) await act(async () => { tree!.unmount(); });
    }
  });
});
