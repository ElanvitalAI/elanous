// NEXUS · /v1/health route (Phase N-1 PR δ)
//
// Liveness probe. Aggregates per-status counts so PWA / external
// monitors can spot regressions at a glance without paginating through
// /v1/nexus/tabs. Also names the answering daemon: universe root,
// test-universe classification, and the hostname selected for Bun.listen.

import { codeRevision } from '../../version/code-revision.js';
import { resolveCurrentInstance } from '../../instance/current.js';
import type { NexusState } from '../state/state.js';
import type { TabRegistry } from '../state/tab-registry.js';
import { getTestStateRoot, nexusRootDir } from '../paths.js';
import { jsonResponse } from './http-server.js';

const UNKNOWN = 'unknown' as const;

export type HealthTestUniverse = boolean | typeof UNKNOWN;

/** Bind identity the HTTP server selected for Bun.listen. */
export interface HealthBindContext {
  bindHost?: string;
  /**
   * 기동 때 한 번 정한 셋업 상태. `handleHealth` 의 선택 셋업 인자다.
   * mode 가 참일 때만 health JSON 에 setupMode·setupMissing 을 싣는다.
   */
  setup?: HealthSetupContext;
}

/** 기동 때 한 번 정한 셋업 상태. mode 가 참일 때만 health JSON 에 칸을 싣는다. */
export interface HealthSetupContext {
  mode: boolean;
  missing: string[];
}

interface HealthIdentityResolvers {
  universeRoot?: () => string;
  testStateRoot?: () => string | undefined;
  currentInstance?: () => { kind: string };
}

let identityResolversForTesting: HealthIdentityResolvers | undefined;

/** @internal Injects identity resolvers in isolated health tests. */
export function setHealthIdentityResolversForTesting(
  resolvers: HealthIdentityResolvers | undefined,
): void {
  identityResolversForTesting = resolvers;
}

/**
 * 데몬(백엔드) 코드의 git short SHA — 배포 최신 여부 구분용(PWA BuildBanner 가
 * PWA 프론트 빌드 SHA 와 나란히 표시). health route가 등록되는 모듈 초기화 때
 * 1회 캡처하므로 이후 health 요청은 데몬 기동 뒤 바뀐 HEAD를 재조회하지 않는다.
 */
function captureDaemonSha(): string {
  // ⛔ 2026-09-24 — 종전엔 `process.cwd()` 의 HEAD 를 읽었다. 설치본 데몬은 WorkingDirectory 가 pilot 트리라
  //   «데몬 코드»가 아니라 «작업 트리»의 커밋을 말했다(설치본 168eb32 ↔ 보고 7368f6a). `elanous --version` 과 같은 해석기로.
  try {
    const revision = codeRevision();
    return revision ? revision.slice(0, 9) : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

let daemonSha = captureDaemonSha();

/** @internal Resets the module-start snapshot in isolated health tests. */
export function resetDaemonShaForTesting(): void {
  daemonSha = captureDaemonSha();
}

function safeUniverseRoot(): string {
  try {
    const read = identityResolversForTesting?.universeRoot ?? nexusRootDir;
    const root = read();
    return typeof root === 'string' && root.trim() ? root : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

function safeTestUniverse(): HealthTestUniverse {
  try {
    const resolveInstance = identityResolversForTesting?.currentInstance
      ?? (() => resolveCurrentInstance());
    const kind = resolveInstance().kind;
    if (kind === 'test') return true;
    if (kind === 'prod') return false;
  } catch {
    // Fall through to the test-state signal rather than guessing.
  }
  try {
    const readTestRoot = identityResolversForTesting?.testStateRoot ?? getTestStateRoot;
    return readTestRoot() !== undefined ? true : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

function safeBindHost(bind?: HealthBindContext): string {
  const host = bind?.bindHost;
  return typeof host === 'string' ? host : UNKNOWN;
}

export function handleHealth(
  state: NexusState,
  registry: TabRegistry,
  bind?: HealthBindContext,
): Response {
  const tabs = registry.list();
  const byStatus: Record<string, number> = {};
  for (const t of tabs) {
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  }
  const setup = bind?.setup;
  return jsonResponse({
    ok: true,
    nexusVersion: state.nexusVersion,
    phase: state.phase,
    startedAt: state.startedAt,
    daemonSha,
    uptimeMs: Date.now() - state.startedAt,
    tabs: {
      total: tabs.length,
      byStatus,
    },
    universeRoot: safeUniverseRoot(),
    testUniverse: safeTestUniverse(),
    bindHost: safeBindHost(bind),
    // W4 — POST /v1/workflows/:name/run understands onlyNode · fromNode+fromRunId · mode (PWA enables its run-mode buttons on this).
    workflowRunModes: true as const,
    ...(setup?.mode === true
      ? { setupMode: true as const, setupMissing: setup.missing }
      : {}),
  });
}
