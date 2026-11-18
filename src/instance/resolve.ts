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

/** RESEARCH-HARNESS-ISOLATION-STATE-DIR — state 축만의 뿌리 규칙(순수 함수).
 *  코드가 운영 루트로 건 config override(`programmatic`)는 격리 스탬프(`ELANOUS_STATE_DIR`)의 state 를 운영으로 끌어오지 않는다.
 *  측정 러너가 운영 설정을 읽으려고 `setElanousConfigDir(~/.elanous)` 를 걸자 logs.db 가 운영으로 갔다(RES 08:0x 발견).
 *  사람·CLI 의 `--config-dir`(`flag`)은 우주 선택이라 종전대로 이긴다 — `where` 와 state 가 같은 운영을 가리킨다.
 *  격리 override(운영이 아닌 루트)도 종전대로 이긴다 — 의도된 별개 우주(매뉴얼 §3 B)를 지킨다. */
export function stateRootOverStamp(instanceRoot: string, stamp: string | undefined, prodRoot: string,
  overrideSource: 'flag' | 'programmatic' | undefined): string {
  const s = stamp?.trim();
  if (!s || overrideSource !== 'programmatic') return instanceRoot;
  const prod = normRoot(prodRoot);
  const stampRoot = normRoot(s);
  return normRoot(instanceRoot) === prod && stampRoot !== prod ? stampRoot : instanceRoot;
}

const reportedStateRootSplits = new Set<string>();

/** state 축 실효 뿌리 — `effectiveInstanceRoot()` 에 위 규칙만 더한다. config 축(`getElanousConfigDir`)은 바꾸지 않는다.
 *  두 축이 갈리면 `instance.identity/state-root-split` 관측을 뿌리 쌍마다 한 번 남긴다(로그 저장소가 이 함수를 다시 불러도 한 번). */
export function effectiveStateRoot(): string {
  const instanceRoot = effectiveInstanceRoot();
  let source: 'flag' | 'programmatic' | undefined;
  try {
    const { getElanousConfigDirOverrideSource } = require('../elanous-config-dir.js') as typeof import('../elanous-config-dir.js');
    source = getElanousConfigDirOverrideSource();
  } catch { /* 부팅 초기 — override 없음으로 본다 */ }
  const stateRoot = stateRootOverStamp(instanceRoot, process.env.ELANOUS_STATE_DIR, prodInstanceRoot(), source);
  if (stateRoot !== instanceRoot) {
    const key = `${instanceRoot}\0${stateRoot}`;
    if (!reportedStateRootSplits.has(key)) {
      reportedStateRootSplits.add(key);
      try {
        const { logDiagnostic } = require('../mss/logging/diagnostic-sink.js') as typeof import('../mss/logging/diagnostic-sink.js');
        logDiagnostic('instance.identity', 'state-root-split', { configRoot: instanceRoot, stateRoot, overrideSource: source ?? null,
          why: '코드가 건 운영 config override ⊕ 격리 스탬프 — config 는 운영, state 는 스탬프' }, { level: 'warn' });
      } catch { /* 관측 실패가 해석을 바꾸지 않는다 */ }
    }
  }
  return stateRoot;
}

/** 시험 전용 — 한 번만 남기는 split 관측 기억을 지운다. */
export function resetStateRootSplitReportsForTesting(): void { reportedStateRootSplits.clear(); }
