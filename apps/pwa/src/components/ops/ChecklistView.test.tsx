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
function render(result: OpsResult<OpsChecklist> | null, owner = '', status = '', pendingOnly = false, expandedId: string | null = null, now?: number) {
  return renderToStaticMarkup(<ChecklistContent result={result} version="0.2.9" owner={owner} status={status} pendingOnly={pendingOnly} expandedId={expandedId} now={now}
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
  test('schedule precedes counts and shows local cut, deadline and remaining time', () => {
    const schedule = { cutAt: '2026-10-03T08:00:00Z', landBy: '2026-10-03T06:30:00Z' };
    const html = render({ kind: 'ready', data: { ...data, schedule } }, '', '', false, null, Date.parse('2026-10-02T17:10:00Z'));
    const dated = render({ kind: 'ready', data: { ...data, schedule } }, '', '', false, null, Date.parse('2026-09-30T17:10:00Z'));
    const cut = new Date(schedule.cutAt);
    const local = `${String(cut.getHours()).padStart(2, '0')}:${String(cut.getMinutes()).padStart(2, '0')}`;
    expect(dated).toContain(`컷 ${String(cut.getMonth() + 1).padStart(2, '0')}/${String(cut.getDate()).padStart(2, '0')} (${['일', '월', '화', '수', '목', '금', '토'][cut.getDay()]}) ${local}`);
    expect(html).toContain('착지 마감');
    expect(html).toContain('마감까지 13시간 20분');
    expect(html.indexOf('aria-label="판 일정"')).toBeLessThan(html.indexOf('aria-label="상태별 수"'));
    expect(html).not.toContain('text-orange-600');
  });
  test('today/tomorrow, three-hour urgency, overdue, cut-only and missing schedule', () => {
    const now = Date.parse('2026-10-02T10:00:00Z');
    const today = new Date(now);
    today.setHours(12, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const scheduled = (cutAt: string, landBy: string | null, at = now) =>
      render({ kind: 'ready', data: { ...data, schedule: { cutAt, landBy } } }, '', '', false, null, at);
    expect(scheduled(today.toISOString(), new Date(now + 3 * 60 * 60 * 1000).toISOString())).toContain('컷 오늘 12:00');
    expect(scheduled(today.toISOString(), new Date(now + 3 * 60 * 60 * 1000).toISOString())).toContain('text-orange-600');
    expect(scheduled(tomorrow.toISOString(), null)).toContain('컷 내일 12:00');
    const cutOnly = scheduled(tomorrow.toISOString(), null);
    expect(cutOnly).not.toContain('착지 마감'); expect(cutOnly).not.toContain('마감까지');
    const overdue = scheduled(today.toISOString(), new Date(now - 60_000).toISOString());
    expect(overdue).toContain('착지 마감 지남'); expect(overdue).toContain('text-red-600');
    expect(render({ kind: 'ready', data: { ...data, schedule: null } })).toContain('판 일정 없음');
    const prevDayLand = new Date(today.getTime() - 24 * 60 * 60 * 1000 + 60 * 60 * 1000);
    const crossDay = scheduled(today.toISOString(), prevDayLand.toISOString(), today.getTime() - 3 * 24 * 60 * 60 * 1000);
    expect(crossDay).toContain(`착지 마감 ${String(prevDayLand.getMonth() + 1).padStart(2, '0')}/${String(prevDayLand.getDate()).padStart(2, '0')}`);
    expect(render({ kind: 'ready', data })).toContain('판 일정 없음');
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
  test('minute timer pauses while hidden, resumes immediately and cleans up', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const savedWindow = globalThis.window;
    const savedDocument = globalThis.document;
    const savedNow = Date.now;
    let clock = Date.parse('2026-10-02T10:00:00Z');
    let hidden = false;
    let timer: (() => void) | undefined;
    let onVisibility: (() => void) | undefined;
    const periods: number[] = [];
    let clears = 0;
    globalThis.window = { setInterval: (fn: () => void, ms: number) => { timer = fn; periods.push(ms); return 1; }, clearInterval: () => { timer = undefined; clears++; } } as never;
    globalThis.document = { get hidden() { return hidden; }, addEventListener: (_: string, fn: () => void) => { onVisibility = fn; }, removeEventListener: () => { onVisibility = undefined; } } as never;
    Date.now = () => clock;
    const deadline = new Date(clock + 181 * 60_000).toISOString();
    const daemon = { config: { baseUrl: '', token: '', provider: '' }, setConfig: () => {},
      client: { fetchResponse: async () => new Response(JSON.stringify({ ...data, schedule: { cutAt: deadline, landBy: deadline } })) } as never,
      sessionId: 'test', setSessionId: () => {} };
    let tree: ReturnType<typeof create> | undefined;
    const text = () => JSON.stringify(tree!.toJSON());
    try {
      await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ChecklistView /></DaemonContext.Provider>); });
      expect(periods).toEqual([60_000]);
      expect(text()).toContain('마감까지 3시간 1분');
      clock += 60_000;
      await act(async () => { timer?.(); });
      expect(text()).toContain('마감까지 3시간');
      expect(text()).toContain('text-orange-600');
      hidden = true;
      await act(async () => { onVisibility?.(); });
      expect(timer).toBeUndefined();
      clock += 60_000;
      expect(text()).toContain('마감까지 3시간');
      hidden = false;
      await act(async () => { onVisibility?.(); });
      expect(text()).toContain('마감까지 2시간 59분');
      expect(periods).toEqual([60_000, 60_000]);
    } finally {
      if (tree) await act(async () => { tree!.unmount(); });
      globalThis.window = savedWindow;
      globalThis.document = savedDocument;
      Date.now = savedNow;
      expect(clears).toBe(2);
      expect(onVisibility).toBeUndefined();
    }
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
