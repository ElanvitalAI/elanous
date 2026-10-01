// B2 — 웹배포 CDP 렌더 검증. fake CdpClient 로 navigate/evaluate/screenshot·fail-soft 검증.
import { describe, test, expect, spyOn } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatVerifyUrlReport, verifyDeployedPage } from './browser-verify.js';
import { CdpUnavailable, type CdpClient, type CdpEventListener } from '../browser-cdp/client.js';
import { debug } from '../debug/log.js';

type FakeOptions = {
  title?: string;
  bodyLen?: number;
  unloadedImageCount?: number;
  duplicateText?: string | null;
  page?: FakePage;
  navved?: string[];
  closed?: { v: boolean };
  withEvents?: boolean;
  onSubscribe?: () => void;
  onUnsubscribe?: () => void;
  emitException?: boolean;
  emitLoad?: boolean;
  navigateDelayMs?: number;
  loadDelayMs?: number;
  emitLoadAfterNavigate?: boolean;
  navigation?: { frameId: string; errorText?: string };
  events?: string[];
};

type FakeElement = {
  text?: string;
  children?: FakeElement[];
  display?: string;
  visibility?: string;
  parentElement?: FakeElement | null;
};

type FakePage = {
  title?: string;
  bodyText?: string;
  elements: FakeElement[];
  images?: Array<{ complete: boolean; naturalWidth: number; loading?: string; rect?: { top: number; bottom: number; left: number; right: number }; getBoundingClientRect?: () => { top: number; bottom: number; left: number; right: number } }>;
};

function textElement(text: string, children: FakeElement[] = [], options: Pick<FakeElement, 'display' | 'visibility'> = {}): FakeElement {
  const element: FakeElement = { text, children, ...options };
  for (const child of children) child.parentElement = element;
  return element;
}

function textNodes(elements: FakeElement[]): Array<{ nodeValue: string; parentElement: FakeElement }> {
  return elements.flatMap((element) => [
    ...(element.text ? [{ nodeValue: element.text, parentElement: element }] : []),
    ...textNodes(element.children ?? []),
  ]);
}

function fakeClient(over: FakeOptions = {}): CdpClient {
  const listeners = new Map<string, CdpEventListener>();
  const client: CdpClient = {
    port: 9222,
    pid: -1,
    isAlive: true,
    async navigate(url) {
      over.navved?.push(url);
      over.events?.push('navigate-start');
      if (over.navigateDelayMs) await new Promise((resolve) => setTimeout(resolve, over.navigateDelayMs));
      over.events?.push('navigate-complete');
      if (over.emitException) listeners.get('Runtime.exceptionThrown')?.({ method: 'Runtime.exceptionThrown', params: { exceptionDetails: { text: 'boom' } } });
      const emitLoad = () => {
        over.events?.push('load');
        listeners.get('Page.loadEventFired')?.({ method: 'Page.loadEventFired', params: {} });
      };
      if (over.emitLoad) {
        if (over.emitLoadAfterNavigate) {
          setTimeout(emitLoad, over.loadDelayMs ?? 0);
        } else {
          if (over.loadDelayMs) await new Promise((resolve) => setTimeout(resolve, over.loadDelayMs));
          emitLoad();
        }
      }
      return over.navigation ?? { frameId: 'frame-1' };
    },
    async evaluate(expr) {
      over.events?.push('evaluate');
      if (over.page && String(expr).includes('unloadedImageCount')) {
        const page = over.page;
        const nodes = textNodes(page.elements);
        const document = {
          title: page.title ?? 'Deployed Page',
          body: { innerText: page.bodyText ?? nodes.map(({ nodeValue }) => nodeValue).join(' ') },
          images: (page.images ?? []).map((image) => ({ ...image, getBoundingClientRect: image.getBoundingClientRect ?? (() => image.rect ?? { top: 1000, bottom: 1100, left: 0, right: 100 }) })),
          createTreeWalker: () => {
            let index = 0;
            return { nextNode: () => nodes[index++] ?? null };
          },
        };
        const window = {
          innerHeight: 800, innerWidth: 600,
          getComputedStyle: (element: FakeElement) => ({ display: element.display ?? 'block', visibility: element.visibility ?? 'visible' }),
        };
        return new Function('document', 'window', 'NodeFilter', `return ${expr}`)(document, window, { SHOW_TEXT: 4 });
      }
      if (String(expr).includes('unloadedImageCount')) return {
        title: over.title ?? 'Deployed Page',
        bodyLength: over.bodyLen ?? 500,
        unloadedImageCount: over.unloadedImageCount ?? 0,
        consecutiveDuplicateText: over.duplicateText ?? null,
      };
      return undefined;
    },
    async screenshot() { over.events?.push('screenshot'); return Buffer.from('PNGDATA'); },
    async setScriptExecutionDisabled(value) { over.events?.push(`set-script-execution-disabled:${value}`); },
    async close() { if (over.closed) over.closed.v = true; },
  };
  if (over.withEvents !== false) {
    client.on = (method, listener) => {
      over.onSubscribe?.();
      listeners.set(method, listener);
      return () => {
        listeners.delete(method);
        over.onUnsubscribe?.();
      };
    };
  }
  return client;
}

describe('verifyDeployedPage (B2)', () => {
  test('정상 렌더 → 기존 결과 모양·스크린샷·타이틀', async () => {
    const navved: string[] = [];
    let captured = 0;
    const r = await verifyDeployedPage('https://x.vercel.app', {
      connect: async () => fakeClient({ title: 'My Site', bodyLen: 800, navved }),
      onScreenshot: (b) => { captured = b.length; },
    });
    expect(r).toEqual({ ok: true, url: 'https://x.vercel.app', title: 'My Site', bodyLength: 800, screenshotBytes: 7, findings: [] });
    expect(navved).toEqual(['https://x.vercel.app']);
    expect(captured).toBe(7);
  });

  test('CDP 이동 실패 사유는 확정 cdp-error finding으로 판정한다', async () => {
    const r = await verifyDeployedPage('http://127.0.0.1:59999', {
      connect: async () => fakeClient({ navigation: { frameId: 'frame-1', errorText: 'net::ERR_CONNECTION_REFUSED' } }),
    });
    expect(r.ok).toBe(false);
    expect(r.findings).toEqual(['CDP 이동 오류: net::ERR_CONNECTION_REFUSED']);
    expect(r.structuredFindings).toEqual([expect.objectContaining({ kind: 'cdp-error', certainty: 'confirmed', message: expect.stringContaining('ERR_CONNECTION_REFUSED') })]);
  });

  test('CDP 이동 실패 사유가 없으면 기존 정상 렌더 판정을 유지한다', async () => {
    const r = await verifyDeployedPage('https://no-navigation-error.example', {
      connect: async () => fakeClient({ navigation: { frameId: 'frame-1' } }),
    });
    expect(r).toEqual({ ok: true, url: 'https://no-navigation-error.example', title: 'Deployed Page', bodyLength: 500, screenshotBytes: 7, findings: [] });
  });

  test('navigate 반환 뒤 비동기 CDP load 완료 이벤트까지 페이지 상태 측정을 보류한다', async () => {
    const events: string[] = [];
    const verification = verifyDeployedPage('https://load-event.vercel.app', {
      connect: async () => fakeClient({ emitLoad: true, emitLoadAfterNavigate: true, loadDelayMs: 25, events }),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(['navigate-start', 'navigate-complete']);
    await verification;
    expect(events).toEqual(['navigate-start', 'navigate-complete', 'load', 'evaluate', 'screenshot']);
  });

  test('load 이벤트가 없으면 navigate 완료 후 짧은 상한 뒤에도 검증을 계속한다', async () => {
    const events: string[] = [];
    const started = Date.now();
    const r = await verifyDeployedPage('https://load-timeout.vercel.app', {
      connect: async () => fakeClient({ navigateDelayMs: 75, events }),
    });
    const elapsed = Date.now() - started;
    expect(r).toMatchObject({ ok: true, title: 'Deployed Page', bodyLength: 500 });
    expect(events).toEqual(['navigate-start', 'navigate-complete', 'evaluate', 'screenshot']);
    expect(elapsed).toBeGreaterThanOrEqual(120);
  });

  test('verified 관측은 CDP load 이벤트와 상한 진행을 구별한다', async () => {
    const calls: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => {
      if (event === 'verified') calls.push({ event, data: data as Record<string, unknown> });
    });
    try {
      await verifyDeployedPage('https://load-event.vercel.app', { connect: async () => fakeClient({ emitLoad: true }) });
      await verifyDeployedPage('https://load-timeout.vercel.app', { connect: async () => fakeClient() });
    } finally {
      log.mockRestore();
    }
    expect(calls.map(({ data }) => data.loadWait)).toEqual(['event', 'timeout']);
  });

  test('빈 페이지 → 기존 finding 유지·의심 structured finding', async () => {
    const r = await verifyDeployedPage('https://blank.vercel.app', {
      connect: async () => fakeClient({ bodyLen: 0 }),
    });
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toContain('본문이 비어있음');
    expect(r.structuredFindings).toContainEqual(expect.objectContaining({ kind: 'empty-body', certainty: 'suspected' }));
  });

  test('미로드 그림과 빈 문서 제목 → 확정 structured findings', async () => {
    const r = await verifyDeployedPage('https://images.vercel.app', {
      connect: async () => fakeClient({ title: '', unloadedImageCount: 2 }),
    });
    expect(r.structuredFindings).toContainEqual(expect.objectContaining({ kind: 'unloaded-image', certainty: 'confirmed' }));
    expect(r.structuredFindings).toContainEqual(expect.objectContaining({ kind: 'empty-title', certainty: 'confirmed' }));
    expect(r.findings).toContain('로드되지 못한 그림 2개');
  });

  test('CDP: 화면 밖 lazy 셋은 ok이고 pendingLazyImages로만 보고', async () => {
    const images = Array.from({ length: 3 }, () => ({ complete: false, naturalWidth: 0, loading: 'lazy' }));
    const r = await verifyDeployedPage('https://lazy.example', {
      connect: async () => fakeClient({ page: { title: 'Lazy page', bodyText: '본문 길이가 충분한 정상 페이지입니다', elements: [], images } }),
    });
    expect(r).toMatchObject({ ok: true, findings: [], pendingLazyImages: 3, screenshotBytes: 7 });
    expect(r.structuredFindings).toBeUndefined();
  });

  test('CDP: 화면 안 미완료 lazy와 깨진 완료 그림은 unloaded-image', async () => {
    const r = await verifyDeployedPage('https://broken.example', {
      connect: async () => fakeClient({ page: { bodyText: '본문 길이가 충분한 정상 페이지입니다', elements: [], images: [
        { complete: false, naturalWidth: 0, loading: 'lazy', rect: { top: 30, bottom: 130, left: 10, right: 110 } },
        { complete: true, naturalWidth: 0, loading: 'lazy' },
      ] } }),
    });
    expect(r.ok).toBe(false);
    expect(r.findings).toContain('로드되지 못한 그림 2개');
  });

  test('aside: 삽입된 관측 스크립트의 화면 밖 lazy 셋은 실패가 아닌 pending', async () => {
    const images = Array.from({ length: 3 }, () => ({ complete: false, naturalWidth: 0, loading: 'lazy', getBoundingClientRect: () => ({ top: 1000, bottom: 1100, left: 0, right: 100 }) }));
    const r = await verifyDeployedPage('https://lazy.example', {
      backend: 'aside',
      runAside: async (_command, args) => {
        const document = { body: { innerText: '본문 길이가 충분한 정상 페이지입니다' }, images };
        const window = { innerHeight: 800, innerWidth: 600 };
        const evaluate = (fn: () => unknown) => new Function('document', 'window', `return (${fn.toString()})()`)(document, window);
        const output: string[] = [];
        await new Function('openTab', 'closeTab', 'console', `return (async () => { ${args[1]} })()`) (
          async () => ({ title: async () => 'Lazy page', evaluate, screenshot: async () => Buffer.from('PNGDATA') }),
          async () => {}, { log: (line: string) => output.push(line) },
        );
        return { stdout: `${output.join('\n')}\n[ok | 1ms]` };
      },
    });
    expect(r).toMatchObject({ ok: true, findings: [], pendingLazyImages: 3, title: 'Lazy page' });
    expect(r.structuredFindings).toBeUndefined();
  });

  test('표현식은 중첩된 한 번의 문구를 중복으로 오판하지 않는다', async () => {
    const paragraph = textElement('한 번만 표시된 문구');
    const main = textElement('', [paragraph]);
    const r = await verifyDeployedPage('https://nested.vercel.app', {
      connect: async () => fakeClient({ page: { bodyText: '한 번만 표시된 문구', elements: [main] } }),
    });
    expect(r.structuredFindings?.map(({ kind }) => kind) ?? []).not.toContain('duplicate-visible-text');
  });

  test('표현식은 독립 요소의 같은 문구 연속 중복을 의심으로 판정한다', async () => {
    const r = await verifyDeployedPage('https://duplicate.vercel.app', {
      connect: async () => fakeClient({ page: { bodyText: '중복 문구 중복 문구', elements: [textElement('중복 문구'), textElement('중복 문구')] } }),
    });
    const duplicate = r.structuredFindings?.find(({ kind }) => kind === 'duplicate-visible-text');
    expect(duplicate).toMatchObject({ certainty: 'suspected' });
    expect(duplicate?.certainty).not.toBe('confirmed');
  });

  test('표현식은 요소와 직접 텍스트 노드에 걸친 연속 중복을 의심으로 판정한다', async () => {
    const r = await verifyDeployedPage('https://mixed-duplicate.vercel.app', {
      connect: async () => fakeClient({ page: { elements: [textElement('문구', [textElement('문구')])] } }),
    });
    expect(r.structuredFindings).toContainEqual(expect.objectContaining({ kind: 'duplicate-visible-text', certainty: 'suspected' }));
  });

  test('표현식은 display:none 조상 아래 문구를 화면 중복으로 오인하지 않는다', async () => {
    const hiddenParent = textElement('', [textElement('숨김 문구'), textElement('숨김 문구')], { display: 'none' });
    const r = await verifyDeployedPage('https://hidden-duplicate.vercel.app', {
      connect: async () => fakeClient({ page: { bodyText: '보이는 문구가 충분히 길어서 본문 판정을 통과한다', elements: [textElement('보이는 문구가 충분히 길어서 본문 판정을 통과한다'), hiddenParent] } }),
    });
    expect(r.ok).toBe(true);
    expect(r.structuredFindings?.map(({ kind }) => kind) ?? []).not.toContain('duplicate-visible-text');
  });

  test('이벤트 API가 있으면 JavaScript 오류를 확정으로 수집하고 구독 해제한다', async () => {
    let subscribed = 0;
    let unsubscribed = 0;
    const r = await verifyDeployedPage('https://error.vercel.app', {
      connect: async () => fakeClient({ emitException: true, onSubscribe: () => { subscribed++; }, onUnsubscribe: () => { unsubscribed++; } }),
    });
    expect(r.structuredFindings).toContainEqual(expect.objectContaining({ kind: 'javascript-error', certainty: 'confirmed', message: 'JavaScript 오류: boom' }));
    expect(r.unmeasured).toBeUndefined();
    expect(subscribed).toBe(2);
    expect(unsubscribed).toBe(2);
  });

  test('이벤트 API가 없으면 오류 판정은 빼고 측정 불가를 남긴다', async () => {
    const r = await verifyDeployedPage('https://no-events.vercel.app', {
      connect: async () => fakeClient({ withEvents: false }),
    });
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.structuredFindings).toBeUndefined();
    expect(r.unmeasured).toEqual(['javascript-errors']);
  });

  test('CDP 엔드포인트 부재 → skip(no-cdp·fail-soft·배포 무영향)', async () => {
    const r = await verifyDeployedPage('https://x.vercel.app', {
      connect: async () => { throw new CdpUnavailable('attach-failed: ECONNREFUSED'); },
    });
    expect(r.skipped).toBe('no-cdp');
    expect(r.ok).toBe(false);
    expect(r.findings).toEqual([]);   // 문제 아님 — 검증 미실행
  });

  test('close 는 항상 호출(finally)', async () => {
    const closed = { v: false };
    await verifyDeployedPage('https://x.vercel.app', { connect: async () => fakeClient({ closed }) });
    expect(closed.v).toBe(true);
  });

  test('navigate/screenshot 예외 → ok=false + 확정 오류 finding(fail-soft)', async () => {
    const r = await verifyDeployedPage('https://x.vercel.app', {
      connect: async () => ({ ...fakeClient(), async navigate() { throw new Error('nav boom'); } } as CdpClient),
    });
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toContain('CDP 검증 오류');
    expect(r.structuredFindings).toContainEqual(expect.objectContaining({ kind: 'cdp-error', certainty: 'confirmed' }));
  });

  test('evaluate 실패 → 추가 DOM finding 없이 기존 본문 판정으로 fail-soft', async () => {
    const r = await verifyDeployedPage('https://evaluate-fails.vercel.app', {
      connect: async () => ({ ...fakeClient(), async evaluate() { throw new Error('evaluate boom'); } } as CdpClient),
    });
    expect(r.findings).toHaveLength(1);
    expect(r.structuredFindings).toContainEqual(expect.objectContaining({ kind: 'empty-body' }));
    expect(r.structuredFindings?.map(({ kind }) => kind)).not.toContain('empty-title');
  });

  test('minBodyLength 커스텀 임계', async () => {
    const r = await verifyDeployedPage('https://x.vercel.app', {
      connect: async () => fakeClient({ bodyLen: 50 }),
      minBodyLength: 100,   // 50 < 100 → finding
    });
    expect(r.ok).toBe(false);
  });

  test('aside는 임시 스크립트 내용을 repl 위치 인자로 전달하고 mixed ok 산출을 관측한다', async () => {
    const calls: Array<{ command: string; args: string[]; timeout: number }> = [];
    let scriptPath = '';
    let writtenScript = '';
    const r = await verifyDeployedPage('https://aside.example/path?quoted="yes"', {
      backend: 'aside',
      asideTimeoutMs: 321,
      writeAsideScript: async (path, script) => {
        scriptPath = path;
        writtenScript = script;
        await writeFile(path, script, 'utf8');
      },
      runAside: async (command, args, options) => {
        calls.push({ command, args, timeout: options.timeout });
        expect(args).toHaveLength(2);
        expect(args).not.toContain('--file');
        expect(args).not.toContain(scriptPath);
        expect(args[1]).toBe(writtenScript);
        expect(args[1]).toContain('openTab(url)');
        expect(args[1]).not.toContain('page.goto(url)');
        expect(args[1]).toContain('finally { try { await closeTab(page); } catch {} }');
        expect(args[1]).toContain('https://aside.example/path?quoted=\\"yes\\"');
        expect(args[1]).toStartWith('await (async () => {');
        expect(args[1]).not.toMatch(/^return\b/m);
        return { stdout: '✔︎ Opened a new tab and set it active\n{"title":"Aside page","bodyLength":88,"unloadedImageCount":0,"screenshotBytes":11}\n[ok | 818ms]\n' };
      },
    });
    expect(calls).toEqual([{ command: 'aside', args: ['repl', writtenScript], timeout: 321 }]);
    expect(existsSync(scriptPath)).toBe(false);
    expect(r).toEqual({ ok: true, url: 'https://aside.example/path?quoted="yes"', title: 'Aside page', bodyLength: 88, screenshotBytes: 11, findings: [], unmeasured: ['javascript-errors'] });
  });

  test('Aside 미실행 문구가 페이지 제목이면 정상 ok 관측으로 유지한다', async () => {
    const url = 'https://aside.example';
    const r = await verifyDeployedPage(url, {
      backend: 'aside',
      runAside: async () => ({ stdout: '{"title":"Aside isn\'t running","bodyLength":88,"unloadedImageCount":0,"screenshotBytes":11}\n[ok | 12ms]', stderr: '', exitCode: 0 }),
    });
    expect(r).toEqual({ ok: true, url, title: "Aside isn't running", bodyLength: 88, screenshotBytes: 11, findings: [], unmeasured: ['javascript-errors'] });
  });

  test('aside 기본 executor는 non-zero 종료여도 ok 표지가 있으면 성공으로 판정한다', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aside-nonzero-'));
    const command = join(directory, 'aside');
    await writeFile(command, '#!/bin/sh\nprintf "Opened a new tab\\n{\\"title\\":\\"Aside page\\",\\"bodyLength\\":88,\\"unloadedImageCount\\":0,\\"screenshotBytes\\":11}\\n[ok | 1ms]\\n"\nexit 1\n', 'utf8');
    await chmod(command, 0o755);
    try {
      const r = await verifyDeployedPage('https://aside.example', { backend: 'aside', asideCommand: command });
      expect(r).toEqual({ ok: true, url: 'https://aside.example', title: 'Aside page', bodyLength: 88, screenshotBytes: 11, findings: [], unmeasured: ['javascript-errors'] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('aside 결과는 기존 렌더 findings로 옮기고 JavaScript 오류는 측정 불가로 남긴다', async () => {
    const r = await verifyDeployedPage('https://aside.example', {
      backend: 'aside',
      runAside: async () => ({ stdout: 'Opened a new tab\n{"title":"","bodyLength":0,"unloadedImageCount":2,"screenshotBytes":7}\n[ok | 1ms]' }),
    });
    expect(r.unmeasured).toEqual(['javascript-errors']);
    expect(r.structuredFindings?.map(({ kind }) => kind)).toEqual(['empty-body', 'unloaded-image', 'empty-title']);
  });

  test('aside가 안 떠 있으면 stderr와 rc를 사용해 페이지 오류 대신 hint·미측정 skip으로 보고한다', async () => {
    const url = 'https://aside.example';
    const calls: Array<{ url: string; kind: string }> = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => {
      if (event === 'verify-aside-skipped') calls.push(data as { url: string; kind: string });
    });
    try {
      const r = await verifyDeployedPage(url, {
        backend: 'aside',
        runAside: async () => ({ stdout: '', stderr: "Failed to request daemon auth challenge: The operation was aborted due to timeout\nAside isn't running on this machine.", exitCode: 1 }),
      });
      expect(r).toEqual({ ok: false, url, skipped: 'aside-not-running', findings: ['Aside 브라우저가 안 떠 있음 — Aside 브라우저를 켜고 다시 · 또는 `aside exec --host <host>`'], unmeasured: ['javascript-errors', 'screenshot'] });
      expect(r.structuredFindings).toBeUndefined();
      expect(r.screenshotBytes).toBeUndefined();
      expect(calls).toEqual([{ url, kind: 'not-running' }]);
      const report = formatVerifyUrlReport(url, r).join('\n');
      expect(report).toContain('⚪ Aside 검증 건너뜀');
      expect(report).not.toContain('⚠️ 문제 감지');
      expect(report).toContain('Aside 브라우저가 안 떠 있음');
      expect(report).toContain('스크린샷: 못 쟀다');
      expect(report).not.toContain('스크린샷: 0 bytes');
    } finally {
      log.mockRestore();
    }
  });

  test('daemon auth challenge timeout만 있으면 같은 skip이며 kind는 auth-timeout', async () => {
    const calls: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => {
      if (event === 'verify-aside-skipped') calls.push((data as { kind: string }).kind);
    });
    try {
      const r = await verifyDeployedPage('https://aside.example', {
        backend: 'aside',
        runAside: async () => ({ stdout: '', stderr: 'Failed to request daemon auth challenge: The operation was aborted due to timeout', exitCode: 1 }),
      });
      expect(r.skipped).toBe('aside-not-running');
      expect(r.ok).toBe(false);
      expect(r.unmeasured).toEqual(['javascript-errors', 'screenshot']);
      expect(r.findings[0]).toContain('Aside 브라우저를 켜고 다시');
      expect(r.structuredFindings).toBeUndefined();
      expect(calls).toEqual(['auth-timeout']);
    } finally {
      log.mockRestore();
    }
  });

  test('aside 기본 executor도 stderr의 앱 부재를 skip으로 전달한다', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aside-not-running-'));
    const command = join(directory, 'aside');
    await writeFile(command, '#!/bin/sh\necho "Aside isn\x27t running on this machine." >&2\nexit 1\n', 'utf8');
    await chmod(command, 0o755);
    try {
      const r = await verifyDeployedPage('https://aside.example', { backend: 'aside', asideCommand: command });
      expect(r.skipped).toBe('aside-not-running');
      expect(r.structuredFindings).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('aside 실행 파일 부재는 no-aside로 fail-soft skip한다', async () => {
    const r = await verifyDeployedPage('https://aside.example', {
      backend: 'aside',
      runAside: async () => { const error = new Error('missing') as NodeJS.ErrnoException; error.code = 'ENOENT'; throw error; },
    });
    expect(r).toEqual({ ok: false, url: 'https://aside.example', findings: [], skipped: 'no-aside', unmeasured: ['javascript-errors'] });
  });

  test('aside 기본 executor는 stdout이 빈 ENOENT spawn 실패를 no-aside skip으로 전달한다', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aside-missing-'));
    try {
      const r = await verifyDeployedPage('https://aside.example', { backend: 'aside', asideCommand: join(directory, 'missing-aside') });
      expect(r).toEqual({ ok: false, url: 'https://aside.example', findings: [], skipped: 'no-aside', unmeasured: ['javascript-errors'] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('aside timeout은 실행 심에 전달되고 검증 오류로 반환한다', async () => {
    const r = await verifyDeployedPage('https://aside.example', {
      backend: 'aside',
      asideTimeoutMs: 12,
      runAside: async (_command, _args, options) => { expect(options.timeout).toBe(12); throw new Error('timed out'); },
    });
    expect(r.findings[0]).toContain('aside 검증 오류: timed out');
    expect(r.structuredFindings).toContainEqual(expect.objectContaining({ kind: 'aside-error', certainty: 'confirmed' }));
    expect(r.structuredFindings?.map(({ kind }) => kind)).not.toContain('cdp-error');
    expect(r.unmeasured).toEqual(['javascript-errors']);
  });

  test('aside는 ANSI로 감싼 성공 표지와 JSON을 정상으로 판정한다', async () => {
    const r = await verifyDeployedPage('https://aside.example', {
      backend: 'aside',
      runAside: async () => ({ stdout: '\x1b[2m{"title":"Aside page","bodyLength":88,"unloadedImageCount":0,"screenshotBytes":11}\x1b[0m\n\x1b[2m[ok | 12ms]\x1b[0m' }),
    });
    expect(r).toEqual({ ok: true, url: 'https://aside.example', title: 'Aside page', bodyLength: 88, screenshotBytes: 11, findings: [], unmeasured: ['javascript-errors'] });
  });

  test('aside는 ANSI로 감싼 실패 표지를 aside-error로 판정한다', async () => {
    const r = await verifyDeployedPage('https://aside.example', {
      backend: 'aside',
      runAside: async () => ({ stdout: 'ReferenceError: missingFn is not defined\n\x1b[2m[error | 12ms]\x1b[0m' }),
    });
    expect(r.findings[0]).toContain('aside repl reported error (repl-error)');
    expect(r.structuredFindings).toEqual([expect.objectContaining({ kind: 'aside-error', certainty: 'confirmed' })]);
  });

  test('aside는 ANSI 출력에도 완료 표지가 없으면 aside-error로 판정한다', async () => {
    const r = await verifyDeployedPage('https://aside.example', {
      backend: 'aside',
      runAside: async () => ({ stdout: '\x1b[2m{"title":"Aside page","bodyLength":88,"unloadedImageCount":0,"screenshotBytes":11}\x1b[0m' }),
    });
    expect(r.findings[0]).toContain('aside observation output missing completion marker (no-marker)');
    expect(r.structuredFindings).toEqual([expect.objectContaining({ kind: 'aside-error', certainty: 'confirmed' })]);
  });

  test('aside JSON 파싱 실패는 cdp-error가 아닌 aside-error로 보고한다', async () => {
    const r = await verifyDeployedPage('https://aside.example', {
      backend: 'aside',
      runAside: async () => ({ stdout: '✔︎ Opened a new tab and set it active\n[ok | 818ms]\n' }),
    });
    expect(r.findings[0]).toContain('aside observation output missing JSON');
    expect(r.structuredFindings).toContainEqual(expect.objectContaining({ kind: 'aside-error', certainty: 'confirmed' }));
    expect(r.structuredFindings?.map(({ kind }) => kind)).not.toContain('cdp-error');
    expect(r.unmeasured).toEqual(['javascript-errors']);
  });

  test.each([
    '{}',
    '{"title":"page","bodyLength":1,"unloadedImageCount":0}',
    '{"title":1,"bodyLength":1,"unloadedImageCount":0,"screenshotBytes":1}',
    '{"title":"page","bodyLength":-1,"unloadedImageCount":0,"screenshotBytes":1}',
    '{"title":"page","bodyLength":1,"unloadedImageCount":"zero","screenshotBytes":1}',
    '{"title":"page","bodyLength":1,"unloadedImageCount":0,"screenshotBytes":null}',
  ])('aside 관측 JSON의 필수 필드·유한 비음수 수치를 검증한다: %s', async (stdout) => {
    const r = await verifyDeployedPage('https://aside.example', {
      backend: 'aside',
      runAside: async () => ({ stdout: `${stdout}\n[ok | 1ms]` }),
    });
    expect(r.structuredFindings).toEqual([expect.objectContaining({ kind: 'aside-error', certainty: 'confirmed' })]);
    expect(r.unmeasured).toEqual(['javascript-errors']);
  });

  test('aside 임시 디렉터리 준비 실패는 예외 누출 없이 aside-error로 반환하고 정리하지 않는다', async () => {
    let cleanupCalls = 0;
    const r = await verifyDeployedPage('https://aside.example', {
      backend: 'aside',
      createAsideTemporaryDirectory: async () => { throw new Error('mkdtemp boom'); },
      cleanupAsideTemporaryDirectory: async () => { cleanupCalls++; },
    });
    expect(r.structuredFindings).toEqual([expect.objectContaining({ kind: 'aside-error', message: expect.stringContaining('mkdtemp boom') })]);
    expect(cleanupCalls).toBe(0);
  });

  test('aside 파일 준비 ENOENT는 no-aside가 아니라 aside-error로 반환한다', async () => {
    const r = await verifyDeployedPage('https://aside.example', {
      backend: 'aside',
      writeAsideScript: async () => { const error = new Error('write missing') as NodeJS.ErrnoException; error.code = 'ENOENT'; throw error; },
    });
    expect(r.skipped).toBeUndefined();
    expect(r.structuredFindings).toEqual([expect.objectContaining({ kind: 'aside-error', message: expect.stringContaining('write missing') })]);
  });

  test('aside 임시 파일 정리 실패는 성공 관측 결과를 덮어쓰지 않는다', async () => {
    let temporaryDirectory = '';
    const r = await verifyDeployedPage('https://aside.example', {
      backend: 'aside',
      runAside: async () => ({ stdout: '{"title":"Aside page","bodyLength":88,"unloadedImageCount":0,"screenshotBytes":11}\n[ok | 1ms]' }),
      cleanupAsideTemporaryDirectory: async (directory) => {
        temporaryDirectory = directory;
        await rm(directory, { recursive: true, force: true });
        throw new Error('cleanup boom');
      },
    });
    expect(existsSync(temporaryDirectory)).toBe(false);
    expect(r).toEqual({ ok: true, url: 'https://aside.example', title: 'Aside page', bodyLength: 88, screenshotBytes: 11, findings: [], unmeasured: ['javascript-errors'] });
  });

  test('aside 임시 파일 정리 실패는 no-aside skip을 덮어쓰지 않는다', async () => {
    let temporaryDirectory = '';
    const r = await verifyDeployedPage('https://aside.example', {
      backend: 'aside',
      runAside: async () => { const error = new Error('missing') as NodeJS.ErrnoException; error.code = 'ENOENT'; throw error; },
      cleanupAsideTemporaryDirectory: async (directory) => {
        temporaryDirectory = directory;
        await rm(directory, { recursive: true, force: true });
        throw new Error('cleanup boom');
      },
    });
    expect(existsSync(temporaryDirectory)).toBe(false);
    expect(r).toEqual({ ok: false, url: 'https://aside.example', findings: [], skipped: 'no-aside', unmeasured: ['javascript-errors'] });
  });
});

describe('포착이 «영영 안 올» 때 (2026-08-28)', () => {
  // ⛔ 이 시험은 「소스에 시한이 적혀 있나」가 아니라 ***「멎어도 함수가 돌아오나」***를 문다.
  //    ⇒ 시한을 지워도 «통과하면» 이 시험은 무효다. 실제로 그것을 아래에서 한 번 확인했다.

  test('screenshot 이 안 돌아와도 «판정은 돌아온다» — 제목·본문은 살고 screenshot 만 못 잰 것으로', async () => {
    const started = Date.now();
    const r = await verifyDeployedPage('https://stall.example', {
      connect: async () => ({
        ...fakeClient({ title: '멎어도 보이는 제목', bodyLen: 800 }),
        // 던지지 «않는다» — 영영 안 온다. try/catch 로는 못 잡는 실패다.
        screenshot: () => new Promise<Buffer>(() => {}),
      } as CdpClient),
      captureTimeoutMs: 40,
    });
    expect(Date.now() - started).toBeLessThan(4_000); // 시한이 없으면 원시 기본 120초까지 멎는다
    expect(r.ok).toBe(true);                          // 화면을 못 얻은 것이 «렌더 실패»는 아니다
    expect(r.title).toBe('멎어도 보이는 제목');
    expect(r.bodyLength).toBe(800);
    expect(r.screenshotBytes).toBe(0);
    expect(r.unmeasured).toEqual(['screenshot']);     // ⭐ 「0바이트」와 「못 쟀다」를 다른 값으로
  });

  test('멎은 포착은 onScreenshot 을 «부르지 않는다» — 없는 그림을 있다고 넘기지 않는다', async () => {
    let calls = 0;
    await verifyDeployedPage('https://stall2.example', {
      connect: async () => ({ ...fakeClient(), screenshot: () => new Promise<Buffer>(() => {}) } as CdpClient),
      captureTimeoutMs: 40,
      onScreenshot: () => { calls += 1; },
    });
    expect(calls).toBe(0);
  });

  test('screenshot 이 «던지면» 그때도 판정은 산다(멎음과 다른 갈래)', async () => {
    const r = await verifyDeployedPage('https://throw.example', {
      connect: async () => ({
        ...fakeClient({ title: '던져도 보이는 제목', bodyLen: 500 }),
        async screenshot(): Promise<Buffer> { throw new Error('target closed'); },
      } as CdpClient),
      captureTimeoutMs: 40,
    });
    expect(r.title).toBe('던져도 보이는 제목');
    expect(r.unmeasured).toEqual(['screenshot']);
  });

  test('포착이 «제때 오면» 못 잰 축은 비어 있다(시험이 늘 참이 되지 않게)', async () => {
    const r = await verifyDeployedPage('https://ok.example', {
      connect: async () => fakeClient({ title: 'ok', bodyLen: 500 }),
      captureTimeoutMs: 40,
    });
    expect(r.unmeasured).toBeUndefined();
    expect(r.screenshotBytes).toBe(7);
  });
});

describe('formatVerifyUrlReport — «표면이 그 구분을 보여 주나» (2026-08-28)', () => {
  const base = { ok: true, url: 'https://x.test', title: 'T', bodyLength: 42, screenshotBytes: 5, findings: [] };

  test('못 잰 축이 있으면 «그 이름으로» 찍는다 — 0바이트와 뭉치지 않는다', () => {
    const lines = formatVerifyUrlReport('https://x.test', { ...base, screenshotBytes: 0, unmeasured: ['screenshot'] });
    expect(lines.join('\n')).toContain('⚪ 못 쟀다: screenshot');
  });

  test('못 잰 축이 «둘»이면 «둘 다» 찍는다 — 하나로 접지 않는다', () => {
    const lines = formatVerifyUrlReport('https://x.test', { ...base, unmeasured: ['javascript-errors', 'screenshot'] });
    expect(lines.filter((l) => l.includes('못 쟀다'))).toHaveLength(2);
  });

  test('다 쟀으면 그 줄이 «없다» — 늘 참인 시험이 되지 않게', () => {
    expect(formatVerifyUrlReport('https://x.test', base).join('\n')).not.toContain('못 쟀다');
  });

  test('--shot 을 줬는데 «못 썼으면» 그렇다고 말한다 — 없는 파일을 있다고 하지 않는다', () => {
    const lines = formatVerifyUrlReport('https://x.test', base, { path: '/tmp/a.png', written: false });
    expect(lines.join('\n')).toContain('⛔ 못 씀(/tmp/a.png)');
    expect(lines.join('\n')).not.toContain('→ /tmp/a.png');
  });

  test('--shot 을 «썼으면» 경로를 그대로 말한다', () => {
    expect(formatVerifyUrlReport('https://x.test', base, { path: '/tmp/a.png', written: true }).join('\n'))
      .toContain('→ /tmp/a.png');
  });

  test('--shot 을 «안 줬으면» 그 칸이 아예 없다', () => {
    const joined = formatVerifyUrlReport('https://x.test', base).join('\n');
    expect(joined).not.toContain('→');
    expect(joined).not.toContain('못 씀');
  });

  test('기존 네 줄의 «모양»은 그대로다 — 봇 루틴이 `✅ 렌더 정상` 을 문다', () => {
    expect(formatVerifyUrlReport('https://x.test', base).slice(0, 4)).toEqual([
      '\n━━ 배포 검증: https://x.test ━━', '  ✅ 렌더 정상', '  title: T', '  본문 길이: 42 · 스크린샷: 5 bytes',
    ]);
  });
});
