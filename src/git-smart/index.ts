/**
 * SMART-MERGE — the one shared module for «what a PR changes» and «bring a PR onto main» (CEO 11-27 10:0x · 10:1x).
 * Callers: land graph finisher (REFRESH · STACK rebuild · LLM capsule), review delta (range-diff), land-graph receipts
 * (patch-id reuse), review carry / virtual-rebase proofs (patch-id parse), `eln land smart-merge`.
 */
export { patchIdFromOutput, stablePatchId, prDelta, deltaBetween, deltaSince, SHA40, type PrDelta, type DeltaSince } from './delta.js';
export { revertGuard, removedLines, type RevertGuardResult, type ForeignRemoval } from './revert-guard.js';
export { RERERE_ARGS, parseDiff3, resolveHunkStructurally, resolveFileStructurally, importUnion, runLadderSync, runLadderLlm, conflictCard, type LlmResolve, type FileConflict, type Hunk } from './conflict-ladder.js';
export { smartRefresh, smartRefreshSync, pickParent, acquirePrLock, type SmartRefreshInput, type SmartRefreshResult } from './smart-refresh.js';
export { detectStaleBaseRevert, type StaleRevertResult } from '../land-guard/stale-base-revert.js';
