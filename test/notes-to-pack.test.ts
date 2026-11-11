import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateKnowledgePack } from '../src/knowledge/write.js';
import { notesToPack } from '../src/knowledge/notes-to-pack.js';

const notes = [
  { id: 'rates', speaker: 'macro analyst', observedAt: '2026-11-12T00:00:00Z', claim: '금리 상승은 장기채 가격에 부담', premise: '정책금리가 유지된다', falsifier: '금리 인하가 시작된다', asset: '장기채', horizon: '6개월', source: { url: 'https://example.org/rates', capturedAt: '2026-11-11T00:00:00Z' } },
  { id: 'chips', speaker: 'semiconductor analyst', observedAt: '2026-11-12T00:01:00Z', claim: 'AI 칩 수요가 증가한다', premise: '데이터센터 투자가 유지된다', falsifier: '설비투자가 감소한다', asset: '반도체', horizon: '12개월', source: { url: 'https://example.org/chips', capturedAt: '2026-11-11T00:01:00Z' } },
  { id: 'power', speaker: 'energy analyst', observedAt: '2026-11-12T00:02:00Z', claim: '전력망 병목이 확대된다', premise: '접속 대기열이 늘어난다', falsifier: '접속 대기열이 줄어든다', asset: '전력망', horizon: '1년' },
] as const;

test('three fixed expert notes yield traceable KPACK1 claim and Bloom 4/5 cards', () => {
  const result = notesToPack(notes, { name: 'expert-view-sim', version: '1.0.0' });
  expect(result.manifest.content).toHaveLength(9);
  expect(result.claimCards).toHaveLength(3);
  expect(result.questionCards).toHaveLength(6);
  expect(result.claimCards[2]?.evidence).toBe('근거 없음');
  expect(result.questionCards.map(card => card.level)).toEqual([4, 5, 4, 5, 4, 5]);
  for (const claim of result.claimCards) {
    expect(claim.claim).toBeTruthy();
    expect(claim.premise).toBeTruthy();
    expect(claim.falsifier).toBeTruthy();
    expect(claim.asset).toBeTruthy();
    expect(claim.horizon).toBeTruthy();
  }
  const root = mkdtempSync(join(tmpdir(), 'notes-to-pack-'));
  try {
    mkdirSync(join(root, 'content'));
    for (const [path, value] of Object.entries(result.files)) writeFileSync(join(root, path), JSON.stringify(value));
    expect(validateKnowledgePack(root).pack.cards).toHaveLength(9);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('duplicate note IDs and empty claims fail closed', () => {
  expect(() => notesToPack([notes[0], notes[0]], { name: 'expert-view-sim', version: '1.0.0' })).toThrow(/duplicate/);
  expect(() => notesToPack([{ ...notes[0], claim: '' }], { name: 'expert-view-sim', version: '1.0.0' })).toThrow(/claim/);
});

test('source URLs require a valid HTTPS host', () => {
  for (const url of ['https://', 'https:///path', 'https://\\example.org', 'https://.', 'https://%2e', 'https://foo..bar', 'https://-bad.example', 'https://@example.org', 'https://bad host/path', 'https://example.org:bad/path', 'http://example.org/path']) {
    expect(() => notesToPack([{ ...notes[0], source: { url, capturedAt: notes[0].source.capturedAt } }],
      { name: 'expert-view-sim', version: '1.0.0' })).toThrow(/invalid source/);
  }
  expect(() => notesToPack([{ ...notes[0], source: { url: 'https://[::1]/note', capturedAt: notes[0].source.capturedAt } }],
    { name: 'expert-view-sim', version: '1.0.0' })).not.toThrow();
});
