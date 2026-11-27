/**
 * ELN-PERSISTENCE-LADDER ④ 단위 — 위임 실패 직접 1회 우회 시험(§⑫ · OP orders ELN-UNIVERSAL-AGENT-1124).
 * 4계열 중 ②실패→직접 우회 ①회 · ④중복 부작용 방지(같은 지문 재실행 금지) 여기 · ③완료는 run-goal-loop 쪽.
 * ⛔ mock.module 없음 — 순수 주입.
 */
import { describe, expect, test } from 'bun:test';
import {
  withDirectFallback,
  delegateErrorProbe,
  selfImplementFailureProbe,
  createDirectFallbackMarker,
} from './delegate-fallback.js';

describe('ELN-PERSISTENCE-LADDER ④ — 실패 판별探', () => {
  test('delegateErrorProbe — {error} 문면은 실패 사유로, 정상 결과는 null', () => {
    expect(delegateErrorProbe({ error: '세션 생성 실패' } as never)).toBe('위임 실패: 세션 생성 실패');
    expect(delegateErrorProbe({ ok: true } as never)).toBe(null);
    expect(delegateErrorProbe(null as never)).toBe(null);
  });

  test('selfImplementFailureProbe — kind=failed(retryable≠false)만 실패 · launched/pending/retryable:false 는 아님', () => {
    expect(selfImplementFailureProbe({ kind: 'failed', reason: '발사 실패' } as never)).toBe('SelfImplement 실패: 발사 실패');
    expect(selfImplementFailureProbe({ kind: 'failed', reason: 'x', retryable: false } as never)).toBe(null);
    expect(selfImplementFailureProbe({ kind: 'launched', runId: 'r' } as never)).toBe(null);
    expect(selfImplementFailureProbe({ kind: 'pending' } as never)).toBe(null);
  });
});

describe('ELN-PERSISTENCE-LADDER ④ — withDirectFallback(직접 1회 우회)', () => {
  test('② 위임 성공 = 우회 0 · 결과 그대로', async () => {
    let directCalls = 0;
    const report = await withDirectFallback(
      'task',
      async () => ({ ok: true }) as never,
      async () => { directCalls += 1; return { ok: 'direct' } as never; },
      delegateErrorProbe,
      { marker: createDirectFallbackMarker() },
    );
    expect(report.bypassed).toBe(false);
    expect(directCalls).toBe(0);
    expect(report.result as unknown).toEqual({ ok: true });
  });

  test('② 위임 {error} 실패 = 같은 일 직접 1회 우회 + 양쪽 결과 보고', async () => {
    let directCalls = 0;
    const report = await withDirectFallback(
      'task',
      async () => ({ error: '세션 생성 실패' }) as never,
      async () => { directCalls += 1; return { ok: 'direct' } as never; },
      delegateErrorProbe,
      { marker: createDirectFallbackMarker() },
    );
    expect(report.bypassed).toBe(true);
    expect(directCalls).toBe(1);
    expect(report.result as unknown).toEqual({ ok: 'direct' });
    expect(report.delegateResult as unknown).toEqual({ error: '세션 생성 실패' });
    expect(report.bypassReason).toContain('위임 실패');
  });

  test('④ 중복 부작용 방지 — 같은 지문이 다시 실패해도 직접 우회는 1회뿐(재실행 없음)', async () => {
    const marker = createDirectFallbackMarker();
    let directCalls = 0;
    const args = { task: '동일 일' };
    const first = await withDirectFallback(args, async () => ({ error: 'e1' }) as never, async () => {
      directCalls += 1; return { ok: 'direct-1' } as never;
    }, delegateErrorProbe, { marker, fingerprint: (a) => JSON.stringify(a) });
    expect(first.bypassed).toBe(true);
    const second = await withDirectFallback(args, async () => ({ error: 'e2' }) as never, async () => {
      directCalls += 1; return { ok: 'direct-2' } as never;
    }, delegateErrorProbe, { marker, fingerprint: (a) => JSON.stringify(a) });
    expect(second.bypassed).toBe(false);
    expect(directCalls).toBe(1);
    expect(second.bypassReason ?? '').toContain('1회 소진');
    expect(second.result as unknown).toEqual({ error: 'e2' });
  });

  test('④ 다른 지문은 별개 — 우회 1회씩 각각 시행', async () => {
    const marker = createDirectFallbackMarker();
    let directCalls = 0;
    for (const task of ['a', 'b']) {
      const report = await withDirectFallback({ task }, async () => ({ error: `e-${task}` }) as never, async () => {
        directCalls += 1; return { ok: `direct-${task}` } as never;
      }, delegateErrorProbe, { marker, fingerprint: (a) => JSON.stringify(a) });
      expect(report.bypassed).toBe(true);
    }
    expect(directCalls).toBe(2);
  });
});