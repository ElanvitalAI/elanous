// 운영 루트의 Nexus 기동은 설치본 또는 명시 운영 루트에서만 허용한다.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normRoot, effectiveInstanceRoot } from './resolve.js';
import { debug } from '../debug/log.js';
import {
  clearLeaderRefusal, leaderRefusalFilePath, isInstalledCopyScript,
  resolveSelfTree, writeLeaderRefusal, type LeaderRefusalRecord,
} from './leader.js';
import { getNestDepth } from '../agent/nest-depth.js';
import { getAppliedGlobalTestRoot } from '../cli/test-flag.js';
import { getTestStateRoot } from '../nexus/paths.js';
import { getElanousConfigDirOverride } from '../elanous-config-dir.js';

export interface NexusRunRefusalInput {
  selfTree: string;
  /** Legacy diagnostic input; never grants operating authority. */
  leaderTree?: string | null;
  root: string;
  homeRoot: string;
  depth: number;
  installedCopy?: boolean;
  explicitRoot?: string | null;
}

export interface NexusRunRefusalDecision {
  refuse: boolean;
  why: string;
  observeAllowed: boolean;
  normalOperation: boolean;
}

export function decideNexusRunRefusal(input: NexusRunRefusalInput): NexusRunRefusalDecision {
  if (normRoot(input.root) !== normRoot(input.homeRoot)) {
    return { refuse: false, why: '해석된 뿌리가 운영 싱글턴이 아님', observeAllowed: true, normalOperation: false };
  }
  if (input.depth > 0) {
    return { refuse: true, why: `중첩 depth ${input.depth}에서 운영 데몬 접수 금지`, observeAllowed: false, normalOperation: false };
  }
  if (input.installedCopy || (input.explicitRoot && normRoot(input.explicitRoot) === normRoot(input.homeRoot))) {
    return { refuse: false, why: input.installedCopy ? '설치본 운영 데몬 기동' : '명시 운영 루트 데몬 기동', observeAllowed: false, normalOperation: true };
  }
  return { refuse: true, why: '명시 운영 루트 없는 소스 트리의 운영 데몬 접수 금지', observeAllowed: false, normalOperation: false };
}

export function renderNexusRunRefusal(input: NexusRunRefusalInput, decision: NexusRunRefusalDecision): string {
  return [
    `⛔ 운영 데몬 기동 거부 — ${decision.why}`,
    `  이 트리   : ${input.selfTree}`,
    `  해석 뿌리 : ${input.root}`,
    '  운영 명령은 전역 `elanous` 로 실행하세요.',
    "  소스 트리 격리 기동은 '--test' 를 사용하세요.",
    `  사유 기록 : ${leaderRefusalFilePath()}`,
  ].join('\n');
}

export interface NexusRunGateDeps {
  selfTree?: string;
  installedCopy?: boolean;
  leaderTree?: string | null;
  explicitRoot?: string | null;
  root?: string;
  homeRoot?: string;
  depth?: number;
  now?: () => string;
  write?: (rec: LeaderRefusalRecord) => void;
  clear?: () => void;
  log?: (event: string, data: Record<string, unknown>, warn?: boolean) => void;
}

export function evaluateNexusRunRefusal(deps: NexusRunGateDeps = {}): string | null {
  const log = deps.log ?? ((event, data, warn) => {
    try { debug.log('instance.identity', event, data, warn ? { level: 'warn' } : undefined); } catch { /* fail-soft */ }
  });
  try {
    const input: NexusRunRefusalInput = {
      selfTree: deps.selfTree ?? resolveSelfTree(),
      installedCopy: deps.installedCopy ?? isInstalledCopyScript(),
      explicitRoot: deps.explicitRoot !== undefined ? deps.explicitRoot :
        (getAppliedGlobalTestRoot() ?? getTestStateRoot() ?? getElanousConfigDirOverride() ?? process.env.ELANOUS_STATE_DIR),
      root: deps.root ?? effectiveInstanceRoot(),
      homeRoot: deps.homeRoot ?? join(homedir(), '.elanous'),
      depth: deps.depth ?? getNestDepth(),
    };
    const decision = decideNexusRunRefusal(input);
    const shape = { selfTree: input.selfTree, root: input.root, depth: input.depth, why: decision.why };
    if (!decision.refuse) {
      if (decision.observeAllowed) log('nexus-run-allowed-isolated', shape);
      if (decision.normalOperation) (deps.clear ?? clearLeaderRefusal)();
      return null;
    }
    log('nexus-run-refused', shape, true);
    (deps.write ?? writeLeaderRefusal)({
      refusedAt: (deps.now ?? (() => new Date().toISOString()))(),
      selfTree: input.selfTree, leaderTree: '', root: input.root, depth: input.depth, why: decision.why,
    });
    return renderNexusRunRefusal(input, decision);
  } catch (e) {
    log('nexus-run-gate-error', { error: e instanceof Error ? e.message : String(e) }, true);
    return null;
  }
}
