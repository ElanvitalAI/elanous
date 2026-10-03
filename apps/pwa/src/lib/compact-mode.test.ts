import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { COMPACT_MAX_WIDTH, useCompactMode } from './compact-mode';

const KEY = 'elanous.pwa.wideView';
type Mode = ReturnType<typeof useCompactMode>;
let current: Mode;
let renderer: ReactTestRenderer | undefined;
let width = 933;
let readFails = false;
let writeFails = false;
const store = new Map<string, string>();
const listeners = new Set<() => void>();
const others = new Map<string, Set<() => void>>();
const previousWindow = (globalThis as { window?: unknown }).window;
const previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

function Probe(): null {
  current = useCompactMode();
  return null;
}

function resize(next: number): void {
  width = next;
  act(() => { for (const notify of [...listeners]) notify(); });
}

function mount(): void {
  act(() => { renderer = create(createElement(Probe)); });
}

beforeEach(() => {
  store.clear();
  listeners.clear();
  others.clear();
  width = 933;
  readFails = false;
  writeFails = false;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { window?: unknown }).window = {
    get innerWidth() { return width; },
    localStorage: {
      getItem: (key: string) => {
        if (readFails) throw new Error('storage blocked');
        return store.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (writeFails) throw new Error('storage blocked');
        store.set(key, value);
      },
      removeItem: (key: string) => {
        if (writeFails) throw new Error('storage blocked');
        store.delete(key);
      },
    },
    addEventListener: (kind: string, notify: (event?: unknown) => void) => {
      if (kind === 'resize') listeners.add(notify);
      else (others.get(kind) ?? others.set(kind, new Set()).get(kind)!).add(notify);
    },
    removeEventListener: (kind: string, notify: (event?: unknown) => void) => {
      if (kind === 'resize') listeners.delete(notify);
      else others.get(kind)?.delete(notify);
    },
    dispatchEvent: (event: { type: string }) => {
      for (const notify of [...(others.get(event.type) ?? [])]) (notify as (e: unknown) => void)(event);
      return true;
    },
  };
});

afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = undefined;
  expect(listeners.size).toBe(0);
  for (const set of others.values()) expect(set.size).toBe(0);
  if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = previousWindow;
  if (previousActEnvironment === undefined) delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  else (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

describe('useCompactMode', () => {
  test('931 and 932 are compact; 933 is wide', () => {
    expect(COMPACT_MAX_WIDTH).toBe(932);
    width = 931;
    mount();
    expect(current.compact).toBe(true);
    resize(932);
    expect(current.compact).toBe(true);
    resize(933);
    expect(current.compact).toBe(false);
  });

  test('remembers 넓게 보기 across mounts and restores compact on opt-out', () => {
    width = 931;
    mount();
    act(() => current.setWide(true));
    expect(current.compact).toBe(false);
    expect(store.get(KEY)).toBe('1');
    act(() => renderer?.unmount());
    mount();
    expect(current.compact).toBe(false);
    act(() => current.setWide(false));
    expect(current.compact).toBe(true);
    expect(store.has(KEY)).toBe(false);
  });

  test('blocked storage reads default to compact; blocked writes keep the current choice', () => {
    width = 932;
    readFails = true;
    writeFails = true;
    mount();
    expect(current.compact).toBe(true);
    act(() => current.setWide(true));
    expect(current.compact).toBe(false);
    act(() => current.setWide(false));
    expect(current.compact).toBe(true);
  });

  test('resize re-evaluates immediately while preserving the explicit wide choice', () => {
    width = 933;
    mount();
    expect(current.compact).toBe(false);
    resize(932);
    expect(current.compact).toBe(true);
    act(() => current.setWide(true));
    resize(931);
    expect(current.compact).toBe(false);
    act(() => current.setWide(false));
    expect(current.compact).toBe(true);
    resize(933);
    expect(current.compact).toBe(false);
  });

  test('every mounted hook follows one 넓게 보기 choice', () => {
    width = 900;
    let second: ReturnType<typeof useCompactMode> | undefined;
    function Second(): null { second = useCompactMode(); return null; }
    let other: ReturnType<typeof create> | undefined;
    mount();
    act(() => { other = create(createElement(Second)); });
    expect(current.compact).toBe(true);
    expect(second?.compact).toBe(true);
    act(() => current.setWide(true));
    expect(second?.compact).toBe(false);
    act(() => second?.setWide(false));
    expect(current.compact).toBe(true);
    act(() => other?.unmount());
  });
});
