import { describe, expect, spyOn, test } from 'bun:test';
import * as debug from '@/lib/debug';
import { getTerminalHistoryView, registerTerminalHistoryView, registerTerminalInput, sendToTerminal, setStickyModifiers, subscribeStickyModifiers, subscribeTerminalHistoryView, takeStickyModifiers, type TerminalHistoryView } from './terminal-input-registry';

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
  test('takes armed modifiers once and notifies only after clearing', () => {
    const consumed: Array<ReturnType<typeof takeStickyModifiers>> = [];
    const off = subscribeStickyModifiers('registry-sticky-once', () => {
      consumed.push(takeStickyModifiers('registry-sticky-once'));
    });
    try {
      const mods = { ctrl: true, alt: false };
      setStickyModifiers('registry-sticky-once', mods);
      mods.ctrl = false;
      expect(takeStickyModifiers('registry-sticky-once')).toEqual({ ctrl: true, alt: false });
      expect(consumed).toEqual([null]);
      expect(takeStickyModifiers('registry-sticky-once')).toBeNull();
      expect(consumed).toEqual([null]);
    } finally {
      off();
      setStickyModifiers('registry-sticky-once', { ctrl: false, alt: false });
    }
  });

  test('sticky modifiers and consumption notifications are isolated by terminal', () => {
    let firstCount = 0;
    let secondCount = 0;
    const offFirst = subscribeStickyModifiers('registry-sticky-first', () => { firstCount++; });
    const offSecond = subscribeStickyModifiers('registry-sticky-second', () => { secondCount++; });
    try {
      setStickyModifiers('registry-sticky-first', { ctrl: true, alt: false });
      setStickyModifiers('registry-sticky-second', { ctrl: false, alt: true });
      expect(takeStickyModifiers('registry-sticky-first')).toEqual({ ctrl: true, alt: false });
      expect(firstCount).toBe(1);
      expect(secondCount).toBe(0);
      expect(takeStickyModifiers('registry-sticky-second')).toEqual({ ctrl: false, alt: true });
      expect(secondCount).toBe(1);
      expect(takeStickyModifiers('registry-sticky-first')).toBeNull();
    } finally {
      offFirst();
      offSecond();
      setStickyModifiers('registry-sticky-first', { ctrl: false, alt: false });
      setStickyModifiers('registry-sticky-second', { ctrl: false, alt: false });
    }
  });

  test('disarming one terminal leaves the other armed', () => {
    setStickyModifiers('registry-disarm-first', { ctrl: true, alt: true });
    setStickyModifiers('registry-disarm-second', { ctrl: true, alt: false });
    try {
      setStickyModifiers('registry-disarm-first', { ctrl: false, alt: false });
      expect(takeStickyModifiers('registry-disarm-first')).toBeNull();
      expect(takeStickyModifiers('registry-disarm-second')).toEqual({ ctrl: true, alt: false });
    } finally {
      setStickyModifiers('registry-disarm-first', { ctrl: false, alt: false });
      setStickyModifiers('registry-disarm-second', { ctrl: false, alt: false });
    }
  });

  test('registered sending leaves armed sticky modifiers untouched', () => {
    const received: string[] = [];
    const off = registerTerminalInput('registry-sticky-send', (data) => received.push(data));
    try {
      setStickyModifiers('registry-sticky-send', { ctrl: true, alt: false });
      expect(sendToTerminal('registry-sticky-send', 'plain')).toBe(true);
      expect(received).toEqual(['plain']);
      expect(takeStickyModifiers('registry-sticky-send')).toEqual({ ctrl: true, alt: false });
    } finally {
      off();
      setStickyModifiers('registry-sticky-send', { ctrl: false, alt: false });
    }
  });

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
