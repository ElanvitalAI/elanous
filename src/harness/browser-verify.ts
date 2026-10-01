// 하니스 웹배포 CDP 렌더 검증 — R(Review) 스테이지의 non-code 버전 (트랙 B2 · 2026-07-22)
//
// PLAN-execution-cycle-harness-expansion §트랙 B2. content-to-web 등으로 배포(published)한 URL 을
// CDP 로 열어 실제 렌더를 확인(스크린샷 + 본문/타이틀 상태)한다 — 코드 PR 의 Review 게이트가 하는
// "산출물이 실제로 동작하나" 검증의 웹 버전. 배포 후 빈 페이지/JS 에러/렌더 실패를 잡아 디버깅에 활용.
//
// ★ B1 attach client(createCdpClientFromEndpoint·브라우저-무관·9222) 재사용 — 특정 브라우저 비귀속.
//   CDP 엔드포인트 부재 시 fail-soft(skipped='no-cdp') — 검증 불가가 배포를 막지 않는다(관측만).

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createCdpClientFromEndpoint, CdpUnavailable, type CdpClient } from '../browser-cdp/client.js';
import { captureWithTimeout, describeCaptureFailure } from './browser-capture-timeout.js';
import { debug } from '../debug/log.js';
import { stripScreenAnsi } from './harness-screen.js';
import { classifyAsideRun, type AsideRunStatus } from './aside-run-status.js';
import { IMAGE_LOAD_STATE_SOURCE } from './image-load-state.js';

const execFileAsync = promisify(execFile);
// Longer than aside's own ~10 s daemon auth-challenge timeout, so «Aside isn't running» reaches stderr before we kill it (10-01 live).
const DEFAULT_ASIDE_TIMEOUT_MS = 30_000;
// Observed load events and complete page content arrive within this window; timeout remains non-blocking.
const CDP_LOAD_WAIT_TIMEOUT_MS = 3_000;

type CdpLoadWaitOutcome = 'event' | 'timeout' | 'unavailable';

type CdpLoadWait = {
  waitAfterNavigation: () => Promise<CdpLoadWaitOutcome>;
};

function waitForCdpLoad(client: CdpClient): CdpLoadWait {
  if (typeof client.on !== 'function') return { waitAfterNavigation: async () => 'unavailable' };
  try {
    let unsubscribe: (() => void) | undefined;
    let settled = false;
    let resolveOutcome: ((value: CdpLoadWaitOutcome) => void) | undefined;
    const settle = (value: CdpLoadWaitOutcome) => {
      if (settled) return;
      settled = true;
      try { unsubscribe?.(); } catch { /* optional event cleanup is fail-soft */ }
      resolveOutcome?.(value);
    };
    unsubscribe = client.on('Page.loadEventFired', () => settle('event'));
    return {
      waitAfterNavigation: () => {
        if (settled) return Promise.resolve('event');
        return new Promise<CdpLoadWaitOutcome>((resolve) => {
          resolveOutcome = resolve;
          setTimeout(() => settle('timeout'), CDP_LOAD_WAIT_TIMEOUT_MS);
        });
      },
    };
  } catch {
    return { waitAfterNavigation: async () => 'unavailable' };
  }
}

export type DeployFindingCertainty = 'confirmed' | 'suspected';
export type DeployUnmeasuredCheck = 'javascript-errors' | 'screenshot';

/** `fullPage` 포착의 시한 — ⛔ 정당한 긴 문서를 「멎었다」로 오독하지 않을 만큼 넉넉하되, 원시 기본 120초와는 자릿수를 가른다. */
export const VERIFY_CAPTURE_TIMEOUT_MS = 15_000;

/** 화면 관측에서 얻은 판정. legacy findings는 이 message를 그대로 유지한다. */
export interface DeployVerifyFinding {
  kind: 'empty-body' | 'unloaded-image' | 'empty-title' | 'duplicate-visible-text' | 'javascript-error' | 'cdp-error' | 'aside-error';
  message: string;
  certainty: DeployFindingCertainty;
}

export interface DeployVerifyResult {
  ok: boolean;
  url: string;
  title?: string;
  bodyLength?: number;
  screenshotBytes?: number;
  /** 아직 화면 밖이라 요청되지 않은 lazy 그림 수(실패가 아님). */
  pendingLazyImages?: number;
  /** 렌더 문제(빈 페이지·에러 등). ok=false 면 최소 1건. */
  findings: string[];
  /** findings와 병행하는 등급 있는 판정. 정상·CDP 미가용 결과에는 생략해 기존 결과 모양을 보존한다. */
  structuredFindings?: DeployVerifyFinding[];
  /** 측정하지 못한 선택적 신호. 빈 배열은 생략하므로 문제 없음과 구별된다. */
  unmeasured?: DeployUnmeasuredCheck[];
  /** 관측 백엔드 미가용으로 검증 스킵됨(배포는 막지 않음). */
  skipped?: 'no-cdp' | 'no-aside' | 'aside-not-running';
}

export type AsideRunner = (command: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string; stderr?: string; exitCode?: number | null; timedOut?: boolean }>;

export interface DeployVerifyDeps {
  /** 기본 CDP 또는 별도 브라우저 세션을 쓰는 aside. */
  backend?: 'cdp' | 'aside';
  /** CDP attach(테스트 seam·기본 createCdpClientFromEndpoint). */
  connect?: (port?: number) => Promise<CdpClient>;
  /** aside 자식 프로세스 seam. 기본은 `aside repl <temporary-script-code>`. */
  runAside?: AsideRunner;
  /** aside 실행 파일 이름. 기본 aside. */
  asideCommand?: string;
  /** aside 임시 디렉터리 생성 seam. 기본은 시스템 임시 디렉터리 아래에 생성한다. */
  createAsideTemporaryDirectory?: () => Promise<string>;
  /** aside 임시 스크립트 쓰기 seam. 기본은 UTF-8 파일을 쓴다. */
  writeAsideScript?: (path: string, script: string) => Promise<void>;
  /** aside 임시 파일 정리 seam. 기본은 임시 디렉터리를 재귀 삭제한다. */
  cleanupAsideTemporaryDirectory?: (directory: string) => Promise<void>;
  /** aside 자식 프로세스 시간 상한(ms). 기본 10초. */
  asideTimeoutMs?: number;
  /** attach 포트(기본 9222). */
  port?: number;
  /** 캡처된 스크린샷 바이트 소비(파일 저장·PR 첨부 등). */
  onScreenshot?: (buf: Buffer) => void;
  /**
   * 화면 포착 시한. ⛔ 안 주면 {@link VERIFY_CAPTURE_TIMEOUT_MS}.
   * ⚠️ `browser-act`(5초)보다 «넉넉하다» — 여기는 `fullPage: true` 라 긴 문서면 정당하게 더 걸린다.
   *    그래도 원시 기본 120초와는 «자릿수»가 다르다.
   */
  captureTimeoutMs?: number;
  /** 본문 최소 길이(이하면 렌더 실패 의심). 기본 10. */
  minBodyLength?: number;
}

interface PageState {
  title: string;
  bodyLength: number;
  unloadedImageCount: number;
  pendingLazyImages: number;
  consecutiveDuplicateText: string | null;
}

const IMAGE_COUNTS_EXPRESSION = `(${IMAGE_LOAD_STATE_SOURCE})(Array.from(document.images, (image) => {
  const rect = image.getBoundingClientRect();
  return {
    complete: image.complete, naturalWidth: image.naturalWidth, loading: image.loading,
    inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth,
  };
}))`;

const PAGE_STATE_EXPRESSION = `(() => {
  const isVisible = (element) => {
    for (let current = element; current; current = current.parentElement) {
      const style = window.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  const textUnits = [];
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.nodeValue ?? '').trim().replace(/\\s+/g, ' ');
      if (text && node.parentElement && isVisible(node.parentElement)) textUnits.push(text);
    }
  }
  const consecutiveDuplicateText = textUnits.find((text, index) => text === textUnits[index + 1]) ?? null;
  const imageCounts = ${IMAGE_COUNTS_EXPRESSION};
  return {
    title: document.title,
    bodyLength: document.body ? document.body.innerText.length : 0,
    unloadedImageCount: imageCounts.broken,
    pendingLazyImages: imageCounts.pendingLazy,
    consecutiveDuplicateText,
  };
})()`;

const observe = (event: string, data: Record<string, unknown>): void => {
  try { debug.log('harness.browser-verify', event, data); } catch { /* fail-soft */ }
};

function finding(kind: DeployVerifyFinding['kind'], message: string, certainty: DeployFindingCertainty): DeployVerifyFinding {
  return { kind, message, certainty };
}

function exceptionMessage(params: Record<string, unknown>): string {
  const details = params.exceptionDetails as { text?: unknown; exception?: { description?: unknown; value?: unknown } } | undefined;
  return String(details?.exception?.description ?? details?.exception?.value ?? details?.text ?? 'unknown JavaScript error').slice(0, 120);
}

function buildAsideScript(url: string): string {
  return [
    'await (async () => {',
    `  const url = ${JSON.stringify(url)};`,
    '  const page = await openTab(url);',
    '  try {',
    '    const title = await page.title();',
    `    const state = await page.evaluate(() => { const imageCounts = ${IMAGE_COUNTS_EXPRESSION}; return { bodyLength: document.body?.innerText.length ?? 0, unloadedImageCount: imageCounts.broken, pendingLazyImages: imageCounts.pendingLazy }; });`,
    '    const screenshot = await page.screenshot({ fullPage: true });',
    '    console.log(JSON.stringify({ title, ...state, screenshotBytes: screenshot?.length ?? 0 }));',
    '  } finally { try { await closeTab(page); } catch {} }',
    '})();',
  ].join('\n');
}

function parseAsideObservation(stdout: string): { title: string; bodyLength: number; unloadedImageCount: number; pendingLazyImages: number; screenshotBytes: number } {
  const normalizedStdout = stripScreenAnsi(stdout);
  const verdict = normalizedStdout.trimEnd().match(/\[(ok|error)\s*\|[^\]]+\]\s*$/);
  if (!verdict) throw new Error('aside observation output missing completion marker');
  if (verdict[1] === 'error') throw new Error('aside repl reported error');

  let parsedJson = false;
  for (const line of normalizedStdout.split(/\r?\n/).reverse()) {
    try {
      const result: unknown = JSON.parse(line.trim());
      parsedJson = true;
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('aside observation JSON must be an object');
      const { title, bodyLength, unloadedImageCount, pendingLazyImages = 0, screenshotBytes } = result as Record<string, unknown>;
      if (
        typeof title !== 'string'
        || typeof bodyLength !== 'number' || !Number.isFinite(bodyLength) || bodyLength < 0
        || typeof unloadedImageCount !== 'number' || !Number.isFinite(unloadedImageCount) || unloadedImageCount < 0
        || typeof pendingLazyImages !== 'number' || !Number.isFinite(pendingLazyImages) || pendingLazyImages < 0
        || typeof screenshotBytes !== 'number' || !Number.isFinite(screenshotBytes) || screenshotBytes < 0
      ) {
        throw new Error('aside observation JSON has invalid required fields');
      }
      return { title, bodyLength, unloadedImageCount, pendingLazyImages, screenshotBytes };
    } catch (error) {
      if (parsedJson) throw error;
    }
  }
  throw new Error('aside observation output missing JSON');
}

function asideErrorResult(url: string, error: unknown, kind?: AsideRunStatus['kind']): DeployVerifyResult {
  const message = error instanceof Error ? error.message : String(error);
  const errorFinding = finding('aside-error', `aside 검증 오류: ${message.slice(0, 120)}${kind ? ` (${kind})` : ''}`, 'confirmed');
  observe('verify-aside-failed', { url: url.slice(0, 80), error: message.slice(0, 120) });
  return { ok: false, url, findings: [errorFinding.message], structuredFindings: [errorFinding], unmeasured: ['javascript-errors'] };
}

async function verifyAsidePage(url: string, deps: DeployVerifyDeps): Promise<DeployVerifyResult> {
  let temporaryDirectory: string | undefined;
  const minBody = deps.minBodyLength ?? 10;
  try {
    temporaryDirectory = await (deps.createAsideTemporaryDirectory ?? (() => mkdtemp(join(tmpdir(), 'elanous-browser-verify-'))))();
    const scriptPath = join(temporaryDirectory, 'observe.mjs');
    await (deps.writeAsideScript ?? ((path, script) => writeFile(path, script, 'utf8')))(scriptPath, buildAsideScript(url));
    const script = await readFile(scriptPath, 'utf8');
    const runAside = deps.runAside ?? (async (command, args, options) => {
      try {
        const result = await execFileAsync(command, args, { ...options, encoding: 'utf8' });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
        const { stdout, stderr, code, killed, signal } = error as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: unknown; signal?: unknown };
        if (typeof stdout === 'string' || typeof stderr === 'string') {
          return {
            stdout: typeof stdout === 'string' ? stdout : '', stderr: typeof stderr === 'string' ? stderr : '',
            exitCode: typeof code === 'number' ? code : null,
            ...(killed === true || typeof signal === 'string' ? { timedOut: true } : {}),
          };
        }
        throw error;
      }
    });
    let observation: Awaited<ReturnType<AsideRunner>>;
    try {
      observation = await runAside(deps.asideCommand ?? 'aside', ['repl', script], { timeout: deps.asideTimeoutMs ?? DEFAULT_ASIDE_TIMEOUT_MS });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        observe('skip-no-aside', { url: url.slice(0, 80) });
        return { ok: false, url, findings: [], skipped: 'no-aside', unmeasured: ['javascript-errors'] };
      }
      return asideErrorResult(url, error);
    }
    const status = classifyAsideRun({ stdout: observation.stdout, stderr: observation.stderr ?? '', exitCode: observation.exitCode ?? null, timedOut: observation.timedOut === true });
    if (status.kind === 'not-running' || status.kind === 'auth-timeout') {
      observe('verify-aside-skipped', { url, kind: status.kind });
      return { ok: false, url, skipped: 'aside-not-running', findings: [status.hint ?? 'Aside 브라우저를 켜고 다시'], unmeasured: ['javascript-errors', 'screenshot'] };
    }
    if (status.kind === 'repl-error') return asideErrorResult(url, new Error('aside repl reported error'), status.kind);
    if (status.kind === 'no-marker') return asideErrorResult(url, new Error('aside observation output missing completion marker'), status.kind);
    const state = parseAsideObservation(observation.stdout);
    const structuredFindings: DeployVerifyFinding[] = [];
    if (state.bodyLength < minBody) structuredFindings.push(finding('empty-body', `페이지 본문이 비어있음(len=${state.bodyLength}·렌더 실패 의심)`, 'suspected'));
    if (state.unloadedImageCount) structuredFindings.push(finding('unloaded-image', `로드되지 못한 그림 ${state.unloadedImageCount}개`, 'confirmed'));
    if (!state.title.trim()) structuredFindings.push(finding('empty-title', '문서 제목이 비어있음', 'confirmed'));
    const findings = structuredFindings.map(({ message }) => message);
    const result: DeployVerifyResult = { ok: findings.length === 0, url, title: state.title, bodyLength: state.bodyLength, screenshotBytes: state.screenshotBytes, findings, unmeasured: ['javascript-errors'], ...(state.pendingLazyImages ? { pendingLazyImages: state.pendingLazyImages } : {}), ...(structuredFindings.length ? { structuredFindings } : {}) };
    observe('verified-aside', { url: url.slice(0, 80), ok: result.ok, bodyLength: state.bodyLength, bytes: state.screenshotBytes, findings: findings.length, unmeasured: result.unmeasured });
    return result;
  } catch (error) {
    return asideErrorResult(url, error);
  } finally {
    if (temporaryDirectory) {
      try {
        await (deps.cleanupAsideTemporaryDirectory ?? ((directory) => rm(directory, { recursive: true, force: true })))(temporaryDirectory);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        observe('aside-temporary-cleanup-failed', { directory: temporaryDirectory, error: message.slice(0, 120) });
      }
    }
  }
}

/**
 * 배포된 URL 을 관측 백엔드로 열어 렌더를 검증한다. 기본 CDP, 선택 aside; 백엔드 부재는 fail-soft skip.
 */
export async function verifyDeployedPage(url: string, deps: DeployVerifyDeps = {}): Promise<DeployVerifyResult> {
  if (deps.backend === 'aside') return verifyAsidePage(url, deps);
  return verifyCdpPage(url, deps);
}

async function verifyCdpPage(url: string, deps: DeployVerifyDeps): Promise<DeployVerifyResult> {
  const connect = deps.connect ?? createCdpClientFromEndpoint;
  const minBody = deps.minBodyLength ?? 10;
  let client: CdpClient;
  try {
    client = await connect(deps.port ?? 9222);
  } catch (e) {
    observe('skip-no-cdp', { url: url.slice(0, 80), reason: e instanceof CdpUnavailable ? e.message : String(e).slice(0, 80) });
    return { ok: false, url, findings: [], skipped: 'no-cdp' };
  }

  const javascriptErrors: string[] = [];
  let unsubscribe: (() => void) | undefined;
  let javascriptErrorsMeasured = false;
  if (client.on) {
    try {
      unsubscribe = client.on('Runtime.exceptionThrown', (event) => javascriptErrors.push(exceptionMessage(event.params)));
      javascriptErrorsMeasured = true;
    } catch { /* optional event collection is fail-soft */ }
  }

  try {
    const loadWait = waitForCdpLoad(client);
    const navigation = await client.navigate(url);
    if (navigation.errorText) {
      const errorFinding = finding('cdp-error', `CDP 이동 오류: ${navigation.errorText.slice(0, 120)}`, 'confirmed');
      observe('verify-failed', { url: url.slice(0, 80), error: navigation.errorText.slice(0, 120) });
      return { ok: false, url, findings: [errorFinding.message], structuredFindings: [errorFinding], ...(javascriptErrorsMeasured ? {} : { unmeasured: ['javascript-errors'] }) };
    }
    const loadWaitOutcome = await loadWait.waitAfterNavigation();
    const state = await client.evaluate(PAGE_STATE_EXPRESSION).catch(() => undefined) as PageState | undefined;
    const title = state?.title ?? '';
    const bodyLength = Number(state?.bodyLength) || 0;
    // ⛔⭐ 여기서 «시한 없이» 부르면 원시 CDP 기본 시한 120,000ms 까지 «조용히» 멎는다 —
    //    그리고 이 함수는 아침 봇 루틴의 「본다」 «1단계»다(2026-08-28 전수에서 드러났다).
    //    ⇒ 멎어도 «판정 전체»를 버리지 않는다: 제목·본문은 이미 위에서 쟀다.
    const shot = await captureWithTimeout(client, deps.captureTimeoutMs ?? VERIFY_CAPTURE_TIMEOUT_MS, { fullPage: true });
    let buf: Buffer | undefined;
    let screenshotUnmeasured: string | undefined;
    if ('png' in shot) buf = shot.png;
    else if ('stalled' in shot) screenshotUnmeasured = `시한 ${deps.captureTimeoutMs ?? VERIFY_CAPTURE_TIMEOUT_MS}ms 안에 «안 왔다»`;
    else screenshotUnmeasured = describeCaptureFailure(shot.reason);
    if (buf) deps.onScreenshot?.(buf);

    const structuredFindings: DeployVerifyFinding[] = [];
    if (bodyLength < minBody) structuredFindings.push(finding('empty-body', `페이지 본문이 비어있음(len=${bodyLength}·렌더 실패 의심)`, 'suspected'));
    if (state?.unloadedImageCount) structuredFindings.push(finding('unloaded-image', `로드되지 못한 그림 ${state.unloadedImageCount}개`, 'confirmed'));
    if (state && !title.trim()) structuredFindings.push(finding('empty-title', '문서 제목이 비어있음', 'confirmed'));
    if (state?.consecutiveDuplicateText) structuredFindings.push(finding('duplicate-visible-text', `같은 문구가 연달아 두 번 나타남: ${state.consecutiveDuplicateText.slice(0, 80)}`, 'suspected'));
    for (const error of javascriptErrors) structuredFindings.push(finding('javascript-error', `JavaScript 오류: ${error}`, 'confirmed'));

    const findings = structuredFindings.map(({ message }) => message);
    const unmeasuredChecks: DeployUnmeasuredCheck[] = [];
    if (!javascriptErrorsMeasured) unmeasuredChecks.push('javascript-errors');
    if (screenshotUnmeasured !== undefined) unmeasuredChecks.push('screenshot');
    const unmeasured = unmeasuredChecks.length ? unmeasuredChecks : undefined;
    const ok = findings.length === 0;
    observe('verified', { url: url.slice(0, 80), ok, title: title.slice(0, 60), bodyLength, bytes: buf?.length ?? 0, screenshotUnmeasured: screenshotUnmeasured ?? null, findings: findings.length, unmeasured: unmeasured ?? [], loadWait: loadWaitOutcome });
    return {
      ok, url, title, bodyLength, screenshotBytes: buf?.length ?? 0, findings,
      ...(structuredFindings.length ? { structuredFindings } : {}),
      ...(state?.pendingLazyImages ? { pendingLazyImages: state.pendingLazyImages } : {}),
      ...(unmeasured ? { unmeasured } : {}),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const errorFinding = finding('cdp-error', `CDP 검증 오류: ${msg.slice(0, 120)}`, 'confirmed');
    observe('verify-failed', { url: url.slice(0, 80), error: msg.slice(0, 120) });
    return { ok: false, url, findings: [errorFinding.message], structuredFindings: [errorFinding], ...(javascriptErrorsMeasured ? {} : { unmeasured: ['javascript-errors'] }) };
  } finally {
    try { unsubscribe?.(); } catch { /* optional event cleanup is fail-soft */ }
    try { await client.close(); } catch { /* ignore */ }
  }
}

/**
 * `verify-url` 의 사람용 산출 — ⛔ 「표면이 그 구분을 «보여 주나»」를 시험이 물 수 있게 순수 함수로 둔다.
 *
 * 🚨 계기(2026-08-28): 나는 「0바이트」와 「못 쟀다」를 코드 «안»에서 갈라 놓고
 *    ***화면에 찍는 줄을 안 썼다***. 그러면 그 구분은 만들어졌지만 «흐르지» 않는다.
 *    ([T] 131차가 같은 형태를 하루에 다섯 번 셌다 — 다섯 번 다 시험은 초록이었다.)
 */
export function formatVerifyUrlReport(
  url: string,
  result: DeployVerifyResult,
  shot?: { path: string; written: boolean },
): string[] {
  const shotNote = shot === undefined ? '' : shot.written ? ` → ${shot.path}` : ` → ⛔ 못 씀(${shot.path})`;
  const lines = [
    `\n━━ 배포 검증: ${url} ━━`,
    `  ${result.skipped === 'aside-not-running' ? '⚪ Aside 검증 건너뜀' : result.ok ? '✅ 렌더 정상' : '⚠️ 문제 감지'}`,
    `  title: ${result.title || '(없음)'}`,
    `  본문 길이: ${result.bodyLength ?? '?'} · 스크린샷: ${result.skipped === 'aside-not-running' ? '못 쟀다' : `${result.screenshotBytes ?? 0} bytes`}${shotNote}`,
  ];
  for (const f of result.findings) lines.push(`  - ${f}`);
  // ⛔⭐ 「못 쟀다」는 초록도 빨강도 아닌 «제 칸»이다 — 「없다」로 접지 않는다.
  for (const u of result.unmeasured ?? []) lines.push(`  ⚪ 못 쟀다: ${u} — 「없다」가 «아니다»`);
  return lines;
}
