// 셸 relay 라운드트립(P1) — autoDrive 게이트·auto 답·escalate·fail-soft 검증.
import { test, expect, describe, beforeAll, afterAll, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { resetLiveDetailCacheForTesting, writeLiveDetail } from '../live/detail-switch.js';
import { decideRelayMode, relayShellPrompt, selectionBytes, type ShellInjector, type RelayShellPromptInput } from './shell-relay.js';
import type { SurfaceUx } from '../agent/surface-ux/types.js';
import type { AskUserQuestionResult } from '../ask-user-question/types.js';

/** 캡처형 fake SurfaceUx. */
function fakeUx(over: {
  interactive?: boolean;
  confirmAnswer?: boolean;
  questionAnswer?: AskUserQuestionResult | null;
} = {}): SurfaceUx & { confirmCalls: number; questionCalls: number } {
  let confirmCalls = 0;
  let questionCalls = 0;
  const ux = {
    surface: 'telegram' as const,
    interactive: over.interactive ?? true,
    async confirm() { confirmCalls++; return over.confirmAnswer ?? true; },
    async question() { questionCalls++; return over.questionAnswer ?? null; },
    spillFile() {},
    progress() {},
  } as unknown as SurfaceUx & { confirmCalls: number; questionCalls: number };
  Object.defineProperty(ux, 'confirmCalls', { get: () => confirmCalls });
  Object.defineProperty(ux, 'questionCalls', { get: () => questionCalls });
  return ux;
}

/** 주입 캡처 seam. */
function captureInject(over: { ok?: boolean; error?: string } = {}) {
  const sent: string[] = [];
  const inject: ShellInjector = async ({ bytes }) => {
    sent.push(bytes);
    return over.ok === false ? { ok: false, error: over.error ?? 'dead' } : { ok: true, output: 'ack' };
  };
  return { inject, sent };
}

function base(over: Partial<RelayShellPromptInput> = {}): RelayShellPromptInput {
  const { inject } = captureInject();
  return { shellId: 's1', prompt: 'Apply patch? (y/n)', ux: fakeUx(), autoDrive: 'safe', inject, ...over };
}

describe('decideRelayMode — autoDrive 게이트(순수)', () => {
  test('on → 항상 auto', () => {
    expect(decideRelayMode('on')).toBe('auto');
    expect(decideRelayMode('on', { lowRisk: false })).toBe('auto');
  });
  test('off → 항상 escalate', () => {
    expect(decideRelayMode('off', { lowRisk: true })).toBe('escalate');
  });
  test('safe → lowRisk 분기', () => {
    expect(decideRelayMode('safe', { lowRisk: true })).toBe('auto');
    expect(decideRelayMode('safe', { lowRisk: false })).toBe('escalate');
    expect(decideRelayMode('safe')).toBe('escalate'); // 기본 안전측
  });
});

describe('relayShellPrompt — auto 경로', () => {
  test('on + autoAnswer → operator 안 부르고 자율 주입', async () => {
    const { inject, sent } = captureInject();
    const ux = fakeUx();
    const out = await relayShellPrompt(base({ autoDrive: 'on', inject, ux, autoAnswer: () => 'y' }));
    expect(out.mode).toBe('auto');
    expect(out.answer).toBe('y');
    expect(out.injected).toBe(true);
    expect(sent).toEqual(['y\n']);
    expect(ux.confirmCalls).toBe(0);
    expect(ux.questionCalls).toBe(0);
  });

  test('on + autoAnswer 없음 → escalate 로 안전 폴백(자동 주입 금지)', async () => {
    const ux = fakeUx({ confirmAnswer: true });
    const { inject, sent } = captureInject();
    const out = await relayShellPrompt(base({ autoDrive: 'on', inject, ux }));
    expect(out.mode).toBe('escalate');
    expect(ux.confirmCalls).toBe(1); // 폴백해서 막 경유
    expect(sent).toEqual(['y\n']);
  });

  test('safe + lowRisk → auto', async () => {
    const out = await relayShellPrompt(base({ autoDrive: 'safe', lowRisk: true, autoAnswer: () => 'yes' }));
    expect(out.mode).toBe('auto');
    expect(out.answer).toBe('yes');
  });
});

describe('relayShellPrompt — escalate confirm(y/N)', () => {
  test('safe 고위험 → ux.confirm 승인 → yesBytes 주입', async () => {
    const ux = fakeUx({ confirmAnswer: true });
    const { inject, sent } = captureInject();
    const out = await relayShellPrompt(base({ autoDrive: 'safe', ux, inject }));
    expect(out.mode).toBe('escalate');
    expect(ux.confirmCalls).toBe(1);
    expect(out.answer).toBe('y');
    expect(sent).toEqual(['y\n']);
  });

  test('confirm 거절 → noBytes(decline) 주입', async () => {
    const ux = fakeUx({ confirmAnswer: false });
    const { inject, sent } = captureInject();
    const out = await relayShellPrompt(base({ autoDrive: 'off', ux, inject }));
    expect(out.answer).toBe('n');
    expect(sent).toEqual(['n\n']);
  });

  test('비대화형 → fail-closed decline(n) + reason', async () => {
    const ux = fakeUx({ interactive: false, confirmAnswer: false });
    const { inject, sent } = captureInject();
    const out = await relayShellPrompt(base({ autoDrive: 'off', ux, inject }));
    expect(out.answer).toBe('n');
    expect(out.reason).toBe('non-interactive-fail-closed-decline');
    expect(sent).toEqual(['n\n']);
  });

  test('yesBytes/noBytes/terminator 커스텀', async () => {
    const ux = fakeUx({ confirmAnswer: true });
    const { inject, sent } = captureInject();
    await relayShellPrompt(base({ autoDrive: 'off', ux, inject, yesBytes: '1', terminator: '\r' }));
    expect(sent).toEqual(['1\r']);
  });
});

describe('relayShellPrompt — escalate question(N-way 메뉴)', () => {
  test('options → ux.question → 선택 라벨 주입', async () => {
    const ux = fakeUx({ questionAnswer: { answers: { shell_relay: 'Overwrite' } } });
    const { inject, sent } = captureInject();
    const out = await relayShellPrompt(base({
      autoDrive: 'off', ux, inject, options: ['Overwrite', 'Skip', 'Rename'],
    }));
    expect(ux.questionCalls).toBe(1);
    expect(out.answer).toBe('Overwrite');
    expect(sent).toEqual(['Overwrite\n']);
  });

  test('멀티셀렉트 배열 → 첫 라벨', async () => {
    const ux = fakeUx({ questionAnswer: { answers: { shell_relay: ['A', 'B'] } } });
    const out = await relayShellPrompt(base({ autoDrive: 'off', ux, options: ['A', 'B'] }));
    expect(out.answer).toBe('A');
  });

  test('비대화형 메뉴 → 추측 금지·HITL 보류(주입 안 함)', async () => {
    const ux = fakeUx({ interactive: false, questionAnswer: null });
    const { inject, sent } = captureInject();
    const out = await relayShellPrompt(base({ autoDrive: 'off', ux, inject, options: ['A', 'B'] }));
    expect(out.answer).toBe(null);
    expect(out.injected).toBe(false);
    expect(out.reason).toBe('non-interactive-menu-fail-closed');
    expect(sent).toEqual([]);
  });

  test('메뉴 취소(cancelled) → 보류', async () => {
    const ux = fakeUx({ questionAnswer: { answers: {}, cancelled: true } });
    const out = await relayShellPrompt(base({ autoDrive: 'off', ux, options: ['A', 'B'] }));
    expect(out.answer).toBe(null);
    expect(out.reason).toBe('cancelled');
  });
});

describe('relayShellPrompt — escalate decision observations', () => {
  const previousStateDir = process.env.ELANOUS_STATE_DIR;
  const previousRunId = process.env.ELANOUS_RUN_ID;
  const stateRoot = mkdtempSync(join(tmpdir(), 'shell-relay-decision-'));
  beforeAll(() => {
    process.env.ELANOUS_STATE_DIR = stateRoot;
    process.env.ELANOUS_RUN_ID = 'run-shell-relay';
    writeLiveDetail({ scope: 'all', ttlMin: 30 });
    resetLiveDetailCacheForTesting();
  });
  afterAll(() => {
    if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousStateDir;
    if (previousRunId === undefined) delete process.env.ELANOUS_RUN_ID;
    else process.env.ELANOUS_RUN_ID = previousRunId;
    resetLiveDetailCacheForTesting();
    rmSync(stateRoot, { recursive: true, force: true });
  });

  test('question emits immediately after the original log even when no answer is available', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ category, event, data: data ?? {} });
    }) as never);
    try {
      const out = await relayShellPrompt(base({ autoDrive: 'off', ux: fakeUx({ interactive: false }), options: ['A', 'B'] }));
      expect(out).toMatchObject({ mode: 'escalate', answer: null, injected: false, reason: 'non-interactive-menu-fail-closed' });
      const index = events.findIndex(({ category, event }) => category === 'harness.relay' && event === 'escalate-question');
      expect(index).toBeGreaterThanOrEqual(0);
      expect(events[index]?.data).toEqual({ shellId: 's1', answer: null, interactive: false });
      expect(events[index + 1]).toMatchObject({ category: 'harness.decision', event: 'decision', data: { kind: 'ESCALATE', runId: 'run-shell-relay', reason: 'question · 비대화형 · 응답 없음' } });
    } finally {
      log.mockRestore();
    }
  });

  test('confirm emits immediately after the unchanged log and preserves injection', async () => {
    resetLiveDetailCacheForTesting();
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ category, event, data: data ?? {} });
    }) as never);
    try {
      const { inject, sent } = captureInject();
      const out = await relayShellPrompt(base({ autoDrive: 'off', ux: fakeUx({ confirmAnswer: false }), inject }));
      expect(out).toMatchObject({ mode: 'escalate', answer: 'n', injected: true });
      expect(sent).toEqual(['n\n']);
      const index = events.findIndex(({ category, event }) => category === 'harness.relay' && event === 'escalate-confirm');
      expect(index).toBeGreaterThanOrEqual(0);
      expect(events[index]?.data).toEqual({ shellId: 's1', ok: false, answer: 'n', interactive: true });
      expect(events[index + 1]).toMatchObject({ category: 'harness.decision', event: 'decision', data: { kind: 'ESCALATE', runId: 'run-shell-relay', reason: 'confirm · 대화형 · 응답 수신' } });
    } finally {
      log.mockRestore();
    }
  });

  test('non-interactive confirm records no operator response separately from the safe decline selection', async () => {
    resetLiveDetailCacheForTesting();
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ category, event, data: data ?? {} });
    }) as never);
    try {
      const { inject, sent } = captureInject();
      const out = await relayShellPrompt(base({ autoDrive: 'off', ux: fakeUx({ interactive: false, confirmAnswer: false }), noBytes: 'decline', inject }));
      expect(out).toMatchObject({ mode: 'escalate', answer: 'decline', injected: true, reason: 'non-interactive-fail-closed-decline' });
      expect(sent).toEqual(['decline\n']);
      const index = events.findIndex(({ category, event }) => category === 'harness.relay' && event === 'escalate-confirm');
      expect(index).toBeGreaterThanOrEqual(0);
      expect(events[index]?.data).toEqual({ shellId: 's1', ok: false, answer: 'decline', interactive: false });
      expect(events[index + 1]).toMatchObject({ category: 'harness.decision', event: 'decision', data: {
        kind: 'ESCALATE', runId: 'run-shell-relay', reason: 'confirm · 비대화형 · 응답 없음 · 안전 거절 선택',
      } });
      expect(JSON.stringify(events[index + 1]?.data)).not.toContain('decline');
    } finally {
      log.mockRestore();
    }
  });

  test('escalation decision never records raw prompt or answer in either branch', async () => {
    resetLiveDetailCacheForTesting();
    const secret = 'token-EXAMPLE-secret-value';
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ category, event, data: data ?? {} });
    }) as never);
    try {
      const prompt = `Enter password ${secret}`;
      const question = await relayShellPrompt(base({ autoDrive: 'off', prompt, ux: fakeUx({ questionAnswer: { answers: { shell_relay: secret } } }), options: [secret] }));
      resetLiveDetailCacheForTesting();
      const confirm = await relayShellPrompt(base({ autoDrive: 'off', prompt, ux: fakeUx({ confirmAnswer: true }), yesBytes: secret }));
      expect(question.answer).toBe(secret);
      expect(confirm.answer).toBe(secret);
      const decisions = events.filter(({ category, event }) => category === 'harness.decision' && event === 'decision').map(({ data }) => data);
      expect(decisions).toHaveLength(2);
      for (const decision of decisions) {
        expect(decision).toMatchObject({ kind: 'ESCALATE', runId: 'run-shell-relay', what: '셸 응답 요청' });
        expect(JSON.stringify(decision)).not.toContain(secret);
        expect(JSON.stringify(decision)).not.toContain(prompt);
      }
      expect(decisions[0]?.reason).toBe('question · 대화형 · 응답 수신');
      expect(decisions[1]?.reason).toBe('confirm · 대화형 · 응답 수신');
    } finally {
      log.mockRestore();
    }
  });

  test('emission failure preserves question and confirm outcomes and original logs', async () => {
    resetLiveDetailCacheForTesting();
    const events: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
      events.push(`${category}:${event}`);
      if (category === 'harness.decision') throw new Error('decision sink unavailable');
    }) as never);
    try {
      const question = await relayShellPrompt(base({ autoDrive: 'off', ux: fakeUx({ interactive: false }), options: ['A', 'B'] }));
      expect(question).toMatchObject({ answer: null, injected: false, reason: 'non-interactive-menu-fail-closed' });
      const { inject, sent } = captureInject();
      resetLiveDetailCacheForTesting();
      const confirm = await relayShellPrompt(base({ autoDrive: 'off', ux: fakeUx({ confirmAnswer: true }), inject }));
      expect(confirm).toMatchObject({ answer: 'y', injected: true });
      expect(sent).toEqual(['y\n']);
      for (const event of ['escalate-question', 'escalate-confirm']) {
        const index = events.indexOf(`harness.relay:${event}`);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(events[index + 1]).toBe('harness.decision:decision');
      }
    } finally {
      log.mockRestore();
    }
  });
});

describe('selectionBytes — 메뉴 방향키 시퀀스(§③)', () => {
  test('arrows: index 만큼 ↓ + Enter', () => {
    const options = ['A', 'B', 'C'];
    expect(selectionBytes('A', { options, optionStyle: 'arrows', terminator: '\n' })).toBe('\r'); // index 0 = Enter
    expect(selectionBytes('B', { options, optionStyle: 'arrows', terminator: '\n' })).toBe('\x1b[B\r');
    expect(selectionBytes('C', { options, optionStyle: 'arrows', terminator: '\n' })).toBe('\x1b[B\x1b[B\r');
  });
  test('text: 라벨 + 종결자', () => {
    expect(selectionBytes('B', { options: ['A', 'B'], optionStyle: 'text', terminator: '\n' })).toBe('B\n');
  });
  test('arrows 인데 답이 옵션에 없음 → text 폴백', () => {
    expect(selectionBytes('Z', { options: ['A', 'B'], optionStyle: 'arrows', terminator: '\n' })).toBe('Z\n');
  });
  test('confirm(옵션 없음) → 항상 text', () => {
    expect(selectionBytes('y', { optionStyle: 'arrows', terminator: '\n' })).toBe('y\n');
  });
});

describe('relayShellPrompt — arrows 메뉴 통합', () => {
  test('optionStyle arrows → 선택 index 방향키 주입', async () => {
    const ux = fakeUx({ questionAnswer: { answers: { shell_relay: 'Skip' } } });
    const { inject, sent } = captureInject();
    const out = await relayShellPrompt(base({
      autoDrive: 'off', ux, inject, options: ['Overwrite', 'Skip', 'Rename'], optionStyle: 'arrows',
    }));
    expect(out.answer).toBe('Skip');
    expect(sent).toEqual(['\x1b[B\r']); // index 1 = ↓×1 + Enter
  });
});

describe('relayShellPrompt — 셀프힐 fail-soft', () => {
  test('dead/unknown 셸 재주입 실패 → throw 안 함·구조화 반환', async () => {
    const ux = fakeUx({ confirmAnswer: true });
    const { inject } = captureInject({ ok: false, error: 'process s1 already exited' });
    const out = await relayShellPrompt(base({ autoDrive: 'off', ux, inject }));
    expect(out.injected).toBe(false);
    expect(out.answer).toBe('y'); // 답은 얻었으나 주입 실패
    expect(out.reason).toContain('inject-failed');
    expect(out.reason).toContain('already exited');
  });
});
