import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import {
  __resetStaleOpenRouterSnapshotWarningForTests,
  ensureOpenRouterChildModelLive,
  resolveImplementationChildModel,
} from '../../self-dev/dev-cli.js';
import { reloadCatalog } from '../loader.js';
import { __resetOpenRouterLiveResolveForTests } from './openrouter-live-resolve.js';

const KNOWN = 'z-ai/glm-test-known';
const NEW = 'anthropic/claude-haiku-5.5';
const NOW = Date.parse('2026-10-10T06:00:00.000Z');

function snapshotWith(ids: string[], generatedAt = '2026-10-09T06:00:00.000Z') {
  return {
    version: 1,
    generatedAt,
    sources: [{ id: 'openrouter', ok: true, durationMs: 1, modelCount: ids.length }],
    models: ids.map((id) => ({
      id,
      provider: 'openrouter',
      partial: { id, provider: 'openrouter', displayName: id },
      discoveryMeta: { source: 'auto-openrouter-api', lastSeen: generatedAt, autoFilled: true, confidence: 'high' },
    })),
  };
}

function fakeFetch(ids: string[], calls: { n: number }): typeof fetch {
  return (async () => {
    calls.n += 1;
    return new Response(JSON.stringify({ data: ids.map((id) => ({ id, name: id, supported_parameters: ['tools', 'reasoning'] })) }), { status: 200 });
  }) as unknown as typeof fetch;
}

let dir: string;
let path: string;
let previousSnapshot: string | undefined;
let logs: Array<{ event: string; data: unknown }>;
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'or-live-resolve-'));
  path = join(dir, 'discovery-snapshot.json');
  previousSnapshot = process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT;
  process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT = path;
  writeFileSync(path, JSON.stringify(snapshotWith([KNOWN])));
  reloadCatalog();
  __resetOpenRouterLiveResolveForTests();
  __resetStaleOpenRouterSnapshotWarningForTests();
  logs = [];
  logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
    if (category === 'registry.discovery') logs.push({ event, data });
  }) as typeof debug.log);
});

afterEach(() => {
  logSpy.mockRestore();
  if (previousSnapshot === undefined) delete process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT;
  else process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT = previousSnapshot;
  rmSync(dir, { recursive: true, force: true });
  reloadCatalog();
});

describe('OR-MODEL-NAMESPACE — live OpenRouter child model resolve', () => {
  test('invariant: snapshot id and non-openrouter providers make zero network calls and resolve unchanged', async () => {
    const calls = { n: 0 };
    const before = resolveImplementationChildModel('openrouter', `openrouter/${KNOWN}`);
    await ensureOpenRouterChildModelLive('openrouter', `openrouter/${KNOWN}`, { fetchImpl: fakeFetch([], calls), now: () => NOW, write: () => {} });
    expect(resolveImplementationChildModel('openrouter', `openrouter/${KNOWN}`)).toEqual(before);
    const grokBefore = resolveImplementationChildModel('grok', 'grok-4.6');
    await ensureOpenRouterChildModelLive('grok', 'grok-4.6', { fetchImpl: fakeFetch([], calls), now: () => NOW, write: () => {} });
    await ensureOpenRouterChildModelLive('grok', 'not-a-real-model', { fetchImpl: fakeFetch([], calls), now: () => NOW, write: () => {} });
    expect(resolveImplementationChildModel('grok', 'grok-4.6')).toEqual(grokBefore);
    expect(calls.n).toBe(0);
    expect(logs).toEqual([]);
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual(snapshotWith([KNOWN]));
  });

  test('a model missing from the snapshot but present upstream passes and is merged into the snapshot', async () => {
    const calls = { n: 0 };
    expect(() => resolveImplementationChildModel('openrouter', `openrouter/${NEW}`)).toThrow('--child-llm-model 알 수 없음');
    await ensureOpenRouterChildModelLive('openrouter', `openrouter/${NEW}`, { fetchImpl: fakeFetch([KNOWN, NEW], calls), now: () => NOW, write: () => {} });
    expect(calls.n).toBe(1);
    expect(resolveImplementationChildModel('openrouter', `openrouter/${NEW}`).resolvedId).toBe(`openrouter/${NEW}`);
    const written = JSON.parse(readFileSync(path, 'utf-8'));
    expect(written.generatedAt).toBe('2026-10-09T06:00:00.000Z');
    expect(written.models.map((m: { id: string }) => m.id)).toEqual([KNOWN, NEW]);
    expect(logs).toContainEqual({ event: 'child-model-live-resolve', data: expect.objectContaining({ id: `openrouter/${NEW}`, found: true, snapshotAgeDays: 1 }) });
  });

  test('persist:false (dry-run) verifies live but leaves the snapshot file untouched', async () => {
    const calls = { n: 0 };
    const lines: string[] = [];
    await ensureOpenRouterChildModelLive('openrouter', `openrouter/${NEW}`, { fetchImpl: fakeFetch([NEW], calls), now: () => NOW, write: (l) => lines.push(l), persist: false });
    expect(calls.n).toBe(1);
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual(snapshotWith([KNOWN]));
    expect(resolveImplementationChildModel('openrouter', `openrouter/${NEW}`).resolvedId).toBe(`openrouter/${NEW}`);
    expect(lines).toEqual([]);
  });

  test('a model absent upstream is still rejected with candidates and the snapshot is untouched', async () => {
    const calls = { n: 0 };
    const attempt = ensureOpenRouterChildModelLive('openrouter', 'openrouter/anthropic/claude-nope-9', { fetchImpl: fakeFetch([KNOWN, NEW], calls), now: () => NOW, write: () => {} });
    await expect(attempt).rejects.toThrow('--child-llm-model 알 수 없음: openrouter/anthropic/claude-nope-9 · 후보:');
    await expect(ensureOpenRouterChildModelLive('openrouter', 'openrouter/anthropic/claude-nope-9', { fetchImpl: fakeFetch([KNOWN], calls), now: () => NOW, write: () => {} }))
      .rejects.not.toThrow('카탈로그 확인 못 함');
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual(snapshotWith([KNOWN]));
    expect(logs).toContainEqual({ event: 'child-model-live-resolve', data: expect.objectContaining({ found: false }) });
  });

  test('network failure or timeout is fail-closed with «카탈로그 확인 못 함»', async () => {
    const broken = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(ensureOpenRouterChildModelLive('openrouter', `openrouter/${NEW}`, { fetchImpl: broken, now: () => NOW, write: () => {} }))
      .rejects.toThrow('카탈로그 확인 못 함(upstream-network: ECONNREFUSED)');
    const hanging = ((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })) as unknown as typeof fetch;
    await expect(ensureOpenRouterChildModelLive('openrouter', `openrouter/${NEW}`, { fetchImpl: hanging, timeoutMs: 20, now: () => NOW, write: () => {} }))
      .rejects.toThrow('카탈로그 확인 못 함(upstream-timeout)');
    expect(() => resolveImplementationChildModel('openrouter', `openrouter/${NEW}`)).toThrow('--child-llm-model 알 수 없음');
    expect(logs).toContainEqual({ event: 'child-model-live-resolve', data: expect.objectContaining({ found: false, error: 'upstream-timeout' }) });
  });

  test('a snapshot older than 7 days warns once on stderr; a fresh one does not', async () => {
    const lines: string[] = [];
    await ensureOpenRouterChildModelLive('openrouter', `openrouter/${KNOWN}`, { fetchImpl: fakeFetch([], { n: 0 }), now: () => NOW, write: (l) => lines.push(l) });
    expect(lines).toEqual([]);
    writeFileSync(path, JSON.stringify(snapshotWith([KNOWN], '2026-09-23T09:36:02.206Z')));
    reloadCatalog();
    await ensureOpenRouterChildModelLive('openrouter', `openrouter/${KNOWN}`, { fetchImpl: fakeFetch([], { n: 0 }), now: () => NOW, write: (l) => lines.push(l) });
    await ensureOpenRouterChildModelLive('openrouter', `openrouter/${KNOWN}`, { fetchImpl: fakeFetch([], { n: 0 }), now: () => NOW, write: (l) => lines.push(l) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('16일 묵었다');
  });
});
