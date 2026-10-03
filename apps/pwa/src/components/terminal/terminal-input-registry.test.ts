import { describe, expect, spyOn, test } from 'bun:test';
import * as debug from '@/lib/debug';
import { getTerminalHistoryView, registerTerminalHistoryView, registerTerminalInput, sendToTerminal, subscribeTerminalHistoryView, type TerminalHistoryView } from './terminal-input-registry';

test('history view registration replaces and cleans up only its own handle', () => {
  const first = {} as TerminalHistoryView;
  const second = {} as TerminalHistoryView;
  const updates: Array<TerminalHistoryView | null> = [];
  const offListener = subscribeTerminalHistoryView(() => updates.push(getTerminalHistoryView('registry-history')));
  const offFirst = registerTerminalHistoryView('registry-history', first);
  const offSecond = registerTerminalHistoryView('registry-history', second);
  try {
    offFirst();
    expect(getTerminalHistoryView('registry-history')).toBe(second);
    expect(updates).toEqual([first, second]);
  } finally {
    offSecond();
    offFirst();
    offListener();
  }
  expect(getTerminalHistoryView('registry-history')).toBeNull();
  expect(updates).toEqual([first, second, null]);
});

describe('terminal input registry', () => {
  test('routes data to the registered terminal only', () => {
    const first: string[] = [];
    const second: string[] = [];
    const offFirst = registerTerminalInput('registry-first', (data) => first.push(data));
    const offSecond = registerTerminalInput('registry-second', (data) => second.push(data));
    try {
      expect(sendToTerminal('registry-first', 'hello')).toBe(true);
      expect(sendToTerminal('registry-second', '\u001b[A')).toBe(true);
      expect(first).toEqual(['hello']);
      expect(second).toEqual(['\u001b[A']);
    } finally {
      offFirst();
      offSecond();
    }
  });

  test('replaces a sender without letting the old cleanup remove the new sender', () => {
    const old: string[] = [];
    const current: string[] = [];
    const offOld = registerTerminalInput('registry-replace', (data) => old.push(data));
    const offCurrent = registerTerminalInput('registry-replace', (data) => current.push(data));
    try {
      offOld();
      expect(sendToTerminal('registry-replace', 'new')).toBe(true);
      expect(old).toEqual([]);
      expect(current).toEqual(['new']);
    } finally {
      offCurrent();
      offOld();
    }
  });

  test('does not remove a newer registration using the same callback', () => {
    const received: string[] = [];
    const sender = (data: string) => { received.push(data); };
    const offOld = registerTerminalInput('registry-same-callback', sender);
    const offCurrent = registerTerminalInput('registry-same-callback', sender);
    try {
      offOld();
      expect(sendToTerminal('registry-same-callback', 'new')).toBe(true);
      expect(received).toEqual(['new']);
    } finally {
      offCurrent();
      offOld();
    }
  });

  test('cleanup removes its sender and remains safe to call again', () => {
    const received: string[] = [];
    const off = registerTerminalInput('registry-cleanup', (data) => received.push(data));
    expect(sendToTerminal('registry-cleanup', 'before')).toBe(true);
    off();
    off();
    expect(sendToTerminal('registry-cleanup', 'after')).toBe(false);
    expect(received).toEqual(['before']);
  });

  test('missing sender returns false and logs the terminal and UTF-8 byte count', () => {
    const log = spyOn(debug, 'debugLog').mockImplementation(() => {});
    try {
      expect(sendToTerminal('registry-missing', '한')).toBe(false);
      expect(log).toHaveBeenCalledWith('webterm.input.no-sender', { terminalId: 'registry-missing', bytes: 3 });
    } finally {
      log.mockRestore();
    }
  });
});
