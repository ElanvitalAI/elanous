import { describe, expect, test } from 'bun:test';
import { runSeatInPlaceUpdateWorld } from './seat-inplace-update-world.js';

describe('SEAT-INPLACE-UPDATE simulation world (seeds 1·2·3)', () => {
  test('every case matches its literal expectation · durable diff empty · turns lost 0', async () => {
    const rows = await runSeatInPlaceUpdateWorld([1, 2, 3]);
    expect(rows.length).toBe(33);
    const byCase = Object.fromEntries(rows.map((r) => [r.case, r.actual]));
    expect(byCase['s1 idle boundary']).toBe('go · sess-OP-1 · notices [mail #1] full notice text 1');
    expect(byCase['s2 mid-turn']).toBe('wait:turn-running → go');
    expect(byCase['s3 typing at exit']).toBe('wait:person-typing → go · draft «half typed line 3+x»');
    expect(byCase['s1 queued person line']).toBe('wait:queued-person-line');
    expect(byCase['s2 RunShell in flight']).toBe('wait:capsule-running');
    expect(byCase['s3 crash loop']).toBe('crash-backoff:2000 · crash-backoff:4000 · fallback-previous:0 · 1 card');
    expect(byCase['s1 back-to-back']).toBe('1 exit on old · go on new · lost none');
    expect(byCase['s2 release window']).toBe('wait:release-window');
    expect(byCase['s3 leaders']).toBe('TC:go UX:go MK:go JUD:go CC-1:none');
    expect(byCase['s1 new build will not start']).toBe('wait:probe-retry · stay-card · none · 1 card · 0 exits');
    expect(byCase['s2 pane id']).toBe('p00002abc|sess-2 ×2');
    for (const row of rows) {
      expect(row.actual).toBe(row.expected);
      expect(row.durableDiff).toEqual([]);
      expect(row.turnLost).toBe(0);
    }
  });
});
