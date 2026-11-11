import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createMemoryIncidentClaimStore } from './incident-claim.js';
import {
  findSilentSupervisionEvents,
  parseSilenceWatchEvents,
  runSilenceWatch,
  type SilenceWatchEvent,
} from './silence-watch.js';

const NOW = Date.parse('2026-11-11T00:10:00.000Z');
const OBSERVED_AT = '2026-11-11T00:00:00.000Z';
// Source: RFC §2b's PT10M threshold; a one-hour-old observation keeps CLI-clock tests overdue without a clock override.
const CLI_OVERDUE_OBSERVED_AT = new Date(Date.now() - 3_600_000).toISOString();

function event(eventId: string, kind: SilenceWatchEvent['kind'], overrides: Partial<SilenceWatchEvent> = {}): SilenceWatchEvent {
  return { eventId, incidentId: `incident:${eventId}`, kind, observedAt: OBSERVED_AT, silenceAfter: 'PT10M', ...overrides };
}

test('overdue unowned observations produce one coordinator claim for each supported event kind', async () => {
  const events = [
    event('doctor', 'run-doctor-visit'),
    event('autopsy', 'autopsy'),
    event('failure', 'failure-attribution'),
    event('landed-yellow', 'landed-but-yellow'),
    event('unmeasured', 'test-interference-unmeasured'),
  ];
  const store = createMemoryIncidentClaimStore();

  const firstTick = await runSilenceWatch(events, NOW, store);
  const repeatedTick = await runSilenceWatch(events, NOW, store);

  expect(firstTick).toHaveLength(5);
  expect(firstTick.every((proposal) => proposal.disposition === 'claimed'
    && proposal.ownerLoopRef === 'loop:coordinator@1')).toBe(true);
  expect(repeatedTick.every((proposal) => proposal.disposition === 'denied')).toBe(true);
});

test('a claim remains active across the scheduled ten-minute tick interval', async () => {
  const events = [event('delayed-tick', 'autopsy')];
  const store = createMemoryIncidentClaimStore();
  const firstTick = await runSilenceWatch(events, NOW, store);
  const nextScheduledTick = await runSilenceWatch(events, Date.parse('2026-11-11T00:20:00.000Z'), store);

  expect(firstTick[0]?.disposition).toBe('claimed');
  expect(nextScheduledTick[0]?.disposition).toBe('denied');
});

test('a valid owner or timely reasoned no_action prevents escalation after the deadline', () => {
  const events = [
    event('owned-after-deadline', 'autopsy', {
      claim: { ownerLoopRef: 'loop:run-doctor@1', expiresAtMs: Date.parse('2026-11-11T00:11:00.000Z') },
    }),
    event('no-action', 'failure-attribution', {
      noAction: { reason: 'coordinator review already queued', recordedAt: '2026-11-11T00:09:00.000Z' },
    }),
  ];

  expect(findSilentSupervisionEvents(events, NOW)).toEqual([]);
});

test('a no_action recorded before the observation does not suppress an overdue event', () => {
  const stale = event('stale-no-action', 'autopsy', {
    noAction: { reason: 'old decision', recordedAt: '2026-11-10T23:59:00.000Z' },
  });

  expect(findSilentSupervisionEvents([stale], NOW)).toEqual([stale]);
});

test('observations before deadline and invalid timestamps or ISO durations do not escalate', async () => {
  const events = [
    event('early', 'landed-but-yellow', { observedAt: '2026-11-11T00:01:00.000Z' }),
    event('bad-time', 'autopsy', { observedAt: 'not-a-time' }),
    event('impossible-date', 'autopsy', { observedAt: '2026-02-30T00:00:00Z' }),
    event('bad-duration', 'failure-attribution', { silenceAfter: 'PTbroken' }),
  ];

  expect(findSilentSupervisionEvents(events, NOW)).toEqual([]);
  expect(await runSilenceWatch(events, NOW)).toEqual([]);
});

test('unsupported and malformed external events are dropped before claims', async () => {
  const events = [
    { ...event('unsupported', 'autopsy'), kind: 'unknown-event' },
    { eventId: 'missing-fields', kind: 'autopsy' },
  ] as unknown as SilenceWatchEvent[];

  expect(parseSilenceWatchEvents(events)).toEqual([]);
  expect(await runSilenceWatch(events, NOW)).toEqual([]);
});

test('separate CLI shadow ticks reuse durable claims and malformed graph context fails soft', () => {
  const root = mkdtempSync(join(tmpdir(), 'silence-watch-sim-'));
  const events = [event('durable', 'autopsy', { observedAt: CLI_OVERDUE_OBSERVED_AT })];
  const cliPath = new URL('./silence-watch.ts', import.meta.url).pathname;
  const invoke = (context: string) => spawnSync(process.execPath, [cliPath, '--shadow'], {
    encoding: 'utf8',
    env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context, ELANOUS_STATE_DIR: root, ELANOUS_STATE_DIR_SOURCE: 'explicit' },
  });
  try {
    const context = JSON.stringify({ input: { events } });
    const firstTick = invoke(context);
    const nextTick = invoke(context);
    const invalidJson = invoke('{');
    const nullContext = invoke('null');

    // Source: a successful shadow command exits zero after producing its JSON receipt.
    expect(firstTick.status).toBe(0);
    expect(nextTick.status).toBe(0);
    expect(invalidJson.status).toBe(0);
    expect(nullContext.status).toBe(0);
    expect(JSON.parse(firstTick.stdout).escalations[0]?.disposition).toBe('claimed');
    expect(JSON.parse(nextTick.stdout).escalations[0]?.disposition).toBe('denied');
    expect(JSON.parse(invalidJson.stdout)).toMatchObject({ observed: 0, escalations: [] });
    expect(JSON.parse(nullContext.stdout)).toMatchObject({ observed: 0, escalations: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the scheduled graph tick calls the shadow command recipe only', () => {
  const graph = parseYaml(readFileSync(join(import.meta.dir, '../../graphs/ops/silence-watch.yaml'), 'utf8')) as {
    loop: { trigger: { cron: string } };
    entry_node: string;
    nodes: Array<{ node_id: string; recipe: string }>;
  };
  const recipes = parseYaml(readFileSync(join(import.meta.dir, '../../graphs/ops/recipes.yaml'), 'utf8')) as Record<string, { command: string }>;
  const entry = graph.nodes.find((node) => node.node_id === graph.entry_node);

  expect(graph.loop.trigger.cron).toBe('*/10 * * * *');
  expect(entry?.recipe).toBe('cmd:silence-watch-shadow');
  expect(recipes['silence-watch-shadow']?.command).toContain('silence-watch.ts" --shadow');
});
