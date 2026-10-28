// SurfaceUx foundation 가드 — PLAN-cross-surface-ux-adapter §3a/3b/3c.
// 4프리미티브 어댑트 + fail-closed + nest-cap + spill/progress 위임을 고정.
import { test, expect, describe, spyOn } from 'bun:test';
import {
  resolveSurfaceUx,
  surfaceUxFromDispatchCtx,
  type SurfaceUxSource,
} from './build.js';
import { debug } from '../../debug/log.js';
import { wrapAutonomousTool } from './wrap.js';
import type { ConfirmChannel } from '../../hitl/confirm.js';
import type { QuestionChannel } from '../../hitl/question.js';
import type { FileSink } from '../../channel/file-sink.js';
import type { FeedbackEnvelope } from '../../feedback/envelope.js';

function fakeConfirmChannel(answer: boolean): ConfirmChannel {
  return { name: 'telegram', async request() { return answer; }, cancel() {} };
}
function fakeQuestionChannel(value: string): QuestionChannel {
  return {
    name: 'telegram',
    async ask(req) { return { answers: { [req.questions[0]!.header]: value }, cancelled: false }; },
    cancel() {},
  };
}
function failingQuestionChannel(): QuestionChannel {
  return {
    name: 'telegram',
    async ask() { throw new Error('transport unavailable'); },
    cancel() {},
  };
}
function captureFileSink(): { sink: FileSink; calls: Array<{ body: string; ext: string }> } {
  const calls: Array<{ body: string; ext: string }> = [];
  return { calls, sink: { sendFile(body, opts) { calls.push({ body, ext: opts.ext }); } } };
}
function captureEmit(): { emit: (e: FeedbackEnvelope) => void; envs: FeedbackEnvelope[] } {
  const envs: FeedbackEnvelope[] = [];
  return { envs, emit: (e) => { envs.push(e); } };
}

describe('SurfaceUx — confirm(fail-closed)', () => {
  test('채널 있으면 race 결과 반환(true)', async () => {
    const ux = resolveSurfaceUx({ surface: 'telegram', surfaceHitlChannels: [fakeConfirmChannel(true)] });
    expect(ux.interactive).toBe(true);
    expect(await ux.confirm({ prompt: 'PR 열까요?' })).toBe(true);
  });
  test('채널 없으면 fail-closed(false) + non-interactive', async () => {
    const ux = resolveSurfaceUx({ surface: 'acp' });
    expect(ux.interactive).toBe(false);
    expect(await ux.confirm({ prompt: 'PR 열까요?' })).toBe(false);
  });
  test('빈 배열도 fail-closed', async () => {
    const ux = resolveSurfaceUx({ surfaceHitlChannels: [] });
    expect(await ux.confirm({ prompt: 'x' })).toBe(false);
  });
});

describe('SurfaceUx — question / spill / progress 위임', () => {
  test('question 채널 있으면 구조화 답 반환과 answered 관측', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const ux = resolveSurfaceUx({ surface: 'telegram', surfaceQuestionChannels: [fakeQuestionChannel('opt-b')] });
      const res = await ux.question({ questions: [{ id: 'sel', header: 'sel', question: '?', options: [{ label: 'a', description: 'A' }, { label: 'b', description: 'B' }] }] });
      expect(res?.answers['sel']).toBe('opt-b');
      expect(log).toHaveBeenCalledWith('surface-ux.confirm', 'question', {
        surface: 'telegram',
        mode: 'answered',
      });
    } finally {
      log.mockRestore();
    }
  });
  test('question 채널 없으면 null과 noChannels 관측', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const ux = resolveSurfaceUx({ surface: 'pwa' });
      expect(await ux.question({ questions: [{ id: 'h', header: 'h', question: '?', options: [] }] })).toBeNull();
      expect(log).toHaveBeenCalledWith('surface-ux.confirm', 'question', {
        surface: 'pwa',
        mode: 'no-channels',
      });
    } finally {
      log.mockRestore();
    }
  });
  test('question 채널이 null 결과면 unanswered 관측', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const ux = resolveSurfaceUx({ surface: 'acp', surfaceQuestionChannels: [failingQuestionChannel()] });
      expect(await ux.question({ questions: [{ id: 'h', header: 'h', question: '?', options: [] }] })).toBeNull();
      expect(log).toHaveBeenCalledWith('surface-ux.confirm', 'question', {
        surface: 'acp',
        mode: 'unanswered',
      });
    } finally {
      log.mockRestore();
    }
  });
  test('question timeout cancels pending channel and records an explicit timeout outcome', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    let cancelled = 0;
    try {
      const ux = resolveSurfaceUx({ surface: 'tui', surfaceQuestionChannels: [{
        name: 'telegram',
        ask: async () => new Promise<null>(() => {}),
        cancel: () => { cancelled += 1; },
      }] });
      const result = await ux.question({ questions: [{ id: 'h', header: 'h', question: '?', options: [] }] }, { timeoutMs: 5 });
      expect(result).toBeNull();
      expect(cancelled).toBe(1);
      expect(log).toHaveBeenCalledWith('surface-ux.confirm', 'question', expect.objectContaining({
        surface: 'tui', mode: 'timeout', timeoutMs: 5,
      }));
    } finally {
      log.mockRestore();
    }
  });
  test('spillFile → FileSink.sendFile 위임', () => {
    const fs = captureFileSink();
    const ux = resolveSurfaceUx({ surfaceFileSink: fs.sink });
    ux.spillFile({ content: 'big diff', ext: 'diff', name: 'x.diff' });
    expect(fs.calls).toEqual([{ body: 'big diff', ext: 'diff' }]);
  });
  test('spillFile sink 없으면 no-op(throw 없음)', () => {
    const ux = resolveSurfaceUx({});
    expect(() => ux.spillFile({ content: 'x', ext: 'txt' })).not.toThrow();
  });
  test('progress → tool.progress 엔벨로프 emit', () => {
    const cap = captureEmit();
    const ux = resolveSurfaceUx({ sessionId: 's1', toolCallId: 't1', emitFeedback: cap.emit });
    ux.progress('시작…', { phase: 'start' });
    expect(cap.envs).toHaveLength(1);
    const e = cap.envs[0]!;
    expect(e.kind).toBe('tool.progress');
    expect(e.sessionId).toBe('s1');
    expect(e.parentToolCallId).toBe('t1');
    expect(e.phase).toBe('start');
    expect(e.asciiFallback).toEqual(['시작…']);
    // ★ telegram emitFeedback(task#22 part2-A M-UX 카드)이 읽는 계약 — payload.lines 고정.
    if (e.kind === 'tool.progress') expect(e.payload.lines).toEqual(['시작…']);
  });
  test('progress emit 없으면 no-op', () => {
    const ux = resolveSurfaceUx({});
    expect(() => ux.progress('x')).not.toThrow();
  });
});

describe('surfaceUxFromDispatchCtx — DaemonToolDispatchCtx 부분집합 수용', () => {
  test('ctx 4필드에서 SurfaceUx 구성 + surface override', async () => {
    const ctx: SurfaceUxSource = { sessionId: 's', surfaceHitlChannels: [fakeConfirmChannel(true)] };
    const ux = surfaceUxFromDispatchCtx(ctx, { surface: 'discord' });
    expect(ux.surface).toBe('discord');
    expect(await ux.confirm({ prompt: '?' })).toBe(true);
  });
});

describe('wrapAutonomousTool', () => {
  test('정상 실행 — spec.run 에 SurfaceUx 주입, 결과 반환', async () => {
    delete process.env.ELANOUS_NEST_DEPTH;
    const cap = captureEmit();
    let seenInteractive = false;
    const out = await wrapAutonomousTool(
      {
        toolNames: ['Demo'], label: 'Demo',
        async run({ ux }) { seenInteractive = ux.interactive; return { ok: true }; },
      },
      {},
      { sessionId: 's', emitFeedback: cap.emit, surfaceHitlChannels: [fakeConfirmChannel(true)] },
    );
    expect(out).toEqual({ ok: true });
    expect(seenInteractive).toBe(true);
    // 시작 ack + 완료 = 최소 2 progress
    expect(cap.envs.length).toBeGreaterThanOrEqual(2);
  });

  test('render spill → spillFile 위임 + 요약만 반환', async () => {
    delete process.env.ELANOUS_NEST_DEPTH;
    const fs = captureFileSink();
    const out = await wrapAutonomousTool(
      {
        toolNames: ['Demo'], label: 'Demo',
        async run() { return { big: 'X'.repeat(100) }; },
        render(r) { return { summary: { note: 'done' }, spill: { content: r.big, ext: 'txt' } }; },
      },
      {},
      { surfaceFileSink: fs.sink },
    );
    expect(out).toEqual({ note: 'done' });
    expect(fs.calls[0]?.body.length).toBe(100);
  });

  test('nest-cap 초과 → 코어 미실행 + 구조화 거부', async () => {
    process.env.ELANOUS_NEST_DEPTH = '9';
    process.env.ELANOUS_MAX_NEST_DEPTH = '3';
    let ran = false;
    const out = await wrapAutonomousTool(
      { toolNames: ['Demo'], label: 'Demo', async run() { ran = true; return {}; } },
      {},
      {},
    );
    expect(ran).toBe(false);
    expect((out as { error: string }).error).toContain('nest cap reached');
    delete process.env.ELANOUS_NEST_DEPTH;
    delete process.env.ELANOUS_MAX_NEST_DEPTH;
  });

  test('run throw → 구조화 에러 반환(턴 안 죽음)', async () => {
    delete process.env.ELANOUS_NEST_DEPTH;
    const out = await wrapAutonomousTool(
      { toolNames: ['Demo'], label: 'Demo', async run() { throw new Error('boom'); } },
      {},
      {},
    );
    expect((out as { error: string }).error).toContain('Demo failed: boom');
  });
});
