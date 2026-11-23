/**
 * RELEASE-RESUME-AFTER-CUT-PUSHED (#38522): release graph node ids live in the plugin layer
 * (scripts/release-loop) so src/ carries no new core feature identifier hardcodes (PLUGIN-ONLY-RATCHET).
 * `cut-branch` is the new cut node; legacy runs carry `version-release`.
 */
export const RELEASE_CUT_NODE_IDS: readonly string[] = ['cut-branch', 'version-release'];

/** Release graph entry can run before the first completed node receipt exists. */
export const RELEASE_INITIAL_NODE_IDS: readonly string[] = ['traffic-prep', ...RELEASE_CUT_NODE_IDS];

/** Nodes whose completion output carries the receipt commit (legacy version node ⊕ new cut/prebuild nodes). */
export const RELEASE_RECEIPT_COMMIT_NODE_IDS: readonly string[] = ['version-release', 'cut-branch', 'gate-image-prebuild'];
