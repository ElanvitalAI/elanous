// kit/loop-shell step 1 (DUPLICATION-MAP §1-1): one role LLM through streamLLM · one lessons format in the shared home.
import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileMemory } from '../judge-butler/memory.js';
import { fileAgentMemory, maintainLessons } from './memory.js';
import { roleLlm, type RoleLlmDeps } from './role-llm.js';

describe('role-llm', () => {
  test('one call through stream with provider · model · usage role · site; null when the role has no LLM', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const deps: RoleLlmDeps = {
      resolve: (role) => (role === 'coordinator' ? { provider: 'codex', model: 'gpt-x' } : null),
      provider: (name, model) => ({ name, model }),
      stream: async (messages, opts) => { calls.push({ messages, ...opts }); return '{"reply":"ok"}'; },
    };
    // 출처: #40402 — maxTokens 300 is a fixture value passed through and read back (not a bound)
    const llm = roleLlm('coordinator', { site: 'loop-agent:judge-butler', maxTokens: 300 }, deps)!;
    expect(await llm.complete('S', 'U')).toEqual({ text: '{"reply":"ok"}', model: 'codex/gpt-x' });
    expect(calls).toHaveLength(1);
    // 출처: #40402 — the same fixture value read back
    expect(calls[0]).toMatchObject({ model: 'gpt-x', maxTokens: 300, usageRole: 'coordinator', usageSite: 'loop-agent:judge-butler', provider: { name: 'codex', model: 'gpt-x' } });
    expect((calls[0]!.messages as Array<{ role: string }>).map(m => m.role)).toEqual(['system', 'user']);
    expect(roleLlm('review', { site: 'x' }, deps)).toBeNull();
    expect(roleLlm('coordinator', { site: 'x' }, { ...deps, provider: () => null })).toBeNull();
  });
});

describe('one lessons format', () => {
  test('a butler lesson is a shell row; the shell reads it, its decay rewrite keeps the cell; a legacy row still reads', () => {
    const root = mkdtempSync(join(tmpdir(), 'kit-lessons-'));
    const butler = fileMemory(root);
    const home = join(root, 'loop-agents', 'judge-butler');
    mkdirSync(home, { recursive: true });
    appendFileSync(join(home, 'lessons.jsonl'), `${JSON.stringify({ at: '2026-11-26T00:00:00Z', cell: 'OLD-1', text: 'legacy row', from: 'JUD' })}\n`);
    butler.appendLesson({ at: '2026-11-27T00:00:00Z', cell: 'MODEL-BY-DIFFICULTY-E4', text: 'CLI reverted after sign — veto', from: 'CLI' });
    const raw = readFileSync(join(home, 'lessons.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
    expect(raw[1]).toMatchObject({ id: 'L-1', pattern: 'cell:MODEL-BY-DIFFICULTY-E4', cell: 'MODEL-BY-DIFFICULTY-E4', status: 'active', from: 'CLI' });
    const shell = fileAgentMemory(root, 'judge-butler', 'JUD');
    expect(shell.lessons().map(l => [l.pattern, l.status])).toEqual([['OLD-1', 'active'], ['cell:MODEL-BY-DIFFICULTY-E4', 'active']]);
    maintainLessons(shell, new Date('2026-11-27T01:00:00Z'));
    shell.writeLessons(shell.lessons()); // the shell rewrites the file in its own row shape
    expect(butler.lessons().map(l => [l.cell, l.text])).toEqual([['OLD-1', 'legacy row'], ['MODEL-BY-DIFFICULTY-E4', 'CLI reverted after sign — veto']]);
    // a lesson the shell decays is no longer a butler lesson
    const rows = shell.lessons(); rows[0]!.status = 'decayed'; shell.writeLessons(rows);
    expect(butler.lessons().map(l => l.cell)).toEqual(['MODEL-BY-DIFFICULTY-E4']);
  });
});
