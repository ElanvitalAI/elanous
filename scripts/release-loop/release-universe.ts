// RELEASE-LEDGER-UNIVERSE (0.2.20 P0): the release run decides its universe ONCE at the entry and every node
// subprocess is pinned to it (graph runner `pinChildUniverse` stamps ELANOUS_STATE_DIR = this root). Without it a node
// launched as `bun scripts/release-loop/*-node.ts` from a non-leader tree (wt-release) re-resolved the tree-derived test
// universe and wrote manifest·story·gate logs to ⟨test:wt-release⟩ while the run ledger was prod (10-07).
import { getElanousConfigDirOverride } from '../../src/elanous-config-dir.js';
import { debug } from '../../src/debug/log.js';
import { effectiveInstanceRoot, normRoot, prodInstanceRoot } from '../../src/instance/resolve.js';

export interface ReleaseUniverseDeps {
  /** An injected ledger root (tests, or a caller that already decided) is used as is. */
  root?: string;
  override?: () => string | undefined;
  prodRoot?: () => string;
  effectiveRoot?: () => string;
}

/**
 * The single universe of a release run. An explicit `--config-dir` selects its own universe; otherwise the release
 * ledger is the machine-wide prod root, and a process that itself resolved elsewhere (a source tree without a stamp)
 * is refused before any node starts — its own logs would land in a different universe from its nodes.
 */
export function releaseRunUniverse(deps: ReleaseUniverseDeps = {}): string {
  if (deps.root) return deps.root;
  const override = (deps.override ?? getElanousConfigDirOverride)();
  if (override) {
    const root = (deps.effectiveRoot ?? effectiveInstanceRoot)();
    debug.log('release.run', 'universe', { root, layer: 'explicit-flag' });
    return root;
  }
  const prod = normRoot((deps.prodRoot ?? prodInstanceRoot)());
  const parent = normRoot((deps.effectiveRoot ?? effectiveInstanceRoot)());
  if (parent !== prod) {
    debug.log('release.run', 'universe-refused', { parent, prod });
    throw new Error(`release run refused: this process resolves to ${parent}, not the release ledger universe ${prod} — its nodes would split ledgers and logs across universes. Run the installed \`elanous\` or pass \`--config-dir ${prod}\``);
  }
  debug.log('release.run', 'universe', { root: prod, layer: 'prod' });
  return prod;
}
