import { createRequire } from 'node:module';
import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import * as daemonProvider from '@/components/providers/DaemonProvider';
import { createReactHookHarness } from '@/lib/testing/react-hook-harness';
import { registerTerminalHistoryView, registerTerminalInput, takeStickyModifiers, setStickyModifiers, type TerminalHistoryView } from './terminal-input-registry';
import { ModifierBar } from './ModifierBar';

const harness = createReactHookHarness(createRequire(import.meta.url)('react'));
const daemon = spyOn(daemonProvider, 'useDaemon');
daemon.mockReturnValue({
  sessionId: 'session-test',
  client: { connectAcp: () => { throw new Error('ModifierBar must not open ACP'); } },
} as unknown as ReturnType<typeof daemonProvider.useDaemon>);

function press(testId: string): void {
  const button = harness.find((element) => element.props['data-testid'] === testId);
  harness.act(() => (button.props.onClick as () => void)());
}

afterEach(() => {
  harness.unmount();
});
afterAll(() => {
  daemon.mockRestore();
});

test('modifier keys route the built sequence through the registered terminal and release after one press', () => {
  const received: string[] = [];
  const unregister = registerTerminalInput('modbar-a', (data) => received.push(data));
  try {
    harness.render(() => ModifierBar({ terminalId: 'modbar-a' }));
    press('modbar-ctrl');
    press('modbar-alt');
    press('modbar-right');
    expect(received).toEqual(['\x1b[1;7C']);
    press('modbar-right');
    expect(received).toEqual(['\x1b[1;7C', '\x1b[C']);
  } finally {
    unregister();
  }
});

test('Ctrl/Alt presses arm only this terminal and consumption resets visible toggles', () => {
  harness.render(() => ModifierBar({ terminalId: 'modbar-sticky' }));
  try {
    press('modbar-ctrl');
    press('modbar-alt');
    expect(takeStickyModifiers('modbar-other')).toBeNull();
    expect(takeStickyModifiers('modbar-sticky')).toEqual({ ctrl: true, alt: true });
    expect(harness.find((element) => element.props['data-testid'] === 'modbar-ctrl').props['aria-pressed']).toBe(false);
    expect(harness.find((element) => element.props['data-testid'] === 'modbar-alt').props['aria-pressed']).toBe(false);
  } finally {
    setStickyModifiers('modbar-sticky', { ctrl: false, alt: false });
  }
});

test('Shift+Enter button sends ESC CR (newline) through the registered terminal', () => {
  const received: string[] = [];
  const unregister = registerTerminalInput('modbar-shift-enter', (data) => received.push(data));
  try {
    harness.render(() => ModifierBar({ terminalId: 'modbar-shift-enter' }));
    press('modbar-shift-enter');
    expect(received).toEqual(['\x1b\r']);
  } finally {
    unregister();
  }
});

test('390px: the key row stays on one line and scrolls horizontally instead of overflowing the page', () => {
  harness.render(() => ModifierBar({ terminalId: 'modbar-narrow' }));
  const bar = harness.find((element) => element.props['data-testid'] === 'modifier-bar');
  const classes = String(bar.props.className).split(/\s+/);
  expect(classes).toContain('flex-nowrap');
  expect(classes).toContain('overflow-x-auto');
  expect(classes).toContain('max-w-full');
  expect(classes).not.toContain('flex-wrap');
  // Buttons must not shrink under nowrap, otherwise they squash instead of scrolling.
  for (const id of ['modbar-esc', 'modbar-shift-enter', 'modbar-left', 'modbar-ctrl']) {
    const btn = harness.find((element) => element.props['data-testid'] === id);
    expect(String(btn.props.className).split(/\s+/)).toContain('shrink-0');
  }
});

test('history button is disabled without a registered xterm and carries its accessible name', () => {
  harness.render(() => ModifierBar({ terminalId: 'modbar-absent' }));
  const button = harness.find((element) => element.props['data-testid'] === 'modbar-history');
  expect(button.props.disabled).toBe(true);
  expect(button.props['aria-label']).toBe('과거 내용 보기');
  expect(harness.textOf(button)).toBe('⇡ 기록');
});

test('history button reads the current buffer on every tap and routes to xterm or its input sender', () => {
  const received: string[] = [];
  const pages: number[] = [];
  let bufferType: 'normal' | 'alternate' = 'normal';
  const view = {
    buffer: { get active() { return { type: bufferType }; } },
    modes: { mouseTrackingMode: 'none' },
    scrollPages: (count: number) => { pages.push(count); },
  } as unknown as TerminalHistoryView;
  const unregisterInput = registerTerminalInput('modbar-history', (data) => received.push(data));
  try {
    harness.render(() => ModifierBar({ terminalId: 'modbar-history' }));
    expect(harness.find((element) => element.props['data-testid'] === 'modbar-history').props.disabled).toBe(true);
    const unregisterView = registerTerminalHistoryView('modbar-history', view);
    try {
      expect(harness.find((element) => element.props['data-testid'] === 'modbar-history').props.disabled).toBe(false);
      press('modbar-history');
      bufferType = 'alternate';
      press('modbar-history');
      expect(pages).toEqual([-1]);
      expect(received).toEqual(['\x02[\x1b[5~']);
    } finally {
      unregisterView();
    }
    expect(harness.find((element) => element.props['data-testid'] === 'modbar-history').props.disabled).toBe(true);
  } finally {
    unregisterInput();
  }
});

test('buttons send to their own terminal without opening an ACP connection', () => {
  const received: string[] = [];
  const unregister = registerTerminalInput('modbar-b', (data) => received.push(data));
  try {
    harness.render(() => ModifierBar({ terminalId: 'modbar-b' }));
    press('modbar-tab');
    expect(received).toEqual(['\x09']);
  } finally {
    unregister();
  }
});
