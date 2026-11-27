// ELS-CHANNEL P0 CLI — `els channel ls · read · post · ack · wait · hold · resume · open` (내부 문서 `ELS-CHANNEL` §5-4).
// Registered from inside the els product (re-exported through control-cli.ts so the eln→els boundary does not grow).
// Every command is one request to the els server; the server decides who the sender is (pane credential), never a flag.

import type { Command } from 'commander';
import { requestEls } from './client.js';
import type { ElsResult } from './core.js';
import { CHANNEL_WAIT_MAX_MS, type ChannelRequest } from './channel-log.js';
import { elsSocketPath } from './server.js';
import { dirname, join } from 'node:path';
import { parseChannelId } from './channel-log.js';
import { runChannelView } from './channel-view.js';
import { writeLoopVoiceDecl } from './loop-voice.js';
import type { ElsRequest } from './server.js';

export interface ChannelCliDeps {
  readonly emit: (result: ElsResult) => void;
  readonly request?: (request: { op: 'channel' } & ChannelRequest, timeoutMs?: number) => Promise<ElsResult>;
  /** Opening the view tab (`new`) — injectable for tests. */
  readonly newPane?: (request: Extract<ElsRequest, { op: 'new' }>) => Promise<ElsResult>;
  /** The els state folder (loop voice declarations live in <els>/loops). */
  readonly elsDir?: () => string;
}

/** The program running this CLI, so a view tab runs the same build (the test universe's tree in a test run). */
export function selfCommand(argv: readonly string[] = process.argv, execPath = process.execPath): string[] {
  const script = argv[1] ?? '';
  return /elanous(\.mjs|\.ts|\.js)?$/.test(script) && script !== execPath ? [execPath, script] : ['elanous'];
}

/** The workspace a channel's view tab opens in: ws:<name> → that workspace; otherwise this pane's workspace, else «channels». */
export function viewWorkspace(channel: string, env: Record<string, string | undefined> = process.env): string {
  const ref = parseChannelId(channel);
  if (ref?.kind === 'ws') return ref.ws;
  return env.ELANOUS_ELS_WS?.trim() || 'channels';
}

const intOpt = (v: string | undefined): number | undefined => (v !== undefined && /^\d{1,9}$/.test(v) ? Number(v) : undefined);
/** Terra #40282 should: a mistyped number is refused with the fix, never silently dropped to a default. */
const badNumber = (opts: Record<string, string | undefined>): string | undefined => {
  for (const [name, v] of Object.entries(opts)) if (v !== undefined && intOpt(v) === undefined) return `els channel: --${name} must be a whole number (got ${JSON.stringify(v)})`;
  return undefined;
};
const listOpt = (v: string | undefined): string[] | undefined => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);

export function registerChannelCommands(side: Command, deps: ChannelCliDeps): void {
  const send = (request: ChannelRequest, timeoutMs?: number): Promise<void> =>
    (deps.request ?? ((r, t) => requestEls(elsSocketPath(), r, t)))({ op: 'channel', ...request }, timeoutMs).then(deps.emit);
  const channel = side.command('channel').description('Typed messages between agents in different tiles: ls · read · post · ack · wait · hold · resume · open (ws:<id> · run:<id> · pair:<a>+<b>)');
  channel.command('ls').description('Channels you can read: last seq · open asks/handoffs · paused').action(() => send({ action: 'list' }));
  channel.command('read <channel>').description('Messages after a seq (default: the last 50)')
    .option('--after <seq>', 'only messages with seq greater than this')
    .option('--limit <n>', 'at most this many (≤200)')
    .action((ch: string, o: { after?: string; limit?: string }) => badNumber({ after: o.after, limit: o.limit }) ? deps.emit({ exitCode: 2, message: badNumber({ after: o.after, limit: o.limit })! }) : send({ action: 'read', channel: ch, ...(intOpt(o.after) !== undefined ? { after: intOpt(o.after) } : {}), ...(intOpt(o.limit) ? { limit: intOpt(o.limit) } : {}) }));
  channel.command('post <channel> <text...>').description('Post one message (the sender is your pane, decided by the server)')
    .option('--type <type>', 'say · ask · answer · handoff · file · done', 'say')
    .option('--to <ids>', 'comma-separated pane ids / seats / loop:<id> to address')
    .option('--reply-to <id>', 'the ask/handoff this answer/done closes')
    .option('--refs <refs>', 'comma-separated structured refs (pr:N · cell:X · file:<path>)')
    .option('--turn <id>', 'your runtime turn id (a retry of the same turn is refused, not duplicated)')
    .action((ch: string, text: string[], o: { type: string; to?: string; replyTo?: string; refs?: string; turn?: string }) => send({
      action: 'post', channel: ch, type: o.type, body: text.join(' '),
      ...(listOpt(o.to) ? { to: listOpt(o.to) } : {}), ...(o.replyTo ? { replyTo: o.replyTo } : {}), ...(listOpt(o.refs) ? { refs: listOpt(o.refs) } : {}), ...(o.turn ? { turn: o.turn } : {}),
    }));
  channel.command('ack <channel> <id>').description('Mark a message read/handled by you').action((ch: string, id: string) => send({ action: 'ack', channel: ch, id }));
  channel.command('wait <channel>').description(`Block until the next message for you lands (server-side wait · ≤${CHANNEL_WAIT_MAX_MS / 1000}s · re-run to keep waiting)`)
    .option('--after <seq>', 'wait for a message after this seq (default: the current last)')
    .option('--timeout <ms>', `give up after this long (≤${CHANNEL_WAIT_MAX_MS})`)
    .action((ch: string, o: { after?: string; timeout?: string }) => {
      const bad = badNumber({ after: o.after, timeout: o.timeout });
      if (bad) { deps.emit({ exitCode: 2, message: bad }); return; }
      const timeoutMs = Math.min(intOpt(o.timeout) ?? CHANNEL_WAIT_MAX_MS, CHANNEL_WAIT_MAX_MS);
      return send({ action: 'wait', channel: ch, timeoutMs, ...(intOpt(o.after) !== undefined ? { after: intOpt(o.after) } : {}) }, timeoutMs + 5_000);
    });
  channel.command('hold <channel>').description('Pause a channel (agents cannot post until a person or OP resumes it)').action((ch: string) => send({ action: 'hold', channel: ch }));
  channel.command('resume <channel>').description('Resume a paused channel (a person or OP)').action((ch: string) => send({ action: 'resume', channel: ch }));
  const ask = (r: { op: 'channel' } & ChannelRequest, t?: number): Promise<ElsResult> => (deps.request ?? ((x, y) => requestEls(elsSocketPath(), x, y)))(r, t);
  channel.command('view <channel>').description('The channel view tile: watch the conversation live and talk (text = say · /ask … · @<who> … · /hold · /resume · /quit)')
    .action(async (ch: string) => { const code = await runChannelView(ch, ask); process.exitCode = code; });
  channel.command('voice <loop> <command...>').description('Give a loop agent a voice: each message to loop:<loop> runs <command> once (JSON line in on stdin → {"text","evidence","actions"} JSON line out). Put the command after --')
    .action((loop: string, command: string[]) => {
      try { writeLoopVoiceDecl(join((deps.elsDir ?? (() => dirname(elsSocketPath())))(), 'loops'), loop, command); deps.emit({ exitCode: 0, message: JSON.stringify({ loop: `loop:${loop}`, command }) }); }
      catch (error) { deps.emit({ exitCode: 2, message: `els channel voice: ${error instanceof Error ? error.message : String(error)}` }); }
    });
  channel.command('open <channel>').description('Create the channel (if new) and open its view tile in a tab — ws:<name> opens in that workspace. Policy options shape a run channel (moderated panels · caps)')
    .option('--floor <floor>', 'free · moderated')
    .option('--moderator <id>', 'pane id or seat that holds the floor')
    .option('--auto-reply <mode>', 'off · ask-only · on')
    .option('--max <n>', 'message cap for the channel')
    .option('--ws <workspace>', 'owner workspace (OP / operator only — a pane opens in its own workspace)')
    .action(async (ch: string, o: { floor?: string; moderator?: string; autoReply?: string; max?: string; ws?: string }) => {
      const bad = badNumber({ max: o.max });
      if (bad) { deps.emit({ exitCode: 2, message: bad }); return; }
      const opened = await ask({ op: 'channel', action: 'open', channel: ch, ...(o.ws ? { ws: o.ws } : {}),
        policy: { ...(o.floor ? { floor: o.floor as 'free' | 'moderated' } : {}), ...(o.moderator ? { moderator: o.moderator } : {}), ...(o.autoReply ? { autoReply: o.autoReply as 'off' | 'ask-only' | 'on' } : {}), ...(intOpt(o.max) ? { maxMessages: intOpt(o.max) } : {}) } });
      // An existing channel is fine — open still shows it.
      if (opened.exitCode !== 0 && !opened.message.includes('already exists')) { deps.emit(opened); return; }
      const tab = await (deps.newPane ?? ((r) => requestEls(elsSocketPath(), r)))({ op: 'new', ws: viewWorkspace(ch), cwd: process.cwd(), command: [...selfCommand(), 'side', 'channel', 'view', ch], title: `# ${ch}` });
      deps.emit(tab.exitCode === 0 ? { exitCode: 0, message: JSON.stringify({ channel: ch, created: opened.exitCode === 0, view: JSON.parse(tab.message) as unknown }) } : tab);
    });
}
