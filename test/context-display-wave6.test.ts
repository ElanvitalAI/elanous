// ── Wave 6 · /usage · /cost · /memory list ──

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCostSlashCommand,
  buildMemorySlashCommand,
  buildUsageSlashCommand,
  clearTelemetryForTest,
  formatCostSummary,
  formatUsageSummary,
  listMemory,
  recordLlmCall,
  showMemory,
} from '../src/context-display';

afterEach(() => clearTelemetryForTest());

describe('Wave 6 · /usage', () => {
  test('descriptor name + aliases', () => {
    const cmd = buildUsageSlashCommand();
    expect(cmd.name).toBe('usage');
    expect(cmd.aliases).toContain('stats');
  });

  test('renders empty placeholder', () => {
    const cmd = buildUsageSlashCommand();
    expect(cmd.render()).toContain('no LLM calls captured');
  });

  test('renders per-provider + per-model + per-role rows', () => {
    recordLlmCall({
      ts: 1, provider: 'anthropic', model: 'claude-opus-4-7', role: 'main',
      inputTokens: 1000, outputTokens: 200,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    });
    recordLlmCall({
      ts: 2, provider: 'anthropic', model: 'claude-haiku-4-5', role: 'summarizer',
      inputTokens: 5000, outputTokens: 800,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    });
    recordLlmCall({
      ts: 3, provider: 'openai', model: 'gpt-4o', role: 'main',
      inputTokens: 300, outputTokens: 50,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    });
    const cmd = buildUsageSlashCommand();
    const out = cmd.render();
    expect(out).toContain('Per provider');
    expect(out).toContain('anthropic');
    expect(out).toContain('openai');
    expect(out).toContain('Per model');
    expect(out).toContain('claude-opus-4-7');
    expect(out).toContain('Per role');
    expect(out).toContain('summarizer');
  });

  test('formatUsageSummary callable directly', () => {
    const out = formatUsageSummary({
      callCount: 1, totalInput: 100, totalOutput: 50,
      totalCacheRead: 0, totalCacheCreate: 0, totalReasoning: 0,
      perProvider: { anthropic: { callCount: 1, totalInput: 100, totalOutput: 50 } },
      perModel: { 'claude-opus-4-7': { callCount: 1, totalInput: 100, totalOutput: 50 } },
      perRole: { main: { callCount: 1, totalInput: 100, totalOutput: 50 } },
    });
    expect(out).toContain('Total: 1 call');
  });
});

describe('Wave 6 · /cost', () => {
  test('descriptor name + aliases', () => {
    const cmd = buildCostSlashCommand();
    expect(cmd.name).toBe('cost');
    expect(cmd.aliases).toContain('budget');
  });

  test('formatCostSummary renders total + per-model rows', () => {
    const out = formatCostSummary(
      {
        totalUsd: 12.34, weeklyUsd: 5.0, monthlyUsd: 12.34,
        perModel: {
          'claude-opus-4-7': { tokens: 100_000, usd: 10.0, count: 5 },
          'gpt-4o-mini': { tokens: 50_000, usd: 2.34, count: 8 },
        },
        perGoal: {},
        weekStart: 0, monthStart: 0, eventsCount: 13, snapshotAt: 1,
      },
      { weeklyCapUsd: 50, monthlyCapUsd: 100 },
    );
    expect(out).toContain('Total spend');
    expect(out).toContain('$12.34');
    expect(out).toContain('claude-opus-4-7');
    expect(out).toContain('gpt-4o-mini');
    expect(out).toContain('cap $50.00');
  });

  test('handles empty per-model gracefully', () => {
    const out = formatCostSummary(
      {
        totalUsd: 0, weeklyUsd: 0, monthlyUsd: 0,
        perModel: {}, perGoal: {},
        weekStart: 0, monthStart: 0, eventsCount: 0, snapshotAt: 1,
      },
      {},
    );
    expect(out).toContain('Total spend:   $0.0000');
    expect(out).not.toContain('Per model');
  });
});

describe('Wave 6 · /memory list', () => {
  test('descriptor name + aliases', () => {
    const cmd = buildMemorySlashCommand();
    expect(cmd.name).toBe('memory');
    expect(cmd.aliases).toContain('mem');
  });

  test('list returns placeholder when dir missing', () => {
    const out = listMemory('/nonexistent/path/xyz');
    expect(out).toContain('no memory folder yet');
  });

  test('list enumerates .md files (skip MEMORY.md index)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memlist-'));
    writeFileSync(join(dir, 'MEMORY.md'), '# index — should be skipped\n');
    writeFileSync(join(dir, 'project_alpha.md'), '---\nname: alpha\ndescription: alpha entry\ntype: project\n---\n\nbody');
    writeFileSync(join(dir, 'feedback_beta.md'), '---\nname: beta\ndescription: beta entry\ntype: feedback\n---\n\nbody');
    const out = listMemory(dir);
    expect(out).toContain('project_alpha');
    expect(out).toContain('feedback_beta');
    expect(out).toContain('alpha entry');
    // MEMORY.md is the index, not enumerated
    expect(out.split('\n').filter(l => l.includes('MEMORY ')).length).toBe(0);
  });

  test('show returns content of named entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memshow-'));
    writeFileSync(join(dir, 'topic.md'), 'this is the topic body');
    expect(showMemory(dir, 'topic')).toContain('this is the topic body');
    expect(showMemory(dir, 'topic.md')).toContain('this is the topic body');
    expect(showMemory(dir, 'missing')).toContain('no entry');
  });

  test('render dispatches subcommands', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memdisp-'));
    writeFileSync(join(dir, 'a.md'), 'A');
    const cmd = buildMemorySlashCommand();
    expect(cmd.render({ sub: 'list', memoryDir: dir })).toContain('Entries:');
    expect(cmd.render({ sub: 'show', arg: 'a', memoryDir: dir })).toContain('A');
    expect(cmd.render({ sub: 'reload', memoryDir: dir })).toContain('reload');
    expect(cmd.render({ sub: 'bogus', memoryDir: dir })).toContain('unknown');
  });
});
