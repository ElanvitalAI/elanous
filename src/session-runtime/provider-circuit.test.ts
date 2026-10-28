// SURVIVAL-PROVIDER-CIRCUIT (S2): 턴을 넘어 공급자 건강을 기억하는 회로 차단기.
// 정본: 내부 문서 `RFC-tui-never-stop-survival-ladder-2026-10-27` §3 S2 · §6 B
//
// 판정은 모두 주입 시계(`now`)로만 움직인다 — 실제 시간·네트워크에 의존하지 않는다.

import { describe, expect, test } from 'bun:test';
import {
  circuitState,
  pickInitialProvider,
  recordProviderFailure,
  recordProviderSuccess,
  resetProviderCircuitForTest,
} from './provider-circuit';

const T0 = 1_000_000;
const MIN = 60_000;

describe('SURVIVAL-PROVIDER-CIRCUIT: open → half-open → closed', () => {
  test('실패 1회는 closed, 10분 창 안 2회 연속은 open, 냉각 뒤 half-open, 성공은 closed', () => {
    resetProviderCircuitForTest();
    const p = 'codex';

    // 실패 1회 — 아직 closed.
    recordProviderFailure(p, 'rate-limit', T0);
    expect(circuitState(p, T0 + 1)).toBe('closed');

    // 10분 창 안 2회 연속 실패 — open (냉각 5분).
    recordProviderFailure(p, 'rate-limit', T0 + 1 * MIN);
    expect(circuitState(p, T0 + 2 * MIN)).toBe('open');
    expect(circuitState(p, T0 + 4 * MIN)).toBe('open');
    // 냉각(5분)이 지나면 half-open.
    expect(circuitState(p, T0 + 6 * MIN + 1)).toBe('half-open');

    // half-open 시도 1회 성공 → closed.
    recordProviderSuccess(p, T0 + 6 * MIN + 2);
    expect(circuitState(p, T0 + 6 * MIN + 3)).toBe('closed');
  });

  test('half-open 재실패는 open, 냉각은 2배(상한 30분)', () => {
    resetProviderCircuitForTest();
    const p = 'glm';
    recordProviderFailure(p, 'network-transient', T0);
    recordProviderFailure(p, 'network-transient', T0 + 1);
    expect(circuitState(p, T0 + 1 * MIN)).toBe('open');

    // 냉각 경과 → half-open → 재실패 → open, 냉각 5분 ×2 = 10분.
    const afterFirstCooldown = T0 + 5 * MIN + 1;
    expect(circuitState(p, afterFirstCooldown)).toBe('half-open');
    recordProviderFailure(p, 'network-transient', afterFirstCooldown + 1);
    expect(circuitState(p, afterFirstCooldown + 2 * MIN)).toBe('open');
    expect(circuitState(p, T0 + 15 * MIN)).toBe('open');
    expect(circuitState(p, T0 + 15 * MIN + 2)).toBe('half-open');

    // 다시 재실패 → 냉각 10분 ×2 = 20분.
    const afterSecondCooldown = T0 + 15 * MIN + 2;
    recordProviderFailure(p, 'network-transient', afterSecondCooldown);
    expect(circuitState(p, T0 + 34 * MIN)).toBe('open');
    expect(circuitState(p, T0 + 35 * MIN + 2)).toBe('half-open');

    // 세 번째 재실패 → 20 ×2 = 40분이지만 상한 30분.
    recordProviderFailure(p, 'network-transient', T0 + 35 * MIN + 3);
    expect(circuitState(p, T0 + 64 * MIN)).toBe('open');
    expect(circuitState(p, T0 + 65 * MIN + 3)).toBe('half-open');
  });

  test('전환 사유가 아닌 범주(사용자 탓)는 회로에 기록하지 않는다', () => {
    resetProviderCircuitForTest();
    const p = 'openai';
    recordProviderFailure(p, 'context-window-exceeded', T0);
    recordProviderFailure(p, 'context-window-exceeded', T0 + 1);
    // 전환 사유 범주가 아니므로 두 번을 넘겨도 열리지 않는다.
    expect(circuitState(p, T0 + 2)).toBe('closed');
  });

  test('StreamIdleTimeoutError·OverloadFailoverError 범주는 회로에 기록된다', () => {
    resetProviderCircuitForTest();
    const p = 'zai';
    recordProviderFailure(p, 'stream-idle-timeout', T0);
    recordProviderFailure(p, 'overload-failover', T0 + 1);
    expect(circuitState(p, T0 + 2)).toBe('open');
  });

  test('성공은 closed 상태의 실패 이력 창을 정리한다', () => {
    resetProviderCircuitForTest();
    const p = 'grok';
    recordProviderFailure(p, 'rate-limit', T0);
    recordProviderSuccess(p, T0 + 1);
    // 성공으로 창이 정리됐다 — 이후 실패 1회만으로는 open 이 아니고 다시 2회가 필요하다.
    recordProviderFailure(p, 'rate-limit', T0 + 2);
    expect(circuitState(p, T0 + 3)).toBe('closed');
    recordProviderFailure(p, 'rate-limit', T0 + 4);
    expect(circuitState(p, T0 + 5)).toBe('open');
  });
});

describe('SURVIVAL-PROVIDER-CIRCUIT: pickInitialProvider', () => {
  test('chainNames 의 첫 closed 공급자를 돌려준다', () => {
    resetProviderCircuitForTest();
    expect(pickInitialProvider(['anthropic', 'gemini', 'local'], T0)).toBe('anthropic');
  });

  test('closed 가 없으면 첫 half-open, 모두 open 이면 undefined', () => {
    resetProviderCircuitForTest();
    const names = ['anthropic', 'gemini', 'local'];
    for (const name of names) {
      recordProviderFailure(name, 'rate-limit', T0);
      recordProviderFailure(name, 'rate-limit', T0 + 1);
    }
    // 모두 open → undefined (호출부가 circuit-all-open 처리).
    expect(pickInitialProvider(names, T0 + 2)).toBeUndefined();

    // 첫 공급자만 냉각 경과(half-open) → 그것이 차선.
    expect(circuitState('anthropic', T0 + 5 * MIN + 1)).toBe('half-open');
    expect(pickInitialProvider(names, T0 + 5 * MIN + 1)).toBe('anthropic');

    // half-open 시도 실패 → 다시 open → 이제 half-open 인 gemini 가 차선.
    recordProviderFailure('anthropic', 'rate-limit', T0 + 5 * MIN + 2);
    expect(circuitState('gemini', T0 + 5 * MIN + 3)).toBe('half-open');
    expect(pickInitialProvider(names, T0 + 5 * MIN + 3)).toBe('gemini');
  });

  test('half-open 성공 뒤에는 다시 그 공급자가 첫 closed 후보가 된다', () => {
    resetProviderCircuitForTest();
    const p = 'local';
    recordProviderFailure(p, 'rate-limit', T0);
    recordProviderFailure(p, 'rate-limit', T0 + 1);
    expect(circuitState(p, T0 + 5 * MIN + 1)).toBe('half-open');
    recordProviderSuccess(p, T0 + 5 * MIN + 2);
    expect(pickInitialProvider([p, 'mistral'], T0 + 5 * MIN + 3)).toBe(p);
  });
});