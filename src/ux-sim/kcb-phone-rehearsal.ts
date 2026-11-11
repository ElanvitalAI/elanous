const KCB_JOURNEY_SLA_MS = 120_000;

export interface KcbPhoneReceipt {
  readonly device: string;
  readonly mode: 'phone' | 'fake-oidc';
  readonly qrScannedAt: string;
  readonly firstResultAt: string | null;
  readonly example: 'article-brief' | 'system-diagram' | 'day-plan';
  readonly note?: string;
}

export interface KcbPhoneVerdict extends KcbPhoneReceipt {
  readonly elapsedMs: number | null;
  readonly withinTwoMinutes: boolean;
}

const examples = new Set(['article-brief', 'system-diagram', 'day-plan']);
const validTime = (value: string): number => {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) throw new Error('timestamps must be UTC ISO milliseconds');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error('invalid timestamp');
  return time;
};

export function kcbPhoneVerdicts(receipts: readonly KcbPhoneReceipt[]): KcbPhoneVerdict[] {
  if (receipts.length !== 3) throw new Error('three device receipts are required');
  const devices = new Set<string>();
  return receipts.map(receipt => {
    if (!/^phone-[1-3]$/.test(receipt.device) || devices.has(receipt.device)) throw new Error('devices must be unique phone-1, phone-2, phone-3');
    devices.add(receipt.device);
    if (receipt.mode !== 'phone' && receipt.mode !== 'fake-oidc') throw new Error('invalid rehearsal mode');
    if (!examples.has(receipt.example)) throw new Error('invalid example');
    const scannedAt = validTime(receipt.qrScannedAt);
    const elapsedMs = receipt.firstResultAt === null ? null : validTime(receipt.firstResultAt) - scannedAt;
    if (elapsedMs !== null && elapsedMs < 0) throw new Error('first result precedes QR scan');
    return { ...receipt, elapsedMs, withinTwoMinutes: elapsedMs !== null && elapsedMs <= KCB_JOURNEY_SLA_MS };
  });
}
