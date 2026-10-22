import { expect, spyOn, test } from 'bun:test';
import { createNextTuiBackgroundBridge } from './index.js';

test('an unregistered Agent promise remains visible across later turns', () => {
  const previous = process.env.ELANOUS_NEXT_TUI_BG_STATUS;
  process.env.ELANOUS_NEXT_TUI_BG_STATUS = '1';
  const frames: Array<{ promised: boolean; running: number }> = [];
  const write = spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    const line = String(chunk);
    if (line.startsWith('ELANOUS_TUI_BG_STATUS\t')) frames.push(JSON.parse(line.slice('ELANOUS_TUI_BG_STATUS\t'.length)));
    return true;
  });
  const bridge = createNextTuiBackgroundBridge('promise-session', () => 0);
  try {
    expect(bridge).not.toBeNull();
    bridge!.observeToolResult('Agent', { run_in_background: true }, { taskId: 'missing-registration', background: true });
    expect(frames.at(-1)?.promised).toBe(true);
    bridge!.beginTurn();
    bridge!.emit();
    expect(frames.at(-1)?.promised).toBe(true);
    bridge!.beginTurn();
    expect(frames.at(-1)?.promised).toBe(true);
    expect(frames.at(-1)?.running).toBe(0);
  } finally {
    bridge?.dispose();
    write.mockRestore();
    // Keep the test independent of the developer's optional TUI bridge setting.
    if (previous === undefined) delete process.env.ELANOUS_NEXT_TUI_BG_STATUS;
    else process.env.ELANOUS_NEXT_TUI_BG_STATUS = previous;
  }
});
