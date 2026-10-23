import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';

import { textInput } from '../src/chat/index.js';
import {
  closeTui,
  initTui,
  KeyStreamParser,
  setKeyTracer,
  type Key,
} from '../src/tui.js';

const START = '\x1b[200~';
const END = '\x1b[201~';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForStdinReader(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (process.stdin.listenerCount('data') > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('readKey did not attach a stdin data listener');
}

describe('textInput bracketed paste integration', () => {
  test('TUI-PASTE-ECHO: 긴 붙여넣기는 자리표시로 보이고 실제 제출 경로가 원문 바이트(CRLF·끝 줄바꿈·앞 공백) 그대로 낸다', async () => {
    const raw = '  first\r\nsecond\r\nthird\r\nfourth\n';
    const nextKey = deferred<Key>();
    let reads = 0;
    const lines: number[] = [];
    const input = textInput({
      row: 2,
      col: 1,
      width: 80,
      maxLines: 4,
      readKey: async () => {
        reads++;
        return reads === 1 ? ({ name: 'paste', ctrl: false, shift: false, paste: raw } as Key) : nextKey.promise;
      },
      onLinesChange: (count) => lines.push(count),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lines.every((n) => n === 1)).toBe(true); // 자리표시 한 줄 — 입력칸이 4줄로 펼쳐지지 않는다
    nextKey.resolve({ name: 'enter', ctrl: false, shift: false });
    await expect(input).resolves.toEqual({ text: raw, submitted: true });
  });

  test('keeps multiline paste in the input until one explicit Enter submits it', async () => {
    const parser = new KeyStreamParser();
    const [paste] = parser.push(`${START}L1\nL2${END}`);
    const nextKey = deferred<Key>();
    const visibleLineCounts: number[] = [];
    let reads = 0;

    const input = textInput({
      row: 2,
      col: 1,
      width: 80,
      maxLines: 4,
      readKey: async () => {
        reads++;
        return reads === 1 ? paste! : nextKey.promise;
      },
      onLinesChange: (count) => visibleLineCounts.push(count),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toBe(2);
    expect(visibleLineCounts).toContain(2);

    nextKey.resolve({ name: 'enter', ctrl: false, shift: false });
    await expect(input).resolves.toEqual({ text: 'L1\nL2', submitted: true });
  });

  test('paints both lines after the host reserves and redraws the expanded input area', async () => {
    const parser = new KeyStreamParser();
    const [paste] = parser.push(`${START}VISIBLE_L1\nVISIBLE_L2${END}`);
    const nextKey = deferred<Key>();
    const writes: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    let reads = 0;

    (process.stdout.write as unknown as (chunk: string | Uint8Array) => boolean) = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const input = textInput({
        row: 3,
        col: 1,
        width: 80,
        maxLines: 4,
        readKey: async () => {
          reads++;
          return reads === 1 ? paste! : nextKey.promise;
        },
        onLinesChange: (count) => {
          if (count === 2) writes.push('HOST_REDRAW');
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      const output = writes.join('');
      expect(output.indexOf('HOST_REDRAW')).toBeLessThan(output.lastIndexOf('VISIBLE_L1'));
      expect(output.indexOf('HOST_REDRAW')).toBeLessThan(output.lastIndexOf('VISIBLE_L2'));

      nextKey.resolve({ name: 'enter', ctrl: false, shift: false });
      await expect(input).resolves.toEqual({ text: 'VISIBLE_L1\nVISIBLE_L2', submitted: true });
    } finally {
      (process.stdout.write as typeof process.stdout.write) = originalWrite;
    }
  });

  test('keeps a chunk-split single-line paste in the input until Enter', async () => {
    const parser = new KeyStreamParser();
    expect(parser.push(`${START}A`)).toEqual([]);
    const [paste] = parser.push(`BC${END}`);
    const nextKey = deferred<Key>();
    let reads = 0;

    const input = textInput({
      row: 1,
      col: 1,
      width: 80,
      readKey: async () => {
        reads++;
        return reads === 1 ? paste! : nextKey.promise;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toBe(2);

    nextKey.resolve({ name: 'enter', ctrl: false, shift: false });
    await expect(input).resolves.toEqual({ text: 'ABC', submitted: true });
  });

  test('assembles split Buffer chunks through readKey and traces no Enter before submit', async () => {
    const stream = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
    const originalStdin = process.stdin;
    const originalWrite = process.stdout.write.bind(process.stdout);
    const writes: string[] = [];
    const traced: Key[] = [];
    const visibleLineCounts: number[] = [];
    let settled = false;

    Object.defineProperty(process, 'stdin', { configurable: true, value: stream });
    stream.isTTY = true;
    stream.setRawMode = () => stream;
    (process.stdout.write as unknown as (chunk: string | Uint8Array) => boolean) = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      initTui(false);
      setKeyTracer((key, source) => {
        if (source === 'input') traced.push(key);
      });

      const input = textInput({
        row: 2,
        col: 1,
        width: 80,
        maxLines: 4,
        onLinesChange: (count) => visibleLineCounts.push(count),
      });
      void input.then(() => { settled = true; });

      const utf8 = Buffer.from('한');
      const chunks = [
        Buffer.from('\x1b[20'),
        Buffer.concat([Buffer.from('0~L1\n'), utf8.subarray(0, 1)]),
        Buffer.concat([utf8.subarray(1), Buffer.from('글L2\x1b[20')]),
        Buffer.from('1~'),
      ];
      for (const chunk of chunks) {
        await waitForStdinReader();
        stream.write(chunk);
      }

      await waitForStdinReader();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(visibleLineCounts).toContain(2);
      expect(writes.join('')).toContain('L1');
      expect(writes.join('')).toContain('한글L2');
      expect(traced).toEqual([{
        name: 'paste',
        ctrl: false,
        shift: false,
        raw: `${START}L1\n한글L2${END}`,
        paste: 'L1\n한글L2',
      }]);
      expect(traced.filter((key) => key.name === 'enter')).toHaveLength(0);

      stream.write(Buffer.from('\r'));
      await expect(input).resolves.toEqual({ text: 'L1\n한글L2', submitted: true });
      expect(traced.map((key) => key.name)).toEqual(['paste', 'enter']);
    } finally {
      setKeyTracer(null);
      closeTui();
      (process.stdout.write as typeof process.stdout.write) = originalWrite;
      Object.defineProperty(process, 'stdin', { configurable: true, value: originalStdin });
      stream.destroy();
    }
  });
});
