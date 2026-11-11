import { createHash } from 'node:crypto';
import {
  emptyGraphCapabilityRegistry,
  registerGraphCapabilityContract,
  registerGraphCapabilityProviderDeclaration,
  type GraphCapabilityContract,
  type GraphCapabilityProvider,
  type GraphCapabilityRegistry,
  type LegacyGraphCapabilityProviders,
} from '../capabilities.js';
import type { InProcessHandlerContext } from '../in-process-registry.js';
import type { OutboundMsg } from '../../nexus/outbound/format.js';

export interface NotifyCapabilityAction {
  readonly id: string;
  readonly label: string;
}

export interface NotifyCapabilityMessage {
  readonly text: string;
  readonly kind?: string;
  readonly actions?: readonly NotifyCapabilityAction[];
  readonly dedupKey?: string;
  readonly refId?: string;
}

export const NOTIFY_CHANNEL_CONTRACT: GraphCapabilityContract = Object.freeze({
  id: 'notify.channel@1',
  input: {
    type: 'object', required: ['text'], properties: {
      text: { type: 'string' },
      kind: { type: 'string' },
      actions: { type: 'array', items: { type: 'object', required: ['id', 'label'], properties: { id: { type: 'string' }, label: { type: 'string' } } } },
      dedupKey: { type: 'string' },
      refId: { type: 'string' },
    },
  },
  output: { type: 'object', required: ['delivered'], properties: { delivered: { type: 'boolean' } } },
});

export type NotifyCapabilitySend = (message: NotifyCapabilityMessage, context: InProcessHandlerContext) =>
  boolean | { ok: boolean } | Promise<boolean | { ok: boolean }>;

function parseMessage(input: unknown): NotifyCapabilityMessage | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (typeof value.text !== 'string' || !value.text.trim()) return undefined;
  if (value.kind !== undefined && (typeof value.kind !== 'string' || !value.kind.trim())) return undefined;
  if (value.dedupKey !== undefined && (typeof value.dedupKey !== 'string' || !value.dedupKey.trim())) return undefined;
  if (value.refId !== undefined && (typeof value.refId !== 'string' || !value.refId.trim() || value.refId.includes(':'))) return undefined;
  if (value.actions !== undefined && (!Array.isArray(value.actions) || value.actions.some((action) => {
    if (!action || typeof action !== 'object' || Array.isArray(action)) return true;
    const record = action as Record<string, unknown>;
    return typeof record.id !== 'string' || !record.id.trim() || record.id.includes(':')
      || typeof record.label !== 'string' || !record.label.trim();
  }))) return undefined;
  return {
    text: value.text,
    ...(typeof value.kind === 'string' ? { kind: value.kind } : {}),
    ...(Array.isArray(value.actions) ? { actions: value.actions.map((action) => ({
      id: (action as Record<string, string>).id,
      label: (action as Record<string, string>).label,
    })) } : {}),
    ...(typeof value.dedupKey === 'string' ? { dedupKey: value.dedupKey } : {}),
    ...(typeof value.refId === 'string' ? { refId: value.refId } : {}),
  };
}

/** Maps the surface-neutral capability contract onto the existing outbound router contract. */
export function toNotifyOutboundMessage(message: NotifyCapabilityMessage): OutboundMsg | undefined {
  const buttons = message.actions?.map(({ id, label }) => ({
    label,
    // Telegram callback payloads carry both the surface-neutral action and its optional target.
    value: message.refId ? `${id}:${message.refId}` : id,
  }));
  if (buttons?.some(({ value }) => new TextEncoder().encode(value).length > 64)) return undefined;
  const notifyDedupKey = message.dedupKey ?? (message.refId
    ? `notify:${createHash('sha256').update(JSON.stringify({
      kind: message.kind ?? 'notify', text: message.text, refId: message.refId, actions: message.actions ?? [],
    })).digest('hex')}`
    : undefined);
  return {
    text: message.text,
    markdown: false,
    kind: message.kind ?? 'notify',
    ...(notifyDedupKey ? { dedupKey: notifyDedupKey } : {}),
    ...(buttons?.length ? { buttons } : {}),
  };
}

async function sendNotifyMessage(message: NotifyCapabilityMessage): Promise<boolean> {
  const outbound = toNotifyOutboundMessage(message);
  if (!outbound) return false;
  const [{ routeOutbound }, { getUserConfig }] = await Promise.all([
    import('../../nexus/outbound/router.js'),
    import('../../user-config.js'),
  ]);
  const result = await routeOutbound(getUserConfig(), outbound);
  return result.delivered;
}

/** Generic notify capability provider. Invalid inputs and unconfirmed delivery fail closed. */
export function createNotifyCapabilityProvider(send: NotifyCapabilitySend = sendNotifyMessage) {
  const provider: GraphCapabilityProvider = async (context) => {
    const message = parseMessage(context.nodeInput !== undefined ? context.nodeInput : context.input);
    if (!message) return { ok: false, outcome: 'failed', error: 'invalid_input' };
    try {
      const result = await send(message, context);
      const delivered = typeof result === 'boolean' ? result : result.ok;
      return delivered
        ? { ok: true, outcome: 'done', result: { delivered: true }, evidence: { delivered: true } }
        : { ok: false, outcome: 'failed', error: 'delivery_failed' };
    } catch {
      return { ok: false, outcome: 'failed', error: 'delivery_failed' };
    }
  };
  return provider;
}

export function createNotifyCapabilityProviders(
  send: NotifyCapabilitySend = sendNotifyMessage,
): LegacyGraphCapabilityProviders {
  return { notify: createNotifyCapabilityProvider(send) };
}

export const notifyCapabilityProviders = createNotifyCapabilityProviders();

export function createNotifyCapabilityRegistry(send: NotifyCapabilitySend = sendNotifyMessage): GraphCapabilityRegistry {
  let registry = emptyGraphCapabilityRegistry();
  registry = registerGraphCapabilityContract(registry, NOTIFY_CHANNEL_CONTRACT);
  return registerGraphCapabilityProviderDeclaration(registry, {
    id: 'notify-channel',
    provides: [NOTIFY_CHANNEL_CONTRACT.id],
    tier: 'byok',
    invoke: createNotifyCapabilityProvider(send),
  });
}

