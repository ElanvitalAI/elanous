import { describe, expect, test } from 'bun:test';
import { buildInstalledSkillCatalogMessage } from './skill-catalog-preamble.js';
import { estimateTokens } from '../tokens.js';

describe('installed skill catalog system-prefix builder', () => {
  test('sorts stable name and description summaries and reuses unchanged content', () => {
    const input = [
      { name: 'omni-market', description: 'Compare market offerings.' },
      { name: 'omni-crawl', description: 'Gather context from the web.' },
      { name: 'kr-flow', description: 'Research Korean workflows.' },
    ];
    const first = buildInstalledSkillCatalogMessage(input, 128_000);
    const same = buildInstalledSkillCatalogMessage(input, 128_000);
    const content = first.message?.content ?? '';
    expect(first.mode).toBe('full');
    expect(content.indexOf('- kr-flow:')).toBeLessThan(content.indexOf('- omni-crawl:'));
    expect(content).toContain('- omni-market: Compare market offerings.');
    expect(same).toBe(first);
    const changed = buildInstalledSkillCatalogMessage([...input, { name: 'new-skill', description: 'Fresh entry.' }], 128_000);
    expect(changed).not.toBe(first);
    expect(changed.message?.content).toContain('- new-skill: Fresh entry.');
  });

  test('reduces descriptions before falling back to names and stays within two percent of context', () => {
    const input = [
      { name: 'omni-crawl', description: 'c'.repeat(4_000) },
      { name: 'kr-flow', description: 'k'.repeat(4_000) },
      { name: 'omni-market', description: 'm'.repeat(4_000) },
    ];
    const built = buildInstalledSkillCatalogMessage(input, 6_400);
    expect(built.mode).toBe('short-description');
    expect(built.estimatedTokens).toBeLessThanOrEqual(128);
    expect(estimateTokens(built.message?.content ?? '')).toBe(built.estimatedTokens);
  });

  test('truncates an oversized names-only catalog and reports the omitted count', () => {
    const input = Array.from({ length: 80 }, (_, index) => ({
      name: `installed-skill-${String(index).padStart(3, '0')}`,
      description: 'x'.repeat(2_000),
    }));
    const built = buildInstalledSkillCatalogMessage(input, 4_000);
    expect(built.mode).toBe('names-truncated');
    expect(built.estimatedTokens).toBeLessThanOrEqual(80);
    expect(built.message?.content).toContain('more omitted');
    expect(built.skillCount).toBeLessThan(input.length);
  });

  test('does not inject a block when no installed skills are available', () => {
    expect(buildInstalledSkillCatalogMessage([], 128_000)).toMatchObject({
      message: null,
      estimatedTokens: 0,
      mode: 'empty',
      skillCount: 0,
    });
  });
});
