import { describe, expect, test } from 'bun:test';
import { getDefaultConfirmChannels, registerDefaultConfirmChannels } from '../hitl/confirm.js';

import {
  createCdpClient,
  createCdpClientFromEndpoint,
  createPageTarget,
  discoverChromeBinary,
  isWindowsInteropBinary,
  resolveDebuggerUrl,
  type CdpTransport,
} from './client.js';
import { performBrowserAction } from '../harness/browser-act.js';
import { browserNavigateRuntime, setBrowserRuntimeDeps } from '../tool-runtime/browser-runtime.js';

function pendingTransport(): CdpTransport {
  return {
    send: () => new Promise<never>(() => {}),
    close() {},
  };
}

function hangingFetch(): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  })) as typeof fetch;
}

function headersThenHangingBodyFetch(): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: () => new Promise<never>(() => {}),
  })) as unknown as typeof fetch;
}

describe('discoverChromeBinary', () => {
  test('prefers an existing ELANOUS_CHROME_BIN over platform candidates', () => {
    const checked: string[] = [];

    const binary = discoverChromeBinary({
      env: { ELANOUS_CHROME_BIN: '/custom/chrome' },
      platform: 'linux',
      existsSync: (path) => {
        checked.push(path);
        return path === '/custom/chrome';
      },
      readFile: () => 'Linux version microsoft',
    });

    expect(binary).toBe('/custom/chrome');
    expect(checked).toEqual(['/custom/chrome']);
  });

  test('preserves Darwin candidate selection', () => {
    const checked: string[] = [];
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

    const binary = discoverChromeBinary({
      env: {},
      platform: 'darwin',
      existsSync: (path) => {
        checked.push(path);
        return path === chrome;
      },
      readFile: () => { throw new Error('Darwin must not probe /proc/version'); },
    });

    expect(binary).toBe(chrome);
    expect(checked).toEqual([chrome]);
  });

  test('prefers a native Linux binary without probing WSL candidates', () => {
    const checked: string[] = [];

    const binary = discoverChromeBinary({
      env: {},
      platform: 'linux',
      existsSync: (path) => {
        checked.push(path);
        return path === '/usr/bin/google-chrome';
      },
      readFile: () => 'Linux version microsoft-standard-WSL2',
    });

    expect(binary).toBe('/usr/bin/google-chrome');
    expect(checked).toEqual(['/usr/bin/google-chrome']);
  });

  test('falls back to WSL candidates only after every native Linux candidate fails', () => {
    const checked: string[] = [];
    const nativeCandidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ];
    const wslEdge = '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

    const binary = discoverChromeBinary({
      env: {},
      platform: 'linux',
      existsSync: (path) => {
        checked.push(path);
        return path === wslEdge;
      },
      readFile: () => 'Linux version Microsoft',
    });

    expect(binary).toBe(wslEdge);
    expect(checked).toEqual([...nativeCandidates, wslEdge]);
  });

  test('detects WSL from WSLInterop when /proc/version lacks microsoft', () => {
    const wslEdge = '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

    expect(discoverChromeBinary({
      env: {},
      platform: 'linux',
      existsSync: (path) => path === '/proc/sys/fs/binfmt_misc/WSLInterop' || path === wslEdge,
      readFile: () => 'Linux version generic',
    })).toBe(wslEdge);
  });

  test('does not probe WSL candidates when neither WSL signal is present', () => {
    const checked: string[] = [];
    const wslEdge = '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

    expect(discoverChromeBinary({
      env: {},
      platform: 'linux',
      existsSync: (path) => {
        checked.push(path);
        return path === wslEdge;
      },
      readFile: () => 'Linux version generic',
    })).toBeNull();
    expect(checked).not.toContain(wslEdge);
  });
});

describe('isWindowsInteropBinary', () => {
  test('recognizes only mounted Windows executable paths', () => {
    expect(isWindowsInteropBinary('/mnt/c/Program Files/x/y.exe')).toBe(true);
    expect(isWindowsInteropBinary('/usr/bin/google-chrome')).toBe(false);
    expect(isWindowsInteropBinary('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')).toBe(false);
    expect(isWindowsInteropBinary('/mnt/c/Program Files/x/y')).toBe(false);
  });
});

describe('CDP client watchdog', () => {
  test('a CDP call that never responds rejects within the configured timeout and names its method and duration', async () => {
    const client = await createCdpClientFromEndpoint(9222, {
      resolvePage: async () => ({ wsUrl: 'ws://fake', targetId: 'tab-1' }),
      createTransport: async () => pendingTransport(),
      fetchImpl: (async () => ({ ok: true, async json() { return {}; } })) as unknown as typeof fetch,
      timeoutMs: 20,
    });

    const started = Date.now();
    await expect(client.screenshot()).rejects.toEqual(expect.objectContaining({
      name: 'CdpTimeoutError',
      method: 'Page.captureScreenshot',
      timeoutMs: 20,
      message: 'CDP call Page.captureScreenshot timed out after 20ms',
    }));
    expect(Date.now() - started).toBeLessThan(1_000);
    await client.close();
  });

  test('an unresponsive /json/new endpoint times out per attempt, identifies the attach layer, and advances retries', async () => {
    let attempts = 0;
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      attempts++;
      return hangingFetch()(input, init);
    }) as typeof fetch;
    const started = Date.now();

    await expect(createPageTarget(9222, {
      fetchImpl,
      retries: 3,
      intervalMs: 1,
      attachTimeoutMs: 20,
    })).rejects.toEqual(expect.objectContaining({
      name: 'CdpUnavailable',
      message: expect.stringContaining('CDP attach /json/new?about%3Ablank timed out after 20ms'),
    }));
    expect(attempts).toBe(3);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('a /json/new endpoint with headers but a hanging JSON body times out per attempt and identifies the attach layer', async () => {
    let attempts = 0;
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      attempts++;
      return headersThenHangingBodyFetch()(input, init);
    }) as typeof fetch;
    const started = Date.now();

    await expect(createPageTarget(9222, {
      fetchImpl,
      retries: 3,
      intervalMs: 1,
      attachTimeoutMs: 20,
    })).rejects.toEqual(expect.objectContaining({
      name: 'CdpUnavailable',
      message: expect.stringContaining('CDP attach /json/new?about%3Ablank timed out after 20ms'),
    }));
    expect(attempts).toBe(3);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('an unresponsive /json/version endpoint identifies the attach layer', async () => {
    // ⛔ 문면을 «통째로» 박지 않는다 — 이 시험의 의도는 「attach 층을 지목하나」이지 「문장이 같나」가 아니다.
    //    2026-09-10: 문면이 「무엇을 했는지」를 담도록 넓어졌고, 통째 비교가 그것을 막았다.
    const error = await resolveDebuggerUrl(9222, {
      fetchImpl: hangingFetch(),
      retries: 1,
      intervalMs: 1,
      attachTimeoutMs: 20,
    }).then(() => null, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error!.name).toBe('CdpUnavailable');
    // ⭐ attach 층을 «지목한다»
    expect(error!.message).toContain('/json/version');
    expect(error!.message).toContain('timed out after 20ms');
  });

  test('⭐ 실패 문면이 «무엇을 했는지» 말한다 — 「기다림이 모자랐다」를 「접근 불가」로 오독하지 않게', async () => {
    // 🩸 계기: 옛 문면은 `Unable to connect. Is the computer able to access the url?` 하나뿐이라
    //    ***「네트워크·주소 문제」처럼 읽혔다***. 실제 원인은 「고부하에서 Chrome 이 2초 안에 안 떴다」였다.
    const error = await resolveDebuggerUrl(9222, {
      fetchImpl: hangingFetch(),
      retries: 2,
      intervalMs: 1,
      attachTimeoutMs: 20,
    }).then(() => null, (e: unknown) => e as Error);
    expect(error!.message).toMatch(/\d+번 시도/);
    expect(error!.message).toMatch(/\d+ms 기다렸다/);
    expect(error!.message).toContain('예산 20ms');
    expect(error!.message).toContain('attachTimeoutMs 를 올려라');
  });

  test('⭐ 「횟수」와 「예산」 중 «늦게 끝나는 쪽»까지 기다린다 — 기존 동작을 줄이지 않는다', async () => {
    const started = Date.now();
    await resolveDebuggerUrl(9222, {
      // ⛔ `typeof fetch` 는 `preconnect` 까지 요구한다 — 시험 심이라 캐스트로 좁힌다
      fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch,
      retries: 1,
      intervalMs: 5,
      attachTimeoutMs: 120,
    }).catch(() => undefined);
    // ⛔ 옛 판이면 retries=1 로 «즉시» 끝났다 — 이제 예산(120ms)을 «쓴다»
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  test('preserves a URL CDP endpoint path and query while opening and closing its dedicated target', async () => {
    const requested: string[] = [];
    const client = await createCdpClientFromEndpoint('https://remote.example/cdp/?token=secret', {
      fetchImpl: (async (input: RequestInfo | URL) => {
        requested.push(String(input));
        return {
          ok: true,
          status: 200,
          async json() { return { webSocketDebuggerUrl: 'ws://fake', id: 'tab-1' }; },
        } as Response;
      }) as typeof fetch,
      createTransport: async () => ({ send: async () => ({}), close() {} }),
    });

    await client.close();
    await Bun.sleep(0);
    expect(requested).toEqual([
      'https://remote.example/cdp/json/new?about%3Ablank&token=secret',
      'https://remote.example/cdp/json/close/tab-1?token=secret',
    ]);
  });

  test('attached-client close remains fail-soft when /json/close times out', async () => {
    const client = await createCdpClientFromEndpoint(9222, {
      resolvePage: async () => ({ wsUrl: 'ws://fake', targetId: 'tab-1' }),
      createTransport: async () => ({ send: async () => ({}), close() {} }),
      fetchImpl: hangingFetch(),
      attachTimeoutMs: 20,
    });

    await expect(client.close()).resolves.toBeUndefined();
  });

  test('Runtime.evaluate sends awaitPromise and does not begin a measurement until a render promise settles', async () => {
    const calls: Array<{ expression: string; returnByValue?: unknown; awaitPromise?: unknown }> = [];
    let settleRender: (() => void) | undefined;
    const client = await createCdpClientFromEndpoint(9222, {
      resolvePage: async () => ({ wsUrl: 'ws://fake', targetId: 'tab-1' }),
      fetchImpl: (async () => ({ ok: true, async json() { return {}; } })) as unknown as typeof fetch,
      createTransport: async () => ({
        send: async (method, params) => {
          if (method !== 'Runtime.evaluate') return {};
          const evaluation = params as { expression: string; awaitPromise?: unknown };
          calls.push(evaluation);
          if (evaluation.expression === 'render-ready') {
            return await new Promise((resolve) => { settleRender = () => resolve({ result: { value: undefined } }); });
          }
          return { result: { value: 'measured' } };
        },
        close() {},
      }),
    });

    const measurement = client.evaluate('render-ready').then(() => client.evaluate('measure'));
    await Bun.sleep(0);
    expect(calls).toEqual([{ expression: 'render-ready', returnByValue: true, awaitPromise: true }]);

    settleRender?.();
    await expect(measurement).resolves.toBe('measured');
    expect(calls).toEqual([
      { expression: 'render-ready', returnByValue: true, awaitPromise: true },
      { expression: 'measure', returnByValue: true, awaitPromise: true },
    ]);
    await client.close();
  });

  test('attached page dispatches a primary click and inserts unicode text via the same CDP transport', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const client = await createCdpClientFromEndpoint(9222, {
      resolvePage: async () => ({ wsUrl: 'ws://fake', targetId: 'tab-1' }),
      fetchImpl: (async () => ({ ok: true })) as unknown as typeof fetch,
      createTransport: async () => ({
        send: async (method, params) => { calls.push({ method, params }); return {}; },
        close() {},
      }),
    });

    await client.click!({ x: 120, y: 80 });
    await client.input!('한글 🖱️');
    expect(calls).toEqual([
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 120, y: 80, button: 'left', clickCount: 1 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 120, y: 80, button: 'left', clickCount: 1 } },
      { method: 'Input.insertText', params: { text: '한글 🖱️' } },
    ]);
    await client.close();
  });

  test('input preserves the shared CDP watchdog and identifies the timed-out command', async () => {
    const client = await createCdpClientFromEndpoint(9222, {
      resolvePage: async () => ({ wsUrl: 'ws://fake', targetId: 'tab-1' }),
      fetchImpl: (async () => ({ ok: true })) as unknown as typeof fetch,
      createTransport: async () => pendingTransport(),
      timeoutMs: 20,
    });
    try {
      await expect(client.input!('text')).rejects.toEqual(expect.objectContaining({
        name: 'CdpTimeoutError', method: 'Input.insertText', timeoutMs: 20,
      }));
    } finally {
      await client.close();
    }
  });

  test('spawned client reaches the shared page transport when inserting text', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const client = await createCdpClient({ binary: '/fake/chrome' }, {
      spawnBinary: () => ({ pid: 123, kill: () => true }) as unknown as import('node:child_process').ChildProcess,
      resolveUrl: async () => 'ws://fake',
      createTransport: async () => ({
        send: async (method, params) => {
          calls.push({ method, params });
          return method === 'Target.getTargets' ? { targetInfos: [{ targetId: 'tab-1', type: 'page', url: 'about:blank' }] } : {};
        },
        close() {},
      }),
    });
    try {
      await client.input!('approved text');
      expect(calls).toEqual([
        { method: 'Target.getTargets', params: undefined },
        { method: 'Input.insertText', params: { text: 'approved text' } },
      ]);
    } finally {
      await client.close();
    }
  });

  test('spawned client refuses text input when target discovery finds no page', async () => {
    const calls: string[] = [];
    const client = await createCdpClient({ binary: '/fake/chrome' }, {
      spawnBinary: () => ({ pid: 123, kill: () => true }) as unknown as import('node:child_process').ChildProcess,
      resolveUrl: async () => 'ws://fake',
      createTransport: async () => ({
        send: async (method) => {
          calls.push(method);
          return method === 'Target.getTargets' ? { targetInfos: [] } : {};
        },
        close() {},
      }),
    });
    try {
      await expect(client.input!('text')).rejects.toThrow('no page target');
      expect(calls).toEqual(['Target.getTargets']);
    } finally {
      await client.close();
    }
  });

  test('unarmed browser action sends no CDP commands, while armed action reaches the CDP click after load', async () => {
    const calls: string[] = [];
    const events: Array<(event: { method: string; params: Record<string, unknown> }) => void> = [];
    const connect = () => createCdpClientFromEndpoint(9222, {
      resolvePage: async () => ({ wsUrl: 'ws://fake', targetId: 'tab-1' }),
      fetchImpl: (async () => ({ ok: true })) as unknown as typeof fetch,
      createTransport: async () => ({
        send: async (method) => {
          calls.push(method);
          if (method === 'Page.navigate') {
            queueMicrotask(() => events.forEach(listener => listener({
              method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'frame', loaderId: 'loader' },
            })));
            return { frameId: 'frame', loaderId: 'loader' };
          }
          if (method === 'Runtime.evaluate') return { result: { value: { x: 120, y: 80, kind: 'navigation' } } };
          if (method === 'Page.captureScreenshot') return { data: Buffer.from('png').toString('base64') };
          return {};
        },
        on: (_method, listener) => { events.push(listener); return () => { events.splice(events.indexOf(listener), 1); }; },
        close() {},
      }),
    });
    const request = { url: 'https://example.test', target: '#next' };
    const deps = { connect, reclaimOpenedTabs: false, loadWaitTimeoutMs: 50,
      saveAttachment: async () => ({ ok: true, entry: { path: 'test.png' } }) as never,
      observe: () => {},
    };
    expect((await performBrowserAction({ ...request, armed: false }, deps)).ok).toBe(false);
    expect(calls).toEqual([]);
    expect((await performBrowserAction({ ...request, armed: true }, deps)).ok).toBe(true);
    expect(calls.filter(method => method === 'Input.dispatchMouseEvent')).toHaveLength(2);
  });

  test('BrowserNavigate requires approval before connection and sends input only after target inspection', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const originalChannels = getDefaultConfirmChannels();
    registerDefaultConfirmChannels([]);
    let connects = 0;
    let inspected = true;
    let pageUrl = 'https://example.test/';
    setBrowserRuntimeDeps({
      getClient: async () => {
        connects++;
        return createCdpClientFromEndpoint(9222, {
          resolvePage: async () => ({ wsUrl: 'ws://fake', targetId: 'tab-1' }),
          fetchImpl: (async () => ({ ok: true })) as unknown as typeof fetch,
          createTransport: async () => ({
            send: async (method, params) => {
              calls.push({ method, params });
              if (method === 'Page.navigate') return { frameId: 'frame', loaderId: 'loader' };
              if (method === 'Runtime.evaluate') {
                const expression = String(params?.expression);
                return { result: { value: expression.includes('getAttribute')
                  ? (inspected ? { tag: 'input', type: 'text', name: 'q', id: 'query', contentEditable: false, inForm: true } : null)
                  : expression.includes('element.focus()') ? true : pageUrl } };
              }
              return {};
            },
            close() {},
          }),
        });
      },
      observe: () => {},
    });
    const req = { url: 'https://example.test/', waitForLoad: false, input: { selector: '#query', text: '승인된 입력' } };
    const answer = (value: boolean | (() => never)) => ({ surface: 'tui' as const, confirmChannels: [{
      name: 'test' as const, request: async () => (typeof value === 'function' ? value() : value), cancel: () => {},
    }] });
    try {
      expect((await browserNavigateRuntime.run(req, { surface: 'tui' })).output).toContain('not approved');
      expect((await browserNavigateRuntime.run(req, answer(false))).output).toContain('not approved');
      expect((await browserNavigateRuntime.run(req, answer(() => { throw new Error('confirmation unavailable'); }))).output).toContain('not approved');
      // The shell-command approver never authorizes browser input, even when it auto-allows.
      expect((await browserNavigateRuntime.run(req, { surface: 'tui', approver: async () => true })).output).toContain('not approved');
      expect((await browserNavigateRuntime.run({ ...req, input: { ...req.input, text: 'submit\n' } }, answer(true))).output).toContain('invalid input');
      expect(connects).toBe(0);
      expect(calls).toEqual([]);
      const viaChannel = await browserNavigateRuntime.run(req, { surface: 'tui', confirmChannels: [{
        name: 'test', request: async () => true, cancel: () => {},
      }] });
      expect(viaChannel.output).toContain('# BrowserNavigate: https://example.test/');
      expect(calls.filter(call => call.method === 'Input.insertText')).toHaveLength(1);
      const confirmations: unknown[] = [];
      const result = await browserNavigateRuntime.run(req, { surface: 'tui', approver: async () => false, confirmChannels: [{
        name: 'test', request: async (request) => { confirmations.push(request); return true; }, cancel: () => {},
      }] });
      expect(result.output).toContain('# BrowserNavigate: https://example.test/');
      expect(confirmations).toHaveLength(1);
      expect(confirmations[0]).toMatchObject({ prompt: 'Browser input on https://example.test/', detail: 'Selector: #query\nText: 승인된 입력' });
      expect(calls.filter(call => call.method === 'Input.insertText')).toEqual([
        { method: 'Input.insertText', params: { text: '승인된 입력' } },
        { method: 'Input.insertText', params: { text: '승인된 입력' } },
      ]);
      inspected = false;
      const before = calls.filter(call => call.method === 'Input.insertText').length;
      expect((await browserNavigateRuntime.run(req, answer(true))).output).toContain('input error');
      expect(calls.filter(call => call.method === 'Input.insertText')).toHaveLength(before);
      inspected = true;
      pageUrl = 'https://other.example.test/';
      expect((await browserNavigateRuntime.run(req, answer(true))).output)
        .toContain('page URL changed after approval');
      expect(calls.filter(call => call.method === 'Input.insertText')).toHaveLength(before);
      pageUrl = 'https://example.test/';
      const withoutSlash = await browserNavigateRuntime.run({ ...req, url: 'https://example.test' }, answer(true));
      expect(withoutSlash.output).toContain('# BrowserNavigate: https://example.test/');
      expect(calls.filter(call => call.method === 'Input.insertText')).toHaveLength(before + 1);
      const plainNavigation = await browserNavigateRuntime.run({ url: req.url, waitForLoad: false }, { surface: 'tui' });
      expect(plainNavigation.output).toContain('# BrowserNavigate: https://example.test/');
      expect(calls.filter(call => call.method === 'Input.insertText')).toHaveLength(before + 1);
    } finally {
      registerDefaultConfirmChannels(originalChannels);
      setBrowserRuntimeDeps({ getClient: async () => null, observe: () => {} });
    }
  });

  test('input refuses newline before dispatch, preventing an implicit form submission', async () => {
    const calls: string[] = [];
    const client = await createCdpClientFromEndpoint(9222, {
      resolvePage: async () => ({ wsUrl: 'ws://fake', targetId: 'tab-1' }),
      fetchImpl: (async () => ({ ok: true })) as unknown as typeof fetch,
      createTransport: async () => ({
        send: async (method) => { calls.push(method); return {}; },
        close() {},
      }),
    });
    try {
      await expect(client.input!('submit\n')).rejects.toThrow('CDP input refuses newlines');
      expect(calls).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test('CDP input failure propagates to its caller rather than reporting a successful insertion', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const client = await createCdpClientFromEndpoint(9222, {
      resolvePage: async () => ({ wsUrl: 'ws://fake', targetId: 'tab-1' }),
      fetchImpl: (async () => ({ ok: true })) as unknown as typeof fetch,
      createTransport: async () => ({
        send: async (method, params) => {
          calls.push({ method, params });
          throw new Error('CDP input rejected');
        },
        close() {},
      }),
    });
    try {
      await expect(client.input!('한글 🖱️')).rejects.toThrow('CDP input rejected');
      expect(calls).toEqual([{ method: 'Input.insertText', params: { text: '한글 🖱️' } }]);
    } finally {
      await client.close();
    }
  });

  test('the spawn client applies its configured watchdog during target discovery and releases transport and child on timeout', async () => {
    let transportClosed = false;
    let killed = false;
    const child = {
      pid: 123,
      kill: () => { killed = true; return true; },
      on: () => {},
    } as unknown as import('node:child_process').ChildProcess;
    const transport: CdpTransport = {
      ...pendingTransport(),
      close() { transportClosed = true; },
    };

    await expect(createCdpClient({ binary: '/fake/chrome', timeoutMs: 20 }, {
      spawnBinary: () => child,
      resolveUrl: async () => 'ws://fake',
      createTransport: async () => transport,
    })).rejects.toEqual(expect.objectContaining({
      name: 'CdpTimeoutError',
      method: 'Target.getTargets',
      timeoutMs: 20,
      message: 'CDP call Target.getTargets timed out after 20ms',
    }));
    expect(transportClosed).toBe(true);
    expect(killed).toBe(true);
  });

  // 🛟 2026-08-27 — abandoned draft #13394 에서 «건져 온» 시험.
  //    🔑 무는 불변식: ***바깥(capture 5초)이 안쪽(CDP 호출 120초)보다 «먼저» 이긴다.***
  //    ⛔ 이 둘을 「하나로 합치자」는 손이 오면 매달림 보호가 «조용히» 약해진다 —
  //       캡처는 «에러가 아니라 영영 안 옴»으로 실패하므로 바깥 시한이 이 경로의 «전제»다.
  test('바깥 capture 시한이 안쪽 CDP 시한보다 «먼저» 이긴다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const transport: CdpTransport = {
      send: (method) => {
        if (method === 'Page.captureScreenshot') return new Promise<never>(() => {});
        if (method === 'Page.navigate') return Promise.resolve({ frameId: 'frame', loaderId: 'loader' });
        // 🪞⛔ 2026-08-30(🅕 37차): 이 목이 «늙어» 이 시험이 ***내내 빨갰다***.
        //    「쓴다」 축이 생기며 되돌림 관문이 `kind` 를 요구하는데(⛔ 모르면 «이동으로 가정하지 않는다»),
        //    이 목은 좌표만 냈다 ⇒ 조작이 «거부»돼 result.ok 가 false 였다.
        //    🔑 이 시험이 무는 것은 ***시한의 순서***이지 되돌림 정책이 아니다 —
        //       그래서 정책을 «느슨하게» 하지 않고 ***목이 그 시나리오를 제대로 세우게*** 고친다.
        if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: { x: 120, y: 80, kind: 'navigation' } } });
        return Promise.resolve({});
      },
      on: (_method, listener) => {
        queueMicrotask(() => listener({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'frame', loaderId: 'loader' } }));
        return () => {};
      },
      close() {},
    };
    const client = await createCdpClientFromEndpoint(9222, {
      resolvePage: async () => ({ wsUrl: 'ws://fake', targetId: 'page-1' }),
      fetchImpl: (async () => ({ ok: true, async json() { return {}; } })) as unknown as typeof fetch,
      createTransport: async () => transport,
      timeoutMs: 50,
    });
    const result = await performBrowserAction(
      { url: 'https://example.test', target: '#save', armed: true },
      { connect: async () => client, captureTimeoutMs: 10, observe: (event, data) => events.push({ event, data }) },
    );
    expect(result.ok).toBe(true);
    expect(events[0]?.data).toMatchObject({ attachmentRef: null, captureOutcome: 'timeout' });
  });
});
