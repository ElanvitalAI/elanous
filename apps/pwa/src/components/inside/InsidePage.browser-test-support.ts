/// <reference types="bun-types" />
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface InsideCdpReply {
  readonly result?: { readonly result?: { readonly value?: unknown }; readonly exceptionDetails?: unknown };
  readonly error?: unknown;
}

export interface InsideBrowserSession {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly send: (method: string, params?: object) => Promise<InsideCdpReply>;
  close(): void;
}

let sessionPromise: Promise<InsideBrowserSession> | undefined;

/** Reuse one real Chromium/CDP session across /inside viewport checks in this test file. */
export function insideBrowserSession(chromium: string, out: string): Promise<InsideBrowserSession> {
  sessionPromise ??= startInsideBrowserSession(chromium, out);
  return sessionPromise;
}

export async function closeInsideBrowserSession(): Promise<void> {
  const session = await sessionPromise?.catch(() => undefined);
  session?.close();
  sessionPromise = undefined;
}

async function startInsideBrowserSession(chromium: string, out: string): Promise<InsideBrowserSession> {
  const profile = mkdtempSync(join(tmpdir(), 'inside-browser-'));
  const server = Bun.serve({ port: 0, fetch: (request) => {
    const pathname = new URL(request.url).pathname;
    const relative = pathname.replace(/^\/app\//, '').replace(/\/$/, '/index.html') || 'index.html';
    if (!pathname.startsWith('/app/') || relative.includes('..')) return new Response('not found', { status: 404 });
    const path = join(out, relative);
    if (!existsSync(path)) return new Response('not found', { status: 404 });
    const type = path.endsWith('.html') ? 'text/html' : path.endsWith('.css') ? 'text/css'
      : path.endsWith('.js') ? 'application/javascript' : path.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream';
    return new Response(Bun.file(path), { headers: { 'content-type': type } });
  } });
  const browser = spawn(chromium, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let socket: WebSocket | undefined;
  try {
    let debuggerUrl = '';
    for (let attempt = 0; attempt < 100 && !debuggerUrl; attempt++) {
      if (!browser.pid || browser.exitCode !== null) throw Error('Chromium exited before exposing CDP');
      if (existsSync(join(profile, 'DevToolsActivePort'))) {
        const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
        try {
          const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl?: string }>;
          debuggerUrl = tabs.find((tab) => tab.type === 'page')?.webSocketDebuggerUrl ?? '';
        } catch { /* CDP endpoint not ready yet. */ }
      }
      if (!debuggerUrl) await Bun.sleep(100);
    }
    if (debuggerUrl) {
      socket = new WebSocket(debuggerUrl);
      await new Promise<void>((resolve, reject) => {
        socket!.onopen = () => resolve();
        socket!.onerror = () => reject(Error('CDP connection failed'));
      });
    }
    let id = 0;
    const pending = new Map<number, (reply: InsideCdpReply) => void>();
    if (socket) socket.onmessage = (event) => {
      const reply = JSON.parse(String(event.data)) as { id?: number } & InsideCdpReply;
      if (reply.id && pending.has(reply.id)) { pending.get(reply.id)!(reply); pending.delete(reply.id); }
    };
    const send = (method: string, params: object = {}) => new Promise<InsideCdpReply>((resolve, reject) => {
      if (!socket) { reject(Error('Chromium did not expose a CDP page')); return; }
      const next = ++id;
      pending.set(next, resolve);
      socket.send(JSON.stringify({ id: next, method, params }));
    });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__insideStreams = [];
      window.EventSource = class {
        constructor(url) { this.url = url; this.handlers = {}; window.__insideStreams.push(this); }
        addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
        removeEventListener(name, fn) { this.handlers[name] = (this.handlers[name] || []).filter((handler) => handler !== fn); }
        close() {}
        emit(frame) { for (const handler of this.handlers.log || []) handler({ data: JSON.stringify(frame) }); }
      };
    ` });
    let closed = false;
    return {
      server, send,
      close() {
        if (closed) return;
        closed = true;
        socket?.close();
        browser.kill();
        server.stop(true);
        rmSync(profile, { recursive: true, force: true });
      },
    };
  } catch (error) {
    socket?.close();
    browser.kill();
    server.stop(true);
    rmSync(profile, { recursive: true, force: true });
    throw error;
  }
}
