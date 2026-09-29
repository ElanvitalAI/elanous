import { describe, expect, test } from 'bun:test';
import { parseTerminalSse } from './terminal-stream';

describe('terminal stream SSE parser', () => {
  test('named events, byte chunks with escapes and newlines, heartbeat ignored, partial tail kept', () => {
    const raw = 'event: mode\ndata: {"mode":"bytes"}\n\n: hb\n\nevent: reset\ndata: {"screen":"$ "}\n\nevent: data\ndata: "ls\\r\\n\\u001b[1mA\\u001b[0m"\n\nevent: end\ndata: {"reason":"exit"}\n\nevent: data\ndata: "par';
    const { events, rest } = parseTerminalSse(raw);
    expect(events).toEqual([
      { type: 'mode', mode: 'bytes' },
      { type: 'reset', screen: '$ ' },
      { type: 'data', chunk: 'ls\r\n\x1b[1mA\x1b[0m' },
      { type: 'end', reason: 'exit' },
    ]);
    expect(rest).toBe('event: data\ndata: "par');
    expect(parseTerminalSse(`${rest}tial"\n\n`).events).toEqual([{ type: 'data', chunk: 'partial' }]);
  });
});
