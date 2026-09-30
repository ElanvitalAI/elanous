// cascade-zyu W8-A 옵션 B (2026-05-14) — `createMissionTurnEmitter` tests.
//
// Validates:
//   1. start() emits 1 envelope · kind=mission.update · op=start · status=running
//   2. end('done') emits 1 envelope · op=end · status=done · progress=1
//   3. end('error') emits 1 envelope · op=end · status=error · progress omitted
//   4. title derivation: trim · first line · 60-char cap (with ellipsis)
//   5. broadcast 예외 시 emitter 자체는 throw 안 함 (telemetric only)
//   6. blockId 가 sessionId:mission:<missionId> shape

import { describe, expect, test } from 'bun:test';
import { createMissionTurnEmitter, type AcpBroadcastFn } from '../src/acp/mission-turn-emit.js';
import { parseElanousFeedbackEnvelope } from '../src/acp/elanous-extensions.js';
import type { FeedbackEnvelope } from '../src/feedback/envelope.js';

type CapturedUpdate = {
  sessionId: string;
  text: string;
  envelope: FeedbackEnvelope | null;
};

function capture(): { broadcast: AcpBroadcastFn; updates: CapturedUpdate[] } {
  const updates: CapturedUpdate[] = [];
  const broadcast: AcpBroadcastFn = async (sessionId, update) => {
    const text = update.content.text;
    const parsed = parseElanousFeedbackEnvelope(text);
    updates.push({
      sessionId,
      text,
      envelope: parsed?.payload ?? null,
    });
  };
  return { broadcast, updates };
}

const fixedNow = (t = 1_700_000_000_000): (() => number) => () => t;

describe('createMissionTurnEmitter · start/end lifecycle', () => {
  test('start() emits running/op=start envelope', async () => {
    const cap = capture();
    const emitter = createMissionTurnEmitter({
      sessionId: 'sid-A',
      userText: 'hello world',
      broadcast: cap.broadcast,
      missionIdOverride: 'm-1',
      now: fixedNow(),
    });
    await emitter.start();

    expect(cap.updates).toHaveLength(1);
    const env = cap.updates[0]!.envelope;
    expect(env).not.toBeNull();
    if (env && env.kind === 'mission.update') {
      expect(env.payload.op).toBe('start');
      expect(env.payload.status).toBe('running');
      expect(env.payload.missionId).toBe('m-1');
      expect(env.payload.title).toBe('hello world');
      expect(env.blockId).toBe('sid-A:mission:m-1');
    }
  });

  test('end(done) emits done/op=end · progress=1', async () => {
    const cap = capture();
    const emitter = createMissionTurnEmitter({
      sessionId: 'sid-A',
      userText: 'go',
      broadcast: cap.broadcast,
      missionIdOverride: 'm-1',
      now: fixedNow(),
    });
    await emitter.end('done');

    expect(cap.updates).toHaveLength(1);
    const env = cap.updates[0]!.envelope;
    if (env && env.kind === 'mission.update') {
      expect(env.payload.op).toBe('end');
      expect(env.payload.status).toBe('done');
      expect(env.payload.progress).toBe(1);
    }
  });

  test('end(error) emits error/op=end · progress omitted', async () => {
    const cap = capture();
    const emitter = createMissionTurnEmitter({
      sessionId: 'sid-A',
      userText: 'go',
      broadcast: cap.broadcast,
      missionIdOverride: 'm-1',
      now: fixedNow(),
    });
    await emitter.end('error');

    const env = cap.updates[0]!.envelope;
    if (env && env.kind === 'mission.update') {
      expect(env.payload.op).toBe('end');
      expect(env.payload.status).toBe('error');
      expect(env.payload.progress).toBeUndefined();
    }
  });
});

describe('createMissionTurnEmitter · title derivation', () => {
  test('trim 공백 + 첫 line', async () => {
    const cap = capture();
    const emitter = createMissionTurnEmitter({
      sessionId: 'sid',
      userText: '  first line\nsecond line\nthird',
      broadcast: cap.broadcast,
      missionIdOverride: 'm',
      now: fixedNow(),
    });
    await emitter.start();
    const env = cap.updates[0]!.envelope;
    if (env && env.kind === 'mission.update') {
      expect(env.payload.title).toBe('first line');
    }
  });

  test('60-char cap + ellipsis suffix', async () => {
    const cap = capture();
    const longText = 'a'.repeat(120);
    const emitter = createMissionTurnEmitter({
      sessionId: 'sid',
      userText: longText,
      broadcast: cap.broadcast,
      missionIdOverride: 'm',
      now: fixedNow(),
    });
    await emitter.start();
    const env = cap.updates[0]!.envelope;
    if (env && env.kind === 'mission.update') {
      expect(env.payload.title.length).toBe(60);
      expect(env.payload.title.endsWith('…')).toBe(true);
    }
  });

  test('빈 userText → "chat turn" fallback', async () => {
    const cap = capture();
    const emitter = createMissionTurnEmitter({
      sessionId: 'sid',
      userText: '   \n\n  ',
      broadcast: cap.broadcast,
      missionIdOverride: 'm',
      now: fixedNow(),
    });
    await emitter.start();
    const env = cap.updates[0]!.envelope;
    if (env && env.kind === 'mission.update') {
      expect(env.payload.title).toBe('chat turn');
    }
  });
});

describe('createMissionTurnEmitter · resilience', () => {
  test('broadcast 가 throw 해도 emitter 는 throw 안 함', async () => {
    const failBroadcast: AcpBroadcastFn = async () => {
      throw new Error('peer disconnected');
    };
    const emitter = createMissionTurnEmitter({
      sessionId: 'sid',
      userText: 'x',
      broadcast: failBroadcast,
      missionIdOverride: 'm',
      now: fixedNow(),
    });
    await expect(emitter.start()).resolves.toBeUndefined();
    await expect(emitter.end('done')).resolves.toBeUndefined();
  });
});
