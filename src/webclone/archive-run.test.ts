// ── 🩸 「아무것도 못 얻었는데 종료 0」 을 무는 시험 ────────────────────────────

import { spawnSync as nativeSpawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { debug } from '../debug/log.js';
import { visibleTextLength } from './clone-fidelity.js';
import { archiveObtainedNothing, classifyDocumentLinks, classifyMirrorCollapse, createDisabledMirrorCopy, deriveSiblingHostAllowlist, diagnoseMirrorEntryLinks, disableMirrorDocumentScripts, exactHostAcceptRegex, formatArchiveRecord, measureRenderedMirror, REMOTE_DOMINANCE_LINK_RATIO, runArchive, waitForRenderSettling, type ArchiveOptions, type ArchiveRecord , mirrorEntryCandidates
} from './archive-run.js';

type LogCall = { category: string; event: string; data?: unknown; options?: unknown };

function captureDebugLog(): { logs: LogCall[]; restore: () => void } {
  const logs: LogCall[] = [];
  const originalLog = debug.log;
  (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown, options?: unknown) => {
    logs.push({ category, event, data, options });
  }) as typeof debug.log;
  return { logs, restore: () => { (debug as { log: typeof debug.log }).log = originalLog; } };
}

const base: ArchiveRecord = {
  slug: 's', url: 'u', out: 'o', dbPath: 'd', capturedAt: 't', title: null,
  originFiles: 13, mirrorOk: true, mirrorCompletion: 'completed', mirrorExitCode: 0, mirrorDepth: 1,
  fullPageScreenshot: { bytes: 2_350_000, dimensions: '1280x4651' },
  tokens: 96, derived: ['DESIGN.md'], uploaded: [], notes: [], archiveNote: '', archivedCount: 0, archivePartial: false,
  renderLocation: 'server', entryPath: '/archive/origin/index.html',
  mirrorEntryLinks: { localAssetLinks: 4, externalLinks: 1 }, mirrorEntryLinkDiagnosis: 'self-contained',
  visibleText: { mirrored: 1664, rendered: 1701, mirrorRendered: 1664 }, mirrorLiveTextRatio: 1664 / 1701, mirrorCollapse: 'intact',
  renderSettling: { status: 'settled', finalLength: 1701, observations: 4, waitedMs: 1500 },
  renderedSnapshot: null, disabledMirrorCopy: null, canvasCount: null,
  integrity: { checked: 13, broken: [], brokenRatio: 0 },
};

describe('렌더 정착 판정', () => {
  const html = (text: string) => `<main>${text}</main>`;

  test('한 번 증가한 뒤 연속 무증가면 상한 전에 settled로 남긴다', async () => {
    const samples = [html('shell'), html('fully rendered content'), html('fully rendered content'), html('fully rendered content')];
    const waits: number[] = [];
    const result = await waitForRenderSettling(
      async () => samples.shift() ?? html('fully rendered content'),
      async (ms) => { waits.push(ms); },
      10, 2, 100,
    );
    expect(result.status).toBe('settled');
    expect(result.waitedMs).toBe(30);
    expect(result.waitedMs).toBeLessThan(100);
    expect(result.finalLength).toBe(22);
    expect(waits).toEqual([10, 10, 10]);
  });

  test('처음부터 끝까지 증가하지 않으면 never-grew로 남긴다', async () => {
    const result = await waitForRenderSettling(
      async () => html('shell'), async () => {}, 10, 2, 30,
    );
    expect(result.status).toBe('never-grew');
    expect(result.waitedMs).toBe(30);
  });

  test('계속 증가하면 capped로 남긴다', async () => {
    let size = 1;
    const result = await waitForRenderSettling(
      async () => html('x'.repeat(size++)), async () => {}, 10, 2, 30,
    );
    expect(result.status).toBe('capped');
    expect(result.waitedMs).toBe(30);
  });

  test('모든 프로브가 실패하면 마지막 오류를 전파한다', async () => {
    const firstError = new Error('first CDP probe');
    const lastError = new Error('last CDP probe');
    const failures = [firstError, lastError];
    const waits: number[] = [];

    await expect(waitForRenderSettling(
      async () => { throw failures.shift() ?? lastError; },
      async (ms) => { waits.push(ms); },
      10, 2, 30,
    )).rejects.toBe(lastError);
    expect(waits).toEqual([10, 10, 10]);
  });

  test('개별 프로브 실패를 건너뛰되 기존 대기 cadence와 settled 규칙을 유지한다', async () => {
    const samples = [html('shell'), new Error('transient CDP probe'), html('fully rendered content'), html('fully rendered content'), html('fully rendered content')];
    const waits: number[] = [];
    const result = await waitForRenderSettling(
      async () => {
        const sample = samples.shift() ?? html('fully rendered content');
        if (sample instanceof Error) throw sample;
        return sample;
      },
      async (ms) => { waits.push(ms); },
      10, 2, 100,
    );
    expect(result).toMatchObject({ status: 'settled', finalLength: 22, observations: 4, waitedMs: 40 });
    expect(waits).toEqual([10, 10, 10, 10]);
  });

  test.each([
    ['intervalMs', 0, 2, 30],
    ['stableObservations', 10, 0, 30],
    ['maxWaitMs', 10, 2, 0],
  ])('유효하지 않은 %s는 상한을 우회하기 전에 거부한다', async (_name, intervalMs, stableObservations, maxWaitMs) => {
    await expect(waitForRenderSettling(async () => html('shell'), async () => {}, intervalMs, stableObservations, maxWaitMs))
      .rejects.toThrow('render settling');
  });
});

describe('runArchive 관측', () => {
  test('정착 관측을 한 번만 수행하고 같은 최종 DOM을 레코드·스냅샷·캡처에 공유한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-settling-'));
    const dbPath = join(root, 'webclone.db');
    const timeline: string[] = [];
    const bodies = [
      '<main>shell</main>',
      '<main>fully rendered content</main>',
      '<main>fully rendered content</main>',
      '<main>fully rendered content</main>',
    ];
    const cdpClient = {
      navigate: async () => ({ errorText: undefined }),
      evaluate: async (expression: string) => {
        if (expression === "document.documentElement?.outerHTML ?? ''") {
          timeline.push('measure');
          return bodies.shift() ?? '<main>fully rendered content</main>';
        }
        if (expression === 'document.title') return 'Rendered';
        if (expression.includes('querySelectorAll')) return 0;
        return { customProperties: {}, roles: {}, honoursReducedMotion: false, viewport: null };
      },
      screenshot: async () => { timeline.push('screenshot'); return new Uint8Array([1, 2, 3]); },
      close: async () => {},
    };
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') writeFileSync(join(args.at(-2)!, 'index.html'), '<main>shell</main>');
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof nativeSpawnSync;
    const options: ArchiveOptions = {
      url: 'https://example.test/rendered', outRoot: root, dbPath, spawnSync,
      discoverChromeBinary: () => '/fake/chrome',
      createCdpClient: (async () => ({ close: async () => {} })) as unknown as typeof import('../browser-cdp/client.js').createCdpClient,
      createCdpClientFromEndpoint: (async () => cdpClient) as unknown as typeof import('../browser-cdp/client.js').createCdpClientFromEndpoint,
      renderSettlingWait: async () => { timeline.push('wait'); },
      renderSettlingConfig: { intervalMs: 10, stableObservations: 2, maxWaitMs: 100 },
    };
    try {
      const result = await runArchive(options);
      expect(result.renderSettling).toMatchObject({ status: 'settled', finalLength: 22, observations: 4, waitedMs: 30 });
      expect(result.visibleText.rendered).toBe(result.renderSettling!.finalLength);
      expect(timeline).toEqual(['measure', 'wait', 'measure', 'wait', 'measure', 'wait', 'measure', 'screenshot']);
      expect(readFileSync(join(result.out, 'origin', 'rendered.html'), 'utf8')).toContain('fully rendered content');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('첫 렌더 probe가 실패해도 뒤의 성공 probe는 측정된 렌더 길이를 보존한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-retry-render-probe-'));
    const dbPath = join(root, 'webclone.db');
    const shell = '<main>shell</main>';
    const rendered = '<main>fully rendered content</main>';
    const bodies = [shell, rendered, rendered];
    const probeSequence: string[] = [];
    const waits: number[] = [];
    let renderProbeCount = 0;
    const cdpClient = {
      navigate: async () => ({ errorText: undefined }),
      evaluate: async (expression: string) => {
        // ⛔ 정확 일치로 물지 않는다 — 실행부가 방어적 형태(`?.` ⊕ `?? ''`)로 바뀐 적이 있고,
        //    그때 이 목이 «조용히» 안 물어 probe 수가 0이 됐다(2026-09-09 실측: 병합 뒤 main 이 빨개졌다).
        if (expression.includes('outerHTML')) {
          renderProbeCount += 1;
          if (renderProbeCount === 1) {
            probeSequence.push('throw');
            throw new Error('first render probe failed');
          }
          const body = bodies.shift() ?? rendered;
          probeSequence.push(body === shell ? 'shell' : 'rendered');
          return body;
        }
        if (expression === 'document.title') return 'Rendered';
        if (expression.includes('querySelectorAll')) return 0;
        return { customProperties: {}, roles: {}, honoursReducedMotion: false, viewport: null };
      },
      screenshot: async () => new Uint8Array([1, 2, 3]),
      close: async () => {},
    };
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') writeFileSync(join(args.at(-2)!, 'index.html'), '<main>shell</main>');
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof nativeSpawnSync;
    const options: ArchiveOptions = {
      url: 'https://example.test/retry-render-probe', outRoot: root, dbPath, spawnSync,
      discoverChromeBinary: () => '/fake/chrome',
      createCdpClient: (async () => ({ close: async () => {} })) as unknown as typeof import('../browser-cdp/client.js').createCdpClient,
      createCdpClientFromEndpoint: (async () => cdpClient) as unknown as typeof import('../browser-cdp/client.js').createCdpClientFromEndpoint,
      renderSettlingWait: async (ms) => { waits.push(ms); },
      renderSettlingConfig: { intervalMs: 1, stableObservations: 1, maxWaitMs: 4 },
    };
    try {
      const result = await runArchive(options);
      expect(renderProbeCount).toBe(4);
      expect(probeSequence).toEqual(['throw', 'shell', 'rendered', 'rendered']);
      expect(waits).toEqual([1, 1, 1]);
      expect(result.renderSettling).toMatchObject({ status: 'settled', finalLength: 22, observations: 3, waitedMs: 3 });
      expect(result.visibleText.rendered).toBe(22);
      expect(result.visibleText.rendered).toBe(result.renderSettling!.finalLength);
      expect(readFileSync(join(result.out, 'origin', 'rendered.html'), 'utf8')).toBe(rendered);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('CDP 오류의 읽을 수 있는 사유를 남기되 미러 완료와 실행 성공을 보존한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-cdp-message-'));
    const dbPath = join(root, 'webclone.db');
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') writeFileSync(join(args.at(-2)!, 'index.html'), '<main>mirror survives</main>');
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof nativeSpawnSync;
    const cdpClient = {
      navigate: async () => {
        throw {
          message: 'TypeError: Cannot read rendered DOM',
          toString: () => { throw new Error('message-bearing CDP failure must not serialize'); },
        };
      },
      close: async () => {},
    };
    try {
      const result = await runArchive({
        url: 'https://example.test/cdp-message', outRoot: root, dbPath, spawnSync,
        discoverChromeBinary: () => '/fake/chrome',
        createCdpClient: (async () => ({ close: async () => {} })) as unknown as typeof import('../browser-cdp/client.js').createCdpClient,
        createCdpClientFromEndpoint: (async () => cdpClient) as unknown as typeof import('../browser-cdp/client.js').createCdpClientFromEndpoint,
      });
      expect(result.notes).toContain('CDP 단계 실패: TypeError: Cannot read rendered DOM — 미러는 남는다');
      expect(result.mirrorCompletion).toBe('completed');
      expect(result.mirrorOk).toBe(true);
      expect(result.originFiles).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('message getter가 던져도 CDP 오류를 직렬화해 미러를 보존한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-cdp-message-getter-'));
    const dbPath = join(root, 'webclone.db');
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') writeFileSync(join(args.at(-2)!, 'index.html'), '<main>mirror survives</main>');
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof nativeSpawnSync;
    const error = {
      get message(): never { throw new Error('message getter failed'); },
      toString: () => 'CDP envelope: readable fallback',
    };
    const cdpClient = {
      navigate: async () => { throw error; },
      close: async () => {},
    };
    try {
      const result = await runArchive({
        url: 'https://example.test/cdp-message-getter', outRoot: root, dbPath, spawnSync,
        discoverChromeBinary: () => '/fake/chrome',
        createCdpClient: (async () => ({ close: async () => {} })) as unknown as typeof import('../browser-cdp/client.js').createCdpClient,
        createCdpClientFromEndpoint: (async () => cdpClient) as unknown as typeof import('../browser-cdp/client.js').createCdpClientFromEndpoint,
      });
      expect(result.notes).toContain('CDP 단계 실패: CDP envelope: readable fallback — 미러는 남는다');
      expect(result.mirrorCompletion).toBe('completed');
      expect(result.mirrorOk).toBe(true);
      expect(result.originFiles).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('사유 없는 긴 CDP 오류는 직렬화 fallback의 절단을 밝힌다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-cdp-fallback-'));
    const dbPath = join(root, 'webclone.db');
    const envelope = `CDP envelope: ${'machine-data '.repeat(30)}`;
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') writeFileSync(join(args.at(-2)!, 'index.html'), '<main>mirror survives</main>');
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof nativeSpawnSync;
    const cdpClient = {
      navigate: async () => { throw { toString: () => envelope }; },
      close: async () => {},
    };
    try {
      const result = await runArchive({
        url: 'https://example.test/cdp-fallback', outRoot: root, dbPath, spawnSync,
        discoverChromeBinary: () => '/fake/chrome',
        createCdpClient: (async () => ({ close: async () => {} })) as unknown as typeof import('../browser-cdp/client.js').createCdpClient,
        createCdpClientFromEndpoint: (async () => cdpClient) as unknown as typeof import('../browser-cdp/client.js').createCdpClientFromEndpoint,
      });
      const note = result.notes.find((entry) => entry.startsWith('CDP 단계 실패:'));
      expect(note).toContain('CDP envelope:');
      expect(note).toContain('…(절단됨)');
      expect(note).toEndWith(' — 미러는 남는다');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('CDP 성공 실행에는 실패 note를 추가하지 않는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-cdp-success-'));
    const dbPath = join(root, 'webclone.db');
    const cdpClient = {
      navigate: async () => ({ errorText: undefined }),
      evaluate: async (expression: string) => {
        if (expression === "document.documentElement?.outerHTML ?? ''") return '<main>rendered</main>';
        if (expression === 'document.title') return 'Rendered';
        if (expression.includes('querySelectorAll')) return 0;
        return { customProperties: {}, roles: {}, honoursReducedMotion: false, viewport: null };
      },
      screenshot: async () => new Uint8Array([1, 2, 3]),
      close: async () => {},
    };
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') writeFileSync(join(args.at(-2)!, 'index.html'), '<main>mirror</main>');
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof nativeSpawnSync;
    try {
      const result = await runArchive({
        url: 'https://example.test/cdp-success', outRoot: root, dbPath, spawnSync,
        discoverChromeBinary: () => '/fake/chrome',
        createCdpClient: (async () => ({ close: async () => {} })) as unknown as typeof import('../browser-cdp/client.js').createCdpClient,
        createCdpClientFromEndpoint: (async () => cdpClient) as unknown as typeof import('../browser-cdp/client.js').createCdpClientFromEndpoint,
        renderSettlingWait: async () => {},
        renderSettlingConfig: { intervalMs: 1, stableObservations: 1, maxWaitMs: 2 },
      });
      expect(result.notes.some((entry) => entry.startsWith('CDP 단계 실패:'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('성공 시 URL·보관 결과·경과 시간을 done 이벤트로 남긴다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-observation-'));
    const page = join(root, 'page.html');
    const dbPath = join(root, 'webclone.db');
    writeFileSync(page, '<!doctype html><title>observation</title><style>:root { --brand: #112233; }</style><main>ok</main>');
    const { logs, restore } = captureDebugLog();
    try {
      const url = new URL(`file://${page}`).href;
      const spawnSync = ((command: string, args: string[]) => {
        if (command === 'wget') writeFileSync(join(args.at(-2)!, 'index.html'), '<!doctype html><title>mirror</title><main>ok</main>');
        return { status: 0, stdout: '', stderr: '' };
      }) as typeof import('node:child_process').spawnSync;
      const result = await runArchive({ url, outRoot: root, dbPath, spawnSync, skipBrowserCapture: true });
      const done = logs.find((log) => log.category === 'webclone.archive' && log.event === 'done');
      expect(done).toBeDefined();
      expect(done?.data).toMatchObject({
        url,
        slug: result.slug,
        originCount: result.originFiles,
        capturedBytes: result.fullPageScreenshot.bytes,
        mirrorCompletion: result.mirrorCompletion,
        mirrorDepth: result.mirrorDepth,
        uploaded: result.uploaded,
        archiveBucket: null,
      });
      expect((done?.data as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(0);
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('done 로거가 던져도 성공 결과를 반환하고 failed를 남기지 않는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-done-logger-failure-'));
    const page = join(root, 'page.html');
    const dbPath = join(root, 'webclone.db');
    writeFileSync(page, '<!doctype html><title>done logger failure</title><main>ok</main>');
    const originalLog = debug.log;
    const events: string[] = [];
    (debug as { log: typeof debug.log }).log = ((_category, event) => {
      events.push(event);
      if (event === 'done') throw new Error('logger failed');
    }) as typeof debug.log;
    try {
      const result = await runArchive({ url: new URL(`file://${page}`).href, outRoot: root, dbPath, skipBrowserCapture: true });
      expect(result.slug).toBeDefined();
      expect(events).toEqual(['done']);
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('초기 실패를 error-level failed 이벤트로 남기고 같은 예외를 재전파한다', async () => {
    const { logs, restore } = captureDebugLog();
    const url = 'https://example.invalid/archive-failure';
    const sentinel = new Error('archive sentinel failure');
    const options = {
      url,
      get outRoot(): string { throw sentinel; },
    };
    try {
      const error = await runArchive(options).catch((caught: unknown) => caught);
      expect(error).toBe(sentinel);
      const failed = logs.find((log) => log.category === 'webclone.archive' && log.event === 'failed');
      const loggedError = (failed?.data as { error: unknown }).error;
      expect(typeof loggedError).toBe('string');
      expect(loggedError).toContain(sentinel.message);
      expect(failed?.data).toMatchObject({ url });
      expect(failed?.options).toEqual({ level: 'error' });
    } finally {
      restore();
    }
  });

  test('failed 로거가 던져도 원래 오류를 재전파한다', async () => {
    const originalLog = debug.log;
    let loggedError: unknown;
    (debug as { log: typeof debug.log }).log = ((_category, _event, data) => {
      loggedError = (data as { error: unknown }).error;
      throw new Error('logger failed');
    }) as typeof debug.log;
    try {
      const error = await runArchive({
        url: 'https://example.invalid/archive-logger-failure', outRoot: '/dev/null',
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('ENOTDIR');
      expect(loggedError).toBe(String(error));
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  });
});

describe('archiveObtainedNothing', () => {
  test('🩸 전부 실패한 판을 «문다» — 실측: 없는 호스트가 종료 0 을 냈다', () => {
    expect(archiveObtainedNothing({
      ...base, originFiles: 0, mirrorOk: false, tokens: null,
      fullPageScreenshot: { bytes: 0, dimensions: '못 쟀다' },
    })).toBe(true);
  });

  test('✅ 온전한 판은 «안» 문다', () => {
    expect(archiveObtainedNothing(base)).toBe(false);
  });

  test('⛔ «부분» 실패는 아니다 — 미러가 살면 보관본은 있다', () => {
    expect(archiveObtainedNothing({
      ...base, tokens: null, fullPageScreenshot: { bytes: 0, dimensions: '못 쟀다' },
    })).toBe(false);   // originFiles 13 이 남아 있다
  });

  test('⛔ 캡처만 살아도 아니다 — 「하나라도 얻었나」가 기준이다', () => {
    expect(archiveObtainedNothing({ ...base, originFiles: 0, mirrorOk: false, tokens: null }))
      .toBe(false);    // 캡처 바이트가 있다
  });
});

// ── 🩸 「껍데기를 받고도 성공처럼 보인다」 ────────────────────────────────────
//
// 실측 2026-09-08: excalidraw.com 을 보관했더니 원문 **11개** · 캡처 **50KB** · 토큰 **24** 로
// 산출이 «성공처럼» 보였는데, 미러한 html 의 보이는 글자는 ***79자***였고 그 내용이
// *"You need to enable JavaScript to run this app."* 였다. ⛔ 도구는 «아무 말도 안 했다».
describe('미러 브라우저 재열기', () => {
  test('미러 사본은 script 시작 태그만 무력화하고 자산 주소와 인접 문서를 보존한다', () => {
    const source = '<!doctype html><link href="assets/site.css"><script src="assets/app.js"></script><img src="images/hero.png"><script type="module">boot()</script><main>same</main>';
    const disabled = disableMirrorDocumentScripts(source);
    expect(disabled.frozenScripts).toBe(2);
    expect(disabled.html).toBe('<!doctype html><link href="assets/site.css"><script type="application/x-archived" src="assets/app.js"></script><img src="images/hero.png"><script type="application/x-archived">boot()</script><main>same</main>');
  });

  test('선택한 미러 문서 옆에 식별 가능한 비활성 사본을 쓰고 자산 주소를 보존한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-disabled-mirror-copy-'));
    const entryPath = join(root, 'origin', 'index.html');
    const source = '<link href="assets/site.css"><script src="assets/app.js"></script><img src="images/hero.png"><main>same</main>';
    mkdirSync(join(root, 'origin'), { recursive: true });
    writeFileSync(entryPath, source);
    try {
      const copy = createDisabledMirrorCopy(entryPath, root);
      expect(copy).toEqual({ path: 'origin/index.scripts-disabled.html', frozenScripts: 1 });
      expect(readFileSync(join(root, copy.path), 'utf8')).toBe('<link href="assets/site.css"><script type="application/x-archived" src="assets/app.js"></script><img src="images/hero.png"><main>same</main>');
      expect(readFileSync(entryPath, 'utf8')).toBe(source);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('로드가 끝나도 대상 file URL이 아니면 이전 문서를 측정하지 않는다', async () => {
    let listener: ((event: { params: Record<string, unknown> }) => void) | null = null;
    const cdpClient = {
      on: (_method: string, registered: (event: { params: Record<string, unknown> }) => void) => {
        listener = registered;
        return () => { listener = null; };
      },
      navigate: async () => {
        queueMicrotask(() => listener?.({ params: { name: 'load', frameId: 'mirror-frame', loaderId: 'mirror-loader' } }));
        return { frameId: 'mirror-frame', loaderId: 'mirror-loader' };
      },
      evaluate: async (expression: string) => expression.includes('href: location.href')
        ? { href: 'https://example.test/previous-live-document', html: '<main>previous live document</main>' }
        : undefined,
    };
    await expect(measureRenderedMirror(cdpClient as any, '/tmp/archive origin/index.html')).resolves.toBeNull();
  });

  test('원문 절반은 intact이고 그 미만만 collapsed이며 측정 누락은 unmeasured다', () => {
    expect(classifyMirrorCollapse(10, 5)).toBe('intact');
    expect(classifyMirrorCollapse(10, 4)).toBe('collapsed');
    expect(classifyMirrorCollapse(10, null)).toBe('unmeasured');
    expect(classifyMirrorCollapse(null, 0)).toBe('unmeasured');
  });

  test('원문 절반 경계와 미측정을 구별하고 collapsed 진단·요약을 남긴다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-mirror-collapse-'));
    const dbPath = join(root, 'webclone.db');
    const live = '<main>live rendered content</main>';
    const mirror = '<link href="assets/site.css"><script src="assets/app.js"></script><main>0123456789</main><script type="module">boot()</script>';
    const cdpEvents: Array<{ method: string; params: Record<string, unknown> }> = [];
    let lifecycleListener: ((event: { method: string; params: Record<string, unknown> }) => void) | null = null;
    const cdpClient: any = {
      navigate: async () => ({ errorText: undefined }),
      evaluate: async () => undefined,
      screenshot: async () => new Uint8Array([1, 2, 3]),
      close: async () => {},
      on: (_method: string, listener: (event: { method: string; params: Record<string, unknown> }) => void) => {
        lifecycleListener = listener;
        return () => { lifecycleListener = null; };
      },
    };
    const navigations: string[] = [];
    let currentUrl = 'https://example.test/mirror-collapse';
    cdpClient.navigate = async (location: string) => {
      navigations.push(location);
      if (location.startsWith('file:')) {
        queueMicrotask(() => {
          currentUrl = location;
          const event = { method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'mirror-frame', loaderId: 'mirror-loader' } };
          cdpEvents.push(event);
          lifecycleListener?.(event);
        });
        return { frameId: 'mirror-frame', loaderId: 'mirror-loader', errorText: undefined };
      }
      return { frameId: 'live-frame', loaderId: 'live-loader', errorText: undefined };
    };
    let probes = 0;
    cdpClient.evaluate = async (expression: string) => {
      if (expression === "document.documentElement?.outerHTML ?? ''") {
        probes += 1;
        return probes <= 2 ? live : '<main>x</main>';
      }
      if (expression.includes('href: location.href')) return { href: currentUrl, html: '<main>x</main>' };
      if (expression === 'document.title') return 'Rendered';
      if (expression.includes('querySelectorAll')) return 0;
      if (expression.includes('document.fonts')) return undefined;
      return { customProperties: {}, roles: {}, honoursReducedMotion: false, viewport: null };
    };
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') writeFileSync(join(args.at(-2)!, 'index.html'), mirror);
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof nativeSpawnSync;
    try {
      const result = await runArchive({
        url: 'https://example.test/mirror-collapse', outRoot: root, dbPath, spawnSync,
        discoverChromeBinary: () => '/fake/chrome',
        createCdpClient: (async () => ({ close: async () => {} })) as unknown as typeof import('../browser-cdp/client.js').createCdpClient,
        createCdpClientFromEndpoint: (async () => cdpClient) as unknown as typeof import('../browser-cdp/client.js').createCdpClientFromEndpoint,
        renderSettlingWait: async () => {}, renderSettlingConfig: { intervalMs: 1, stableObservations: 1, maxWaitMs: 2 },
      });
      expect(result.entryPath).toBe(join(result.out, 'origin', 'index.html'));
      expect(navigations).toEqual(['https://example.test/mirror-collapse', new URL(`file://${result.entryPath}`).href]);
      expect(currentUrl).toBe(new URL(`file://${result.entryPath}`).href);
      expect(cdpEvents).toContainEqual({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'mirror-frame', loaderId: 'mirror-loader' } });
      expect(result.visibleText.mirrored).toBe(10);
      expect(result.visibleText.mirrorRendered).toBe(1);
      expect(result.mirrorLiveTextRatio).toBe(1);
      expect(result.mirrorCollapse).toBe('collapsed');
      expect(result.renderLocation).toBe('server');
      expect(result.renderedSnapshot).toMatchObject({ path: 'origin/rendered.html', trigger: 'mirror-collapse' });
      expect(readFileSync(join(result.out, 'origin', 'rendered.html'), 'utf8')).toContain('<main>x</main>');
      expect(result.disabledMirrorCopy).toEqual({ path: 'origin/index.scripts-disabled.html', frozenScripts: 2 });
      expect(readFileSync(join(result.out, result.disabledMirrorCopy!.path), 'utf8')).toBe('<link href="assets/site.css"><script type="application/x-archived" src="assets/app.js"></script><main>0123456789</main><script type="application/x-archived">boot()</script>');
      expect(result.notes.join('\n')).toContain('원문 HTML 10자 ↔ 브라우저로 연 미러 1자');
      expect(result.notes.join('\n')).toContain('원문 미러를 그냥 열면 본문이 줄어드니 origin/index.scripts-disabled.html 을 대신 열어라');
      expect(formatArchiveRecord(result).join('\n')).toContain('미러 열기   collapsed');
      expect(formatArchiveRecord(result).join('\n')).toContain('원문 미러 대신 이 사본을 열어라');
      expect(formatArchiveRecord(result).join('\n')).toContain('방아쇠 mirror-collapse');
      expect(formatArchiveRecord({ ...base, visibleText: { mirrored: 10, rendered: 10, mirrorRendered: 5 }, mirrorCollapse: 'intact' }).join('\n')).toContain('미러 열기   intact');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('무너졌어도 렌더 DOM을 못 얻으면 스냅샷을 남기지 않는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-collapse-without-render-dom-'));
    const dbPath = join(root, 'webclone.db');
    let lifecycleListener: ((event: { method: string; params: Record<string, unknown> }) => void) | null = null;
    let currentUrl = 'https://example.test/collapse-without-render-dom';
    const cdpClient: any = {
      navigate: async (location: string) => {
        if (location.startsWith('file:')) {
          currentUrl = location;
          queueMicrotask(() => lifecycleListener?.({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'mirror-frame', loaderId: 'mirror-loader' } }));
          return { frameId: 'mirror-frame', loaderId: 'mirror-loader', errorText: undefined };
        }
        return { frameId: 'live-frame', loaderId: 'live-loader', errorText: undefined };
      },
      evaluate: async (expression: string) => {
        if (expression === "document.documentElement?.outerHTML ?? ''") return '';
        if (expression.includes('href: location.href')) return { href: currentUrl, html: '<main>x</main>' };
        if (expression === 'document.title') return 'Rendered';
        if (expression.includes('querySelectorAll')) return 0;
        if (expression.includes('document.fonts')) return undefined;
        return { customProperties: {}, roles: {}, honoursReducedMotion: false, viewport: null };
      },
      screenshot: async () => new Uint8Array([1, 2, 3]), close: async () => {},
      on: (_method: string, listener: (event: { method: string; params: Record<string, unknown> }) => void) => {
        lifecycleListener = listener;
        return () => { lifecycleListener = null; };
      },
    };
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') writeFileSync(join(args.at(-2)!, 'index.html'), '<main>0123456789</main>');
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof nativeSpawnSync;
    try {
      const result = await runArchive({
        url: 'https://example.test/collapse-without-render-dom', outRoot: root, dbPath, spawnSync,
        discoverChromeBinary: () => '/fake/chrome',
        createCdpClient: (async () => ({ close: async () => {} })) as unknown as typeof import('../browser-cdp/client.js').createCdpClient,
        createCdpClientFromEndpoint: (async () => cdpClient) as unknown as typeof import('../browser-cdp/client.js').createCdpClientFromEndpoint,
        renderSettlingWait: async () => {}, renderSettlingConfig: { intervalMs: 1, stableObservations: 1, maxWaitMs: 2 },
      });
      expect(result.mirrorCollapse).toBe('collapsed');
      expect(result.renderedSnapshot).toBeNull();
      expect(existsSync(join(result.out, 'origin', 'rendered.html'))).toBe(false);
      expect(result.disabledMirrorCopy).toEqual({ path: 'origin/index.scripts-disabled.html', frozenScripts: 0 });
      expect(readFileSync(join(result.out, result.disabledMirrorCopy!.path), 'utf8')).toBe('<main>0123456789</main>');
      expect(result.notes.join('\n')).toContain('원문 미러를 그냥 열면 본문이 줄어드니 origin/index.scripts-disabled.html 을 대신 열어라');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('무너지지 않은 미러에는 스크립트 무력화 사본을 만들지 않는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-intact-mirror-'));
    const dbPath = join(root, 'webclone.db');
    let lifecycleListener: ((event: { method: string; params: Record<string, unknown> }) => void) | null = null;
    let currentUrl = 'https://example.test/intact-mirror';
    const cdpClient: any = {
      navigate: async (location: string) => {
        if (location.startsWith('file:')) {
          currentUrl = location;
          queueMicrotask(() => lifecycleListener?.({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'mirror-frame', loaderId: 'mirror-loader' } }));
          return { frameId: 'mirror-frame', loaderId: 'mirror-loader', errorText: undefined };
        }
        return { frameId: 'live-frame', loaderId: 'live-loader', errorText: undefined };
      },
      evaluate: async (expression: string) => {
        if (expression === "document.documentElement?.outerHTML ?? ''") return '<main>0123456789</main>';
        if (expression.includes('href: location.href')) return { href: currentUrl, html: '<main>0123456789</main>' };
        if (expression === 'document.title') return 'Rendered';
        if (expression.includes('querySelectorAll')) return 0;
        if (expression.includes('document.fonts')) return undefined;
        return { customProperties: {}, roles: {}, honoursReducedMotion: false, viewport: null };
      },
      screenshot: async () => new Uint8Array([1, 2, 3]), close: async () => {},
      on: (_method: string, listener: (event: { method: string; params: Record<string, unknown> }) => void) => {
        lifecycleListener = listener;
        return () => { lifecycleListener = null; };
      },
    };
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') writeFileSync(join(args.at(-2)!, 'index.html'), '<script src="assets/app.js"></script><main>0123456789</main>');
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof nativeSpawnSync;
    try {
      const result = await runArchive({
        url: 'https://example.test/intact-mirror', outRoot: root, dbPath, spawnSync,
        discoverChromeBinary: () => '/fake/chrome',
        createCdpClient: (async () => ({ close: async () => {} })) as unknown as typeof import('../browser-cdp/client.js').createCdpClient,
        createCdpClientFromEndpoint: (async () => cdpClient) as unknown as typeof import('../browser-cdp/client.js').createCdpClientFromEndpoint,
        renderSettlingWait: async () => {}, renderSettlingConfig: { intervalMs: 1, stableObservations: 1, maxWaitMs: 2 },
      });
      expect(result.mirrorCollapse).toBe('intact');
      expect(result.mirrorLiveTextRatio).toBe(1);
      expect(formatArchiveRecord(result).join('\n')).not.toContain('보관본이 라이브의 일부만 담았다');
      expect(result.disabledMirrorCopy).toBeNull();
      expect(existsSync(join(result.out, 'origin', 'index.scripts-disabled.html'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('열어도 안 줄었지만 라이브 일부만 담은 미러를 별도 판정하고 비율을 출력한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-partial-live-content-'));
    const dbPath = join(root, 'webclone.db');
    let lifecycleListener: ((event: { method: string; params: Record<string, unknown> }) => void) | null = null;
    let currentUrl = 'https://example.test/partial-live-content';
    const cdpClient: any = {
      navigate: async (location: string) => {
        if (location.startsWith('file:')) {
          currentUrl = location;
          queueMicrotask(() => lifecycleListener?.({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'mirror-frame', loaderId: 'mirror-loader' } }));
          return { frameId: 'mirror-frame', loaderId: 'mirror-loader', errorText: undefined };
        }
        return { frameId: 'live-frame', loaderId: 'live-loader', errorText: undefined };
      },
      evaluate: async (expression: string) => {
        if (expression === "document.documentElement?.outerHTML ?? ''") return '<main>01234567890123456789</main>';
        if (expression.includes('href: location.href')) return { href: currentUrl, html: '<main>1234</main>' };
        if (expression === 'document.title') return 'Rendered';
        if (expression.includes('querySelectorAll')) return 0;
        if (expression.includes('document.fonts')) return undefined;
        return { customProperties: {}, roles: {}, honoursReducedMotion: false, viewport: null };
      },
      screenshot: async () => new Uint8Array([1, 2, 3]), close: async () => {},
      on: (_method: string, listener: (event: { method: string; params: Record<string, unknown> }) => void) => {
        lifecycleListener = listener;
        return () => { lifecycleListener = null; };
      },
    };
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') writeFileSync(join(args.at(-2)!, 'index.html'), '<main>1234</main>');
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof nativeSpawnSync;
    try {
      const result = await runArchive({
        url: 'https://example.test/partial-live-content', outRoot: root, dbPath, spawnSync,
        discoverChromeBinary: () => '/fake/chrome',
        createCdpClient: (async () => ({ close: async () => {} })) as unknown as typeof import('../browser-cdp/client.js').createCdpClient,
        createCdpClientFromEndpoint: (async () => cdpClient) as unknown as typeof import('../browser-cdp/client.js').createCdpClientFromEndpoint,
        renderSettlingWait: async () => {}, renderSettlingConfig: { intervalMs: 1, stableObservations: 1, maxWaitMs: 2 },
      });
      expect(result.visibleText).toEqual({ mirrored: 4, rendered: 20, mirrorRendered: 4 });
      expect(result.mirrorLiveTextRatio).toBe(0.2);
      expect(result.mirrorCollapse).toBe('partial-live-content');
      expect(result.disabledMirrorCopy).toBeNull();
      expect(formatArchiveRecord(result).join('\n')).toContain('라이브 대비 20.0% — 보관본이 라이브의 일부만 담았다');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('라이브 렌더 본문을 못 재면 비율은 null이고 일부 판정을 내지 않는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-live-text-unmeasured-'));
    const dbPath = join(root, 'webclone.db');
    let lifecycleListener: ((event: { method: string; params: Record<string, unknown> }) => void) | null = null;
    let currentUrl = 'https://example.test/live-text-unmeasured';
    const cdpClient: any = {
      navigate: async (location: string) => {
        if (location.startsWith('file:')) {
          currentUrl = location;
          queueMicrotask(() => lifecycleListener?.({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'mirror-frame', loaderId: 'mirror-loader' } }));
          return { frameId: 'mirror-frame', loaderId: 'mirror-loader', errorText: undefined };
        }
        return { frameId: 'live-frame', loaderId: 'live-loader', errorText: undefined };
      },
      evaluate: async (expression: string) => {
        if (expression === "document.documentElement?.outerHTML ?? ''") return '';
        if (expression.includes('href: location.href')) return { href: currentUrl, html: '<main>1234</main>' };
        if (expression === 'document.title') return 'Rendered';
        if (expression.includes('querySelectorAll')) return 0;
        if (expression.includes('document.fonts')) return undefined;
        return { customProperties: {}, roles: {}, honoursReducedMotion: false, viewport: null };
      },
      screenshot: async () => new Uint8Array([1, 2, 3]), close: async () => {},
      on: (_method: string, listener: (event: { method: string; params: Record<string, unknown> }) => void) => {
        lifecycleListener = listener;
        return () => { lifecycleListener = null; };
      },
    };
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') writeFileSync(join(args.at(-2)!, 'index.html'), '<main>1234</main>');
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof nativeSpawnSync;
    try {
      const result = await runArchive({
        url: 'https://example.test/live-text-unmeasured', outRoot: root, dbPath, spawnSync,
        discoverChromeBinary: () => '/fake/chrome',
        createCdpClient: (async () => ({ close: async () => {} })) as unknown as typeof import('../browser-cdp/client.js').createCdpClient,
        createCdpClientFromEndpoint: (async () => cdpClient) as unknown as typeof import('../browser-cdp/client.js').createCdpClientFromEndpoint,
        renderSettlingWait: async () => {}, renderSettlingConfig: { intervalMs: 1, stableObservations: 1, maxWaitMs: 2 },
      });
      expect(result.visibleText).toEqual({ mirrored: 4, rendered: 0, mirrorRendered: 4 });
      expect(result.mirrorLiveTextRatio).toBeNull();
      expect(result.mirrorCollapse).toBe('intact');
      expect(formatArchiveRecord(result).join('\n')).not.toContain('보관본이 라이브의 일부만 담았다');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('미러 재탐색만 실패해도 라이브 캡처와 보관을 보존하고 unmeasured로 남긴다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-mirror-cdp-failure-'));
    const dbPath = join(root, 'webclone.db');
    let navigationCount = 0;
    const cdpClient = {
      navigate: async () => {
        navigationCount += 1;
        if (navigationCount === 2) throw new Error('mirror file navigation failed');
        return { errorText: undefined };
      },
      evaluate: async (expression: string) => {
        if (expression === "document.documentElement?.outerHTML ?? ''") return '<main>live rendered content</main>';
        if (expression === 'document.title') return 'Rendered';
        if (expression.includes('querySelectorAll')) return 0;
        return { customProperties: {}, roles: {}, honoursReducedMotion: false, viewport: null };
      },
      screenshot: async () => new Uint8Array([1, 2, 3]),
      close: async () => {},
    };
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') writeFileSync(join(args.at(-2)!, 'index.html'), '<main>mirror survives</main>');
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof nativeSpawnSync;
    try {
      const result = await runArchive({
        url: 'https://example.test/mirror-cdp-failure', outRoot: root, dbPath, spawnSync,
        discoverChromeBinary: () => '/fake/chrome',
        createCdpClient: (async () => ({ close: async () => {} })) as unknown as typeof import('../browser-cdp/client.js').createCdpClient,
        createCdpClientFromEndpoint: (async () => cdpClient) as unknown as typeof import('../browser-cdp/client.js').createCdpClientFromEndpoint,
        renderSettlingWait: async () => {}, renderSettlingConfig: { intervalMs: 1, stableObservations: 1, maxWaitMs: 2 },
      });
      expect(result.visibleText.rendered).toBeGreaterThan(0);
      expect(result.visibleText.mirrorRendered).toBeNull();
      expect(result.mirrorLiveTextRatio).toBeNull();
      expect(result.mirrorCollapse).toBe('unmeasured');
      expect(result.mirrorCompletion).toBe('completed');
      expect(result.mirrorOk).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('진입 파일 또는 미러 CDP 재열기가 없으면 unmeasured로 보관을 보존한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-mirror-unmeasured-'));
    const dbPath = join(root, 'webclone.db');
    const spawnSync = (() => ({ status: 0, stdout: '', stderr: '' })) as unknown as typeof nativeSpawnSync;
    try {
      const result = await runArchive({ url: 'https://example.test/no-entry', outRoot: root, dbPath, spawnSync, skipBrowserCapture: true });
      expect(result.entryPath).toBeNull();
      expect(result.visibleText.mirrorRendered).toBeNull();
      expect(result.mirrorCollapse).toBe('unmeasured');
      expect(result.mirrorCompletion).toBe('index-missing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('미러 진입 링크 자립 진단', () => {
  test('렌더 스냅샷과 같은 href/src 규칙으로 로컬·원격 링크를 분류한다', () => {
    expect(classifyDocumentLinks('<a href="/asset.css"><img src="images/logo.svg"><a href="https://cdn.test/x.js"><a href="#section"><a href="mailto:a@example.test">'))
      .toEqual({ localAssetLinks: 2, externalLinks: 1 });
  });

  test('원격 지배 문턱의 양쪽 경계를 이름 있는 진단으로 분리한다', () => {
    expect(diagnoseMirrorEntryLinks({ localAssetLinks: 4, externalLinks: 6 })).toBe('non-self-contained');
    expect(diagnoseMirrorEntryLinks({ localAssetLinks: 5, externalLinks: 5 })).toBe('self-contained');
    expect(REMOTE_DOMINANCE_LINK_RATIO).toBe(0.6);
  });

  test('주입 spawnSync가 만든 로컬 다수 진입 문서는 경고하지 않는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-entry-local-'));
    const dbPath = join(root, 'webclone.db');
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') writeFileSync(join(args.at(-2)!, 'index.html'), '<link href="/a.css"><img src="images/a.png"><script src="scripts/a.js"><a href="https://example.test/about">');
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof nativeSpawnSync;
    try {
      const result = await runArchive({ url: 'https://example.test/local', outRoot: root, dbPath, spawnSync, skipBrowserCapture: true });
      expect(result.mirrorEntryLinks).toEqual({ localAssetLinks: 3, externalLinks: 1 });
      expect(result.mirrorEntryLinkDiagnosis).toBe('self-contained');
      expect(formatArchiveRecord(result).join('\n')).not.toContain('미러 진입 링크');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('주입 spawnSync가 만든 로컬 0·원격 다수 진입 문서는 수와 오프라인 경고를 낸다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-entry-remote-'));
    const dbPath = join(root, 'webclone.db');
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') writeFileSync(join(args.at(-2)!, 'index.html'), '<link href="https://cdn.test/a.css"><img src="https://cdn.test/a.png"><a href="https://example.test/about">');
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof nativeSpawnSync;
    try {
      const result = await runArchive({ url: 'https://example.test/remote', outRoot: root, dbPath, spawnSync, skipBrowserCapture: true });
      expect(result.mirrorEntryLinks).toEqual({ localAssetLinks: 0, externalLinks: 3 });
      expect(result.mirrorEntryLinkDiagnosis).toBe('non-self-contained');
      expect(formatArchiveRecord(result).join('\n')).toContain('로컬 0개 · 네트워크 3개');
      expect(formatArchiveRecord(result).join('\n')).toContain('네트워크 없이 열면 생김새가 달라질 수 있다');
      expect(result.mirrorCompletion).toBe('completed');
      expect(result.mirrorCollapse).toBe('unmeasured');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('진입 문서가 없으면 링크 수와 진단을 측정 불가로 보존하고 경고하지 않는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-entry-missing-'));
    const dbPath = join(root, 'webclone.db');
    const spawnSync = (() => ({ status: 0, stdout: '', stderr: '' })) as unknown as typeof nativeSpawnSync;
    try {
      const result = await runArchive({ url: 'https://example.test/no-entry-links', outRoot: root, dbPath, spawnSync, skipBrowserCapture: true });
      expect(result.mirrorEntryLinks).toBeNull();
      expect(result.mirrorEntryLinkDiagnosis).toBe('unmeasured');
      expect(formatArchiveRecord(result).join('\n')).not.toContain('미러 진입 링크');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('렌더 위치 — 껍데기 판별', () => {
  test('🩸 클라이언트 렌더는 「원문 파일이 많아도」 껍데기다', () => {
    const shell: ArchiveRecord = {
      ...base, originFiles: 11, tokens: 24,
      fullPageScreenshot: { bytes: 51_200, dimensions: '1280x813' },
      renderLocation: 'client', visibleText: { mirrored: 79, rendered: 536, mirrorRendered: 79 },
      renderedSnapshot: { path: 'origin/rendered.html', bytes: 60_600, visible: 536, gain: 6.78, trigger: 'render-location', externalLinks: 7, localAssetLinks: 3, frozenScripts: 0 },
      canvasCount: 2,
    };
    // ⛔ 「아무것도 못 얻었다」는 «아니다» — 캡처도 토큰도 남는다. 그래서 «다른 값»이 필요했다.
    expect(archiveObtainedNothing(shell)).toBe(false);
    expect(shell.renderLocation).toBe('client');
  });

  test('⛔ 서버 렌더는 그 경고가 «없다»', () => {
    expect(base.renderLocation).toBe('server');
  });
});

describe('렌더 대기 불확실성 출력', () => {
  test('never-grew와 capped는 renderLocation을 신뢰할 수 없다고 각각 말한다', () => {
    const neverGrew = formatArchiveRecord({
      ...base,
      renderSettling: { status: 'never-grew', finalLength: 393, observations: 21, waitedMs: 10_000 },
    }).join('\n');
    const capped = formatArchiveRecord({
      ...base,
      renderSettling: { status: 'capped', finalLength: 14_802, observations: 21, waitedMs: 10_000 },
    }).join('\n');
    expect(neverGrew).toContain('본문 증가를 한 번도 보지 못했다');
    expect(neverGrew).toContain('renderLocation은 신뢰할 수 없다');
    expect(capped).toContain('전체 대기 상한에 닿았다');
    expect(capped).toContain('renderLocation은 신뢰할 수 없다');
    expect(capped).not.toBe(formatArchiveRecord(base).join('\n'));
  });
});

describe('렌더 스냅샷 — 「원문 형태 보관」을 CSR 에서도 지킨다', () => {
  test('⭐ 껍데기일 때 렌더 뒤 DOM 을 «같이» 남긴다 — 실측 excalidraw 6.78배', () => {
    const shell: ArchiveRecord = {
      ...base, renderLocation: 'client', visibleText: { mirrored: 79, rendered: 536, mirrorRendered: 79 },
      renderedSnapshot: { path: 'origin/rendered.html', bytes: 60_600, visible: 536, gain: 6.78, trigger: 'render-location', externalLinks: 7, localAssetLinks: 3, frozenScripts: 0 },
      canvasCount: 2,
    };
    // ⛔ `origin/` 에 둔다 — 렌더 HTML 도 «원본 저작물»이지 파생물이 아니다.
    expect(shell.renderedSnapshot?.path.startsWith('origin/')).toBe(true);
    expect(formatArchiveRecord(shell).join('\n')).toContain('렌더 스냅샷');
  });

  test('⛔ 서버 렌더면 «안» 만든다 — 용량만 늘고 얻는 게 없다', () => {
    expect(base.renderedSnapshot).toBeNull();
    expect(formatArchiveRecord(base).join('\n')).not.toContain('렌더 스냅샷');
  });

  test('⚠️ canvas 가 있으면 «이득이 제한된다»고 말한다 — 그림이 DOM 이 아니다', () => {
    const shell: ArchiveRecord = {
      ...base, renderLocation: 'mixed', visibleText: { mirrored: 136, rendered: 205, mirrorRendered: 136 },
      renderedSnapshot: { path: 'origin/rendered.html', bytes: 72_966, visible: 205, gain: 1.51, trigger: 'render-location', externalLinks: 2, localAssetLinks: 5, frozenScripts: 5 },
      canvasCount: 1,
    };
    expect(formatArchiveRecord(shell).join('\n')).toContain('canvas 1개');
  });
});

// ── 🩸 「열면 보인다」의 «조건»을 말해야 한다 ────────────────────────────────
//
// 실측 2026-09-08: 저장한 스냅샷을 실제로 열어 보니 라이브와 ***픽셀까지 동일***이었다(해시 일치).
// ⛔ 그런데 그것은 «같은 폴더의 미러 자산»이 붙어 준 덕이었고, 서드파티 링크 7개는 네트워크에서 왔다.
// ⇒ 「된다」만 말하면 파일을 옮긴 뒤 «조용히» 깨진다.
describe('스냅샷 자립 조건', () => {
  const shell: ArchiveRecord = {
    ...base, renderLocation: 'client', visibleText: { mirrored: 79, rendered: 536, mirrorRendered: 79 },
    renderedSnapshot: { path: 'origin/rendered.html', bytes: 60_600, visible: 536, gain: 6.78, trigger: 'render-location', externalLinks: 7, localAssetLinks: 3, frozenScripts: 0 },
    canvasCount: 2,
  };

  test('⭐ 「같은 폴더 자산 N개 필요」를 «수»로 말한다', () => {
    expect(formatArchiveRecord(shell).join('\n')).toContain('같은 폴더 자산 3개 필요');
  });

  test('⛔ 네트워크 링크가 있으면 «오프라인 자립 아님»을 말한다', () => {
    expect(formatArchiveRecord(shell).join('\n')).toContain('오프라인 자립 아님');
  });

  test('✅ 네트워크 링크가 0 이면 그 경고가 «없다»', () => {
    const offline: ArchiveRecord = {
      ...shell,
      renderedSnapshot: { ...shell.renderedSnapshot!, externalLinks: 0 },
    };
    expect(formatArchiveRecord(offline).join('\n')).not.toContain('오프라인 자립 아님');
  });
});

// ── 🩸 「보관본」과 「다시 부팅하는 앱」은 다르다 ────────────────────────────
//
// 실측 2026-09-08(aside 브라우저): tldraw 스냅샷을 «그냥» 열었더니 SPA 라우터가
// `/rendered.html` 을 못 찾아 ***"Page not found"*** 를 그렸다(글자 142 · canvas 0).
// `<script>` 5개를 무력화하니 라이브와 같은 화면이 돌아왔다(글자 122 · canvas 1 · notFound=false).
// ⭐ excalidraw 스냅샷은 `<script>` 가 ***0개***라 원래 정적이었다 — 그래서 그냥도 잘 열렸다.
describe('스크립트 무력화', () => {
  const withScripts: ArchiveRecord = {
    ...base, renderLocation: 'mixed', visibleText: { mirrored: 136, rendered: 205, mirrorRendered: 136 },
    renderedSnapshot: { path: 'origin/rendered.html', bytes: 72_966, visible: 205, gain: 1.51, trigger: 'render-location', externalLinks: 39, localAssetLinks: 37, frozenScripts: 5 },
    canvasCount: 1,
  };

  test('⭐ 무력화한 수를 말하고 «왜»를 붙인다', () => {
    const out = formatArchiveRecord(withScripts).join('\n');
    expect(out).toContain('스크립트    5개 무력화');
    expect(out).toContain('다시 부팅');
  });

  test('⛔ 원래 0개면 «다른 문장»을 낸다 — 「고쳤다」처럼 말하지 않는다', () => {
    const noScripts: ArchiveRecord = {
      ...withScripts,
      renderedSnapshot: { ...withScripts.renderedSnapshot!, frozenScripts: 0 },
    };
    const out = formatArchiveRecord(noScripts).join('\n');
    expect(out).toContain('원래 없었다');
    expect(out).not.toContain('다시 부팅');
  });
});

// ── 🩸 「0 인 경우」를 통제 표본이 드러냈다 ──────────────────────────────────
//
// 남의 사이트(링크 수십 개)로만 재면 두 수가 늘 0 이 아니라 이 거짓이 «영영 안 보인다».
// 실측 2026-09-08: 링크 0개인데 *"오프라인 자립은 아니다"*, 자산 0개인데 *"혼자 못 산다"* 라고 말했다.
describe('자립 문면 — 0 일 때 «거짓말하지 않는다»', () => {
  const mk = (externalLinks: number, localAssetLinks: number): ArchiveRecord => ({
    ...base, renderLocation: 'client', visibleText: { mirrored: 12, rendered: 103, mirrorRendered: 12 },
    renderedSnapshot: { path: 'origin/rendered.html', bytes: 1_100, visible: 103, gain: 8.58, trigger: 'render-location', externalLinks, localAssetLinks, frozenScripts: 1 },
    canvasCount: 1,
  });

  test('⛔ 네트워크 링크 0 이면 «오프라인에서도 선다»고 말한다', () => {
    const out = formatArchiveRecord(mk(0, 0)).join('\n');
    expect(out).toContain('네트워크 링크 0개');
    expect(out).not.toContain('오프라인 자립 아님');
  });

  test('⭐ 링크가 있으면 그때만 «자립 아님»을 말한다', () => {
    expect(formatArchiveRecord(mk(39, 37)).join('\n')).toContain('오프라인 자립 아님');
  });
});

// ── 🩸 「순서가 계약이다」 — 소스 «순서»를 시험이 문다 ────────────────────────
//
// 2026-09-08: 렌더 스냅샷 블록이 ③④⑤ «뒤»에 있어서 `rendered.html` 이
// 원장에 ***0행***이었고 S3 보관 루프도 못 봤다. 파일은 로컬에만 있었다.
// ⛔ 그런데 그 PR 본문엔 *"비공개 버킷 쪽으로 간다"*고 적혀 있었다 — 거짓이었다.
// ⇒ 시험이 «호출 순서»를 물지 않으면 이 자리는 조용히 되돌아온다.
const wgetAvailable = Bun.which('wget') !== null;
const wgetIntegration = wgetAvailable ? test : test.skip;
const wgetIntegrationName = (name: string) => wgetAvailable ? name : `${name} (skipped: wget unavailable)`;

describe('브라우저 재현 가능한 미러 계약', () => {
  test.each([
    ['www 요청 호스트', 'https://www.example.co.uk/page', ['www.example.co.uk', 'example.co.uk']],
    ['비 www 요청 호스트', 'https://example.co.uk/page', ['example.co.uk', 'www.example.co.uk']],
    ['정상 ccTLD 등록 도메인', 'https://www.example.de/page', ['www.example.de', 'example.de']],
    ['공용 접미 요청 호스트', 'https://www.co.uk/page', ['www.co.uk']],
    ['주소가 아닌 입력', 'not a URL', []],
  ])('%s에서 www 형제 허용 목록만 유도한다', (_name, url, expected) => {
    expect(deriveSiblingHostAllowlist(url)).toEqual(expected);
  });

  test('정확 호스트 정규식은 허용 형제만 받고 하위 호스트와 외부 호스트를 거절한다', () => {
    const filter = new RegExp(exactHostAcceptRegex(['www.example.co.uk', 'example.co.uk'])!);
    expect(filter.test('https://www.example.co.uk/assets/app.js')).toBe(true);
    expect(filter.test('https://example.co.uk/assets/app.js')).toBe(true);
    expect(filter.test('https://cdn.example.co.uk/assets/app.js')).toBe(false);
    expect(filter.test('https://other.example.co.uk/assets/app.js')).toBe(false);
    expect(filter.test('https://example.net/assets/app.js')).toBe(false);
  });

  // 실 wget 계약(POSIX ERE 컴파일·형제 호스트만 받기)은 실물 wget 만 답한다 — 가짜 실행기로 바꾸면 이 시험의 뜻이 사라진다.
  // 게이트 Pod 이미지(docker/harness)엔 wget 이 없다(0.2.30 게이트: originFiles 0). 그때는 «이유를 이름에 단» skip 이고,
  // wget 인자 계약은 바로 아래 주입 실행기 시험(형제 제한·깊이·정규화 인자)이 Pod 에서도 문다.
  wgetIntegration(wgetIntegrationName('실제 wget은 POSIX ERE를 컴파일해 www 형제 자산만 받고 외부 호스트는 받지 않는다'), async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-live-siblings-'));
    const dbPath = join(root, 'webclone.db');
    const serverScript = `
      const http = require('node:http');
      const server = http.createServer((request, response) => {
        const host = request.headers.host || '';
        if (request.url === '/') {
          const port = server.address().port;
          response.setHeader('content-type', 'text/html');
          response.end('<!doctype html>' + Array.from({ length: 220 }, (_, index) => '<img src="http://localhost:' + port + '/assets/' + index + '.svg">').join('') + '<img src="http://127.0.0.1:' + port + '/outside.svg">');
          return;
        }
        if (host.startsWith('127.0.0.1')) {
          response.end('outside-host-must-not-download');
          return;
        }
        response.setHeader('content-type', 'image/svg+xml');
        response.end('<svg xmlns="http://www.w3.org/2000/svg"><text>' + request.url + '</text></svg>');
      });
      server.listen(0, '127.0.0.1', () => console.log(server.address().port));
    `;
    const server = Bun.spawn(['node', '-e', serverScript], { stdout: 'pipe', stderr: 'pipe' });
    const firstChunk = await server.stdout.getReader().read();
    const port = Number(new TextDecoder().decode(firstChunk.value).trim());
    try {
      expect(port).toBeGreaterThan(0);
      const result = await runArchive({
        url: `http://www.localhost:${port}/`, outRoot: root, dbPath, spawnSync: nativeSpawnSync,
        discoverChromeBinary: () => '/fake/chrome', skipBrowserCapture: true,
      });
      expect(result.mirrorAllowedHosts).toEqual(['www.localhost', 'localhost']);
      expect(result.originFiles).toBeGreaterThanOrEqual(221);
      expect(result.entryPath).not.toBeNull();
      const entry = readFileSync(result.entryPath!, 'utf8');
      expect(entry).not.toContain(`http://localhost:${port}/assets/`);
      expect(entry).toContain(`http://127.0.0.1:${port}/outside.svg`);
      expect(result.mirrorEntryLinks).toEqual({ localAssetLinks: 220, externalLinks: 1 });
      expect(result.mirrorEntryLinkDiagnosis).toBe('self-contained');
      expect([...new Bun.Glob('**/*').scanSync({ cwd: join(result.out, 'origin'), onlyFiles: true })]
        .some((path) => readFileSync(join(result.out, 'origin', path), 'utf8').includes('outside-host-must-not-download'))).toBe(false);
    } finally {
      server.kill();
      await server.exited;
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('주소가 아닌 입력은 실제 wget 호출에서 host traversal을 열지 않는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-invalid-url-'));
    const dbPath = join(root, 'webclone.db');
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = ((command: string, args: string[]) => {
      calls.push({ command, args });
      if (command === 'wget') writeFileSync(join(args.at(-2)!, 'index.html'), '<main>invalid input</main>');
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof nativeSpawnSync;
    try {
      const result = await runArchive({ url: 'not a URL', outRoot: root, dbPath, spawnSync, skipBrowserCapture: true });
      const wgetArgs = calls.find((call) => call.command === 'wget')!.args;
      expect(result.mirrorAllowedHosts).toEqual([]);
      expect(wgetArgs).not.toContain('--span-hosts');
      expect(wgetArgs.some((arg) => arg.startsWith('--domains='))).toBe(false);
      expect(formatArchiveRecord(result).join('\n')).toContain('허용 호스트 없음');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runArchive가 실제 wget 호출에 www 형제 제한, 기존 깊이와 파일명 정규화 인자를 전달한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-wget-args-'));
    const dbPath = join(root, 'webclone.db');
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = ((command: string, args: string[]) => {
      calls.push({ command, args });
      const out = args.at(-2)!;
      writeFileSync(join(out, 'index.html'), '<!doctype html><title>mirror</title><main>ok</main>');
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof import('node:child_process').spawnSync;
    try {
      const result = await runArchive({ url: 'https://www.example.co.uk/cache-busted', outRoot: root, dbPath, spawnSync, skipBrowserCapture: true });
      expect(calls).toContainEqual({
        command: 'wget',
        args: [
          '--mirror', '-l', '1', '-p', '-k', '-nH', '-q', '-e', 'robots=off',
          '--restrict-file-names=windows', '-E', '--timeout=30', '--tries=2', '--user-agent=Mozilla/5.0',
          '--span-hosts', '--domains=www.example.co.uk,example.co.uk',
          '--accept-regex=^https?://(www\\.example\\.co\\.uk|example\\.co\\.uk)(:[0-9]+)?/', '-P',
          join(root, 'www-example-co-uk-cache-busted', 'origin'), 'https://www.example.co.uk/cache-busted',
        ],
      });
      expect(result.mirrorAllowedHosts).toEqual(['www.example.co.uk', 'example.co.uk']);
      expect(formatArchiveRecord(result).join('\n')).toContain('허용 호스트 www.example.co.uk · example.co.uk  (www. 형제만)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('비 www 요청도 runArchive wget 인자와 record에 두 형제 호스트를 전달한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-non-www-wget-args-'));
    const dbPath = join(root, 'webclone.db');
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = ((command: string, args: string[]) => {
      calls.push({ command, args });
      if (command === 'wget') writeFileSync(join(args.at(-2)!, 'index.html'), '<main>mirror</main>');
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof nativeSpawnSync;
    try {
      const result = await runArchive({ url: 'https://example.co.uk/page', outRoot: root, dbPath, spawnSync, skipBrowserCapture: true });
      const wgetArgs = calls.find((call) => call.command === 'wget')!.args;
      expect(result.mirrorAllowedHosts).toEqual(['example.co.uk', 'www.example.co.uk']);
      expect(wgetArgs).toContain('--span-hosts');
      expect(wgetArgs).toContain('--domains=example.co.uk,www.example.co.uk');
      expect(wgetArgs).toContain('--accept-regex=^https?://(example\\.co\\.uk|www\\.example\\.co\\.uk)(:[0-9]+)?/');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('허용 호스트 출력은 미기록, 명시적 빈 목록, 실제 목록을 구별한다', () => {
    expect(formatArchiveRecord(base).join('\n')).toContain('허용 호스트 미기록/알 수 없음');
    expect(formatArchiveRecord({ ...base, mirrorAllowedHosts: [] }).join('\n')).toContain('허용 호스트 없음');
    expect(formatArchiveRecord({ ...base, mirrorAllowedHosts: ['example.co.uk'] }).join('\n')).toContain('허용 호스트 example.co.uk');
  });

  test('미러 완료 상태는 깊이와 링크 변환을 기록하고 경고를 내지 않는다', () => {
    const completed = formatArchiveRecord(base).join('\n');
    expect(completed).toContain('미러 완료');
    expect(completed).toContain('재귀 깊이 1');
    expect(completed).toContain('링크 변환 완료');
    expect(completed).toContain('파일명 정규화');
    expect(completed).not.toContain('⚠️');
  });

  test('실패·시간 상한·index 누락은 서로 다른 기록과 사람용 출력이다', () => {
    const failed = formatArchiveRecord({ ...base, mirrorOk: false, mirrorCompletion: 'failed' }).join('\n');
    const timedOut = formatArchiveRecord({ ...base, mirrorOk: false, mirrorCompletion: 'timed-out' }).join('\n');
    const indexMissing = formatArchiveRecord({ ...base, mirrorOk: false, mirrorCompletion: 'index-missing' }).join('\n');
    expect(failed).toContain('미러 실패');
    expect(timedOut).toContain('시간 상한');
    expect(timedOut).toContain('링크 변환이 실행되지 않았을 수 있어');
    expect(timedOut).toContain('브라우저에서 열리지 않을 수 있다');
    expect(indexMissing).toContain('index 누락');
    expect(failed).not.toContain('시간 상한');
    expect(indexMissing).not.toContain('미러 실패');
  });

  test('wget 종료 코드 0은 completed와 열린 미러로 보관한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-exit-zero-'));
    const dbPath = join(root, 'webclone.db');
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') {
        writeFileSync(join(args.at(-2)!, 'index.html'), '<main>complete</main>');
      }
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof nativeSpawnSync;
    try {
      const result = await runArchive({ url: 'https://example.test/exit-zero', outRoot: root, dbPath, spawnSync, skipBrowserCapture: true });
      expect(result.mirrorCompletion).toBe('completed');
      expect(result.mirrorOk).toBe(true);
      expect(result.mirrorExitCode).toBe(0);
      expect(formatArchiveRecord(result).join('\n')).toContain('미러 완료');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('wget 종료 코드 8은 일부 서버 오류 완료로 열고 실패로 부르지 않는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-server-error-'));
    const dbPath = join(root, 'webclone.db');
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') {
        writeFileSync(join(args.at(-2)!, 'index.html'), '<main>partial asset error</main>');
      }
      return { status: 8, stdout: '', stderr: '' };
    }) as typeof nativeSpawnSync;
    try {
      const result = await runArchive({ url: 'https://example.test/server-error', outRoot: root, dbPath, spawnSync, skipBrowserCapture: true });
      const rendered = formatArchiveRecord(result).join('\n');
      expect(result.mirrorCompletion).toBe('partial-server-error');
      expect(result.mirrorOk).toBe(true);
      expect(result.mirrorExitCode).toBe(8);
      expect(rendered).toContain('일부 자산이 서버 오류를 받았지만');
      expect(rendered).toContain('wget 종료 코드 8');
      expect(rendered).not.toContain('미러 실패');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('다른 wget 비영 종료 코드는 failed와 닫힌 미러로 보관한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-other-error-'));
    const dbPath = join(root, 'webclone.db');
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') {
        writeFileSync(join(args.at(-2)!, 'index.html'), '<main>failed mirror</main>');
      }
      return { status: 4, stdout: '', stderr: '' };
    }) as typeof nativeSpawnSync;
    try {
      const result = await runArchive({ url: 'https://example.test/other-error', outRoot: root, dbPath, spawnSync, skipBrowserCapture: true });
      expect(result.mirrorCompletion).toBe('failed');
      expect(result.mirrorOk).toBe(false);
      expect(result.mirrorExitCode).toBe(4);
      expect(formatArchiveRecord(result).join('\n')).toContain('미러 실패');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('코드 8이어도 진입 문서가 없으면 index-missing이 우선한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-server-error-no-entry-'));
    const dbPath = join(root, 'webclone.db');
    const spawnSync = (() => ({ status: 8, stdout: '', stderr: '' })) as unknown as typeof nativeSpawnSync;
    try {
      const result = await runArchive({ url: 'https://example.test/server-error-no-entry', outRoot: root, dbPath, spawnSync, skipBrowserCapture: true });
      expect(result.mirrorCompletion).toBe('index-missing');
      expect(result.mirrorOk).toBe(false);
      expect(result.mirrorExitCode).toBe(8);
      expect(formatArchiveRecord(result).join('\n')).toContain('index 누락');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('종료 코드를 얻지 못한 외부 종료는 0과 구별해 failed로 보관한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-no-exit-code-'));
    const dbPath = join(root, 'webclone.db');
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') {
        writeFileSync(join(args.at(-2)!, 'index.html'), '<main>no exit code</main>');
        return { status: null, signal: 'SIGTERM', stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof nativeSpawnSync;
    try {
      const result = await runArchive({ url: 'https://example.test/no-exit-code', outRoot: root, dbPath, spawnSync, skipBrowserCapture: true });
      expect(result.mirrorCompletion).toBe('failed');
      expect(result.mirrorOk).toBe(false);
      expect(result.mirrorExitCode).toBeNull();
      expect(result.mirrorExitCode).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('실제 spawnSync 시간 상한 결과를 주입하면 timed-out으로 기록한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-timeout-'));
    const dbPath = join(root, 'webclone.db');
    const timedOut = nativeSpawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 1_000)'], { timeout: 10 });
    expect((timedOut.error as NodeJS.ErrnoException | undefined)?.code).toBe('ETIMEDOUT');
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') return timedOut;
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof import('node:child_process').spawnSync;
    const { logs, restore } = captureDebugLog();
    try {
      const result = await runArchive({ url: 'https://example.test/timed-out', outRoot: root, dbPath, spawnSync, skipBrowserCapture: true });
      const done = logs.find((log) => log.category === 'webclone.archive' && log.event === 'done');
      expect(result.mirrorCompletion).toBe('timed-out');
      expect(result.mirrorOk).toBe(false);
      expect(result.mirrorExitCode).toBeNull();
      expect(result.mirrorDepth).toBe(1);
      expect(done?.data).toMatchObject({
        mirrorCompletion: result.mirrorCompletion,
        mirrorDepth: result.mirrorDepth,
      });
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('error 없는 SIGTERM 결과는 외부 종료로 보고 failed로 기록한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-sigterm-'));
    const dbPath = join(root, 'webclone.db');
    const spawnSync = ((command: string) => {
      if (command === 'wget') return { status: null, signal: 'SIGTERM', stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof import('node:child_process').spawnSync;
    try {
      const result = await runArchive({ url: 'https://example.test/external-sigterm', outRoot: root, dbPath, spawnSync, skipBrowserCapture: true });
      expect(result.mirrorCompletion).toBe('failed');
      expect(result.mirrorOk).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('정상 wget 완료 뒤 index가 없으면 index-missing으로 기록한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-index-missing-'));
    const dbPath = join(root, 'webclone.db');
    const spawnSync = (() => ({ status: 0, stdout: '', stderr: '' })) as unknown as typeof import('node:child_process').spawnSync;
    try {
      const result = await runArchive({ url: 'https://example.test/index-missing', outRoot: root, dbPath, spawnSync, skipBrowserCapture: true });
      expect(result.mirrorCompletion).toBe('index-missing');
      expect(result.mirrorOk).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('경로 URL의 .html 미러 파일을 진입점으로 선택해 completed로 기록한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-path-entry-'));
    const dbPath = join(root, 'webclone.db');
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') {
        const origin = args.at(-2)!;
        mkdirSync(join(origin, 'profile'), { recursive: true });
        writeFileSync(join(origin, 'profile', 'bsky.app.html'), '<main>path entry text</main>');
      }
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof import('node:child_process').spawnSync;
    try {
      const result = await runArchive({ url: 'https://bsky.app/profile/bsky.app', outRoot: root, dbPath, spawnSync, skipBrowserCapture: true });
      expect(result.mirrorCompletion).toBe('completed');
      expect(result.mirrorOk).toBe(true);
      expect(result.visibleText.mirrored).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('후행 슬래시 URL은 디렉터리가 아닌 경로 index.html을 진입점으로 선택한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-directory-entry-'));
    const dbPath = join(root, 'webclone.db');
    const entry = '<main>directory entry text</main>';
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') {
        const origin = args.at(-2)!;
        mkdirSync(join(origin, 'docs'), { recursive: true });
        writeFileSync(join(origin, 'docs', 'index.html'), entry);
      }
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof import('node:child_process').spawnSync;
    try {
      const result = await runArchive({ url: 'https://example.test/docs/', outRoot: root, dbPath, spawnSync, skipBrowserCapture: true });
      expect(result.mirrorCompletion).toBe('completed');
      expect(result.mirrorOk).toBe(true);
      expect(result.visibleText.mirrored).toBe(visibleTextLength(entry));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('뿌리 index.html은 경로 후보보다 먼저 선택한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-root-entry-'));
    const dbPath = join(root, 'webclone.db');
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') {
        const origin = args.at(-2)!;
        mkdirSync(join(origin, 'profile'), { recursive: true });
        writeFileSync(join(origin, 'index.html'), '<main>root entry</main>');
        writeFileSync(join(origin, 'profile', 'bsky.app.html'), '<main>path entry</main>');
      }
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof import('node:child_process').spawnSync;
    try {
      const result = await runArchive({ url: 'https://bsky.app/profile/bsky.app', outRoot: root, dbPath, spawnSync, skipBrowserCapture: true });
      expect(result.mirrorCompletion).toBe('completed');
      expect(result.visibleText.mirrored).toBe(visibleTextLength('<main>root entry</main>'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('뿌리와 경로 후보가 모두 없으면 index-missing으로 남긴다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-no-entry-'));
    const dbPath = join(root, 'webclone.db');
    const spawnSync = (() => ({ status: 0, stdout: '', stderr: '' })) as unknown as typeof import('node:child_process').spawnSync;
    try {
      const result = await runArchive({ url: 'https://bsky.app/profile/bsky.app', outRoot: root, dbPath, spawnSync, skipBrowserCapture: true });
      expect(result.mirrorCompletion).toBe('index-missing');
      expect(result.mirrorOk).toBe(false);
      expect(result.visibleText.mirrored).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('src/cli/repo-cli.ts registerRepoCommands가 runArchive를 호출한다', () => {
    const repoCli = readFileSync(new URL('../cli/repo-cli.ts', import.meta.url), 'utf8');
    expect(repoCli).toContain('export function registerRepoCommands');
    expect(repoCli).toContain('const record = await deps.runArchive({');
  });
});

describe('부분 원문 보관 표식', () => {
  test('시간 초과여도 받은 원문을 올리고 비초록 요약·상태 마커·archivePartial을 남긴다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-partial-marker-'));
    const dbPath = join(root, 'webclone.db');
    const uploaded = new Map<string, Uint8Array>();
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') {
        const origin = args.at(-2)!;
        mkdirSync(join(origin, 'assets'), { recursive: true });
        writeFileSync(join(origin, 'index.html'), '<main>partial</main>');
        writeFileSync(join(origin, 'assets', 'site.css'), 'body{}');
      }
      return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) };
    }) as unknown as typeof nativeSpawnSync;
    try {
      const result = await runArchive({
        url: 'https://example.test/partial', outRoot: root, dbPath, upload: true,
        archiveBucket: 'private-archive', spawnSync, skipBrowserCapture: true,
        archiveBucketVerdict: () => ({ ok: true, state: 'blocked', why: 'private', remedy: null }),
        uploadArchiveFile: async (_bucket, _region, key, body) => {
          uploaded.set(key, body);
          return { ok: true, detail: `s3://private-archive/${key}` };
        },
      });
      const stateKey = `monad/webclone/${result.slug}/ARCHIVE-STATE.md`;
      expect(result.mirrorCompletion).toBe('timed-out');
      expect(result.archivedCount).toBe(2);
      expect(result.archivePartial).toBe(true);
      expect(result.archiveNote.startsWith('✅')).toBe(false);
      expect(result.archiveNote).toContain('부분 보관');
      expect(result.archiveNote).toContain('timed-out');
      expect(result.archiveNote).toContain('받은 파일 2개');
      expect([...uploaded.keys()]).toEqual(expect.arrayContaining([
        `monad/webclone/${result.slug}/origin/index.html`,
        `monad/webclone/${result.slug}/origin/assets/site.css`,
        stateKey,
      ]));
      expect(new TextDecoder().decode(uploaded.get(stateKey))).toBe([
        '원본 주소: https://example.test/partial',
        `담은 시각: ${result.capturedAt}`,
        '완주 상태: timed-out',
        '받은 파일 수: 2',
        '이 보관본은 부분이라 원본과 다를 수 있다',
      ].join('\n'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('완주 보관은 기존 초록 요약과 원문 키만 유지하고 상태 마커를 올리지 않는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-complete-marker-'));
    const dbPath = join(root, 'webclone.db');
    const uploadedKeys: string[] = [];
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') {
        const origin = args.at(-2)!;
        writeFileSync(join(origin, 'index.html'), '<main>complete</main>');
      }
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof nativeSpawnSync;
    try {
      const result = await runArchive({
        url: 'https://example.test/complete', outRoot: root, dbPath, upload: true,
        archiveBucket: 'private-archive', spawnSync, skipBrowserCapture: true,
        archiveBucketVerdict: () => ({ ok: true, state: 'blocked', why: 'private', remedy: null }),
        uploadArchiveFile: async (_bucket, _region, key) => {
          uploadedKeys.push(key);
          return { ok: true, detail: `s3://private-archive/${key}` };
        },
      });
      expect(result.mirrorCompletion).toBe('completed');
      expect(result.archivePartial).toBe(false);
      expect(result.archiveNote).toBe(`✅ private-archive(비공개) 로 ***${result.archivedCount}개*** 보관`);
      expect(uploadedKeys).toEqual([
        `monad/webclone/${result.slug}/origin/index.html`,
      ]);
      expect(uploadedKeys).not.toContain(`monad/webclone/${result.slug}/ARCHIVE-STATE.md`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('원문 보관 키 안전성', () => {
  test('?·# 원문 키는 건너뛰고 일반 키만 올리며 실패를 이름으로 남긴다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-unsafe-key-'));
    const dbPath = join(root, 'webclone.db');
    const uploadedKeys: string[] = [];
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') {
        const origin = args.at(-2)!;
        mkdirSync(join(origin, 'assets'), { recursive: true });
        writeFileSync(join(origin, 'index.html'), '<!doctype html><title>mirror</title><main>ok</main>');
        writeFileSync(join(origin, 'assets', 'ordinary.css'), 'body{}');
        writeFileSync(join(origin, 'assets', 'cache.css?v=123'), 'body{}');
        writeFileSync(join(origin, 'assets', 'fragment.css#copy'), 'body{}');
      }
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof import('node:child_process').spawnSync;
    try {
      const result = await runArchive({
        url: 'https://example.test/unsafe-key', outRoot: root, dbPath, upload: true,
        archiveBucket: 'private-archive', spawnSync, skipBrowserCapture: true,
        archiveBucketVerdict: () => ({ ok: true, state: 'blocked', why: 'private', remedy: null }),
        uploadArchiveFile: async (_bucket, _region, key) => {
          uploadedKeys.push(key);
          return { ok: true, detail: `s3://private-archive/${key}` };
        },
      });
      expect(uploadedKeys).toEqual([
        'monad/webclone/example-test-unsafe-key/origin/assets/ordinary.css',
        'monad/webclone/example-test-unsafe-key/origin/index.html',
      ]);
      expect(uploadedKeys.join('\n')).not.toContain('cache.css?v=123');
      expect(uploadedKeys.join('\n')).not.toContain('fragment.css#copy');
      expect(result.archivedCount).toBe(uploadedKeys.length);
      expect(result.archiveNote).toContain('실패 2건');
      expect(result.archiveNote).toContain('origin/assets/cache.css?v=123');
      expect(result.archiveNote).toContain('origin/assets/fragment.css#copy');
      expect(result.archiveNote).toContain('키가 잘려 다른 파일을 덮어쓸 위험');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('일반 원문 키는 바꾸지 않고 모두 업로드한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webclone-archive-safe-key-'));
    const dbPath = join(root, 'webclone.db');
    const uploadedKeys: string[] = [];
    const spawnSync = ((command: string, args: string[]) => {
      if (command === 'wget') {
        const origin = args.at(-2)!;
        mkdirSync(join(origin, 'assets'), { recursive: true });
        writeFileSync(join(origin, 'index.html'), '<!doctype html><title>mirror</title><main>ok</main>');
        writeFileSync(join(origin, 'assets', 'ordinary.css'), 'body{}');
        writeFileSync(join(origin, 'assets', 'logo.svg'), '<svg/>');
      }
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof import('node:child_process').spawnSync;
    try {
      const result = await runArchive({
        url: 'https://example.test/safe-key', outRoot: root, dbPath, upload: true,
        archiveBucket: 'private-archive', spawnSync, skipBrowserCapture: true,
        archiveBucketVerdict: () => ({ ok: true, state: 'blocked', why: 'private', remedy: null }),
        uploadArchiveFile: async (_bucket, _region, key) => {
          uploadedKeys.push(key);
          return { ok: true, detail: `s3://private-archive/${key}` };
        },
      });
      expect(uploadedKeys).toEqual(expect.arrayContaining([
        expect.stringContaining('/origin/index.html'),
        expect.stringContaining('/origin/assets/ordinary.css'),
        expect.stringContaining('/origin/assets/logo.svg'),
      ]));
      expect(uploadedKeys.some((key) => /[?#]/.test(key))).toBe(false);
      expect(result.archivedCount).toBe(uploadedKeys.length);
      expect(result.archiveNote).not.toContain('실패');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('순서 계약 — rendered.html 이 색인·보관을 «탄다»', () => {
  const source = readFileSync(new URL('./archive-run.ts', import.meta.url), 'utf8');

  test('⭐ originFiles.push(rendered) 가 insertAsset «앞»이다', () => {
    const push = source.indexOf('originFiles.push(rel)');
    const insert = source.indexOf('insertAsset(db, {');
    expect(push).toBeGreaterThan(0);
    expect(insert).toBeGreaterThan(0);
    expect(push).toBeLessThan(insert);
  });

  test('⭐ 그리고 S3 보관 루프 «앞»이다', () => {
    const push = source.indexOf('originFiles.push(rel)');
    const upload = source.indexOf('for (const rel of [...originFiles');
    expect(upload).toBeGreaterThan(0);
    expect(push).toBeLessThan(upload);
  });

  test('⭐ 온전성 검사도 push 뒤라 스냅샷을 «본다»', () => {
    const push = source.indexOf('originFiles.push(rel)');
    const integ = source.indexOf('const integrity = checkAssets(');
    expect(integ).toBeGreaterThan(push);
  });
});

// ── 🩸 원장 «완전성» — 디스크에 있는데 원장에 없으면 조용한 구멍이다 ────────────
//
// 실측 2026-09-08(전수 감사): 디스크 47 · 원장 41 ⇒ ***여섯이 없었다***.
//   origin/fullpage.png          ⛔ S3 엔 올라가는데 원장엔 0행 — 「무엇을 보관했나」가 반쪽
//   origin/manifest.webmanifest  ⛔ «확장자 허용목록»이 조용히 뺐다 — 원장에도 S3 에도 안 갔다
//   DESIGN.md·tokens·spec·NOTICE ⚠️ 배포 행은 업로드가 만든다 — 그러나 «말은» 해야 한다
describe('원장 완전성', () => {
  const source = readFileSync(new URL('./archive-run.ts', import.meta.url), 'utf8');

  test('⛔ 확장자 «허용목록»을 쓰지 않는다 — 아는 확장자만 담으면 조용히 빠진다', () => {
    expect(source).not.toContain('ARCHIVE_EXT');
    expect(source).toContain('MIRROR_JUNK');
  });

  test('⭐ 전체 캡처가 원장 대상에 «들어간다»', () => {
    expect(source).toContain("const fullPageRel = join('origin', 'fullpage.png')");
    expect(source).toContain('ledgerFiles');
  });

  test('⭐ 안 올린 파생물을 «이름으로» 말한다 — 침묵이 아니다', () => {
    expect(source).toContain('원장 assets 에도 «행이 없다»');
  });

  test('⛔ 파생물을 reference 로 «넣지 않는다» — 그 값은 원본 저작물을 뜻한다', () => {
    // 저작권 구분을 편의로 흐리지 않는다는 결정을 «주석이 아니라 코드 모양»으로 못 박는다.
    // ⛔ 닻은 «코드»여야 한다 — 한때 절 주석(`// ── ⑤ 업로드`)을 닻으로 썼는데 리팩터가 그 주석을 지우자
    //    indexOf 가 -1 이 되어 slice 가 «파일 끝까지» 벌어졌고, 시험이 엉뚱한 이유로 빨개졌다.
    const anchor = (needle: string): number => {
      const at = source.indexOf(needle);
      // 못 찾으면 «조용히 -1» 로 가지 않고 여기서 이유를 대며 죽는다.
      expect(at, `닻을 못 찾았다: ${needle}`).toBeGreaterThan(0);
      return at;
    };
    const originLoop = source.slice(anchor('for (const f of ledgerFiles)'), anchor('const profile = options.profile'));
    expect(originLoop).toContain("visibility: 'reference'");
    expect(originLoop).not.toContain('derived');
  });
});


// ⛔⭐⭐ 🩸 2026-09-12(🅕) — ***`index.html` «만» 찾아서 「색인이 아닌 URL」이 조용히 안 재졌다.***
//    대조 장 README 가 그 「못 쟀음」을 ***「배선이 안 산다」로 «석 달» 적어 두고 있었다.***
describe('mirrorEntryCandidates — 사본 들머리 후보', () => {
  test('⭐ 색인이 «먼저»다 — 디렉토리 URL 이 정상 경로다', () => {
    expect(mirrorEntryCandidates('http://h/')[0]).toBe('index.html');
  });

  test('⛔⭐ ***색인이 «아닌» URL 의 파일 이름을 «담는다»*** — 이것이 이 함수의 존재 이유다', () => {
    expect(mirrorEntryCandidates('http://h/js-painted.html')).toContain('js-painted.html');
  });

  test('⭐ 확장자가 «없으면» wget `-E` 가 붙이는 `.html` 도 본다', () => {
    const c = mirrorEntryCandidates('http://h/a/b/page');
    expect(c).toContain('page');
    expect(c).toContain('page.html');
  });

  test('⛔ 중복을 «안» 만든다 — `/index.html` 은 이미 첫 칸이다', () => {
    const c = mirrorEntryCandidates('http://h/index.html');
    expect(c.filter((x) => x === 'index.html')).toHaveLength(1);
  });

  test('⛔ URL 을 «못 읽으면» 넓히지 않는다 — 지어내지 않는다', () => {
    expect(mirrorEntryCandidates('not a url')).toEqual(['index.html', 'index.html.1']);
  });

  test('⛔ 빈 경로도 색인 둘로만 — «없는 이름»을 만들지 않는다', () => {
    expect(mirrorEntryCandidates('http://h')).toEqual(['index.html', 'index.html.1']);
  });
});
