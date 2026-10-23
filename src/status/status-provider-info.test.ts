import { describe, expect, test } from 'bun:test';
import type { UserConfig } from '../user-config.js';
import { createStatusProviderInfoReader, statusModelActual } from './status-provider-info.js';

function harness() {
  let t = 0;
  let cfg = { id: 1 } as unknown as UserConfig;
  let configReads = 0;
  const inspected: Array<string | undefined> = [];
  const read = createStatusProviderInfoReader({
    now: () => t,
    readConfig: () => { configReads += 1; return cfg; },
    inspect: (_cfg, runtimeModel) => {
      inspected.push(runtimeModel);
      return { provider: 'openai-codex', model: runtimeModel ?? 'gpt-cfg', auth: 'oauth', authDetail: 'x' } as never;
    },
    ttlMs: 2_000,
    maxAgeMs: 30_000,
  });
  return {
    read,
    advance: (ms: number) => { t += ms; },
    swapConfig: () => { cfg = { id: 2 } as unknown as UserConfig; },
    configReads: () => configReads,
    inspected,
  };
}

describe('createStatusProviderInfoReader', () => {
  test('상태줄이 쓰는 provider·model 만 돌려준다(authDetail 없음)', () => {
    const h = harness();
    expect(h.read()).toEqual({ provider: 'openai-codex', model: 'gpt-cfg' });
  });

  test('TTL 안에서는 설정도 판정도 다시 안 한다', () => {
    const h = harness();
    h.read();
    for (let i = 0; i < 50; i++) { h.advance(10); h.read(); }
    expect(h.configReads()).toBe(1);
    expect(h.inspected).toHaveLength(1);
  });

  test('TTL 이 지나도 설정 객체가 같으면 판정을 재사용한다', () => {
    const h = harness();
    h.read();
    h.advance(2_500);
    h.read();
    expect(h.configReads()).toBe(2);
    expect(h.inspected).toHaveLength(1);
  });

  test('설정이 바뀌면 TTL 뒤 다시 판정한다', () => {
    const h = harness();
    h.read();
    h.swapConfig();
    h.advance(2_500);
    h.read();
    expect(h.inspected).toHaveLength(2);
  });

  test('runtimeModel 이 바뀌면 TTL 과 무관하게 즉시 다시 판정한다', () => {
    const h = harness();
    expect(h.read().model).toBe('gpt-cfg');
    h.advance(10);
    expect(h.read('gpt-runtime').model).toBe('gpt-runtime');
    expect(h.inspected).toEqual([undefined, 'gpt-runtime']);
  });

  test('TTL 안의 조기 반환도 maxAge 를 넘기면 다시 판정한다(29s 확인 → 30.001s 렌더)', () => {
    const h = harness();
    h.read();
    h.advance(29_000);
    h.read();
    expect(h.inspected).toHaveLength(1);
    h.advance(1_001);
    h.read();
    expect(h.inspected).toHaveLength(2);
  });

  test('설정이 그대로여도 maxAge 가 지나면 다시 판정한다(auto 공급자 자격 변화)', () => {
    const h = harness();
    h.read();
    h.advance(31_000);
    h.read();
    expect(h.inspected).toHaveLength(2);
  });

  // TUI-MODEL-BADGE-ACTUAL (10-16) — 이번 턴 실제 실행은 기억 «밖» 에서 덧씌운다(낡은 실행이 굳지 않게).
  test('이번 턴 실제 실행을 덧씌우되 설정 판정은 기억한 그대로 쓴다', () => {
    const h = harness();
    const actual = { model: 'grok-4.3', provider: 'grok', fallbackFrom: 'gpt-cfg' };
    expect(h.read(undefined, actual)).toEqual({ provider: 'openai-codex', model: 'gpt-cfg', actual });
    h.advance(10);
    expect(h.read(undefined, { model: 'grok-4.3' }).actual).toEqual({ model: 'grok-4.3' });
    expect(h.read(undefined, null)).toEqual({ provider: 'openai-codex', model: 'gpt-cfg' });
    expect(h.configReads()).toBe(1);
    expect(h.inspected).toHaveLength(1);
  });

  test('statusModelActual: 실행 기록이 없으면 null(꾸미지 않는다)', () => {
    expect(statusModelActual('nobody-recorded-here')).toBeNull();
  });
});
