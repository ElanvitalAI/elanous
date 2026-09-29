import { describe, expect, test } from 'bun:test';

import type { DaemonLogEntry, DaemonTerminalLineageResponse, DaemonTerminalSummary } from '@/lib/daemon-client';
import { terminalListRequest, terminalsQueryUrl } from '@/components/observatory/subject-list';
import {
  ptyProgressByTerminal,
  ptyTerminalProcessOutputStatusLabel,
  ptyTerminalStartedAtLabel,
  ptyTerminalListRequest,
  ptyTerminalLineageModel,
  ptyTerminalListModel,
  ptyTerminalPanelModel,
  ptyTerminalRows,
  initialTerminalSelection,
  ptyRowKey,
  resolvePtyTerminalId,
  type PtyFrameState,
  type PtyScrollbackState,
} from './pty-terminal-list';

const row = (
  id: string,
  overrides: Partial<DaemonTerminalSummary> = {},
): DaemonTerminalSummary => ({
  id,
  alive: true,
  correlationId: `correlation-${id}`,
  instance: 'test',
  sessionId: `session-${id}`,
  startedAt: 1,
  accessMode: null,
  ...overrides,
});

const frame = (
  id: number,
  ptyId: string,
  seq: number,
  humanLine: string,
  overrides: Partial<Record<'runId' | 'planId' | 'ts', string>> = {},
): DaemonLogEntry => ({
  id,
  ts: overrides.ts ?? new Date(id * 1_000).toISOString(),
  level: 'info',
  surface: 'nexus',
  category: 'self-implement',
  event: 'headless.progress-frame',
  data: {
    ptyId,
    runId: overrides.runId ?? 'run-1',
    planId: overrides.planId ?? 'plan-1',
    seq,
    humanLine,
  },
});

describe('ptyTerminalRows', () => {
  test('keeps the exact ids for PTY rows and excludes PTY-less agent rows', () => {
    const rows = ptyTerminalRows([
      row('pty-alpha', { hasPty: true }),
      row('agent-without-pty-alpha', { hasPty: false }),
      row('pty-beta', { hasPty: true }),
      row('agent-without-pty-beta', { hasPty: false }),
    ]);

    expect(rows.map((terminal) => terminal.id)).toEqual(['pty-alpha', 'pty-beta']);
  });

  test('keeps an id-only PTY row while excluding an explicit PTY-less row', () => {
    const rows = ptyTerminalRows([
      row('pty-id-only'),
      row('agent-without-pty', { hasPty: false }),
      row('legacy-pty', { hasPty: true }),
    ]);

    expect(rows.map((terminal) => terminal.id)).toEqual(['legacy-pty', 'pty-id-only']);
  });

  test('deduplicates by row key before ordering newest starts first', () => {
    const rows = ptyTerminalRows([
      row('pty-b', { hasPty: true, startedAt: 10 }),
      row('agent-only', { hasPty: false, startedAt: 100 }),
      row('pty-a', { startedAt: 20 }),
      row('pty-b', { hasPty: true, sessionId: 'duplicate', startedAt: 30 }),
    ]);

    expect(rows.map(({ id, sessionId }) => ({ id, sessionId }))).toEqual([
      { id: 'pty-a', sessionId: 'session-pty-a' },
      { id: 'pty-b', sessionId: 'session-pty-b' },
    ]);
  });

  test('uses terminal id to order equal starts and puts every invalid or missing start after valid starts', () => {
    const rows = ptyTerminalRows([
      row('z-invalid', { startedAt: Number.NaN }),
      row('a-tie', { startedAt: 20 }),
      row('b-tie', { startedAt: 20 }),
      row('a-missing', { startedAt: undefined }),
      row('b-out-of-range', { startedAt: Number.MAX_VALUE }),
      row('recent', { startedAt: 30 }),
    ]);

    expect(rows.map((terminal) => terminal.id)).toEqual([
      'recent', 'a-tie', 'b-tie', 'a-missing', 'b-out-of-range', 'z-invalid',
    ]);
  });

  test('falls back to row key only when both startedAt and terminal id are equal', () => {
    const inZ = row('same-id', { startedAt: 20, sourceRoot: { name: 'z', dbPath: '/roots/z/manifest.db' } });
    const inA = row('same-id', { startedAt: 20, sourceRoot: { name: 'a', dbPath: '/roots/a/manifest.db' } });

    expect(ptyTerminalRows([inZ, inA])).toEqual([inA, inZ]);
  });
});

describe('resolvePtyTerminalId', () => {
  test('selects the sole matching row and carries its row key and reason', () => {
    const terminal = row('pty-unique', { sourceRoot: { name: 'alpha', dbPath: '/roots/alpha/manifest.db' } });

    expect(resolvePtyTerminalId('pty-unique', [terminal])).toEqual({
      kind: 'selected',
      terminal,
      terminalKey: ptyRowKey(terminal),
      candidates: [terminal],
      reason: 'unique-id',
    });
  });

  test('selects a unique rootless row', () => {
    const terminal = row('pty-rootless');

    expect(resolvePtyTerminalId('pty-rootless', [terminal])).toEqual({
      kind: 'selected',
      terminal,
      terminalKey: ptyRowKey(terminal),
      candidates: [terminal],
      reason: 'unique-id',
    });
  });

  test('does not select a missing id from a non-empty list', () => {
    expect(resolvePtyTerminalId('pty-missing', [row('pty-present')])).toEqual({
      kind: 'not-found',
      terminal: null,
      terminalKey: null,
      candidates: [],
      reason: 'terminal-id-not-found',
    });
  });

  test('distinguishes an empty list from a non-empty list with no matching id', () => {
    expect(resolvePtyTerminalId('pty-missing', [])).toEqual({
      kind: 'not-found',
      terminal: null,
      terminalKey: null,
      candidates: [],
      reason: 'empty-terminal-list',
    });
  });

  test('returns every same-id row from different roots without selecting either one', () => {
    const inA = row('tui:1', { sourceRoot: { name: 'a', dbPath: '/roots/a/manifest.db' } });
    const inB = row('tui:1', { sourceRoot: { name: 'b', dbPath: '/roots/b/manifest.db' } });

    expect(resolvePtyTerminalId('tui:1', [inA, inB])).toEqual({
      kind: 'ambiguous',
      terminal: null,
      terminalKey: null,
      candidates: [inA, inB],
      reason: 'duplicate-id',
    });
  });

  test('remains ambiguous when same-id root candidates arrive in reverse order', () => {
    const inA = row('tui:1', { sourceRoot: { name: 'a', dbPath: '/roots/a/manifest.db' } });
    const inB = row('tui:1', { sourceRoot: { name: 'b', dbPath: '/roots/b/manifest.db' } });

    const forward = resolvePtyTerminalId('tui:1', [inA, inB]);
    const reverse = resolvePtyTerminalId('tui:1', [inB, inA]);

    expect(forward.kind).toBe('ambiguous');
    expect(reverse.kind).toBe('ambiguous');
    expect(forward.candidates).toEqual([inA, inB]);
    expect(reverse.candidates).toEqual([inB, inA]);
  });

  test('does not select either same-id rootless row', () => {
    const first = row('tui:rootless', { sessionId: 'session-first' });
    const second = row('tui:rootless', { sessionId: 'session-second' });

    expect(resolvePtyTerminalId('tui:rootless', [first, second])).toEqual({
      kind: 'ambiguous',
      terminal: null,
      terminalKey: null,
      candidates: [first, second],
      reason: 'duplicate-id',
    });
  });
});

// ⛔ 선택·캐시 키는 «행 키»(root ⊕ id)다 — id 가 아니다. 이 파일의 fixture 행들은
//    sourceRoot 가 없으므로 rootless 키를 쓴다. 왜 id 로는 안 되는지는 ptyRowKey 참조.
const BETA = ptyRowKey({ id: 'pty-beta' });

describe('ptyTerminalListModel', () => {
  const rows = [row('pty-alpha'), row('pty-beta'), row('pty-gamma')];

  test('shares the complete all/includeTest request contract with the Observatory URL', () => {
    for (const includeAll of [false, true]) {
      const request = terminalListRequest(includeAll);
      expect(ptyTerminalListRequest(includeAll)).toEqual(request);
      const query = new URL(`http://localhost${terminalsQueryUrl(includeAll)}`).searchParams;
      expect(Object.fromEntries(query.entries())).toEqual(
        Object.fromEntries(Object.entries(request).map(([key, value]) => [key, String(value)])),
      );
    }
  });

  test('keeps absent, zero, and positive hidden-terminal wording while always reporting zero terminated live owners', () => {
    const absent = ptyTerminalPanelModel(false, rows, undefined, null, new Map());
    const zero = ptyTerminalPanelModel(true, rows, { hiddenDead: 0, futureScopeField: 'safe' }, null, new Map());
    const hidden = ptyTerminalPanelModel(true, rows, { hiddenDead: 279 }, null, new Map());

    expect(absent.scopeSummary).toBe('소유 런이 끝났는데 터미널이 남아 있는 행이 0개입니다.');
    expect(zero.scopeSummary).toBe('숨긴 종료 PTY가 0개입니다. 소유 런이 끝났는데 터미널이 남아 있는 행이 0개입니다.');
    expect(hidden.scopeSummary).toBe('숨긴 종료 PTY가 279개입니다. 소유 런이 끝났는데 터미널이 남아 있는 행이 0개입니다.');
    expect(hidden.scopeSummary).toContain('숨긴 종료 PTY가 279개입니다.');
    expect(hidden.rows.map((item) => item.terminal.id)).toEqual(['pty-alpha', 'pty-beta', 'pty-gamma']);
  });

  test('counts only visible terminated live owners and excludes other or missing owner usage', () => {
    const visible = ptyTerminalRows([
      row('terminated-a', { ownerRunUsage: 'terminated-live-owner' }),
      row('terminated-b', { ownerRunUsage: 'terminated-live-owner' }),
      row('running', { ownerRunUsage: 'running' }),
      row('unknown', { ownerRunUsage: 'unknown' }),
      row('no-run-id', { ownerRunUsage: 'no-run-id' }),
      row('missing'),
      row('hidden-terminated', { hasPty: false, ownerRunUsage: 'terminated-live-owner' }),
    ]);
    const model = ptyTerminalPanelModel(true, visible, { hiddenDead: 4 }, null, new Map());

    expect(model.rows.map((item) => item.terminal.id)).toEqual([
      'missing', 'no-run-id', 'running', 'terminated-a', 'terminated-b', 'unknown',
    ]);
    expect(model.scopeSummary).toBe('숨긴 종료 PTY가 4개입니다. 소유 런이 끝났는데 터미널이 남아 있는 행이 2개입니다.');
  });

  test('selects only the requested existing row and attaches its screen text there', () => {
    const model = ptyTerminalListModel(rows, BETA, new Map([
      [BETA, { status: 'ready', scrollback: 'beta screen\nnext line' } satisfies PtyScrollbackState],
    ]));

    expect(model.map((item) => item.selected)).toEqual([false, true, false]);
    expect(model.map((item) => item.scrollback?.text ?? null)).toEqual([null, 'beta screen\nnext line', null]);
  });

  test('two rows sharing an id in different roots are different rows, and a rootless row keeps its own key', () => {
    // The federated list shows several manifest roots at once and a PTY id is only
    // unique within one. `selectPtyTerminal` used to answer "which row" with an id
    // alone; that cannot tell these two apart, so it was retired for this key.
    const inA = { id: 'tui:1', sourceRoot: { name: 'a', dbPath: '/roots/a/pty/manifest.db' } };
    const inB = { id: 'tui:1', sourceRoot: { name: 'b', dbPath: '/roots/b/pty/manifest.db' } };
    expect(ptyRowKey(inA)).not.toBe(ptyRowKey(inB));
    expect(ptyRowKey(inA)).toBe(ptyRowKey({ ...inA }));
    expect(ptyRowKey({ id: 'tui:1' })).not.toBe(ptyRowKey(inA));
  });

  test('uses distinct text for unrequested, loading, failed, and empty scrollback', () => {
    const messageFor = (state: PtyScrollbackState): string => ptyTerminalListModel(
      rows,
      BETA,
      new Map([[BETA, state]]),
    )[1]!.scrollback!.text;
    const unrequested = messageFor({ status: 'unrequested' });
    const loading = messageFor({ status: 'loading' });
    const failed = messageFor({ status: 'error' });
    const empty = messageFor({ status: 'ready', scrollback: '' });

    expect(new Set([unrequested, loading, failed, empty]).size).toBe(4);
  });

  test('defaults to raw and switches to a separately fetched rendered frame', () => {
    const raw = new Map([
      [BETA, { status: 'ready', scrollback: '\u001b[31mraw terminal text' } satisfies PtyScrollbackState],
    ]);
    const frames = new Map([
      [BETA, {
        status: 'ready', frame: '[80x24 cursor=(3,4)]\n┌─ rendered screen ─┐', frameAt: 123, frameSource: 'anything',
      } satisfies PtyFrameState],
    ]);

    const rawModel = ptyTerminalListModel(rows, BETA, raw)[1]!.scrollback!;
    const renderModel = ptyTerminalListModel(rows, BETA, raw, 'render', frames)[1]!.scrollback!;

    expect(rawModel.text).toBe('\u001b[31mraw terminal text');
    expect(renderModel.text).toBe('┌─ rendered screen ─┐');
    expect(renderModel.frameInfo).toBe('[80x24 cursor=(3,4)]');
    expect(renderModel.frameMetadata).toEqual({ frameAt: 123, frameSource: 'anything' });
    expect(renderModel.text).not.toContain(renderModel.frameInfo!);
  });

  test('puts visible raw/render switch labels and exactly one selected mode in the pure selected-row model', () => {
    const rawModel = ptyTerminalListModel(rows, BETA, new Map([
      [BETA, { status: 'ready', scrollback: 'raw text' } satisfies PtyScrollbackState],
    ]))[1]!;
    const renderModel = ptyTerminalListModel(rows, BETA, new Map(), 'render', new Map([
      [BETA, {
        status: 'ready', frame: '[80x24 cursor=(3,4)]\nrendered text', frameAt: 456, frameSource: 'future-source',
      } satisfies PtyFrameState],
    ]))[1]!;

    expect(rawModel.view).toMatchObject({
      visible: true,
      modes: [
        { mode: 'raw', label: '원시 글자', selected: true },
        { mode: 'render', label: '렌더 화면', selected: false },
      ],
      display: { text: 'raw text' },
    });
    expect(renderModel.view).toMatchObject({
      visible: true,
      modes: [
        { mode: 'raw', label: '원시 글자', selected: false },
        { mode: 'render', label: '렌더 화면', selected: true },
      ],
      display: { text: 'rendered text', frameMetadata: { frameAt: 456, frameSource: 'future-source' } },
    });
  });

  test('uses distinct unrequested, loading, failed, and empty messages for rendered frames', () => {
    const messageFor = (state: PtyFrameState): string => ptyTerminalListModel(
      rows,
      BETA,
      new Map(),
      'render',
      new Map([[BETA, state]]),
    )[1]!.scrollback!.text;

    expect(new Set([
      messageFor({ status: 'unrequested' }),
      messageFor({ status: 'loading' }),
      messageFor({ status: 'error' }),
      messageFor({ status: 'ready', frame: '', frameAt: 0, frameSource: 'unknown' }),
    ]).size).toBe(4);
  });

  test('keeps a ready raw snapshot available when the rendered frame fails', () => {
    const raw = new Map([
      [BETA, { status: 'ready', scrollback: 'raw still available' } satisfies PtyScrollbackState],
    ]);
    const frames = new Map([
      [BETA, { status: 'error' } satisfies PtyFrameState],
    ]);

    expect(ptyTerminalListModel(rows, BETA, raw, 'render', frames)[1]!.scrollback).toMatchObject({
      kind: 'error', text: '렌더 화면을 불러오지 못했습니다.',
    });
    expect(ptyTerminalListModel(rows, BETA, raw, 'raw', frames)[1]!.scrollback).toMatchObject({
      kind: 'content', text: 'raw still available', frameInfo: null,
    });
  });

  test('attaches no selection or scrollback when the selected id is absent', () => {
    const model = ptyTerminalListModel(rows, ptyRowKey({ id: 'not-in-the-list' }), new Map([
      ['not-in-the-list', { status: 'ready', scrollback: 'must stay hidden' } satisfies PtyScrollbackState],
    ]));

    expect(model.every((item) => !item.selected && item.scrollback === null)).toBe(true);
  });

  test('leaves every row visually unchanged when no row is selected', () => {
    const model = ptyTerminalListModel(rows, null, new Map());

    expect(model.map((item) => ({ id: item.terminal.id, selected: item.selected, scrollback: item.scrollback, view: item.view }))).toEqual([
      { id: 'pty-alpha', selected: false, scrollback: null, view: null },
      { id: 'pty-beta', selected: false, scrollback: null, view: null },
      { id: 'pty-gamma', selected: false, scrollback: null, view: null },
    ]);
  });
});

describe('ptyTerminalLineagePresentation', () => {
  test('formats a known epoch-millisecond value with the PWA locale convention instead of exposing it', () => {
    const startedAt = 1786645434799;
    const label = ptyTerminalStartedAtLabel(startedAt);

    expect(label).toBe(new Date(startedAt).toLocaleString());
    expect(label).not.toContain(String(startedAt));
  });

  test('uses a safe label for absent and invalid start times', () => {
    expect(ptyTerminalStartedAtLabel(undefined)).toBe('시작 시각 알 수 없음');
    expect(ptyTerminalStartedAtLabel(Number.NaN)).toBe('시작 시각 알 수 없음');
  });

  test('labels every process and output-stream state with its own literal text', () => {
    expect(ptyTerminalProcessOutputStatusLabel(true, false)).toBe('프로세스 실행 중 · 출력 스트림 열림');
    expect(ptyTerminalProcessOutputStatusLabel(true, true)).toBe('프로세스 실행 중 · 출력 스트림 닫힘');
    expect(ptyTerminalProcessOutputStatusLabel(false, false)).toBe('프로세스 종료 · 출력 스트림 열림');
    expect(ptyTerminalProcessOutputStatusLabel(false, true)).toBe('프로세스 종료 · 출력 스트림 닫힘');
  });

  test('wires the lineage row to the presentation helpers instead of raw epoch and split states', async () => {
    const terminalPanelSource = await Bun.file(new URL('./TerminalPanel.tsx', import.meta.url)).text();

    expect(terminalPanelSource).toContain('ptyTerminalProcessOutputStatusLabel(lineageRow.alive, lineageRow.closed)');
    expect(terminalPanelSource).toContain('ptyTerminalStartedAtLabel(lineageRow.startedAt)');
    expect(terminalPanelSource).not.toContain("lineageRow.alive ? '실행 중' : '종료'");
    expect(terminalPanelSource).not.toContain("lineageRow.closed ? '닫힘' : '열림'");
    expect(terminalPanelSource).not.toContain('시작 {lineageRow.startedAt}');
  });
});

describe('ptyTerminalLineageModel', () => {
  const lineage = (unreadablePayloads?: number): DaemonTerminalLineageResponse => ({
    key: 'pty-beta',
    ...(unreadablePayloads === undefined ? {} : { unreadablePayloads }),
    groups: [{
      joinedBy: 'run',
      key: 'run-42',
      rows: [
        { ptyId: 'pty-alpha', kind: 'terminal', instance: 'test', alive: true, startedAt: 1 },
        { ptyId: 'pty-beta', kind: 'terminal', instance: 'test', alive: true, startedAt: 2 },
        { ptyId: 'pty-gamma', kind: 'terminal', instance: 'test', alive: false, startedAt: 3, closed: true },
      ],
    }],
  });

  test('shows every screen in a group and marks only the selected screen', () => {
    const model = ptyTerminalLineageModel('pty-beta', { status: 'ready', lineage: lineage(2) })!;

    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]!.rows.map((item) => item.ptyId)).toEqual(['pty-alpha', 'pty-beta', 'pty-gamma']);
    expect(model.groups[0]!.rows.map((item) => item.selected)).toEqual([false, true, false]);
    expect(model.groups[0]!.rows[2]!.closed).toBe(true);
  });

  test('keeps unreadable payload counts absent, zero, and positive distinct', () => {
    const absent = ptyTerminalLineageModel('pty-beta', { status: 'ready', lineage: lineage() })!;
    const zero = ptyTerminalLineageModel('pty-beta', { status: 'ready', lineage: lineage(0) })!;
    const positive = ptyTerminalLineageModel('pty-beta', { status: 'ready', lineage: lineage(2) })!;

    // ⛔ 2026-08-14 무인 리뷰 must-fix — 종전엔 `Set(...).size === 3` 만 봤다.
    //   그러면 «값 없음 / 0 / N» 의 뜻이 서로 «뒤바뀌어도», N 이 문면에서 빠져도 통과한다
    //   (셋이 다르기만 하면 되므로). 그건 내가 골에 「셋이 서로 다르다」만 요구한 탓이다.
    //   ⇒ 각 입력이 «어느» 문면을 내는지 리터럴로 못 박고, N 이 실제로 들어가는지 본다.
    expect(absent.unreadablePayloadsSummary).toBe('읽지 못한 계보 payload 수를 데몬이 알리지 않았습니다.');
    expect(zero.unreadablePayloadsSummary).toBe('읽지 못한 계보 payload가 0개입니다.');
    expect(positive.unreadablePayloadsSummary).toBe('읽지 못한 계보 payload가 2개입니다.');
    expect(positive.unreadablePayloadsSummary).toContain('2');
  });

  test('preserves an unknown joinedBy value and isolates empty, failed, and no-selection states', () => {
    const unknown = ptyTerminalLineageModel('pty-beta', {
      status: 'ready',
      lineage: { key: 'pty-beta', groups: [{ joinedBy: 'future-link', key: 'future-1', rows: [] }] },
    })!;

    expect(unknown.groups[0]).toMatchObject({ joinedBy: 'future-link', key: 'future-1' });
    expect(ptyTerminalLineageModel('pty-beta', { status: 'ready', lineage: { key: 'pty-beta', groups: [] } })?.kind).toBe('empty');
    expect(ptyTerminalLineageModel('pty-beta', { status: 'error' })?.kind).toBe('error');
    expect(ptyTerminalLineageModel(null, { status: 'ready', lineage: lineage(0) })).toBeNull();
  });
});

describe('ptyProgressByTerminal', () => {
  test('folds repeated text to the latest completed frame', () => {
    const progress = ptyProgressByTerminal([
      frame(4, 'self-alpha', 4, '● implement'),
      frame(3, 'self-alpha', 3, '● implement'),
      frame(2, 'self-alpha', 2, '● implement'),
      frame(1, 'self-alpha', 1, '◐ implement'),
    ]);

    expect(progress.get('self-alpha')).toEqual({
      line: '● implement',
      status: 'complete',
      hasMissingFrames: false,
    });
    expect(progress.size).toBe(1);
  });

  test('reports a gap only when a plan sequence is not continuous from one', () => {
    expect(ptyProgressByTerminal([
      frame(1, 'self-alpha', 1, 'one'),
      frame(2, 'self-alpha', 2, 'two'),
      frame(4, 'self-alpha', 4, 'four'),
    ]).get('self-alpha')?.hasMissingFrames).toBe(true);

    expect(ptyProgressByTerminal([
      frame(1, 'self-alpha', 1, 'one'),
      frame(2, 'self-alpha', 2, 'two'),
      frame(3, 'self-alpha', 3, 'three'),
    ]).get('self-alpha')?.hasMissingFrames).toBe(false);
  });

  test('isolates frames from distinct PTYs and ignores malformed logs', () => {
    const progress = ptyProgressByTerminal([
      frame(1, 'self-alpha', 1, 'alpha'),
      { ...frame(2, 'self-beta', 1, 'beta'), data: { ptyId: 'self-beta', seq: 1 } },
      frame(3, 'self-beta', 1, 'beta'),
    ]);

    expect(progress.get('self-alpha')?.line).toBe('alpha');
    expect(progress.get('self-beta')?.line).toBe('beta');
    expect(progress.size).toBe(2);
  });

  test('ignores non-safe or non-positive sequence values without allocating by their magnitude', () => {
    const progress = ptyProgressByTerminal([
      frame(1, 'self-alpha', 1, 'valid'),
      frame(2, 'self-alpha', Number.MAX_SAFE_INTEGER + 1, 'unsafe'),
      frame(3, 'self-beta', -1, 'negative'),
      frame(4, 'self-gamma', 1.5, 'fractional'),
    ]);

    expect(progress.get('self-alpha')).toEqual({
      line: 'valid',
      status: 'running',
      hasMissingFrames: false,
    });
    expect(progress.has('self-beta')).toBe(false);
    expect(progress.has('self-gamma')).toBe(false);
  });

  test('uses the newest plan when prior and current plan sequences are independently continuous', () => {
    const progress = ptyProgressByTerminal([
      frame(1, 'self-alpha', 1, 'older one', { planId: 'plan-old' }),
      frame(2, 'self-alpha', 2, 'older two', { planId: 'plan-old' }),
      frame(3, 'self-alpha', 1, 'newest', { planId: 'plan-new' }),
    ]);

    expect(progress.get('self-alpha')).toEqual({
      line: 'newest',
      status: 'running',
      hasMissingFrames: false,
    });
  });

  test('reports a missing frame from any run and plan group without treating a plan restart as a gap', () => {
    const previousPlanGap = ptyProgressByTerminal([
      frame(1, 'self-alpha', 1, 'older one', { runId: 'run-old', planId: 'plan-old' }),
      frame(2, 'self-alpha', 3, 'older three', { runId: 'run-old', planId: 'plan-old' }),
      frame(3, 'self-alpha', 1, 'newest', { runId: 'run-new', planId: 'plan-new' }),
    ]);
    const newestPlanGap = ptyProgressByTerminal([
      frame(1, 'self-alpha', 1, 'older', { runId: 'run-old', planId: 'plan-old' }),
      frame(2, 'self-alpha', 1, 'newest one', { runId: 'run-new', planId: 'plan-new' }),
      frame(3, 'self-alpha', 3, 'newest three', { runId: 'run-new', planId: 'plan-new' }),
    ]);

    expect(previousPlanGap.get('self-alpha')?.hasMissingFrames).toBe(true);
    expect(newestPlanGap.get('self-alpha')?.hasMissingFrames).toBe(true);
  });

  test('returns no activity for empty logs', () => {
    expect(ptyProgressByTerminal([]).size).toBe(0);
  });
});

// ⛔ 2026-08-14 실측 회귀 — 위 픽스처는 원래 `✓` 였다. 실물 `headless.progress-frame` 은
//   `◐`(진행 중)와 `●`(완료)만 쓴다(표본 9: ◐ 2 · ● 7 · 그 밖 0).
//   구현의 «추측»과 픽스처의 «추측»이 서로 맞아 통과했고, 실물에서는 complete 가 «영영» 안 났다.
//   아래가 그 실물 두 문자를 못 박는다.
describe('ptyProgressByTerminal — the markers the daemon actually emits', () => {
  test('treats ● as complete and ◐ as running, and rejects the invented ✓', () => {
    const done = ptyProgressByTerminal([frame(1, 'self-real', 1, '● 실제 완료 줄')]);
    expect(done.get('self-real')?.status).toBe('complete');

    const busy = ptyProgressByTerminal([frame(1, 'self-busy', 1, '◐ 실제 진행 줄')]);
    expect(busy.get('self-busy')?.status).toBe('running');

    // ✓ 는 이 스트림이 «안 쓰는» 문자다 — 완료로 읽으면 그건 다시 추측이다.
    const invented = ptyProgressByTerminal([frame(1, 'self-fake', 1, '✓ 없는 표식')]);
    expect(invented.get('self-fake')?.status).toBe('running');
  });
});

// 대표 2026-08-17 — "preview-1 같은 아이디가 이제는 의미 없지 않나요?"
describe('initialTerminalSelection — 첫 화면은 실재 PTY 를 먼저 본다', () => {
  const rows = [
    { id: 'agent:dead1', alive: false },
    { id: 'term-dead', alive: false, cmd: 'web-terminal' },
    { id: 'self_5837456a', alive: true, cmd: 'bash' },
    { id: 'term-mukshd4l', alive: true, cmd: 'web-terminal' },
  ];

  test('사람이 마지막에 고른 것을 «도구가 뒤엎지 않는다»', () => {
    expect(initialTerminalSelection({ storedId: 'preview-1', fallbackId: 'preview-1', terminals: rows }))
      .toEqual({ terminalId: 'preview-1', reason: 'stored' });
  });

  test('저장된 선택이 없으면 «살아 있는» 실재 PTY 를 고르고 이유를 말한다', () => {
    expect(initialTerminalSelection({ storedId: null, fallbackId: 'preview-1', terminals: rows }))
      .toEqual({ terminalId: 'term-mukshd4l', reason: 'live-pty' });
  });

  // 대표 2026-09-28 — 에이전트 PTY 를 터미널 탭으로 고르면 같은 id 의 «그림자 셸»이 생긴다.
  test('살아 있는 에이전트 PTY 만 있으면 고르지 않는다 — 터미널 탭은 웹 셸에만 붙는다', () => {
    expect(initialTerminalSelection({
      storedId: null,
      fallbackId: 'preview-1',
      terminals: [{ id: 'codex_801fe2e2', alive: true, cmd: 'bash' }, { id: 'pty_2696c00d', alive: true }],
    })).toEqual({ terminalId: 'preview-1', reason: 'fallback' });
  });

  test('죽은 것만 있으면 폴백으로 떨어진다 — 죽은 PTY 를 고르지 않는다', () => {
    expect(initialTerminalSelection({
      storedId: '  ', fallbackId: 'preview-1', terminals: [{ id: 'agent:dead1', alive: false }],
    })).toEqual({ terminalId: 'preview-1', reason: 'fallback' });
  });

  test('목록이 비면 폴백', () => {
    expect(initialTerminalSelection({ storedId: null, fallbackId: 'preview-1', terminals: [] }))
      .toEqual({ terminalId: 'preview-1', reason: 'fallback' });
  });

  test('폴백이 없고 고를 실재 PTY도 없으면 선택 없음을 이유와 함께 돌려준다', () => {
    const picked = initialTerminalSelection({
      storedId: '  ',
      terminals: [{ id: 'agent:dead1', alive: false }],
    });

    expect(picked).toEqual({ terminalId: null, reason: 'no-terminals' });
    if (picked.terminalId !== null) throw new Error('expected no terminal selection');
    expect(picked.reason).toBe('no-terminals');
  });

  test('null 폴백도 선택 없음을 표현한다', () => {
    expect(initialTerminalSelection({ storedId: null, fallbackId: null, terminals: [] }))
      .toEqual({ terminalId: null, reason: 'no-terminals' });
  });

  test('실재 목록의 고정 이름은 폴백 없이도 선택한다', () => {
    expect(initialTerminalSelection({
      storedId: null,
      terminals: [{ id: 'preview-1', alive: true, cmd: 'web-terminal' }],
    })).toEqual({ terminalId: 'preview-1', reason: 'live-pty' });
  });

  test.each(['preview-1', '', '   ', ' preview-1 '])(
    '기존 명시 폴백 호출은 %p를 변형하지 않고 직접 사용할 수 있다',
    (fallbackId) => {
      const picked: { terminalId: string; reason: 'stored' | 'live-pty' | 'fallback' } = initialTerminalSelection({
        storedId: null,
        fallbackId,
        terminals: [],
      });

      expect(picked).toEqual({ terminalId: fallbackId, reason: 'fallback' });
    },
  );
});

describe('ptyTerminalRows provenance compatibility', () => {
  test('preserves daemon provenance and controller metadata while retaining distinct row-key dedupe', () => {
    const rows = ptyTerminalRows([
      { id: 'human', alive: true, correlationId: 'h', instance: 'test', sessionId: 's', startedAt: 2, accessMode: null, terminalOriginCategory: 'direct-human', controller: 'operator' },
      { id: 'external', alive: true, correlationId: 'e', instance: 'test', sessionId: 's', startedAt: 1, accessMode: null, terminalOriginCategory: 'external-tool', externalToolName: 'codex' },
    ]);

    expect(rows.map((row) => row.terminalOriginCategory)).toEqual(['direct-human', 'external-tool']);
    expect(rows[0]?.controller).toBe('operator');
    expect(rows[1]?.externalToolName).toBe('codex');
  });
});
