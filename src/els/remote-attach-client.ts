// els remote attach client (stage 5) — the els-attach line-JSON protocol over one HTTP request to a registered
// host's window: `POST /els/attach/<pane>?cols=&rows=&from=`. Frames come back as chunked lines of the same shape as
// the Unix-socket attach (src/els/attach-client.ts), `input`/`resize` lines go out in the request body, and ending
// the request is detach (the pane keeps running there). The drawing is not here: the caller passes the same handlers
// to attachEls or attachRemote, so keys, colors and view stay one code path.
//
// Like fetchHostJson (src/els/hosts.ts): the host name must resolve to loopback or tailnet addresses before the
// connection is made; anything else is refused without a request.

import { lookup } from 'node:dns/promises';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { AttachFrame, AttachHandlers, Attached } from './attach-client.js';
import { isTailnetOrLoopback, type FederatedHost } from './hosts.js';
import { createLineDecoder } from './wire.js';

export interface RemoteAttachDeps {
  /** Name → addresses (default: the system resolver). The connection goes to the address checked here, never re-resolved. */
  readonly lookup?: (name: string) => Promise<string[]>;
}

const systemLookup = async (name: string): Promise<string[]> => (await lookup(name, { all: true })).map((entry) => entry.address);

export function attachRemote(host: FederatedHost, pane: string, size: { cols: number; rows: number }, handlers: AttachHandlers, from = '', deps: RemoteAttachDeps = {}): Attached {
  let ended = false;
  let cancelled = false;   // detach before the request exists: nothing may be opened afterwards
  let opened: ClientRequest | undefined;
  let queued: string[] = [];   // lines typed before the request exists follow it in order, never overtake it
  const end = (exitCode: 0 | 1 | 2, reason: string): void => { if (!ended) { ended = true; handlers.onEnd(exitCode, reason); } };
  const write = (value: object): void => {
    if (ended) return;
    const line = `${JSON.stringify(value)}\n`;
    if (opened && !opened.destroyed) opened.write(line);
    else queued.push(line);
  };
  void (async () => {
    try {
      const url = new URL(`/els/attach/${encodeURIComponent(pane)}`, host.baseUrl);
      url.searchParams.set('cols', String(size.cols));
      url.searchParams.set('rows', String(size.rows));
      if (from !== '') url.searchParams.set('from', from);
      const name = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(name) ? [name] : await (deps.lookup ?? systemLookup)(name);
      if (cancelled) return;   // detached while the name was resolving: open nothing
      const outside = addresses.find((address) => !isTailnetOrLoopback(address));
      const pinned = addresses[0];
      if (outside !== undefined || pinned === undefined) {
        throw new Error(`${name} resolves to ${outside ?? 'nothing'}, not a tailnet or loopback address`);
      }
      // Connect to the checked address itself (no second resolution a rebinding answer could change); the name rides
      // in the Host header (and SNI for https).
      const https = url.protocol === 'https:';
      const options = {
        method: 'POST', host: pinned, family: isIP(pinned), port: url.port === '' ? (https ? 443 : 80) : Number(url.port),
        path: `${url.pathname}${url.search}`, headers: { host: url.host, 'content-type': 'application/x-ndjson' },
        ...(https && !isIP(name) ? { servername: name } : {}),
      };
      const send = (https ? httpsRequest : httpRequest)(options, (message: IncomingMessage) => {
        if (message.statusCode !== 200) {
          // A refusal is one small JSON answer: the client stops typing and shows why.
          let body = '';
          message.setEncoding('utf8');
          message.on('data', (chunk: string) => { body += chunk; });
          message.on('end', () => {
            let why = `http ${message.statusCode}`;
            try { const parsed = JSON.parse(body) as { error?: unknown }; if (typeof parsed.error === 'string') why = parsed.error; } catch { /* not JSON */ }
            end(1, why);
          });
          return;
        }
        const lines = createLineDecoder((line) => {
          let value: { type?: string; exitCode?: 0 | 1 | 2; message?: string } & Partial<AttachFrame>;
          try { value = JSON.parse(line) as typeof value; } catch { end(1, `els attach: malformed frame from ${host.name}`); return; }
          if (value.type === 'frame' && typeof value.screen === 'string') {
            handlers.onFrame({ pane: String(value.pane), seq: Number(value.seq), cols: Number(value.cols), rows: Number(value.rows), screen: value.screen, back: 0 });
          } else if (value.type === 'end') end(value.exitCode ?? 0, value.message ?? '');
          else if (value.type === 'error') handlers.onError?.(value.message ?? 'refused');
        });
        message.on('data', (chunk: Buffer) => lines.push(chunk));
        // The stream ended without a word: a closed window, not a detach (a detach is answered and quiet).
        message.on('end', () => end(1, `els attach: ${host.name} closed the attach stream`));
        message.on('error', () => end(1, `els attach: ${host.name} closed the attach stream`));
      });
      send.on('error', (error: NodeJS.ErrnoException) => {
        end(1, error.code === 'ECONNREFUSED'
          ? `els attach: ${host.name} is not answering — is its window open? (\`els serve --http\` there)`
          : `els attach: ${error.message}`);
      });
      opened = send;
      // The headers go out now — the request body stays open: it is the input stream, and ending it is detach.
      // (Node sends a request only on the first write or end(); an attach that types nothing would never start.)
      send.flushHeaders();
      for (const line of queued) send.write(line);
      queued = [];
    } catch (error) {
      end(1, `els attach: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
  return {
    input: (bytes) => write({ op: 'input', bytes }),
    resize: (cols, rows) => write({ op: 'resize', cols, rows }),
    // The window stream has no scrollback lane (the frames are the live screen), like the ssh bridge.
    scroll: () => {},
    // Detach ends the request body; the host answers {type:'end'} and the pane keeps running there.
    detach: () => { cancelled = true; if (!ended) { ended = true; opened?.end(); } },
  };
}
