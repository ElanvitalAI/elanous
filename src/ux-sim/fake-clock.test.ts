import { describe, expect, it, jest } from 'bun:test';
import { withSimClock } from './fake-clock.js';

describe('Bun fake clock scope', () => {
  it('advances real Date and timer callbacks without waiting', async () => {
    const epoch = Date.parse('2026-10-15T00:00:00Z');
    await withSimClock(epoch, (clock) => {
      const fired: number[] = [];
      setTimeout(() => fired.push(Date.now()), 25);
      expect(clock.pendingTimers()).toBe(1);
      clock.tick(24);
      expect(fired).toEqual([]);
      clock.tick(1);
      expect(fired).toEqual([epoch + 25]);
      clock.setTime(epoch + 100);
      expect(clock.now()).toBe(epoch + 100);
    });
    expect(jest.isFakeTimers()).toBe(false);
  });

  it('restores global timers even when the scenario throws', async () => {
    await expect(withSimClock(0, () => {
      setTimeout(() => {}, 10_000);
      throw new Error('scenario failed');
    })).rejects.toThrow('scenario failed');
    expect(jest.isFakeTimers()).toBe(false);
    expect(Date.now()).toBeGreaterThan(0);
  });

  it('rejects overlapping scopes before either can restore the other clock', async () => {
    await withSimClock(123, async () => {
      await expect(withSimClock(456, () => undefined)).rejects.toThrow('serially');
      expect(Date.now()).toBe(123);
    });
    expect(jest.isFakeTimers()).toBe(false);
  });
});
