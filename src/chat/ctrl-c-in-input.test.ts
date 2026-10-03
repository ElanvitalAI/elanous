import { describe, expect, test, spyOn } from 'bun:test';
import { resolveCtrlCInInput } from './ctrl-c-in-input.js';
import { textInput } from './index.js';
import { debug } from '../debug/log.js';
import type { Key } from '../tui.js';

const ctrlC: Key = { name: 'c', ctrl: true, shift: false };
const enter: Key = { name: 'enter', ctrl: false, shift: false };

async function drive(keys: Key[], initialText = '', dispatchGlobalAction?: () => void) {
  const output: string[] = [];
  const originalWrite = process.stdout.write;
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  let idx = 0;
  try {
    const result = await textInput({
      row: 3, col: 1, width: 80, initialText,
      ...(dispatchGlobalAction ? { host: { dispatchGlobalAction } } : {}),
      readKey: async () => {
        const key = keys[idx++];
        if (!key) throw new Error('unexpected additional key read');
        return key;
      },
    });
    return { result, output: output.join(''), calls: log.mock.calls.map((args) => args) };
  } finally {
    log.mockRestore();
    process.stdout.write = originalWrite;
  }
}

describe('resolveCtrlCInInput', () => {
  test('clears any nonempty input and disarms even when armed (never exits with text)', () => {
    expect(resolveCtrlCInInput({ text: 'draft', now: 110, armedAt: 100 }))
      .toEqual({ action: 'clear-input', armedAt: null, hint: null });
    expect(resolveCtrlCInInput({ text: '\n', now: 110, armedAt: 100 }).action).toBe('clear-input');
  });

  test('arms an empty input with the exit hint', () => {
    expect(resolveCtrlCInInput({ text: '', now: 100, armedAt: null }))
      .toEqual({ action: 'arm-exit', armedAt: 100, hint: '한 번 더 누르면 나갑니다 · /quit' });
  });

  test('exits within two seconds, then re-arms after the window', () => {
    expect(resolveCtrlCInInput({ text: '', now: 2100, armedAt: 100 }))
      .toEqual({ action: 'exit', armedAt: null, hint: null });
    expect(resolveCtrlCInInput({ text: '', now: 2101, armedAt: 100 }))
      .toEqual({ action: 'arm-exit', armedAt: 2101, hint: '한 번 더 누르면 나갑니다 · /quit' });
  });
});

describe('textInput Ctrl+C wiring', () => {
  test('clears multiline input, resets cursor and submits only a later typed key', async () => {
    const { result, output, calls } = await drive([ctrlC, { name: 'x', ctrl: false, shift: false }, enter], 'secret\nsecond');
    expect(result).toEqual({ text: 'x', submitted: true });
    expect(output).toContain('❯');
    expect(calls.filter(([category, event]) => category === 'chat.input' && event === 'ctrl-c'))
      .toEqual([['chat.input', 'ctrl-c', { action: 'clear-input', length: 13 }]]);
    expect(calls.flat().join(' ')).not.toContain('secret');
  });

  test('arms with a visible status-row hint and routes the next Ctrl+C through /quit submission', async () => {
    let globalDispatches = 0;
    const { result, output, calls } = await drive([ctrlC, { ...ctrlC, name: 'ㅊ' }], '', () => { globalDispatches++; });
    expect(globalDispatches).toBe(0);
    expect(result).toEqual({ text: '/quit', submitted: true });
    expect(output).toContain('\x1b[5;1H\x1b[2K');
    expect(output).toContain('한 번 더 누르면 나갑니다 · /quit');
    expect(calls.filter(([category, event]) => category === 'chat.input' && event === 'ctrl-c'))
      .toEqual([
        ['chat.input', 'ctrl-c', { action: 'arm-exit', length: 0 }],
        ['chat.input', 'ctrl-c', { action: 'exit', length: 0 }],
      ]);
  });

  test('another key cancels the exit arm', async () => {
    const { result, calls } = await drive([ctrlC, { name: 'left', ctrl: false, shift: false }, ctrlC, enter]);
    expect(result).toEqual({ text: '', submitted: true });
    expect(calls.filter(([category, event]) => category === 'chat.input' && event === 'ctrl-c')
      .map(([, , data]) => data)).toEqual([
        { action: 'arm-exit', length: 0 }, { action: 'arm-exit', length: 0 },
      ]);
  });
});
