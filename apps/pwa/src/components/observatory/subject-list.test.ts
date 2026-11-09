import { expect, mock, test } from 'bun:test';
import {
  canonicalPtyItems,
  classifySubject,
  requestTerminalTakeover,
  subjectProgressBySubject,
  subjectSurfaces,
  terminalControlUrl,
  terminalFrameUrl,
  terminalListRequest,
  terminalsQueryUrl,
  TERMINAL_TAKEOVER_MESSAGES,
  visibleSubjects,
  type ObservatorySubject,
  type TerminalTakeoverFailureKind,
} from './subject-list';

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

test('classifies live, unknown and inactive subjects while keeping talk, screen and agent axes distinct', () => {
  const live = subject({ screen: { ptyIds: ['pty-1'], liveCount: 1 } });
  const unknown = subject({ agent: { names: ['codex'], controllers: [] } });
  const inactive = subject({ screen: { ptyIds: ['pty-old'], liveCount: 0 } });
  expect([classifySubject(live), classifySubject(unknown), classifySubject(inactive)]).toEqual(['live', 'unknown', 'inactive']);
  expect(visibleSubjects([live, unknown, inactive])).toEqual([live, unknown]);
  expect(visibleSubjects([live, unknown, inactive], true)).toEqual([live, unknown, inactive]);
  expect(subjectSurfaces(subject({ talk: [{}], screen: { ptyIds: ['pty-2'], liveCount: 0 }, agent: { names: [], controllers: ['ctrl'] } })))
    .toEqual({ talk: true, screen: true, agent: true });
});

test('joins screen progress deterministically and distinguishes no screen from no progress', () => {
  const multi = subject({ id: 'multi', screen: { ptyIds: ['pty-b', 'pty-a', 'pty-a'], liveCount: 2 } });
  const none = subject({ id: 'none', screen: { ptyIds: [], liveCount: 0 } });
  const summaries = new Map([
    ['pty-a', { line: '● first', status: 'complete' as const, hasMissingFrames: true }],
    ['pty-b', { line: '◐ second', status: 'running' as const, hasMissingFrames: false }],
  ]);
  expect(subjectProgressBySubject([multi, none], summaries)).toEqual(new Map([
    ['multi', { kind: 'progress', ptyId: 'pty-a', line: '● first', status: 'complete', hasMissingFrames: true }],
    ['none', { kind: 'no-screen' }],
  ]));
  expect(subjectProgressBySubject([subject({ id: 'empty', screen: { ptyIds: ['pty-c'], liveCount: 1 } })], new Map()).get('empty'))
    .toEqual({ kind: 'no-progress' });
});

test('keeps the shared terminal API URLs stable and deduplicates only explicit non-PTY rows', () => {
  const rows = [
    { id: 'pty-a', hasPty: true },
    { id: 'agent-only', hasPty: false },
    { id: 'pty-b' },
    { id: 'pty-a', hasPty: true },
  ];
  expect(canonicalPtyItems(rows).map(({ id }) => id)).toEqual(['pty-a', 'pty-b']);
  expect(terminalFrameUrl('pty/a b')).toBe('/v1/terminals/pty%2Fa%20b/frame');
  expect(terminalControlUrl('pty/a b')).toBe('/v1/terminals/pty%2Fa%20b/control');
  expect(terminalsQueryUrl()).toBe('/v1/terminals');
  expect(terminalsQueryUrl(true)).toBe('/v1/terminals?all=true&includeTest=true');
});


test('preserves the shared terminal-list request contract for both consumers', () => {
  expect(terminalListRequest(false)).toEqual({});
  expect(terminalListRequest(true)).toEqual({ all: true, includeTest: true });
  expect(terminalsQueryUrl(false)).toBe('/v1/terminals');
  expect(terminalsQueryUrl(true)).toBe('/v1/terminals?all=true&includeTest=true');
});

test('keeps takeover boundary behavior for success, HTTP failures, and network failures', async () => {
  const fetchImpl = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('/v1/terminals/pty%2Fa%20b/control');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init?.body).toBe(JSON.stringify({ action: 'takeover' }));
    return new Response(JSON.stringify({ id: 'pty/a b', action: 'takeover', status: 'success' }), { status: 200 });
  });
  await expect(requestTerminalTakeover('pty/a b', fetchImpl)).resolves.toEqual({ ok: true, ptyId: 'pty/a b' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);

  const cases: ReadonlyArray<{ status: number; kind: TerminalTakeoverFailureKind; message: string }> = [
    { status: 404, kind: 'unknown', message: TERMINAL_TAKEOVER_MESSAGES.unknown },
    { status: 409, kind: 'denied', message: TERMINAL_TAKEOVER_MESSAGES.denied },
    { status: 504, kind: 'owner-unreachable', message: TERMINAL_TAKEOVER_MESSAGES['owner-unreachable'] },
    { status: 502, kind: 'failed', message: TERMINAL_TAKEOVER_MESSAGES.failed },
  ];
  for (const { status, kind, message } of cases) {
    await expect(requestTerminalTakeover('pty-x', async () => new Response('no', { status })))
      .resolves.toEqual({ ok: false, ptyId: 'pty-x', kind, status, message });
  }
  await expect(requestTerminalTakeover('pty-x', async () => { throw new Error('offline'); }))
    .resolves.toEqual({ ok: false, ptyId: 'pty-x', kind: 'network', message: TERMINAL_TAKEOVER_MESSAGES.network });
});
