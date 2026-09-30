// UX 녹화·캡처 공용 — 헤드리스 Chrome 하나를 띄워 CDP 로 몰고, 어떤 경로로 끝나도 Chrome 과 프로필을 치운다.
// 대표 상시지시: 측정·녹화 스크립트는 Chrome 을 반드시 죽인다(exit · SIGINT · SIGTERM · 전역 타임아웃 넷 다).
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME = process.env.UX_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type Cdp = {
  send: (method: string, params?: object) => Promise<any>;
  ev: <T = unknown>(expression: string) => Promise<T>;
  click: (label: string, exact?: boolean) => Promise<string>;
  png: (file: string) => Promise<void>;
  close: () => void;
};

export async function launch(opts: { port: number; timeoutMs: number; width: number; height: number; dpr?: number; mobile?: boolean }): Promise<Cdp> {
  const profile = mkdtempSync(join(tmpdir(), 'ux-cdp-'));
  const chrome = spawn(CHROME, ['--headless=new', '--use-mock-keychain', '--password-store=basic', `--remote-debugging-port=${opts.port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const kill = () => { try { chrome.kill('SIGKILL'); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
  process.on('exit', kill);
  for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => { kill(); process.exit(130); });
  setTimeout(() => { console.error('global timeout'); kill(); process.exit(2); }, opts.timeoutMs).unref();

  let ws = '';
  for (let i = 0; i < 50 && !ws; i++) {
    try { const l = (await (await fetch(`http://127.0.0.1:${opts.port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>; ws = l.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? ''; } catch {}
    if (!ws) await sleep(200);
  }
  if (!ws) { kill(); throw new Error(`chrome did not expose a page on port ${opts.port}`); }
  const sock = new WebSocket(ws);
  await new Promise((r) => sock.addEventListener('open', r, { once: true }));
  let id = 0;
  const pend = new Map<number, (v: any) => void>();
  sock.addEventListener('message', (m) => {
    const x = JSON.parse(String(m.data));
    if (x.id && pend.has(x.id)) { pend.get(x.id)!(x.result); pend.delete(x.id); }
    if (x.method === 'Page.javascriptDialogOpening') sock.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
  });
  const send = (method: string, params: object = {}) => new Promise<any>((res) => { const n = ++id; pend.set(n, res); sock.send(JSON.stringify({ id: n, method, params })); });
  const ev = async <T,>(expression: string) => (await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression })).result?.value as T;
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: opts.width, height: opts.height, deviceScaleFactor: opts.dpr ?? 1, mobile: !!opts.mobile });
  if (opts.mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  return {
    send,
    ev,
    click: (label, exact = true) => ev<string>(`(()=>{const L=${JSON.stringify(label)}; const b=[...document.querySelectorAll('button,a,[role=button],summary')].find(e=>${exact ? 'e.textContent.trim()===L' : 'e.textContent.trim().includes(L)'}); if(!b) return 'missing'; b.scrollIntoView({block:'center'}); b.click(); return 'ok'})()`),
    png: async (file) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(file, Buffer.from(r.data, 'base64')); },
    close: () => { try { sock.close(); } catch {} kill(); },
  };
}

/** 공개 캡처 누설 점검 — `?capture=public` 화면에 남으면 안 되는 모양을 센다(값은 출력하지 않는다). */
export const PUBLIC_LEAK_CHECK = `(()=>{const t=document.body.innerText; const bad=[]; if(/\\/Users\\//.test(t)) bad.push('/Users/'); if(/\\$\\s?\\d/.test(t)) bad.push('USD'); if(/\\bmsb\\d+\\b/.test(t)) bad.push('msbN'); if(/\\.ts\\.net\\b/.test(t)) bad.push('ts.net'); if(/elt_[A-Za-z0-9_-]{16,}/.test(t)) bad.push('token'); return JSON.stringify({publicOn: t.includes('공개 캡처 켜짐'), bad, len: t.length})})()`;

/** 프레임(실제 촬영 시각)을 간격 그대로 mp4 로 — 상수 fps 가정 없이. */
export class Frames {
  readonly dir: string;
  readonly list: { f: string; t: number }[] = [];
  constructor(outDir: string) { this.dir = join(outDir, 'frames'); mkdirSync(this.dir, { recursive: true }); }
  add(base64Jpeg: string, t = Date.now() / 1000) { const f = join(this.dir, `f${String(this.list.length).padStart(5, '0')}.jpg`); writeFileSync(f, Buffer.from(base64Jpeg, 'base64')); this.list.push({ f, t }); }
  toMp4(mp4: string, w: number, h: number) {
    const lines: string[] = [];
    for (let i = 0; i < this.list.length; i++) { const d = i + 1 < this.list.length ? Math.max(0.001, this.list[i + 1].t - this.list[i].t) : 0.04; lines.push(`file '${this.list[i].f}'`, `duration ${d.toFixed(4)}`); }
    if (this.list.length) lines.push(`file '${this.list[this.list.length - 1].f}'`);
    const txt = join(this.dir, '..', 'frames.txt'); writeFileSync(txt, lines.join('\n'));
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', txt, '-vf', `fps=30,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', mp4]);
  }
}
