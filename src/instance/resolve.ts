// 인스턴스 우주: 명시 루트 → 부모 스탬프 → 운영 집. 트리 위치는 우주를 고르지 않는다.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type InstanceKind = 'prod' | 'test';
export type ResolutionLayer = 'explicit-flag' | 'parent-stamp' | 'installed' | 'default';

export interface InstanceResolution {
  kind: InstanceKind;
  root: string;
  layer: ResolutionLayer;
  why: string;
}

export interface ResolveDeps {
  explicitFlagRoot?: string | undefined;
  stampedStateDir?: string | undefined;
  installedCopy?: boolean;
  /** Retired injected inputs cannot grant operating authority. */
  treeDerivedEnabled?: boolean;
  axes?: { selfInstalled?: boolean };
  depth?: number;
  prodRoot?: string;
  treeTestRoot?: string | null;
}

export function normRoot(p: string): string {
  return resolve(p.trim().replace(/\/+$/, ''));
}

export function prodInstanceRoot(): string {
  return normRoot(join(homedir(), '.elanous'));
}

/** Release records are machine-wide except in an explicitly selected config universe. */
export function releaseLedgerRoot(): string {
  const { getElanousConfigDirOverride } = require('../elanous-config-dir.js') as typeof import('../elanous-config-dir.js');
  return getElanousConfigDirOverride() ? effectiveInstanceRoot() : prodInstanceRoot();
}

export function resolveInstance(deps: ResolveDeps = {}): InstanceResolution {
  const prodRoot = normRoot(deps.prodRoot ?? prodInstanceRoot());
  if (deps.explicitFlagRoot?.trim()) {
    const root = normRoot(deps.explicitFlagRoot);
    return { kind: root === prodRoot ? 'prod' : 'test', root, layer: 'explicit-flag', why: '명시 루트(--test/--test-state-dir/--config-dir)' };
  }
  if (deps.stampedStateDir?.trim()) {
    const root = normRoot(deps.stampedStateDir);
    return { kind: root === prodRoot ? 'prod' : 'test', root, layer: 'parent-stamp', why: '부모 스탬프 ELANOUS_STATE_DIR' };
  }
  const installed = deps.installedCopy ?? isInstalledExecution();
  if (installed) return { kind: 'prod', root: prodRoot, layer: 'installed', why: '설치본으로 실행' };
  // Explicit --test selects a test root before this resolver runs. A checkout,
  // worktree, or arbitrary cwd alone never changes the operating house.
  return { kind: 'prod', root: prodRoot, layer: 'default', why: '명시 시험 우주가 없는 운영 집' };
}

/** 부모가 도장으로 물려준 우주와 자식이 실제로 쓰는 우주가 다른가. 비어 있는 쪽은 비교하지 않는다. */
export function universeMismatch(parentRoot: string | undefined, childRoot: string | undefined): { parentRoot: string; childRoot: string } | null {
  const parent = parentRoot?.trim();
  const child = childRoot?.trim();
  if (!parent || !child) return null;
  const p = normRoot(parent);
  const c = normRoot(child);
  return p === c ? null : { parentRoot: p, childRoot: c };
}

export type UniverseMeasure = { measurable: true } | { measurable: false; reason: '빈 우주' };

/** 읽을 우주가 비어 있으면 «0» 이 아니라 «측정 불가» 로 말해야 한다. 디렉터리가 없거나 항목이 하나도 없으면 빈 우주다. */
export function measureUniverse(root: string, entries: (dir: string) => string[] = defaultEntries): UniverseMeasure {
  return entries(root).length > 0 ? { measurable: true } : { measurable: false, reason: '빈 우주' };
}

function defaultEntries(dir: string): string[] {
  try {
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    return readdirSync(dir);
  } catch { return []; }
}

/** 명시 config-dir 이 없으면 state-dir 과 config-dir 을 같은 우주로 유지한다. */
export function configDirFollowingStateDir(
  explicitConfigDir: string | undefined,
  stateDir: string | undefined,
  prodRoot = join(homedir(), '.elanous'),
): { dir: string; followed: boolean } {
  if (explicitConfigDir) return { dir: explicitConfigDir, followed: false };
  const s = stateDir?.trim();
  if (s && normRoot(s) !== normRoot(prodRoot)) return { dir: normRoot(s), followed: true };
  return { dir: prodRoot, followed: false };
}

/** 설치본 판별은 실행 스크립트 기준이며 cwd 가 트리여도 설치본은 운영이다. */
export function isInstalledExecution(): boolean {
  try {
    const { isInstalledCopyScript } = require('./leader.js') as typeof import('./leader.js');
    return isInstalledCopyScript();
  } catch { return false; }
}

// Legacy configuration seam remains callable, but source isolation cannot be disabled.
export function treeDerivedTestEnabled(): boolean { return true; }
export function setTreeDerivedTestForTesting(_enabled: boolean | undefined): void { resetEffectiveInstanceRoot(); }

let memoRoot: string | undefined;
export function resetEffectiveInstanceRoot(): void { memoRoot = undefined; }

export function treeDerivedRootFor(cwd: string): string | null {
  try {
    const { findTreeRoot } = require('../cli/test-flag.js') as typeof import('../cli/test-flag.js');
    const { treeFromScriptPath } = require('./leader.js') as typeof import('./leader.js');
    const t = (process.argv[1] ? treeFromScriptPath(process.argv[1]) : null) ?? findTreeRoot(cwd);
    return t ? join(t, '.elanous-test') : null;
  } catch { return null; }
}

/** state-dir/config-dir 의 동일한 실효 뿌리. 명시는 memo 보다 앞서 읽는다. */
export function effectiveInstanceRoot(): string {
  try {
    const { getElanousConfigDirOverride } = require('../elanous-config-dir.js') as typeof import('../elanous-config-dir.js');
    const ov = getElanousConfigDirOverride();
    if (ov) return resolveInstance({ explicitFlagRoot: ov }).root;
  } catch { /* 부팅 초기에는 아래 층으로 */ }
  const stamp = process.env.ELANOUS_STATE_DIR?.trim();
  if (stamp) return resolveInstance({ stampedStateDir: stamp }).root;
  if (memoRoot) return memoRoot;
  memoRoot = resolveInstance().root;
  return memoRoot;
}
