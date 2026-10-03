import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import type { ElanousCardData, ElanousCardItem } from '@/lib/elanous-card';
import { ElanousCard } from './ElanousCard';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const item = (title: string, daysLeft: number | null, extra: Partial<ElanousCardItem> = {}): ElanousCardItem =>
  ({ title, due: daysLeft === null ? null : '2026-10-05', daysLeft, state: 'open', owner: 'OP', ...extra });
const card = (kind: ElanousCardData['kind'], items: ElanousCardItem[] = []): ElanousCardData => ({ kind, items });
const render = (data: ElanousCardData) => renderToStaticMarkup(<ElanousCard card={data} />);
const titles = (html: string) => [...html.matchAll(/data-elanous-card-item="\d+".*?(?:<span class="font-medium">|underline-offset-2"[^>]*>)([^<]+)</g)].map((m) => m[1]);

describe('ElanousCard', () => {
  test('heading per kind with the item count', () => {
    expect(render(card('coo-admin', [item('a', 1)]))).toContain('운영 할 일');
    expect(render(card('release-schedule'))).toContain('판 일정');
    expect(render(card('release-checklist'))).toContain('판별 칸');
    expect(render(card('coo-admin', [item('a', 1), item('b', 2)]))).toContain('· 2');
    expect(render(card('coo-admin'))).toContain('항목이 없습니다');
  });

  test('D-day badge from the server daysLeft: overdue red · today/≤3 orange · later plain · null none', () => {
    const html = render(card('coo-admin', [item('late', -2), item('today', 0), item('soon', 3), item('later', 9), item('none', null)]));
    expect(html).toContain('2일 지남');
    expect(html).toMatch(/data-due-status="overdue"[^>]*>2일 지남/);
    expect(html).toMatch(/data-due-status="soon"[^>]*>오늘/);
    expect(html).toMatch(/data-due-status="soon"[^>]*>D-3/);
    expect(html).toContain('D-9');
    expect(html).not.toMatch(/data-due-status="[a-z]+"[^>]*>D-9/);
  });

  test('orders by daysLeft, undated last, ties keep input order', () => {
    const html = render(card('coo-admin', [item('undated', null), item('later', 5), item('first', -1), item('tie a', 2), item('tie b', 2)]));
    expect(titles(html)).toEqual(['first', 'tie a', 'tie b', 'later', 'undated']);
  });

  test('state · owner · due line, and only http(s) or same-origin links become links', () => {
    const html = render(card('release-checklist', [
      item('safe', 1, { url: '/ops/checklist', state: 'yellow', owner: 'UX' }),
      item('bad', 2, { url: 'javascript:alert(1)' }),
    ]));
    expect(html).toContain('yellow · UX · 2026-10-05');
    expect(html).toContain('href="/ops/checklist"');
    expect(html).not.toContain('javascript:');
  });

  test('shows 12 items then «N개 더 보기» expands the rest', () => {
    const many = Array.from({ length: 15 }, (_, i) => item(`t${i}`, i));
    let renderer: ReturnType<typeof create> | undefined;
    act(() => { renderer = create(<ElanousCard card={card('coo-admin', many)} />); });
    expect(renderer!.root.findAll((n) => n.props['data-elanous-card-item'] !== undefined)).toHaveLength(12);
    const more = renderer!.root.findByType('button');
    expect(more.props.children).toEqual([3, '개 더 보기']);
    act(() => more.props.onClick());
    expect(renderer!.root.findAll((n) => n.props['data-elanous-card-item'] !== undefined)).toHaveLength(15);
    act(() => renderer!.unmount());
  });
});
