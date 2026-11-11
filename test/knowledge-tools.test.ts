// ── PFC-S4.2 + S4.3 tool layer ──

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../src/debug/log';
import type { LogRecord } from '../src/mss/logging/record';
import {
  buildKnowledgeQueryTool,
  dispatchKnowledgeQuery,
} from '../src/knowledge/tools/knowledge-query';
import {
  buildKnowledgeWriteTool,
  dispatchKnowledgeWrite,
} from '../src/knowledge/tools/knowledge-write';
import type { ObsidianVault } from '../src/auto-research/obsidian-bridge';

function seedVault(): ObsidianVault {
  const root = mkdtempSync(join(tmpdir(), 'kt-'));
  mkdirSync(join(root, 'Incidents'), { recursive: true });
  writeFileSync(join(root, 'Incidents', 'a.md'),
    `---\nseverity: HIGH\ntitle: test\nresolved: false\ntags: [x]\nkind: incident\n---\n# hello\nworld\n`);
  return { root, isSimulated: false, label: 'kt' };
}

describe('KnowledgeQuery tool', () => {
  test('spec shape — name + no required', () => {
    const spec = buildKnowledgeQueryTool();
    expect(spec.name).toBe('KnowledgeQuery');
    expect(spec.parameters.required).toBeUndefined();
  });

  test('happy path — returns results + summary output', async () => {
    const vault = seedVault();
    const r = await dispatchKnowledgeQuery({ tags: ['x'] }, { vault });
    expect(r.total).toBe(1);
    expect(r.output).toContain('1/1 result');
  });

  test('question with vault filters remains a vault query instead of selecting a pack', async () => {
    const vault = seedVault();
    let selections = 0;
    const selectPack = () => { selections += 1; return { id: 'pack:fixture@1', title: 'fixture' }; };
    for (const input of [
      { question: 'ticketing design', tags: ['x'] },
      { question: 'ticketing design', fulltext: 'world' },
      { question: 'ticketing design', kind: 'incident' as const },
    ]) {
      const result = await dispatchKnowledgeQuery(input, { vault, selectPack });
      expect(result.pack_hits).toBeUndefined();
      expect(result.results).toHaveLength(1);
    }
    expect(selections).toBe(0);
  });

  test('auto-select failure is observed and falls back to the vault query', async () => {
    const vault = seedVault();
    const events: LogRecord[] = [];
    const unregister = debug.registerSink({ name: 'knowledge-query-test', emit: event => events.push(event) });
    try {
      const result = await dispatchKnowledgeQuery({ question: 'ticketing design' }, {
        vault,
        selectPack: () => { throw new Error('KGS store unavailable'); },
      });

      expect(result.pack_hits).toBeUndefined();
      expect(result.total).toBe(1);
      expect(result.results[0]?.relPath).toBe('Incidents/a.md');
      expect(events).toContainEqual(expect.objectContaining({
        category: 'knowledge-pack.select', event: 'failed', level: 'warn',
        data: expect.objectContaining({ fallback: 'vault', errorType: 'Error' }),
      }));
    } finally {
      unregister();
    }
  });

  test('an auto-selected pack search failure is logged without the raw question', async () => {
    const events: LogRecord[] = [];
    const unregister = debug.registerSink({ name: 'knowledge-query-provider-failure', emit: event => events.push(event) });
    const question = 'private ticketing question';
    try {
      const result = await dispatchKnowledgeQuery({ question }, {
        resolvePack: () => ({ kind: 'selected', pack: { id: 'pack:ticketing@1.0.0', title: 'Ticketing' }, priority: 1, intentTags: ['ticketing'] }),
        searchPack: () => { throw new Error('provider unavailable'); },
      });

      expect(result.output).toContain('KnowledgeQuery failed: provider unavailable');
      expect(events).toContainEqual(expect.objectContaining({
        category: 'knowledge-pack.select', event: 'provider-failed', level: 'warn',
        data: expect.objectContaining({ stage: 'pack-search', fallback: 'none', packId: 'pack:ticketing@1.0.0', errorType: 'Error' }),
      }));
      expect(JSON.stringify(events)).not.toContain(question);
    } finally {
      unregister();
    }
  });

  test('kind filter routes correctly', async () => {
    const vault = seedVault();
    const r = await dispatchKnowledgeQuery({ kind: 'incident' }, { vault });
    expect(r.total).toBe(1);
  });

  test('invalid regex returns structured error (no throw)', async () => {
    const vault = seedVault();
    const r = await dispatchKnowledgeQuery({ fulltext: '[[[' }, { vault });
    expect(r.total).toBe(0);
    expect(r.output).toContain('failed');
  });

  test('limit clamp still enforced via dispatch', async () => {
    const vault = seedVault();
    const r = await dispatchKnowledgeQuery({ tags: ['x'], limit: 999 }, { vault });
    expect(r.results.length).toBeLessThanOrEqual(100);
  });
});

describe('KnowledgeWrite tool', () => {
  test('spec shape — required rel_path + body', () => {
    const spec = buildKnowledgeWriteTool();
    expect(spec.name).toBe('KnowledgeWrite');
    expect(spec.parameters.required).toEqual(['rel_path', 'body']);
  });

  test('happy path — writes note', async () => {
    const vault = seedVault();
    const r = await dispatchKnowledgeWrite({
      rel_path: 'Notes/h.md',
      body: 'body',
      kind: 'note',
      frontmatter: { title: 't' },
    }, { vault });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(existsSync(r.path)).toBe(true);
      expect(readFileSync(r.path, 'utf-8')).toContain('body');
    }
  });

  test('schema fail returns ok:false + errors', async () => {
    const vault = seedVault();
    const r = await dispatchKnowledgeWrite({
      rel_path: 'Incidents/miss.md',
      body: 'body',
      kind: 'incident',
      frontmatter: { title: 'only' },    // missing severity/resolved
    }, { vault });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  test('kind auto-inject into frontmatter', async () => {
    const vault = seedVault();
    const r = await dispatchKnowledgeWrite({
      rel_path: 'Notes/k.md',
      body: 'body',
      kind: 'note',
      frontmatter: { title: 'a' },
    }, { vault });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(readFileSync(r.path, 'utf-8')).toContain('kind: note');
    }
  });

  test('dispatch catches path-escape as error (not throw)', async () => {
    const vault = seedVault();
    const r = await dispatchKnowledgeWrite({
      rel_path: '../escape.md',
      body: 'b',
    }, { vault });
    expect(r.ok).toBe(false);
  });
});
