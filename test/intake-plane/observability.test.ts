import { createHash } from 'node:crypto';
import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../../src/debug/log.js';
import { handleTextChannelIntakeCommand } from '../../src/intake-plane/channel-command.js';
import { resolveIntakeSlash } from '../../src/intake-plane/slash.js';
import { getIntakeStore, setIntakeStoreForTest } from '../../src/intake-plane/runtime.js';
import { createIntakeStore } from '../../src/intake-plane/store.js';
import type { PipelineRunResult } from '../../src/intake-plane/pipeline-runner.js';

type DebugEvent = { category: string; event: string; data?: Record<string, unknown> };

function recordDebugEvents(): { events: DebugEvent[]; restore: () => void } {
  const events: DebugEvent[] = [];
  const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
    events.push({ category, event, data });
  }) as never);
  return { events, restore: () => spy.mockRestore() };
}

function pipelineWithOneTask(): PipelineRunResult {
  return {
    enriched: {
      missions: [{
        tasks: [{
          id: 'task-1',
          title: 'Observed task',
          intent: 'Preserve intake observability',
          refs: ['src/intake-plane/slash.ts'],
          confidence: 'high',
          invariants: [{
            condition: 'existing intake behavior remains reachable',
            verification: 'bun test test/intake-plane/observability.test.ts',
            expected: 'focused test passes',
          }],
          decisionSignals: [{
            condition: 'harness dispatch starts',
            observation: 'debug event count',
            expected: 'one or more',
          }],
          context: { enrichments: [] },
        }],
      }],
    },
    decomposition: { rationale: 'test pipeline' },
  } as unknown as PipelineRunResult;
}

function assertSafeTextMetadata(event: DebugEvent, text: string): void {
  expect(event.data).toMatchObject({ textLength: text.length });
  expect(typeof event.data?.textHash).toBe('string');
  expect(event.data?.textHash).toHaveLength(64);
  if (text) expect(JSON.stringify(event.data)).not.toContain(text);
}

describe('intake plane observability', () => {
  test('shared channel entry records Telegram and Discord sources without intake text', async () => {
    const { events, restore } = recordDebugEvents();
    const store = createIntakeStore({ archiveDir: null });
    const body = 'private channel intake body';
    try {
      for (const source of ['telegram', 'discord'] as const) {
        await handleTextChannelIntakeCommand(['now', body], {
          surface: source,
          source,
          text: body,
          store,
          createIntakeId: () => `intake-${source}`,
        });
      }
    } finally {
      restore();
    }
    const channelEvents = events.filter((event) => event.category === 'intake-plane.channel');
    const received = channelEvents.filter((event) => event.event === 'received');
    const ingested = channelEvents.filter((event) => event.event === 'ingested');
    expect(received.map((event) => event.data?.source)).toEqual(['telegram', 'discord']);
    expect(ingested.map((event) => event.data?.source)).toEqual(['telegram', 'discord']);
    expect(received.map((event) => event.data?.intakeId)).toEqual(['intake-telegram', 'intake-discord']);
    expect(ingested.map((event) => event.data?.intakeId)).toEqual(['intake-telegram', 'intake-discord']);
    expect(ingested.map((event) => event.data?.state)).toEqual(['clarifying', 'clarifying']);
    for (const event of channelEvents) assertSafeTextMetadata(event, body);
  });

  test('channel existing-session commands record safe subcommand metadata before capture delegation', async () => {
    const { events, restore } = recordDebugEvents();
    const store = createIntakeStore({ archiveDir: null });
    const body = 'private channel capture body';
    const trace: string[] = [];
    const capture = store.capture.bind(store);
    store.capture = ((record) => {
      if (record.intakeId === 'intake-channel-capture') {
        trace.push(events.some((event) => event.category === 'intake-plane.channel'
          && event.event === 'existing-session-command'
          && event.data?.subcommand === 'capture')
          ? 'existing-session-command'
          : 'missing-existing-session-command');
        trace.push('capture');
      }
      return capture(record);
    }) as typeof store.capture;
    try {
      await handleTextChannelIntakeCommand(['capture', body], {
        surface: 'telegram',
        source: 'telegram',
        text: body,
        store,
        createIntakeId: () => 'intake-channel-capture',
      });
      await handleTextChannelIntakeCommand(['now', '--', body], {
        surface: 'telegram',
        source: 'telegram',
        text: body,
        store,
        createIntakeId: () => 'intake-channel-now',
      });
    } finally {
      restore();
    }
    const channelEvents = events.filter((event) => event.category === 'intake-plane.channel');
    const existingSessionCommand = channelEvents.find((event) => event.event === 'existing-session-command');
    expect(existingSessionCommand?.data?.subcommand).toBe('capture');
    expect(existingSessionCommand?.data).toMatchObject({
      textLength: 'capture'.length,
      textHash: createHash('sha256').update('capture').digest('hex'),
    });
    expect(JSON.stringify(existingSessionCommand?.data)).not.toContain(body);
    expect(trace).toEqual(['existing-session-command', 'capture']);
    expect(channelEvents.some((event) => event.event === 'received')).toBe(true);
    expect(channelEvents.some((event) => event.event === 'ingested')).toBe(true);
  });

  test('runtime store initialization records progress with safe empty-body metadata', () => {
    const { events, restore } = recordDebugEvents();
    try {
      setIntakeStoreForTest(null);
      getIntakeStore();
    } finally {
      setIntakeStoreForTest(null);
      restore();
    }
    const ready = events.find((event) => event.category === 'intake-plane.runtime' && event.event === 'store-ready');
    expect(ready).toBeDefined();
    expect(ready?.data?.source).toBe('runtime');
    expect(ready?.data?.stage).toBe('store-ready');
    assertSafeTextMetadata(ready!, '');
  });

  test('/intake implement retains pre-launch observation when harness dispatch fails', async () => {
    const { events, restore } = recordDebugEvents();
    const store = createIntakeStore({ archiveDir: null });
    const body = 'private slash intake body';
    try {
      await resolveIntakeSlash(['capture', body], { store, createIntakeId: () => 'intake-observed' });
      await resolveIntakeSlash(['implement'], {
        store,
        runPipeline: async () => pipelineWithOneTask(),
        dispatchHarness: async () => { throw new Error('launch failed'); },
      });
    } finally {
      restore();
    }
    const launching = events.filter((event) => event.category === 'intake-plane.slash' && event.event === 'harness-launching');
    const launched = events.filter((event) => event.category === 'intake-plane.slash' && event.event === 'harness-launched');
    expect(launching).toHaveLength(1);
    expect(launched).toHaveLength(0);
    expect(launching[0]?.data?.source).toBe('tui-scratch');
    assertSafeTextMetadata(launching[0]!, body);
  });

  test('/intake implement records post-launch only after successful harness dispatch', async () => {
    const { events, restore } = recordDebugEvents();
    const store = createIntakeStore({ archiveDir: null });
    const body = 'private successful slash intake body';
    try {
      await resolveIntakeSlash(['capture', body], { store, createIntakeId: () => 'intake-observed' });
      await resolveIntakeSlash(['implement'], {
        store,
        runPipeline: async () => pipelineWithOneTask(),
        dispatchHarness: async () => ({ output: 'launched' }),
      });
    } finally {
      restore();
    }
    const slash = events.filter((event) => event.category === 'intake-plane.slash');
    // 발사 전 점검(#20962 대상 저장소 가드)은 수명 사건이 아니다 — 먼저 ok 로 와야 하고, 본문 메타데이터는 싣지 않는다.
    expect(slash[0]).toMatchObject({ event: 'harness-target', data: { ok: true } });
    const lifecycle = slash.filter((event) => event.event !== 'harness-target');
    expect(lifecycle.map((event) => event.event)).toEqual(['harness-launching', 'harness-launched']);
    for (const event of lifecycle) assertSafeTextMetadata(event, body);
  });
});
