// 정적 export 의 prerender 조건(데몬 연결 없음 → NexusClientProvider 가 QueryClientProvider 를
// 안 깐다)에서 AppShell 부품이 던지면 PWA 빌드 전체가 깨진다(2026-09-27 · #20786 뒤 «No QueryClient set»).
// 단위 시험은 그것을 못 잡고 `nexus build` 에서만 드러났다 — 같은 조건을 여기서 재현한다.
import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SetupModeBanner } from './SetupModeBanner';

test('SetupModeBanner 는 제공자 없이(prerender 조건) 그려도 던지지 않는다', () => {
  expect(() => renderToStaticMarkup(createElement(SetupModeBanner))).not.toThrow();
});
