// 정책 저장소 시험 — 한 벌 정본·원자 쓰기·버전·변경 원장 1줄·이전 정상 정책 유지(fail-closed)·출처.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { SubscriptionRowPolicy } from './types.js';
import { readAppliedSpendPolicy, readRecentSpendPolicyChanges, readStoredSpendPolicy, spendPolicyFiles, writeStoredSpendPolicy } from './store.js';

let dir: string;

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'llm-spend-store-test-')), 'policy');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeStoredSpendPolicy — 검증 먼저 · 원자 쓰기', () => {
  test('유효한 문서를 쓰면 버전 1 이 되고 원장에 바뀐 키가 1줄 남는다', async () => {
    const written = await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } } } }); // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
    expect(written.ok).toBe(true);
    if (written.ok) {
      expect(written.version).toBe(1);
      expect(written.changedKeys).toContain('providers.codex-default.capPct');
    }
    const changes = await readRecentSpendPolicyChanges(20, dir);
    expect(changes.length).toBe(1);
    expect(changes[0]!.actor).toBe('test');
    expect(changes[0]!.version).toBe(1);
    expect(changes[0]!.changedKeys).toContain('providers.codex-default.capPct');
  });
  test('틀린 문서는 «한 글자도 쓰지 않고» 거부한다(capPct>100)', async () => {
    const written = await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 150 } } } }); // 출처: #39171 정책 표 시험 픽스처
    expect(written.ok).toBe(false);
    if (!written.ok) expect(written.errors.some((e) => e.includes('capPct is out of range'))).toBe(true);
    const paths = await spendPolicyFiles(dir);
    expect(existsSync(paths.policy)).toBe(false);
  });
  test('비밀 모양 값이 섞인 문서도 거부한다', async () => {
    const written = await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { openrouter: { vault: 'sk-1234567890abcdef' } } } });
    expect(written.ok).toBe(false);
    if (!written.ok) expect(written.errors.some((e) => e.includes('비밀 키 모양'))).toBe(true);
  });
  test('두 번 쓰면 버전이 오르고 바뀐 키만 원장에 남는다', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } } } }); // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
    const second = await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 85 } } } }); // 출처: #39171 정책 표 시험 픽스처
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.version).toBe(2);
      expect(second.changedKeys).toContain('providers.codex-default.capPct');
    }
    const changes = await readRecentSpendPolicyChanges(20, dir);
    expect(changes.length).toBe(2);
    expect(changes[0]!.version).toBe(2);
  });
  test('정본은 0600 으로 적는다(원자 쓰기 규약)', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { returnOnReset: false } });
    const paths = await spendPolicyFiles(dir);
    expect(statSync(paths.policy).mode & 0o777).toBe(0o600);
    const yaml = readFileSync(paths.policy, 'utf8');
    expect(yaml).toContain('returnOnReset: false');
    expect(yaml).toContain('한 벌'); // 정본 머리 주석
  });
  test('부분 행(오버레이)을 써도 undefined 잎이 null 로 박히지 않는다', async () => {
    const written = await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-team': { kind: 'subscription', provider: 'openai-codex' } } } });
    expect(written.ok).toBe(true);
    const paths = await spendPolicyFiles(dir);
    const yaml = readFileSync(paths.policy, 'utf8');
    expect(yaml).not.toMatch(/capPct: null/);
    expect(yaml).not.toMatch(/onExhausted: null/);
    // 다시 읽어도 유효해야 한다(쓴 정본이 읽기 검증을 통과)
    const stored = await readStoredSpendPolicy(dir);
    expect(stored.valid).toBe(true);
  });
});

describe('이전 정상 정책 유지 — fail-closed', () => {
  test('무효한 두 번째 쓰기는 첫 정상 정책을 그대로 둔다', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } } } }); // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: -3 } } } });
    const applied = await readAppliedSpendPolicy({ dir });
    expect((applied.policy.providers['codex-default'] as SubscriptionRowPolicy).capPct).toBe(90);
    expect(applied.sources['providers.codex-default.capPct']).toBe('stored');
  });
  test('첫 정상 쓰기 직후 정본이 손상돼도 그 첫 정책(최신 정상본)으로 복구된다', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } } } }); // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
    const paths = await spendPolicyFiles(dir);
    expect(existsSync(paths.lastGood)).toBe(true); // 첫 쓰기에도 last-good 이 생긴다
    writeFileSync(paths.policy, 'this: [is: not yaml', 'utf8');
    const stored = await readStoredSpendPolicy(dir);
    expect(stored.valid).toBe(true);
    expect(stored.fromLastGood).toBe(true);
    const applied = await readAppliedSpendPolicy({ dir });
    expect((applied.policy.providers['codex-default'] as SubscriptionRowPolicy).capPct).toBe(90);
  });
  test('연속 쓰기 뒤 정본이 손상되면 직전이 아니라 «최신» 정상 정책으로 복구된다', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } } } }); // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 85 } } } }); // 출처: #39171 정책 표 시험 픽스처
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 80 } } } }); // 출처: #39171 정책 표 시험 픽스처
    const paths = await spendPolicyFiles(dir);
    writeFileSync(paths.policy, 'this: [is: not yaml', 'utf8');
    const applied = await readAppliedSpendPolicy({ dir });
    expect(applied.stored.fromLastGood).toBe(true);
    expect((applied.policy.providers['codex-default'] as SubscriptionRowPolicy).capPct).toBe(80); // 최신 정상본
  });
  test('정본과 사본이 다 무효하면 코드 기본값으로 돌아가고 사유가 보인다', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } } } }); // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
    const paths = await spendPolicyFiles(dir);
    writeFileSync(paths.policy, 'unknownKey: 5\n', 'utf8');
    writeFileSync(paths.lastGood, 'unknownKey: 5\n', 'utf8');
    const stored = await readStoredSpendPolicy(dir);
    expect(stored.valid).toBe(false);
    const applied = await readAppliedSpendPolicy({ dir });
    expect((applied.policy.providers['codex-default'] as SubscriptionRowPolicy).capPct).toBe(95); // 코드 기본
    expect(applied.sources['providers.codex-default.capPct']).toBe('default');
  });
});

describe('저장 경로 fail-closed — 비밀 모양 키 · 무효 kind · overlay 오류', () => {
  test('비밀 모양 공급자 행 키는 저장 거부되고 파일·오류 어디에도 남지 않는다', async () => {
    const secretKey = 'sk-1234567890abcdef';
    const result = await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { [secretKey]: { kind: 'subscription', provider: 'openai-codex', capPct: 50 } } } }); // 출처: #39171 정책 표 시험 픽스처
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secretKey);
    const paths = await spendPolicyFiles(dir);
    expect(existsSync(paths.policy)).toBe(false);
    const applied = await readAppliedSpendPolicy({ dir });
    expect(JSON.stringify(applied)).not.toContain(secretKey);
  });
  test('명시된 무효 kind(bogus)는 저장 거부 — 이전 정상 정책 유지', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } } } }); // 출처: #39171 정책 표 시험 픽스처
    const result = await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { kind: 'bogus', capPct: 80 } } } }); // 출처: #39171 정책 표 시험 픽스처
    expect(result.ok).toBe(false);
    const applied = await readAppliedSpendPolicy({ dir });
    expect((applied.policy.providers['codex-default'] as SubscriptionRowPolicy).capPct).toBe(90);
  });
  test('적용 불가(overlay 오류) 문서는 저장하지 않는다(이전 정상 정책 유지)', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } } } }); // 출처: #39171 정책 표 시험 픽스처
    const paths = await spendPolicyFiles(dir);
    const before = readFileSync(paths.policy, 'utf8');
    // 기본 행과 kind 가 다른 문서(적용 불가) — 거짓 성공 없이 실패하고 정본은 그대로여야 한다.
    const result = await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { kind: 'credit', provider: 'openrouter' } } } });
    expect(result.ok).toBe(false);
    expect(readFileSync(paths.policy, 'utf8')).toBe(before);
  });
});

describe('readAppliedSpendPolicy — 적용 값 + 출처(default/stored)', () => {
  test('정본이 없으면 코드 기본 전부가 적용 값이다', async () => {
    const applied = await readAppliedSpendPolicy({ dir });
    expect(applied.stored.present).toBe(false);
    expect(applied.policy.fallbackOrder[0]).toBe('codex-default');
    expect(applied.sources['fallbackOrder']).toBe('default');
    expect(applied.sources['providers.openrouter.spendCap.dailyUsd']).toBe('default');
  });
  test('저장 덮어씀은 stored 출처로, 안 덮은 잎은 default 로 표기한다', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } }, returnOnReset: false } }); // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
    const applied = await readAppliedSpendPolicy({ dir });
    expect((applied.policy.providers['codex-default'] as SubscriptionRowPolicy).capPct).toBe(90);
    expect(applied.policy.providers['codex-default']!.kind).toBe('subscription');
    expect(applied.policy.returnOnReset).toBe(false);
    expect(applied.sources['providers.codex-default.capPct']).toBe('stored');
    expect(applied.sources['providers.codex-default.kind']).toBe('default');
    expect(applied.sources['returnOnReset']).toBe('stored');
    expect(applied.sources['providers.codex-team.capPct']).toBe('default');
  });
  test('공급자 상태는 주입된 것만 붙는다', async () => {
    const applied = await readAppliedSpendPolicy({
      dir,
      states: [{ row: 'codex-default', provider: 'openai-codex', window: { status: 'measured', usedPct: 42, observedAt: '2026-11-20T03:00:00Z' } }],
    });
    expect(applied.states.length).toBe(1);
    expect(applied.states[0]!.row).toBe('codex-default');
    const withoutStates = await readAppliedSpendPolicy({ dir });
    expect(withoutStates.states).toEqual([]);
  });
});

describe('writeStoredSpendPolicy — 병합 쓰기(JUD #109425 must②)', () => {
  test('부분 입력 쓰기 뒤에도 저장돼 있던 다른 행·역할이 보존된다', async () => {
    const first = await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 }, 'claude-acp': { hostOnly: false, maxSessions: 2 } }, roles: { review: { creditOk: false, prefer: ['codex-default'] } } } }); // 출처: #39171 정책 표 시험 픽스처
    expect(first.ok).toBe(true);
    const second = await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { openrouter: { spendCap: { dailyUsd: 50 } } } } }); // 출처: #39171 정책 표 시험 픽스처
    expect(second.ok).toBe(true);
    const view = await readAppliedSpendPolicy({ dir });
    const codex = view.policy.providers['codex-default'] as SubscriptionRowPolicy;
    expect(codex.capPct).toBe(90); // 출처: #39171 정책 표 시험 픽스처
    const acp = view.policy.providers['claude-acp'];
    expect(acp?.kind === 'acp-device' && acp.hostOnly).toBe(false);
    expect(acp?.kind === 'acp-device' && acp.maxSessions).toBe(2);
    const or = view.policy.providers.openrouter;
    expect(or?.kind === 'credit' && or.spendCap.dailyUsd).toBe(50); // 출처: #39171 정책 표 시험 픽스처
    expect(or?.kind === 'credit' && or.models).toEqual(['openrouter/z-ai/glm-5.3']);
    expect(view.policy.roles.review?.prefer).toEqual(['codex-default']);
  });
  test('부분 행도 kind 가 확정돼 적힌다(왕복) · last-good 도 최신 병합본이다', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } } } }); // 출처: #39171 정책 표 시험 픽스처
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { openrouter: { spendCap: { dailyUsd: 50 } } } } }); // 출처: #39171 정책 표 시험 픽스처
    const paths = await spendPolicyFiles(dir);
    const policyText = readFileSync(paths.policy, 'utf8');
    expect(policyText).toContain('dailyUsd: 50'); // 출처: #39171 정책 표 시험 픽스처
    expect(policyText).toContain('capPct: 90'); // 출처: #39171 정책 표 시험 픽스처
    expect(readFileSync(paths.lastGood, 'utf8')).toBe(policyText);
    const read = await readStoredSpendPolicy(dir);
    expect(read.valid).toBe(true);
  });
  test('정본 쓰기가 실패하면 last-good 은 이전 커밋본 그대로다(정본 먼저 · last-good 나중 — Terra must)', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } } } }); // 출처: #39171 정책 표 시험 픽스처
    const paths = await spendPolicyFiles(dir);
    const committed = readFileSync(paths.lastGood, 'utf8');
    rmSync(paths.policy);
    mkdirSync(paths.policy); // 정본 자리를 디렉터리로 막아 rename 을 실패시킨다
    let threw = false;
    try { await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 80 } } } }); } catch { threw = true; } // 출처: #39171 정책 표 시험 픽스처
    expect(threw).toBe(true);
    expect(readFileSync(paths.lastGood, 'utf8')).toBe(committed); // 미커밋 정책이 복구본으로 새지 않는다
    expect(readFileSync(paths.lastGood, 'utf8')).not.toContain('capPct: 80'); // 출처: #39171 정책 표 시험 픽스처
  });
  test('원장 changedKeys 는 바뀐 잎만 남기고 명시 삭제(null)만 저장 행을 지운다', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } }, roles: { review: { creditOk: false } } } }); // 출처: #39171 정책 표 시험 픽스처
    const second = await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-team': { capPct: 55 } } } }); // 출처: #39171 정책 표 시험 픽스처
    expect(second.ok && second.changedKeys).toEqual(['providers.codex-team.capPct']);
    const del = await writeStoredSpendPolicy({ actor: 'test', dir, document: { roles: { review: null } } });
    expect(del.ok).toBe(true);
    const view = await readAppliedSpendPolicy({ dir });
    expect(view.policy.roles.review?.creditOk).toBe(true); // 저장 역할 삭제 → 코드 기본으로 복귀
    expect((view.policy.providers['codex-default'] as SubscriptionRowPolicy).capPct).toBe(90); // 출처: #39171 정책 표 시험 픽스처
  });
  test('병합본이 무효가 되는 입력은 거부되고 디스크는 그대로다', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } } } }); // 출처: #39171 정책 표 시험 픽스처
    const paths = await spendPolicyFiles(dir);
    const before = readFileSync(paths.policy, 'utf8');
    const bad = await writeStoredSpendPolicy({ actor: 'test', dir, document: { fallbackOrder: ['nope'] } });
    expect(bad.ok).toBe(false);
    expect(readFileSync(paths.policy, 'utf8')).toBe(before);
  });
  test('깨진 YAML 읽기 오류·쓰기 응답에 비밀 원문이 안 나온다', async () => {
    const secret = 'sk-ant-api03-abcdefghijklmnop';
    const paths = await spendPolicyFiles(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(paths.policy, `providers:\n  ${secret}: [unclosed\n`);
    const read = await readStoredSpendPolicy(dir);
    expect(JSON.stringify(read)).not.toContain(secret);
    const written = await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { [secret]: { capPct: 5 } } } }); // 출처: #39171 정책 표 시험 픽스처
    expect(written.ok).toBe(false);
    expect(JSON.stringify(written)).not.toContain(secret);
  });
});
