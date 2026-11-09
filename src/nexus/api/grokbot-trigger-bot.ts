import { spawn } from 'node:child_process';
import { debug } from '../../debug/log.js';
import { receiveChannelEvent } from '../outbound/router.js';
import { registerGrokbotAdapter } from '../outbound/grokbot-adapter.js';
import { createSession, listSessions } from '../../session/index.js';
import type { UserConfig } from '../../user-config/types.js';
import type { runTurn } from '../../session/chat.js';
import type { ChannelEnvelope } from '../outbound/router.js';

const DEFAULT_AGENT = 'COO';
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const MAX_MESSAGE_BYTES = 64 * 1024;

export interface GrokbotPendingMessage {
  id: string;
}

export interface GrokbotMailbox {
  listPending(): Promise<GrokbotPendingMessage[]>;
  /** Atomically move a pending request into processing; null means another consumer claimed it. */
  claim(id: string): Promise<string | null>;
  acknowledge(id: string, text: string): Promise<void>;
  complete(id: string, text: string): Promise<void>;
  sendPrompt(agent: string, prompt: string): Promise<{ preview?: string }>;
}

export interface NexusGrokbotTriggerBotOptions {
  mailbox: GrokbotMailbox;
  dispatch: (event: ChannelEnvelope) => Promise<string>;
  pollIntervalMs?: number;
  now?: () => string;
  log?: (event: string, data: Record<string, unknown>) => void;
}

const GROKBOT_SESSION_CHAT_ID = -707151151;
const GROKBOT_SESSION_BOT_ID = 'grokbot-coo';

function grokbotMainSessionId(): string {
  const existing = listSessions().find((session) => session.origin === 'grokbot' && session.personaId === 'grokbot-coo');
  if (existing) return existing.id;
  return createSession({
    source: 'cli', sourceKind: 'telegram', origin: 'grokbot', personaId: 'grokbot-coo',
    title: 'Grok Bot COO · 주 세션',
  }).id;
}

/** Reuse one durable main-agent session for the bot's conversation across requests and restarts. */
export function createGrokbotMainSessionDispatcher(
  userConfig: UserConfig,
  runTurnImpl: typeof runTurn,
  getSessionId: () => string = grokbotMainSessionId,
): (event: ChannelEnvelope) => Promise<string> {
  const sessionId = getSessionId();
  return async (event) => {
    const result = await runTurnImpl({
      userConfig,
      sessionId,
      userText: event.text,
      utteranceSurface: 'telegram',
      tgChat: { botId: GROKBOT_SESSION_BOT_ID, chatId: GROKBOT_SESSION_CHAT_ID },
    });
    return result.text;
  };
}

export interface NexusGrokbotTriggerBotHandle {
  pollOnce(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

function safeReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 240);
}

function validId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
}

function runRemote(script: string, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', 'box@grbot-coo', 'bash -s'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    const timeout = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.on('error', () => { clearTimeout(timeout); reject(new Error('grokbot transport unavailable')); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout.trimEnd());
      else reject(new Error('grokbot transport failed'));
    });
    child.stdin.end(script);
  });
}

function encoded(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength > MAX_MESSAGE_BYTES) throw new Error('grokbot message exceeds 64 KiB');
  return bytes.toString('base64');
}

function remoteWrite(relativePath: string, value: string): string {
  if (!/^[A-Za-z0-9_./-]+$/.test(relativePath)) throw new Error('invalid grokbot output path');
  const body = encoded(value);
  const target = `"$HOME/${relativePath}"`;
  return `set -eu\nmkdir -p "$(dirname ${target})"\nprintf '%s' '${body}' | base64 -d > ${target}\n`;
}

/** SSH-only transport to the COO bot host. The gateway credential remains on that host. */
export function createSshGrokbotMailbox(): GrokbotMailbox {
  return {
    async listPending() {
      const output = await runRemote(`set -eu\nfor f in "$HOME"/elanous-inbox/*.txt; do\n  [ -f "$f" ] || continue\n  b=\${f##*/}; printf '%s\\n' "\${b%.txt}"\ndone\n`);
      return output.split('\n').filter(validId).map((id) => ({ id }));
    },
    async claim(id) {
      if (!validId(id)) throw new Error('invalid grokbot request id');
      const output = await runRemote(`set -eu\nroot="$HOME/elanous-inbox"\nmkdir -p "$root/processing"\nsrc="$root/${id}.txt"\ndst="$root/processing/${id}.txt"\n[ -f "$src" ] || exit 3\n[ ! -e "$dst" ] || exit 4\nmv "$src" "$dst"\nbase64 "$dst" | tr -d '\\n'\n`);
      return Buffer.from(output, 'base64').toString('utf8');
    },
    async acknowledge(id, text) {
      if (!validId(id)) throw new Error('invalid grokbot request id');
      await runRemote(`${remoteWrite(`elanous-outbox/${id}.ack`, text)}printf '%s\\n' "$(date -Is)" >> "$HOME/elanous-inbox/processing/${id}.accepted"\n`);
    },
    async complete(id, text) {
      if (!validId(id)) throw new Error('invalid grokbot request id');
      await runRemote(`${remoteWrite(`elanous-outbox/${id}.md`, text)}mkdir -p "$HOME/elanous-inbox/done"\nif [ -f "$HOME/elanous-inbox/processing/${id}.txt" ]; then mv "$HOME/elanous-inbox/processing/${id}.txt" "$HOME/elanous-inbox/done/${id}.txt"; fi\n`);
    },
    async sendPrompt(agent, prompt) {
      if (agent !== DEFAULT_AGENT) throw new Error('grokbot agent is not allowlisted');
      const body = encoded(prompt);
      const script = `set -eu\ntoken=$(jq -er '.token | strings | select(length > 0)' "$HOME/sand-data/gateway.json")\nagent=$(curl -fsS -m 15 -X POST http://127.0.0.1:1340/api/listAgents -H 'Content-Type: application/json' -H "Authorization: Bearer $token" -d '{}' | jq -er '.[] | select(.name == "COO") | .id' | head -n 1)\n[ -n "$agent" ]\nprintf '%s' '${body}' | base64 -d | jq -Rs --arg agentId "$agent" '{agentId:$agentId,prompt:.}' | curl -fsS -m 30 -X POST http://127.0.0.1:1340/api/sendPrompt -H 'Content-Type: application/json' -H "Authorization: Bearer $token" --data-binary @- | jq -c '{preview:(.lastMessagePreview // .preview // "")}'\n`;
      const response = await runRemote(script, 45_000);
      const parsed = JSON.parse(response) as { preview?: unknown };
      return { ...(typeof parsed.preview === 'string' && parsed.preview ? { preview: parsed.preview } : {}) };
    },
  };
}

export function createNexusGrokbotTriggerBot(options: NexusGrokbotTriggerBotOptions): NexusGrokbotTriggerBotHandle {
  const now = options.now ?? (() => new Date().toISOString());
  const log = options.log ?? ((event, data) => debug.log('channel.grokbot', event, data));
  const unregister = registerGrokbotAdapter({
    sendPrompt: (agent, prompt) => options.mailbox.sendPrompt(agent, prompt),
    now,
    log,
  });
  let stopped = false;
  let polling = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let currentPoll: Promise<void> | undefined;

  const pollOnce = async (): Promise<void> => {
    if (stopped || polling) return currentPoll;
    polling = true;
    currentPoll = (async () => {
      try {
        const messages = await options.mailbox.listPending();
        for (const { id } of messages) {
          if (stopped) break;
          let text: string | null;
          try { text = await options.mailbox.claim(id); }
          catch (error) { log('failure', { id, failedAt: now(), reason: safeReason(error), stage: 'claim' }); continue; }
          if (text === null) continue;
          try {
            const kind = /^(승인|보류|수정)(?:\s|[:：]|$)/.test(text.trim()) ? 'decision' : 'request';
            const envelope = await receiveChannelEvent('grokbot', { id, text, kind });
            if (!envelope || envelope instanceof Promise) throw new Error('grokbot request normalization failed');
            await options.mailbox.acknowledge(id, 'OP 접수 — 답을 준비 중입니다.');
            const reply = await options.dispatch(envelope);
            if (!reply.trim()) throw new Error('main session returned an empty reply');
            await options.mailbox.complete(id, reply);
            log('reply', { id, repliedAt: now(), replyChars: reply.length });
          } catch (error) {
            const reason = safeReason(error);
            log('failure', { id, failedAt: now(), reason, stage: 'dispatch-or-reply' });
            try { await options.mailbox.complete(id, '요청을 처리하지 못했습니다. 주 세션 연결과 eln logs의 channel.grokbot 기록을 확인해 주세요.'); }
            catch (replyError) { log('failure', { id, failedAt: now(), reason: safeReason(replyError), stage: 'failure-reply' }); }
          }
        }
      } catch (error) {
        log('failure', { failedAt: now(), reason: safeReason(error), stage: 'poll' });
      }
    })().finally(() => { polling = false; });
    return currentPoll;
  };

  return {
    pollOnce,
    start() {
      if (stopped || timer) return;
      void pollOnce();
      timer = setInterval(() => { void pollOnce(); }, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await currentPoll;
      unregister();
    },
  };
}
