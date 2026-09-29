import { describe, expect, test } from 'bun:test';
import { shadowBoundaryDecision, type BoundaryShadowDeps } from './boundary-shadow.js';
import type { JevRequest, JevResponse } from './jev.js';

const request = { requestId: 'r-1', requestKind: 'rejected', command: 'safe command' };
const rejected = { requestKind: 'rejected', wouldApprove: false, evidenceWhy: 'not allowed' };
const local = { enabled: true, endpoint: 'http://localhost:1234/v1/systemone' };

function observer() {
  const requests: JevRequest[] = [];
  const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  const deps: BoundaryShadowDeps = {
    callJev: async (req) => {
      requests.push(req);
      return { model: 'local', answers: { irreversible: { type: 'noul', noul: 0.05, confidence: 0.8 } } };
    },
    log: (category, event, data) => { events.push({ category, event, data }); },
    logUsage: () => {},
  };
  return { requests, events, deps };
}

describe('boundary Jev shadow', () => {
  test('default off and rejected-only: no request or observation for disabled and approved verdicts', async () => {
    const o = observer();
    await shadowBoundaryDecision(request, rejected, undefined, o.deps);
    await shadowBoundaryDecision(request, rejected, { enabled: false, endpoint: local.endpoint }, o.deps);
    await shadowBoundaryDecision({ ...request, requestKind: 'command-start' }, { ...rejected, requestKind: 'command-start' }, local, o.deps);
    await shadowBoundaryDecision({ ...request, requestKind: 'command-start-cap-reached' }, { ...rejected, requestKind: 'command-start-cap-reached' }, local, o.deps);
    expect(o.requests).toHaveLength(0);
    expect(o.events).toHaveLength(0);
    await shadowBoundaryDecision(request, rejected, local, o.deps);
    expect(o.requests).toHaveLength(1);
    expect(o.events[0]?.event).toBe('judged');
  });

  test('sampling gates at both bounds and uses supplied randomness only for fractional rates', async () => {
    const o = observer();
    const random = () => 0.5;
    await shadowBoundaryDecision(request, rejected, { ...local, sampleRate: 0 }, { ...o.deps, random });
    await shadowBoundaryDecision(request, rejected, { ...local, sampleRate: Number.NaN }, { ...o.deps, random });
    await shadowBoundaryDecision(request, rejected, { ...local, sampleRate: 2 }, { ...o.deps, random });
    await shadowBoundaryDecision(request, rejected, { ...local, sampleRate: 0.5 }, { ...o.deps, random });
    expect(o.requests).toHaveLength(0);
    await shadowBoundaryDecision(request, rejected, { ...local, sampleRate: 0.51 }, { ...o.deps, random });
    await shadowBoundaryDecision(request, rejected, { ...local, sampleRate: 1 }, { ...o.deps, random: () => { throw new Error('unnecessary random'); } });
    expect(o.requests).toHaveLength(2);
  });

  test('masks nested secret fields and free-form credentials before Jev request; original is unchanged', async () => {
    const o = observer();
    const sensitive = { requestId: 'r-2', requestKind: 'rejected', metadata: { password: 'super-sensitive', nested: [{ api_key: 'sk-sensitive123456', detail: 'Bearer bearer-sensitive token=token-sensitive' }] }, command: 'ordinary' };
    await shadowBoundaryDecision(sensitive, { ...rejected, evidenceWhy: 'Authorization: risky-sensitive' }, local, o.deps);
    const outgoing = JSON.stringify(o.requests[0]);
    expect(outgoing).not.toContain('super-sensitive');
    expect(outgoing).not.toContain('sk-sensitive123456');
    expect(outgoing).not.toContain('bearer-sensitive');
    expect(outgoing).not.toContain('token-sensitive');
    expect(outgoing).not.toContain('risky-sensitive');
    expect(outgoing).toContain('[REDACTED]');
    expect(outgoing).toContain('ordinary');
    expect(outgoing).toContain('"type":"noul"');
    expect(sensitive.metadata.password).toBe('super-sensitive');
    expect(JSON.stringify(o.events)).not.toContain('sensitive');
  });

  test('masks credentials in requestId in both Jev state and observation events', async () => {
    const o = observer();
    const sensitive = { ...request, requestId: 'r-2 Authorization: Bearer 비밀값' };
    await shadowBoundaryDecision(sensitive, rejected, local, o.deps);
    expect(JSON.stringify(o.requests)).not.toContain('비밀값');
    expect(JSON.stringify(o.events)).not.toContain('비밀값');
    expect(o.events[0]?.data.requestId).toBe('r-2 Authorization: [REDACTED] [REDACTED]');
    expect(sensitive.requestId).toBe('r-2 Authorization: Bearer 비밀값');

    const failed = observer();
    await shadowBoundaryDecision(sensitive, rejected, local, {
      ...failed.deps, callJev: async () => { throw new Error('request failed'); },
    });
    expect(failed.events[0]?.event).toBe('failed');
    expect(JSON.stringify(failed.events)).not.toContain('비밀값');
    expect(failed.events[0]?.data.requestId).toBe('r-2 Authorization: [REDACTED] [REDACTED]');
  });

  test('masks Jev response model before emitting the success observation', async () => {
    const o = observer();
    await shadowBoundaryDecision(request, rejected, local, {
      ...o.deps,
      callJev: async () => ({
        model: 'Authorization: Bearer 비밀값',
        answers: { irreversible: { type: 'noul', noul: 0.7, confidence: 0.8 } },
      }),
    });
    expect(o.events).toHaveLength(1);
    expect(o.events[0]?.event).toBe('judged');
    expect(JSON.stringify(o.events)).not.toContain('비밀값');
    expect(o.events[0]?.data.model).toBe('Authorization: [REDACTED] [REDACTED]');
    expect(o.events[0]?.data.jevYes).toBe(0.7);
    expect(o.events[0]?.data.confidence).toBe(0.8);
  });

  test('masks secrets in object property names before sending the Jev request', async () => {
    const o = observer();
    const sensitive = {
      requestId: 'r-key', requestKind: 'rejected',
      metadata: { 'Authorization: Bearer 비밀값': 'header-value', 'note Bearer nested-key-value': 'safe-value' },
    };
    await shadowBoundaryDecision(sensitive, rejected, local, o.deps);
    const outgoing = JSON.stringify(o.requests[0]);
    expect(o.requests).toHaveLength(1);
    expect(outgoing).not.toContain('비밀값');
    expect(outgoing).not.toContain('nested-key-value');
    expect(outgoing).not.toContain('header-value');
    expect(outgoing).toContain('[REDACTED]');
    expect(sensitive.metadata['Authorization: Bearer 비밀값']).toBe('header-value');
  });

  test('masks serialized JSON credentials inside free-form boundary text', async () => {
    const o = observer();
    await shadowBoundaryDecision({ requestId: 'r-json', requestKind: 'rejected', line: '{"password":"json-secret","api_key":"json-key"}' }, rejected, local, o.deps);
    const outgoing = JSON.stringify(o.requests[0]);
    expect(outgoing).not.toContain('json-secret');
    expect(outgoing).not.toContain('json-key');
    expect(outgoing).toContain('[REDACTED]');
  });

  test('times out at 5 seconds without waiting for a hung Jev request, records failure without changing verdict', async () => {
    const o = observer();
    let timeoutMs = 0;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers = new Map<object, () => void>();
    globalThis.setTimeout = ((callback: () => void, ms: number) => {
      timeoutMs = ms;
      const handle = {};
      timers.set(handle, callback);
      return handle as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
      timers.delete(handle as object);
    }) as typeof clearTimeout;
    try {
      const pending = shadowBoundaryDecision(request, rejected, local, {
        ...o.deps,
        callJev: async () => new Promise<JevResponse>(() => {}),
      });
      expect(timeoutMs).toBe(5_000);
      for (const callback of timers.values()) callback();
      await pending;
      expect(o.events).toEqual([{ category: 'decide.boundary-shadow', event: 'failed', data: { requestId: 'r-1', reason: 'timeout' } }]);
      expect(timers.size).toBe(0);
      expect(rejected.wouldApprove).toBe(false);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test('timeout aborts the in-flight HTTP request', async () => {
    const o = observer();
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let fire: (() => void) | undefined;
    let aborted = false;
    globalThis.setTimeout = ((callback: () => void, ms: number) => {
      expect(ms).toBe(5_000);
      fire = callback;
      return {} as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
    try {
      const pending = shadowBoundaryDecision(request, rejected, local, {
        ...o.deps,
        callJev: async (_req, _key, fetchImpl) => {
          await fetchImpl('http://local', { method: 'POST' });
          return { model: 'local', answers: {} };
        },
        fetch: (async (_url, init) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
        })) as typeof fetch,
      });
      expect(fire).toBeDefined();
      fire?.();
      await pending;
      expect(aborted).toBe(true);
      expect(o.events[0]?.data.reason).toBe('timeout');
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test('Jev failure and log failure are fail-soft; no approval mutation', async () => {
    const o = observer();
    await shadowBoundaryDecision(request, rejected, local, {
      ...o.deps, callJev: async () => { throw new Error('secret internal detail'); },
    });
    expect(o.events[0]?.data.reason).toBe('request-failed');
    expect(JSON.stringify(o.events)).not.toContain('secret internal detail');
    await expect(shadowBoundaryDecision(request, rejected, local, { ...o.deps, log: () => { throw new Error('log failed'); } })).resolves.toBeUndefined();
    expect(rejected.wouldApprove).toBe(false);
  });

  test('irreversible question: blocked-but-safe and approved-but-irreversible are recorded, usage is tagged', async () => {
    const levels: Array<string | undefined> = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const usage: Array<{ model: string; usage: Record<string, unknown> }> = [];
    const asked: JevRequest[] = [];
    const deps = (noul: number): BoundaryShadowDeps => ({
      callJev: async (req) => { asked.push(req); return { model: 'jev-1.13.0', answers: { irreversible: { type: 'noul', noul } }, usage: { input_tokens: 298, output_tokens: 0 } }; },
      log: (_category, event, data, level) => { events.push({ event, data }); levels.push(level); },
      logUsage: (model, u) => { usage.push({ model, usage: u }); },
    });
    await shadowBoundaryDecision({ requestId: 'r-ls', requestKind: 'rejected', command: 'ls -la src/', decidingToken: 'none' }, { requestKind: 'rejected', wouldApprove: false }, local, deps(0.02));
    expect(Object.keys(asked[0]!.questions)).toEqual(['irreversible']);
    expect(events.map((e) => e.event)).toEqual(['judged', 'safe-but-blocked']);
    expect(events[0]!.data).toMatchObject({ allowlistApprove: false, jevYes: 0.02, irreversible: false, agree: false, threshold: 0.7 });
    expect(usage).toEqual([{ model: 'jev-1.13.0', usage: { inputTokens: 298, outputTokens: 0 } }]);
    events.length = 0; levels.length = 0;
    await shadowBoundaryDecision({ requestId: 'r-rm', requestKind: 'rejected', command: 'rm -rf build' }, { requestKind: 'rejected', wouldApprove: true }, local, deps(0.9));
    expect(events.map((e) => e.event)).toEqual(['judged', 'warn-disagree']);
    expect(levels).toEqual([undefined, 'warn']);
    expect(events[1]!.data).toMatchObject({ allowlistApprove: true, irreversible: true, agree: false });
    expect(JSON.stringify(events)).not.toContain('rm -rf build');
  });

  test('shell-argument secrets never reach the Jev request body', async () => {
    const cases = [
      'curl -H "Authorization: Bearer abc123SECRETzz" https://x',
      'curl --header=X-Api-Key:k3y5ECRETqq https://x',
      "curl -H 'x-api-key: k3y5ECRET22' https://x",
      'curl -u alice:p4ssSECRET https://x',
      'GITHUB_TOKEN=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA gh pr list',
      'tool --token t0kSECRETxyz run',
      'git clone https://user:passSECRET@github.com/o/r.git',
      'XAI_API_KEY=xai-SECRETabcdef123 bun run x',
      'OPENAI_API_KEY=sk-proj-SECRETabcdef1234567 node x',
      'curl -b "session=c00kieSECRET" https://x',
    ];
    for (const command of cases) {
      let body = '';
      await shadowBoundaryDecision({ requestId: 'r', requestKind: 'rejected', command }, rejected, local, {
        callJev: async (req) => { body = JSON.stringify(req); return { model: 'm', answers: { irreversible: { type: 'noul', noul: 0.1 } } }; },
        log: () => {}, logUsage: () => {},
      });
      expect(body.length).toBeGreaterThan(0);
      expect(body).not.toMatch(/SECRET|ghp_A{10}/);
    }
    // 비밀이 아닌 명령은 그대로 간다(Jev 가 판정할 수 있어야 한다).
    let plain = '';
    await shadowBoundaryDecision({ requestId: 'r', requestKind: 'rejected', command: 'git push --force origin main' }, rejected, local, {
      callJev: async (req) => { plain = JSON.stringify(req); return { model: 'm', answers: { irreversible: { type: 'noul', noul: 0.6 } } }; },
      log: () => {}, logUsage: () => {},
    });
    expect(plain).toContain('git push --force origin main');
  });
});
