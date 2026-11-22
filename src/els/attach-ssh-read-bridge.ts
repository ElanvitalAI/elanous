// SSH pipe view: the registered host's read window supplies screens. No socket credential or write is used.
import { fetchHostJson, isTailnetOrLoopback } from './hosts.js';
import { parseAddress } from './address.js';
import { createLineDecoder } from './wire.js';
import { AUTH_OWNER_TOKEN_ENV, AUTH_PANE_TOKEN_ENV } from './server-auth.js';

export function runSshReadBridge(pane: string, cols: number, rows: number, baseUrl: string, ws: string, tab: string): Promise<number> {
  // A view-only bridge must never run while it still holds a server mutation credential.
  if (process.env[AUTH_OWNER_TOKEN_ENV] || process.env[AUTH_PANE_TOKEN_ENV]) return Promise.resolve(2);
  let url: URL;
  try { url = new URL(baseUrl); }
  catch { return Promise.resolve(2); }
  if (url.origin !== baseUrl || !['http:', 'https:'].includes(url.protocol) || !isTailnetOrLoopback(url.hostname)
    || !parseAddress(`${ws}/${tab}/${pane}`)) return Promise.resolve(2);
  return new Promise(resolve => {
    let finished = false; let started = false; let seq = 0; let last = '';
    let pendingInput = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const out = (payload: unknown) => { if (!finished) process.stdout.write(`${JSON.stringify(payload)}\n`); };
    const finish = (code: number, reason?: string) => {
      if (finished) return;
      if (reason) out({ op: 'end', code, reason });
      finished = true;
      if (timer) clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onStdinEnd);
      process.stdin.pause();
      resolve(code);
    };
    const poll = async (): Promise<void> => {
      if (finished) return;
      try {
        const answer = await fetchHostJson({ name: 'self', baseUrl },
          `/els/read?address=${encodeURIComponent(`${ws}/${tab}/${pane}`)}`, 2_000);
        const body = answer.body && typeof answer.body === 'object' ? answer.body as { screen?: unknown } : {};
        if (answer.status !== 200 || typeof body.screen !== 'string') { finish(1, 'remote read refused'); return; }
        if (body.screen !== last || seq === 0) {
          last = body.screen;
          out({ op: 'frame', pane, seq: ++seq, cols, rows, screen: body.screen, back: 0 });
        }
      } catch { finish(1, 'remote read unavailable'); return; }
      if (!finished) timer = setTimeout(poll, 250);
    };
    const lines = createLineDecoder(line => {
      let msg: { op?: unknown };
      try { msg = JSON.parse(line) as typeof msg; } catch { finish(2, 'invalid attach wire'); return; }
      if (msg.op === 'attach' && !started) { started = true; void poll(); }
      else if (msg.op === 'input') out({ op: 'error', message: 'remote SSH attach is view-only' });
      else if (msg.op === 'end') finish(0);
    });
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        pendingInput = byte === 10 ? 0 : pendingInput + 1;
        if (pendingInput > 64 * 1024) { finish(2, 'attach wire too large'); return; }
      }
      lines.push(chunk);
    };
    const onStdinEnd = () => finish(0);
    process.stdin.on('data', onData);
    process.stdin.on('end', onStdinEnd);
    process.stdin.resume();
  });
}
