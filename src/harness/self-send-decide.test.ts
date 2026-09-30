import { describe, expect, test } from 'bun:test';
import { decideSelfSend, formatSelfSendCandidateDisplay, type SelfSendCandidate, type SelfSendDecisionDeps, type SelfSendDecisionInput, type SelfSendLedger, type SelfSendRunScreen } from './self-send-decide.js';

describe('self send superseded explicit target protection — decision', () => {
  const now = 1_700_000_000_000;
  const older = 'self-impl-shared-goal-aaaaaaaa';
  const newer = 'self-impl-shared-goal-bbbbbbbb';
  const screen = (spaceId: string, liveness: SelfSendCandidate['liveness'] = 'alive', mtimeMs = now): SelfSendCandidate => ({ spaceId, liveness, mtimeMs });
  const runId = 'run-893d29dd-0000-4000-8000-000000000001';
  function decide(input: Partial<SelfSendDecisionInput> = {}, options: {
    screens?: SelfSendCandidate[];
    runScreens?: Record<string, Partial<SelfSendRunScreen>>;
    ledgers?: SelfSendLedger[];
    target?: ReturnType<SelfSendDecisionDeps['resolveTarget']>;
    pod?: boolean;
    podFragments?: { spaceId: string }[];
    throwLedger?: boolean;
  } = {}) {
    const screens = options.screens ?? [screen(older)];
    const runScreens = options.runScreens ?? { [runId]: { screenKey: screens[0]?.spaceId } };
    const deps: SelfSendDecisionDeps = {
      resolveRunScreen: (id) => ({ logStoreStatus: 'read', logStorePath: '/test/logs.db', ...runScreens[id] }),
      podFragmentsForRun: () => options.podFragments ?? [],
      resolveTarget: (spaceId) => options.target ?? { kind: 'space', spaceId },
      isPodFragment: () => options.pod ?? false,
      screens: () => screens,
      ledgers: () => { if (options.throwLedger) throw new Error('unreadable'); return options.ledgers ?? []; },
      runScreenKey: (id) => runScreens[id]?.screenKey,
    };
    return decideSelfSend({ opts: { memo: 'memo' }, now, ...input }, deps);
  }
  const memo = (spaceId: string, warnings?: string[]) => expect.objectContaining({ kind: 'send', channel: 'inbox', spaceId, ...(warnings ? { warnings } : {}) });
  const refused = (result: ReturnType<typeof decide>, text: string, exitCode: 1 | 2) => {
    expect(result.kind).toBe('refuse');
    if (result.kind === 'refuse') {
      expect(result.message).toContain(text);
      expect(result.exitCode).toBe(exitCode);
    }
  };

  test('resolves a run to its latest differently shaped screen before delivering a memo', () => {
    expect(decide({ opts: { run: runId, memo: 'memo' } }, { screens: [screen(older), screen(newer)], runScreens: { [runId]: { screenKey: newer } } })).toEqual(memo(newer));
  });
  test('normalizes a trailing-hyphen run screen key before selecting its inbox', () => {
    const key = 'self-impl-goalid-473d2feaade20de2-src-pty-shell-pty-manifest-ts';
    expect(decide({ opts: { run: runId, memo: 'memo' } }, { screens: [screen(key)], runScreens: { [runId]: { screenKey: `${key}-` } } })).toEqual(memo(key));
  });
  test('keeps an unchanged run screen key delivering to its existing inbox', () => {
    expect(decide({ opts: { run: runId, memo: 'memo' } })).toEqual(memo(older));
  });
  test('rejects a normalized run screen key with no screen or inbox write', () => {
    refused(decide({ opts: { run: runId, memo: 'memo' } }, { screens: [], runScreens: { [runId]: { screenKey: `${older}-` } } }), `해석한 화면이 없습니다: ${older}`, 1);
  });
  test('rejects an unresolved run without recording to any screen', () => {
    const result = decide({ opts: { run: runId, memo: 'memo' } }, { runScreens: { [runId]: { missingStatus: 'not-found' } } });
    refused(result, 'run 화면 해석 불가:', 1);
    refused(result, 'Pod 조각 기록도 0', 1);
  });
  test('routes a screenless child run to its sole Pod fragment', () => {
    expect(decide({ opts: { run: runId, memo: 'memo' } }, { runScreens: {}, podFragments: [{ spaceId: 'task-child' }] }))
      .toEqual({ kind: 'send', spaceId: 'task-child', channel: 'pod', warnings: [] });
  });
  test('routes a screenless parent run to its sole Pod fragment', () => {
    const parentRunId = 'run-parent';
    expect(decide({ opts: { run: parentRunId, stop: true } }, { runScreens: {}, podFragments: [{ spaceId: 'task-child' }] }))
      .toEqual({ kind: 'send', spaceId: 'task-child', channel: 'pod', warnings: [] });
  });
  test('refuses multiple Pod fragments for a screenless run and names every space', () => {
    const result = decide({ opts: { run: runId, memo: 'memo' } }, { runScreens: {}, podFragments: [{ spaceId: 'task-a' }, { spaceId: 'task-b' }] });
    refused(result, 'space 이름으로 다시 보내세요', 2);
    refused(result, 'task-a', 2);
    refused(result, 'task-b', 2);
  });
  test('keeps a resolved local screen ahead of Pod records', () => {
    expect(decide({ opts: { run: runId, memo: 'memo' } }, { podFragments: [{ spaceId: 'task-child' }] })).toEqual(memo(older));
  });
  test('rejects conflicting controls even when a screenless run has one Pod fragment', () => {
    refused(decide({ opts: { run: runId, stop: true, memo: 'memo' } }, { runScreens: {}, podFragments: [{ spaceId: 'task-child' }] }), '--stop 과 --memo', 2);
  });
  test('preserves unresolved run rejection before missing or conflicting control options', () => {
    for (const opts of [{ run: runId }, { run: runId, stop: true, memo: 'memo' }]) {
      const result = decide({ opts }, { runScreens: {} });
      refused(result, 'run 화면 해석 불가:', 1);
      if (result.kind === 'refuse') {
        expect(result.message).not.toContain('self send에는 --stop 또는 --memo <sentence>가 필요합니다.');
        expect(result.message).not.toContain('self send에서는 --stop 과 --memo를 함께 사용할 수 없습니다.');
      }
    }
  });
  test('rejects simultaneous explicit space and run targets without recording', () => {
    refused(decide({ space: older, opts: { run: runId, memo: 'memo' } }), '--run 과 space 는 함께 사용할 수 없습니다.', 2);
  });
  test('keeps the explicit screen-key delivery path unchanged', () => {
    expect(decide({ space: older })).toEqual(memo(older));
  });
  test('preserves the stop and memo conflict before refusing a TUI self-report target', () => {
    const result = decide({ space: 'tui:84650', opts: { stop: true, memo: 'memo' } }, { target: { kind: 'refuse', reason: 'tui-self-report-has-no-inbox-reader' } });
    refused(result, 'self send에서는 --stop 과 --memo를 함께 사용할 수 없습니다.', 2);
    if (result.kind === 'refuse') expect(result.message).not.toContain('self send 대상 거절:');
  });
  test('preserves the required-control-option rejection before refusing a TUI self-report target', () => {
    const result = decide({ space: 'tui:84650', opts: {} }, { target: { kind: 'refuse', reason: 'tui-self-report-has-no-inbox-reader' } });
    refused(result, 'self send에는 --stop 또는 --memo <sentence>가 필요합니다.', 2);
    if (result.kind === 'refuse') expect(result.message).not.toContain('self send 대상 거절:');
  });
  test('rejects a superseded explicit memo without recording it and names both attempts', () => {
    const result = decide({ space: older }, { screens: [screen(older, 'alive', now - 2000), screen(newer, 'alive', now - 1000)] });
    refused(result, `${older} → ${newer}`, 2);
  });
  test('groups legacy and run-suffixed attempts for explicit-target protection and candidate display', () => {
    const legacy = 'self-impl-shared-goal-aaaaaaaa';
    const suffixed = 'self-impl-shared-goal-bbbbbbbb-rc41218';
    const candidates = [screen(legacy, 'alive', now - 2000), screen(suffixed, 'alive', now - 1000)];
    refused(decide({ space: legacy }, { screens: candidates }), `${legacy} → ${suffixed}`, 2);
    const display = formatSelfSendCandidateDisplay(candidates, { now });
    expect(display.lines[0]).toContain('같은 골의 다른 시도');
    expect(display.lines[1]).toContain('같은 골의 다른 시도 · 가장 최근');
  });

  test('rejects a superseded explicit stop without recording it', () => {
    refused(decide({ space: older, opts: { stop: true } }, { screens: [screen(older, 'alive', now - 2000), screen(newer, 'alive', now - 1000)] }), '더 최근 시도로 교체되었습니다', 2);
  });
  test('--memo names the record file and reports «읽음» once a consumer claims it', () => {
    expect(decide({ space: older, opts: { memo: 'read me', readWait: '5' } })).toEqual(memo(older));
  });
  test('--memo without a consumer says «아직 안 읽힘» with the check command and still exits 0', () => {
    expect(decide({ space: older, opts: { memo: 'nobody reads', readWait: '1' } })).toEqual(memo(older));
  });
  test('keeps an explicit sole target and the omitted sole-target path recording normally', () => {
    expect(decide({ space: older })).toEqual(memo(older));
    expect(decide({ opts: { stop: true } })).toEqual(expect.objectContaining({ kind: 'send', spaceId: older }));
  });
  test('displays alive heartbeat age from the supplied timestamp without changing other liveness states', () => {
    const candidates = [
      { ...screen('alive-seconds-space'), heartbeatAtMs: now - 50_000 },
      { ...screen('alive-minutes-space'), heartbeatAtMs: now - 2_898_000 },
      screen('alive-without-time-space'),
      { ...screen('dead-space', 'dead'), heartbeatAtMs: now - 50_000 },
      { ...screen('unknown-space', 'unknown'), heartbeatAtMs: now - 50_000 },
      { spaceId: 'missing-space', mtimeMs: now },
    ];
    const first = formatSelfSendCandidateDisplay(candidates, { now });
    const second = formatSelfSendCandidateDisplay(candidates, { now });
    expect(first).toEqual(second);
    expect(first.lines[0]).toContain('자식 생존 (heartbeat 50초 전)');
    expect(first.lines[1]).toContain('자식 생존 (heartbeat 48분 전)');
    expect(first.lines[1]).not.toContain('50초 전');
    expect(first.lines[2]).toContain('자식 생존');
    expect(first.lines[2]).not.toContain('heartbeat ');
    expect(first.lines[3]).toContain('자식 사망 (heartbeat alive=false)');
    expect(first.lines[3]).not.toContain('50초 전');
    expect(first.lines[4]).not.toContain('자식 생존');
    expect(first.lines[4]).not.toContain('50초 전');
    expect(first.lines[5]).not.toContain('자식 생존');
    expect(first.lines[5]).not.toContain('50초 전');
  });
  test('renders distinct alive heartbeat ages through the self send candidate-list path', () => {
    const screens = [screen('seconds'), screen('minutes'), screen('dead', 'dead')].map((item, i) => ({ ...item, heartbeatAtMs: i === 1 ? now - 2_898_000 : now - 50_000 }));
    const result = decide({}, { screens });
    refused(result, 'soft stop 대상이 모호합니다.', 2);
    if (result.kind === 'refuse') {
      expect(result.message).toContain('heartbeat 50초 전');
      expect(result.message).toContain('heartbeat 48분 전');
      expect(result.message).toContain('자식 사망 (heartbeat alive=false)');
      expect(result.message).not.toContain('자식 사망 (heartbeat 50초 전)');
    }
  });
  test('warns and records when a dead heartbeat has no lifecycle evidence', () => {
    expect(decide({ space: older }, { screens: [screen(older, 'dead')] })).toEqual(memo(older, [`경고: self send 대상 런의 lifecycle 상태를 알 수 없습니다: ${older}. 기록은 계속합니다.\n`]));
  });
  test('rejects a terminal run distinctly from a dead child and preserves dead-child stop rejection', () => {
    const options = { screens: [screen(older, 'dead')], ledgers: [{ runId, entries: [{ event: 'start', data: {} }, { event: 'run-status', data: { runStatus: 'completed' } }] }] };
    const memoDecision = decide({ opts: { run: runId, memo: 'memo' } }, options);
    refused(memoDecision, '런이 이미 종료되었습니다', 2);
    if (memoDecision.kind === 'refuse') expect(memoDecision.message).not.toContain('heartbeat alive=false');
    refused(decide({ opts: { run: runId, stop: true } }, options), 'heartbeat alive=false', 2);
  });
  test('rejects a terminal run resolved from a dead heartbeat without inbox records', () => {
    expect(decide({ opts: { run: runId, memo: 'memo' } }, { screens: [screen(older, 'dead')], ledgers: [{ runId, entries: [{ event: 'start', data: {} }, { event: 'terminal', data: {} }] }] })).toEqual({
      kind: 'refuse',
      exitCode: 2,
      message: `self send 대상 런이 이미 종료되었습니다: ${runId}. 메모를 기록하지 않았습니다. 새 런을 시작해 다시 보내세요.\n`,
    });
  });
  test('records a memo for a continuing run despite its dead child through explicit --run', () => {
    expect(decide({ opts: { run: runId, memo: 'memo' } }, { screens: [screen(older, 'dead')], ledgers: [{ runId, entries: [{ event: 'start', data: {} }] }] })).toEqual(memo(older));
  });
  test('warns and records for empty or lifecycle-less ledgers', () => {
    for (const entries of [[], [{ event: 'note', data: {} }]]) {
      const result = decide({ opts: { run: runId, memo: 'memo' } }, { screens: [screen(older, 'dead')], ledgers: [{ runId, entries }] });
      expect(result).toEqual(memo(older, [`경고: self send 대상 런의 lifecycle 상태를 알 수 없습니다: ${runId}. 기록은 계속합니다.\n`]));
    }
  });
  test('uses the same terminal-then-start lifecycle rule for explicit and space targets', () => {
    const options = { screens: [screen(older, 'dead')], ledgers: [{ runId, entries: ['start', 'terminal', 'start'].map((event) => ({ event, data: {} })) }] };
    expect(decide({ opts: { run: runId, memo: 'memo' } }, options)).toEqual(memo(older));
    expect(decide({ space: older }, options)).toEqual(memo(older));
  });
  test('applies terminal lifecycle rejection across explicit run, space, and automatic targets for every heartbeat state', () => {
    for (const liveness of ['alive', 'dead', 'unknown'] as const) for (const input of [{ opts: { run: runId, memo: 'memo' } }, { space: older }, {}]) {
      refused(decide(input, { screens: [screen(older, liveness)], ledgers: [{ runId, entries: [{ event: 'start', data: {} }, { event: 'terminal', data: {} }] }] }), '런이 이미 종료되었습니다', 2);
    }
  });
  test('uses lifecycle evidence for continuing and unknown ledgers across space and automatic targets', () => {
    for (const [entries, warning] of [[[{ event: 'start', data: {} }], false], [[], true], [[{ event: 'note', data: {} }], true], [['start', 'terminal', 'start'].map((event) => ({ event, data: {} })), false]] as const) {
      for (const input of [{ space: older }, {}]) {
        const result = decide(input, { screens: [screen(older, 'dead')], ledgers: [{ runId, entries }] });
        expect(result.kind).toBe('send');
        if (result.kind === 'send') expect(result.warnings.some((line) => line.includes('lifecycle 상태를 알 수 없습니다'))).toBe(warning);
      }
    }
  });
  test('permits missing and alive heartbeats to record control memos', () => {
    const missing = decide({ space: older }, { screens: [screen(older, 'unknown')] });
    expect(missing).toEqual(memo(older));
    expect(missing.kind === 'send' && missing.warnings.join('')).toContain('heartbeat 상태를 알 수 없습니다');
    const alive = decide({ space: newer }, { screens: [screen(newer, 'alive')] });
    expect(alive).toEqual(memo(newer));
    if (alive.kind === 'send') expect(alive.warnings.join('')).not.toContain('heartbeat 상태를 알 수 없습니다');
  });
  test('permits an old alive heartbeat to record a control memo', () => {
    const result = decide({ space: older }, { screens: [{ ...screen(older), heartbeatAtMs: now - 2_898_000 }] });
    expect(result).toEqual(memo(older));
    expect(result.kind === 'send' && result.warnings.join('')).toContain('heartbeat가 5분보다 오래되어');
  });
});
