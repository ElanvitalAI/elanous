import { createHmac, timingSafeEqual } from 'node:crypto';

export type CheckoutOutcome = 'approved' | 'declined' | 'cancelled';
export type SubscriptionStatus = 'active' | 'past_due' | 'suspended';

export interface Payment {
  id: string;
  amount: number;
  status: 'approved' | 'declined' | 'cancelled';
  refunded: number;
}

export interface PaymentWebhook {
  id: string;
  paymentId: string;
  type: 'payment.approved';
}

export interface Subscription {
  id: string;
  amount: number;
  billingDay: number;
  nextBillingAt: number;
  status: SubscriptionStatus;
  retryIndex: number;
  graceEndsAt: number | null;
  cardValid: boolean;
}

export interface SignedPaymentWebhook {
  event: PaymentWebhook;
  signature: string;
}

export interface FakePaymentPort {
  checkout(input: { id: string; amount: number; outcome?: CheckoutOutcome }): Promise<Payment>;
  readonly outgoingWebhooks: readonly SignedPaymentWebhook[];
  signWebhook(event: PaymentWebhook): string;
  receiveWebhook(event: PaymentWebhook, signature: string): { accepted: boolean; duplicate: boolean };
  subscribe(input: { id: string; amount: number; billingDay: number; cardValid?: boolean }): Subscription;
  advanceSubscriptions(): void;
  updateCard(subscriptionId: string, valid: boolean): void;
  refund(paymentId: string, amount: number): Payment;
  readonly payments: ReadonlyMap<string, Payment>;
  readonly subscriptions: ReadonlyMap<string, Subscription>;
  readonly processedWebhookIds: ReadonlySet<string>;
  readonly webhookProcessCount: number;
}

export interface FakePaymentOptions {
  secret: string;
  now?: () => number;
  retryDelaysMs?: readonly number[];
  gracePeriodMs?: number;
}

function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('amount must be a positive safe integer in minor units');
}

export function createFakePayment(options: FakePaymentOptions): FakePaymentPort {
  if (!options.secret) throw new Error('webhook secret must not be empty');
  const now = options.now ?? Date.now;
  const retryDelaysMs = [...(options.retryDelaysMs ?? [60_000, 300_000])];
  if (retryDelaysMs.some((delay) => !Number.isSafeInteger(delay) || delay < 0)) throw new Error('retry delays must be nonnegative safe integers');
  const gracePeriodMs = options.gracePeriodMs ?? 86_400_000;
  if (!Number.isSafeInteger(gracePeriodMs) || gracePeriodMs < 0) throw new Error('grace period must be a nonnegative safe integer');
  const paymentRows = new Map<string, Payment>();
  const outgoingWebhooks: SignedPaymentWebhook[] = [];
  const subscriptionRows = new Map<string, Subscription>();
  const processed = new Set<string>();
  let processCount = 0;

  const signWebhook = (event: PaymentWebhook) => createHmac('sha256', options.secret).update(JSON.stringify(event)).digest('hex');
  const port: FakePaymentPort = {
    payments: paymentRows,
    outgoingWebhooks,
    subscriptions: subscriptionRows,
    processedWebhookIds: processed,
    get webhookProcessCount() { return processCount; },
    async checkout(input) {
      assertAmount(input.amount);
      if (paymentRows.has(input.id)) throw new Error(`payment already exists: ${input.id}`);
      const status = input.outcome ?? 'approved';
      const payment: Payment = { id: input.id, amount: input.amount, status, refunded: 0 };
      paymentRows.set(input.id, payment);
      if (status === 'approved') {
        const event: PaymentWebhook = { id: `${input.id}:approved`, paymentId: input.id, type: 'payment.approved' };
        outgoingWebhooks.push({ event, signature: signWebhook(event) });
      }
      return { ...payment };
    },
    signWebhook,
    receiveWebhook(event, signature) {
      const expected = Buffer.from(signWebhook(event), 'hex');
      const supplied = /^[0-9a-f]{64}$/i.test(signature) ? Buffer.from(signature, 'hex') : Buffer.alloc(0);
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return { accepted: false, duplicate: false };
      if (processed.has(event.id)) return { accepted: true, duplicate: true };
      const payment = paymentRows.get(event.paymentId);
      if (!payment || event.type !== 'payment.approved' || payment.status !== 'approved') return { accepted: false, duplicate: false };
      processed.add(event.id);
      processCount++;
      return { accepted: true, duplicate: false };
    },
    subscribe(input) {
      assertAmount(input.amount);
      if (!Number.isSafeInteger(input.billingDay) || input.billingDay < 1 || input.billingDay > 31) throw new Error('billing day must be an integer from 1 to 31');
      if (subscriptionRows.has(input.id)) throw new Error(`subscription already exists: ${input.id}`);
      const current = new Date(now());
      const nextBillingAt = nextBillingDate(current, input.billingDay);
      const subscription: Subscription = { id: input.id, amount: input.amount, billingDay: input.billingDay,
        nextBillingAt, status: 'active', retryIndex: 0, graceEndsAt: null, cardValid: input.cardValid ?? true };
      subscriptionRows.set(input.id, subscription);
      return { ...subscription };
    },
    advanceSubscriptions() {
      const currentTime = now();
      for (const subscription of subscriptionRows.values()) {
        if (subscription.status === 'suspended') continue;
        if (subscription.status === 'past_due' && subscription.graceEndsAt !== null && currentTime >= subscription.graceEndsAt) {
          subscription.status = 'suspended';
          continue;
        }
        if (currentTime < subscription.nextBillingAt) continue;
        if (subscription.status === 'active') {
          if (subscription.cardValid) {
            subscription.nextBillingAt = nextBillingDate(new Date(currentTime), subscription.billingDay);
            continue;
          }
          subscription.status = 'past_due';
          subscription.retryIndex = 0;
          subscription.graceEndsAt = currentTime + gracePeriodMs;
          subscription.nextBillingAt = currentTime + (retryDelaysMs[0] ?? 0);
          continue;
        }
        if (subscription.cardValid) {
          subscription.status = 'active';
          subscription.retryIndex = 0;
          subscription.graceEndsAt = null;
          subscription.nextBillingAt = nextBillingDate(new Date(currentTime), subscription.billingDay);
          continue;
        }
        subscription.retryIndex++;
        const nextDelay = retryDelaysMs[subscription.retryIndex];
        subscription.nextBillingAt = nextDelay === undefined
          ? subscription.graceEndsAt ?? currentTime
          : currentTime + nextDelay;
      }
    },
    updateCard(subscriptionId, valid) {
      const subscription = subscriptionRows.get(subscriptionId);
      if (!subscription) throw new Error(`unknown subscription: ${subscriptionId}`);
      subscription.cardValid = valid;
      if (valid && subscription.status === 'past_due') subscription.nextBillingAt = now();
    },
    refund(paymentId, amount) {
      assertAmount(amount);
      const payment = paymentRows.get(paymentId);
      if (!payment || payment.status !== 'approved') throw new Error(`payment is not refundable: ${paymentId}`);
      if (payment.refunded + amount > payment.amount) throw new Error('refund exceeds approved payment amount');
      payment.refunded += amount;
      return { ...payment };
    },
  };
  return port;
}

function nextBillingDate(from: Date, billingDay: number): number {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const timestampInMonth = (monthOffset: number) => {
    const target = new Date(Date.UTC(year, month + monthOffset, 1, from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds()));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(billingDay, lastDay));
    return target.getTime();
  };
  const thisMonth = timestampInMonth(0);
  return thisMonth > from.getTime() ? thisMonth : timestampInMonth(1);
}

export interface PaymentContractCase {
  name: string;
  input: { operation: 'checkout'; id: string; amount: number; outcome?: CheckoutOutcome };
  expected: { status: CheckoutOutcome; amount: number };
}

export const fakePaymentContractMatrix: readonly PaymentContractCase[] = [
  { name: 'approved checkout', input: { operation: 'checkout', id: 'matrix-approved', amount: 137 }, expected: { status: 'approved', amount: 137 } },
  { name: 'declined checkout', input: { operation: 'checkout', id: 'matrix-declined', amount: 241, outcome: 'declined' }, expected: { status: 'declined', amount: 241 } },
  { name: 'user cancellation', input: { operation: 'checkout', id: 'matrix-cancelled', amount: 389, outcome: 'cancelled' }, expected: { status: 'cancelled', amount: 389 } },
];

export async function runFakePaymentContractMatrix(port: FakePaymentPort, cases: readonly PaymentContractCase[] = fakePaymentContractMatrix): Promise<Array<{ name: string; actual: { status: CheckoutOutcome; amount: number }; expected: PaymentContractCase['expected'] }>> {
  const results = [];
  for (const item of cases) {
    if (item.input.operation !== 'checkout') throw new Error(`unsupported contract operation: ${item.input.operation}`);
    const payment = await port.checkout(item.input);
    results.push({ name: item.name, actual: { status: payment.status, amount: payment.amount }, expected: item.expected });
  }
  return results;
}
