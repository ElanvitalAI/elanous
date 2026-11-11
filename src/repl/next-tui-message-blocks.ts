import type { MessageBlock, MessageBlockDetail, MessageBlockKind } from '../conv-substrate/message-block.js';

export interface NextTuiRawDetailRef { readonly runId: string; readonly blockId: string }

export interface NextTuiMessageBlockEmitter {
  progress(text: string, steps?: readonly string[]): void;
  thought(text: string, reasoning?: boolean): void;
  status(text: string): void;
  error(text: string): void;
  toolCall(call: { id: string; name: string; args: Record<string, unknown> }): void;
  toolResult(call: { id: string; name: string; result: unknown }): void;
}

export function createNextTuiMessageBlockEmitter(input: {
  sessionId: string;
  runId: string;
  emit(block: MessageBlock): void;
}): NextTuiMessageBlockEmitter {
  let sequence = 0;
  let thoughtId: string | undefined;
  let thoughtText = '';
  const timestamps = new Map<string, number>();
  const now = (id: string): number => {
    const timestamp = timestamps.get(id) ?? Date.now();
    timestamps.set(id, timestamp);
    return timestamp;
  };
  const ref = (blockId: string): NextTuiRawDetailRef => ({ runId: input.runId, blockId });
  const details = (blockId: string, summary: string, steps: readonly string[] = [], rawAvailable = false): MessageBlockDetail => ({
    level: rawAvailable ? 3 : steps.length ? 2 : 1, summary, ...(steps.length ? { steps } : {}),
    ...(rawAvailable ? { rawRef: ref(blockId) } : {}),
  });
  const push = (id: string, body: MessageBlockKind, detail: MessageBlockDetail): void => {
    const source = body.kind === 'tool-call' ? 'tool' : body.kind === 'status' || body.kind === 'error' ? 'system' : 'agent';
    input.emit({ id, ts: now(id), source, body, detail });
  };
  return {
    progress(text, steps = []) {
      const id = `${input.sessionId}:${input.runId}:progress:${++sequence}`;
      push(id, { kind: 'plan', ref: text }, details(id, text, steps));
    },
    thought(text, reasoning = false) {
      thoughtId ??= `${input.sessionId}:${input.runId}:thought:${++sequence}`;
      thoughtText += text;
      const blockId = thoughtId;
      const sentences = thoughtText.split(/(?<=[.!?。！？])\s|\n/).map((line) => line.trim()).filter(Boolean);
      input.emit({ id: blockId, ts: now(blockId), source: 'agent', body: { kind: 'thought', text: thoughtText, reasoning },
        detail: details(blockId, sentences[0] ?? thoughtText, sentences.slice(1)) });
    },
    status(text) {
      const id = `${input.sessionId}:${input.runId}:status:${++sequence}`;
      push(id, { kind: 'status', text }, details(id, text));
    },
    error(text) {
      const id = `${input.sessionId}:${input.runId}:error:${++sequence}`;
      push(id, { kind: 'error', text }, details(id, text));
    },
    toolCall(call) {
      const id = `${input.sessionId}:${input.runId}:tool:${call.id}`;
      push(id, { kind: 'tool-call', toolCallId: call.id, title: call.name, status: '실행 중' },
        details(id, `${call.name} 실행`, ['입력 준비', '도구 실행'], true));
    },
    toolResult(call) {
      const id = `${input.sessionId}:${input.runId}:tool:${call.id}`;
      input.emit({ id, ts: now(id), source: 'tool', body: {
        kind: 'tool-call', toolCallId: call.id, title: call.name,
        status: call.result && typeof call.result === 'object' && 'error' in call.result ? '실패' : '완료',
      }, detail: details(id, `${call.name} 결과`, ['호출 인자 전달', '도구 결과 수신'], true) });
    },
  };
}
