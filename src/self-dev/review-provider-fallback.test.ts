import { resolveModelAlias } from '../intelligence-map/model-alias.js';
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProvider, streamLLM } from '../llm.js';
import { buildDefaultSelfImplementSeams, planDevPipeline } from './dev-pipeline.js';
import { clearLaunchRoleLlmOverrides, parseSubscriptionReviewerSpec, setUserConfigOverlay } from '../user-config.js';
import { parseReviewResult, renderReview } from '../agent-substrate/pr-reviewer.js';
import { defaultLlmPolicy, validateLlmPolicy } from '../policy/llm-policy.js';
import {
  classifyReviewProviderFailure, buildReviewProviderAttempts, defaultReviewFallbackModel, runReviewWithFallback,
  type ReviewFallbackObservation, subscriptionReviewerSpawn, runSubscriptionReviewer,
  subscriptionReviewerAvailability, parseTeamclaudeStatusJson, parseTeamclaudeBaseUrl,
} from './review-provider-fallback.js';

const A = { model: 'gpt-5.6-sol', provider: getProvider('gpt-5.6-sol')!, label: 'codex' };
const B = { model: 'grok-4', provider: getProvider('grok-4')!, label: 'grok' };
const C = { model: 'claude-opus', provider: getProvider('claude-opus')!, label: 'claude' };

describe('Claude ACP subscription review', () => {
  const cct = { provider: 'claude-acp' as const };
  const cc = { provider: 'claude-acp' as const, executor: 'cc' as const };
  const env = { PATH: '/bin', ANTHROPIC_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'token',
    CLAUDE_CODE_OAUTH_TOKEN: 'other', CLAUDE_CODE_USE_VERTEX: '1' };

  test('roleLlm.reviewer is opt-in and policy cap defaults to 60%', () => {
    expect(parseSubscriptionReviewerSpec({ provider: 'claude-acp' })).toEqual(cct);
    expect(parseSubscriptionReviewerSpec({ provider: 'claude-acp', executor: 'cc' })).toEqual(cc);
    expect(parseSubscriptionReviewerSpec({ provider: 'claude-acp', executor: 'unknown' })).toBeUndefined();
    const policy = defaultLlmPolicy();
    expect(policy.roles.reviewer).toBeUndefined();
    expect(policy.caps.claude.harness).toBe(60);
    expect(validateLlmPolicy({ roles: { reviewer: cc }, caps: { claude: { harness: 60 } } }).valid).toBe(true);
    expect(validateLlmPolicy({ roles: { reviewer: { provider: 'claude-acp', executor: 'unknown' } } }).valid).toBe(false);
  });

  test('cct status confirms subscription and measures usage; an unmeasured quota falls back', async () => {
    const calls: string[] = [];
    const runStatus = (command: string, args: string[], cleanEnv: Record<string, string>) => {
      calls.push(`${command} ${args.join(' ')}`);
      expect(cleanEnv.ANTHROPIC_API_KEY).toBeUndefined();
      if (args[0] === 'env') return { status: 0, stdout: proxyEnv };
      return { status: 0, stdout: 'Claude subscription active; usage: 42%' };
    };
    const api = async () => 'VERDICT: PASS';
    const acp = async () => 'VERDICT: WARN';
    expect(await runSubscriptionReviewer(cct, 60, 'review', api, acp, env, { runStatus })).toBe('VERDICT: WARN');
    // Old teamclaude: `--json` is not JSON, so both questions fall back to the text probe.
    expect(calls).toEqual(['teamclaude status --json', 'teamclaude status', 'teamclaude env --no-mitm']);
    expect(await runSubscriptionReviewer(cct, 60, 'review', api, acp, env,
      { runStatus: () => ({ status: 0, stdout: 'Claude subscription active' }) })).toContain('usage unavailable');
  });

  // Key structure of a real `teamclaude status --json` (mbp 10-10); names are fake, quota ratios are 0-1.
  const proxyEnv = 'export ANTHROPIC_BASE_URL=http://localhost:3456\n# TeamClaude env: base-URL mode, localhost:3456\n';
  const tcJson = (accounts: unknown[], currentAccount = 'acct-b') => JSON.stringify({
    accounts, currentAccount, currentAccounts: { anthropic: currentAccount }, switchThreshold: 0.95,
    server: {}, sessions: [], usageDimensions: {},
  });
  const acct = (name: string, quota: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    name, type: 'oauth', provider: 'anthropic', status: 'active', disabled: false, unavailable: null,
    quota: { unified5h: null, unified7d: null, unifiedStatus: null, ...quota }, ...extra,
  });
  const realShape = tcJson([acct('acct-a', {}), acct('acct-b', { unified5h: 0.09, unified7d: 0.5, unifiedStatus: 'allowed' })]);

  test('teamclaude status --json: an active oauth account is a subscription and its quota ratio is a percent', () => {
    expect(parseTeamclaudeStatusJson(realShape)).toEqual({ subscribed: true, usedPercent: 50, reason: 'current-account' });
    const calls: string[] = [];
    const runStatus = (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (args[0] === 'env') return { status: 0, stdout: proxyEnv };
      return { status: 0, stdout: args.includes('--json') ? realShape : 'Accounts\n  acct-b  active  5h 9%  7d 50%' };
    };
    const ok = subscriptionReviewerAvailability(cct, 60, env, { runStatus }).spawn;
    expect(ok?.command).toBe('claude-agent-acp');
    expect(ok?.env.ANTHROPIC_BASE_URL).toBe('http://localhost:3456');
    expect(calls).toEqual(['teamclaude status --json', 'teamclaude env --no-mitm']);
    // A proxy without a base URL is not a route: fail closed to the default reviewer.
    expect(subscriptionReviewerAvailability(cct, 60, env, { runStatus: (_c: string, args: string[]) =>
      ({ status: 0, stdout: args[0] === 'env' ? '' : realShape }) }).reason).toBe('cct proxy base URL unavailable');
    expect(subscriptionReviewerAvailability(cct, 40, env, { runStatus }).reason).toContain('at harness cap (40%)');
  });

  test('teamclaude status --json: logged-out or api-key-only accounts are not a subscription; unmeasured quota fails closed', () => {
    const apiKeyOnly = tcJson([{ name: 'k', type: 'api-key', status: 'active', disabled: false, quota: { unified5h: 0.1 } }], 'k');
    const loggedOut = tcJson([acct('acct-b', { unified5h: 0.1 }, { status: 'error' }), acct('acct-c', { unified5h: 0.1 }, { disabled: true })]);
    for (const stdout of [apiKeyOnly, loggedOut, tcJson([])]) {
      expect(parseTeamclaudeStatusJson(stdout)?.subscribed).toBe(false);
      expect(subscriptionReviewerAvailability(cct, 60, env, { runStatus: () => ({ status: 0, stdout }) }).reason)
        .toBe('cct subscription check failed');
    }
    const unmeasured = tcJson([acct('acct-b', {})]);
    expect(parseTeamclaudeStatusJson(unmeasured)).toEqual({ subscribed: true, reason: 'quota-unmeasured' });
    expect(subscriptionReviewerAvailability(cct, 60, env, { runStatus: () => ({ status: 0, stdout: unmeasured }) }).reason)
      .toContain('usage unavailable');
    // The routed (current) account's quota gates: another account's low usage does not stand in for it.
    expect(parseTeamclaudeStatusJson(tcJson([acct('acct-a', { unified5h: 0.2 }), acct('acct-b', {})])))
      .toEqual({ subscribed: true, reason: 'quota-unmeasured' });
    // No usable current account: every usable account must be measured, and the highest counts.
    expect(parseTeamclaudeStatusJson(tcJson([acct('acct-a', { unified5h: 0.2 }), acct('acct-c', { unified7d: 0.7 })], 'gone')))
      .toEqual({ subscribed: true, usedPercent: 70, reason: 'max-active-account' });
    expect(parseTeamclaudeStatusJson(tcJson([acct('acct-a', { unified5h: 0.2 }), acct('acct-c', {})], 'gone')))
      .toEqual({ subscribed: true, reason: 'quota-unmeasured' });
    // A bucket nulled by its window reset leaves the other bucket gating; an invalid present value fails closed.
    expect(parseTeamclaudeStatusJson(tcJson([acct('acct-b', { unified5h: null, unified7d: 0.4 })])))
      .toEqual({ subscribed: true, usedPercent: 40, reason: 'current-account' });
    for (const bad of [1.5, -0.1, '0.2', {}]) {
      const stdout = tcJson([acct('acct-b', { unified5h: bad, unified7d: 0.1 })]);
      expect(parseTeamclaudeStatusJson(stdout)).toEqual({ subscribed: true, reason: 'quota-unmeasured' });
      expect(subscriptionReviewerAvailability(cct, 60, env, { runStatus: (_c: string, args: string[]) =>
        ({ status: 0, stdout: args[0] === 'env' ? proxyEnv : stdout }) }).reason).toContain('usage unavailable');
    }
    // A missing bucket key is not a reset: unmeasured, fail closed.
    expect(parseTeamclaudeStatusJson(JSON.stringify({ currentAccount: 'acct-b', accounts: [
      { name: 'acct-b', type: 'oauth', status: 'active', disabled: false, quota: { unified7d: 0.1 } }] })))
      .toEqual({ subscribed: true, reason: 'quota-unmeasured' });
    // A non-boolean `disabled` is another schema, not an enabled account.
    for (const disabled of ['true', null, undefined])
      expect(parseTeamclaudeStatusJson(tcJson([acct('acct-b', { unified5h: 0.1 }, { disabled })]))).toBeUndefined();
  });

  test('teamclaude without --json (non-zero exit or non-JSON) falls back to the text probe', () => {
    const runStatus = (_command: string, args: string[]) => args[0] === 'env' ? { status: 0, stdout: proxyEnv }
      : args.includes('--json') ? { status: 1, stdout: 'unknown option --json' }
      : { status: 0, stdout: 'Claude subscription active; usage: 30%' };
    expect(subscriptionReviewerAvailability(cct, 60, env, { runStatus }).spawn?.command).toBe('claude-agent-acp');
    expect(parseTeamclaudeStatusJson('Claude subscription active')).toBeUndefined();
    expect(parseTeamclaudeStatusJson('{"server":{}}')).toBeUndefined();
    // Another account schema is not this JSON: it must reach the text probe, not read as "no subscription".
    const otherSchema = JSON.stringify({ accounts: [{ kind: 'oauth', state: 'active' }] });
    expect(parseTeamclaudeStatusJson(otherSchema)).toBeUndefined();
    expect(subscriptionReviewerAvailability(cct, 60, env, { runStatus: (_c: string, args: string[]) => args[0] === 'env'
      ? { status: 0, stdout: proxyEnv } : args.includes('--json') ? { status: 0, stdout: otherSchema }
      : { status: 0, stdout: 'Claude subscription active; usage: 30%' } }).spawn?.command).toBe('claude-agent-acp');
  });

  test('a child that never answers the ACP handshake falls back to the default reviewer in bounded time', async () => {
    const { makeAcpReviewLLM } = await import('../agent-substrate/acp-reviewer.js');
    const { getAcpBackend } = await import('../acp/backend-registry.js');
    const t0 = Date.now();
    const text = await runSubscriptionReviewer(cct, 60, 'review', async () => 'VERDICT: PASS',
      (prompt, spawn) => makeAcpReviewLLM({ cwd: process.cwd(), backend: 'claude', env: spawn.env, handshakeTimeoutMs: 300,
        // The pre-fix child: an interactive CLI that never speaks ACP.
        backendSpec: { ...getAcpBackend('claude'), command: '/bin/sleep', args: ['30'] } })(prompt),
      env, { checkSubscription: () => true, usedPercent: () => 10,
        runStatus: () => ({ status: 0, stdout: proxyEnv }) });
    expect(text).toBe('VERDICT: PASS\n[reviewer fallback: ACP review failed; default reviewer used]');
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 20_000);

  test('fallback notice survives review parsing and appears in rendered review result', async () => {
    const raw = await runSubscriptionReviewer(cct, 60, 'review', async () => 'VERDICT: PASS\nMUST-FIX:\n',
      async () => { throw new Error('ACP must not launch'); }, env,
      { checkSubscription: () => false, usedPercent: () => 10 });
    const result = parseReviewResult(raw);
    expect(result).toMatchObject({ verdict: 'pass', reviewerFallback: 'cct subscription check failed; default reviewer used' });
    expect(renderReview(result)).toContain('[reviewer fallback: cct subscription check failed; default reviewer used]');
  });

  test('both executors run the ACP adapter (not the interactive CLI) without billing credentials; cct routes via the proxy base URL', () => {
    for (const spec of [cct, cc]) {
      expect(subscriptionReviewerSpawn(spec, env)).toMatchObject({ command: 'claude-agent-acp', args: [],
        backendSpec: { id: 'claude', command: 'claude-agent-acp', args: [] } });
    }
    expect(subscriptionReviewerSpawn(cct, env, 'http://localhost:3456').env.ANTHROPIC_BASE_URL).toBe('http://localhost:3456');
    expect(subscriptionReviewerSpawn(cc, env, 'http://localhost:3456').env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(parseTeamclaudeBaseUrl(proxyEnv + '# remote clients must also present the proxy key: ANTHROPIC_API_KEY=x\n'))
      .toBe('http://localhost:3456');
    expect(parseTeamclaudeBaseUrl('export ANTHROPIC_API_KEY=x\n')).toBeUndefined();
    for (const spec of [cct, cc]) {
      const child = subscriptionReviewerSpawn(spec, env).env;
      expect(child.PATH).toBe('/bin');
      for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_VERTEX'])
        expect(child[key]).toBeUndefined();
    }
  });

  test('no setting uses the unchanged default path; subscription failure and cap failure report the fallback', async () => {
    const calls: string[] = [];
    const api = async (_prompt: string) => { calls.push('api'); return 'PASS'; };
    const acp = async (_prompt: string, spawn: ReturnType<typeof subscriptionReviewerSpawn>) => {
      calls.push(spawn.command); return 'ACP PASS';
    };
    expect(await runSubscriptionReviewer(undefined, 60, 'review', api, acp, env)).toBe('PASS');
    expect(calls).toEqual(['api']);
    expect(await runSubscriptionReviewer(cct, 60, 'review', api, acp, env,
      { checkSubscription: () => false, usedPercent: () => 10 })).toBe('PASS\n[reviewer fallback: cct subscription check failed; default reviewer used]');
    expect(await runSubscriptionReviewer(cc, 60, 'review', api, acp, env,
      { checkSubscription: () => true, usedPercent: () => 60 })).toContain('at harness cap (60%)');
    expect(calls).toEqual(['api', 'api', 'api']);
    expect(await runSubscriptionReviewer(cct, 60, 'review', api, acp, env,
      { checkSubscription: () => true, usedPercent: () => 59, runStatus: () => ({ status: 0, stdout: proxyEnv }) })).toBe('ACP PASS');
    expect(calls.at(-1)).toBe('claude-agent-acp');
    expect(await runSubscriptionReviewer(cc, 60, 'review', api, async () => '', env,
      { checkSubscription: () => true, usedPercent: () => 10 })).toContain('ACP review failed; default reviewer used');
  });
});

describe('classifyReviewProviderFailure — 「제공자가 아픈가」만 문다', () => {
  test('⭐ 실물 문면(#10069)을 문다', () => {
    expect(classifyReviewProviderFailure('Codex API error: Our servers are currently overloaded. Please try again later.')).toBe('overloaded');
  });
  test('rate limit · 5xx · timeout 을 각각 가른다', () => {
    expect(classifyReviewProviderFailure('429 rate limit exceeded')).toBe('rate-limited');
    expect(classifyReviewProviderFailure('HTTP 503 Service Unavailable')).toBe('server-error');
    expect(classifyReviewProviderFailure('request timed out')).toBe('timeout');
  });
  test('모델-프로바이더 불일치·기타 오류를 유한 사유로 가른다', () => {
    expect(classifyReviewProviderFailure("Codex API 400: The 'grok-4.6' model is not supported when using Codex")).toBe('model-provider-mismatch');
    expect(classifyReviewProviderFailure('prompt too long: 200000 tokens')).toBe('other');
    expect(classifyReviewProviderFailure('invalid api key')).toBe('other');
  });
  test('OpenRouter 자격 미설정은 다른 프로바이더로 넘길 수 있는 가용성 실패다', () => {
    expect(classifyReviewProviderFailure('openrouter unavailable: configure apiKey via `elanous setup`')).toBe('credentials-unavailable');
  });
});

describe('self review isolated CLI model routing', () => {
  test('--model glm sends the OpenRouter model and does not call Codex OAuth', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-review-glm-'));
    const configDir = join(root, '.elanous-test');
    const binDir = join(root, 'bin');
    const capture = join(root, 'request.json');
    try {
      mkdirSync(configDir);
      mkdirSync(binDir);
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ llm: { provider: 'openai-codex', model: 'gpt-6-sol', apiKey: 'test-openrouter-key' } }));
      writeFileSync(join(binDir, 'gh'), `#!/bin/sh\nif [ "$1" = "api" ]; then printf 'diff --git a/x b/x\\n@@\\n+ok\\n'; exit 0; fi\necho '{"title":"review","body":"","headRefOid":"0123456789abcdef0123456789abcdef01234567","baseRefOid":"aaaabbbbccccddddeeeeffff0000111122223333"}'\n`, { mode: 0o755 });
      const preload = join(root, 'capture.ts');
      writeFileSync(preload, `const requests = []; globalThis.fetch = async (input, init) => { requests.push({ url: String(input), body: JSON.parse(String(init?.body)) }); await Bun.write(${JSON.stringify(capture)}, JSON.stringify(requests)); if (!String(input).startsWith('https://openrouter.ai/')) throw new Error('Codex OAuth misroute: ' + input); return new Response('data: {"choices":[{"delta":{"content":"VERDICT: PASS"}}]}\\n\\ndata: [DONE]\\n\\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }); };`);
      const childEnv: Record<string, string | undefined> = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, OPENROUTER_API_KEY: 'test-openrouter-key', OPENAI_API_KEY: 'test-codex-key', CODEX_AUTH_TOKEN: 'test-oauth-token' };
      delete childEnv.ELANOUS_TEST_FAKE_LLM;
      const run = spawnSync(process.execPath, ['--preload', preload, join(import.meta.dir, '..', '..', 'bin/elanous.mjs'), `--test=${configDir}`, '--config-dir', configDir, 'self', 'review', '1', '--json', '--model', 'glm'],
        { cwd: root, env: childEnv, encoding: 'utf8', timeout: 90_000 });
      expect(run.status, `stdout=${run.stdout}\nstderr=${run.stderr}`).toBe(0);
      const requests = JSON.parse(readFileSync(capture, 'utf8')) as Array<{ url: string; body: { model: string } }>;
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toContain('openrouter.ai');
      expect(requests[0]!.body.model).toBe('z-ai/glm-5.3');
      const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
      expect(result).toMatchObject({ requestedModel: 'glm', model: 'openrouter/z-ai/glm-5.3', respondedProvider: 'openrouter' });
      const rejected = spawnSync(process.execPath, [join(import.meta.dir, '..', '..', 'bin/elanous.mjs'), `--test=${configDir}`, '--config-dir', configDir, 'self', 'review', '1', '--json', '--model', 'glm-5.3'],
        { cwd: root, env: childEnv, encoding: 'utf8', timeout: 90_000 });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stdout).toContain('openrouter/z-ai/glm-5.3');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120_000);
});

describe('self implement reviewDiff fallback route', () => {
  test('primary overload reaches OpenRouter glm request with the canonical model', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'elanous-review-fallback-seam-'));
    const originalFetch = globalThis.fetch;
    const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
    const originalOpenAIKey = process.env.OPENAI_API_KEY;
    const requests: Array<{ url: string; model: string }> = [];
    try {
      clearLaunchRoleLlmOverrides();
      process.env.OPENROUTER_API_KEY = 'test-review-openrouter-key';
      process.env.OPENAI_API_KEY = 'test-review-openai-key';
      writeFileSync(join(repo, 'changed.ts'), 'export const changed = true;\n');
      setUserConfigOverlay((config) => ({ ...config,
        roleLlm: {}, roleModelTiers: {}, roleModels: { review: 'gpt-5.6-sol' },
        llm: { ...config.llm, provider: 'openai-codex', reviewFallbackModels: ['glm'] },
      }));
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body)) as { model: string };
        requests.push({ url, model: body.model });
        if (!url.startsWith('https://openrouter.ai/')) throw new Error('Our servers are currently overloaded.');
        return new Response('data: {"choices":[{"delta":{"content":"VERDICT: PASS"}}]}\n\ndata: [DONE]\n\n', {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        });
      }) as typeof fetch;
      const seams = await buildDefaultSelfImplementSeams(planDevPipeline({ input: { text: 'review fallback' } }), {
        toolReviewerRate: 0,
        streamLLM,
        reviewScopeDiff: async () => 'diff --git a/changed.ts b/changed.ts\n+export const changed = true;\n',
      });
      const review = await seams.reviewDiff!(repo, { goal: 'review fallback' });
      expect(review.reviewed, JSON.stringify({ review, requests })).toBe(true);
      expect(requests.length).toBeGreaterThan(1);
      expect(requests.slice(0, -1).every(({ url, model }) =>
        !url.startsWith('https://openrouter.ai/') && model === 'gpt-5.6-sol')).toBe(true);
      expect(requests.at(-1)).toEqual({
        url: 'https://openrouter.ai/api/v1/chat/completions', model: 'z-ai/glm-5.3',
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
      if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAIKey;
      setUserConfigOverlay(null);
      clearLaunchRoleLlmOverrides();
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('buildReviewProviderAttempts — 순서와 중복 제거', () => {
  test('기본 provider fallback은 provider inference 가능한 canonical 모델 ID를 쓴다', () => {
    expect(defaultReviewFallbackModel('grok')).toBe('claude-opus-5-5');
    expect(defaultReviewFallbackModel('openrouter')).toBe('grok-4.7');
  });

  test('self review --model glm resolves the OpenRouter model before routing, not Codex OAuth', () => {
    const attempts = buildReviewProviderAttempts({ model: 'glm', label: 'primary' }, [A]);
    expect(attempts[0]).toMatchObject({ model: 'openrouter/z-ai/glm-5.3', provider: { name: 'openrouter' }, label: 'primary' });
    expect(attempts[0]!.provider?.name).not.toBe('openai-codex');
    expect(attempts[1]).toBe(A);
    for (const fallbacks of [[], [B]]) {
      for (const model of ['claude', 'unregistered-review-model']) {
        const attempts = buildReviewProviderAttempts({ model, label: 'primary' }, fallbacks);
        expect(attempts[0]).toMatchObject({ model, label: 'primary' });
        expect(attempts[0]?.provider).toBeUndefined();
        if (fallbacks.length) expect(attempts[1]).toBe(B);
      }
    }
    const mismatched = buildReviewProviderAttempts({ model: 'grok-4', provider: A.provider, label: 'primary' }, [B]);
    expect(mismatched[0]?.provider).toBeUndefined();
    expect(mismatched[1]).toBe(B);
  });

  test('명시한 primary provider 객체의 사용자 설정을 보존한다', () => {
    const custom = { ...getProvider('openrouter/z-ai/glm-5.3'), available: () => true };
    const attempts = buildReviewProviderAttempts({ model: 'glm', provider: custom, label: 'custom' }, [B]);
    expect(attempts[0]?.model).toBe('openrouter/z-ai/glm-5.3');
    expect(attempts[0]?.provider).toBe(custom);
  });

  test('primary 실패 뒤 glm fallback을 OpenRouter의 정식 모델로 실행한다', async () => {
    const attempts = buildReviewProviderAttempts(A, [{ model: 'glm', label: 'glm' }]);
    const calls: Array<{ model: string; provider?: string }> = [];
    const result = await runReviewWithFallback(attempts, async (attempt) => {
      calls.push({ model: attempt.model, provider: attempt.provider?.name });
      if (attempt.label === 'codex') throw new Error('Our servers are currently overloaded.');
      return 'VERDICT: PASS';
    });
    expect(result.used).toMatchObject({ model: 'openrouter/z-ai/glm-5.3', provider: { name: 'openrouter' } });
    expect(calls).toEqual([
      { model: A.model, provider: A.provider.name },
      { model: 'openrouter/z-ai/glm-5.3', provider: 'openrouter' },
    ]);
  });

  test('fallback의 모호한 모델과 잘못 지정된 provider는 명시 거부한다', () => {
    expect(() => buildReviewProviderAttempts(A, [{ model: 'unregistered-review-model', label: 'unknown' }]))
      .toThrow(/ambiguous or unsupported fallback model/);
    expect(() => buildReviewProviderAttempts(A, [{ model: 'glm', provider: A.provider, label: 'wrong' }]))
      .toThrow(/unsupported provider/);
  });

  test('primary glm과 같은 별칭 fallback은 정규화한 모델 기준으로 한 번만 시도한다', () => {
    const attempts = buildReviewProviderAttempts({ model: 'glm', label: 'primary' }, [
      { model: 'glm', label: 'duplicate-alias' },
      { model: 'openrouter/z-ai/glm-5.3', label: 'duplicate-canonical' },
      B,
    ]);
    expect(attempts.map((attempt) => attempt.label)).toEqual(['primary', 'grok']);
  });

  test('기본이 «맨 앞»이고 중복 모델은 빠진다', () => {
    expect(buildReviewProviderAttempts(A, [B, A, C]).map((x) => x.label)).toEqual(['codex', 'grok', 'claude']);
  });
  test('⛔ 빈 모델은 무시한다', () => {
    expect(buildReviewProviderAttempts(A, [{ model: '  ', label: 'x' }]).map((x) => x.label)).toEqual(['codex']);
  });
});

describe('runReviewWithFallback — 계약 넷', () => {
  test('① 첫 시도 성공이면 종전과 «동일»하다', async () => {
    const calls: string[] = [];
    const r = await runReviewWithFallback([A, B], async (a) => { calls.push(a.label); return 'PASS'; });
    expect(r.text).toBe('PASS');
    expect(r.used.label).toBe('codex');
    expect(calls).toEqual(['codex']);
  });

  test('해석된 프로바이더는 별도 resolved 관측에 기록하고 attempt는 한 번만 남긴다', async () => {
    const seen: Array<{ event: string; data: ReviewFallbackObservation }> = [];
    const observe = (event: string, data: ReviewFallbackObservation) => { seen.push({ event, data }); };
    await runReviewWithFallback([A], async (_attempt, resolved) => {
      resolved('openai-codex');
      return 'PASS';
    }, observe);
    await runReviewWithFallback([A], async (_attempt, resolved) => {
      resolved(A.provider.name);
      return 'PASS';
    }, observe);
    await runReviewWithFallback([A], async () => 'PASS', observe);

    const attempts = seen.filter(({ event }) => event === 'attempt');
    const resolved = seen.filter(({ event }) => event === 'resolved');
    expect(attempts).toEqual([
      { event: 'attempt', data: { attempt: 1, total: 1, label: 'codex', model: A.model, provider: A.provider.name } },
      { event: 'attempt', data: { attempt: 1, total: 1, label: 'codex', model: A.model, provider: A.provider.name } },
      { event: 'attempt', data: { attempt: 1, total: 1, label: 'codex', model: A.model, provider: A.provider.name } },
    ]);
    expect(resolved).toEqual([
      { event: 'resolved', data: { attempt: 1, total: 1, label: 'codex', model: A.model, provider: A.provider.name, resolvedProvider: 'openai-codex' } },
      { event: 'resolved', data: { attempt: 1, total: 1, label: 'codex', model: A.model, provider: A.provider.name, resolvedProvider: A.provider.name } },
    ]);
  });

  test('provider 시도와 비어 있지 않은 논리 리뷰 완료를 분리한다', async () => {
    const count = async (run: (observe: (event: string, data: ReviewFallbackObservation) => void) => Promise<unknown>) => {
      const seen: string[] = [];
      await run((event) => { seen.push(event); });
      return {
        attempts: seen.filter((event) => event === 'attempt').length,
        completed: seen.filter((event) => event === 'completed').length,
      };
    };

    await expect(count((observe) => runReviewWithFallback([A, B], async () => 'PASS', observe)))
      .resolves.toEqual({ attempts: 1, completed: 1 });
    await expect(count((observe) => runReviewWithFallback([A, B], async (attempt) => {
      if (attempt === A) throw new Error('Our servers are currently overloaded.');
      return 'PASS';
    }, observe))).resolves.toEqual({ attempts: 2, completed: 1 });
    await expect(count((observe) => runReviewWithFallback([A, B], async (attempt) => {
      if (attempt === A) throw new Error('Our servers are currently overloaded.');
      return '   ';
    }, observe))).resolves.toEqual({ attempts: 2, completed: 0 });
  });

  test('확정 뒤 실패도 실제 프로바이더를 남기며 다음 시도로 새지 않는다', async () => {
    const seen: Array<{ event: string; data: ReviewFallbackObservation }> = [];
    await expect(runReviewWithFallback([A, B], async (attempt, resolved) => {
      if (attempt === A) {
        resolved('openai-codex');
        throw new Error('Our servers are currently overloaded.');
      }
      return 'PASS';
    }, (event, data) => { seen.push({ event, data }); })).resolves.toMatchObject({ used: B });

    expect(seen).toContainEqual({
      event: 'fallback',
      data: { attempt: 1, total: 2, label: 'codex', model: A.model, provider: A.provider.name, resolvedProvider: 'openai-codex', afterReason: 'overloaded', errorMessage: 'Our servers are currently overloaded.' },
    });
    expect(seen).toContainEqual({
      event: 'attempt',
      data: { attempt: 2, total: 2, label: 'grok', model: B.model, provider: B.provider.name, afterReason: 'overloaded' },
    });
  });

  test('⭐ 과부하면 다음 제공자로 넘어가고 «전이가 관측»된다', async () => {
    const seen: Array<{ e: string; label: string; after?: string }> = [];
    const r = await runReviewWithFallback([A, B], async (a) => {
      if (a.label === 'codex') throw new Error('Our servers are currently overloaded.');
      return 'PASS from grok';
    }, (e, d) => { seen.push({ e, label: d.label, after: d.afterReason }); });
    expect(r.used.label).toBe('grok');
    expect(r.attemptIndex).toBe(1);
    expect(seen.map((s) => s.e)).toEqual(['attempt', 'fallback', 'attempt', 'completed']);
    // ⛔ 「왜 넘어갔나」가 값으로 남는다 — 나중에 세려면 이게 있어야 한다
    expect(seen[1]!.after).toBe('overloaded');
    expect(seen[2]!.after).toBe('overloaded');
  });

  test('OpenRouter 자격이 없으면 설정된 다음 제공자를 시도한다', async () => {
    const openrouter = { model: 'openrouter/z-ai/glm-5.3', provider: getProvider('openrouter/z-ai/glm-5.3')!, label: 'openrouter' };
    const calls: string[] = [];
    const seen: Array<{ event: string; data: ReviewFallbackObservation }> = [];
    const result = await runReviewWithFallback([openrouter, B], async (attempt) => {
      calls.push(attempt.label);
      if (attempt === openrouter) throw new Error('openrouter unavailable: configure apiKey via `elanous setup`');
      return 'PASS from grok';
    }, (event, data) => seen.push({ event, data }));

    expect(calls).toEqual(['openrouter', 'grok']);
    expect(result).toMatchObject({ text: 'PASS from grok', used: B, attemptIndex: 1 });
    expect(seen.map(({ event }) => event)).toEqual(['attempt', 'fallback', 'attempt', 'completed']);
    expect(seen[1]?.data).toMatchObject({ afterReason: 'credentials-unavailable' });
  });

  test('② 폴백 불가능한 오류는 사유를 남기고 즉시 던진다 — 다른 모델로 안 샌다', async () => {
    const calls: string[] = [];
    await expect(runReviewWithFallback([A, B], async (a) => {
      calls.push(a.label); throw new Error('prompt too long');
    })).rejects.toThrow('prompt too long');
    expect(calls).toEqual(['codex']);
  });

  test('모델-프로바이더 불일치·과부하·기타 실패는 유한 사유와 원문으로 관측된다', async () => {
    const observed: Array<{ reason?: string; message?: string }> = [];
    for (const [message, reason] of [
      ["Codex API 400: The 'grok-4.6' model is not supported when using Codex", 'model-provider-mismatch'],
      ['Our servers are currently overloaded.', 'overloaded'],
      ['invalid api key', 'other'],
    ] as const) {
      await expect(runReviewWithFallback([A], async () => { throw new Error(message); }, (_event, data) => {
        if (data.afterReason) observed.push({ reason: data.afterReason, message: data.errorMessage });
      })).rejects.toThrow(message);
    }
    expect(observed).toEqual([
      { reason: 'model-provider-mismatch', message: "Codex API 400: The 'grok-4.6' model is not supported when using Codex" },
      { reason: 'overloaded', message: 'Our servers are currently overloaded.' },
      { reason: 'other', message: 'invalid api key' },
    ]);
  });

  test('프로바이더를 못 정한 모델은 호출하지 않고 사유를 남긴 뒤 다음 시도로 간다', async () => {
    const seen: Array<{ event: string; reason?: string; message?: string }> = [];
    const r = await runReviewWithFallback([
      { model: 'unregistered-review-model', label: 'unknown' },
      B,
    ], async (attempt) => {
      expect(attempt.label).toBe('grok');
      return 'PASS';
    }, (event, data) => { seen.push({ event, reason: data.afterReason, message: data.errorMessage }); });
    expect(r.used).toBe(B);
    expect(seen).toEqual([
      { event: 'attempt', reason: undefined, message: undefined },
      { event: 'fallback', reason: 'unknown-model-provider', message: 'review fallback: unable to infer provider for model unregistered-review-model' },
      { event: 'attempt', reason: 'unknown-model-provider', message: undefined },
      { event: 'completed', reason: 'unknown-model-provider', message: undefined },
    ]);
  });

  test('③ 전부 실패하면 «마지막» 오류를 던진다 — 첫 오류로 덮지 않는다', async () => {
    await expect(runReviewWithFallback([A, B], async (a) => {
      throw new Error(a.label === 'codex' ? 'overloaded' : 'HTTP 503 last one');
    })).rejects.toThrow('HTTP 503 last one');
  });

  test('④ 시도가 없으면 이름을 대고 거부한다', async () => {
    await expect(runReviewWithFallback([], async () => 'x')).rejects.toThrow('no attempts configured');
  });

  test('⛔ 관측 콜백이 던져도 리뷰를 막지 않는다', async () => {
    const r = await runReviewWithFallback([A], async () => 'PASS', () => { throw new Error('sink down'); });
    expect(r.text).toBe('PASS');
  });
});

// 🩸 B8(2026-09-25): 기대값에 `grok-4.6` 을 박아 두어 사다리가 4.7 로 옮겨지자 main 에서 둘이 빨갛게 됐다 — 사다리에서 파생한다.
const GROK_LADDER = resolveModelAlias('grok')!;

describe('reviewFallbackModelsFromConfig — config 노브', () => {
  test('⭐ 기본은 «빈 목록» — 이 착지는 기전만 세우고 동작을 «안» 바꾼다', async () => {
    const { reviewFallbackModelsFromConfig } = await import('./review-provider-fallback.js');
    expect(reviewFallbackModelsFromConfig(() => ({}))).toEqual([]);
    expect(reviewFallbackModelsFromConfig(() => ({ llm: {} }))).toEqual([]);
  });

  test('문자열 배열만 받고 공백·비문자열은 버리며 별칭을 정식 모델명으로 해석한다', async () => {
    const { reviewFallbackModelsFromConfig } = await import('./review-provider-fallback.js');
    expect(reviewFallbackModelsFromConfig(() => ({
      llm: { reviewFallbackModels: ['grok', 'grok-fast', '  ', 7, ' claude-opus ', 'unknown-model'] as unknown },
    }))).toEqual([GROK_LADDER, resolveModelAlias('grok-fast')!, 'claude-opus', 'unknown-model']);
  });

  test('해석된 폴백도 주 모델 뒤의 시도 목록에만 추가한다', async () => {
    const { reviewFallbackModelsFromConfig } = await import('./review-provider-fallback.js');
    const models = reviewFallbackModelsFromConfig(() => ({ llm: { reviewFallbackModels: ['grok'] } }));
    expect(buildReviewProviderAttempts(A, models.map((model) => ({ model, label: model })))).toEqual([
      A,
      { model: GROK_LADDER, provider: getProvider(GROK_LADDER), label: GROK_LADDER },
    ]);
  });

  test('⛔ 읽기가 던져도 «막지» 않는다 — 폴백 없이 종전대로 돈다', async () => {
    const { reviewFallbackModelsFromConfig } = await import('./review-provider-fallback.js');
    expect(reviewFallbackModelsFromConfig(() => { throw new Error('config down'); })).toEqual([]);
  });
});
