import { createRequire } from 'node:module';
import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import * as daemonProvider from '@/components/providers/DaemonProvider';
import { createReactHookHarness } from '@/lib/testing/react-hook-harness';
import { registerTerminalInput } from './terminal-input-registry';
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
