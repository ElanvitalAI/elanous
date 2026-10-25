import { describe, expect, test } from 'bun:test';
import { handleNextTuiTermSlash, type NextTuiTermSlashContext } from './term-next.js';

describe('Next TUI terminal slash', () => {
  test('keeps Next terminal views read-only and labels unknown session facts honestly', async () => {
    const chatLines: string[] = [];
    const scrollOffsets: number[] = [];
    let listCalls = 0;
    const context: NextTuiTermSlashContext = {
      chatLines,
      setChatScrollOffset: (value) => scrollOffsets.push(value),
      sessions: {
        list: () => {
          listCalls += 1;
          return [
            { id: 'pty_12345678', title: 'shell-a', kind: 'shell', status: 'running' },
            { id: 'pty_87654321', title: 'shell-b', kind: 'shell', status: 'exited' },
          ];
        },
      },
    };
    const term = handleNextTuiTermSlash;
    await term([], context);
    expect(chatLines.join('\n')).toContain('/term list');
    await term(['list'], context);
    expect(chatLines.join('\n')).toContain('shell-a');
    expect(chatLines.join('\n')).toContain('shell-b');
    expect(chatLines.join('\n')).toContain('shell-a · cwd=unknown · exitCode=not-exited');
    expect(chatLines.join('\n')).toContain('shell-b · cwd=unknown · exitCode=unknown');
    await term(['matrix'], context);
    expect(chatLines.some((line) => line.includes('pty_87654321') && line.includes('exited'))).toBe(true);
    await term(['status'], context);
    expect(chatLines.join('\n')).toContain('1 live · 1 exited');
    await term(['spawn'], context);
    await term(['kill', 'pty_12345678'], context);
    expect(chatLines.join('\n')).toContain('Unsupported /term command in Next TUI: spawn');
    expect(chatLines.join('\n')).toContain('Unsupported /term command in Next TUI: kill');
    expect(listCalls).toBe(3);
    expect(scrollOffsets).toEqual([-1, -1, -1, -1, -1, -1]);
  });
});
