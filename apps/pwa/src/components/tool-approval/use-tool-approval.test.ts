import { afterAll, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { AcpConnection, AcpRequestHandler, AcpStateHandler } from '@/lib/daemon-client';
import * as dialogModule from '@/components/ui/dialog';
import * as buttonModule from '@/components/ui/button';
import { useToolApproval, type ToolApprovalRequest } from './use-tool-approval';
import { ToolApprovalSheet } from './ToolApprovalSheet';
const originalDialog = { ...dialogModule };
const originalButton = { ...buttonModule };
afterAll(() => {
  mock.module('@/components/ui/dialog', () => originalDialog);
  mock.module('@/components/ui/button', () => originalButton);
});

mock.module('@/components/ui/dialog', () => Object.fromEntries(
  ['Dialog', 'DialogContent', 'DialogDescription', 'DialogFooter', 'DialogHeader', 'DialogTitle'].map(
    (key) => [key, (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement(key, props, props.children)],
  ),
));
mock.module('@/components/ui/button', () => ({ Button: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('button', props, props.children) }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Hook = ReturnType<typeof useToolApproval>;
const options = [
  { kind: 'allow_once', optionId: 'a-1' },
  { kind: 'allow_always', optionId: 'a-all' },
  { kind: 'reject_once', optionId: 'r-1' },
];
const request = (tool = 'Write', sessionId = 's1') => ({
  sessionId, toolCall: { toolCallId: 'call-1', title: tool, rawInput: { file_path: '/private/secret' } }, options,
});

function mount(sessionId: string | null = 's1') {
  let handler: AcpRequestHandler | undefined;
  let stateHandler: AcpStateHandler | undefined;
  const acp = {
    onRequest: (method: string, callback: AcpRequestHandler) => {
      expect(method).toBe('session/request_permission');
      handler = callback;
      return () => { handler = undefined; };
    },
    onState: (callback: AcpStateHandler) => { stateHandler = callback; return () => { stateHandler = undefined; }; },
  } as AcpConnection;
  let latest!: Hook;
  const Host = ({ sid }: { sid: string | null }) => {
    latest = useToolApproval({ acp, sessionId: sid });
    return null;
  };
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(React.createElement(Host, { sid: sessionId })); });
  return {
    get hook() { return latest; },
    receive: (raw: unknown) => { if (!handler) throw new Error('handler missing'); return handler(raw); },
    changeSession: (sid: string | null) => act(() => renderer.update(React.createElement(Host, { sid }))),
    close: () => act(() => stateHandler?.('CLOSED')),
    unmount: () => act(() => renderer.unmount()),
  };
}

test('sheet presents tool, 80-character argument summary, collapsed details, time and three choices', () => {
  let renderer!: ReactTestRenderer;
  const rawInput = { command: 'x'.repeat(90) };
  const req: ToolApprovalRequest = { ...request('Bash'), toolCall: { ...request().toolCall, title: 'Bash', rawInput }, options: [
    { kind: 'allow_once', optionId: 'a-1' }, { kind: 'allow_always', optionId: 'a-all' }, { kind: 'reject_once', optionId: 'r-1' },
  ] };
  const chosen: string[] = [];
  act(() => { renderer = create(React.createElement(ToolApprovalSheet, {
    request: req, receivedAt: Date.now(), onChoose: (displayed: ToolApprovalRequest, choice: string) => { expect(displayed).toBe(req); chosen.push(choice); }, onCancel: (displayed: ToolApprovalRequest) => { expect(displayed).toBe(req); chosen.push('cancelled'); },
  })); });
  const dialog = renderer.root.findByType('Dialog' as never);
  expect(dialog.props.open).toBe(true);
  const summary = renderer.root.findAllByType('p').find((node) => node.props.title);
  expect(summary?.props.children).toBe('x'.repeat(80));
  expect(renderer.root.findByType('details').props.children[0].props.children).toBe('자세히');
  expect(renderer.root.findByType('pre').props.children).toContain('x'.repeat(90));
  expect(renderer.root.findAllByType('p').some(node => String(node.props.children).includes('남은 시간:'))).toBe(true);
  expect(renderer.root.findAllByType('button').map(node => node.props.children)).toEqual(['이번만 허용', '이 도구는 항상 허용', '거절']);
  for (const button of renderer.root.findAllByType('button')) button.props.onClick();
  expect(chosen).toEqual(['allow_once', 'allow_always', 'reject_once']);
  dialog.props.onOpenChange(false);
  expect(chosen.at(-1)).toBe('cancelled');
  act(() => renderer.unmount());
});

test('request opens sheet; each button returns its actual optionId', async () => {
  const ui = mount();
  for (const [choice, id] of [['allow_once', 'a-1'], ['allow_always', 'a-all'], ['reject_once', 'r-1']] as const) {
    let answer!: Promise<unknown>;
    act(() => { answer = Promise.resolve(ui.receive(request())); });
    expect(ui.hook.pendingRequest?.toolCall.title).toBe('Write');
    act(() => ui.hook.choose(ui.hook.pendingRequest!, choice));
    expect(await answer).toEqual({ outcome: { outcome: 'selected', optionId: id } });
    expect(ui.hook.pendingRequest).toBeNull();
  }
  ui.unmount();
});

test('close, session change, transport close and unmount cancel pending work', async () => {
  for (const end of ['cancel', 'change', 'close', 'unmount'] as const) {
    const ui = mount();
    let answer!: Promise<unknown>;
    act(() => { answer = Promise.resolve(ui.receive(request())); });
    if (end === 'cancel') act(() => ui.hook.cancel(ui.hook.pendingRequest!));
    if (end === 'change') ui.changeSession('s2');
    if (end === 'close') ui.close();
    if (end === 'unmount') ui.unmount();
    expect(await answer).toEqual({ outcome: { outcome: 'cancelled' } });
    if (end !== 'unmount') ui.unmount();
  }
});

test('approval expires after 60 seconds and a late click cannot change the cancellation', async () => {
  const ui = mount();
  const originalSetTimeout = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  let delay: number | undefined;
  globalThis.setTimeout = ((callback: () => void, ms: number) => {
    expire = callback;
    delay = ms;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    let answer!: Promise<unknown>;
    act(() => { answer = Promise.resolve(ui.receive(request())); });
    expect(delay).toBe(60_000);
    expect(ui.hook.pendingRequest?.toolCall.title).toBe('Write');
    const displayed = ui.hook.pendingRequest!;
    act(() => expire?.());
    act(() => ui.hook.choose(displayed, 'allow_once'));
    expect(await answer).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(ui.hook.pendingRequest).toBeNull();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    ui.unmount();
  }
});

test('approval telemetry never includes tool arguments', async () => {
  const entries: string[] = [];
  const original = console.debug;
  console.debug = (...args: unknown[]) => { entries.push(JSON.stringify(args)); };
  try {
    const ui = mount();
    let answer!: Promise<unknown>;
    const secret = 'SECRET_TITLE_ARGUMENT_7F92';
    act(() => { answer = Promise.resolve(ui.receive(request(`Write ${secret}`))); });
    act(() => ui.hook.choose(ui.hook.pendingRequest!, 'allow_always'));
    await answer;
    act(() => { answer = Promise.resolve(ui.receive(request(`Write ${secret}`))); });
    act(() => ui.hook.cancel(ui.hook.pendingRequest!));
    await answer;
    await ui.receive(null);
    ui.unmount();
    expect(entries.join(' ')).not.toContain('/private/secret');
    expect(entries.join(' ')).not.toContain(secret);
    expect(entries.join(' ')).toContain('"tool":"unverified"');
    expect(entries.join(' ')).toContain('pwa.tool-approval.requested');
    expect(entries.join(' ')).toContain('pwa.tool-approval.decided');
    expect(entries.join(' ')).not.toContain('pwa.tool-approval.remembered');
    expect(entries.join(' ')).toContain('pwa.tool-approval.cancelled');
  } finally {
    console.debug = original;
  }
});

test('replacement request cancels the previous request', async () => {
  const ui = mount();
  let previous!: Promise<unknown>;
  act(() => { previous = Promise.resolve(ui.receive(request())); });
  let next!: Promise<unknown>;
  act(() => { next = Promise.resolve(ui.receive(request('Bash'))); });
  expect(await previous).toEqual({ outcome: { outcome: 'cancelled' } });
  expect(ui.hook.pendingRequest?.toolCall.title).toBe('Bash');
  act(() => ui.hook.cancel(ui.hook.pendingRequest!));
  expect(await next).toEqual({ outcome: { outcome: 'cancelled' } });
  ui.unmount();
});

test('a stale sheet cannot decide or cancel a replacement even when the call id is reused', async () => {
  const ui = mount();
  let first!: Promise<unknown>;
  act(() => { first = Promise.resolve(ui.receive(request('Write'))); });
  const displayed = ui.hook.pendingRequest!;
  let second!: Promise<unknown>;
  act(() => { second = Promise.resolve(ui.receive({
    ...request('Bash'), options: options.map(o => ({ ...o, optionId: `new-${o.kind}` })),
  })); });
  expect(await first).toEqual({ outcome: { outcome: 'cancelled' } });
  const current = ui.hook.pendingRequest!;
  act(() => {
    ui.hook.choose(displayed, 'allow_always');
    ui.hook.cancel(displayed);
  });
  expect(ui.hook.pendingRequest).toBe(current);
  act(() => ui.hook.choose(current, 'reject_once'));
  expect(await second).toEqual({ outcome: { outcome: 'selected', optionId: 'new-reject_once' } });
  ui.unmount();
});

test('an expired replacement timer cannot cancel the current request', async () => {
  const ui = mount();
  const originalSetTimeout = globalThis.setTimeout;
  const callbacks: Array<() => void> = [];
  globalThis.setTimeout = ((callback: () => void) => {
    callbacks.push(callback);
    return callbacks.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    let first!: Promise<unknown>;
    act(() => { first = Promise.resolve(ui.receive(request('Write'))); });
    let second!: Promise<unknown>;
    act(() => { second = Promise.resolve(ui.receive(request('Bash'))); });
    expect(await first).toEqual({ outcome: { outcome: 'cancelled' } });
    act(() => callbacks[0]?.());
    expect(ui.hook.pendingRequest?.toolCall.title).toBe('Bash');
    act(() => callbacks[1]?.());
    expect(await second).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(ui.hook.pendingRequest).toBeNull();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    ui.unmount();
  }
});

test('malformed or wrong-session request cancels without opening sheet', async () => {
  const ui = mount();
  const throwingShape = Object.defineProperty({}, 'toolCall', { get() { throw new Error('invalid shape'); } });
  for (const raw of [
    null, {}, throwingShape, { ...request(), options: [] },
    { ...request(), options: [...options, { optionId: 'bad', kind: 'unknown' }] },
    { ...request(), options: [options[0], { kind: 'allow_always', optionId: 'a-1' }, options[2]] },
    { ...request(), options: [options[0], options[1], { kind: 'reject_once', optionId: 'a-all' }] },
    { ...request(), toolCall: { title: 'Write' } }, request('Write', 'other'),
  ]) {
    expect(await ui.receive(raw)).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(ui.hook.pendingRequest).toBeNull();
  }
  ui.unmount();
});

test('allow_always selects its option but a matching display title cannot authorize a later call', async () => {
  const ui = mount();
  let first!: Promise<unknown>;
  act(() => { first = Promise.resolve(ui.receive(request('Write'))); });
  act(() => ui.hook.choose(ui.hook.pendingRequest!, 'allow_always'));
  expect(await first).toEqual({ outcome: { outcome: 'selected', optionId: 'a-all' } });
  let second!: Promise<unknown>;
  act(() => { second = Promise.resolve(ui.receive({
    ...request('Write'),
    toolCall: { ...request('Write').toolCall, toolCallId: 'call-2', rawInput: { file_path: '/tmp/other' } },
    options: options.map(o => ({ ...o, optionId: `fresh-${o.kind}` })),
  })); });
  expect(ui.hook.pendingRequest?.toolCall.title).toBe('Write');
  expect(ui.hook.pendingRequest?.toolCall.rawInput).toEqual({ file_path: '/tmp/other' });
  act(() => ui.hook.cancel(ui.hook.pendingRequest!));
  expect(await second).toEqual({ outcome: { outcome: 'cancelled' } });
  let other!: Promise<unknown>;
  act(() => { other = Promise.resolve(ui.receive(request('Bash'))); });
  expect(ui.hook.pendingRequest?.toolCall.title).toBe('Bash');
  act(() => ui.hook.cancel(ui.hook.pendingRequest!));
  expect(await other).toEqual({ outcome: { outcome: 'cancelled' } });
  ui.unmount();
});
