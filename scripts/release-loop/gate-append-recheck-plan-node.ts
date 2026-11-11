#!/usr/bin/env bun
import { selectGateAppendRecheckEdge } from './gate-partial.js';
import { errorResult, readGraphContext } from './node-verdict.js';

if (import.meta.main) {
  try {
    const context = readGraphContext();
    const input = context.nodeInput ?? {};
    const policyOverrides = context.input.policyOverrides;
    const policy = policyOverrides && typeof policyOverrides === 'object' && !Array.isArray(policyOverrides)
      ? (policyOverrides as Record<string, unknown>)['gate.plan.promoteToFull'] : undefined;
    const costs = input.receiptCosts && typeof input.receiptCosts === 'object' && !Array.isArray(input.receiptCosts)
      ? input.receiptCosts as { partialMs?: unknown; fullMs?: unknown } : undefined;
    const route = selectGateAppendRecheckEdge({
      changedFiles: Array.isArray(input.changedFiles) ? input.changedFiles.filter((file): file is string => typeof file === 'string') : [],
      radiusFiles: Array.isArray(input.radiusFiles) ? input.radiusFiles.filter((file): file is string => typeof file === 'string') : [],
      closureOpaque: typeof input.closureOpaque === 'boolean' ? input.closureOpaque : undefined,
      ...(costs && typeof costs.partialMs === 'number' && typeof costs.fullMs === 'number'
        ? { receiptCosts: { partialMs: costs.partialMs, fullMs: costs.fullMs, source: 'same-ledger-receipts' as const } } : {}),
      ...(Array.isArray(policy) && policy.every((item) => typeof item === 'string') ? { promoteToFull: policy as string[] } : {}),
    });
    console.log(JSON.stringify({ outcome: route.edge, promoted: route.promoted, reason: route.reason }));
  } catch (error) {
    console.log(JSON.stringify(errorResult(error)));
    process.exitCode = 2;
  }
}
