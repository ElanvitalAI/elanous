import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// TUI-INPUT-PLACEHOLDER-OFF (대표 «불필요한 가이드 없애라») — provider 가 있으면 빈 입력창에 고정 안내 문구가 없다.
// provider 가 없을 때의 setup 안내는 남긴다.
const dashboard = readFileSync(new URL('../src/dashboard/index.ts', import.meta.url), 'utf8');

test('chat composer placeholder is empty when a provider is available', () => {
  const m = dashboard.match(/placeholder: anyProviderAvailable\(\)\s*\?\s*('[^']*')\s*:\s*('[^']*')/);
  expect(m).not.toBeNull();
  expect(m![1]).toBe("''");
  expect(m![2]).toContain('no LLM provider available');
  expect(dashboard).not.toContain('말 한 줄로 시작 — 질문하거나');
});
