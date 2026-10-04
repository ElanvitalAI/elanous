/**
 * web_capture — 페이지 스크린샷을 아티팩트로 저장 (deer-flow browserless web_capture 대응)
 *
 * 시각 소스(차트/IR 페이지/대시보드) 수집용. JS 렌더링 페이지도 실제 브라우저로 렌더.
 * 1순위: headless Chrome `--screenshot` 셸아웃 (dep-free·로컬 Chrome 재사용).
 * 폴백:  Dia CDP (port 9222) — dia-claude 가 이미 떠 있으면 Page.captureScreenshot.
 * SSRF 가드 필수 (임의 URL 렌더).
 *
 * 저장: OMNI_CRAWL_CAPTURE_DIR (기본 ~/.omni-crawl/captures) 에 PNG.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { env } from './env.js';
import { validatePublicHttpUrl } from './url-safety.js';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

let missingChromeReported = false;

function findChrome(): string | null {
  const override = env('OMNI_CRAWL_CHROME');
  if (override && existsSync(override)) return override;
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  return null;
}

function captureDir(): string {
  const dir = env('OMNI_CRAWL_CAPTURE_DIR') || join(homedir(), '.omni-crawl', 'captures');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function safeSlug(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/[^0-9A-Za-z]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'page';
  } catch { return 'page'; }
}

export interface CaptureOpts {
  fullPage?: boolean;       // 전체 페이지 (기본 true)
  width?: number;           // 뷰포트 폭 (기본 1280)
  height?: number;          // 뷰포트 높이 (기본 800)
  timeoutMs?: number;       // 렌더 타임아웃 (기본 30s)
  allowPrivate?: boolean;   // SSRF opt-out
}

export interface CaptureResult {
  url: string;
  path: string;
  method: string;
  bytes: number;
}

/**
 * URL 스크린샷 → PNG 파일 경로. 실패 시 null (fail-soft).
 */
export async function captureScreenshot(url: string, opts?: CaptureOpts): Promise<CaptureResult | null> {
  const err = await validatePublicHttpUrl(url, { action: 'capture', allowPrivate: opts?.allowPrivate });
  if (err) { console.log(`  [capture] 차단: ${err}`); return null; }

  const dir = captureDir();
  const stamp = `${safeSlug(url)}_${process.hrtime.bigint().toString(36)}`;
  const out = join(dir, `${stamp}.png`);
  const w = opts?.width ?? 1280;
  const h = opts?.height ?? 800;
  const timeout = opts?.timeoutMs ?? 30_000;

  // 1순위: headless Chrome 셸아웃
  const chrome = findChrome();
  if (!chrome && !missingChromeReported) {
    missingChromeReported = true;
    console.error('Chrome 없음 — 로컬 스크린샷 빠짐 · 설치하면 headless 캡처 켜짐 (CDP 폴백은 계속)');
  }
  if (chrome) {
    console.log(`  [capture] headless Chrome 렌더: ${url}`);
    const args = [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
      '--disable-dev-shm-usage', `--window-size=${w},${h}`,
      '--virtual-time-budget=8000',
      `--screenshot=${out}`,
      url,
    ];
    try {
      execFileSync(chrome, args, { timeout: timeout + 5_000, stdio: 'pipe', cwd: tmpdir() });
      if (existsSync(out)) {
        const { statSync } = await import('node:fs');
        const bytes = statSync(out).size;
        if (bytes > 0) { console.log(`  [capture] 저장: ${out} (${(bytes / 1024).toFixed(0)}KB)`); return { url, path: out, method: 'chrome-headless', bytes }; }
      }
    } catch (e: any) {
      console.log(`  [capture] Chrome 실패: ${e.message?.split('\n')[0]?.slice(0, 80)}`);
    }
  }

  // 폴백: Dia CDP (dia-claude 가 9222 에 떠 있을 때)
  const cdp = await captureViaCdp(url, out, { w, h, timeout });
  if (cdp) return cdp;

  console.log('  [capture] Chrome/CDP 모두 실패 — 스크린샷 건너뜀');
  return null;
}

/** Dia/Chrome CDP (port 9222) 로 Page.captureScreenshot. Node 24 글로벌 WebSocket 사용. */
async function captureViaCdp(url: string, out: string, o: { w: number; h: number; timeout: number }): Promise<CaptureResult | null> {
  const port = env('OMNI_CRAWL_CDP_PORT') || '9222';
  let wsUrl: string;
  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT', signal: AbortSignal.timeout(5_000),
    }).then(r => r.ok ? r.json() : null).catch(() => null)
      || await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(5_000) }).then(r => r.ok ? r.json() : null).catch(() => null);
    if (!targets?.webSocketDebuggerUrl) return null;
    wsUrl = targets.webSocketDebuggerUrl;
  } catch { return null; }

  console.log(`  [capture] Dia/CDP 폴백: ${url}`);
  return new Promise<CaptureResult | null>((resolve) => {
    let id = 0; const pending = new Map<number, (v: any) => void>();
    let done = false;
    const finish = (v: CaptureResult | null) => { if (!done) { done = true; try { ws.close(); } catch {} resolve(v); } };
    const timer = setTimeout(() => finish(null), o.timeout);
    let ws: WebSocket;
    try { ws = new WebSocket(wsUrl); } catch { clearTimeout(timer); return resolve(null); }

    const send = (method: string, params?: any) => new Promise<any>((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });

    ws.onmessage = (ev: any) => {
      try {
        const msg = JSON.parse(ev.data.toString());
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg.result); pending.delete(msg.id); }
      } catch {}
    };
    ws.onerror = () => finish(null);
    ws.onopen = async () => {
      try {
        await send('Page.enable');
        await new Promise(r => setTimeout(r, 2500)); // 렌더 대기
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        if (shot?.data) {
          const { writeFileSync, statSync } = await import('node:fs');
          writeFileSync(out, Buffer.from(shot.data, 'base64'));
          clearTimeout(timer);
          const bytes = statSync(out).size;
          console.log(`  [capture] CDP 저장: ${out} (${(bytes / 1024).toFixed(0)}KB)`);
          return finish({ url, path: out, method: 'dia-cdp', bytes });
        }
      } catch {}
      clearTimeout(timer); finish(null);
    };
  });
}

export function chromeAvailable(): boolean { return findChrome() !== null; }
