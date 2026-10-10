import { expect, test } from 'bun:test';
import { isHarnessTempArtifact } from './orchestrator.js';

// 10-09: 범위 타입검사 임시 tsconfig 가 «추적 파일 삭제»로 잡혀 범위 카드가 irreversible 로 대표에게 갔다(D-20·35·43·80).
test('범위 타입검사 임시 tsconfig 는 하니스 임시물이다 — 루트·하위 폴더 둘 다', () => {
  expect(isHarnessTempArtifact('.elanous-typecheck-scope-3216a73f-1f61-43d1-adc2-ade3b7a37bb3.json')).toBe(true);
  expect(isHarnessTempArtifact('apps/pwa/.elanous-typecheck-scope-037b38e6-2349-4a1c-a52c-d956679a0214.json')).toBe(true);
});

test('일반 파일·비슷한 이름은 임시물이 아니다(범위 판정에 남는다)', () => {
  expect(isHarnessTempArtifact('src/cli/intake-cli.ts')).toBe(false);
  expect(isHarnessTempArtifact('tsconfig.json')).toBe(false);
  expect(isHarnessTempArtifact('docs/elanous-typecheck-scope-notes.md')).toBe(false);
  expect(isHarnessTempArtifact('.elanous-typecheck-scope-x.json.bak')).toBe(false);
});
