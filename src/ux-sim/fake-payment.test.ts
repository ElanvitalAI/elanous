import { describe, expect, it } from 'bun:test';
import { createFakePayment, fakePaymentContractMatrix, runFakePaymentContractMatrix } from './fake-payment.js';

const makePort = (now: () => number = () => Date.UTC(2026, 0, 1)) => createFakePayment({ secret: 'test-secret-only', now, retryDelaysMs: [10, 20], gracePeriodMs: 35 });

describe('fake payment gateway contract', () => {
  it('runs the exported contract matrix against any compatible port', async () => {
    const results = await runFakePaymentContractMatrix(makePort());
    expect(results).toHaveLength(fakePaymentContractMatrix.length);
    expect(results.map((result) => result.actual)).toEqual(fakePaymentContractMatrix.map(({ expected }) => expected));
  });

  it('distinguishes approval, decline, and user cancellation', async () => {
    const port = makePort();
    expect((await port.checkout({ id: 'approve', amount: 137 })).status).toBe('approved');
    expect((await port.checkout({ id: 'decline', amount: 241, outcome: 'declined' })).status).toBe('declined');
    expect((await port.checkout({ id: 'cancel', amount: 389, outcome: 'cancelled' })).status).toBe('cancelled');
  });

  it('processes a signed approval webhook once and rejects a forged signature without mutation', async () => {
    const port = makePort();
    await port.checkout({ id: 'pay-1', amount: 137 });
    const { event, signature } = port.outgoingWebhooks[0]!;
    expect(port.outgoingWebhooks).toHaveLength(1);
    expect(port.receiveWebhook(event, signature)).toEqual({ accepted: true, duplicate: false });
    const before = { count: port.webhookProcessCount, processed: [...port.processedWebhookIds] };
    expect(port.receiveWebhook(event, signature)).toEqual({ accepted: true, duplicate: true });
    expect(port.webhookProcessCount).toBe(before.count);
    expect([...port.processedWebhookIds]).toEqual(before.processed);
    expect(port.receiveWebhook({ ...event, id: 'evt-forged' }, signature)).toEqual({ accepted: false, duplicate: false });
    expect(port.webhookProcessCount).toBe(before.count);
    expect([...port.processedWebhookIds]).toEqual(before.processed);
  });

  it('retries failed subscription billing, enters grace, suspends, and recovers after card update', () => {
    let now = Date.UTC(2026, 0, 1);
    const port = makePort(() => now);
    const subscription = port.subscribe({ id: 'sub-1', amount: 503, billingDay: 1, cardValid: false });
    now = subscription.nextBillingAt;
    port.advanceSubscriptions();
    expect(port.subscriptions.get('sub-1')).toMatchObject({ status: 'past_due', retryIndex: 0 });
    now += 10;
    port.advanceSubscriptions();
    expect(port.subscriptions.get('sub-1')).toMatchObject({ status: 'past_due', retryIndex: 1 });
    now += 20;
    port.advanceSubscriptions();
    expect(port.subscriptions.get('sub-1')).toMatchObject({ status: 'past_due', retryIndex: 2 });
    now += 5;
    port.advanceSubscriptions();
    expect(port.subscriptions.get('sub-1')?.status).toBe('suspended');
    port.updateCard('sub-1', true);
    expect(port.subscriptions.get('sub-1')?.status).toBe('suspended');

    const recovered = port.subscribe({ id: 'sub-recover', amount: 607, billingDay: 1, cardValid: false });
    now = recovered.nextBillingAt;
    port.advanceSubscriptions();
    port.updateCard('sub-recover', true);
    port.advanceSubscriptions();
    expect(port.subscriptions.get('sub-recover')).toMatchObject({ status: 'active', retryIndex: 0, graceEndsAt: null, cardValid: true });
  });

  it('advances monthly billing after February clamps billing days 29 through 31', () => {
    for (const billingDay of [29, 30, 31]) {
      let now = Date.UTC(2026, 0, 31, 12);
      const port = createFakePayment({ secret: 'test-secret-only', now: () => now });
      const subscription = port.subscribe({ id: `sub-day-${billingDay}`, amount: 503, billingDay });
      now = subscription.nextBillingAt;
      expect(new Date(now).getUTCMonth()).toBe(1);
      expect(new Date(now).getUTCDate()).toBe(28);
      port.advanceSubscriptions();
      const nextBillingAt = port.subscriptions.get(subscription.id)!.nextBillingAt;
      expect(nextBillingAt).toBeGreaterThan(now);
      expect(new Date(nextBillingAt).getUTCMonth()).toBe(2);
      expect(new Date(nextBillingAt).getUTCDate()).toBe(billingDay);
    }
  });

  it('suspends at grace expiry even when retry is later or the card changes after expiry', () => {
    let now = Date.UTC(2026, 0, 1);
    const port = createFakePayment({ secret: 'test-secret-only', now: () => now, retryDelaysMs: [100], gracePeriodMs: 50 });
    const subscription = port.subscribe({ id: 'sub-long-retry', amount: 503, billingDay: 1, cardValid: false });
    now = subscription.nextBillingAt;
    port.advanceSubscriptions();
    const graceEndsAt = port.subscriptions.get(subscription.id)!.graceEndsAt!;
    expect(port.subscriptions.get(subscription.id)?.nextBillingAt).toBeGreaterThan(graceEndsAt);

    now = graceEndsAt;
    port.advanceSubscriptions();
    expect(port.subscriptions.get(subscription.id)?.status).toBe('suspended');

    const afterExpiry = port.subscribe({ id: 'sub-card-after-expiry', amount: 607, billingDay: 1, cardValid: false });
    now = afterExpiry.nextBillingAt;
    port.advanceSubscriptions();
    now = port.subscriptions.get(afterExpiry.id)!.graceEndsAt!;
    port.updateCard(afterExpiry.id, true);
    port.advanceSubscriptions();
    expect(port.subscriptions.get(afterExpiry.id)?.status).toBe('suspended');
  });

  it('allows full and partial refunds but rejects cumulative over-refund without changing state', async () => {
    const port = makePort();
    await port.checkout({ id: 'refund-1', amount: 997 });
    expect(port.refund('refund-1', 307).refunded).toBe(307);
    expect(port.refund('refund-1', 690).refunded).toBe(997);
    expect(() => port.refund('refund-1', 1)).toThrow('refund exceeds approved payment amount');
    expect(port.payments.get('refund-1')?.refunded).toBe(997);
  });

  it('rejects non-integer or unsafe amounts', async () => {
    const port = makePort();
    await expect(port.checkout({ id: 'bad-amount', amount: 1.5 })).rejects.toThrow('safe integer');
    await expect(port.checkout({ id: 'unsafe-amount', amount: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow('safe integer');
  });
});
