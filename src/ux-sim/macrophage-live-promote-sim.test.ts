import { expect, test } from 'bun:test';
import { resolveMacrophageFailurePromotion, runMacrophageHeal, type MacrophageScrap } from '../release-loop/macrophage-heal.js';

test('MACRO-LIVE-PROMOTE simulation: only type-error with independent overlay agreement is live', () => {
  const promotionOptions = { requestedMode: 'live', policyAction: 'attempt-repair' as const };
  const promoted = resolveMacrophageFailurePromotion('type-error', promotionOptions);
  expect(promoted).toMatchObject({ mode: 'live', action: 'attempt-repair', crossVerdict: 'agree' });
  expect(promoted.overlayId).toBe('stop-heal-ladder-release-type-error');

  const otherSignature = resolveMacrophageFailurePromotion('configuration-missing');
  expect(otherSignature.mode).toBe('shadow');
  expect(otherSignature.reason).toContain('signature-out-of-scope');

  const unknown = resolveMacrophageFailurePromotion('unknown');
  expect(unknown.mode).toBe('shadow');
  expect(unknown.reason).toContain('signature-out-of-scope');

  const missingOverlay = resolveMacrophageFailurePromotion('type-error', { ...promotionOptions, loadLadder: () => ({
    template: undefined,
    overlays: [],
  }) });
  expect(missingOverlay.mode).toBe('shadow');
  expect(missingOverlay.crossVerdict).toBe('disagree');
  expect(missingOverlay.rollbackReason).toContain('overlay-unavailable');
  expect(resolveMacrophageFailurePromotion('type-error', { ...promotionOptions, requestedMode: 'unrecognized-setting' })).toMatchObject({
    mode: 'shadow', rollbackReason: 'unknown-mode-setting',
  });
  expect(resolveMacrophageFailurePromotion('type-error', { requestedMode: 'live', policyAction: 'retain' })).toMatchObject({
    mode: 'shadow', crossVerdict: 'disagree', rollbackReason: 'policy-action-mismatch-or-unavailable',
  });
  expect(resolveMacrophageFailurePromotion('type-error', { policyAction: 'attempt-repair' })).toMatchObject({
    mode: 'shadow', rollbackReason: 'unknown-mode-setting',
  });

  const inventory: MacrophageScrap[] = [
    { id: 'signature-type-error', kind: 'release-node-failure', evidence: { failureSignature: 'type-error', nodeId: 'gate' } },
    { id: 'signature-config-missing', kind: 'release-node-failure', evidence: { failureSignature: 'configuration-missing', nodeId: 'gate' } },
  ];
  const events = runMacrophageHeal({ phase: 'idle', mode: 'live', promotionMode: 'live', now: new Date(0), consecutiveFailureLimit: 3, inventory }).events;
  expect(events[0]).toMatchObject({ action: 'attempt-repair', applied: false, promotionMode: 'live',
    promotionReason: 'type-error-policy-and-overlay-agree', rollbackReason: 'none',
    promotionOverlayId: 'stop-heal-ladder-release-type-error' });
  expect(events[1]).toMatchObject({ action: 'open-cell', applied: false, promotionMode: 'shadow',
    promotionReason: 'signature-out-of-scope', rollbackReason: 'signature-out-of-scope' });

  const missingLadderEvent = runMacrophageHeal({ phase: 'idle', mode: 'live', promotionMode: 'live', now: new Date(0), consecutiveFailureLimit: 3,
    promotionLadder: () => ({ template: undefined, overlays: [] }), inventory: [inventory[0]!] }).events[0];
  expect(missingLadderEvent).toMatchObject({ action: 'attempt-repair', applied: false, promotionMode: 'shadow',
    rollbackReason: 'overlay-unavailable-or-action-mismatch' });
  const omittedPromotionMode = runMacrophageHeal({ phase: 'idle', mode: 'live', now: new Date(0), consecutiveFailureLimit: 3,
    inventory: [inventory[0]!] }).events[0];
  expect(omittedPromotionMode).toMatchObject({ promotionMode: 'shadow', rollbackReason: 'unknown-mode-setting' });

  const simulated = runMacrophageHeal({ phase: 'idle', mode: 'simulation', promotionMode: 'simulation', now: new Date(0), consecutiveFailureLimit: 3,
    inventory: [inventory[0]!] }).events[0];
  expect(simulated).toMatchObject({ action: 'attempt-repair', applied: false, promotionMode: 'shadow',
    promotionReason: 'live-mode-not-explicit', rollbackReason: 'simulation-only' });
  const conflictingModes = runMacrophageHeal({ phase: 'idle', mode: 'simulation', promotionMode: 'live', now: new Date(0),
    consecutiveFailureLimit: 3, inventory: [inventory[0]!] }).events[0];
  expect(conflictingModes).toMatchObject({ promotionMode: 'shadow', rollbackReason: 'simulation-only' });
});
