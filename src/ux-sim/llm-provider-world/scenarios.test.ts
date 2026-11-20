import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileReservationLedger, createInMemoryReservationLedger, type SpendReservationLedger } from '../../oauth/llm-spend-reservation.js';
import { defaultSpendPolicyDoc } from '../../nexus/llm-spend-policy/schema.js';
import {
  collectStrings, decideOnWorld, exhaustAllSubscriptions, guardOnWorld, policyWith, SECRET_SHAPE_PROBE,
} from './scenarios.js';
import { createLlmProviderWorld } from './world.js';

const tmp = mkdtempSync(join(tmpdir(), 'llm-sim-scn-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const START = '2026-11-20T00:00:00Z';
const RESET_5H = '2026-11-20T05:00:00Z';

describe('세계 조립기', () => {
  test('시계 하나를 모든 장치가 공유 · states() 는 행 이름 7개', () => {
    const w = createLlmProviderWorld({ startIso: START, balanceUsd: 10 });
    expect(w.states().map((s) => s.row)).toEqual([
      'codex-default', 'codex-team', 'codex-third', 'claude-code-sub', 'claude-code-sub-2', 'openrouter', 'claude-acp',
    ]);
    const lease = w.targets.configDir.supply('codex-default');
    expect(lease.ok).toBe(true);
    w.openrouter.call({ estimateUsd: 1 });
    w.clock.advance(3_600_000);
    expect(w.remote.heartbeat().at).toBe('2026-11-20T01:00:00.000Z');
    expect(w.targets.configDir.leases()).toEqual([]); // 1h 뒤 임대 TTL 만료 — 같은 시계
    expect(w.openrouter.events()[0]!.at).toBe('2026-11-20T00:00:00.000Z');
    expect(w.openrouter.observe()!.balance).toMatchObject({ observedAt: '2026-11-20T01:00:00.000Z' });
  });

  test('기본 정책의 걷기 순서 리터럴', () => {
    const policy = defaultSpendPolicyDoc();
    expect(policy.fallbackOrder).toEqual(['codex-default', 'codex-team', 'codex-third', 'claude-code-sub', 'claude-acp', 'openrouter']);
    expect(Object.keys(policy.providers)).toEqual(['codex-default', 'codex-team', 'codex-third', 'claude-code-sub', 'claude-acp', 'openrouter']);
    const capByRow = Object.fromEntries(Object.entries(policy.providers).map(([row, p]) => [row, p.kind === 'credit' ? null : p.capPct]));
    expect(capByRow).toEqual({ 'codex-default': 95, 'codex-team': 60, 'codex-third': 60, 'claude-code-sub': 85, 'claude-acp': 85, openrouter: null });
  });
});

describe('① 구독 소진 → 다른 구독 → 크레딧 → 멈춤', () => {
  test('default 95 → team → third → claude-code-sub → (claude-acp 창 미주입 건너뜀) → openrouter → spendCap → stop', async () => {
    const w = createLlmProviderWorld({ startIso: START, balanceUsd: 1000 });
    const g = guardOnWorld(w);
    const req = { role: 'judgement', execLocation: 'host', estimateUsd: 1 } as const;

    let r = await g.run(req);
    expect(r.decision).toMatchObject({ outcome: 'choice', row: 'codex-default', switched: false });

    w.codex.default.setUsedPct('five-hour', 95); // 상한 95% 도달
    r = await g.run(req);
    expect(r.decision).toMatchObject({ outcome: 'choice', row: 'codex-team', switched: true, reason: 'switch(fallbackOrder 걷기)' });
    if (r.decision.outcome === 'choice') expect(r.decision.skipped).toEqual([{ row: 'codex-default', why: 'cap-pct-exhausted(95% ≥ 상한 95%)' }]);

    w.codex.team.setUsedPct('five-hour', 60);
    r = await g.run(req);
    expect(r.decision).toMatchObject({ outcome: 'choice', row: 'codex-third' });

    w.codex.third.setUsedPct('five-hour', 60);
    r = await g.run(req);
    expect(r.decision).toMatchObject({ outcome: 'choice', row: 'claude-code-sub' });

    w.claude.sub1.setUsedPct('five-hour', 85);
    r = await g.run(req);
    expect(r.decision).toMatchObject({ outcome: 'choice', row: 'openrouter', model: 'openrouter/z-ai/glm-5.3' });
    if (r.decision.outcome === 'choice') {
      expect(r.decision.skipped).toEqual([
        { row: 'claude-code-sub', why: 'cap-pct-exhausted(85% ≥ 상한 85%)' },
        { row: 'claude-acp', why: 'window-unmeasured(주입된 실측 없음 — «모른다»를 «비었다»로 접지 않는다)' },
      ]);
    }

    w.openrouter.call({ role: 'judgement', estimateUsd: 300 }); // 일 $300 도달
    r = await g.run(req);
    expect(r.decision.outcome).toBe('stop');
    expect(r.decision.reason).toBe('no-candidate(걷는 순서 전부 불가 — openrouter:spend-cap-exceeded:today(300+예약 0+추정 1 > 300USD))');

    expect(g.ledger.map((e) => [e.action, e.from, e.to, e.what])).toEqual([
      ['decision', null, 'codex-default', 'codex-default'],
      ['switch', 'codex-default', 'codex-team', 'codex-team'],
      ['switch', 'codex-team', 'codex-third', 'codex-third'],
      ['switch', 'codex-third', 'claude-code-sub', 'claude-code-sub'],
      ['switch', 'claude-code-sub', 'openrouter', 'openrouter'],
      ['decision', 'openrouter', null, 'stop'],
    ]);
  });
});

describe('② 창 리셋 뒤 구독 복귀', () => {
  test('시계를 리셋 너머로 → 사용률 0 → 크레딧에서 구독으로 return 원장', async () => {
    const w = createLlmProviderWorld({ startIso: START, balanceUsd: 50 });
    const g = guardOnWorld(w);
    exhaustAllSubscriptions(w, RESET_5H);
    const req = { role: 'judgement', execLocation: 'host', estimateUsd: 1 } as const;

    let r = await g.run(req);
    expect(r.decision).toMatchObject({ outcome: 'choice', row: 'openrouter' });
    expect(g.ledger.map((e) => e.action)).toEqual(['decision']);

    w.clock.advance(5 * 3_600_000 + 60_000); // 5h1m — 5시간 창 리셋 너머
    expect(w.codex.default.windows()).toEqual([
      { name: 'five-hour', usedPct: 0, resetsAt: '2026-11-20T10:00:00.000Z' },
      { name: 'weekly', usedPct: 0, resetsAt: '2026-11-27T00:00:00.000Z' },
    ]);
    r = await g.run(req);
    expect(r.decision).toMatchObject({ outcome: 'choice', row: 'codex-default', switched: true, reason: 'return-on-reset(구독 창 리셋 실측 → 다시 구독 우선)' });
    expect(r.resets['codex-default']).toBe('usage-drop');
    expect(g.ledger).toHaveLength(2);
    expect(g.ledger[1]).toMatchObject({ action: 'return', from: 'openrouter', to: 'codex-default', what: 'codex-default' });
    expect(g.ledger[1]!.reason).toBe('return-on-reset(구독 창 리셋 실측 → 다시 구독 우선) · 관측:usage-drop');
  });

  test('히스테리시스 10%p — 86% 는 크레딧 유지(원장 0줄 추가) · 85% 에서 return', async () => {
    const w = createLlmProviderWorld({ startIso: START, balanceUsd: 50 });
    const g = guardOnWorld(w);
    exhaustAllSubscriptions(w, RESET_5H);
    const req = { role: 'judgement', execLocation: 'host', estimateUsd: 1 } as const;
    await g.run(req);

    w.codex.default.setUsedPct('five-hour', 86); // 게이트(<95)는 통과하지만 복귀 문턱(≤ 95−10 = 85) 밖
    let r = await g.run(req);
    expect(r.decision).toMatchObject({ outcome: 'choice', row: 'openrouter', reason: 'stay:게이트 통과(이전 행 유지)' });
    expect(g.ledger).toHaveLength(1);

    w.codex.default.setUsedPct('five-hour', 85);
    r = await g.run(req);
    expect(r.decision).toMatchObject({ outcome: 'choice', row: 'codex-default' });
    expect(g.ledger).toHaveLength(2);
    expect(g.ledger[1]).toMatchObject({ action: 'return', to: 'codex-default' });
  });
});

describe('③ spendCap 도달', () => {
  test('일 $300 기본 — 299 + 추정 1 는 통과(300 이하) · 300 도달이면 거부', () => {
    const w = createLlmProviderWorld({ startIso: START, balanceUsd: 1000 });
    exhaustAllSubscriptions(w, RESET_5H);
    w.openrouter.call({ role: 'judgement', estimateUsd: 299 });
    let d = decideOnWorld(w, { role: 'judgement', execLocation: 'host', estimateUsd: 1 });
    expect(d).toMatchObject({ outcome: 'choice', row: 'openrouter' });
    d = decideOnWorld(w, { role: 'judgement', execLocation: 'host', estimateUsd: 1.01 });
    expect(d.outcome).toBe('stop');
    if (d.outcome === 'stop') expect(d.skipped.find((s) => s.row === 'openrouter')!.why).toBe('spend-cap-exceeded:today(299+예약 0+추정 1.01 > 300USD)');
  });

  test('월 키 미설정 = 일만 — 닷새 합 1250 이어도 오늘 0 이면 통과 · 월 상한을 넣으면 같은 상황이 거부', () => {
    const w = createLlmProviderWorld({ startIso: START, balanceUsd: 5000 });
    exhaustAllSubscriptions(w, '2026-12-30T00:00:00Z');
    for (let day = 0; day < 5; day += 1) {
      w.openrouter.call({ role: 'judgement', estimateUsd: 250 });
      w.clock.advance(24 * 3_600_000);
    }
    expect(w.openrouter.observe()!.spend).toMatchObject({ todayUsd: 0, monthUsd: 1250 });
    expect(defaultSpendPolicyDoc().providers.openrouter).toMatchObject({ spendCap: { dailyUsd: 300 } });
    const req = { role: 'judgement', execLocation: 'host', estimateUsd: 1 } as const;
    expect(decideOnWorld(w, req)).toMatchObject({ outcome: 'choice', row: 'openrouter' });
    const withMonth = policyWith({ creditSpendCap: { dailyUsd: 300, monthlyUsd: 1000 } });
    const d = decideOnWorld(w, req, withMonth);
    expect(d.outcome).toBe('stop');
    if (d.outcome === 'stop') expect(d.skipped.find((s) => s.row === 'openrouter')!.why).toBe('spend-cap-exceeded:month(1250+예약 0+추정 1 > 1000USD)');
  });
});

describe('④ 자동 충전', () => {
  test('autoTopUp off → 402 insufficient_credits · on → 402 대신 충전 이벤트 + 통과', () => {
    const w = createLlmProviderWorld({ startIso: START, balanceUsd: 1 });
    const r = w.openrouter.call({ estimateUsd: 5 });
    expect(r).toEqual({
      ok: false, device: 'openrouter', status: 402, code: 'insufficient_credits',
      message: 'OpenRouter credits insufficient: balance $1.00 is below call cost $5.00',
    });
    expect(w.openrouter.events().map((e) => [e.kind, e.usd])).toEqual([['insufficient', 5]]);

    w.openrouter.setAutoTopUp({ enabled: true, amountUsd: 20 });
    expect(w.openrouter.call({ estimateUsd: 5 })).toEqual({ ok: true, device: 'openrouter', costUsd: 5 });
    expect(w.openrouter.events().map((e) => [e.kind, e.usd])).toEqual([['insufficient', 5], ['topup', 20], ['charge', 5]]);
    expect(w.openrouter.observe()!.balance).toMatchObject({ usd: 16, totalCreditsUsd: 21, totalUsageUsd: 5 });
    expect(w.openrouter.observe()!.autoTopUp).toMatchObject({ enabled: true, amountUsd: 20 });
  });

  test('결정 쪽 — 잔액 1 · 추정 5 는 balance-insufficient 멈춤, 충전 뒤(16)에는 크레딧 통과', () => {
    const w = createLlmProviderWorld({ startIso: START, balanceUsd: 1 });
    exhaustAllSubscriptions(w, RESET_5H);
    const req = { role: 'judgement', execLocation: 'host', estimateUsd: 5 } as const;
    const stop = decideOnWorld(w, req);
    expect(stop.outcome).toBe('stop');
    if (stop.outcome === 'stop') expect(stop.skipped.find((s) => s.row === 'openrouter')!.why).toBe('balance-insufficient(잔액 1 < 예약 0+추정 5USD)');
    w.openrouter.setAutoTopUp({ enabled: true, amountUsd: 20 });
    w.openrouter.call({ estimateUsd: 5 });
    expect(decideOnWorld(w, req)).toMatchObject({ outcome: 'choice', row: 'openrouter' });
  });
});

describe('⑤ 역할 creditOk', () => {
  const consumers = ['ta-child', 'review', 'judgement'] as const;
  test('ta-child 는 크레딧 대신 멈춤 · review·judgement 는 크레딧 허용', () => {
    const policy = policyWith({ creditModels: ['openrouter/z-ai/glm-5.3', 'openrouter/moonshotai/kimi-k3'] });
    const w = createLlmProviderWorld({ startIso: START, balanceUsd: 100 });
    exhaustAllSubscriptions(w, RESET_5H);
    const out = consumers.map((role) => {
      const d = decideOnWorld(w, { role, execLocation: 'host', estimateUsd: 1, model: 'openrouter/moonshotai/kimi-k3' }, policy);
      return [role, d.outcome, d.outcome === 'choice' ? d.row : d.skipped.find((s) => s.row === 'openrouter')!.why];
    });
    expect(out).toEqual([
      ['ta-child', 'stop', 'role-credit-not-ok(역할 creditOk=false — 크레딧 미사용)'],
      ['review', 'choice', 'openrouter'],
      ['judgement', 'choice', 'openrouter'],
    ]);
  });

  test('역할 절이 없는 역할(authoring)·역할 없음 = creditOk 빠짐 = false', () => {
    const w = createLlmProviderWorld({ startIso: START, balanceUsd: 100 });
    exhaustAllSubscriptions(w, RESET_5H);
    for (const role of ['authoring', undefined] as const) {
      const d = decideOnWorld(w, { ...(role ? { role } : {}), execLocation: 'host', estimateUsd: 1 });
      expect(d.outcome).toBe('stop');
    }
  });
});

describe('⑥ 리뷰 GLM 금지', () => {
  const glm = 'openrouter/z-ai/glm-5.3';
  test('기본 정책의 코드 상수 deny — role review + GLM 은 크레딧 행이 있어도 거부', () => {
    const w = createLlmProviderWorld({ startIso: START, balanceUsd: 100 });
    exhaustAllSubscriptions(w, RESET_5H);
    const d = decideOnWorld(w, { role: 'review', execLocation: 'host', estimateUsd: 1 }); // prefer 비어 있어 크레딧 기본 모델(glm)이 걸린다
    expect(d.outcome).toBe('stop');
    if (d.outcome === 'stop') expect(d.skipped.find((s) => s.row === 'openrouter')!.why).toBe('deny:리뷰 GLM 금지(코드 상수): glm(코드 상수 — 절대)');
    // 같은 GLM 이어도 judgement 는 허용
    expect(decideOnWorld(w, { role: 'judgement', execLocation: 'host', estimateUsd: 1 })).toMatchObject({ outcome: 'choice', row: 'openrouter', model: glm });
  });

  test('YAML 역할 deny 오버레이 — 구독 행까지 전부 거부(모델이 요청된 경우) · creditOk·여유 잔액으로도 못 넘음', () => {
    const w = createLlmProviderWorld({ startIso: START, balanceUsd: 100000 });
    const policy = policyWith({ roles: { review: { creditOk: true, deny: ['glm'] } } });
    const d = decideOnWorld(w, { role: 'review', execLocation: 'host', model: glm, estimateUsd: 0 }, policy);
    expect(d.outcome).toBe('stop');
    if (d.outcome === 'stop') {
      expect(d.skipped.map((s) => s.row)).toEqual(['codex-default', 'codex-team', 'codex-third', 'claude-code-sub', 'claude-acp', 'openrouter']);
      expect(d.skipped.every((s) => s.why === 'deny:glm(YAML 역할 deny — 절대)')).toBe(true);
    }
    // YAML deny 를 빼도 코드 상수가 한 번 더 막는다(이중)
    const noYaml = policyWith({ roles: { review: { creditOk: true, deny: [] } } });
    const d2 = decideOnWorld(w, { role: 'review', execLocation: 'host', model: 'GLM-5.3', estimateUsd: 0 }, noYaml);
    expect(d2.outcome).toBe('stop');
    if (d2.outcome === 'stop') expect(d2.skipped[0]!.why).toBe('deny:리뷰 GLM 금지(코드 상수): glm(코드 상수 — 절대)');
  });
});

describe('⑦ 동시 예약 초과 0', () => {
  async function race(ledger: SpendReservationLedger) {
    const w = createLlmProviderWorld({ startIso: START, balanceUsd: 1000 });
    exhaustAllSubscriptions(w, RESET_5H);
    w.openrouter.call({ role: 'judgement', estimateUsd: 250 }); // 오늘 250 → 잔여 상한 50
    const g = guardOnWorld(w, { reservations: ledger });
    const results = await Promise.all(Array.from({ length: 10 }, () => g.run({ role: 'judgement', execLocation: 'host', estimateUsd: 20 })));
    return { results, ledger: g.ledger, now: w.clock.now() }; // 예약 TTL(#39183)은 시뮬 시계 기준 — snapshot 에 시뮬 now 를 준다
  }

  test('메모리 원장 — 10 호출 × $20 / 잔여 $50 → 허용 2 · 멈춤 8 · 예약 합 40', async () => {
    const reservations = createInMemoryReservationLedger();
    const { results, now } = await race(reservations);
    expect(results.filter((r) => r.decision.outcome === 'choice')).toHaveLength(2);
    expect(results.filter((r) => r.decision.outcome === 'stop')).toHaveLength(8);
    expect(results.filter((r) => r.reservation !== undefined)).toHaveLength(2);
    expect(reservations.snapshot(now).reduce((sum, e) => sum + e.usd, 0)).toBe(40);
  });

  test('파일 원장 — 같은 결과(허용 2 · 예약 합 40) · 파일이 있고 깨지지 않음', async () => {
    const path = join(tmp, 'reservations.json');
    const reservations = createFileReservationLedger(path);
    const { results, now } = await race(reservations);
    expect(results.filter((r) => r.decision.outcome === 'choice')).toHaveLength(2);
    expect(results.filter((r) => r.decision.outcome === 'stop')).toHaveLength(8);
    const snap = reservations.snapshot(now);
    expect(snap.map((e) => e.state)).toEqual(['reserved', 'reserved']);
    expect(snap.reduce((sum, e) => sum + e.usd, 0)).toBe(40);
  });

  test('확정 뒤에도 초과 0 — 두 건 commit(실제 21 · 19) 후 추가 호출은 거부', async () => {
    const reservations = createInMemoryReservationLedger();
    const { results, now } = await race(reservations);
    const handles = results.map((r) => r.reservation).filter((h) => h !== undefined);
    expect(handles[0]!.commit(21)).toBe(true);
    expect(handles[1]!.commit(19)).toBe(true);
    expect(reservations.snapshot(now).reduce((sum, e) => sum + e.usd, 0)).toBe(40);
  });
});

describe('⑧ 공급자 오류 문구 비밀 0', () => {
  test('탐침 자체가 비밀 모양을 잡는다(양성 대조)', () => {
    for (const bad of ['sk-abcdefgh12345678', 'ghp_abcdefgh12345678', 'eyJhbGciOiJIUzI1NiJ9', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2']) {
      expect(SECRET_SHAPE_PROBE.test(bad)).toBe(true);
    }
    expect(SECRET_SHAPE_PROBE.test('MD-UX-SIM-LLM-PROVIDER-WORLD-SUBSCRIPTIONS-TS usage_limit_reached 2026-11-20T05:00:00.000Z')).toBe(false);
  });

  test('장치 오류 문구 · 결정 출력 · 가드 원장 · 예약 원장 어디에도 비밀 모양 0', async () => {
    const w = createLlmProviderWorld({ startIso: START, balanceUsd: 0 });
    const reservations = createInMemoryReservationLedger();
    const g = guardOnWorld(w, { reservations });
    const seen: unknown[] = [];
    w.codex.default.exhaust('five-hour', RESET_5H);
    seen.push(w.codex.default.call(), w.openrouter.call({ estimateUsd: 5 }));
    w.acp.setAlive(false);
    seen.push(w.acp.call());
    w.acp.setAlive(true);
    w.acp.setSessions(4);
    seen.push(w.acp.call());
    seen.push(w.targets.pod.supply('sk-abcdefghijklmnopqrstuvwx'), w.targets.pod.supply('claude-acp'), w.targets.configDir.supply('nope'));
    exhaustAllSubscriptions(w, RESET_5H);
    seen.push(w.states());
    seen.push(await g.run({ role: 'judgement', execLocation: 'host', estimateUsd: 1 })); // 잔액 0 → 멈춤
    w.openrouter.setBalanceUsd(500);
    seen.push(await g.run({ role: 'review', execLocation: 'pod', estimateUsd: 1 }));
    seen.push(decideOnWorld(w, { role: 'review', execLocation: 'host', model: 'glm-5.3' }));
    seen.push(g.ledger, reservations.snapshot());
    const strings = collectStrings(seen);
    // 탐침이 빈 입력을 훑는 게 아님 — 실제 오류 문구들이 모인 것을 확인한다.
    expect(strings).toContain('OpenRouter credits insufficient: balance $0.00 is below call cost $5.00');
    expect(strings).toContain('The usage limit has been reached (codex-default: five-hour). Resets at 2026-11-20T05:00:00.000Z.');
    expect(strings).toContain('claude-acp device is down on the host');
    expect(strings.filter((s) => SECRET_SHAPE_PROBE.test(s))).toEqual([]);
    // 거부 사유는 입력한 값을 되풀이하지 않는다
    expect(JSON.stringify(seen)).not.toContain('abcdefghijklmnopqrstuvwx');
  });
});

describe('⑨ claude-acp', () => {
  function acpWorld() {
    const w = createLlmProviderWorld({ startIso: START, balanceUsd: 100 });
    exhaustAllSubscriptions(w, RESET_5H);
    w.acp.setWindow({ usedPct: 10 });
    return w;
  }
  const req = { role: 'judgement', estimateUsd: 1 } as const;

  test('호스트에서는 claude-acp · Pod 에서는 제외(host-only-device) → openrouter', () => {
    const w = acpWorld();
    expect(decideOnWorld(w, { ...req, execLocation: 'host' })).toMatchObject({ outcome: 'choice', row: 'claude-acp' });
    const pod = decideOnWorld(w, { ...req, execLocation: 'pod' });
    expect(pod).toMatchObject({ outcome: 'choice', row: 'openrouter' });
    if (pod.outcome === 'choice') {
      expect(pod.skipped.find((s) => s.row === 'claude-acp')!.why).toBe('host-only-device(ACP 장치는 Pod 실행에서 제외)');
    }
  });

  test('장치 헬스 실패 → 다음 후보(openrouter) · 세션 가득도 같음', () => {
    const w = acpWorld();
    w.acp.setAlive(false);
    expect(w.acp.call()).toEqual({ ok: false, device: 'claude-acp', status: 503, code: 'device_down', message: 'claude-acp device is down on the host' });
    let d = decideOnWorld(w, { ...req, execLocation: 'host' });
    expect(d).toMatchObject({ outcome: 'choice', row: 'openrouter' });
    if (d.outcome === 'choice') expect(d.skipped.find((s) => s.row === 'claude-acp')!.why).toBe('device-health-failed(장치 헬스 실패 — 다음 후보)');

    w.acp.setAlive(true);
    w.acp.setSessions(4);
    d = decideOnWorld(w, { ...req, execLocation: 'host' });
    expect(d).toMatchObject({ outcome: 'choice', row: 'openrouter' });
    if (d.outcome === 'choice') expect(d.skipped.find((s) => s.row === 'claude-acp')!.why).toBe('device-sessions-full(4 ≥ 동시 세션 상한 4)');
  });
});

describe('⑩ 공급', () => {
  test('고른 행의 금고 항목을 SupplyTarget 에 supply → pod/ta 허용 · claude-acp pod 거부 · revoke 뒤 목록 0', () => {
    const policy = defaultSpendPolicyDoc();
    const w = createLlmProviderWorld({
      startIso: START,
      supplyPolicy: { 'oauth:codex:team': ['pod', 'ta', 'host', 'config-dir'], 'claude-acp': ['host', 'config-dir'] },
    });
    w.codex.default.setUsedPct('five-hour', 95);
    const d = decideOnWorld(w, { role: 'judgement', execLocation: 'pod', estimateUsd: 1 });
    expect(d).toMatchObject({ outcome: 'choice', row: 'codex-team' });
    const row = policy.providers['codex-team']!;
    expect(row.kind === 'subscription' ? row.vault : undefined).toBe('oauth:codex:team');

    const pod = w.targets.pod.supply('oauth:codex:team');
    const ta = w.targets.ta.supply('oauth:codex:team');
    expect(pod).toEqual({ ok: true, leaseId: 'MD-UX-SIM-LLM-SUPPLY-TARGETS-TS:pod-lease-1' });
    expect(ta).toEqual({ ok: true, leaseId: 'MD-UX-SIM-LLM-SUPPLY-TARGETS-TS:ta-lease-1' });
    expect(w.targets.pod.leases()).toEqual([{ vaultItem: 'oauth:codex:team', leaseId: 'MD-UX-SIM-LLM-SUPPLY-TARGETS-TS:pod-lease-1', expiresAt: '2026-11-20T01:00:00.000Z' }]);

    expect(w.targets.pod.supply('claude-acp')).toEqual({ ok: false, reason: 'host-only-item' });
    expect(w.targets.ta.supply('claude-acp')).toEqual({ ok: false, reason: 'host-only-item' });
    expect(w.targets.configDir.supply('claude-acp')).toMatchObject({ ok: true });

    if (!pod.ok || !ta.ok) throw new Error('supply failed');
    w.targets.pod.revoke(pod.leaseId);
    w.targets.ta.revoke(ta.leaseId);
    expect(w.targets.pod.leases()).toEqual([]);
    expect(w.targets.ta.leases()).toEqual([]);
  });
});

describe('⑪ 원격 호스트 heartbeat — desiredSha 어긋남', () => {
  test('desired ≠ observed 가 관측되고 맞추면 사라진다 · 죽으면 alive false', () => {
    const w = createLlmProviderWorld({ startIso: START, remoteHostName: 'sim-host-a' });
    w.remote.setDesiredSha('sha-desired-2');
    w.remote.setObservedSha('sha-observed-1');
    expect(w.remote.drifted()).toBe(true);
    expect(w.remote.heartbeat()).toEqual({ at: '2026-11-20T00:00:00.000Z', desiredSha: 'sha-desired-2', observedSha: 'sha-observed-1', alive: true });
    w.clock.advance(60_000);
    w.remote.setObservedSha('sha-desired-2');
    expect(w.remote.drifted()).toBe(false);
    w.remote.setAlive(false);
    expect(w.remote.heartbeat()).toEqual({ at: '2026-11-20T00:01:00.000Z', desiredSha: 'sha-desired-2', observedSha: 'sha-desired-2', alive: false });
  });
});
