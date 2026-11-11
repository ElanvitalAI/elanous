export interface FakeTelegramOutboundAction {
  readonly label: string;
  readonly value: string;
}

export interface FakeTelegramOutboundGenericAction {
  readonly id: string;
  readonly label: string;
}

export interface FakeTelegramOutboundRequest {
  readonly refId?: string;
  readonly dedupKey?: string;
  readonly actions?: readonly FakeTelegramOutboundGenericAction[];
  /** Legacy briefing fields remain accepted for existing simulation fixtures. */
  readonly briefingId?: string;
  readonly text: string;
  readonly kind?: string;
  readonly buttons?: readonly FakeTelegramOutboundAction[];
}

export interface FakeTelegramOutboundReceipt extends FakeTelegramOutboundRequest {
  readonly buttons: readonly FakeTelegramOutboundAction[];
}

function copyRequest(input: FakeTelegramOutboundRequest): FakeTelegramOutboundReceipt {
  return {
    ...(input.refId === undefined ? {} : { refId: input.refId }),
    ...(input.dedupKey === undefined ? {} : { dedupKey: input.dedupKey }),
    ...(input.actions === undefined ? {} : { actions: input.actions.map(({ id, label }) => ({ id, label })) }),
    ...(input.briefingId === undefined ? {} : { briefingId: input.briefingId }),
    text: input.text,
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    buttons: (input.buttons ?? []).map((button) => ({ label: button.label, value: button.value })),
  };
}

/** In-memory generic Telegram text/action boundary; briefing metadata remains optional. */
export function createFakeTelegramOutbound(options: { fail?: boolean } = {}) {
  const receipts: FakeTelegramOutboundReceipt[] = [];
  let calls = 0;
  return {
    async send(input: FakeTelegramOutboundRequest): Promise<{ ok: boolean }> {
      calls++;
      if (!input || typeof input.text !== 'string' || !input.text.trim()) {
        throw new Error('fake-telegram-outbound: non-empty text is required');
      }
      if (input.briefingId !== undefined && (typeof input.briefingId !== 'string' || !input.briefingId.trim())) {
        throw new Error('fake-telegram-outbound: briefingId must be non-empty when provided');
      }
      if (input.refId !== undefined && (typeof input.refId !== 'string' || !input.refId.trim())) {
        throw new Error('fake-telegram-outbound: refId must be non-empty when provided');
      }
      if (input.dedupKey !== undefined && (typeof input.dedupKey !== 'string' || !input.dedupKey.trim())) {
        throw new Error('fake-telegram-outbound: dedupKey must be non-empty when provided');
      }
      if (input.actions !== undefined && (!Array.isArray(input.actions) || input.actions.some((action) =>
        !action || typeof action.id !== 'string' || !action.id.trim() || typeof action.label !== 'string' || !action.label.trim()))) {
        throw new Error('fake-telegram-outbound: actions must contain non-empty ids and labels');
      }
      if (input.buttons !== undefined && (!Array.isArray(input.buttons) || input.buttons.some((button) =>
        !button || typeof button.label !== 'string' || !button.label.trim() || typeof button.value !== 'string' || !button.value.trim()))) {
        throw new Error('fake-telegram-outbound: buttons must contain non-empty labels and values');
      }
      if (!options.fail) receipts.push(copyRequest(input));
      return { ok: !options.fail };
    },
    calls: () => calls,
    receipts: () => receipts.map(copyRequest),
  };
}
