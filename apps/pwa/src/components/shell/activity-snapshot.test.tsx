import { afterAll, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ObservatorySubject } from '@/components/observatory/subject-list';
import { classifySubject } from '@/components/observatory/subject-list';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import type { DaemonLogEntry } from '@/lib/daemon-client';
import {
  activityAriaLabel,
  buildActivitySnapshot,
  observatoryHref,
  selectLiveActivity,
  type ShellActivitySnapshot,
} from './activity-snapshot';
import { fetchActivitySnapshot } from './fetch-activity-snapshot';
import { FabricStageHeader } from './FabricStageHeader';
import { TopBarActivityIndicator } from './TopBarActivityIndicator';
import * as realNavigation from 'next/navigation';
import * as realNexusContext from '@/nexus/hooks/use-nexus-context';

// R-TST23 — mock.module 은 프로세스 전역이다. 끝에 원본으로 되돌린다
// (안 되돌리면 뒤에 도는 파일이 가짜 use-nexus-context 를 받는다 · setup/done 시험 2건이 여기서 깨졌다).
const originalNavigation = { ...realNavigation };
const originalNexusContext = { ...realNexusContext };
afterAll(() => {
  mock.module('next/navigation', () => originalNavigation);
  mock.module('@/nexus/hooks/use-nexus-context', () => originalNexusContext);
});

mock.module('next/navigation', () => ({
  usePathname: () => '/term',
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
}));

mock.module('@/nexus/hooks/use-nexus-context', () => ({
  useOptionalNexusClient: () => null,
  useNexusClient: () => ({}),
}));

import { AppShell } from './AppShell';
import { TopBar } from './TopBar';

function subject(overrides: Partial<ObservatorySubject> = {}): ObservatorySubject {
  return {
    id: 'subject:run-1',
    runId: 'run-1',
    origin: 'system',
    screen: { ptyIds: [], liveCount: 0 },
    agent: { names: [], controllers: [] },
    talk: [],
    ...overrides,
  };
}

function progressLog(ptyId: string, runId: string, humanLine: string, id = 1): DaemonLogEntry {
  return {
    id,
    ts: '2026-08-15T00:00:00.000Z',
    level: 'info',
    surface: 'headless',
    category: 'progress',
    event: 'headless.progress-frame',
    data: { ptyId, runId, planId: 'plan-1', seq: 1, humanLine },
  };
}

const LIVE_RUN = {
  subjectId: 'subject:self_82122f50',
  runId: 'self_82122f50',
  origin: 'system' as const,
  progressLine: '● orchestrator.ts에서 중단 산출 보존 훅',
  progressStatus: 'complete' as const,
  href: '/observatory#subject%3Aself_82122f50',
};

const ACTIVE: Extract<ShellActivitySnapshot, { kind: 'active' }> = {
  kind: 'active',
  extraLiveCount: 0,
  run: LIVE_RUN,
};

const ERROR: Extract<ShellActivitySnapshot, { kind: 'error' }> = {
  kind: 'error',
  message: 'GET /v1/terminals failed (503)',
};

const STUB_DAEMON = {
  config: { baseUrl: '', token: '', provider: '' },
  setConfig: () => undefined,
  client: {} as never,
  sessionId: 'shell-test',
  setSessionId: () => undefined,
};

function wrap(node: React.ReactNode): React.ReactNode {
  return (
    <DaemonContext.Provider value={STUB_DAEMON}>
      <ThemeProvider>{node}</ThemeProvider>
    </DaemonContext.Provider>
  );
}

function renderTopBar(snapshot: ShellActivitySnapshot): string {
  return renderToStaticMarkup(
    wrap(<TopBar onToggleSidebar={() => undefined} sidebarOpen={false} activity={snapshot} />),
  );
}

function renderShell(snapshot: ShellActivitySnapshot, room = 'term room'): string {
  return renderToStaticMarkup(wrap(
    <AppShell activity={snapshot}>
      <div data-testid="non-observatory-room">{room}</div>
    </AppShell>,
  ));
}

function activitySurface(html: string): string | null {
  const match = html.match(/<(?:a|span)[^>]*data-elanous-component="topbar-activity"[^>]*>[\s\S]*?<\/(?:a|span)>/);
  return match?.[0] ?? null;
}

function findLinkByName(html: string, name: string): { href: string } | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = html.match(new RegExp(`<a([^>]*aria-label="${escaped}"[^>]*)>`, 'i'));
  if (!named) return null;
  const href = named[1]?.match(/href="([^"]*)"/)?.[1];
  return href ? { href } : null;
}

describe('shell activity snapshot model', () => {
  test('quiet when no live runs exist — empty is not an error', () => {
    expect(buildActivitySnapshot({ status: 'ready', subjects: [] })).toEqual({ kind: 'quiet' });
    expect(buildActivitySnapshot({
      status: 'ready',
      subjects: [subject({ screen: { ptyIds: ['pty-old'], liveCount: 0 } })],
    })).toEqual({ kind: 'quiet' });
  });

  test('error is distinct from quiet', () => {
    expect(buildActivitySnapshot({ status: 'error', message: 'GET /v1/terminals failed (503)' })).toEqual({
      kind: 'error',
      message: 'GET /v1/terminals failed (503)',
    });
    expect(buildActivitySnapshot({ status: 'loading' })).toEqual({ kind: 'loading' });
  });

  test('selects a live run and surfaces origin + progress line', () => {
    const live = subject({
      id: 'subject:self_82122f50',
      runId: 'self_82122f50',
      origin: 'system',
      screen: { ptyIds: ['pty-live'], liveCount: 1 },
    });
    const snapshot = buildActivitySnapshot({
      status: 'ready',
      subjects: [live],
      logs: [progressLog('pty-live', 'self_82122f50', '● orchestrator.ts에서 중단 산출 보존 훅')],
    });
    expect(snapshot).toEqual(ACTIVE);
    const label = activityAriaLabel(snapshot as Extract<ShellActivitySnapshot, { kind: 'active' }>);
    expect(label).toContain('LIVE self_82122f50');
    expect(label).toContain('origin: system');
    expect(label).toContain('● orchestrator.ts에서 중단 산출 보존 훅');
  });

  test('multiple live runs prefer running progress, then report extras', () => {
    const running = subject({
      id: 'subject:b',
      runId: 'run-b',
      screen: { ptyIds: ['pty-b'], liveCount: 1 },
    });
    const complete = subject({
      id: 'subject:a',
      runId: 'run-a',
      screen: { ptyIds: ['pty-a'], liveCount: 1 },
    });
    const selected = selectLiveActivity(
      [complete, running],
      new Map([
        ['subject:a', { kind: 'progress', ptyId: 'pty-a', line: '● done', status: 'complete', hasMissingFrames: false }],
        ['subject:b', { kind: 'progress', ptyId: 'pty-b', line: '◐ implement', status: 'running', hasMissingFrames: false }],
      ]),
    );
    expect(selected?.run.runId).toBe('run-b');
    expect(selected?.extraLiveCount).toBe(1);
  });

  test('observatory href encodes the subject id', () => {
    expect(observatoryHref('subject:run/1')).toBe('/observatory#subject%3Arun%2F1');
  });
});

describe('fetchActivitySnapshot', () => {
  test('maps empty terminals to quiet', async () => {
    const snapshot = await fetchActivitySnapshot({
      fetchImpl: async () => new Response(JSON.stringify({ subjects: [] }), { status: 200 }),
      listProgressFrames: async () => ({ logs: [] }),
    });
    expect(snapshot).toEqual({ kind: 'quiet' });
  });

  test('maps HTTP failure to error, not quiet', async () => {
    const snapshot = await fetchActivitySnapshot({
      fetchImpl: async () => new Response('no', { status: 503 }),
      listProgressFrames: async () => ({ logs: [] }),
    });
    expect(snapshot.kind).toBe('error');
    if (snapshot.kind === 'error') expect(snapshot.message).toContain('503');
  });

  test('joins progress frames onto a live subject', async () => {
    const live = subject({
      id: 'subject:live',
      runId: 'self_live',
      screen: { ptyIds: ['pty-1'], liveCount: 1 },
    });
    const snapshot = await fetchActivitySnapshot({
      fetchImpl: async () => new Response(JSON.stringify({ subjects: [live] }), { status: 200 }),
      listProgressFrames: async () => ({
        logs: [progressLog('pty-1', 'self_live', '◐ implement')],
      }),
    });
    expect(snapshot.kind).toBe('active');
    if (snapshot.kind === 'active') {
      expect(snapshot.run.runId).toBe('self_live');
      expect(snapshot.run.progressStatus).toBe('running');
      expect(snapshot.run.progressLine).toBe('◐ implement');
    }
  });
});

describe('TopBarActivityIndicator render — quiet/loading/error/active', () => {
  test('quiet and loading render nothing — empty is not a fault', () => {
    expect(renderToStaticMarkup(<TopBarActivityIndicator snapshot={{ kind: 'quiet' }} />)).toBe('');
    expect(renderToStaticMarkup(<TopBarActivityIndicator snapshot={{ kind: 'loading' }} />)).toBe('');
  });

  test('error is an alert and is not the quiet surface', () => {
    const html = renderToStaticMarkup(<TopBarActivityIndicator snapshot={ERROR} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-activity-kind="error"');
    expect(html).toContain('activity error');
    expect(html).toContain(ERROR.message);
    expect(html).not.toContain('data-activity-kind="active"');
    expect(html).not.toContain('href="/observatory');
    expect(html).not.toBe('');
  });

  test('active exposes a named link to the observatory subject', () => {
    const html = renderToStaticMarkup(<TopBarActivityIndicator snapshot={ACTIVE} />);
    const name = activityAriaLabel(ACTIVE);
    const link = findLinkByName(html, name);
    expect(link).not.toBeNull();
    expect(link?.href).toBe('/observatory#subject%3Aself_82122f50');
    expect(html).toContain('data-activity-kind="active"');
    expect(html).toContain('self_82122f50');
    expect(html).toContain(LIVE_RUN.progressLine);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('activity error');
    expect(html).not.toContain('takeover');
  });

  test('state input switches the rendered surface', () => {
    const quiet = renderToStaticMarkup(<TopBarActivityIndicator snapshot={{ kind: 'quiet' }} />);
    const loading = renderToStaticMarkup(<TopBarActivityIndicator snapshot={{ kind: 'loading' }} />);
    const error = renderToStaticMarkup(<TopBarActivityIndicator snapshot={ERROR} />);
    const active = renderToStaticMarkup(<TopBarActivityIndicator snapshot={ACTIVE} />);
    expect(quiet).toBe('');
    expect(loading).toBe('');
    expect(error).toContain('activity error');
    expect(error).not.toContain('data-activity-kind="active"');
    expect(active).toContain('data-activity-kind="active"');
    expect(active).not.toContain('activity error');
  });
});

describe('TopBar h-9 strip + activity insertion', () => {
  test('quiet keeps the one-row strip and hides the activity surface', () => {
    const html = renderTopBar({ kind: 'quiet' });
    expect(html).toContain('flex h-9 shrink-0 items-center');
    expect(html).toContain('aria-label="open menu"');
    expect(html).toContain('aria-label="voice"');
    expect(html).toContain('aria-label="settings"');
    expect(activitySurface(html)).toBeNull();
    expect(html).not.toContain('activity error');
    expect(html).not.toContain('data-activity-kind');
  });

  test('loading is as quiet as empty — no fault chrome', () => {
    const html = renderTopBar({ kind: 'loading' });
    expect(html).toContain('flex h-9 shrink-0 items-center');
    expect(activitySurface(html)).toBeNull();
    expect(html).not.toContain('activity error');
  });

  test('error sits in the same h-9 row and is distinct from quiet', () => {
    const html = renderTopBar(ERROR);
    expect(html).toContain('flex h-9 shrink-0 items-center');
    expect(html).toContain('aria-label="open menu"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('activity error');
    expect(html).toContain('data-activity-kind="error"');
  });

  test('active keeps h-9 and names a link to the live run', () => {
    const html = renderTopBar(ACTIVE);
    expect(html).toContain('flex h-9 shrink-0 items-center');
    expect(html).toContain('aria-label="open menu"');
    const link = findLinkByName(html, activityAriaLabel(ACTIVE));
    expect(link?.href).toBe(LIVE_RUN.href);
    expect(html).toContain('data-activity-kind="active"');
    expect(html).toContain('max-w-[7.5rem]');
  });
});

describe('AppShell wiring on a non-observatory room', () => {
  test('without override, AppShell still mounts TopBar and the room — hook starts quiet/loading', () => {
    const html = renderToStaticMarkup(wrap(
      <AppShell>
        <div data-testid="non-observatory-room">term room</div>
      </AppShell>,
    ));
    expect(html).toContain('data-testid="non-observatory-room"');
    expect(html).toContain('term room');
    expect(html).toContain('flex h-9 shrink-0 items-center');
    expect(html).toContain('aria-label="open menu"');
    expect(html).toContain('aria-label="voice"');
    expect(html).toContain('aria-label="settings"');
    expect(activitySurface(html)).toBeNull();
    expect(html).not.toContain('activity error');
  });

  test('quiet: room content stays, activity surface stays absent', () => {
    const html = renderShell({ kind: 'quiet' });
    expect(html).toContain('data-testid="non-observatory-room"');
    expect(html).toContain('term room');
    expect(html).toContain('flex h-9 shrink-0 items-center');
    expect(html).toContain('aria-label="open menu"');
    expect(activitySurface(html)).toBeNull();
    expect(html).not.toContain('activity error');
  });

  test('loading does not shake the layout or look like a fault', () => {
    const html = renderShell({ kind: 'loading' });
    expect(html).toContain('term room');
    expect(html).toContain('flex h-9 shrink-0 items-center');
    expect(activitySurface(html)).toBeNull();
    expect(html).not.toContain('activity error');
  });

  test('error is visible on /term and is not quiet', () => {
    const html = renderShell(ERROR);
    expect(html).toContain('term room');
    expect(html).toContain('role="alert"');
    expect(html).toContain('activity error');
    expect(html).not.toContain('data-activity-kind="active"');
  });

  test('a live run is announced on /term with destination + accessible name', () => {
    const html = renderShell(ACTIVE);
    expect(html).toContain('term room');
    expect(html).not.toContain('data-testid="fabric-stage-header"');
    const link = findLinkByName(html, activityAriaLabel(ACTIVE));
    expect(link?.href).toBe('/observatory#subject%3Aself_82122f50');
    expect(html).toContain('data-run-id="self_82122f50"');
    expect(html).toContain(LIVE_RUN.progressLine);
    expect(html).not.toContain('takeover');
  });

  test('multiple live runs keep the extra count on the named link', () => {
    const multi: Extract<ShellActivitySnapshot, { kind: 'active' }> = {
      ...ACTIVE,
      extraLiveCount: 1,
    };
    const html = renderShell(multi);
    const link = findLinkByName(html, activityAriaLabel(multi));
    expect(link?.href).toBe(LIVE_RUN.href);
    expect(html).toContain('+1');
    expect(activityAriaLabel(multi)).toContain('+1 more');
  });
});

describe('preservation — fabric breadcrumb and observatory API stay themselves', () => {
  test('FabricStageHeader is still a Mission Fabric breadcrumb, not activity', () => {
    const html = renderToStaticMarkup(<FabricStageHeader active="tasks" />);
    expect(html).toContain('Mission Fabric');
    expect(html).toContain('href="/autopilot"');
    expect(html).toContain('href="/tasks"');
    expect(html).toContain('href="/scheduler"');
    expect(html).not.toContain('data-elanous-component="topbar-activity"');
    expect(html).not.toContain('useShellActivity');
  });

  test('observatory classifySubject is unchanged and still used by the shell model', () => {
    const live = subject({ screen: { ptyIds: ['pty-1'], liveCount: 1 } });
    const inactive = subject({ screen: { ptyIds: ['pty-old'], liveCount: 0 } });
    expect(classifySubject(live)).toBe('live');
    expect(classifySubject(inactive)).toBe('inactive');
    expect(buildActivitySnapshot({ status: 'ready', subjects: [inactive] })).toEqual({ kind: 'quiet' });
  });
});
