// ELS-CHANNEL P3 minimal (대표 11-27 01:0x «대화 채널을 빠르게 보고 싶네요») — the channel view tile: `els channel view <ch>`
// draws the conversation and keeps an input line at the bottom so a person can watch and talk. New messages arrive by the
// server's own wait (answered the moment a post lands — no poll); a burst is then read in one `read after`.
// Input: plain text → say · `/ask …` · `/handoff …` · `@<pane|seat|loop:id> …` addresses one participant · `/hold` · `/resume` · `/quit`.

import { createInterface } from 'node:readline';
import type { ChannelMessage, ChannelRequest } from './channel-log.js';
import type { ElsResult } from './core.js';

export type ChannelAsk = (request: { op: 'channel' } & ChannelRequest, timeoutMs?: number) => Promise<ElsResult>;

const C = { dim: '\u001b[2m', bold: '\u001b[1m', reset: '\u001b[0m', cyan: '\u001b[36m', magenta: '\u001b[35m', yellow: '\u001b[33m', green: '\u001b[32m', red: '\u001b[31m' };
const PALETTE = [C.cyan, C.green, C.yellow, C.magenta];

/** Who wrote a message, as shown in the tile. */
export function speaker(m: Pick<ChannelMessage, 'from' | 'human'>): string {
  if (m.from.role === 'server') return '·';
  if (m.from.role === 'loop') return `↻ ${m.from.seat ?? 'loop'}`;
  if (m.human || m.from.role === 'operator') return 'you';
  return m.from.seat && m.from.pane ? `${m.from.seat}·${m.from.pane}` : m.from.seat ?? m.from.pane ?? m.from.role;
}

/** One message → one or more display lines (no colour when `color` is false — tests and pipes). */
export function formatChannelLine(m: ChannelMessage, color = true): string {
  const paint = (code: string, text: string): string => (color ? `${code}${text}${C.reset}` : text);
  const t = new Date(m.at);
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  const who = speaker(m);
  const whoColor = m.from.role === 'server' ? C.dim : m.from.role === 'loop' ? C.magenta : who === 'you' ? C.bold : PALETTE[[...who].reduce((a, ch) => a + ch.charCodeAt(0), 0) % PALETTE.length]!;
  const kind = m.type === 'say' ? '' : ` ${paint(m.type === 'ask' || m.type === 'handoff' ? C.yellow : C.dim, m.type)}`;
  const to = m.to?.length ? paint(C.dim, ` → ${m.to.join(',')}`) : '';
  const refs = m.refs?.length ? `\n      ${paint(C.dim, m.refs.join('  '))}` : '';
  const body = m.from.role === 'server' ? paint(C.dim, m.body) : m.body;
  return `${paint(C.dim, hhmm)} ${paint(whoColor, who)}${kind}${to}  ${body.replace(/\n/g, '\n      ')}${refs}`;
}

export type ViewInput =
  | { readonly kind: 'post'; readonly type: 'say' | 'ask' | 'handoff'; readonly body: string; readonly to?: readonly string[] }
  | { readonly kind: 'hold' | 'resume' | 'quit' | 'empty' };

/** The input line → one action. */
export function parseViewInput(line: string): ViewInput {
  let text = line.trim();
  if (!text) return { kind: 'empty' };
  if (text === '/quit' || text === '/q') return { kind: 'quit' };
  if (text === '/hold') return { kind: 'hold' };
  if (text === '/resume') return { kind: 'resume' };
  let type: 'say' | 'ask' | 'handoff' = 'say';
  const cmd = /^\/(ask|handoff)\s+/.exec(text);
  if (cmd) { type = cmd[1] as 'ask' | 'handoff'; text = text.slice(cmd[0].length); }
  const at = /^@([A-Za-z0-9._:+-]{1,96})(?:\s+|$)/.exec(text);
  const to = at ? [at[1]!] : undefined;
  if (at) text = text.slice(at[0].length);
  if (!text.trim()) return { kind: 'empty' };
  return { kind: 'post', type, body: text, ...(to ? { to } : {}) };
}

const WAIT_MS = 25_000; // 출처: 내부 문서 `ELS-CHANNEL` §2 — the server holds a wait at most 25 s
const RETRY_MS = 2_000; // 출처: 내부 문서 `ELS-CHANNEL` §9 — a lost server is retried, never spun on

export interface ChannelViewIo {
  readonly out: Pick<NodeJS.WriteStream, 'write'> & { readonly isTTY?: boolean };
  readonly input: NodeJS.ReadableStream;
  /** The retry pause (tests pass a fast one). */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Run the tile until /quit or Ctrl-C. A lost server never ends the tile (Terra #40331 must-4): one error line per outage,
 *  then a retry every RETRY_MS until the server answers again — the first read included. */
export async function runChannelView(channel: string, ask: ChannelAsk, io: ChannelViewIo = { out: process.stdout, input: process.stdin }): Promise<number> {
  const { out } = io;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const tty = !!out.isTTY;
  let after = 0;
  let closed = false;
  const rl = createInterface({ input: io.input, output: out as NodeJS.WritableStream, terminal: tty });
  rl.setPrompt(`${tty ? C.dim : ''}${channel}${tty ? C.reset : ''} › `);
  const print = (text: string): void => {
    if (tty) out.write('\r\u001b[2K');
    out.write(`${text}\n`);
    if (!closed && tty) rl.prompt(true);
  };
  let lastError = '';
  const report = (message: string): void => { if (message !== lastError) { lastError = message; print(tty ? `${C.red}${message}${C.reset}` : message); } };
  const show = (messages: readonly ChannelMessage[]): void => { for (const m of messages) { if (m.seq > after) { print(formatChannelLine(m, tty)); after = m.seq; } } };
  /** true = caught up; false = the server refused or is gone (already reported). */
  const readNew = async (): Promise<boolean> => {
    const r = await ask({ op: 'channel', action: 'read', channel, ...(after ? { after } : {}), limit: 200 });
    if (r.exitCode !== 0) { report(r.message); return false; }
    show((JSON.parse(r.message) as { messages: ChannelMessage[] }).messages);
    if (lastError) { lastError = ''; print(tty ? `${C.dim}reconnected${C.reset}` : 'reconnected'); }
    return true;
  };
  out.write(`${tty ? C.bold : ''}# ${channel}${tty ? C.reset : ''}  text = say · /ask … · @<who> … · /hold · /resume · /quit\n`);
  if (tty) rl.prompt();
  rl.on('line', (line) => {
    const input = parseViewInput(line);
    if (input.kind === 'quit') { closed = true; rl.close(); return; }
    if (input.kind === 'empty') { if (tty) rl.prompt(); return; }
    const request: { op: 'channel' } & ChannelRequest = input.kind === 'post'
      ? { op: 'channel', action: 'post', channel, type: input.type, body: input.body, ...(input.to ? { to: input.to } : {}) }
      : { op: 'channel', action: input.kind, channel };
    void ask(request).then((r) => { if (r.exitCode !== 0) print(r.message); else if (tty) rl.prompt(); }, (e: unknown) => print(`els channel: ${e instanceof Error ? e.message : String(e)}`));
  });
  const done = new Promise<void>((resolve) => rl.on('close', () => { closed = true; resolve(); }));
  void (async () => {
    let synced = false;
    while (!closed) {
      try {
        if (!synced) { synced = await readNew(); if (!synced) await sleep(RETRY_MS); continue; }
        const r = await ask({ op: 'channel', action: 'wait', channel, after, all: true, timeoutMs: WAIT_MS }, WAIT_MS + 5_000);
        if (closed) break;
        if (r.exitCode !== 0) { report(r.message); synced = false; await sleep(RETRY_MS); continue; }
        if ((JSON.parse(r.message) as { message?: ChannelMessage }).message) synced = await readNew();
      } catch (error) {
        if (closed) break;
        report(`els channel: ${error instanceof Error ? error.message : String(error)} — retrying`);
        synced = false;
        await sleep(RETRY_MS);
      }
    }
  })();
  await done;
  return 0;
}
