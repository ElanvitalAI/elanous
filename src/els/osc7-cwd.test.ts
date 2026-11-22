import { expect, test } from 'bun:test';
import { osc7CwdParser } from './osc7-cwd.js';

test('CAN and SUB cancel every partial control string and allow the next OSC 7', () => {
  const prefixes = [
    '\x1b', // escape
    '\x1b]7;file:///cancelled', // osc
    '\x1b]7;file:///cancelled\x1b', // osc-escape
    '\x1bPignored', // discard
    '\x1bPignored\x1b', // discard-escape
    '\x1b]7;' + 'x'.repeat(8193), // overflow discard
  ];
  for (const cancel of ['\x18', '\x1a']) {
    for (const prefix of prefixes) {
      const found: string[] = [];
      const feed = osc7CwdParser(cwd => found.push(cwd));
      feed(prefix); feed(cancel); // cancellation may be in its own PTY chunk
      for (const ch of '\x1b]7;file:///after\x07') feed(ch);
      expect(found).toEqual(['/after']);
    }
  }
});

test('rejects query and fragment delimiters, including empty ones, but accepts encoded path characters', () => {
  const found: string[] = [];
  const feed = osc7CwdParser(cwd => found.push(cwd));
  for (const uri of ['file:///bad?', 'file:///bad#', 'file:///bad?x', 'file:///bad#x', 'file:///bad?#']) {
    feed(`\x1b]7;${uri}\x07`);
  }
  feed('\x1b]7;file:///good%3F%23\x07');
  expect(found).toEqual(['/good?#']);
});

test('plain text fast path preserves split sequences and all control string introducers', () => {
  const found: string[] = [];
  const feed = osc7CwdParser(cwd => found.push(cwd));
  feed('한글 plain text '.repeat(10000) + '\x18\x1a');
  feed('\x1b'); feed(']7;file:///split'); feed('\x07');
  feed('\x9d'); feed('7;file:///c1'); feed('\x9c');
  for (const start of ['\x90', '\x98', '\x9e', '\x9f']) {
    feed(start); feed('ignored\x1b]7;file:///nested'); feed('\x9c');
  }
  feed('\x1b]7;file:///after\x07');
  expect(found).toEqual(['/split', '/c1', '/after']);
});

test('BEL inside non-OSC control strings does not expose nested OSC reports', () => {
  for (const start of ['\x1bP', '\x1bX', '\x1b^', '\x1b_', '\x90', '\x98', '\x9e', '\x9f']) {
    const found: string[] = [];
    const feed = osc7CwdParser(cwd => found.push(cwd));
    feed(start + 'hidden\x07');
    feed('\x1b]7;file:///fake\x07');
    feed('\x1b\\\x1b]7;file:///actual\x07');
    expect(found).toEqual(['/actual']);
  }
});

test('cancelled OSC payload is not reported when its old terminator arrives', () => {
  for (const cancel of ['\x18', '\x1a']) {
    const found: string[] = [];
    const feed = osc7CwdParser(cwd => found.push(cwd));
    feed(`\x1b]7;file:///cancelled${cancel}\x07\x1b]7;file:///after\x1b\\`);
    expect(found).toEqual(['/after']);
  }
});
