import type { GraphRunState } from './runner-types.js';
import type { Message } from '../msg/msg-store.js';
import { assertSignedT6PwaBranchWaiver, T6_PWA_WAIVER } from './release-pwa-known-issue.js';
import { assertPwaMailWaiver } from './release-pwa-mail-waiver.js';

/** Preserve the exact T6 receipt while fresh runs use independently attested mail. */
export function assertSignedPwaBranchWaiver(state: GraphRunState, root: string, recorded = false,
  getMessage?: (id: number) => Message | null) {
  if (state.runId === T6_PWA_WAIVER.runId) {
    assertSignedT6PwaBranchWaiver(state, root, recorded);
    return { documentSha256: T6_PWA_WAIVER.documentSha256,
      signatureSha256: T6_PWA_WAIVER.signatureSha256,
      pairedLogSha256: T6_PWA_WAIVER.pairedLogSha256 };
  }
  const proof = assertPwaMailWaiver(state, root, recorded, getMessage);
  return { documentSha256: proof.packetSha256,
    signatureSha256: proof.judMessageSha256,
    pairedLogSha256: proof.pairedLogSha256 };
}
