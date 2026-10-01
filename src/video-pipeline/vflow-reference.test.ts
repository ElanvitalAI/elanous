import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchVflowReferences } from './vflow-reference.js';

it('읽을 수 없는 DB 는 검색 결과 0건이 아니라 unavailable 이유를 반환한다', () => {
  const result = searchVflowReferences(join(tmpdir(), 'missing-vflow-references.ndjson'), { camera: 'tracking' });
  expect(result.available).toBe(false);
  if (!result.available) expect(result.reason).toContain('ENOENT');
});

it('spec 의 카메라·조명·무드·길이로 검색하고 옛 줄은 필터 없을 때 보존한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vflow-ref-'));
  const file = join(dir, 'prompts.ndjson');
  const base = { url: 'https://example.test/p', model: 'seedance-2-0', category: 'camera', name: 'Tracking', description: '', prompt: 'Tracking shot', keywords: ['tracking'], author: 'Aster', authorUrl: 'https://example.test/aster' };
  try {
    writeFileSync(file, [
      { ...base, spec: { camera: ['Slow Tracking'], lighting: ['Golden Hour'], mood: ['Cinematic'], duration: '6s' }, video: { url: 'https://example.test/v.mp4' } },
      { ...base, url: 'https://example.test/orbit', spec: { camera: ['orbit'], lighting: ['neon'], mood: ['tense'], duration: '12s' } },
      base,
      { ...base, url: 'https://example.test/null-spec', spec: null, video: null },
      '{broken',
    ].map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n'));
    const all = searchVflowReferences(file, { limit: 10 });
    expect(all.available && [all.rows.length, all.read, all.skipped]).toEqual([4, 5, 1]);
    const filtered = searchVflowReferences(file, { camera: 'TRACKING', lighting: 'golden', mood: 'cinema', maxSeconds: 6, model: 'SEE', limit: 3 });
    expect(filtered.available && filtered.rows.map((row) => [row.url, row.video?.url, row.spec?.camera])).toEqual([
      ['https://example.test/p', 'https://example.test/v.mp4', ['Slow Tracking']],
    ]);
    const tooShort = searchVflowReferences(file, { maxSeconds: 5 });
    expect(tooShort.available && tooShort.rows).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('원천이 «모르는 칸»을 null 로 낸 줄(spec.duration·video.isoDuration 등)을 버리지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vflow-ref-null-'));
  const file = join(dir, 'prompts.ndjson');
  // 10-01 실물 모양: duration·isoDuration·difficulty 가 null 인 줄이 전체의 절반을 넘는다
  const row = { url: 'https://example.test/n', model: 'grok-imagine', category: 'x', name: 'N', description: '', prompt: 'static shot', keywords: [], author: null, authorUrl: null,
    spec: { duration: null, camera: ['static/fixed'], lighting: [], mood: ['hopeful'], difficulty: null, promptLanguage: 'EN', includes: null },
    video: { url: 'https://example.test/n.mp4', isoDuration: null, resolution: null, aspect: null } };
  try {
    writeFileSync(file, JSON.stringify(row));
    const result = searchVflowReferences(file, { camera: 'static' });
    expect(result.available && [result.read, result.skipped, result.rows.length]).toEqual([1, 0, 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
