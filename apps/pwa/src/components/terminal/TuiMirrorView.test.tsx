// ⭐P2 (capture substrate) — TuiMirrorView SSR smoke test. The PWA
// component-test harness is SSR-static (renderToStaticMarkup · effects do
// NOT run), so this covers the render surface (empty state · a11y labels),
// NOT the useEffect WS lifecycle. The connect/teardown wiring mirrors
// XtermView's proven pattern (unsubscribe→close, now try/finally-hardened);
// its pure halves (reducer · prune · stripAnsi) are unit-tested in
// tui-observe.test.ts.

import { describe, expect, test, mock } from 'bun:test';
import { restoreModuleMocksAfterAll } from '@/lib/testing/restore-module-mocks';
import { renderToStaticMarkup } from 'react-dom/server';

// Mock the DaemonProvider hook so the SSR pass doesn't reach a real client.
// Effects don't fire under SSR, so connectAcp is never called here.
// R-TST23 — 아래 mock.module 은 프로세스 전역이다. 원본을 잡아 두고 파일 끝에 되돌린다(`@/lib/testing/restore-module-mocks`).
await restoreModuleMocksAfterAll([
  '@/components/providers/DaemonProvider',
], (specifier) => import(specifier));

mock.module('@/components/providers/DaemonProvider', () => ({
  useDaemon: () => ({ client: {}, setSessionId: () => {} }),
}));

import { TuiMirrorView } from './TuiMirrorView';

describe('TuiMirrorView (SSR)', () => {
  test('renders the empty-state prompt + a11y labels without a live frame', () => {
    const html = renderToStaticMarkup(<TuiMirrorView sessionId="s1" />);
    expect(html).toContain('TUI 관측');
    expect(html).toContain('자기신고 화면 대기 중');
    // Empty state guidance (no frames yet).
    expect(html).toContain('대시보드(elanous)를 실행하면');
    // Accessibility — the live-frame region is labelled.
    expect(html).toContain('선택한 TUI 화면의 라이브 렌더 프레임');
  });
});
