import { describe, expect, it } from 'bun:test';
import {
  createAsideRemoteRouter,
  areAsideRemoteTargetsConfigured,
  beginAsideRemoteTargetsConfiguration,
  getAsideRemoteRouter,
  resolveAsideTarget,
  validateAsideTargets,
  setAsideRemoteRouter,
  setAsideRemoteTargetsConfigured,
  sanitizeAsideObservabilityText,
  type AsideRemoteTarget,
} from '../aside/remote-targets.js';

const targets: AsideRemoteTarget[] = validateAsideTargets([
  { id: 'mac-a', host: 'minim5', command: ['aside', 'mcp'], capabilities: ['browser', 'repl', 'selection'] },
  { id: 'mac-b', host: 'node-b', command: ['aside', 'mcp'], capabilities: ['browser', 'repl'] },
]);
const online = new Map([
  ['mac-a', { online: true, authenticated: true }],
  ['mac-b', { online: true, authenticated: true }],
]);

describe('ASIDE-REMOTE-TARGET selection and MCP roundtrip', () => {
  it('selects explicit, context, global, and unique automatic targets in order', () => {
    const prefs = { defaultTargetId: 'mac-b', contextDefaults: { research: 'mac-a' } };
    expect(resolveAsideTarget(targets, { targetId: 'mac-a' }, prefs, online)).toMatchObject({ ok: true, target: { id: 'mac-a' }, source: 'explicit' });
    expect(resolveAsideTarget(targets, { context: 'research' }, prefs, online)).toMatchObject({ ok: true, target: { id: 'mac-a' }, source: 'context' });
    expect(resolveAsideTarget(targets, {}, prefs, online)).toMatchObject({ ok: true, target: { id: 'mac-b' }, source: 'global' });
    expect(resolveAsideTarget([targets[0]!], {}, {}, online)).toMatchObject({ ok: true, target: { id: 'mac-a' }, source: 'automatic' });
  });

  it('fails closed for ambiguity and explicit offline or authentication failure', () => {
    expect(resolveAsideTarget(targets, {}, {}, online)).toMatchObject({ ok: false, reason: 'ambiguous', candidates: ['mac-a', 'mac-b'] });
    expect(resolveAsideTarget(targets, { targetId: 'mac-b' }, {}, new Map([['mac-b', { online: false, authenticated: false }]]))).toMatchObject({ ok: false, reason: 'offline' });
    expect(resolveAsideTarget(targets, { targetId: 'mac-a' }, {}, new Map([['mac-a', { online: true, authenticated: false }]]))).toMatchObject({ ok: false, reason: 'authentication-failed' });
  });

  it('routes concurrent calls to their own target and preserves model-facing remote results', async () => {
    const calls: string[] = [];
    const router = createAsideRemoteRouter({
      targets,
      preferences: {},
      health: () => online,
      clients: new Map(targets.map(target => [target.id, { callTool: async (_name, args) => {
        calls.push(`${target.id}:${String(args.prompt)}`);
        return { content: [{ type: 'text', text: target.id === 'mac-a' ? 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB' : target.id }] };
      } }])),
    });
    const [a, b] = await Promise.all([
      router.call('exec', { prompt: 'canary-a' }, { targetId: 'mac-a', capability: 'repl' }),
      router.call('exec', { prompt: 'canary-b' }, { targetId: 'mac-b', capability: 'repl' }),
    ]);
    expect(calls.sort()).toEqual(['mac-a:canary-a', 'mac-b:canary-b']);
    expect(JSON.stringify(a)).toContain('ghp_***');
    expect(JSON.stringify(a)).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyzAB');
    expect(JSON.stringify(b)).toContain('mac-b');
    let error = '';
    try { await router.call('exec', { prompt: 'canary-secret' }, {}); } catch (caught) { error = String(caught); }
    expect(error).toContain('ambiguous');
    expect(error).not.toContain('canary-secret');
  });

  it('redacts standard secrets in model-facing results without entropy or URL rewriting', async () => {
    const router = createAsideRemoteRouter({
      targets: [targets[0]!], preferences: {}, health: () => new Map([['mac-a', { online: true, authenticated: true }]]),
      clients: new Map([['mac-a', { callTool: async () => ({ content: [{ type: 'text', text: 'tokenization works; ghp_0123456789abcdefghijklmnopqrstuvwxyzAB; aZ9bC8dE7fGh; abcdefghijklmnopQRSTUVWX01234567; https://example.test/search/abcdefghijklmnopQRSTUVWX01234567' }] }) }]]),
    });
    const result = await router.call('exec', {}, { targetId: 'mac-a' });
    const text = JSON.stringify(result);
    expect(text).toContain('tokenization works');
    expect(text).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyzAB');
    expect(text).toContain('ghp_***');
    expect(text).toContain('aZ9bC8dE7fGh');
    expect(text).toContain('abcdefghijklmnopQRSTUVWX01234567');
    expect(text).toContain('https://example.test/search/abcdefghijklmnopQRSTUVWX01234567');
  });

  it('strict redaction mode masks high-entropy model-facing result text when enabled', async () => {
    const canaries = [
      'aZ9bC8dE7fGhJ2kL4mN6pQ8rT0vX5sW',
      'aB3+dE4/fG5+hI6/jK7+lM8/nO9+pQ0=',
    ];
    for (const isError of [false, true]) {
      const router = createAsideRemoteRouter({
        targets: [targets[0]!], preferences: {}, strictRedactMode: true,
        health: () => new Map([['mac-a', { online: true, authenticated: true }]]),
        clients: new Map([['mac-a', { callTool: async () => ({ isError, content: [{ type: 'text', text: `selected item title; ${canaries.join('; ')}; readable tail` }] }) }]]),
      });

      const result = await router.call('exec', {}, { targetId: 'mac-a' });
      const text = JSON.stringify(result);
      for (const canary of canaries) expect(text).not.toContain(canary);
      expect(text).toContain('[REDACTED]');
      expect(text).toContain('selected item title');
      expect(text).toContain('readable tail');
    }
  });

  it('strict and observability redaction still catch a high-entropy segment after a low-entropy slash prefix', async () => {
    const highEntropySegment = 'aZ9bC8dE7fGh';
    const combined = `${'a'.repeat(48)}/${highEntropySegment}`;
    const router = createAsideRemoteRouter({
      targets: [targets[0]!], preferences: {}, strictRedactMode: true,
      health: () => new Map([['mac-a', { online: true, authenticated: true }]]),
      clients: new Map([['mac-a', { callTool: async () => ({ content: [{ type: 'text', text: combined }] }) }]]),
    });

    const result = await router.call('exec', {}, { targetId: 'mac-a' });
    expect(JSON.stringify(result)).not.toContain(highEntropySegment);
    expect(JSON.stringify(result)).toContain('a'.repeat(48));
    expect(sanitizeAsideObservabilityText(combined)).not.toContain(highEntropySegment);
  });

  it('redacts standard secrets from model-facing MCP error-result text', async () => {
    const router = createAsideRemoteRouter({
      targets: [targets[0]!], preferences: {}, health: () => new Map([['mac-a', { online: true, authenticated: true }]]),
      clients: new Map([['mac-a', { callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB aZ9bC8dE7fGh' }] }) }]]),
    });
    const result = await router.call('exec', {}, { targetId: 'mac-a' });
    expect(JSON.stringify(result)).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyzAB');
    expect(JSON.stringify(result)).toContain('ghp_***');
    expect(JSON.stringify(result)).toContain('aZ9bC8dE7fGh');
    expect((result as { isError: boolean }).isError).toBe(true);
  });

  it('scrubs standard secrets, canaries, URLs and opaque tokens only on the observability path', () => {
    const safe = sanitizeAsideObservabilityText('ghp_0123456789abcdefghijklmnopqrstuvwxyzAB token-canary-secret-value aZ9bC8dE7fGh tokenization https://example.test/page?api_key=canary abcdefghijklmnopQRSTUVWX01234567');
    expect(safe).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyzAB');
    expect(safe).not.toContain('token-canary-secret-value');
    expect(safe).not.toContain('aZ9bC8dE7fGh');
    expect(safe).not.toContain('canary');
    expect(safe).not.toContain('abcdefghijklmnopQRSTUVWX01234567');
    expect(safe).toContain('tokenization');
    expect(safe).toContain('[URL_REDACTED]');
  });

  it('keeps remote configuration ownership across overlapping handle shutdowns', () => {
    const olderOwner = {};
    const newerOwner = {};
    const older = { call: async () => ({}) };
    const newer = { call: async () => ({}) };
    setAsideRemoteTargetsConfigured(true, olderOwner);
    setAsideRemoteRouter(older, undefined, olderOwner);
    setAsideRemoteTargetsConfigured(true, newerOwner);
    setAsideRemoteRouter(newer, undefined, newerOwner);
    setAsideRemoteTargetsConfigured(false, olderOwner);
    setAsideRemoteRouter(undefined, older, olderOwner);
    expect(areAsideRemoteTargetsConfigured()).toBe(true);
    expect(getAsideRemoteRouter()).toBe(newer);
    const disabledOwner = {};
    beginAsideRemoteTargetsConfiguration(false, disabledOwner);
    expect(areAsideRemoteTargetsConfigured()).toBe(false);
    expect(getAsideRemoteRouter()).toBeUndefined();
    setAsideRemoteTargetsConfigured(false, newerOwner);
    setAsideRemoteRouter(undefined, newer, newerOwner);
    setAsideRemoteTargetsConfigured(false, disabledOwner);
  });
});
