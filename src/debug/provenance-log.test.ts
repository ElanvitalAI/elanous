import { afterEach, expect, test } from 'bun:test';
import { debug, type DebugEvent } from './log.js';

test('debug records preserve explicit source tags and mark untagged rows unknown', () => {
  const previous = debug.status();
  const previousSimUniverse = process.env.ELANOUS_SIM_UNIVERSE;
  const records: DebugEvent[] = [];
  const unregister = debug.registerSink({ name: 'provenance-test', emit: record => records.push(record) });
  debug.setFileEnabled(false);
  debug.setMirror(false);
  debug.setVerboseEnabled(true);
  try {
    debug.log('event.test', 'untagged', { value: 1 });
    debug.log('event.test', 'simulated', { value: 2 }, {
      provenance: { universe: 'sim', source: 'sim', device: 'ux-sim', scenario: 'tag-test', clock: 'sim' },
    });
    debug.log('event.test', 'malformed', { value: 3 }, {
      provenance: { universe: 'prod', source: 'real', device: '' } as never,
    });
    const sim = { universe: 'sim', source: 'sim', device: 'ux-sim', scenario: 'conflicting-tags', clock: 'sim' } as const;
    debug.log('event.test', 'conflicting-tags', { value: 4, provenance: sim }, {
      provenance: { universe: 'prod', source: 'real' },
    });
    expect(records[0]?.provenance).toMatchObject({ source: 'unknown' });
    expect(records[1]?.provenance).toEqual({ universe: 'sim', source: 'sim', device: 'ux-sim', scenario: 'tag-test', clock: 'sim' });
    expect(records[2]?.provenance).toMatchObject({ source: 'unknown' });
    expect(records[3]?.provenance).toEqual(sim);
    expect(records[3]?.data).toMatchObject({ provenance: sim });
    process.env.ELANOUS_SIM_UNIVERSE = '1';
    debug.log('event.test', 'sim-run-with-real-tag', {
      value: 5, provenance: { universe: 'prod', source: 'real' },
    }, { provenance: { universe: 'prod', source: 'real' } });
    expect(records[4]?.provenance).toEqual({ universe: 'sim', source: 'unknown' });
    expect(records[4]?.data).toMatchObject({ provenance: { universe: 'sim', source: 'unknown' } });
  } finally {
    if (previousSimUniverse === undefined) delete process.env.ELANOUS_SIM_UNIVERSE;
    else process.env.ELANOUS_SIM_UNIVERSE = previousSimUniverse;
    unregister();
    debug.setFileEnabled(previous.file);
    debug.setMirror(previous.mirror);
    debug.setVerboseEnabled(previous.verbose);
    debug.setDiagEnabled(previous.diag);
  }
});
