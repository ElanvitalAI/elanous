import { describe, expect, test } from 'bun:test';
import { debug } from '../debug/log.js';
import {
  isOldDoorInternalCall,
  oldDoorInternalEnv,
  oldDoorRefusalMessage,
  OLD_DOOR_STAMP_ENV,
  OLD_DOOR_STAMP_FLAG,
  refuseOldDoor,
} from './old-door.js';

describe('old door — outside calls refuse, harness-internal calls pass', () => {
  test('an unstamped dev --ask, self implement, and self orchestrate each refuse with exit 1 and one pointer line', () => {
    for (const door of ['dev-ask', 'self-implement', 'self-orchestrate'] as const) {
      expect(isOldDoorInternalCall(door, {}, ['node', 'elanous'])).toBe(false);
      const refused = refuseOldDoor(door);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.caller).toBe('outside');
      expect(refused.message).toContain('harness say / harness ask 로');
      expect(refused.message.split('\n')).toHaveLength(1);
      expect(refused.message).toContain('elanous harness');
    }
    expect(oldDoorRefusalMessage('dev-ask')).toContain('elanous harness ask <goal.md>');
    expect(oldDoorRefusalMessage('self-implement')).toContain('elanous harness say "<sentence>"');
    expect(oldDoorRefusalMessage('self-orchestrate')).toContain('elanous harness say "<sentence>"');
  });

  test('a harness stamp in the environment or the internal flag keeps the door open', () => {
    expect(isOldDoorInternalCall('dev-ask', { [OLD_DOOR_STAMP_ENV]: 'dev-ask' }, [])).toBe(true);
    expect(isOldDoorInternalCall('dev-ask', { [OLD_DOOR_STAMP_ENV]: 'cli-harness-ask' }, [])).toBe(true);
    expect(isOldDoorInternalCall('self-implement', { [OLD_DOOR_STAMP_ENV]: 'self-implement' }, [])).toBe(true);
    expect(isOldDoorInternalCall('self-implement', { [OLD_DOOR_STAMP_ENV]: 'daemon-tool' }, [])).toBe(true);
    expect(isOldDoorInternalCall('self-orchestrate', { [OLD_DOOR_STAMP_ENV]: 'self-orchestrate' }, [])).toBe(true);
    expect(isOldDoorInternalCall('self-orchestrate', { [OLD_DOOR_STAMP_ENV]: 'cli-harness-say' }, [])).toBe(true);
    expect(isOldDoorInternalCall('self-implement', {}, ['node', 'elanous', 'self', 'implement', OLD_DOOR_STAMP_FLAG])).toBe(true);
    expect(isOldDoorInternalCall('dev-ask', { [OLD_DOOR_STAMP_ENV]: 'self-implement' }, [])).toBe(false);
    expect(isOldDoorInternalCall('self-implement', { [OLD_DOOR_STAMP_ENV]: '   ' }, [])).toBe(false);
  });

  test('the internal env uses the ONEDOOR-1 entrance stamp', () => {
    expect(oldDoorInternalEnv('self-implement')).toEqual({ [OLD_DOOR_STAMP_ENV]: 'self-implement' });
    expect(oldDoorInternalEnv('queue-tick')).toEqual({ [OLD_DOOR_STAMP_ENV]: 'queue-tick' });
  });

  test('refusing logs one harness.entrance old-door-refused row naming the door and the outside caller', () => {
    const seen: Array<{ category: string; event: string; data: unknown }> = [];
    const original = debug.log.bind(debug);
    debug.log = ((category: string, event: string, data?: unknown) => {
      seen.push({ category, event, data });
    }) as typeof debug.log;
    try {
      const refused = refuseOldDoor('self-implement');
      debug.log('harness.entrance', 'old-door-refused', { door: refused.door, caller: refused.caller });
    } finally {
      debug.log = original;
    }
    expect(seen).toEqual([{ category: 'harness.entrance', event: 'old-door-refused', data: { door: 'self-implement', caller: 'outside' } }]);
  });

  test('dropping the stamp check closes the internal path — this is the refutation', () => {
    const stampIgnored = (_door: string, _env: NodeJS.ProcessEnv, _argv: readonly string[]): boolean => false;
    expect(stampIgnored('self-implement', oldDoorInternalEnv('self-implement'), [OLD_DOOR_STAMP_FLAG])).toBe(false);
    expect(isOldDoorInternalCall('self-implement', oldDoorInternalEnv('self-implement'), [])).toBe(true);
  });
});
