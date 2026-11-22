// POST-TURN-LESSON-REVIEW r9 — Terra mustFix ①: 브리지 실배선(도구 결과 → 관측 → scanTurnSignals → friction 원장).
// 헬퍼(collectTurnObservations) 단위 + 브리지 수준 통합(runTurn 종료 시 원장 fired 행) 을 증명한다.
// 오류 꼴은 제품 원문 실측: code-edit/tools.ts:173 `{ output: 'Edit failed: …' }` ·
// run-core-turn.ts 연구 정책 `{ error: '…allowlist…' }` · 그 외 `{ error: string }`.
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '../core-turn/run-core-turn.js';
import * as config from '../user-config.js';
import type { CoreTurnContext } from '../core-turn/types.js';
import type { AcpTurnContext } from './server.js';
import { bridgeCoreTurnToAcp, collectTurnObservations } from './core-turn-bridge.js';
import { FrictionLedger } from '../lessons/friction-ledger.js';

afterEach(() => mock.restore());

test('Edit 실패 결과(`{ output: "Edit failed: …" }`) → land-rejected 관측 1건', () => {
  const obs = collectTurnObservations([
    { id: 't1', name: 'Edit', result: { output: 'Edit failed: policy rejected (EditErrorCode.PolicyRejected)' } },
  ]);
  expect(obs.length).toBe(1);
  expect(obs[0]!.kind).toBe('land-rejected');
  expect(obs[0]!.signature).toBe('write-gate:Edit');
});

test('연구 정책 거부 `{ error: … allowlist … }` 도 land-rejected · 일반 `{ error }` 는 tool-error', () => {
  const obs = collectTurnObservations([
    { id: 'r1', name: 'Bash', result: { error: 'This research turn may only use the research tool allowlist.' } },
    { id: 'e1', name: 'Bash', result: { error: 'command not found: foo' } },
  ]);
  expect(obs.length).toBe(2);
  expect(obs[0]!.kind).toBe('land-rejected');
  expect(obs[1]!.kind).toBe('tool-error');
  expect(obs[1]!.signature).toMatch(/^tool:Bash:enoent-[0-9a-f]+$/); // r16 — Terra r15b ③: 종류명 뒤 결정적 지문까지(같은 종류의 서로 다른 오류도 합쳐지지 않는다 · 원문·비밀·경로 노출 0)
});

test('성공 결과(`{ output: "PASS …" }`·exitCode 0)는 관측하지 않는다 — 오탐 0', () => {
  const obs = collectTurnObservations([
    { id: 'ok1', name: 'RunShell', result: { output: 'PASS test/a.test.ts', stdout: 'PASS', exitCode: 0 } },
    { id: 'ok2', name: 'Edit', result: { output: 'edited /tmp/a.ts' } },
    { id: 'ok3', name: 'Read', result: undefined },
  ]);
  expect(obs.length).toBe(0);
});

test('브리지 수준: runTurn 종료 시 관측이 scanTurnSignals 를 거쳐 원장 fired 표에 남는다', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'bridge-lesson-'));
  const base = config.getUserConfig();
  spyOn(config, 'getUserConfig').mockReturnValue({
    ...base,
    llm: { ...base.llm, provider: 'openai', model: 'gpt-5.6', fallbackChain: [] },
    chat: { ...base.chat, autoCompact: { ...base.chat.autoCompact, enabled: false } },
    tools: { ...base.tools, deferred: { ...base.tools.deferred, mode: 'off' } },
  });
  const runTurn = bridgeCoreTurnToAcp({
    getMessages: () => [{ role: 'user', content: 'fix it' }],
    getTools: () => [{ name: 'Edit', description: 'd', parameters: { type: 'object' } }],
    dispatchTool: async () => ({ output: 'edited' }),
    lessonStateDir: stateDir,
  });
  const turn = {
    sessionId: 'lesson-scan', cwd: '/tmp', userText: 'fix it',
    isAborted: () => false,
    push: async () => {}, pushWithMeta: async () => {}, pushSessionUpdate: async () => {},
    pushToolCall: async () => {}, pushToolResult: async () => {}, pushUsage: async () => {},
    requestApproval: async () => 'allow-once' as const,
  } as unknown as AcpTurnContext;
  spyOn(core, 'runCoreTurn').mockImplementation(async (ctx: CoreTurnContext) => {
    ctx.callbacks?.onToolResult?.({ id: 'e1', name: 'Edit', result: { output: 'Edit failed: policy rejected (EditErrorCode.PolicyRejected)' } });
    return { stopReason: 'end_turn', finalText: 'done' };
  });
  await runTurn(turn);
  const ledger = new FrictionLedger({ stateDir });
  const today = new Date().toISOString().slice(0, 10);
  // 출처: #125563(완료선 — 원장 신호 때 발화 흔적이 friction 원장 fired 표에 남는다)
  expect(ledger.countFiredOn(today, 'person')).toBeGreaterThanOrEqual(1);
  // r12 — Terra r11 [0]: 실제 진입점(브리지 runTurn)에서 신호가 원장 행까지 간다 — 시험은 BUN_TEST 로 결정적 요약.
  const promoted = ledger.candidates(1).find(r => r.signature === 'write-gate:edit'); // 원장은 normalizeSignature 가 소문자로 접는다
  expect(promoted).toBeDefined(); // land-rejected 승격 행 — write-gate 거부 관측이 friction 원장에 행으로 남는다
});

test('r12 — 사람 입력 원문이 관측에 실리면 정정 문구는 원장 행이 되고 원문은 note 에 남지 않는다', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'bridge-lesson-'));
  const base = config.getUserConfig();
  spyOn(config, 'getUserConfig').mockReturnValue({
    ...base,
    llm: { ...base.llm, provider: 'openai', model: 'gpt-5.6', fallbackChain: [] },
    chat: { ...base.chat, autoCompact: { ...base.chat.autoCompact, enabled: false } },
    tools: { ...base.tools, deferred: { ...base.tools.deferred, mode: 'off' } },
  });
  const runTurn = bridgeCoreTurnToAcp({
    getMessages: () => [{ role: 'user', content: '아니 그게 아니라 다시 해' }],
    getTools: () => [],
    dispatchTool: async () => ({ output: '' }),
    lessonStateDir: stateDir,
  });
  const turn = {
    sessionId: 'lesson-human', cwd: '/tmp', userText: '아니 그게 아니라 다시 해',
    isAborted: () => false,
    push: async () => {}, pushWithMeta: async () => {}, pushSessionUpdate: async () => {},
    pushToolCall: async () => {}, pushToolResult: async () => {}, pushUsage: async () => {},
    requestApproval: async () => 'allow-once' as const,
  } as unknown as AcpTurnContext;
  spyOn(core, 'runCoreTurn').mockImplementation(async () => ({ stopReason: 'end_turn', finalText: 'done' }));
  await runTurn(turn);
  const ledger = new FrictionLedger({ stateDir });
  const row = ledger.candidates(1).find(r => r.signature.startsWith('human:correction:'));
  expect(row).toBeDefined(); // 사람 정정 문구 → human-correction 신호 → 원장 행(r12 실제 진입점 배선)
  const { Database } = require('bun:sqlite');
  const db = new Database(`${stateDir}/lessons/friction.sqlite`, { readonly: true });
  const noted = db.query("SELECT note FROM friction WHERE signature LIKE 'human:correction:%'").get() as { note: string };
  db.close();
  expect(noted.note).not.toContain('다시 해'); // 사람 원문 전문 미노출 — 요약 줄이 note 를 대체(Terra r11 [1] 비밀·원문 노출 0)
});

test('r10 — 오류 원문에 토큰이 있어도 서명에 비밀이 남지 않는다', () => {
  const obs = collectTurnObservations([
    { id: 's1', name: 'Bash', result: { error: 'auth failed: token sk-abcdefgh12345678 rejected' } },
  ]);
  expect(obs.length).toBe(1);
  expect(obs[0]!.signature).not.toContain('sk-'); // 원문 40자 노출 금지(Terra mustFix ⑨)
  expect(obs[0]!.signature).toMatch(/^tool:Bash:unclassified-[0-9a-f]+$/); // r12 — 결정적 지문(원문 노출 0 · 미분류끼리 분리 · Terra r11 [4])
});

test('r12 — 서로 다른 미분류 오류는 다른 지문을 받는다(1회 발생 오류의 반복 후보 합산 방지 · Terra r11 [4])', () => {
  const obs = collectTurnObservations([
    { id: 'u1', name: 'Bash', result: { error: 'weird failure alpha-block-9931 happened' } },
    { id: 'u2', name: 'Bash', result: { error: 'different failure beta-signal-4417 occurred' } },
  ]);
  expect(obs.length).toBe(2);
  expect(obs[0]!.kind).toBe('tool-error');
  expect(obs[1]!.kind).toBe('tool-error');
  expect(obs[0]!.signature).not.toBe(obs[1]!.signature); // 서로 다른 오류 → 서로 다른 지문 — 1회씩만 발생한 오류가 '같은 오류 2회'로 합쳐지지 않는다
  expect(obs[0]!.signature).toMatch(/^tool:Bash:unclassified-[0-9a-f]+$/);
  expect(obs[1]!.signature).toMatch(/^tool:Bash:unclassified-[0-9a-f]+$/);
  // 같은 원문은 같은 지문(결정적 — 관측 이력·서명 안정)
  const same = collectTurnObservations([
    { id: 'u3', name: 'Bash', result: { error: 'weird failure alpha-block-9931 happened' } },
  ]);
  expect(same[0]!.signature).toBe(obs[0]!.signature);
});
