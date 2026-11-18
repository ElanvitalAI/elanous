/**
 * RELEASE-RESUME-AFTER-CUT-PUSHED (#38522): release graph node ids live in the plugin layer
 * (scripts/release-loop) so src/ carries no new core feature identifier hardcodes (PLUGIN-ONLY-RATCHET).
 * `cut-branch` is the new cut node; legacy runs carry `version-release`.
 */
export const RELEASE_CUT_NODE_IDS: readonly string[] = ['cut-branch', 'version-release'];

/** Nodes whose completion output carries the receipt commit (legacy version node ⊕ new cut/prebuild nodes). */
export const RELEASE_RECEIPT_COMMIT_NODE_IDS: readonly string[] = ['version-release', 'cut-branch', 'gate-image-prebuild'];
