// WorktreesPanel · three-state render contract.
//
// ⛔ bun test has no browser DOM (no jsdom). Click / refetch cannot be
//    exercised here. Same substitute as SchedulerPanel.test.tsx:
//    renderToStaticMarkup and assert the three mutually exclusive
//    copy strings. The empty branch is guarded by `data`, so a failed
//    query does not also print "No worktrees registered."
//
// useWorktrees is the existing data-hook seam (use-worktrees.ts).
// Tests control it the same way other PWA SSR tests control hooks:
// mock.module, then render the public panel.

import { describe, expect, mock, test } from 'bun:test';
import { restoreModuleMocksAfterAll } from '@/lib/testing/restore-module-mocks';
import { renderToStaticMarkup } from 'react-dom/server';

import type { WorktreesResponse, WorktreeView } from '@/nexus/client';

const query: {
  data: WorktreesResponse | undefined;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
  isFetching: boolean;
} = {
  data: undefined,
  isLoading: false,
  error: null,
  refetch: () => undefined,
  isFetching: false,
};

function setQuery(next: {
  data?: WorktreesResponse;
  isLoading?: boolean;
  error?: unknown;
  isFetching?: boolean;
}): void {
  query.data = next.data;
  query.isLoading = next.isLoading ?? false;
  query.error = next.error === undefined ? null : next.error;
  query.isFetching = next.isFetching ?? false;
}

// R-TST23 — 아래 mock.module 은 프로세스 전역이다. 원본을 잡아 두고 파일 끝에 되돌린다(`@/lib/testing/restore-module-mocks`).
await restoreModuleMocksAfterAll([
  '@/nexus/hooks/use-worktrees',
  '@/nexus/hooks/use-nexus-context',
], (specifier) => import(specifier));

mock.module('@/nexus/hooks/use-worktrees', () => ({
  useWorktrees: () => query,
  useDisposeWorktree: () => ({
    mutateAsync: async () => ({ ok: true, action: null }),
    isPending: false,
  }),
}));

mock.module('@/nexus/hooks/use-nexus-context', () => ({
  useOptionalNexusClient: () => ({}),
  useNexusClient: () => ({}),
}));

import { WorktreesPanel } from './WorktreesPanel';

const EMPTY: WorktreesResponse = {
  repoRoot: '/repo',
  worktrees: [],
  orphanedSessions: [],
};

const ROW: WorktreeView = {
  path: '/tmp/feat-x',
  branch: 'feat-x',
  sha: 'abcdef1234567',
  isMain: false,
  isLocked: false,
  isDetached: false,
  session: null,
  orphan: false,
};

const LOADING_COPY = 'Querying /v1/worktrees…';
const EMPTY_COPY = 'No worktrees registered.';
const ERROR_COPY = 'Failed to load worktrees';
const ERROR_REASON = 'daemon unavailable';

function renderPanel(): string {
  return renderToStaticMarkup(<WorktreesPanel />);
}

describe('WorktreesPanel · render contract', () => {
  test('failed query shows the error reason and not the empty copy', () => {
    // Non-Error so the panel's fallback copy is what SSR emits.
    // Pinning only error.message would still pass if this string were deleted.
    setQuery({ error: ERROR_REASON });
    const html = renderPanel();
    expect(html).toContain(ERROR_COPY);
    expect(html).not.toContain(EMPTY_COPY);
    expect(html).not.toContain(LOADING_COPY);
  });

  test('failed query with an Error shows the reason and not the empty copy', () => {
    setQuery({ error: new Error(ERROR_REASON) });
    const html = renderPanel();
    expect(html).toContain(ERROR_REASON);
    expect(html).not.toContain(EMPTY_COPY);
    expect(html).not.toContain(LOADING_COPY);
  });

  test('empty successful list shows the empty copy and not the failure copy', () => {
    setQuery({ data: EMPTY });
    const html = renderPanel();
    expect(html).toContain(EMPTY_COPY);
    expect(html).not.toContain(ERROR_REASON);
    expect(html).not.toContain('Failed to load worktrees');
    expect(html).not.toContain(LOADING_COPY);
  });

  test('pending initial query shows the loading copy', () => {
    setQuery({ isLoading: true });
    const html = renderPanel();
    expect(html).toContain(LOADING_COPY);
    expect(html).not.toContain(EMPTY_COPY);
    expect(html).not.toContain(ERROR_REASON);
    expect(html).not.toContain('Failed to load worktrees');
  });

  test('populated successful list keeps row content distinct from empty and failure', () => {
    setQuery({
      data: { repoRoot: '/repo', worktrees: [ROW], orphanedSessions: [] },
    });
    const html = renderPanel();
    expect(html).toContain('feat-x');
    expect(html).toContain('/tmp/feat-x');
    expect(html).not.toContain(EMPTY_COPY);
    expect(html).not.toContain(ERROR_REASON);
    expect(html).not.toContain('Failed to load worktrees');
    expect(html).not.toContain(LOADING_COPY);
  });
});
