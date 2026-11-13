import { expect, test } from 'bun:test';
import {
  createShellApprovalSession,
  type NextTuiShellApprovalSession,
  type NextTuiShellApprovalPorts,
} from './shell-approval-session.js';
import type { Key } from '../tui.js';

interface Harness {
  readonly session: NextTuiShellApprovalSession;
  readonly statuses: string[];
  readonly renders: number[];
  readonly viewportCalls: number[];
}

const createHarness = (ports: Partial<NextTuiShellApprovalPorts> = {}): Harness => {
  const statuses: string[] = [];
  const renders: number[] = [];
  const viewportCalls: number[] = [];
  const session = createShellApprovalSession({
    setStatus: (status) => statuses.push(status),
    render: () => renders.push(statuses.length),
    viewport: () => { viewportCalls.push(1); return { columns: 80, rows: 6, sidetabWidth: 0 }; },
    ...ports,
  });
  return { session, statuses, renders, viewportCalls };
};

const key = (name: string): Key => ({ name, ctrl: false, shift: false } as Key);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('shell-approval session publishes request status per kind and settles y/n with per-kind decision status', async () => {
  for (const kind of ['bash', 'graph'] as const) {
    const { session, statuses, renders } = createHarness();
    const decision = session.begin(`echo ${kind}`, `call-${kind}`, kind);
    expect(statuses.at(-1)).toBe(kind === 'graph' ? '플러그인 그래프 승인 필요 · 기본 N' : 'Bash 실행 승인 필요 · 기본 N');
    expect(renders.length).toBe(1);
    expect(session.handleKey(key('y'))).toBe(true);
    await expect(decision).resolves.toBe(true);
    expect(statuses.at(-1)).toBe(kind === 'graph' ? '플러그인 그래프 승인됨' : 'Bash 명령 승인됨');
    expect(session.active()).toBe(null);
  }
  const { session, statuses } = createHarness();
  const denied = session.begin('rm -rf x', 'call-deny', 'bash');
  session.handleKey(key('n'));
  await expect(denied).resolves.toBe(false);
  expect(statuses.at(-1)).toBe('Bash 명령 거부됨');
});

test('a second request while a prompt is active resolves false immediately and keeps the first prompt', async () => {
  const { session, statuses } = createHarness();
  const first = session.begin('first', 'call-1', 'bash');
  const second = session.begin('second', 'call-2', 'bash');
  await expect(second).resolves.toBe(false);
  expect(session.active()?.command).toBe('first');
  expect(statuses.filter((status) => status.includes('필요')).length).toBe(1);
  session.handleKey(key('escape'));
  await expect(first).resolves.toBe(false);
});

test('request timeout resolves false, publishes the timeout status, and does not double-resolve', async () => {
  // Source: .rules/reviews/res%2Fentry-ts-hotspot-seam-1113.md — bounded wait mirrors the production deadline clamp.
  const { session, statuses, renders } = createHarness({ timeoutMs: 5 });
  const decision = session.begin('slow', 'call-timeout', 'bash');
  await expect(decision).resolves.toBe(false);
  expect(statuses.at(-1)).toBe('Bash 승인 시간 초과 · 거부됨');
  const rendersAtTimeout = renders.length;
  await sleep(20);
  expect(renders.length).toBe(rendersAtTimeout);
  expect(statuses.filter((status) => status === 'Bash 승인 시간 초과 · 거부됨').length).toBe(1);
});

test('cancel resolves the active prompt false with per-reason status and stays fail-closed for the resolved call', async () => {
  const { session, statuses, renders } = createHarness();
  const decision = session.begin('hosted', 'call-cancel', 'bash');
  session.cancel('call-cancel', 'host-cancelled');
  await expect(decision).resolves.toBe(false);
  expect(statuses.at(-1)).toBe('Bash 승인 취소됨 · 거부됨');
  const rendersAfterCancel = renders.length;
  // The child may time out while the host processes a delayed reply: the same
  // callId must republish the fail-closed status without a live prompt.
  session.cancel('call-cancel', 'timeout');
  expect(statuses.at(-1)).toBe('Bash 승인 시간 초과 · 거부됨');
  expect(renders.length).toBe(rendersAfterCancel + 1);
  // Cancelling an unrelated call is a no-op.
  session.cancel('call-unknown', 'host-cancelled');
  expect(statuses.at(-1)).toBe('Bash 승인 시간 초과 · 거부됨');
});

test('handleKey returns false while inactive, keeps pending keys, and clamps prompt scrolling to the viewport', () => {
  const { session, viewportCalls } = createHarness();
  expect(session.handleKey(key('y'))).toBe(false);
  expect(viewportCalls.length).toBe(0);
  const command = Array.from({ length: 40 }, (_, index) => `line-${index}`).join('\n');
  void session.begin(command, 'call-scroll', 'bash');
  // Unmapped key: consumed as pending, no viewport math, prompt survives.
  expect(session.handleKey(key('x'))).toBe(true);
  expect(session.active()?.scroll).toBe(0);
  expect(viewportCalls.length).toBe(0);
  // rows=6 → pageSize=min(8, 0)… clamp floor is 1; viewport() reports the same
  // metrics entry would, so scroll tracks viewport.scroll exactly.
  for (let step = 0; step < 60; step += 1) session.handleKey(key('down'));
  const maxScroll = session.active()!.scroll;
  // Source: .rules/reviews/res%2Fentry-ts-hotspot-seam-1113.md — clamped range, not a new product bound.
  expect(maxScroll).toBeGreaterThan(0);
  session.handleKey(key('down'));
  expect(session.active()!.scroll).toBe(maxScroll);
  session.handleKey(key('up'));
  expect(session.active()!.scroll).toBe(maxScroll - 1);
  session.handleKey(key('up'));
  expect(session.active()!.scroll).toBe(maxScroll - 2);
  expect(viewportCalls.length).toBe(63);
  // Enter still denies after scrolling.
  session.handleKey(key('enter'));
  expect(session.active()).toBe(null);
});

test('dispose fail-closes a surviving prompt and clears its timer', async () => {
  // Source: .rules/reviews/res%2Fentry-ts-hotspot-seam-1113.md — bounded wait mirrors the production deadline clamp.
  const { session, statuses, renders } = createHarness({ timeoutMs: 5 });
  const decision = session.begin('dying', 'call-dispose', 'bash');
  session.dispose();
  await expect(decision).resolves.toBe(false);
  expect(session.active()).toBe(null);
  expect(statuses.at(-1)).toBe('Bash 실행 승인 필요 · 기본 N');
  const rendersAtDispose = renders.length;
  await sleep(20);
  expect(renders.length).toBe(rendersAtDispose);
});
