import {
  registerGraphCapabilityContract,
  registerGraphCapabilityProviderDeclaration,
  type GraphCapabilityRegistry,
} from './capabilities.js';
import type { InProcessHandlerContext, InProcessHandlerResult } from './in-process-registry.js';
import { validateAbsorbDesignProposal, validateAbsorbDesignWrite, validateAbsorbSuggestionWrites } from './absorb-design-contract.js';
import { createDefaultMarketDataRegistry } from './capability-providers/market-data/registry.js';

const proposalContract = 'absorb.design-proposal@1' as const;
const writeContract = 'absorb.design-write@1' as const;
const suggestionWriteContract = 'absorb.suggestion-write@1' as const;

function row(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function validateDesignGuard(context: InProcessHandlerContext): InProcessHandlerResult {
  const graphInput = context.graphInput ?? context.input;
  const nodeInput = context.nodeInput ?? context.input;
  const invalid = context.requires === proposalContract
    ? validateAbsorbDesignProposal(graphInput, context.outputs)
    : context.requires === suggestionWriteContract
      ? validateAbsorbSuggestionWrites(graphInput, nodeInput, context.outputs)
    : context.requires === writeContract
      ? validateAbsorbDesignWrite(graphInput, nodeInput, context.outputs)
      : 'unknown absorb design guard contract';
  if (invalid) return { ok: false, outcome: 'failed', error: invalid, evidence: { contract: context.requires } };
  const design = context.outputs.design;
  const rawDesignResult = design && typeof design === 'object' ? (design as Record<string, unknown>).result : undefined;
  const designResult = rawDesignResult && typeof rawDesignResult === 'object'
    ? rawDesignResult as Record<string, unknown> : {};
  const query = row(nodeInput);
  const memberId = row(row(graphInput).context).memberId;
  const suggestions = Array.isArray(query.suggestions) ? query.suggestions.map(row) : [];
  const existing = row(row(context.outputs['load-existing-suggestions']).result).items;
  const existingIds = new Set(Array.isArray(existing) ? existing.map(item => row(item).id) : []);
  const result = context.requires === suggestionWriteContract ? { valid: true, items: suggestions.filter(suggestion => !existingIds.has(suggestion.id)).map(suggestion => ({
    // Insert-only is the write-time guard. A concurrent graph that read the
    // same empty list must fail on the existing owner/key, never replace it.
    op: 'create', collection: 'suggestions', owner: memberId, key: suggestion.id,
    value: suggestion, ownerScoped: true,
  })) } : context.requires === proposalContract ? { ...designResult, valid: true } : { valid: true,
    write: { op: query.op, collection: query.collection, owner: memberId,
      key: query.key, value: query.value, ownerScoped: query.ownerScoped } };
  return { ok: true, outcome: 'done', result, evidence: { contract: context.requires } };
}

/** Declare absorb-specific validation as graph capabilities, outside the shared runner. */
export function registerAbsorbDesignGuards(registry: GraphCapabilityRegistry): GraphCapabilityRegistry {
  let next = registerGraphCapabilityContract(registry, {
    id: proposalContract,
    input: { type: 'object' },
    output: { type: 'object', required: ['valid'], properties: { valid: { type: 'boolean' } } },
  });
  next = registerGraphCapabilityContract(next, {
    id: writeContract,
    input: { type: 'object', required: ['op', 'collection', 'owner', 'key', 'value', 'ownerScoped'] },
    output: { type: 'object', required: ['valid', 'write'], properties: { valid: { type: 'boolean' }, write: { type: 'object',
      required: ['op', 'collection', 'owner', 'key', 'value', 'ownerScoped'], properties: { op: { type: 'string' },
        collection: { type: 'string' }, owner: { type: 'string' }, key: {}, value: {}, ownerScoped: { type: 'boolean' } } } } },
  });
  next = registerGraphCapabilityContract(next, {
    id: suggestionWriteContract,
    input: { type: 'object', required: ['owner', 'briefingId', 'design', 'suggestions'] },
    output: { type: 'object', required: ['valid', 'items'], properties: { valid: { type: 'boolean' }, items: { type: 'array' } } },
  });
  return registerGraphCapabilityProviderDeclaration(next, {
    id: 'absorb-design-guards',
    provides: [proposalContract, writeContract, suggestionWriteContract],
    tier: 'free',
    invoke: validateDesignGuard,
  });
}

export function createAbsorbDesignRegistry(): GraphCapabilityRegistry {
  return registerAbsorbDesignGuards(createDefaultMarketDataRegistry());
}
