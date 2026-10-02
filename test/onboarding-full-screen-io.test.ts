import { describe, expect, test } from 'bun:test';
import {
  parseMiniKey,
  normalizeKeyForMatch,
  fullScreenIO,
} from '../src/onboarding/full-screen-io.js';
import type { ChoiceOption } from '../src/onboarding/io-extended.js';

describe('parseMiniKey · control characters', () => {
  test('Ctrl-C is recognized', () => {
    const k = parseMiniKey('\x03');
    expect(k.name).toBe('c');
    expect(k.ctrl).toBe(true);
  });

  test('Enter is recognized for both \\r and \\n', () => {
    expect(parseMiniKey('\r').name).toBe('enter');
    expect(parseMiniKey('\n').name).toBe('enter');
  });

  test('Backspace is recognized for DEL and BS', () => {
    expect(parseMiniKey('\x7f').name).toBe('backspace');
    expect(parseMiniKey('\b').name).toBe('backspace');
  });

  test('Tab is recognized', () => {
    expect(parseMiniKey('\t').name).toBe('tab');
  });

  test('lone Esc is recognized', () => {
    expect(parseMiniKey('\x1b').name).toBe('esc');
  });
});

describe('parseMiniKey · arrow keys', () => {
  test('CSI sequences map to up/down/left/right', () => {
    expect(parseMiniKey('\x1b[A').name).toBe('up');
    expect(parseMiniKey('\x1b[B').name).toBe('down');
    expect(parseMiniKey('\x1b[C').name).toBe('right');
    expect(parseMiniKey('\x1b[D').name).toBe('left');
  });

  test('SS3 (ESC O) sequences also map to arrows', () => {
    expect(parseMiniKey('\x1bOA').name).toBe('up');
    expect(parseMiniKey('\x1bOB').name).toBe('down');
    expect(parseMiniKey('\x1bOC').name).toBe('right');
    expect(parseMiniKey('\x1bOD').name).toBe('left');
  });

  test('unknown ESC sequences fall back to esc', () => {
    expect(parseMiniKey('\x1b[Z').name).toBe('esc');
  });
});

describe('parseMiniKey · printable chars', () => {
  test('letter and digit chars map to themselves', () => {
    expect(parseMiniKey('a').name).toBe('a');
    expect(parseMiniKey('Z').name).toBe('Z');
    expect(parseMiniKey('5').name).toBe('5');
    expect(parseMiniKey(' ').name).toBe(' ');
  });

  test('multi-byte UTF-8 keeps the leading char as the name', () => {
    const k = parseMiniKey('한');
    // The name is the first char (multi-byte handled separately), raw preserved
    expect(k.raw).toBe('한');
  });
});

// ── PR-Δ23b (Sprint 18 · 2026-04-30) — fuzzy typing buffer integration ──
//
// Builds a minimal stream-like mock that captures `out.write()` and
// dispenses queued keys to the readKey loop. The mock satisfies the
// subset of NodeJS.ReadStream / WriteStream the wizard actually uses
// (isTTY · setRawMode · setEncoding · resume · pause · on/off 'data' ·
// write · columns / rows). Keys are queued first; pairing with the
// next readKey listener happens via queueMicrotask so the await loop
// makes progress between each event.
function makeFakeIO() {
  const queuedKeys: string[] = [];
  const listeners: ((data: string) => void)[] = [];
  const drain = (): void => {
    while (queuedKeys.length > 0 && listeners.length > 0) {
      const data = queuedKeys.shift()!;
      const cb = listeners.shift()!;
      queueMicrotask(() => cb(data));
    }
  };
  const input = {
    isTTY: true,
    setRawMode: () => {},
    setEncoding: () => {},
    resume: () => {},
    pause: () => {},
    on(event: string, cb: (data: string) => void): void {
      if (event === 'data') {
        listeners.push(cb);
        drain();
      }
    },
    off(event: string, cb: (data: string) => void): void {
      if (event !== 'data') return;
      const idx = listeners.indexOf(cb);
      if (idx >= 0) listeners.splice(idx, 1);
    },
  } as unknown as NodeJS.ReadStream;
  const written: string[] = [];
  const output = {
    write: (s: string): boolean => {
      written.push(s);
      return true;
    },
    columns: 80,
    rows: 24,
  } as unknown as NodeJS.WriteStream;
  const queueKey = (s: string): void => {
    queuedKeys.push(s);
    drain();
  };
  return { input, output, written, queueKey };
}

describe('fullScreenIO.choose · fuzzy typing buffer (Δ23b)', () => {
  test('options.length below threshold: no fuzzy UI, legacy quick-pick works', async () => {
    const { input, output, written, queueKey } = makeFakeIO();
    const io = fullScreenIO({ input, output });
    const opts: ChoiceOption<string>[] = [
      { key: 'y', label: 'Yes', value: 'yes' },
      { key: 'n', label: 'No', value: 'no' },
    ];
    const promise = io.choose!('Confirm:', opts);
    queueKey('y'); // legacy letter quick-pick
    const result = await promise;
    expect(result).toBe('yes');
    const allOut = written.join('');
    expect(allOut).not.toContain('filter:');
  });

  test('options.length ≥ threshold: filter UI rendered above options', async () => {
    const { input, output, written, queueKey } = makeFakeIO();
    const io = fullScreenIO({ input, output });
    const opts: ChoiceOption<string>[] = Array.from({ length: 12 }, (_, i) => ({
      key: String(i + 1),
      label: `model-${i + 1}`,
      value: `v${i + 1}`,
    }));
    const promise = io.choose!('Pick:', opts);
    queueKey('\r'); // Enter on default = idx 0
    const result = await promise;
    expect(result).toBe('v1');
    const allOut = written.join('');
    expect(allOut).toContain('filter:');
    expect(allOut).toContain('12 / 12 matches');
  });

  test('typing chars narrows the visible list + Enter picks filtered[selected]', async () => {
    const { input, output, queueKey } = makeFakeIO();
    const io = fullScreenIO({ input, output });
    const opts: ChoiceOption<string>[] = [
      { key: '1', label: 'claude-3-haiku', value: 'haiku-3' },
      { key: '2', label: 'claude-3-sonnet', value: 'sonnet-3' },
      { key: '3', label: 'claude-3-opus', value: 'opus-3' },
      { key: '4', label: 'gpt-4o', value: 'gpt-4o' },
      { key: '5', label: 'gpt-4o-mini', value: 'gpt-4o-mini' },
      { key: '6', label: 'gemini-1.5-pro', value: 'gemini-pro' },
      { key: '7', label: 'gemini-1.5-flash', value: 'gemini-flash' },
      { key: '8', label: 'mistral-large', value: 'mistral' },
      { key: '9', label: 'grok-2', value: 'grok' },
      { key: '10', label: 'llama-3', value: 'llama' },
      { key: '11', label: 'phi-3', value: 'phi' },
      { key: '12', label: 'qwen-2', value: 'qwen' },
    ];
    const promise = io.choose!('Pick:', opts);
    // Type 'h' 'a' 'i' → narrows to claude-3-haiku only, Enter picks it
    queueKey('h');
    queueKey('a');
    queueKey('i');
    queueKey('\r');
    const result = await promise;
    expect(result).toBe('haiku-3');
  });

  test('numeric quick-pick resolves against filtered list when fuzzy active', async () => {
    const { input, output, queueKey } = makeFakeIO();
    const io = fullScreenIO({ input, output });
    const opts: ChoiceOption<string>[] = [
      { key: '1', label: 'claude-haiku', value: 'haiku' },
      { key: '2', label: 'claude-sonnet', value: 'sonnet' },
      { key: '3', label: 'claude-opus', value: 'opus' },
      { key: '4', label: 'gpt-4o', value: 'gpt' },
      { key: '5', label: 'gemini', value: 'gemini' },
      { key: '6', label: 'mistral', value: 'mistral' },
      { key: '7', label: 'grok', value: 'grok' },
      { key: '8', label: 'llama', value: 'llama' },
      { key: '9', label: 'phi', value: 'phi' },
      { key: '10', label: 'qwen', value: 'qwen' },
      { key: '11', label: 'falcon', value: 'falcon' },
    ];
    const promise = io.choose!('Pick:', opts);
    // Filter to 'claude' → 3 matches. Press '2' picks filtered[1] = claude-sonnet
    queueKey('c');
    queueKey('l');
    queueKey('a');
    queueKey('u');
    queueKey('d');
    queueKey('e');
    queueKey('2');
    const result = await promise;
    expect(result).toBe('sonnet');
  });

  test('Backspace pops one char from the typing buffer', async () => {
    const { input, output, queueKey } = makeFakeIO();
    const io = fullScreenIO({ input, output });
    const opts: ChoiceOption<string>[] = Array.from({ length: 11 }, (_, i) => ({
      key: String(i + 1),
      label: i < 5 ? `claude-${i + 1}` : `gpt-${i + 1}`,
      value: `v${i + 1}`,
    }));
    const promise = io.choose!('Pick:', opts);
    // Type 'cla' → narrows to claude-* (5 items). Backspace once → 'cl' still filters.
    // Backspace 3x → buffer empty, full list. Then Enter on default (idx 0) = claude-1.
    queueKey('c');
    queueKey('l');
    queueKey('a');
    queueKey('\x7f'); // Backspace (DEL)
    queueKey('\x7f');
    queueKey('\x7f');
    queueKey('\r');
    const result = await promise;
    expect(result).toBe('v1');
  });

  test('ESC with non-empty buffer clears filter without canceling', async () => {
    const { input, output, written, queueKey } = makeFakeIO();
    const io = fullScreenIO({ input, output });
    const opts: ChoiceOption<string>[] = Array.from({ length: 11 }, (_, i) => ({
      key: String(i + 1),
      label: `item-${i + 1}`,
      value: `v${i + 1}`,
    }));
    const promise = io.choose!('Pick:', opts);
    queueKey('z'); // narrows to 0 matches
    queueKey('z');
    queueKey('\x1b'); // ESC clears buffer (does not cancel — buffer non-empty)
    queueKey('\r'); // Enter on default = filtered[0] = item-1
    const result = await promise;
    expect(result).toBe('v1');
    // Filter UI rendered at some point.
    const allOut = written.join('');
    expect(allOut).toContain('filter:');
  });

  test('explicit fuzzyThreshold: Infinity disables fuzzy mode for long lists', async () => {
    const { input, output, written, queueKey } = makeFakeIO();
    const io = fullScreenIO({ input, output });
    const opts: ChoiceOption<string>[] = Array.from({ length: 15 }, (_, i) => ({
      key: String(i + 1),
      label: `m-${i + 1}`,
      value: `v${i + 1}`,
    }));
    const promise = io.choose!('Pick:', opts, { fuzzyThreshold: Infinity });
    queueKey('\r'); // Enter on default
    const result = await promise;
    expect(result).toBe('v1');
    const allOut = written.join('');
    expect(allOut).not.toContain('filter:');
  });

  test('default fuzzyThreshold is 10 — exactly 10 options trigger fuzzy', async () => {
    const { input, output, written, queueKey } = makeFakeIO();
    const io = fullScreenIO({ input, output });
    const opts: ChoiceOption<string>[] = Array.from({ length: 10 }, (_, i) => ({
      key: String(i + 1),
      label: `m-${i + 1}`,
      value: `v${i + 1}`,
    }));
    const promise = io.choose!('Pick:', opts);
    queueKey('\r');
    await promise;
    const allOut = written.join('');
    expect(allOut).toContain('filter:');
    expect(allOut).toContain('10 / 10 matches');
  });
});

describe('normalizeKeyForMatch · Hangul jamo → qwerty', () => {
  test('lowercases ASCII letters', () => {
    expect(normalizeKeyForMatch('Y')).toBe('y');
    expect(normalizeKeyForMatch('N')).toBe('n');
    expect(normalizeKeyForMatch('a')).toBe('a');
  });

  test('Hangul jamo emitted by Korean IME map to qwerty position', () => {
    expect(normalizeKeyForMatch('ㅛ')).toBe('y'); // qwerty Y
    expect(normalizeKeyForMatch('ㅜ')).toBe('n'); // qwerty N
    expect(normalizeKeyForMatch('ㅑ')).toBe('i');
    expect(normalizeKeyForMatch('ㅏ')).toBe('k');
  });

  test('Shift jamo also map (shift + jamo on qwerty)', () => {
    expect(normalizeKeyForMatch('ㅒ')).toBe('o');
    expect(normalizeKeyForMatch('ㅖ')).toBe('p');
    expect(normalizeKeyForMatch('ㅃ')).toBe('q');
  });

  test('non-mapped chars pass through lowercased', () => {
    expect(normalizeKeyForMatch('5')).toBe('5');
    expect(normalizeKeyForMatch(' ')).toBe(' ');
    expect(normalizeKeyForMatch('한')).toBe('한'); // composed syllable not mapped
  });
});

describe('fullScreenIO.print while no question is pending (OB4 · 0.2.6 실물: 기기 코드가 안 보이고 멈춤)', () => {
  test('after a pick, print paints immediately so the device code and URL are visible during the wait', async () => {
    const { input, output, written, queueKey } = makeFakeIO();
    const io = fullScreenIO({ input, output });
    const promise = io.choose!('Auth mode:', [{ key: '1', label: 'OAuth', value: 'oauth' }, { key: '2', label: 'Skip', value: 'skip' }]);
    queueKey('1');
    expect(await promise).toBe('oauth');
    const before = written.length;
    io.print('    1) 아무 브라우저에서 열기: https://example.test/device');
    io.print('    2) 코드 입력:             ABCD-EFGH');
    const painted = written.slice(before).join('');
    expect(painted).toContain('코드 입력:             ABCD-EFGH');
    expect(painted).toContain('아무 브라우저에서 열기');
    expect(painted).toContain('Ctrl-C cancel');
  });

  test('print inside a pending question still waits for that question screen (no extra paint)', async () => {
    const { input, output, written, queueKey } = makeFakeIO();
    const io = fullScreenIO({ input, output });
    const promise = io.choose!('Pick:', [{ key: '1', label: 'A', value: 'a' }, { key: '2', label: 'B', value: 'b' }]);
    const before = written.length;
    io.print('note during question');
    expect(written.length).toBe(before);
    queueKey('1');
    expect(await promise).toBe('a');
  });
});
