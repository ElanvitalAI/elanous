// 교차 프로세스 동시 폴백 시험 픽스처 — llm-low-balance-alert.test.ts 가 Bun.spawn 으로 2개 띄운다(같은 dir 공유).
// 우편은 shared dir/mails.log 에 한 줄씩. 이 파일은 시험 파일이 아니므로 bun test 가 스캔하지 않는다.
// ⛔ 비밀 0 — 행 이름·레벨만 기록한다.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { gateLlmCall, type LlmCallGateDeps } from '../oauth/llm-call-gate.js';
import { createFileGuardStore } from '../oauth/llm-spend-guard.js';
import { createFileReservationLedger } from '../oauth/llm-spend-reservation.js';
import { defaultSpendPolicyDoc } from '../nexus/llm-spend-policy/schema.js';
import type { LlmSpendRowState } from '../nexus/llm-spend-policy/types.js';

const dir = process.argv[2];
if (typeof dir !== 'string' || dir.length === 0) process.exit(2);
const T0 = new Date('2026-11-20T03:00:00.000Z');
const LEASE = '2026-11-20T23:00:00.000Z';
const GLM = 'openrouter/z-ai/glm-5.3';

const states = (): LlmSpendRowState[] => [
  { row: 'codex-default', provider: 'x', window: { status: 'measured', usedPct: 100, observedAt: T0.toISOString() }, lease: { leaseId: 'l-cd', expiresAt: LEASE } },
  {
    row: 'openrouter', provider: 'openrouter', lease: { leaseId: 'l-or', expiresAt: LEASE },
    balance: { status: 'measured', usd: 2, totalCreditsUsd: 100, totalUsageUsd: 50, source: 't', observedAt: T0.toISOString() }, // low: 잔액 2 < 추정 5
    spend: { todayUsd: 1, monthUsd: 1, source: 't', observedAt: T0.toISOString() },
  },
];

const deps: { -readonly [K in keyof LlmCallGateDeps]: LlmCallGateDeps[K] } = {
  readPolicy: async () => defaultSpendPolicyDoc(),
  observers: [states],
  memory: createFileGuardStore(join(dir, 'guard-memory.json')),
  reservations: createFileReservationLedger(join(dir, 'reservations.json')),
  appendLedger: () => {},
  now: () => T0,
  lowBalanceMailer: async (mail) => {
    await new Promise((r) => setTimeout(r, 40)); // 실배선 mailer 도 await 가 낀다 — 경쟁 창을 넓힌다
    appendFileSync(join(dir, 'mails.log'), `${mail.row} ${mail.level}\n`);
  },
};

await gateLlmCall({ role: 'judgement', location: 'host', models: [GLM], estimateUsd: 5 }, deps);