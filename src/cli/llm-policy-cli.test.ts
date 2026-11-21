// `eln llm policy` 시험 — 적용 값 전부 · 출처 표기(default/stored) · 주입된 상태만 · 비밀 0.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIVE_SYNTHETIC_DENIED, runLlmPolicyInject, runLlmPolicyView } from './llm-policy-cli.js';
import { appendSpendObservation, readSpendObservations, spendObservationsFile } from '../nexus/llm-spend-policy/observations.js';
import { readRecentSpendTransitions } from '../nexus/llm-spend-policy/ledger.js';
import { setTestStateRoot } from '../nexus/paths.js';
import { writeStoredSpendPolicy } from '../nexus/llm-spend-policy/store.js';
import type { LlmSpendRowState } from '../nexus/llm-spend-policy/types.js';

let dir: string;
let lines: string[];

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'llm-policy-cli-test-')), 'policy');
  lines = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function view(opts: { json?: boolean; now?: Date; states?: readonly LlmSpendRowState[] } = {}): Promise<string> {
  await runLlmPolicyView({ ...opts, dir, out: (line) => { lines.push(line); } });
  return lines.join('\n');
}

describe('runLlmPolicyView — 모름 표기 · 전 값 출처', () => {
  test('임대 상태가 주입되지 않으면 «임대 없음» 이 아니라 미측정으로 표시한다', async () => {
    const text = await view();
    expect(text).toContain('임대 unmeasured(주입 없음)');
    expect(text).not.toMatch(/임대 없음/);
  });
  test('임대 유무를 아는 경우(leaseId null)에만 «임대 없음» 이 나온다', async () => {
    const text = await view({ states: [{ row: 'codex-default', provider: 'openai-codex', lease: { leaseId: null, reason: 'no-lease' } }] });
    expect(text).toContain('임대 없음(no-lease)');
  });
  test('kind·provider·vault·onExhausted·역할 prefer/deny 전부 출처 표기가 붙는다', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { roles: { review: { creditOk: true, prefer: ['codex-team'], deny: ['openrouter'] } } } });
    const text = await view();
    const rowLine = text.split('\n').find((l) => l.startsWith('─ 행 codex-default'))!;
    expect(rowLine).toMatch(/subscription \[default\] · openai-codex \[default\].*\[default\]$/);
    expect(text).toMatch(/소진 순서: .* \[default\]/);
    const roleLine = text.split('\n').find((l) => l.startsWith('─ 역할 review'))!;
    expect(roleLine).toContain('prefer: codex-team [yaml]');
    expect(roleLine).toContain('deny: openrouter [yaml]');
    const taLine = text.split('\n').find((l) => l.startsWith('─ 역할 ta-child'))!;
    expect(taLine).toContain('prefer: (없음) [default]');
  });
});

describe('runLlmPolicyView — 적용 값 + 출처', () => {
  test('정본이 없으면 코드 기본 전부를 [default] 출처로 보여 준다', async () => {
    const text = await view();
    expect(text).toContain('LLM 지출 정책 한 장');
    expect(text).toContain('저장 정책 없음(코드 기본만 적용)');
    expect(text).toContain('fallbackOrder: codex-default → codex-team → codex-third → claude-code-sub → claude-acp → openrouter [default]');
    expect(text).toContain('returnOnReset: true [default]');
    expect(text).toContain('─ 행 codex-default — subscription [default] · openai-codex [default] · 금고: oauth:codex:default [default]');
    expect(text).toContain('capPct: 95% [default]'); // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
    expect(text).toContain('spendCap: 일 300USD [default]');
    expect(text).toContain('─ 역할 review — creditOk: true [default]');
    expect(text).toContain('creditOk=false');
  });
  test('저장 덮어씀은 [yaml] 로, 안 덮은 잎은 [default] 로 같은 줄에 구분해 보여 준다', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } }, returnOnReset: false } }); // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
    const text = await view();
    expect(text).toContain(`정본: ${dir}/policy.yaml`);
    expect(text).toContain('저장 정책 유효 · v1');
    expect(text).toContain('capPct: 90% [yaml]'); // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
    expect(text).toContain('returnOnReset: false [yaml]');
    expect(text).toContain('capPct: 60% [default]'); // codex-team 은 덮지 않았다
    expect(text).toContain('─ 행 codex-default — subscription [default] · openai-codex [default]');
  });
  test('공급자 상태는 주입된 것만 보여 준다(없으면 unmeasured)', async () => {
    const noStates = await view();
    expect(noStates).toContain('창 unmeasured(주입 없음)');
    expect(noStates).toContain('잔액 unmeasured(missing-management-lease)'); // CC-1 어댑터: 임대 없으면 네트워크 0 · unmeasured
    const injected = await view({
      states: [{
        row: 'codex-default', provider: 'openai-codex',
        window: { status: 'measured', usedPct: 42, observedAt: '2026-11-20T03:00:00Z' },
        lease: { leaseId: 'lease-1', expiresAt: '2026-11-20T04:00:00Z' },
      }],
    });
    expect(injected).toContain('창 실측 42%');
    expect(injected).toContain('임대 lease-1');
  });
  test('출력에 비밀 값 모양이 없다(금고 «이름» 만 찍는다)', async () => {
    const text = await view();
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{8,}\./);
    expect(text).toContain('금고: oauth:codex:default');
  });
  test('--json 은 적용 문서·출처·저장 상태를 한 덩어리로 내보낸다', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } } } }); // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
    await view({ json: true });
    const parsed = JSON.parse(lines.join('\n')) as {
      policy: { providers: Record<string, { capPct?: number }> };
      sources: Record<string, string>;
      stored: { present: boolean; valid: boolean; version: number | null };
    };
    expect(parsed.policy.providers['codex-default']!.capPct).toBe(90);
    expect(parsed.sources['providers.codex-default.capPct']).toBe('stored');
    expect(parsed.sources['providers.codex-team.capPct']).toBe('default');
    expect(parsed.stored.present).toBe(true);
    expect(parsed.stored.valid).toBe(true);
    expect(parsed.stored.version).toBe(1);
  });
});

describe('runLlmPolicyView — 저장 정책이 깨졌을 때도 비밀 원문 0 (JUD #109425)', () => {
  test('비밀 모양 키가 든 정본을 읽어도 텍스트·JSON 출력에 원문이 없다', async () => {
    const secret = 'sk-ant-api03-abcdefghijklmnop';
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'policy.yaml'), ['providers:', '  ' + secret + ':', '    capPct: 5', 'roles:', '  ' + secret + ':', '    prefer: []', ''].join('\n')); // 출처: #39171 정책 표 시험 픽스처
    expect(await view()).not.toContain(secret);
    lines = [];
    expect(await view({ json: true })).not.toContain(secret);
  });
});

describe('runLlmPolicyInject — 합성 사건 결정 드라이런', () => {
  const T = new Date('2026-11-20T03:00:00.000Z');
  const LEASE = '2026-11-20T23:00:00.000Z';
  const leases = (): LlmSpendRowState[] => ['codex-default', 'codex-team', 'codex-third', 'claude-code-sub'].map((row) => ({
    row, provider: 'openai-codex', window: { status: 'measured' as const, usedPct: 10, observedAt: T.toISOString() }, lease: { leaseId: `l-${row}`, expiresAt: LEASE },
  }));
  async function inject(opts: Parameters<typeof runLlmPolicyInject>[0]) {
    const out: string[] = [];
    const result = await runLlmPolicyInject({ dir, now: () => T, out: (l) => { out.push(l); }, ...opts });
    return { result, out };
  }
  const policy = () => writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } } } });
  afterEach(() => { setTestStateRoot(null); });

  test('정책 정본이 없는 우주는 거부 · 관측·원장 0', async () => {
    const { result } = await inject({ row: 'codex-team', event: 'usage_limit_reached' });
    expect(result).toEqual({ ok: false, error: '정책 정본(policy.yaml)이 없는 우주 — 주입은 정책이 있는 우주에서만 의미가 있다' });
    expect(await readSpendObservations(dir)).toEqual([]);
    expect(await readRecentSpendTransitions(20, dir)).toEqual([]);
  });
  test('드라이런: «지금 이 사건이면» 선택 행·사유·skipped 를 계산 · 실 관측 저장소 0 쓰기 · 원장 synthetic:true 줄', async () => {
    await policy();
    const { result, out } = await inject({ row: 'codex-default', event: 'usage_limit_reached', resetsAt: '2026-11-20T08:00:00Z', states: leases() });
    expect(result.ok && result.mode).toBe('dry-run');
    expect(result.ok && result.decision?.outcome).toBe('choice');
    expect(result.ok && result.decision?.row).toBe('codex-team');
    expect(result.ok && result.decision?.skipped.some((s) => s.row === 'codex-default')).toBe(true);
    expect(out.join('\n')).toContain('지금 이 사건이면 선택: codex-team');
    expect(await readSpendObservations(dir)).toEqual([]); // 실 저장소 0 쓰기
    const obsFile = await spendObservationsFile(dir);
    expect(existsSync(obsFile)).toBe(false);
    expect(existsSync(join(dir, 'guard-memory.json'))).toBe(false); // 가드 기억 불변
    expect(existsSync(join(dir, 'reservations.json'))).toBe(false); // 예약 원장 불변
    const ledger = await readRecentSpendTransitions(20, dir);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ action: 'decision', to: 'codex-team', synthetic: true });
    expect(ledger[0]!.reason).toContain('synthetic-dry-run');
  });
  test('드라이런은 현재 실제(real) 관측 위에 오버레이 — real 소진 + window-reset 합성 → 복귀 선택 · 실 저장소의 real 은 그대로', async () => {
    await policy();
    await appendSpendObservation({ id: 'r1', row: 'codex-default', provider: 'openai-codex', kind: 'window', source: 'real', observedAt: '2026-11-20T02:00:00.000Z', usedPct: 100 }, dir);
    const before = await readSpendObservations(dir);
    const { result } = await inject({ row: 'codex-default', event: 'window-reset', states: leases().map((s) => ({ row: s.row, provider: s.provider, lease: s.lease })) });
    expect(result.ok && result.decision?.row).toBe('codex-default');
    expect(await readSpendObservations(dir)).toEqual(before);
  });
  test('드라이런 결과가 실 관문 결정에 영향 0 — 드라이런 뒤 실 observer 는 synthetic 을 읽지 않는다', async () => {
    await policy();
    await inject({ row: 'codex-default', event: 'usage_limit_reached', states: leases() });
    const { createObservationObserver } = await import('../nexus/llm-spend-policy/observations.js');
    expect(await createObservationObserver(dir)()).toEqual([]);
  });
  test('다섯 사건 모두 · 구독/크레딧 불일치 거부 · spend-cap 은 amount 필수', async () => {
    await policy();
    expect((await inject({ row: 'codex-team', event: 'window-reset' })).result.ok).toBe(true);
    expect((await inject({ row: 'openrouter', event: 'insufficient_credits' })).result.ok).toBe(true);
    expect((await inject({ row: 'openrouter', event: 'spend-cap', amountUsd: '300' })).result.ok).toBe(true);
    expect((await inject({ row: 'openrouter', event: 'auto-topup', amountUsd: 20 })).result.ok).toBe(true);
    expect((await inject({ row: 'openrouter', event: 'window-reset' })).result.ok).toBe(false);
    expect((await inject({ row: 'openrouter', event: 'spend-cap' })).result.ok).toBe(false);
    expect((await inject({ row: 'nope', event: 'window-reset' })).result.ok).toBe(false);
    expect((await readRecentSpendTransitions(20, dir)).every((e) => e.synthetic === true)).toBe(true);
    expect(await readSpendObservations(dir)).toEqual([]);
  });
  describe('window-usage — 기울기 입력 + 가상 임대(드라이런 전용)', () => {
    const RESET = '2026-11-21T09:00:00Z'; // T(11-20 03:00Z) + 30h
    const windowOnly = (): LlmSpendRowState[] => leases().filter((s) => s.row !== 'codex-default').map((s) => ({ row: s.row, provider: s.provider, window: s.window! }));
    const usage = (slope: number, role: string) => inject({ row: 'codex-default', event: 'window-usage', usedPct: 50, slopePctPerHour: slope, resetsAt: RESET, role, states: windowOnly() });
    test('기울기 2%/h · 리셋 30h · 사용 50% → 95% 도달 22.5h < 30h → ta-child 는 다음 행으로 이동(burn-shift) · 가상 임대 표기', async () => {
      await policy();
      const { result, out } = await usage(2, 'ta-child');
      expect(result.ok && result.decision?.outcome).toBe('choice');
      expect(result.ok && result.decision?.row).toBe('codex-team');
      expect(result.ok && result.decision?.lease).toBe('virtual(dry-run)');
      expect(result.ok && result.decision?.skipped.find((s) => s.row === 'codex-default')?.why).toContain('burn-shift(');
      expect(out.join('\n')).toContain('burn-shift 이동: 역할 ta-child codex-default → codex-team');
      expect(out.join('\n')).toContain('lease: virtual(dry-run)');
      expect((await readRecentSpendTransitions(20, dir))[0]).toMatchObject({ to: 'codex-team', synthetic: true });
    });
    test('상위 우선 역할(review·authoring)은 같은 사건에서 이동 0 · 기울기 낮으면(0.5%/h) ta-child 도 머문다', async () => {
      await policy();
      expect((await usage(2, 'review')).result).toMatchObject({ ok: true, decision: { row: 'codex-default' } });
      expect((await usage(2, 'authoring')).result).toMatchObject({ ok: true, decision: { row: 'codex-default' } });
      expect((await usage(0.5, 'ta-child')).result).toMatchObject({ ok: true, decision: { row: 'codex-default' } });
    });
    test('review deny(YAML)는 이동 후보에도 절대 — 가상 임대가 deny 를 풀지 않는다', async () => {
      await writeStoredSpendPolicy({ actor: 'test', dir, document: { roles: { 'ta-child': { creditOk: true, deny: ['codex-team'] } } } });
      const { result } = await inject({ row: 'codex-default', event: 'window-usage', usedPct: 50, slopePctPerHour: 2, resetsAt: RESET, role: 'ta-child', model: 'codex-team', states: windowOnly() });
      expect(result.ok && result.decision?.outcome).toBeDefined();
      expect(JSON.stringify(result)).not.toContain('"row":"codex-team","model":"codex-team"');
    });
    test('실 저장소 0 쓰기 · 합성 표식 유지 · 실 관문 observer 는 합성(기울기 포함)을 읽지 않는다 · 임대 주입이 있으면 가상 임대는 덮지 않는다', async () => {
      await policy();
      await usage(2, 'ta-child');
      expect(existsSync(await spendObservationsFile(dir))).toBe(false);
      expect((await readRecentSpendTransitions(20, dir)).every((l) => l.synthetic === true)).toBe(true);
      const own = await inject({ row: 'codex-default', event: 'window-usage', usedPct: 50, slopePctPerHour: 2, resetsAt: RESET, role: 'ta-child', states: [...windowOnly(), { row: 'codex-team', provider: 'openai-codex', lease: { leaseId: null, reason: 'no-lease' } }] });
      expect(own.result.ok && own.result.decision?.skipped.find((s) => s.row === 'codex-team')?.why).toContain('no-lease');
    });
    test('JUD-B 회귀: 선택 행에 명시 임대가 있으면 lease 는 injected(id 값 노출 0) · 명시 임대가 가상보다 이긴다 · 다른 행의 명시 임대는 선택 행 라벨에 영향 0', async () => {
      await policy();
      const lowUse = { row: 'codex-default', event: 'window-usage' as const, usedPct: 10, slopePctPerHour: 0.1, resetsAt: RESET, role: 'authoring' };
      const explicit: LlmSpendRowState = { row: 'codex-default', provider: 'openai-codex', lease: { leaseId: 'REAL-LEASE-TEST', expiresAt: LEASE } };
      const chosen = await inject({ ...lowUse, states: [...windowOnly(), explicit] });
      expect(chosen.result.ok && chosen.result.decision?.row).toBe('codex-default');
      expect(chosen.result.ok && chosen.result.decision?.lease).toBe('injected');
      expect(chosen.out.join('\n')).toContain('lease: injected');
      expect(chosen.out.join('\n')).not.toContain('virtual(dry-run)');
      expect(chosen.out.join('\n')).not.toContain('REAL-LEASE-TEST');
      const json = await inject({ ...lowUse, json: true, states: [...windowOnly(), explicit] });
      expect(JSON.parse(json.out[0]!).decision.lease).toBe('injected');
      expect(json.out[0]).not.toContain('REAL-LEASE-TEST');
      // 선택 행(codex-default)이 아닌 다른 행(codex-team)의 명시 임대 → 선택 행은 가상 임대 그대로.
      const other = await inject({ ...lowUse, states: [...windowOnly().filter((x) => x.row !== 'codex-team'), { row: 'codex-team', provider: 'openai-codex', lease: { leaseId: 'REAL-LEASE-TEST', expiresAt: LEASE } }] });
      expect(other.result.ok && other.result.decision?.lease).toBe('virtual(dry-run)');
    });
    test('UX #115450 회귀: 같은 행이 두 번 주입돼도(앞 항목 임대 없음 · 뒤 항목 명시 임대) 선택 행 라벨은 injected', async () => {
      await policy();
      const lowUse = { row: 'codex-default', event: 'window-usage' as const, usedPct: 50, slopePctPerHour: 0, resetsAt: RESET, role: 'review' };
      const bare: LlmSpendRowState = { row: 'codex-default', provider: 'openai-codex' };
      const explicit: LlmSpendRowState = { row: 'codex-default', provider: 'openai-codex', lease: { leaseId: 'REAL-LEASE-TEST', expiresAt: LEASE } };
      const dup = await inject({ ...lowUse, json: true, states: [bare, explicit] });
      const parsed = JSON.parse(dup.out[0]!);
      expect(parsed.decision.row).toBe('codex-default');
      expect(parsed.decision.lease).toBe('injected');
      expect(dup.out[0]).not.toContain('REAL-LEASE-TEST');
    });
    test('가상 임대가 선택 행에 실제 적용되면 lease 는 virtual(dry-run) — 텍스트·JSON 동일 · 멈춤이면 none', async () => {
      await policy();
      const base = { row: 'codex-default', event: 'window-usage' as const, usedPct: 10, slopePctPerHour: 0.1, resetsAt: RESET, role: 'authoring', states: windowOnly() };
      const v = await inject(base);
      expect(v.result.ok && v.result.decision?.lease).toBe('virtual(dry-run)');
      expect(v.out.join('\n')).toContain('lease: virtual(dry-run)');
      const stop = await inject({ ...base, event: 'usage_limit_reached', usedPct: undefined, slopePctPerHour: undefined, json: true, states: windowOnly().map((x) => ({ ...x, window: { status: 'unmeasured' as const, reason: 'test' } })).concat([{ row: 'codex-default', provider: 'openai-codex', window: { status: 'unmeasured' as const, reason: 'test' } }]) });
      expect(stop.result.ok && stop.result.decision?.outcome).toBe('stop');
      expect(JSON.parse(stop.out[0]!).decision.lease).toBe('none');
    });
    test('OP #115146 리터럴: codex-default 50% · 2%/h · 리셋 30h · ta-child → 유일한 적격 openrouter 로 burn-shift · 원장 줄 리터럴', async () => {
      // ta-child 기본 creditOk=false 라 시험에서 명시적으로 true 로 둔다(크레딧 행 도달 조건).
      await writeStoredSpendPolicy({ actor: 'test', dir, document: { roles: { 'ta-child': { creditOk: true } } } });
      const exhausted = (row: string): LlmSpendRowState => ({ row, provider: 'openai-codex', window: { status: 'measured', usedPct: 100, observedAt: T.toISOString() }, lease: { leaseId: `l-${row}`, expiresAt: LEASE } });
      const states: LlmSpendRowState[] = [
        exhausted('codex-team'), exhausted('codex-third'),
        { ...exhausted('claude-code-sub'), provider: 'anthropic' },
        { row: 'claude-acp', provider: 'claude-acp', device: { status: 'measured', alive: false, sessions: 0, observedAt: T.toISOString() } },
        {
          row: 'openrouter', provider: 'openrouter',
          balance: { status: 'measured', usd: 100, totalCreditsUsd: 100, totalUsageUsd: 0, source: 'test', observedAt: T.toISOString() },
          spend: { todayUsd: 0, monthUsd: 0, observedAt: T.toISOString() },
          lease: { leaseId: 'or-lease', expiresAt: LEASE },
        },
      ];
      const { result, out } = await inject({ row: 'codex-default', event: 'window-usage', usedPct: 50, slopePctPerHour: 2, resetsAt: '2026-11-21T09:00:00.000Z', role: 'ta-child', states });
      expect(result.ok && result.decision?.row).toBe('openrouter');
      expect(result.ok && result.decision?.lease).toBe('injected');
      expect(out.join('\n')).toContain('burn-shift 이동: 역할 ta-child codex-default → openrouter');
      const line = (await readRecentSpendTransitions(20, dir))[0]!;
      expect(line).toMatchObject({ action: 'decision', what: 'codex-default', to: 'openrouter', synthetic: true, actor: 'inject-cli', at: T.toISOString() });
      expect(line.reason).toContain('burn-shift codex-default→openrouter');
    });
    test('입력 검증: window-usage 는 --used-pct 필수 · 다른 사건에 기울기 거부 · 크레딧 행 거부', async () => {
      await policy();
      expect((await inject({ row: 'codex-default', event: 'window-usage' })).result.ok).toBe(false);
      expect((await inject({ row: 'codex-default', event: 'window-usage', usedPct: 50, slopePctPerHour: -1 })).result.ok).toBe(false);
      expect((await inject({ row: 'codex-default', event: 'window-reset', slopePctPerHour: 1 })).result.ok).toBe(false);
      expect((await inject({ row: 'openrouter', event: 'window-usage', usedPct: 50 })).result.ok).toBe(false);
    });
  });
  test('--json 은 결정 요약을 한 줄 JSON 으로 낸다', async () => {
    await policy();
    const { out } = await inject({ row: 'codex-default', event: 'usage_limit_reached', json: true, states: leases() });
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: true, mode: 'dry-run', decision: { outcome: 'choice', row: 'codex-team' } });
  });
  test('운영 신원(getTestStateRoot 없음): --live-synthetic 거부 — 리터럴 오류 · 저장소·원장 0 쓰기', async () => {
    await policy();
    const { result } = await inject({ row: 'codex-default', event: 'usage_limit_reached', liveSynthetic: true });
    expect(result).toEqual({ ok: false, error: LIVE_SYNTHETIC_DENIED });
    expect(LIVE_SYNTHETIC_DENIED).toBe('--live-synthetic 은 시험 우주 신원(getTestStateRoot)이 있을 때만 허용된다 — 운영 우주는 합성 관측을 실 관문 저장소에 쓰지 않는다(드라이런만)');
    expect(await readSpendObservations(dir)).toEqual([]);
    expect(await readRecentSpendTransitions(20, dir)).toEqual([]);
  });
  test('시험 우주 신원: --live-synthetic 허용 — synthetic 관측 저장 + 원장 synthetic:true', async () => {
    await policy();
    setTestStateRoot(join(dir, '..', 'test-root'));
    const { result } = await inject({ row: 'codex-team', event: 'usage_limit_reached', resetsAt: '2026-11-20T08:00:00Z', liveSynthetic: true });
    expect(result.ok && result.mode).toBe('live-synthetic');
    const obs = await readSpendObservations(dir);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ row: 'codex-team', kind: 'window', source: 'synthetic', usedPct: 100, resetAt: '2026-11-20T08:00:00.000Z' });
    const ledger = await readRecentSpendTransitions(20, dir);
    expect(ledger[0]).toMatchObject({ action: 'observe', what: 'codex-team', to: 'usage_limit_reached', synthetic: true });
  });
});

describe('runLlmPolicyView — 자동 충전 원천(declared|observed) · 비밀 0 (CREDIT-PROVIDER-TOPUP-READ)', () => {
  // 출처: 리터럴 독립 — 2026-11-20 REL 실측 «autoTopUp = unmeasured · not-provided» 빨강 원문의 반대 단언. 임대 값은 가짜 문자열.
  const FAKE_LEASE = 'fake-mgmt-lease-ZZ9-not-real';
  const okFetch = (async () => new Response(JSON.stringify({ data: { total_credits: 100, total_usage: 40 } }), { status: 200 })) as unknown as typeof fetch;
  type Parsed = { states: { row: string; balance?: { status: string; usd?: number; reason?: string }; autoTopUp?: { status: string; reason?: string; enabled?: boolean; amountUsd?: number; source?: string; observedAt?: string } }[] };
  async function json(extra: { leases?: Record<string, string> } = {}): Promise<{ text: string; or: NonNullable<Parsed['states'][number]> }> {
    await runLlmPolicyView({ json: true, dir, out: (line) => { lines.push(line); }, credit: { ...extra, fetchImpl: okFetch } });
    const text = lines.join('\n');
    return { text, or: (JSON.parse(text) as Parsed).states.find((s) => s.row === 'openrouter')! };
  }
  test('아무 원천도 없으면 unmeasured(not-provided) — 모름을 꺼짐으로 접지 않는다', async () => {
    const { or } = await json();
    expect(or.autoTopUp).toEqual({ status: 'unmeasured', reason: 'not-provided' });
  });
  test('정책 행에 선언된 autoTopUp 은 on/금액/출처 declared 로 나온다', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { openrouter: { autoTopUp: { status: 'measured', enabled: true, amountUsd: 50, observedAt: '2026-11-20T01:00:00Z' } } } } });
    const { or } = await json();
    expect(or.autoTopUp).toEqual({ status: 'measured', enabled: true, amountUsd: 50, source: 'declared', observedAt: '2026-11-20T01:00:00Z' });
  });
  test('실 관측(real) autoTopUp 이 선언을 이기고 출처 observed 로 나온다 · 합성은 무시', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { openrouter: { autoTopUp: { status: 'measured', enabled: true, amountUsd: 50, observedAt: '2026-11-20T01:00:00Z' } } } } });
    await appendSpendObservation({ id: 'r1', row: 'openrouter', provider: 'openrouter', kind: 'autoTopUp', source: 'real', observedAt: '2026-11-20T02:00:00Z', enabled: false }, dir);
    await appendSpendObservation({ id: 's1', row: 'openrouter', provider: 'openrouter', kind: 'autoTopUp', source: 'synthetic', observedAt: '2026-11-20T03:00:00Z', enabled: true }, dir);
    const { or } = await json();
    expect(or.autoTopUp).toEqual({ status: 'measured', enabled: false, source: 'observed', observedAt: '2026-11-20T02:00:00Z' });
  });
  test('가짜 임대로 잔액 60USD 를 읽어도 임대 문자열은 JSON·텍스트 어디에도 없다', async () => {
    const { text, or } = await json({ leases: { openrouter: FAKE_LEASE } });
    expect(or.balance).toMatchObject({ status: 'measured', usd: 60 });
    expect(text).not.toContain(FAKE_LEASE);
    lines = [];
    await runLlmPolicyView({ dir, out: (line) => { lines.push(line); }, credit: { leases: { openrouter: FAKE_LEASE }, fetchImpl: okFetch } });
    expect(lines.join('\n')).not.toContain(FAKE_LEASE);
  });
  test('잔액 읽기 실패는 0 이 아니라 unmeasured(사유) — 임대 없음 = missing-management-lease', async () => {
    const { or } = await json();
    expect(or.balance).toEqual({ status: 'unmeasured', reason: 'missing-management-lease' });
  });
});

describe('runLlmPolicyView — 역할 × 현재 모델(드라이런)', () => {
  const now = new Date('2026-11-21T00:00:00Z');
  const lease = { leaseId: 'lease-1', expiresAt: '2026-11-21T06:00:00Z' } as const;
  const win = { status: 'measured', usedPct: 10, observedAt: '2026-11-20T23:59:00Z' } as const;
  const states: LlmSpendRowState[] = [{ row: 'codex-default', provider: 'openai-codex', lease, window: win }];

  async function seeded(): Promise<void> {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { roles: {
      review: { creditOk: true, prefer: ['codex-default'], deny: ['glm'] },
      'ta-child': { creditOk: false, prefer: ['codex-default'], deny: [] },
    } } });
  }

  test('주입 상태: 선택 줄(모델 있음·모델 미지정)이 역할별로 찍힌다', async () => {
    await seeded();
    const text = await view({ now, states });
    expect(text).toContain('역할 × 현재 모델(드라이런 · 실호출 0 · 주입·실측 상태 기준)');
    expect(text).toContain('  ta-child: codex-default · codex-default — decision(fallbackOrder 걷기)');
    expect(text).toContain('  supervisor: codex-default · (모델 미지정) — decision(fallbackOrder 걷기)');
    expect(text).toContain('  review: codex-default · codex-default — decision(fallbackOrder 걷기)');
  });
  test('상태 미주입이면 모델을 지어내지 않고 no-lease 사유를 낸다', async () => {
    await seeded();
    const text = await view({ now });
    const line = text.split('\n').find((l) => l.startsWith('  ta-child: '))!;
    expect(line).toContain('멈춤 — no-candidate(');
    expect(line).toContain('codex-default:no-lease(');
  });
  test('review + GLM deny: GLM 행은 deny 로 건너뛴다', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { roles: { review: { creditOk: true, prefer: ['openrouter/z-ai/glm-5.3'], deny: ['glm'] } } } });
    const text = await view({ now, states });
    const line = text.split('\n').find((l) => l.startsWith('  review: '))!;
    expect(line).toContain('멈춤 — no-candidate(');
    expect(line).toContain('deny:glm(YAML 역할 deny — 절대)');
  });
  test('json: roleCurrent 는 역할 8개 · 정해진 키', async () => {
    await seeded();
    const parsed = JSON.parse(await view({ json: true, now, states }));
    expect(parsed.roleCurrent.map((e: { role: string }) => e.role)).toEqual(['review', 'judgement', 'authoring', 'hand-seat', 'ta-child', 'recovery', 'supervisor', 'seat-op']);
    const ta = parsed.roleCurrent.find((e: { role: string }) => e.role === 'ta-child');
    expect(Object.keys(ta).sort()).toEqual(['model', 'outcome', 'reason', 'role', 'row', 'skipped']);
    expect(ta.outcome).toBe('choice');
    lines = [];
    const bare = JSON.parse(await view({ json: true, now })).roleCurrent.find((e: { role: string }) => e.role === 'supervisor');
    expect(Object.keys(bare).sort()).toEqual(['outcome', 'reason', 'role', 'skipped']);
    expect(bare.outcome).toBe('stop');
  });
});
