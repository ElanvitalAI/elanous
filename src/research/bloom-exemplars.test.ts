import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BLOOM_2D_SCOPED } from '../knowledge/kgs/types.js';
import {
  BLOOM_EXEMPLAR_DOMAINS,
  getBloomExemplarContext,
  inferBloomExemplarDomain,
  validateBloomExemplarPack,
} from './bloom-exemplars.js';

function fullPack() {
  const exemplars = BLOOM_EXEMPLAR_DOMAINS.flatMap((domain) => [1, 2, 3, 4, 5, 6].flatMap((level) => {
    const cognitive = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'][level - 1];
    const bloom = BLOOM_2D_SCOPED.find(cell => cell.cognitive === cognitive)!;
    return Array.from({ length: 5 }, (_, index) => ({
      domain, level, bloom,
      question: `Fixture ${domain} level ${level} example ${index + 1}?`,
    }));
  }));
  return { version: 1, exemplars };
}

test('uses the existing Bloom2D taxonomy and selects finance level 4/5 exemplars for bond-rate research', () => {
  expect(inferBloomExemplarDomain('채권 금리가 오르는 원인을 분석해줘')).toBe('finance');
  const fallback = getBloomExemplarContext('채권 금리가 오르는 원인을 분석해줘', '/missing/bloom-exemplars.json');
  expect(fallback).toMatchObject({ source: 'public-fallback', count: 2, levels: [4, 5] });
  expect(fallback.context).toContain('L4 analyze/conceptual');
  expect(fallback.context).toContain('L5 evaluate/metacognitive');
});

test('selects two public technology L4/L5 exemplars for the AI data-center demo question', () => {
  const result = getBloomExemplarContext(
    '2030년 AI 데이터센터 전력수요는 낮음·기준·높음 시나리오에서 각각 얼마나 늘어날까?',
    '/missing/bloom-exemplars.json',
  );

  expect(result).toMatchObject({
    domain: 'technology', domainSignal: 'matched', source: 'public-fallback', count: 2, levels: [4, 5],
  });
  expect(result.context).toContain('L4 analyze/conceptual');
  expect(result.context).toContain('L5 evaluate/metacognitive');
  expect(result.context).toContain('추론 처리량');
  expect(result.context).toContain('전력수요 전망을 반박');
});

test('accepts only the complete 7×6×5 premium bank and selects three examples at both requested stages', () => {
  const pack = fullPack();
  expect(pack.exemplars).toHaveLength(210);
  expect(validateBloomExemplarPack(pack)).toBe(true);
  expect(validateBloomExemplarPack({ ...pack, exemplars: pack.exemplars.slice(0, 209) })).toBe(false);

  const dir = mkdtempSync(join(tmpdir(), 'bloom-exemplars-'));
  const path = join(dir, 'pack.json');
  try {
    writeFileSync(path, JSON.stringify(pack));
    const result = getBloomExemplarContext('bond yields', path);
    expect(result).toMatchObject({ source: 'pro-pack', domain: 'finance', count: 6, levels: [4, 5] });
    expect(result.context.match(/^L4 /gm)).toHaveLength(3);
    expect(result.context.match(/^L5 /gm)).toHaveLength(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid external packs safely fall back without carrying arbitrary pack content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bloom-exemplars-invalid-'));
  const path = join(dir, 'pack.json');
  try {
    writeFileSync(path, JSON.stringify({ version: 1, exemplars: [{ domain: 'finance', level: 4, bloom: {}, question: 'untrusted' }] }));
    const result = getBloomExemplarContext('bond yields', path);
    expect(result.source).toBe('public-fallback');
    expect(result.context).not.toContain('untrusted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
