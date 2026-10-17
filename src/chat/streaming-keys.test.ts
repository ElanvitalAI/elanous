import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { attachStreamingKeys, onEscAbort } from './index.js';
import { registerExternalInputHost, type ExternalInputHost } from '../input/external-input-queue.js';

type DataListener = (data: string | Buffer) => void;

interface FakeStdin {
  paused: boolean;
  listeners: DataListener[];
  pending: Array<string | Buffer>;
  resumeCalls: number;
  pauseCalls: number;
  removeCalls: number;
  write(data: string | Buffer): void;
}

function installFakeStdin(startPaused: boolean): FakeStdin {
  const fake: FakeStdin = {
    paused: startPaused,
    listeners: [],
    pending: [],
    resumeCalls: 0,
    pauseCalls: 0,
    removeCalls: 0,
    write(data) {
      if (fake.paused) {
        fake.pending.push(data);
        return;
      }
      for (const listener of fake.listeners.slice()) listener(data);
    },
  };
  (process.stdin as any).on = (event: string, listener: DataListener) => {
    if (event === 'data') fake.listeners.push(listener);
    return process.stdin;
  };
  (process.stdin as any).removeListener = (event: string, listener: DataListener) => {
    if (event === 'data') {
      fake.removeCalls++;
      fake.listeners = fake.listeners.filter((candidate) => candidate !== listener);
    }
    return process.stdin;
  };
  (process.stdin as any).isPaused = () => fake.paused;
  (process.stdin as any).resume = () => {
    fake.resumeCalls++;
    fake.paused = false;
    const pending = fake.pending.splice(0);
    for (const data of pending) fake.write(data);
    return process.stdin;
  };
  (process.stdin as any).pause = () => {
    fake.pauseCalls++;
    fake.paused = true;
    return process.stdin;
  };
  return fake;
}

describe('attachStreamingKeys stdin lifecycle', () => {
  let originalOn: typeof process.stdin.on;
  let originalRemoveListener: typeof process.stdin.removeListener;
  let originalIsPaused: typeof process.stdin.isPaused;
  let originalResume: typeof process.stdin.resume;
  let originalPause: typeof process.stdin.pause;

  beforeEach(() => {
    originalOn = process.stdin.on;
    originalRemoveListener = process.stdin.removeListener;
    originalIsPaused = process.stdin.isPaused;
    originalResume = process.stdin.resume;
    originalPause = process.stdin.pause;
  });

  afterEach(() => {
    (process.stdin as any).on = originalOn;
    (process.stdin as any).removeListener = originalRemoveListener;
    (process.stdin as any).isPaused = originalIsPaused;
    (process.stdin as any).resume = originalResume;
    (process.stdin as any).pause = originalPause;
  });

  test('resumes paused stdin and delivers buffered multi-key input', () => {
    const stdin = installFakeStdin(true);
    const seen: string[] = [];
    stdin.write('jk');

    const cleanup = attachStreamingKeys((key) => { seen.push(key.name); });

    expect(stdin.resumeCalls).toBe(1);
    expect(stdin.paused).toBe(false);
    expect(seen).toEqual(['j', 'k']);
    cleanup();
  });

  test('cleanup restores paused state, removes its listener, and is idempotent', () => {
    const stdin = installFakeStdin(true);
    const cleanup = attachStreamingKeys(() => {});

    cleanup();
    cleanup();

    expect(stdin.listeners).toEqual([]);
    expect(stdin.removeCalls).toBe(1);
    expect(stdin.pauseCalls).toBe(1);
    expect(stdin.paused).toBe(true);
  });

  test('cleanup preserves an already flowing stdin', () => {
    const stdin = installFakeStdin(false);
    const cleanup = attachStreamingKeys(() => {});

    cleanup();

    expect(stdin.removeCalls).toBe(1);
    expect(stdin.pauseCalls).toBe(0);
    expect(stdin.paused).toBe(false);
  });

  test('onEscAbort receives a lone Escape through the streaming listener', async () => {
    const stdin = installFakeStdin(true);
    const controller = new AbortController();
    const cleanup = onEscAbort(controller);

    stdin.write('\x1b');
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(controller.signal.aborted).toBe(true);
    cleanup();
  });
});

// ⏹ TUI-STOP-RAW-PTY — 원시 pty 길(`pty text pty_<id> /stop --enter`)은 stdin 한 청크로 온다.
//   반증: 이 가로채기를 빼면 handler 가 `/ s t o p ⏎` 여섯 키를 받아 typeahead 가 «대기(응답 뒤)»에 쌓는다.
describe('attachStreamingKeys raw-pty /stop', () => {
  const saved = { on: process.stdin.on, removeListener: process.stdin.removeListener, isPaused: process.stdin.isPaused, resume: process.stdin.resume, pause: process.stdin.pause };
  let unregister: (() => void) | null = null;
  afterEach(() => {
    unregister?.(); unregister = null;
    Object.assign(process.stdin as any, saved);
  });
  function host(turn: boolean): { host: ExternalInputHost; stops: number[] } {
    const stops: number[] = [];
    return {
      stops,
      host: {
        isTurnActive: () => turn,
        composerText: () => undefined,
        hasPendingKeys: () => false,
        submit: () => false,
        requestStop: () => { stops.push(1); return true; },
      },
    };
  }

  test('턴 중 한 청크 /stop⏎ 는 키로 흘리지 않고 stop 으로 간다', () => {
    const stdin = installFakeStdin(false);
    const h = host(true);
    unregister = registerExternalInputHost(h.host);
    const seen: string[] = [];
    const cleanup = attachStreamingKeys((key) => { seen.push(key.name); });
    stdin.write('/stop\r');
    expect(h.stops.length).toBe(1);
    expect(seen).toEqual([]);
    cleanup();
  });

  // 의도: 오탐 0 — 가로채는 것은 «한 청크 = 정확히 /stop⏎·/esc⏎» 하나뿐이다.
  //   사람이 한 글자씩 친 /stop⏎(청크 여섯)·붙여넣기(봉투 한 청크 또는 봉투가 열린 채 온 본문 청크)·
  //   여러 줄 청크·글 중간에 섞인 /stop 은 전부 종전대로 키(→ typeahead)로 간다.
  test('오탐 경계: 한 글자씩 친 /stop⏎ · 붙여넣기 · 여러 줄 · 글 중간 /stop 은 가로채지 않는다', () => {
    const stdin = installFakeStdin(false);
    const h = host(true);
    unregister = registerExternalInputHost(h.host);
    const seen: string[] = [];
    const cleanup = attachStreamingKeys((key) => { seen.push(key.name); });
    // 경계마다 handler 가 키를 «받았는지» 따로 본다 — 가로채면 그 경계의 키가 0 이다.
    const delivered = (chunks: readonly string[]): string[] => {
      const from = seen.length;
      for (const c of chunks) stdin.write(c);
      return seen.slice(from);
    };
    expect(delivered(['/', 's', 't', 'o', 'p', '\r'])).toEqual(['/', 's', 't', 'o', 'p', 'enter']);
    expect(delivered(['\x1b[200~/stop\r\x1b[201~']).length).toBeGreaterThan(0);
    expect(delivered(['\x1b[200~', '/stop\r', '\x1b[201~']).length).toBeGreaterThan(0);
    expect(delivered(['hello\r/stop\r'])).toEqual(['h', 'e', 'l', 'l', 'o', 'enter', '/', 's', 't', 'o', 'p', 'enter']);
    expect(delivered(['abc /stop\r'])).toEqual(['a', 'b', 'c', 'space', '/', 's', 't', 'o', 'p', 'enter']);
    expect(h.stops.length).toBe(0);
    cleanup();
  });

  test('/esc⏎ 한 청크도 stop · 앞 청크의 이스케이프가 열려 있으면 가로채지 않는다', async () => {
    const stdin = installFakeStdin(false);
    const h = host(true);
    unregister = registerExternalInputHost(h.host);
    const cleanup = attachStreamingKeys(() => {});
    stdin.write('/esc\r');
    expect(h.stops.length).toBe(1);
    stdin.write('\x1b');
    stdin.write('/stop\r');
    expect(h.stops.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    cleanup();
  });

  test('일반 글 청크·턴 밖 /stop 은 종전대로 키로 배달된다', () => {
    const stdin = installFakeStdin(false);
    const busy = host(true);
    unregister = registerExternalInputHost(busy.host);
    const seen: string[] = [];
    const cleanup = attachStreamingKeys((key) => { seen.push(key.name); });
    stdin.write('ok\r');
    expect(busy.stops.length).toBe(0);
    expect(seen.length).toBe(3);
    unregister(); unregister = null;
    const idle = host(false);
    unregister = registerExternalInputHost(idle.host);
    seen.length = 0;
    stdin.write('/stop\r');
    expect(idle.stops.length).toBe(0);
    expect(seen.length).toBe(6);
    cleanup();
  });
});
