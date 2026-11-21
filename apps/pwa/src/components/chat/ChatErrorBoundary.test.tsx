import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import TestRenderer, { type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { ChatErrorBoundary, reconnectRejectedDevice } from './ChatErrorBoundary';

// 출처: #39459 WEBCHAT-REJECTED-TOKEN-NO-CRASH — 거부·만료 토큰으로 /app/chat 를 열면
// 챗 런타임의 잡히지 않은 render throw 가 Next.js 기본 «Application error» 페이지로
// 전체 PWA 를 죽였다(2026-11-21 g8 실화면 · evidence/20261121/testverse-g8-live/
// 15-crash-pinpoint.md). 바운더리 계약: 그 throw 를 라우트 안에서 잡아 «다시 연결»
// 안내(연결 화면 복귀)로 바꾼다 — 앱 사망 0. 이 앱에는 /login 라우트가 없다
// (basePath /app 정적 export — JUD-B #122871 재검토). (pwa 표준 하네스 =
// react-test-renderer, DOM 없음)

type JSONChild = { children: JSONChild[] | null } | string | number;

function collectText(node: JSONChild | JSONChild[] | null | undefined, out: string[]): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return;
  }
  collectText(node.children ?? [], out);
}

function textOf(renderer: ReactTestRenderer): string {
  const out: string[] = [];
  collectText(renderer.toJSON() as JSONChild | JSONChild[] | null, out);
  return out.join(' ');
}

// 버튼 자송 문자열 — «다시 시도»/«다시 연결» 두 버튼이 나란히 있어 라벨로 구분한다.
function instanceText(instance: ReactTestInstance): string {
  const out: string[] = [];
  const walk = (node: ReactTestInstance): void => {
    for (const child of node.children ?? []) {
      if (typeof child === 'string') out.push(child);
      else walk(child);
    }
  };
  walk(instance);
  return out.join('');
}

function findButton(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const hit = renderer.root
    .findAllByProps({ type: 'button' })
    .find((button) => instanceText(button).includes(label));
  if (!hit) throw new Error(`button not found: ${label}`);
  return hit;
}

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const originalActEnv = actEnv.IS_REACT_ACT_ENVIRONMENT;

beforeEach(() => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = originalActEnv;
});

function Boom(): never {
  throw new Error('simulated rejected-token render error');
}

test('챗 트리 render throw → 전체 크래시 대신 «다시 연결» 안내 폴백', () => {
  // create 는 act 안에서만 commit — 동시성 루트라 비-act create 는 렌더가 유예된다.
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(ChatErrorBoundary, null, createElement(Boom)));
  });
  expect(textOf(renderer)).toContain('대화를 열지 못했습니다');
  expect(textOf(renderer)).toContain('다시 연결');
  // JUD #123140 보안 HOLD — 예외 message 는 화면에 나오지 않는다(고정 안내 문구만).
  expect(textOf(renderer)).not.toContain('simulated rejected-token render error');
  act(() => {
    renderer.unmount();
  });
});

test('JUD #123140 보안 HOLD 회귀 — 화면·콘솔 어디에도 예외 내용을 흘리지 않는다', () => {
  // 출처: #39459 — 예외 message 에는 요청 URL·토큰 등이 실릴 수 있다. sentinel 로
  // 화면 렌더와 console.error 인자 둘 다에 예외 내용이 없음을 잰다.
  const secret = 'TOPSECRET-token-fragment-9931';
  function Leaky(): never {
    throw new Error(`GET https://host/v1/x failed: ${secret}`);
  }
  const errSpy = mock((..._args: unknown[]) => {});
  const original = console.error;
  console.error = errSpy as unknown as typeof console.error;
  try {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(ChatErrorBoundary, null, createElement(Leaky)));
    });
    const page = textOf(renderer);
    expect(page).toContain('대화를 열지 못했습니다');
    expect(page).not.toContain(secret);
    const logged = JSON.stringify(errSpy.mock.calls ?? []);
    expect(logged).not.toContain(secret);
    act(() => {
      renderer.unmount();
    });
  } finally {
    console.error = original;
  }
});

test('«다시 시도» → 트리 재마운트, 회복 트리는 본래 화면', async () => {
  let fail = true;
  function Flaky(): ReactElement {
    if (fail) throw new Error('flaky first mount');
    return createElement('p', null, '정상 렌더');
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(ChatErrorBoundary, null, createElement(Flaky)));
  });
  expect(textOf(renderer)).toContain('다시 연결');
  fail = false;
  await act(async () => {
    (findButton(renderer, '다시 시도').props as { onClick: () => void }).onClick();
  });
  expect(textOf(renderer)).toContain('정상 렌더');
  expect(textOf(renderer)).not.toContain('다시 연결');
  act(() => {
    renderer.unmount();
  });
});

test('«다시 연결» → 저장 토큰 해제 + 앱 재기동(재기동하면 게이트가 연결 화면을 낸다)', () => {
  // bun:test 에는 window/localStorage 가 없다 — 브라우저 저장소 계약은 스텁으로 잰다.
  const setItem = mock((_key: string, _value: string) => {});
  const removeItem = mock((_key: string) => {});
  const reload = mock(() => {});
  const g = globalThis as unknown as { window?: unknown; localStorage?: unknown };
  const savedWindow = Object.getOwnPropertyDescriptor(g, 'window');
  const savedLocalStorage = Object.getOwnPropertyDescriptor(g, 'localStorage');
  Object.defineProperty(g, 'window', { value: { location: { reload } }, configurable: true });
  Object.defineProperty(g, 'localStorage', { value: { setItem, removeItem }, configurable: true });
  try {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(ChatErrorBoundary, null, createElement(Boom)));
    });
    act(() => {
      (findButton(renderer, '다시 연결').props as { onClick: () => void }).onClick();
    });
    // 연결 토큰 해제(elanous.daemon.token → '') 후 재기동 — 재기동하면
    // DeviceConnectGate 가 빈 토큰을 물어 연결 화면에 닿는다.
    expect(setItem).toHaveBeenCalledWith('elanous.daemon.token', '');
    // 출처: #39459 — JUD-B #124629: «다시 연결»은 레거시 elanous.voice.token 까지
    // 지운다(재로드 때 이주가 거부된 옛 토큰을 되살리는 문을 닫는다).
    expect(removeItem).toHaveBeenCalledWith('elanous.voice.token');
    expect(reload).toHaveBeenCalledTimes(1);
    act(() => {
      renderer.unmount();
    });
  } finally {
    if (savedWindow) Object.defineProperty(g, 'window', savedWindow);
    else delete g.window;
    if (savedLocalStorage) Object.defineProperty(g, 'localStorage', savedLocalStorage);
    else delete g.localStorage;
  }
});

test('reconnectRejectedDevice — window 없는(SSR) 환경에선 아무 것도 안 한다', () => {
  const g = globalThis as unknown as { window?: unknown };
  const savedWindow = Object.getOwnPropertyDescriptor(g, 'window');
  Object.defineProperty(g, 'window', { value: undefined, configurable: true });
  try {
    expect(() => reconnectRejectedDevice()).not.toThrow();
  } finally {
    if (savedWindow) Object.defineProperty(g, 'window', savedWindow);
    else delete g.window;
  }
});

test('정상 트리는 바운더리를 통과해 그대로 렌더 (회귀)', () => {
  function Quiet(): ReactElement {
    return createElement('p', null, '정상 렌더');
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(ChatErrorBoundary, null, createElement(Quiet)));
  });
  expect(textOf(renderer)).toContain('정상 렌더');
  expect(textOf(renderer)).not.toContain('다시 연결');
  act(() => {
    renderer.unmount();
  });
});