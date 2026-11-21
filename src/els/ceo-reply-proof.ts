import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'ceo-op-proof:v1:';

export interface CeoReplyBinding {
  readonly source: string;
  readonly threadId: string;
  readonly messageId: string;
  /** HMAC of the authenticated ingress frame, also recorded on the accepted channel row. */
  readonly ingressId: string;
  readonly sessionId: string;
  readonly turnRunId: string;
}

const bodySha = (body: string): string => createHash('sha256').update(body).digest('hex');
const signedFields = (binding: CeoReplyBinding, parentId: number, body: string): unknown[] => [
  1, binding.source, binding.threadId, binding.messageId, binding.ingressId,
  binding.sessionId, binding.turnRunId, parentId, bodySha(body),
];
const macOf = (binding: CeoReplyBinding, parentId: number, body: string, secret: string): string =>
  createHmac('sha256', Buffer.from(secret, 'hex')).update(JSON.stringify(signedFields(binding, parentId, body))).digest('hex');

export function ceoReplyProofRef(binding: CeoReplyBinding, parentId: number, body: string, secret: string): string {
  if (!/^[0-9a-f]{64}$/.test(secret) || !/^[0-9a-f]{64}$/.test(binding.ingressId)
    || !binding.sessionId || !binding.turnRunId || !Number.isSafeInteger(parentId) || parentId < 1) throw new Error('invalid CEO reply binding');
  const payload = { ...binding, parentId, bodySha: bodySha(body), mac: macOf(binding, parentId, body, secret) };
  return PREFIX + Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/** Mail sender and refs are untrusted; only the scoped tab secret plus the accepted ingress row authorize egress. */
export function verifyCeoReplyProof(refsJson: string | null, expected: Pick<CeoReplyBinding, 'source' | 'threadId' | 'messageId'>,
  parentId: number, body: string, secret: string): CeoReplyBinding | null {
  if (!refsJson || !/^[0-9a-f]{64}$/.test(secret)) return null;
  let refs: unknown;
  try { refs = JSON.parse(refsJson); } catch { return null; }
  if (!Array.isArray(refs) || refs.length > 32) return null;
  for (const ref of refs) {
    if (typeof ref !== 'string' || !ref.startsWith(PREFIX) || ref.length > 2048) continue;
    try {
      const raw = JSON.parse(Buffer.from(ref.slice(PREFIX.length), 'base64url').toString('utf8')) as Record<string, unknown>;
      if (raw.source !== expected.source || raw.threadId !== expected.threadId || raw.messageId !== expected.messageId
        || raw.parentId !== parentId || raw.bodySha !== bodySha(body)
        || typeof raw.ingressId !== 'string' || !/^[0-9a-f]{64}$/.test(raw.ingressId)
        || typeof raw.sessionId !== 'string' || !raw.sessionId || raw.sessionId.length > 128
        || typeof raw.turnRunId !== 'string' || !raw.turnRunId || raw.turnRunId.length > 128
        || typeof raw.mac !== 'string' || !/^[0-9a-f]{64}$/.test(raw.mac)) continue;
      const binding: CeoReplyBinding = {
        source: raw.source as string, threadId: raw.threadId as string, messageId: raw.messageId as string,
        ingressId: raw.ingressId, sessionId: raw.sessionId, turnRunId: raw.turnRunId,
      };
      const expectedMac = Buffer.from(macOf(binding, parentId, body, secret), 'hex');
      if (timingSafeEqual(expectedMac, Buffer.from(raw.mac, 'hex'))) return binding;
    } catch { /* a forged or damaged ref has no authority */ }
  }
  return null;
}
