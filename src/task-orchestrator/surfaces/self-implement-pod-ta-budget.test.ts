import { expect, test } from 'bun:test';
import type { UserConfig } from '../../user-config.js';
import { podSelfImplementSpawn as realPodSelfImplementSpawn, type Kubectl } from './self-implement-pod.js';

// TA-BUDGET — hand 가 싣는 ELANOUS_TA_WALL_SEC 가 Pod Job 수명(activeDeadlineSeconds)을 조이는 운영 소비자(self-implement-pod.ts) 시험.
// 큰 시험 파일과 같은 어댑터 — 가짜 kubectl 이면 폴링 sleep 0 · 예산/폴백/게이트웨이/PR 조회는 고정.
const podSelfImplementSpawn: typeof realPodSelfImplementSpawn = (options = {}) =>
  realPodSelfImplementSpawn(options.kubectl ? { sleep: async () => {}, budgetSnapshot: () => undefined, fallbackConfig: () => ({ llm: {} }) as UserConfig,
    openGatewayConfig: () => ({ llm: {} }) as UserConfig,
    lookupOpenPrByBranch: () => ({ status: 'not-found', reason: 'test-fixture' }), ...options } : options);

function fakeKubectl() {
  const calls: Array<{ args: string; input?: string }> = [];
  const k: Kubectl = (args, input) => {
    calls.push({ args: args.join(' '), ...(input ? { input } : {}) });
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
    if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
    if (args.some((a) => a.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: '', stderr: '' };
    if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { k, calls };
}

const NOW = Date.parse('2030-01-01T00:00:00Z');
const GROK_AUTH = JSON.stringify({ 'https://auth.x.ai::client': { key: 'access-ta', expires_at: new Date(NOW + 10 * 3600_000).toISOString() } });

async function deadlineFor(env: Record<string, string>, spaceId: string): Promise<number> {
  const { k, calls } = fakeKubectl();
  await podSelfImplementSpawn({ provider: 'grok', kubectl: k, now: () => NOW, grokCredentials: () => ({ grokAuth: GROK_AUTH, ghToken: 'gh' }), env })({ feature: 'x', spaceId }).done;
  return calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!))[1].spec.activeDeadlineSeconds;
}

test('a declared wall-clock narrows the Job deadline to wall + 300s grace', async () => {
  expect(await deadlineFor({ ELANOUS_TA_WALL_SEC: '1800' }, 'ta-budget-1')).toBe(2100);
  expect(await deadlineFor({ ELANOUS_TA_WALL_SEC: '6900' }, 'ta-budget-2')).toBe(7200);
});

test('invalid or absent declaration keeps the default 10800s Job deadline', async () => {
  for (const bad of ['6901', '0', '-5', '1.5', 'abc', '']) expect(await deadlineFor({ ELANOUS_TA_WALL_SEC: bad }, `ta-budget-bad-${bad || 'empty'}`)).toBe(10_800);
  expect(await deadlineFor({}, 'ta-budget-none')).toBe(10_800);
});
