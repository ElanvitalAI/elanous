import { describe, expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentProps } from 'react';
import { leaksInternal } from './public-text';
import { EMPTY_DECISIONS, parseDecision, reduceDecisions } from './pty-decisions';
import { PtyDecisionScene } from './PtyDecisionScene';
import type { TerminalStreamEvent } from '@/lib/terminal-stream';

const raw = {
  ts: '2026-10-03T08:35:00Z', missionId: 'one', seq: 1, sessionId: 'session',
  terminalId: 'terminal', agent: 'codex', step: 'read', text: '읽기',
};
const event = (patch: Record<string, unknown>) => parseDecision({ ...raw, ...patch })!;

type Client = ComponentProps<typeof PtyDecisionScene>['client'];
function fakeClient() {
  const calls = { snapshot: [] as string[], stream: [] as string[], dispose: 0, control: 0, input: 0 };
  let onEvent: ((ev: TerminalStreamEvent) => void) | undefined;
  const client = {
    snapshotTerminal: async (id: string) => { calls.snapshot.push(id); return { status: 'success' as const, screen: 'ready' }; },
    streamTerminal: (id: string, _opts: unknown, callback: (ev: TerminalStreamEvent) => void) => {
      calls.stream.push(id);
      onEvent = callback;
      return () => { calls.dispose++; };
    },
    controlTerminal: () => { calls.control++; throw new Error('control prohibited'); },
    sendTerminalText: () => { calls.input++; throw new Error('input prohibited'); },
    sendTerminalKey: () => { calls.input++; throw new Error('input prohibited'); },
  };
  return { client: client as Client, calls, emit: (ev: TerminalStreamEvent) => onEvent?.(ev) };
}

describe('PTY decision scene', () => {
  test('waits for a terminal with an empty decision state; responsive and readable at 1440', () => {
    const { client, calls } = fakeClient();
    const html = renderToStaticMarkup(<PtyDecisionScene client={client} decisions={EMPTY_DECISIONS} />);
    expect(html).toContain('터미널을 기다리는 중');
    expect(html).toContain('판단을 기다리는 중');
    expect(html).toContain('grid-cols-1');
    expect(html).toContain('min-[1440px]:grid-cols-2');
    expect(html).toContain('min-[1440px]:text-[22px]');
    expect(calls.snapshot).toHaveLength(0);
    expect(calls.stream).toHaveLength(0);
  });

  test('shows ordered steps, two-line answer/recovery, result variants and highlights current step without leaking markers', () => {
    const steps = [
      event({ seq: 1, text: 'OP /home/ubuntu/private/secret' }),
      event({ seq: 2, step: 'judge', text: '판단' }),
      event({ seq: 3, step: 'input', text: '입력' }),
      event({ seq: 4, step: 'answer', text: '답변', detail: { question: 'TC 허용?', answer: 'UX 승인' } }),
      event({ seq: 5, step: 'recover', text: '복구', detail: { blocked: 'MK 차단', action: 'OP 재시도' } }),
      event({ seq: 6, step: 'done', text: '완료', detail: { result: { kind: 'pr', ref: 'https://github.com/org/repo/pull/12' } } }),
    ];
    const { client } = fakeClient();
    const decisions = steps.reduce(reduceDecisions, EMPTY_DECISIONS);
    const html = renderToStaticMarkup(<PtyDecisionScene client={client} decisions={decisions} />);
    for (const step of ['read', 'judge', 'input', 'answer', 'recover', 'done']) expect(html).toContain(`>${step}</span>`);
    expect(html.indexOf('읽기')).toBeLessThan(html.indexOf('완료'));
    expect(html).toContain('물음 → CTO 허용?');
    expect(html).toContain('답 → CXO 승인');
    expect(html).toContain('막힘 → CMO 차단');
    expect(html).toContain('처리 → COO 재시도');
    expect(html).toContain('href="https://github.com/org/repo/pull/12"');
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(leaksInternal(html)).toEqual([]);
    for (const result of [
      { kind: 'file', ref: '/home/ubuntu/project/report.md' },
      { kind: 'text', ref: '완료 요약' },
    ] as const) {
      const state = reduceDecisions(EMPTY_DECISIONS, event({ step: 'done', detail: { result } }));
      const output = renderToStaticMarkup(<PtyDecisionScene client={client} decisions={state} />);
      expect(output).toContain(result.kind === 'file' ? 'report.md' : '완료 요약');
      expect(leaksInternal(output)).toEqual([]);
    }
  });

  test('uses snapshot and stream frame dimensions and keeps rows beyond 40 and long lines intact', async () => {
    const { client, emit, calls } = fakeClient();
    client.snapshotTerminal = async (id) => {
      calls.snapshot.push(id);
      return { status: 'success', screen: `[screen 132x55 cursor=(row 54, col 0, visible true)]\n${Array.from({ length: 55 }, (_, i) => `row-${i}`).join('\n')}` };
    };
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const state = reduceDecisions(EMPTY_DECISIONS, event({}));
    let root: ReturnType<typeof create> | undefined;
    try {
      await act(async () => { root = create(<PtyDecisionScene client={client} decisions={state} />); await new Promise((resolve) => setTimeout(resolve, 30)); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
      expect(JSON.stringify(root!.toJSON())).toContain('row-54');
      const wide = 'wide line '.repeat(15);
      const overflow = 'overflow-'.repeat(25); // 225 chars > 160 columns: xterm soft-wraps it (review must-fix · INSIDE1f)
      await act(async () => {
        emit({ type: 'screen', screen: `[screen 160x65 cursor=(row 64, col 0, visible true)]\n${Array.from({ length: 65 }, (_, i) => i === 0 ? wide : i === 1 ? overflow : `line-${i}`).join('\n')}` });
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
      const output = JSON.stringify(root!.toJSON());
      expect(output).toContain('line-64');
      expect(output).toContain(wide);
      expect(output).toContain(overflow); // one source line, no newline inserted at the wrap
      expect(output).not.toContain('[screen 160x65');
      expect(leaksInternal(output)).toEqual([]);
    } finally {
      if (root) await act(async () => { root!.unmount(); });
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
    expect(calls.control).toBe(0);
    expect(calls.input).toBe(0);
  });

  test('keeps the end status when the preceding screen write completes afterward', async () => {
    const { client, emit, calls } = fakeClient();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const state = reduceDecisions(EMPTY_DECISIONS, event({}));
    let root: ReturnType<typeof create> | undefined;
    try {
      await act(async () => { root = create(<PtyDecisionScene client={client} decisions={state} />); await new Promise((resolve) => setTimeout(resolve, 30)); });
      await act(async () => {
        emit({ type: 'screen', screen: '[screen 80x24 cursor=(row 0, col 0, visible true)]\nlast frame' });
        emit({ type: 'end', reason: 'done' });
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(JSON.stringify(root!.toJSON())).toContain('last frame');
      expect(JSON.stringify(root!.toJSON())).toContain('PTY 가 끝났습니다');
    } finally {
      if (root) await act(async () => { root!.unmount(); });
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
    expect(calls.control).toBe(0);
    expect(calls.input).toBe(0);
  });

  test('preserves the end message after a pending poll rejects and a late status arrives', async () => {
    const { client, calls } = fakeClient();
    let emit: ((ev: TerminalStreamEvent) => void) | undefined;
    let fallback: (() => void) | undefined;
    let rejectPoll: ((reason: Error) => void) | undefined;
    let snapshots = 0;
    client.snapshotTerminal = async (id) => {
      calls.snapshot.push(id);
      if (++snapshots === 1) return { status: 'success', screen: 'last frame' };
      return new Promise((_, reject) => { rejectPoll = reject; });
    };
    client.streamTerminal = (id, _opts, callback, onFallback) => {
      calls.stream.push(id);
      emit = callback;
      fallback = () => onFallback('stream disconnected');
      return () => { calls.dispose++; };
    };
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const state = reduceDecisions(EMPTY_DECISIONS, event({}));
    let root: ReturnType<typeof create> | undefined;
    try {
      await act(async () => { root = create(<PtyDecisionScene client={client} decisions={state} />); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
      await act(async () => { fallback!(); });
      expect(rejectPoll).toBeDefined();
      await act(async () => { emit!({ type: 'end', reason: 'done' }); });
      await act(async () => { rejectPoll!(new Error('poll failed')); });
      expect(JSON.stringify(root!.toJSON())).toContain('PTY 가 끝났습니다');
      await act(async () => { emit!({ type: 'status', status: 'reconnecting' }); });
      expect(JSON.stringify(root!.toJSON())).toContain('PTY 가 끝났습니다');
      expect(JSON.stringify(root!.toJSON())).not.toContain('터미널 화면을 기다리는 중');
    } finally {
      if (root) await act(async () => { root!.unmount(); });
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
    expect(calls.control).toBe(0);
    expect(calls.input).toBe(0);
  });

  test('reads only the current child terminal, replaces screen on stream events and disposes on mission switch', async () => {
    const { client, calls, emit } = fakeClient();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const first = reduceDecisions(EMPTY_DECISIONS, event({}));
    const second = reduceDecisions(first, event({ missionId: 'two', terminalId: 'second', ts: '2026-10-03T08:36:00Z' }));
    let root: ReturnType<typeof create> | undefined;
    try {
      await act(async () => { root = create(<PtyDecisionScene client={client} decisions={first} />); await new Promise((resolve) => setTimeout(resolve, 30)); });
      expect(calls.snapshot).toEqual(['terminal']);
      expect(calls.stream).toEqual(['terminal']);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(JSON.stringify(root!.toJSON())).toContain('ready');
      await act(async () => { emit({ type: 'screen', screen: 'changed' }); await new Promise((resolve) => setTimeout(resolve, 20)); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(JSON.stringify(root!.toJSON())).toContain('changed');
      await act(async () => { root!.update(<PtyDecisionScene client={client} decisions={second} />); });
      expect(calls.stream).toEqual(['terminal', 'second']);
      expect(calls.dispose).toBe(1);
      expect(JSON.stringify(root!.toJSON())).not.toContain('changed');
    } finally {
      if (root) await act(async () => { root!.unmount(); });
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
    expect(calls.dispose).toBe(2);
    expect(calls.control).toBe(0);
    expect(calls.input).toBe(0);
  });
});
