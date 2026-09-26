import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { getElanousConfigDirOverride } from '../elanous-config-dir.js';
import { getTestStateRoot } from '../nexus/paths.js';
import { findTreeRoot, getAppliedGlobalTestRoot } from '../cli/test-flag.js';
import { isInstalledCopyScript, treeFromScriptPath } from './leader.js';
import { prodInstanceRoot, resolveInstance, type InstanceResolution } from './resolve.js';

interface ResolveCurrentInstanceDeps {
  cwd?: () => string;
  stampedStateDir?: () => string | undefined;
  explicitFlagRoot?: () => string | undefined;
  /** Retired injection, ignored by universe selection. */
  treeDerivedEnabled?: () => boolean;
}

/** 현재 프로세스의 4층 판정 입력을 모아 순수 리졸버에 전달한다. */
export function resolveCurrentInstance(deps: ResolveCurrentInstanceDeps = {}): InstanceResolution {
  const cwd = (deps.cwd ?? (() => process.cwd()))();
  const explicitFlagRoot = (deps.explicitFlagRoot ?? (() =>
    getAppliedGlobalTestRoot() ?? getTestStateRoot() ?? getElanousConfigDirOverride()))();
  const treeRoot = (process.argv[1] ? treeFromScriptPath(process.argv[1]) : null) ?? findTreeRoot(cwd);
  const resolution = resolveInstance({
    explicitFlagRoot,
    stampedStateDir: (deps.stampedStateDir ?? (() => process.env.ELANOUS_STATE_DIR))(),
    installedCopy: isInstalledCopyScript(),
    treeTestRoot: treeRoot ? join(treeRoot, '.elanous-test') : null,
    prodRoot: prodInstanceRoot(),
  });
  debug.log('instance.current', 'resolved', { layer: resolution.layer, kind: resolution.kind });
  return resolution;
}
