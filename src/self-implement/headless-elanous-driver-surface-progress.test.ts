import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { classifyFrameState, GOAL_LOOP_STATE_RULES, UNKNOWN_INPUT_MAX_LINE_LENGTH, UNKNOWN_INPUT_MAX_LINES } from '../capture/frame-state-detect.js';
import { decideBoundaryApproval } from './auto-intervene.js';
import { encodeReportOriginEnv } from './report-origin.js';
import {
  countSurfaceProgressOutcome,
  deliverSurfaceProgress,
  formatBoundaryProgressLine,
  formatFrameStallProgressLine,
  formatSurfaceLinkProgressLine,
  formatSupervisionProgressLine,
  formatWaitSupervisionBatchReason,
  runHeadlessGoalLoopPty,
  watchHarnessBoundaryRequests,
} from './headless-elanous-driver.js';

const previousStateDir = process.env.ELANOUS_STATE_DIR;
const previousReportOrigin = process.env.ELANOUS_REPORT_ORIGIN;
const stateDirs: string[] = [];

beforeEach(() => { delete process.env.ELANOUS_REPORT_ORIGIN; });

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = previousStateDir;
  if (previousReportOrigin === undefined) delete process.env.ELANOUS_REPORT_ORIGIN;
  else process.env.ELANOUS_REPORT_ORIGIN = previousReportOrigin;
  for (const stateDir of stateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

function configureBoundaryMailboxState(): string {
  const stateDir = mkdtempSync(join(tmpdir(), 'headless-surface-progress-'));
  stateDirs.push(stateDir);
  process.env.ELANOUS_STATE_DIR = stateDir;
  return stateDir;
}

describe('headless parent-surface progress lines', () => {
  test('renders the three sparse surface events without raw PTY deltas', () => {
    const boundary = formatBoundaryProgressLine({
      requestId: 'request-1', wouldApprove: true, approve: false, shadowed: true, evidenceWhy: 'write permitted',
    });
    const supervision = formatSupervisionProgressLine({ action: 'input', reason: 'continue implementation', delivery: 'queued' });
    const frameStall = formatFrameStallProgressLine({ previousRung: 1, currentRung: 2 });

    expect(boundary).toBe('[boundary] requestId=request-1 reason=write permitted parentWouldApprove=true approvalEnforced=false childRejection=would-have-been-approved observedRawShellMetacharacters=unknown\n');
    expect(formatBoundaryProgressLine({
      requestId: 'request-2', wouldApprove: false, approve: true, shadowed: false, evidenceWhy: 'write blocked',
    })).toBe('[boundary] requestId=request-2 reason=write blocked parentWouldApprove=false approvalEnforced=true childRejection=not-rejected observedRawShellMetacharacters=unknown\n');
    expect(formatBoundaryProgressLine({
      requestId: 'request-3', wouldApprove: false, approve: false, shadowed: true, evidenceWhy: 'shadow blocked',
    })).toBe('[boundary] requestId=request-3 reason=shadow blocked parentWouldApprove=false approvalEnforced=false childRejection=preserved observedRawShellMetacharacters=unknown\n');
    expect(formatBoundaryProgressLine({
      requestId: 'request-4', wouldApprove: false, approve: false, shadowed: false, evidenceWhy: 'actually blocked',
    })).toBe('[boundary] requestId=request-4 reason=actually blocked parentWouldApprove=false approvalEnforced=false childRejection=preserved observedRawShellMetacharacters=unknown\n');
    expect(formatBoundaryProgressLine({
      requestId: 'request-5', wouldApprove: true, approve: false, shadowed: true, evidenceWhy: 'boundary-shell-syntax-with-bun',
      observedRawShellMetacharacters: '',
    })).toBe('[boundary] requestId=request-5 reason=boundary-shell-syntax-with-bun parentWouldApprove=true approvalEnforced=false childRejection=would-have-been-approved observedRawShellMetacharacters=\n');
    expect(formatBoundaryProgressLine({
      requestId: 'request-6', wouldApprove: true, approve: false, shadowed: true, evidenceWhy: 'boundary-shell-syntax-with-bun',
      observedRawShellMetacharacters: '|&',
    })).toBe('[boundary] requestId=request-6 reason=boundary-shell-syntax-with-bun parentWouldApprove=true approvalEnforced=false childRejection=would-have-been-approved observedRawShellMetacharacters=|&\n');
    expect(formatBoundaryProgressLine({
      requestId: 'request-7', wouldApprove: true, approve: false, shadowed: true, evidenceWhy: 'boundary-shell-syntax-with-bun',
      observedRawShellMetacharacters: '\n',
    })).toBe('[boundary] requestId=request-7 reason=boundary-shell-syntax-with-bun parentWouldApprove=true approvalEnforced=false childRejection=would-have-been-approved observedRawShellMetacharacters=\\n\n');
    // «무엇이» 막혔나 — verdict 의 안전한 칸 셋이 기존 칸 «뒤»에 붙는다.
    expect(formatBoundaryProgressLine({
      requestId: 'request-8', wouldApprove: true, approve: false, shadowed: true, evidenceWhy: 'boundary-shell-syntax-with-bun',
      observedRawShellMetacharacters: '|', commandFirstToken: 'bun', decidingToken: '|', commandAction: 'bun run',
    })).toBe('[boundary] requestId=request-8 reason=boundary-shell-syntax-with-bun parentWouldApprove=true approvalEnforced=false childRejection=would-have-been-approved observedRawShellMetacharacters=| commandFirstToken=bun decidingToken=| commandAction=bun run\n');
    // 제어문자는 한 줄로 접힌다(값에 줄바꿈이 섞여도 진행 줄이 둘로 갈라지지 않는다).
    expect(formatBoundaryProgressLine({
      requestId: 'request-9', wouldApprove: false, approve: false, shadowed: true, evidenceWhy: 'x',
      commandFirstToken: 'b\nun', decidingToken: '\n',
    })).toBe('[boundary] requestId=request-9 reason=x parentWouldApprove=false approvalEnforced=false childRejection=preserved observedRawShellMetacharacters=unknown commandFirstToken=b un decidingToken=\\n\n');
    expect(boundary).toContain('parentWouldApprove=true');
    expect(boundary).toContain('approvalEnforced=false');
    expect(boundary).toContain('childRejection=would-have-been-approved');
    expect(boundary).toContain('observedRawShellMetacharacters=');
    expect(supervision).toBe('[supervision] action=input reason=continue implementation delivery=queued\n');
    expect(formatSupervisionProgressLine({ action: 'input', reason: 'continue implementation', delivery: 'delivered' }))
      .toBe('[supervision] action=input reason=continue implementation delivery=delivered\n');
    expect(formatSupervisionProgressLine({ action: 'input', reason: 'continue implementation', delivery: 'delivered', inputInstructionOccurrence: 2 }))
      .toBe('[supervision] action=input reason=continue implementation delivery=delivered inputInstructionOccurrence=2\n');
    expect(formatSupervisionProgressLine({ action: 'input', reason: 'continue implementation', delivery: 'not-delivered', deliveryReason: 'rework-round-limit' }))
      .toBe('[supervision] action=input reason=continue implementation delivery=not-delivered deliveryReason=rework-round-limit\n');
    expect(formatSupervisionProgressLine({ action: 'wait', reason: 'waitCount=5 latestJudgment=wait' }))
      .toBe('[supervision] action=wait reason=waitCount=5 latestJudgment=wait\n');
    expect(frameStall).toBe('[frame-stall] previousRung=1 currentRung=2\n');
    expect([boundary, supervision, frameStall].join('')).not.toContain('raw PTY delta');
  });

  test('carries each closed mailbox request kind identically through decision response and verdict callback', () => {
    const directory = mkdtempSync(join(tmpdir(), 'headless-boundary-request-kind-'));
    const requestsPath = join(directory, 'requests.jsonl');
    const responsesPath = join(directory, 'responses.jsonl');
    const watcher = new EventEmitter() as EventEmitter & { close: () => void };
    const verdicts: Array<{ requestId: string; requestKind: string }> = [];
    watcher.close = () => {};
    const stop = watchHarnessBoundaryRequests(requestsPath, { ptyId: 'pty-kind', runId: 'run-kind' }, {
      responsePath: responsesPath,
      onVerdict: (verdict) => verdicts.push({ requestId: verdict.requestId, requestKind: verdict.requestKind }),
      watchDirectory: ((_directory: string, listener: (...args: unknown[]) => void) => {
        watcher.on('change', listener);
        return watcher;
      }) as unknown as typeof import('node:fs').watch,
    });
    try {
      const base = { boundary: '/tmp/worktree', cwd: '/tmp/worktree', targetKnown: true, target: '/tmp/worktree/src/a.ts', commandFirstToken: 'bun' };
      const expected = [
        { requestId: 'rejected', requestKind: 'rejected' },
        { requestId: 'command-start', requestKind: 'command-start', requestType: 'command-start' },
        { requestId: 'command-start-cap-reached', requestKind: 'command-start-cap-reached', requestType: 'command-start-cap-reached' },
      ];
      for (const request of expected) appendFileSync(requestsPath, `${JSON.stringify({ ...base, ...request })}\n`);
      watcher.emit('change', 'requests.jsonl');
      expect(readFileSync(responsesPath, 'utf8').trimEnd().split('\n').map((line) => {
        const response = JSON.parse(line) as { requestId: string; requestKind: string };
        return { requestId: response.requestId, requestKind: response.requestKind };
      })).toEqual(expected.map(({ requestId, requestKind }) => ({ requestId, requestKind })));
      expect(verdicts).toEqual(expected.map(({ requestId, requestKind }) => ({ requestId, requestKind })));
    } finally {
      stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('request-received carries a short summary that survives truncation of the raw request', () => {
    const directory = mkdtempSync(join(tmpdir(), 'headless-boundary-summary-'));
    const requestsPath = join(directory, 'requests.jsonl');
    const watcher = new EventEmitter() as EventEmitter & { close: () => void };
    watcher.close = () => {};
    const original = (debug as { log: typeof debug.log }).log;
    const received: Array<Record<string, unknown>> = [];
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      if (category === 'harness.boundary' && event === 'request-received') received.push(data as Record<string, unknown>);
    }) as typeof debug.log;
    const stop = watchHarnessBoundaryRequests(requestsPath, { ptyId: 'pty-summary', runId: 'run-summary' }, {
      responsePath: join(directory, 'responses.jsonl'),
      watchDirectory: ((_directory: string, listener: (...args: unknown[]) => void) => {
        watcher.on('change', listener);
        return watcher;
      }) as unknown as typeof import('node:fs').watch,
    });
    try {
      // 긴 경로 칸 «뒤»에 결정 토큰이 온다 — 원문은 상한(1024자)에서 잘려 JSON 으로 못 읽는다.
      const longPath = `/tmp/${'p'.repeat(2000)}`;
      appendFileSync(requestsPath, `${JSON.stringify({
        requestId: 'long-rejected', boundary: '/tmp/worktree', cwd: '/tmp/worktree', targetKnown: false,
        path: longPath, target: longPath, commandFirstToken: 'bun', commandHash: 'abc123', decidingToken: '|',
      })}\n`);
      appendFileSync(requestsPath, 'not json at all\n');
      watcher.emit('change', 'requests.jsonl');
      expect(received).toHaveLength(2);
      expect(received[0]!.summary).toEqual({
        parse: 'ok', requestKind: 'rejected', requestId: 'long-rejected', commandFirstToken: 'bun', decidingToken: '|', commandHash: 'abc123',
      });
      expect(JSON.stringify(received[0]!.summary)).not.toContain('pppp');
      // 「못 읽음」은 «거부»로 접히지 않는다.
      expect(received[1]!.summary).toEqual({ parse: 'invalid-json' });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('renders actual producer verdict candidates separately from enforcement and preserved rejection', () => {
    const inputs = [
      { requestId: 'producer-allowlisted', commandFirstToken: 'bun' },
      { requestId: 'producer-not-allowlisted', commandFirstToken: 'git' },
      { requestId: 'producer-observed-metacharacters', commandFirstToken: 'bun', command: 'bun test src/x.ts | tee out.txt && echo done' },
      { requestId: 'producer-newline-metacharacter', commandFirstToken: 'bun', command: 'bun test\nrg foo' },
    ] as const;
    const lines = inputs.map((input) => formatBoundaryProgressLine({
      requestId: input.requestId,
      ...decideBoundaryApproval({
        requestKind: 'rejected',
        boundary: '/tmp/worktree',
        cwd: '/tmp/worktree/src',
        targetKnown: true,
        target: '/tmp/worktree/src/a.ts',
        commandFirstToken: input.commandFirstToken,
        ...('command' in input ? { command: input.command } : {}),
      }),
    }));

    expect(lines).toEqual([
      '[boundary] requestId=producer-allowlisted reason=boundary-shell-syntax-with-bun parentWouldApprove=true approvalEnforced=false childRejection=would-have-been-approved observedRawShellMetacharacters=unknown commandFirstToken=bun\n',
      '[boundary] requestId=producer-not-allowlisted reason=boundary-shell-syntax-with-git parentWouldApprove=true approvalEnforced=false childRejection=would-have-been-approved observedRawShellMetacharacters=unknown commandFirstToken=git\n',
      '[boundary] requestId=producer-observed-metacharacters reason=boundary-shell-syntax-with-bun parentWouldApprove=true approvalEnforced=false childRejection=would-have-been-approved observedRawShellMetacharacters=|& commandFirstToken=bun\n',
      '[boundary] requestId=producer-newline-metacharacter reason=boundary-shell-syntax-with-bun parentWouldApprove=true approvalEnforced=false childRejection=would-have-been-approved observedRawShellMetacharacters=\\n commandFirstToken=bun\n',
    ]);
    expect(lines.join('')).toContain('observedRawShellMetacharacters=');
    expect(lines.join('')).toContain('parentWouldApprove=true');
    expect(lines.join('')).toContain('approvalEnforced=false');
    expect(lines.join('')).toContain('childRejection=would-have-been-approved');
    expect(lines.join('')).not.toContain('actuallyBlocked=');
    expect(lines.join('')).not.toContain('bun test src/x.ts');
  });

  test('renders a child terminal URL from the dynamic PWA base and preserves unavailable reasons', () => {
    expect(formatSurfaceLinkProgressLine('self_child-1', { status: 'registered', loopback: 'http://127.0.0.1:4312/app/', url: 'http://127.0.0.1:4312/app/', source: 'local' }))
      .toBe('[surface-link] url=http://127.0.0.1:4312/app/term?pty=self_child-1 source=local\n');
    expect(formatSurfaceLinkProgressLine('self_child-1', { status: 'unregistered', loopback: 'http://127.0.0.1:4312/app', url: 'http://127.0.0.1:4312/app', source: 'local', pid: 9 }))
      .toBe('[surface-link] url=http://127.0.0.1:4312/term?pty=self_child-1 source=local\n');
    // ⭐ 사설망 주소를 «고른» 경우 — 링크가 그 주소로 나오고 source 가 그것을 말한다(GOAL-T80 수리).
    expect(formatSurfaceLinkProgressLine('self_child-1', { status: 'registered', loopback: 'http://127.0.0.1:4312/app/', url: 'https://host.ts.net:4312/app/', source: 'tailnet' }))
      .toBe('[surface-link] url=https://host.ts.net:4312/app/term?pty=self_child-1 source=tailnet\n');

    const unavailable = [
      { status: 'absent' as const, reason: 'daemon-absent' as const },
      { status: 'absent' as const, reason: 'pwa-query-failed' as const },
      { status: 'unregistered' as const, reason: 'pwa-url-unknown' as const, pid: 9 },
    ].map((pwa) => formatSurfaceLinkProgressLine('self_child-1', pwa));
    expect(unavailable).toEqual([
      '[surface-link] unavailable=daemon-absent\n',
      '[surface-link] unavailable=pwa-query-failed\n',
      '[surface-link] unavailable=pwa-url-unknown\n',
    ]);
    expect(new Set(unavailable).size).toBe(3);
  });

  test('encodes a newline metacharacter so it stays distinct from a space on one progress line', () => {
    const newlineLine = formatBoundaryProgressLine({
      requestId: 'request-newline', wouldApprove: true, approve: false, shadowed: true, evidenceWhy: 'boundary-shell-syntax-with-bun',
      observedRawShellMetacharacters: '\n',
    });
    const spaceLine = formatBoundaryProgressLine({
      requestId: 'request-space', wouldApprove: true, approve: false, shadowed: true, evidenceWhy: 'boundary-shell-syntax-with-bun',
      observedRawShellMetacharacters: ' ',
    });
    expect(newlineLine).toBe('[boundary] requestId=request-newline reason=boundary-shell-syntax-with-bun parentWouldApprove=true approvalEnforced=false childRejection=would-have-been-approved observedRawShellMetacharacters=\\n\n');
    expect(spaceLine).toBe('[boundary] requestId=request-space reason=boundary-shell-syntax-with-bun parentWouldApprove=true approvalEnforced=false childRejection=would-have-been-approved observedRawShellMetacharacters= \n');
    expect(newlineLine).not.toBe(spaceLine);
    expect(newlineLine).toContain('observedRawShellMetacharacters=\\n');
    expect(newlineLine).not.toContain('observedRawShellMetacharacters= \n');
  });

  test('normalizes event fields to a single parent-surface line', () => {
    expect(formatBoundaryProgressLine({
      requestId: 'request\n2', wouldApprove: false, approve: false, shadowed: true, evidenceWhy: 'reason\nnext',
    })).toBe('[boundary] requestId=request 2 reason=reason next parentWouldApprove=false approvalEnforced=false childRejection=preserved observedRawShellMetacharacters=unknown\n');
    expect(formatSupervisionProgressLine({ action: undefined, reason: undefined }))
      .toBe('[supervision] action=none reason=none\n');
    expect(formatSupervisionProgressLine({ action: 'wait', reason: 'waitCount=2\nlatestJudgment=wait\x1b[31m' }))
      .toBe('[supervision] action=wait reason=waitCount=2 latestJudgment=wait\n');
  });

  test('formats wait batches with count and latest sanitized judgment', () => {
    expect(formatWaitSupervisionBatchReason(5, 'wait'))
      .toBe('waitCount=5 latestJudgment=wait');
    expect(formatWaitSupervisionBatchReason(2, 'wait\nnext\x1b[31m'))
      .toBe('waitCount=2 latestJudgment=wait next');
    expect(formatSupervisionProgressLine({ action: 'wait', reason: formatWaitSupervisionBatchReason(5, 'wait') }))
      .toBe('[supervision] action=wait reason=waitCount=5 latestJudgment=wait\n');
  });

  test('hands sparse surface progress to the dedicated callback', () => {
    const received: string[] = [];
    const outcome = deliverSurfaceProgress('[boundary] requestId=request-1\n', 'boundary', (line) => received.push(line));
    expect(outcome).toEqual({ kind: 'boundary', status: 'handed-to-callback' });
    expect(received).toEqual(['[boundary] requestId=request-1\n']);
  });

  test('records an unwired surface callback separately from an absent surface line', () => {
    expect(deliverSurfaceProgress('[supervision] action=input\n', 'supervision', undefined))
      .toEqual({ kind: 'supervision', status: 'surface-callback-unwired' });
    expect(formatSupervisionProgressLine({ action: undefined, reason: undefined }))
      .toBe('[supervision] action=none reason=none\n');
  });

  test('counts each callback handoff status without changing the outcome', () => {
    const counts = { total: 0, handedToCallback: 0, unwired: 0, callbackFailed: 0 };
    for (const onSurfaceProgress of [
      (line: string) => { expect(line).toContain('[supervision]'); },
      undefined,
      () => { throw new Error('sink unavailable'); },
    ]) {
      const outcome = deliverSurfaceProgress('[supervision] action=input\n', 'supervision', onSurfaceProgress);
      countSurfaceProgressOutcome(counts, outcome);
    }
    expect(counts).toEqual({ total: 3, handedToCallback: 1, unwired: 1, callbackFailed: 1 });
  });

  test('includes canonical unknown input only on frame-state transitions involving unknown', async () => {
    const transitions: Record<string, unknown>[] = [];
    const off = debug.registerSink({
      name: 'headless-frame-state-unknown-input-capture',
      emit: (record) => {
        if (record.category === 'self-implement' && record.event === 'frame-state') {
          transitions.push((record.data ?? {}) as Record<string, unknown>);
        }
      },
    });
    const wasEnabled = debug.enabled;
    debug.enable();
    const longUnknown = Array.from({ length: UNKNOWN_INPUT_MAX_LINES + 2 }, (_, index) => `unknown-${index}-${'x'.repeat(UNKNOWN_INPUT_MAX_LINE_LENGTH + 10)}`).join('\n');
    const screens = [longUnknown, '⏺ Read({"file_path":"x"})', 'GOAL-COMPLETE', 'GOAL-COMPLETE'];
    const canonicalUnknownInput = [...classifyFrameState(longUnknown, GOAL_LOOP_STATE_RULES).unknownInput!];
    expect(canonicalUnknownInput).toHaveLength(UNKNOWN_INPUT_MAX_LINES);
    let screenIndex = 0;
    let now = 1_500;
    let aliveChecks = 0;
    try {
      await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd: '/tmp/worktree', featurePrompt: 'x', runId: 'frame-state-unknown-input',
        maxWaitSec: 4, maxHardWaitSec: 4, pollMs: 1, nowMs: () => (now += 1_500),
        ptyAvailable: () => true,
        spawn: (() => ({
          id: 'frame-state-unknown-input', write: () => {},
          renderScreen: async () => screens[screenIndex++]!, renderScreenPng: async () => null,
          snapshot: () => '', drainDelta: () => '', isAlive: () => aliveChecks++ < 12, exitCode: 0, kill: () => {},
        })) as never,
      });
      expect(transitions).toHaveLength(3);
      const [enteredUnknown, leftUnknown, workingToDone] = transitions;
      expect(enteredUnknown).toMatchObject({ from: null, to: 'unknown', heldMs: 0 });
      expect(leftUnknown).toMatchObject({ from: 'unknown', to: 'working', heldMs: 1_500 });
      expect(workingToDone).toMatchObject({ from: 'working', to: 'done', heldMs: 1_500 });
      for (const transition of [enteredUnknown, leftUnknown]) {
        const input = transition!.unknownInput as string[];
        expect(input).toEqual(canonicalUnknownInput);
        expect(input).toHaveLength(UNKNOWN_INPUT_MAX_LINES);
        expect(input.every((line) => [...line].length <= UNKNOWN_INPUT_MAX_LINE_LENGTH)).toBe(true);
        expect(input[0]).toStartWith('unknown-2-');
      }
      expect(workingToDone).not.toHaveProperty('unknownInput');
      // ⭐ 「어느 규칙이 이 상태를 냈나」 — 생산되고 아무도 안 읽던 값(`matchedLabel`)을 관측이 싣는다.
      //   ⛔ unknown 은 어느 규칙도 안 물었으므로 «없어야» 한다 — 「모른다」와 「어느 규칙」은 다른 값이다.
      expect(enteredUnknown).not.toHaveProperty('matchedRule');
      expect(workingToDone!.matchedRule).toBe(classifyFrameState('GOAL-COMPLETE', GOAL_LOOP_STATE_RULES).matchedLabel);
      expect(workingToDone!.matchedRule).toBeTruthy();   // ⛔ 모집단 0이면 위 단언이 공허해진다
    } finally {
      off();
      if (!wasEnabled) debug.disable();
    }
  });

  // ⭐ unknown 진단의 «둘째 축»(`MEAS-T57` · `JDG-T35` ⑴) — 「화면에 신호가 없었다」와
  //   「신호가 «창 밖»이라 못 봤다」를 관측이 «가르는지». 값은 classifyFrameState 가 내지만
  //   이 배선이 없으면 그 값을 «볼 사람이 없다**(그것이 이 테스트가 지키는 것이다).
  test('창 밖으로 밀린 후보를 frame-state 전이에 싣고, whole 규칙은 후보가 될 수 없다', async () => {
    const transitions: Record<string, unknown>[] = [];
    const off = debug.registerSink({
      name: 'headless-frame-state-out-of-region-capture',
      emit: (record) => {
        if (record.category === 'self-implement' && record.event === 'frame-state') {
          transitions.push((record.data ?? {}) as Record<string, unknown>);
        }
      },
    });
    const wasEnabled = debug.enabled;
    debug.enable();
    // idle 규칙은 bottomLines 3 을 본다 ⇒ 세션 줄을 위로 밀어내면 «창 밖»이 된다.
    const promptPushedOut = ['[session abcdef123456]', 'filler 1', 'filler 2', 'filler 3', 'filler 4'].join('\n');
    const canonical = classifyFrameState(promptPushedOut, GOAL_LOOP_STATE_RULES);
    expect(canonical.state).toBe('unknown');                       // ⛔ 전제: 이 화면이 정말 unknown 이다
    expect(canonical.outOfRegionCandidates ?? []).not.toHaveLength(0); // ⛔ 모집단 0 아님
    const screens = [promptPushedOut, '⏺ Read({"file_path":"x"})', 'GOAL-COMPLETE', 'GOAL-COMPLETE'];
    let screenIndex = 0;
    let now = 1_500;
    let aliveChecks = 0;
    try {
      await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd: '/tmp/worktree', featurePrompt: 'x', runId: 'frame-state-out-of-region',
        maxWaitSec: 4, maxHardWaitSec: 4, pollMs: 1, nowMs: () => (now += 1_500),
        ptyAvailable: () => true,
        spawn: (() => ({
          id: 'frame-state-out-of-region', write: () => {},
          renderScreen: async () => screens[screenIndex++]!, renderScreenPng: async () => null,
          snapshot: () => '', drainDelta: () => '', isAlive: () => aliveChecks++ < 12, exitCode: 0, kill: () => {},
        })) as never,
      });
      expect(transitions).toHaveLength(3);
      const [enteredUnknown, leftUnknown, workingToDone] = transitions;
      // unknown 이 걸린 두 전이에 실린다 — 그리고 값이 classifyFrameState 산출과 «같다».
      for (const transition of [enteredUnknown, leftUnknown]) {
        expect(transition!.outOfRegionCandidates).toEqual([...canonical.outOfRegionCandidates!]);
      }
      // ⛔ whole 규칙(goal-loop-tool-activity)은 「밖」이 없으므로 후보가 될 수 없다.
      expect(enteredUnknown!.outOfRegionCandidates as string[]).not.toContain('goal-loop-tool-activity');
      // unknown 과 무관한 전이에는 아예 없다 — 「빈 배열」과 「필드 부재」도 다른 값이다.
      expect(workingToDone).not.toHaveProperty('outOfRegionCandidates');
    } finally {
      off();
      if (!wasEnabled) debug.disable();
    }
  });

  test('actual driver run emits and observes one child link without blocking resolver failure', async () => {
    const spawnRecords: Record<string, unknown>[] = [];
    const off = debug.registerSink({
      name: 'headless-surface-link-capture',
      emit: (record) => {
        if (record.category === 'self-implement' && record.event === 'headless.spawn') {
          spawnRecords.push((record.data ?? {}) as Record<string, unknown>);
        }
      },
    });
    const wasEnabled = debug.enabled;
    debug.enable();
    const surfaceLines: string[] = [];
    let resolverCalls = 0;
    let aliveChecks = 0;
    try {
      await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd: '/tmp/worktree', featurePrompt: 'x', runId: 'surface-link-run', maxWaitSec: 1, pollMs: 1,
        ptyAvailable: () => true,
        resolveNexusPwa: ({ cwd }) => {
          resolverCalls += 1;
          expect(cwd).toBe('/tmp/worktree');
          return { status: 'registered', loopback: 'http://127.0.0.1:4312/app/', url: 'http://127.0.0.1:4312/app/', source: 'local' };
        },
        spawn: (() => ({
          id: 'self_surface-link-run', write: () => {}, renderScreen: async () => 'working', renderScreenPng: async () => null,
          snapshot: () => 'working', drainDelta: () => '', isAlive: () => aliveChecks++ < 2, exitCode: 0, kill: () => {},
        })) as never,
        onSurfaceProgress: (line) => surfaceLines.push(line),
      });
      expect(resolverCalls).toBe(1);
      expect(surfaceLines).toContain('[surface-link] url=http://127.0.0.1:4312/app/term?pty=self_surface-link-run source=local\n');
      expect(spawnRecords).toHaveLength(1);
      expect(spawnRecords[0]).toMatchObject({
        ptyId: 'self_surface-link-run', runId: 'surface-link-run',
        surfaceLinkUrl: 'http://127.0.0.1:4312/app/term?pty=self_surface-link-run',
      });
    } finally {
      off();
      if (!wasEnabled) debug.disable();
    }

    const failureLines: string[] = [];
    aliveChecks = 0;
    await runHeadlessGoalLoopPty({
      binRoot: '/tmp/repo', cwd: '/tmp/worktree', featurePrompt: 'x', runId: 'surface-link-failure', maxWaitSec: 1, pollMs: 1,
      ptyAvailable: () => true,
      resolveNexusPwa: () => { throw new Error('resolver unavailable'); },
      spawn: (() => ({
        id: 'self_surface-link-failure', write: () => {}, renderScreen: async () => 'working', renderScreenPng: async () => null,
        snapshot: () => 'working', drainDelta: () => '', isAlive: () => aliveChecks++ < 2, exitCode: 0, kill: () => {},
      })) as never,
      onSurfaceProgress: (line) => failureLines.push(line),
    });
    expect(failureLines).toContain('[surface-link] unavailable=pwa-query-failed\n');
  });

  test('reports one link only for an originating telegram conversation and a resolved URL; send failure is fail-soft', async () => {
    const origin = { channel: 'telegram' as const, chatId: -100123, botId: 'bot-1', threadId: 7 };
    const sends: Array<{ text: string; kind: string; origin: unknown }> = [];
    const reported: Record<string, unknown>[] = [];
    const off = debug.registerSink({
      name: 'headless-link-reported-capture',
      emit: (record) => {
        if (record.category === 'self-implement.surface-link' && record.event === 'reported') reported.push(record.data as Record<string, unknown>);
      },
    });
    const wasEnabled = debug.enabled;
    debug.enable();
    const run = async (hasOrigin: boolean, hasLink: boolean, failSend = false) => {
      configureBoundaryMailboxState();
      if (hasOrigin) Object.assign(process.env, encodeReportOriginEnv(origin));
      else delete process.env.ELANOUS_REPORT_ORIGIN;
      let aliveChecks = 0;
      const lines: string[] = [];
      const result = await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd: '/tmp/worktree', featurePrompt: 'x', runId: 'report-link-run', maxWaitSec: 1, pollMs: 1,
        ptyAvailable: () => true,
        resolveNexusPwa: () => hasLink
          ? { status: 'registered', loopback: 'http://127.0.0.1:4312/', url: 'https://host.ts.net/', source: 'tailnet' }
          : { status: 'absent', reason: 'daemon-absent' },
        spawn: (() => ({
          id: 'self_12345678', write: () => {}, renderScreen: async () => 'working', renderScreenPng: async () => null,
          snapshot: () => 'working', drainDelta: () => '', isAlive: () => aliveChecks++ < 2, exitCode: 0, kill: () => {},
        })) as never,
        onSurfaceProgress: (line) => lines.push(line),
        sendOutbound: (text, kind, destination) => {
          sends.push({ text, kind: kind ?? 'alert', origin: destination });
          if (failSend) throw new Error('telegram unavailable');
          return true;
        },
      });
      expect(result.ok).toBe(true);
      expect(lines.filter((line) => line.startsWith('[surface-link]'))).toHaveLength(1);
    };
    try {
      await run(true, true);
      expect(sends).toHaveLength(1);
      expect(typeof sends[0]!.text).toBe('string');
      expect(sends[0]!.text).toContain('https://host.ts.net/term?pty=self_12345678');
      expect(sends[0]!.text).toContain('takeover');
      expect(sends[0]).toMatchObject({ kind: 'report', origin });
      expect(reported).toHaveLength(1);
      expect(reported[0]).toMatchObject({ ptyId: 'self_12345678', chatId: -100123 });
      await run(false, true);
      await run(true, false);
      expect(sends).toHaveLength(1);
      await run(true, true, true);
      expect(sends).toHaveLength(2);
      expect(reported).toHaveLength(1);
    } finally {
      off();
      if (!wasEnabled) debug.disable();
    }
  });

  test('actual driver run includes callback-handoff and unwired parent-surface totals in headless.done', async () => {
    const done: Record<string, unknown>[] = [];
    const off = debug.registerSink({
      name: 'headless-surface-progress-done-capture',
      emit: (record) => {
        if (record.category === 'self-implement' && record.event === 'headless.done') {
          done.push((record.data ?? {}) as Record<string, unknown>);
        }
      },
    });
    const wasEnabled = debug.enabled;
    const stateDir = configureBoundaryMailboxState();
    expect(process.env.ELANOUS_STATE_DIR).toBe(stateDir);
    debug.enable();
    const run = async (runId: string, onSurfaceProgress?: (line: string) => void): Promise<Record<string, unknown>> => {
      let aliveChecks = 0;
      await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd: '/tmp/worktree', featurePrompt: 'x', runId, maxWaitSec: 1, pollMs: 1,
        ptyAvailable: () => true,
        spawn: ((options: { env: Record<string, string> }) => {
          writeFileSync(options.env.ELANOUS_HARNESS_BOUNDARY_REQUESTS!, `${JSON.stringify({
            requestId: 'surface-progress', boundary: '/tmp/worktree', cwd: '/tmp/worktree/src',
            targetKnown: true, target: '/tmp/worktree/src/a.ts', commandFirstToken: 'bun',
          })}\n`);
          return {
            id: 'surface-progress-run', write: () => {}, renderScreen: async () => 'working', renderScreenPng: async () => null,
            snapshot: () => 'working', drainDelta: () => '', isAlive: () => aliveChecks++ < 2, exitCode: 0, kill: () => {},
          };
        }) as never,
        onSurfaceProgress,
      });
      const observed = done.filter((record) => record.runId === runId);
      expect(observed).toHaveLength(1);
      return observed[0]!;
    };
    try {
      const unwired = await run('surface-progress-unwired');
      expect(typeof unwired.surfaceProgressTotal).toBe('number');
      expect(typeof unwired.surfaceProgressUnwired).toBe('number');
      expect(unwired.surfaceProgressTotal).toBe(2);
      expect(unwired.surfaceProgressUnwired).toBe(2);
      expect(unwired.surfaceProgressHandedToCallback).toBe(0);
      expect(unwired.surfaceProgressCallbackFailed).toBe(0);

    const callbackLines: string[] = [];
    const handedToCallback = await run('surface-progress-handed-to-callback', (line) => callbackLines.push(line));
    expect(typeof handedToCallback.surfaceProgressTotal).toBe('number');
    expect(typeof handedToCallback.surfaceProgressHandedToCallback).toBe('number');
    expect(handedToCallback.surfaceProgressTotal).toBe(2);
    expect(handedToCallback.surfaceProgressHandedToCallback).toBe(2);
    expect(handedToCallback.surfaceProgressUnwired).toBe(0);
    expect(handedToCallback.surfaceProgressCallbackFailed).toBe(0);
    expect(callbackLines).toContain('[boundary] requestId=surface-progress reason=boundary-shell-syntax-with-bun parentWouldApprove=true approvalEnforced=false childRejection=would-have-been-approved observedRawShellMetacharacters=unknown\n');
    } finally {
      off();
      if (!wasEnabled) debug.disable();
    }
  });
});
