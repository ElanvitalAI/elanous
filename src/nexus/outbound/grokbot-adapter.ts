import { debug } from '../../debug/log.js';
import { registerOutboundAdapter } from './router.js';
import type {
  ChannelAdapter,
  ChannelEnvelope,
  ChannelResult,
  OutboundChannelConfig,
  RouterDeps,
} from './router.js';
import type { OutboundMsg } from './format.js';
import type { UserConfig } from '../../user-config/types.js';

export interface GrokbotAdapterOptions {
  sendPrompt: (agent: string, prompt: string) => Promise<{ preview?: string }>;
  now?: () => string;
  log?: (event: string, data: Record<string, unknown>) => void;
  agent?: string;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 240);
}

function inboundEnvelope(payload: unknown): Omit<ChannelEnvelope, 'text'> & { text: string } | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const event = payload as Record<string, unknown>;
  if (typeof event.text !== 'string' || event.text.length === 0) return null;
  if (typeof event.id !== 'string' && typeof event.id !== 'number') return null;
  const kind = typeof event.kind === 'string' && event.kind.trim() ? event.kind : 'request';
  return { text: event.text, kind, channel: 'COO', senderId: 'COO', messageId: event.id };
}

export function createGrokbotAdapter(options: GrokbotAdapterOptions): ChannelAdapter {
  const agent = options.agent ?? 'COO';
  const now = options.now ?? (() => new Date().toISOString());
  const log = options.log ?? ((event, data) => debug.log('channel.grokbot', event, data));
  return {
    type: 'grokbot',
    capabilities: {
      send: true, receive: true, thread: false, topic: false, persona: false,
      channelLifecycle: false, permissions: false, commands: false, attachments: false,
      buttons: false, choices: true, deliveryConfirmation: false, rateLimit: false,
    },
    parseConfig: (raw): OutboundChannelConfig | undefined => raw.type === 'grokbot' ? { type: 'grokbot' } : undefined,
    receive: (payload): ChannelEnvelope | null => {
      const envelope = inboundEnvelope(payload);
      if (!envelope) return null;
      log('received', { id: envelope.messageId, text: envelope.text, receivedAt: now() });
      return envelope;
    },
    send: async (_config: OutboundChannelConfig, message: OutboundMsg, _cfg: UserConfig, _deps: RouterDeps): Promise<ChannelResult> => {
      const requestedAt = now();
      log('request', { agent, text: message.text, requestedAt, kind: message.kind });
      try {
        const prompt = `[엘라누스 알림 — 아래를 대표님께 그대로 전해 주세요. 덧붙이지 마세요]\n\n${message.text}`;
        const result = await options.sendPrompt(agent, prompt);
        log('reply', { agent, repliedAt: now(), ...(result.preview ? { preview: result.preview } : {}) });
        return { type: 'grokbot', ok: true };
      } catch (error) {
        const reason = safeError(error);
        log('failure', { agent, failedAt: now(), reason });
        return { type: 'grokbot', ok: false, error: reason };
      }
    },
  };
}

export function registerGrokbotAdapter(options: GrokbotAdapterOptions): () => void {
  return registerOutboundAdapter(createGrokbotAdapter(options));
}
