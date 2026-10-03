// 2026-05-07 dogfood feedback — SessionPill 의 ID 분리 + Copy 기능
// 테스트. 컴포넌트 자체는 React DOM + DaemonProvider 의존이 있어 PWA
// bun test 환경에서 직접 render 하기 어렵지만, 두 핵심 helper
// (`shortSessionId` · `copyToClipboard`) 는 pure 함수로 단위 검증
// 가능. 사용자가 ID 식별 / 복사 둘 다 안 됐다는 회귀가 다시 들어오지
// 않게 lock.

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { _resetSessionsServiceSingletonForTest } from '@/lib/sessions-service';
import { SessionDeleteConfirm } from './SessionDeleteConfirm';
import { SessionIdChip } from './SessionIdChip';
import { SessionPicker } from './SessionPicker';
import { SessionPill, copyToClipboard, shortSessionId, type SessionPillProps } from './SessionPill';

describe('shortSessionId — pill display 의 short ID + 단축 cue', () => {
  it('full UUID 의 첫 8자 + ellipsis 반환 (단축 visual cue)', () => {
    expect(shortSessionId('8a7c3f2b-9d4e-4f1a-b2c3-1234567890ab'))
      .toBe('8a7c3f2b…');
  });

  it('정확히 8자 ID 는 ellipsis 없이 그대로 (전체 = 표시값)', () => {
    expect(shortSessionId('abcd1234')).toBe('abcd1234');
  });

  it('8자 미만 짧은 ID 그대로 반환', () => {
    expect(shortSessionId('abc')).toBe('abc');
    expect(shortSessionId('s-1')).toBe('s-1');
  });

  it('9자 이상 ID 는 8자 + ellipsis (단축 표시 명시)', () => {
    expect(shortSessionId('abcdefghi')).toBe('abcdefgh…');
    expect(shortSessionId('s-1a2b3c4d-fallback'))
      .toBe('s-1a2b3c…');
  });

  it('null / undefined / empty 시 placeholder "—" 반환', () => {
    expect(shortSessionId(null)).toBe('—');
    expect(shortSessionId(undefined)).toBe('—');
    expect(shortSessionId('')).toBe('—');
  });
});

describe('copyToClipboard — clipboard API wrapper', () => {
  let originalNavigator: unknown;

  beforeEach(() => {
    originalNavigator = (globalThis as { navigator?: unknown }).navigator;
  });

  afterEach(() => {
    (globalThis as { navigator?: unknown }).navigator = originalNavigator;
  });

  it('빈 value 는 false 반환 (no-op · 호출 안 됨)', async () => {
    let called = false;
    (globalThis as unknown as { navigator: unknown }).navigator = {
      clipboard: { writeText: async () => { called = true; } },
    };
    expect(await copyToClipboard('')).toBe(false);
    expect(called).toBe(false);
  });

  it('clipboard API 미지원 (navigator.clipboard undefined) 시 false', async () => {
    (globalThis as unknown as { navigator: unknown }).navigator = {};
    expect(await copyToClipboard('abc')).toBe(false);
  });

  it('clipboard.writeText resolve 시 true + 정확한 value 전달', async () => {
    const written: string[] = [];
    (globalThis as unknown as { navigator: unknown }).navigator = {
      clipboard: {
        writeText: async (s: string) => { written.push(s); },
      },
    };
    expect(await copyToClipboard('sess-xyz')).toBe(true);
    expect(written).toEqual(['sess-xyz']);
  });

  it('clipboard.writeText reject 시 false (silent · throw 안 함)', async () => {
    (globalThis as unknown as { navigator: unknown }).navigator = {
      clipboard: {
        writeText: async () => { throw new Error('insecure context'); },
      },
    };
    expect(await copyToClipboard('sess-xyz')).toBe(false);
  });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const currentId = '8a7c3f2b-9d4e-4f1a-b2c3-1234567890ab';
const currentSession = {
  id: currentId,
  msgCount: 2,
  lastMsgPreview: '오늘의 이야기',
  lastTurnAt: new Date().toISOString(),
  origin: 'pwa' as const,
};

function renderedText(tree: ReactTestRenderer): string {
  return JSON.stringify(tree.toJSON());
}

describe('대화 화면 문면과 기존 동작', () => {
  let tree: ReactTestRenderer | undefined;
  let selected: string[];
  let requests: number;
  let forgotten: string[];
  const client = {
    fetchJson: async () => {
      requests += 1;
      return { sessions: [currentSession] };
    },
    sessionStoreEventsUrl: () => '',
  };
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const documentStub = new EventTarget();
  const daemon = {
    client: client as never,
    config: { baseUrl: '', token: '', provider: '' },
    sessionId: currentId,
    setSessionId: (id: string) => selected.push(id),
    setConfig: () => {},
  };

  beforeEach(() => {
    selected = [];
    forgotten = [];
    requests = 0;
    Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { setItem: () => {}, getItem: () => null } });
  });
  afterEach(async () => {
    if (tree) await act(async () => tree!.unmount());
    tree = undefined;
    _resetSessionsServiceSingletonForTest();
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete (globalThis as { document?: Document }).document;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete (globalThis as { window?: Window }).window;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('pill 메뉴의 새 대화·전환·지우기 문면은 대화 용어이고 콜백과 ID는 유지된다', async () => {
    await act(async () => { tree = create(
      createElement(DaemonContext.Provider, { value: daemon },
        createElement<SessionPillProps>(SessionPill, { onAttachRequest: () => { forgotten.push('attach'); }, onForgetRequest: () => { forgotten.push('forget'); } })),
    ); });
    const buttons = () => tree!.root.findAllByType('button');
    expect(buttons().find((b) => b.props['aria-label'] === '대화 메뉴')).toBeDefined();
    await act(async () => buttons().find((b) => b.props['aria-label'] === '대화 메뉴')!.props.onClick());
    expect(renderedText(tree!)).toContain('다른 대화로 전환');
    expect(renderedText(tree!)).toContain('이 대화 지우기');
    expect(renderedText(tree!)).toContain('대화 ID');
    expect(renderedText(tree!)).toContain('새 대화 시작 (두 번 클릭)');
    expect(renderedText(tree!)).not.toContain('세션');
    await act(async () => buttons().find((b) => b.children.includes('다른 대화로 전환'))!.props.onClick());
    expect(forgotten).toEqual(['attach']);
    await act(async () => buttons().find((b) => b.props['aria-label'] === '대화 메뉴')!.props.onClick());
    await act(async () => buttons().find((b) => b.children.includes('이 대화 지우기'))!.props.onClick());
    expect(forgotten).toEqual(['attach', 'forget']);
    await act(async () => buttons().find((b) => b.props['aria-label'] === '대화 메뉴')!.props.onClick());
    await act(async () => buttons().find((b) => b.findAllByType('span').some((s) => s.children.includes('새 대화 시작')))!.props.onClick());
    expect(selected).toHaveLength(1);
    expect(selected[0]).not.toBe(currentId);
  });

  it('picker의 새 대화·기존 대화 전환·지우기 버튼과 빈 상태 문면', async () => {
    const picked: unknown[] = [];
    await act(async () => { tree = create(
      createElement(DaemonContext.Provider, { value: daemon },
        createElement(SessionPicker, { open: true, onClose: () => {}, onPick: (pick) => { picked.push(pick); }, attachedSessions: new Map() })),
    ); });
    expect(requests).toBeGreaterThan(0);
    expect(renderedText(tree!)).toContain('새 대화 시작');
    expect(renderedText(tree!)).not.toContain('세션');
    const buttons = () => tree!.root.findAllByType('button');
    await act(async () => buttons().find((b) => b.findAllByType('div').some((d) => d.children.includes('새 대화 시작')))!.props.onClick());
    expect(picked).toMatchObject([{ kind: 'new', sessionId: expect.any(String) }]);
    await act(async () => buttons().find((b) => b.props.className?.includes('flex min-w-0 flex-1 flex-col'))!.props.onClick());
    expect(picked[1]).toEqual({ kind: 'existing', sessionId: currentId });
    await act(async () => buttons().find((b) => b.props['aria-label'] === `대화 ${currentId} 지우기`)!.props.onClick({ stopPropagation: () => {} }));
    expect(renderedText(tree!)).toContain('대화 지우기');
    expect(renderedText(tree!)).not.toContain('세션');
  });

  it('ID 칩과 삭제 확인창은 대화로 안내하고 동일 ID·확인 콜백을 유지한다', async () => {
    let confirms = 0;
    await act(async () => { tree = create(createElement('div', null,
      createElement(SessionIdChip, { sessionId: currentId }),
      createElement(SessionDeleteConfirm, { open: true, session: currentSession, onCancel: () => {}, onConfirm: () => { confirms++; } }),
    )); });
    expect(tree!.root.findByProps({ 'data-elanous-session-id': currentId }).props['aria-label']).toBe(`대화 ID ${currentId} 복사`);
    expect(renderedText(tree!)).toContain('대화 지우기');
    expect(renderedText(tree!)).not.toContain('세션');
    await act(async () => tree!.root.findAllByType('button').find((b) => b.children.includes('지우기'))!.props.onClick());
    expect(confirms).toBe(1);
  });
});
