import { describe, expect, test } from 'bun:test';
import {
  createExternalEventBundler,
  EXTERNAL_EVENT_BUNDLE_MAX_CHARS,
  EXTERNAL_EVENT_BUNDLE_MAX_ITEMS,
} from './external-event-bundle.js';

describe('external event bundle', () => {
  test('ten arrivals leave as one idle turn', () => {
    const bundle = createExternalEventBundler();
    for (let i = 0; i < 10; i += 1) {
      expect(bundle.push({ id: `e${i}`, source: `⇢ ${i}` })).toBe(true);
    }
    expect(bundle.depth()).toBe(10);
    const taken = bundle.take(false);
    expect(taken?.ids).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9']);
    expect(taken?.text.split('\n')).toHaveLength(10);
    expect(taken?.overflow).toBe(0);
    expect(bundle.depth()).toBe(0);
    expect(bundle.take(false)).toBeNull();
  });

  test('a running turn keeps the burst until it is idle', () => {
    const bundle = createExternalEventBundler();
    bundle.push({ id: 'a', source: '⇢ OP' });
    bundle.push({ id: 'b', source: '⏰ wake' });
    expect(bundle.take(true)).toBeNull();
    expect(bundle.depth()).toBe(2);
    expect(bundle.take(false)?.ids).toEqual(['a', 'b']);
  });

  test('the same id is queued once', () => {
    const bundle = createExternalEventBundler();
    expect(bundle.push({ id: 'a', source: '⇢ OP' })).toBe(true);
    expect(bundle.push({ id: 'a', source: '⇢ OP again' })).toBe(false);
    expect(bundle.take(false)?.text).toBe('⇢ OP');
  });

  test('an id can arrive again after its bundle left', () => {
    const bundle = createExternalEventBundler();
    bundle.push({ id: 'a', source: 'first' });
    bundle.take(false);
    expect(bundle.push({ id: 'a', source: 'second' })).toBe(true);
    expect(bundle.take(false)?.text).toBe('second');
  });

  test('a burst past the item cap keeps the newest and reports the rest', () => {
    const bundle = createExternalEventBundler();
    const extra = 30;
    const total = EXTERNAL_EVENT_BUNDLE_MAX_ITEMS + extra;
    for (let i = 0; i < total; i += 1) bundle.push({ id: `e${i}`, source: `⇢ ${i}` });
    expect(bundle.depth()).toBe(EXTERNAL_EVENT_BUNDLE_MAX_ITEMS);
    expect(bundle.overflow()).toBe(extra);
    const taken = bundle.take(false);
    expect(taken?.ids).toHaveLength(EXTERNAL_EVENT_BUNDLE_MAX_ITEMS);
    expect(taken?.ids[0]).toBe(`e${extra}`);
    expect(taken?.ids.at(-1)).toBe(`e${total - 1}`);
    expect(taken?.overflow).toBe(extra);
    expect(taken?.text.endsWith(`외 ${extra}건`)).toBe(true);
    expect((taken?.text.length ?? 0) <= EXTERNAL_EVENT_BUNDLE_MAX_CHARS).toBe(true);
    expect(bundle.depth()).toBe(0);
    expect(bundle.overflow()).toBe(0);
  });

  test('text past the char cap keeps the newest lines and counts the rest', () => {
    const wide = Math.floor(EXTERNAL_EVENT_BUNDLE_MAX_CHARS / 8);
    const bundle = createExternalEventBundler({ maxItems: EXTERNAL_EVENT_BUNDLE_MAX_ITEMS * 2 });
    const count = 20;
    for (let i = 0; i < count; i += 1) {
      bundle.push({ id: `e${i}`, source: `s${i}:${'x'.repeat(wide)}` });
    }
    const taken = bundle.take(false);
    expect((taken?.text.length ?? 0) <= EXTERNAL_EVENT_BUNDLE_MAX_CHARS).toBe(true);
    expect(taken?.overflow === 0).toBe(false);
    expect(taken?.text.endsWith(`외 ${taken?.overflow}건`)).toBe(true);
    expect(taken?.ids.at(-1)).toBe(`e${count - 1}`);
    expect(bundle.depth()).toBe(0);
  });
});
