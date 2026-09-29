import { describe, expect, test } from 'bun:test';
import { tabForPath, visitRecord } from './nav-visit';

const items = [
  { href: '/', visibility: 'public' as const },
  { href: '/chat', visibility: 'public' as const },
  { href: '/vault', visibility: 'public' as const },
  { href: '/workspace?intent=term', visibility: 'labs' as const },
  { href: '/worktrees', visibility: 'hidden' as const },
];

describe('nav visit', () => {
  test('path folds to its menu tab (longest prefix, "/" exact only, query and trailing slash dropped)', () => {
    expect(tabForPath('/vault/notes/secret-plan.md', items)).toEqual({ tab: '/vault', visibility: 'public' });
    expect(tabForPath('/chat/', items)).toEqual({ tab: '/chat', visibility: 'public' });
    expect(tabForPath('/', items)).toEqual({ tab: '/', visibility: 'public' });
    expect(tabForPath('/workspace?intent=term', items)).toEqual({ tab: '/workspace', visibility: 'labs' });
    expect(tabForPath('/worktrees', items).visibility).toBe('hidden');
    expect(tabForPath('/nowhere', items)).toEqual({ tab: 'other', visibility: 'other' });
  });

  test('a visit carries the previous tab and dwell; moving inside one tab is not a visit; no full path leaks', () => {
    const first = visitRecord(null, '/chat', 1000, items)!;
    expect(first.record).toEqual({ tab: '/chat', visibility: 'public', from: null, dwellMs: null });
    expect(visitRecord(first.next, '/chat/', 2000, items)).toBeNull();
    const second = visitRecord(first.next, '/vault/notes/secret-plan.md', 61_000, items)!;
    expect(second.record).toEqual({ tab: '/vault', visibility: 'public', from: '/chat', dwellMs: 60_000 });
    expect(JSON.stringify(second.record)).not.toContain('secret-plan');
  });
});
