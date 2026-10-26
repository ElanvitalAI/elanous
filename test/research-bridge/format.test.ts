// PLAN §4.4 · Phase 1.4 — formatResearchPrefill / Summary tests.

import { describe, expect, test } from 'bun:test';
import {
  formatResearchPrefill, formatResearchSummary,
  type ExternalResearchResult,
} from '../../src/research-bridge/index.js';

function makeResult(over: Partial<ExternalResearchResult> = {}): ExternalResearchResult {
  return {
    topic: 'cursor pause patterns',
    skill: 'omni-crawl',
    startedAt: '2026-04-25T13:00:00.000Z',
    finishedAt: '2026-04-25T13:00:01.234Z',
    durationMs: 1234,
    ok: true,
    output: '## findings\n\n- pause is implicit\n- resume re-streams',
    ...over,
  };
}

describe('formatResearchSummary', () => {
  test('ok result starts with ✓', () => {
    expect(formatResearchSummary(makeResult())).toMatch(/^✓ /);
  });

  test('failed result starts with ⚠', () => {
    expect(formatResearchSummary(makeResult({ ok: false }))).toMatch(/^⚠ /);
  });

  test('summary includes seconds, char count, skill, topic', () => {
    const s = formatResearchSummary(makeResult());
    expect(s).toContain('omni-crawl');
    expect(s).toContain('cursor pause patterns');
    expect(s).toContain('1.2s');
    expect(s).toMatch(/\d+ chars/);
  });

  test('error message is appended on failure', () => {
    const s = formatResearchSummary(makeResult({ ok: false, error: 'API rate limited' }));
    expect(s).toContain('API rate limited');
  });
});

describe('formatResearchPrefill', () => {
  test('wraps output in <external-research> block', () => {
    const seed = formatResearchPrefill(makeResult());
    expect(seed).toContain('<external-research>');
    expect(seed).toContain('</external-research>');
    expect(seed).toContain('<topic>cursor pause patterns</topic>');
    expect(seed).toContain('<skill>omni-crawl</skill>');
    expect(seed).toContain('<duration_ms>1234</duration_ms>');
    expect(seed).toContain('<ok>true</ok>');
  });

  test('keeps the pre-router call path free of routing metadata', () => {
    const seed = formatResearchPrefill(makeResult());
    expect(seed).not.toContain('<output_format>');
    expect(seed).not.toContain('<question_weight');
    expect(seed).not.toContain('<output_route_observation>');
    expect(seed).toContain('<topic>cursor pause patterns</topic>');
    expect(seed).toContain('pause is implicit');
  });

  test('includes the full output verbatim when under cap', () => {
    const seed = formatResearchPrefill(makeResult());
    expect(seed).toContain('pause is implicit');
    expect(seed).toContain('resume re-streams');
  });

  test('caps output at ~6 KiB and notes truncation', () => {
    const long = 'b'.repeat(10 * 1024);
    const seed = formatResearchPrefill(makeResult({ output: long }));
    expect(seed).toContain('truncated');
    expect(seed.length).toBeLessThan(8 * 1024);
  });

  test('ends with a continuation prompt', () => {
    const seed = formatResearchPrefill(makeResult());
    expect(seed).toMatch(/Continue with: $/);
  });
});
