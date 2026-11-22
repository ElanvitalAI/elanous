// SEAT-STEER-PREEMPT ② 결정 우편 → 30초 안 선점 (OP #132479 ② · JUD-C #132473 재대조) —
//   합성 경로 «결정 우편(원장 도착) → 분류(isDecisionMail · 구조화 intent) → 전달(mid-turn steer 오퍼) →
//   선점(urgent steer → 실행 중 요청 중단 → 다음 요청에 결정 반영)» 을 그대로 통과하는 n=20 p95 분포.
//   이전 p95 시험(#39660)이 직접 호출하던 pending 삽입·signalUrgentSteer 은 이 시험에서 한 번도
//   직접 부르지 않는다 — 도착(adapter 배열) → seatMailOnArrived(busy) → offerSeatMailSteer(분류) →
//   실제 steer inbox push(내부에서 pending 등록·urgent 시그널) → 실제 tool loop 선점까지 전부 실경로.
//   보안 HOLD(b5c5c3b3) 보존 대조: 결정 아닌 우편은 urgent=false 로 전달돼 선점하지 않는다.
import { expect, test } from 'bun:test';
import type { LLMProvider, LLMStreamEvent } from '../llm.js';
import { streamLLMWithTools } from '../llm.js';
import { seatMailOnArrived } from './seat-mail-on-arrived.js';
import { offerSeatMailSteer } from './seat-mail-midturn-steer.js';
import { createNextTuiSteerInbox } from '../repl/next-tui-steer.js';
import { drainPendingUserInput } from '../session/pending-input.js';
import type { SeatMailArrivalInfo } from './seat-mail-arrival.js';

const PREEMPT_BUDGET_MS = 30_000; // «결정 우편 → 30초 안 선점» 상한 (OP #132157 ② · #129162)

type Sample = { run: number; mailboxToPreemptMs: number };

function hangingFirstRequestProvider(run: number, seen: string[][], markAborted: () => void, enteredFirst: () => void): LLMProvider {
  return {
    name: `decision-preempt-provider-${run}`, defaultModel: `decision-preempt-model-${run}`, available: () => true,
    async *chat() { yield 'unused'; },
    streamChat(messages, options) {
      seen.push(messages.filter((m) => m.role === 'user').map((m) => String(m.content)));
      if (seen.length > 1) return (async function* () { yield { type: 'text', delta: 'decision received' } as LLMStreamEvent; })();
      options?.signal?.addEventListener('abort', () => { markAborted(); });
      return {
        [Symbol.asyncIterator]() { return this; },
        next() { enteredFirst(); return new Promise<IteratorResult<LLMStreamEvent, void>>(() => {}); },
        async return() { return { done: true, value: undefined }; },
      } as AsyncGenerator<LLMStreamEvent, void, unknown>;
    },
  };
}

test('SEAT-STEER-PREEMPT ② 결정 우편 → 분류 → 전달 → 선점: 실 배달 경로 그대로 n=20 · p95 기록 (OP #132479 ②)', async () => {
  const N = 20;
  const samples: Sample[] = [];
  for (let run = 1; run <= N; run++) {
    const sessionId = `decision-preempt-run-${run}`;
    const seen: string[][] = [];
    let aborted = false;
    let enteredFirst = () => {};
    const first = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const provider = hangingFirstRequestProvider(run, seen, () => { aborted = true; }, enteredFirst);
    const result = streamLLMWithTools([{ role: 'user', content: 'initial work' }],
      { onText() {}, dispatchTool: async () => 'unused' },
      { provider, model: provider.defaultModel, tools: [{ name: 'probe', description: '', parameters: { type: 'object' } }],
        sessionId, maxTurns: 2, drainPendingUserInput: () => drainPendingUserInput(sessionId) });
    await first;

    // 실제 한 턴의 steer inbox — entry.ts:2233 배선과 같은 구성요소(실제 push → pending 등록·urgent 시그널).
    const inbox = createNextTuiSteerInbox(sessionId, () => {});
    let serial = 0;
    // 결정 우편 도착 — watcher 가 onArrived 에 넘기는 도착 배열과 같은 모양(msgId·본문·intent).
    const decisionText = `OP decision run ${run}: stop and report`;
    const arrivals: SeatMailArrivalInfo[] = [{ msgId: 900000 + run, seat: 'OP', text: decisionText, sender: 'OP', intent: 'decision' }];
    const tMailbox = performance.now();
    // 실 도착 배선: busy 턴 → 중도 이벤트 → 결정 분류 → urgent steer 오퍼(거부 시 이벤트함 폴백).
    seatMailOnArrived({
      busy: () => true,
      injectKey() { throw new Error('idle door must not open while busy'); },
      queueWake: null,
      enqueueMidTurn: (event) => offerSeatMailSteer(event, (steerId, text, urgent, seatMail) => inbox.push(steerId, text, urgent === true, seatMail), () => ++serial) !== null,
      removeQueuedNotice: () => 0,
    })(arrivals);

    expect(await Promise.race([result, new Promise<string>((_, reject) => setTimeout(() => reject(new Error('decision mail did not preempt')), PREEMPT_BUDGET_MS))])).toBe('decision received');
    const tPreempt = performance.now();
    expect(aborted).toBe(true); // 실행 중 첫 요청이 중단됐다(선점)
    expect(seen).toHaveLength(2);
    expect(seen[1]?.some((s) => s.includes(decisionText))).toBe(true); // 다음 요청에 결정 본문이 반영됐다
    samples.push({ run, mailboxToPreemptMs: tPreempt - tMailbox });
    inbox.finish();
  }
  expect(samples).toHaveLength(N);
  const sorted = samples.map((s) => s.mailboxToPreemptMs).sort((a, b) => a - b);
  const p95 = sorted[Math.min(N - 1, Math.ceil(0.95 * N) - 1)]!;
  const max = sorted[N - 1]!;
  // eslint-disable-next-line no-console
  console.log(`[SEAT-STEER-PREEMPT decision-mail] n=${N} p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms budget=${PREEMPT_BUDGET_MS}ms samples=[${sorted.map((v) => v.toFixed(1)).join(',')}]`);
  expect(p95).toBeLessThanOrEqual(PREEMPT_BUDGET_MS);
  expect(max).toBeLessThanOrEqual(PREEMPT_BUDGET_MS);
}, 60_000);

test('대조(보안 HOLD b5c5c3b3 보존): 결정 아닌 우편은 urgent 없이 전달돼 선점하지 않는다', async () => {
  const sessionId = 'decision-preempt-ordinary-control';
  const seen: string[][] = [];
  let aborted = false;
  let enteredFirst = () => {};
  const first = new Promise<void>((resolve) => { enteredFirst = resolve; });
  const provider = hangingFirstRequestProvider(0, seen, () => { aborted = true; }, enteredFirst);
  const result = streamLLMWithTools([{ role: 'user', content: 'initial work' }],
    { onText() {}, dispatchTool: async () => 'unused' },
    { provider, model: provider.defaultModel, tools: [{ name: 'probe', description: '', parameters: { type: 'object' } }],
      sessionId, maxTurns: 2, drainPendingUserInput: () => drainPendingUserInput(sessionId) });
  await first;
  const inbox = createNextTuiSteerInbox(sessionId, () => {});
  let serial = 0;
  const arrivals: SeatMailArrivalInfo[] = [{ msgId: 910001, seat: 'UX', text: '일반 우편 — 선점 없음', sender: 'UX', intent: undefined }];
  seatMailOnArrived({
    busy: () => true,
    injectKey() { throw new Error('idle door must not open while busy'); },
    queueWake: null,
    enqueueMidTurn: (event) => offerSeatMailSteer(event, (steerId, text, urgent, seatMail) => inbox.push(steerId, text, urgent === true, seatMail), () => ++serial) !== null,
    removeQueuedNotice: () => 0,
  })(arrivals);
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(aborted).toBe(false); // 결정이 아니면 실행 중 요청을 끊지 않는다
  expect(seen).toHaveLength(1);
  inbox.finish(); // 다음 턴으로 이월(실계약: 유실 0)
  // 대기 중 첫 요청 정리 — 이 대조의 관심사는 «선점 안 함» 이므로 프로미스를 버린다(터미널 경합 없음).
  void result;
});
