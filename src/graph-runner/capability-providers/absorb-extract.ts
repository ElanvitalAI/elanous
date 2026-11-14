import { registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration,
  type GraphCapabilityRegistry } from '../capabilities.js';

const CONTRACT = 'extract.item@1';
const SUPPORTED_KINDS = new Set(['web', 'x', 'youtube', 'voice', 'video', 'photo', 'text', 'pdf']);
const MAX_TEXT_BYTES = 256 * 1024;

function row(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Read only text already stored for this member; this provider never fetches an untrusted URL. */
export function registerAbsorbExtractProvider(registry: GraphCapabilityRegistry): GraphCapabilityRegistry {
  const withContract = registerGraphCapabilityContract(registry, {
    id: CONTRACT,
    input: { type: 'object', required: ['scrap'], properties: { scrap: { type: 'object' } } },
    output: { type: 'object', required: ['id', 'kind', 'text'], properties: {
      id: { type: 'string' }, kind: { type: 'string' }, text: { type: 'string' },
    } },
  });
  return registerGraphCapabilityProviderDeclaration(withContract, {
    id: 'absorb-member-owned-extract', provides: [CONTRACT], tier: 'free',
    invoke: context => {
      const owner = context.verifiedOwnerId;
      const graphOwner = row(row(context.graphInput ?? context.input)?.context)?.memberId;
      const scrap = row(row(context.nodeInput)?.scrap);
      if (!owner || graphOwner !== owner || !scrap || scrap.owner !== owner)
        return { ok: false, outcome: 'failed', error: 'verified member scrap required' };
      if (typeof scrap.id !== 'string' || !scrap.id || typeof scrap.kind !== 'string'
        || !SUPPORTED_KINDS.has(scrap.kind) || typeof scrap.text !== 'string' || !scrap.text.trim()
        || Buffer.byteLength(scrap.text) > MAX_TEXT_BYTES)
        return { ok: false, outcome: 'failed', error: 'owned scrap has no bounded extracted text' };
      const result = { id: scrap.id, kind: scrap.kind, text: scrap.text,
        title: typeof scrap.title === 'string' ? scrap.title : `${scrap.kind} scrap`,
        sourceRef: typeof scrap.url === 'string' ? scrap.url
          : typeof scrap.mediaRef === 'string' ? scrap.mediaRef : scrap.id };
      return { ok: true, outcome: 'done', result, evidence: { scrapId: scrap.id, kind: scrap.kind, owner } };
    },
  });
}
