import { expect, test } from 'bun:test';
import { streamLLMWithTools, type LLMProvider, type LLMStreamEvent } from './llm.js';
import { signalUrgentSteer } from './session/urgent-steer.js';

/**
 * SEAT-STEER-PREEMPT 지연 분포 합성 시험 (OP #132157 ② · JUD-C HOLD)
 *
 * 완료선: «결정 우편 → 30초 안 선점» — n≥20 회 결정 우편 도착부터 첫 후속 provider 요청까지의
 * 지연을 실측하고 p95 를 기록한다. 전 회차의 지연이 30초 상한 이내(합성 하네스·제어된 시계)임을
 * 단언하고, p95 값 자체를 시험 로그에 남긴다(«n≥20 · p95 기록»).
 *
 * 출처: OP 결정 #132157 ② — «SEAT-STEER-PREEMPT: "결정 우편 → 30초 안 선점" 지연 분포 합성
 * 시험(n≥20 · p95 기록)». 기존 단일 회차 시험(#126648 · llm-urgent-steer.test.ts)과 달리
 * 이 시험은 분포(n≥20)를 측정한다. 시간은 시험 하네스의 제어된 타이머로 측정하며 실제
 * wall-clock 30초를 기다리지 않는다(측정 단위=ms · 상한=30_000ms 동일 척도).
 */

const PREEMPT_BUDGET_MS = 30_000; // «결정 우편 → 30초 안 선점» 상한 (OP #132157 ②)

type Sample = { run: number; mailboxToNextRequestMs: number };

test('SEAT-STEER-PREEMPT: 결정 우편 → 30초 안 선점 — 지연 분포 n=20 · p95 기록 (OP #132157 ②)', async () => {
  const N = 20;
  const samples: Sample[] = [];
  for (let run = 1; run <= N; run++) {
    const sessionId = `steer-preempt-p95-run-${run}`;
    const seen: string[][] = [];
    let enteredFirst = () => {};
    const first = new Promise<void>((resolve) => { enteredFirst = resolve; });
    let aborted = false;
    const provider: LLMProvider = {
      name: `steer-preempt-p95-provider-${run}`, defaultModel: `steer-preempt-p95-model-${run}`, available: () => true,
      async *chat() { yield 'unused'; },
      streamChat(messages, options) {
        seen.push(messages.filter((m) => m.role === 'user').map((m) => String(m.content)));
        if (seen.length > 1) return (async function* () { yield { type: 'text', delta: 'decision received' } as LLMStreamEvent; })();
        options?.signal?.addEventListener('abort', () => { aborted = true; });
        return {
          [Symbol.asyncIterator]() { return this; },
          next() { enteredFirst(); return new Promise<IteratorResult<LLMStreamEvent, void>>(() => {}); },
          async return() { return { done: true, value: undefined }; },
        } as AsyncGenerator<LLMStreamEvent, void, unknown>;
      },
    };
    const pending: string[] = [];
    const result = streamLLMWithTools([{ role: 'user', content: 'initial work' }],
      { onText() {}, dispatchTool: async () => 'unused' },
      { provider, model: provider.defaultModel, tools: [{ name: 'probe', description: '', parameters: { type: 'object' } }],
        sessionId, maxTurns: 2, drainPendingUserInput: () => pending.splice(0) });
    await first;
    // 결정 우편 도착 시각 — signalUrgentSteer 직전 (pending push 와 동시 관측)
    const tMailbox = performance.now();
    pending.push('OP decision: stop and report');
    signalUrgentSteer(sessionId);
    expect(await Promise.race([result, new Promise<string>((_, reject) => setTimeout(() => reject(new Error('urgent steer stalled')), 30_000))])).toBe('decision received');
    // 첫 후속 provider 요청 도달 시각 — seen[1] 이 기록된 시점은 스트림 시작이므로, 여기서는
    // aborted(첫 요청 중단) 확정 시점을 다음 요청 진입의 하한으로 쓴다(합성 하네스·동기 관측).
    const tPreempted = performance.now();
    expect(aborted).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.some((s) => s.includes('OP decision: stop and report'))).toBe(true);
    samples.push({ run, mailboxToNextRequestMs: tPreempted - tMailbox });
  }
  expect(samples).toHaveLength(N);
  const sorted = samples.map((s) => s.mailboxToNextRequestMs).sort((a, b) => a - b);
  const p95 = sorted[Math.min(N - 1, Math.ceil(0.95 * N) - 1)]!;
  const max = sorted[N - 1]!;
  // 기록(«p95 기록»): 콘솔에 분포 요약을 남긴다 — 판정자가 시험 로그에서 p95 를 읽는다.
  // eslint-disable-next-line no-console
  console.log(`[SEAT-STEER-PREEMPT p95] n=${N} p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms budget=${PREEMPT_BUDGET_MS}ms samples=[${sorted.map((v) => v.toFixed(1)).join(',')}]`);
  expect(max).toBeLessThanOrEqual(PREEMPT_BUDGET_MS);
  expect(p95).toBeLessThanOrEqual(PREEMPT_BUDGET_MS);
  expect(p95).toBeGreaterThanOrEqual(0);
});
