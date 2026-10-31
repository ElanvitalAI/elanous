import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import type { StartOpts } from '../pty-shell/registry.js';
import { childRunContextEnv } from '../agent/run-context.js';
import { childNestEnv } from '../agent/nest-depth.js';
import { harnessBoundaryEnv, harnessBoundaryRequestsEnv, harnessSpaceEnv, resolveRunIdentity, type HarnessSpace } from '../harness/harness-space.js';
import { controlInboxEnv } from '../harness/control-inbox.js';
import { childPtyIdentityEnv } from '../agent/pty-identity.js';
import { deriveChildController } from '../agent/identity-env.js';
import { observeOnlyFlagEnv } from './observe-only.js';
import { selfDevRunsDir } from '../self-dev/run-store.js';
import { syncTestConfig } from '../cli/config-test-sync.js';
import { debug } from '../debug/log.js';

/** = `PREAMBLE_SYNC_BLOCK_ENV`(dashboard/turn-preamble.ts). 그 모듈을 끌어오지 않으려 이름만 둔다 —
 *  같은 값인지는 elanous-tui-spawn-identity.test.ts 가 잡는다. */
export const PREAMBLE_SYNC_BLOCK_ENV = 'ELANOUS_TEST_PREAMBLE_SYNC_BLOCK_MS';

/** Bare held TUI startup includes Nexus/test-universe initialization; 30s is below observed cold-start latency. */
export const DEFAULT_TUI_TEST_READY_TIMEOUT_MS = 180_000;

export interface ElanousTuiSpawnOptions {
  readonly repoRoot: string;
  readonly cwd: string;
  readonly configDir?: string;
  readonly stateDir?: string;
  /** ⭐ 위 뿌리가 «파생»이면 자식에게 값으로 알린다(`OBS-T121`). */
  readonly stateDirSource?: 'derived';
  /** Parent-resolved absolute control inbox directory for the child's turn-boundary drain. */
  readonly controlInboxDir?: string;
  /** Caller-established space; the recipe must never recalculate this identity. */
  readonly space: HarnessSpace;
  readonly runId?: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly requireIsolation?: boolean;
  /** Parent CLI override, exported into the child environment before boot. */
  readonly observeOnly?: boolean;
  /** ⭐ 이 자식이 살 **PTY 의 id**(hold 경로는 미리 발급한다). 자식에게 `ELANOUS_PTY_ID` 로 넘긴다.
   *  ⛔ 없으면 자식의 `getCurrentPtyId()` 가 `undefined` 라 **자기가 어느 PTY 인지 관측에 못 적는다**.
   *  ⚠️ 이것은 **정체성 전파일 뿐 pty↔session 결속이 아니다** — 세션은 데몬이 소유한다
   *  (매뉴얼 §0a ⑶b · 조율 채널 #5730 · 2026-08-01). */
  ptyId?: string;
  /** Explicit controller identity for this child; otherwise derived from the parent environment. */
  readonly controller?: string;
}

export interface ElanousTuiIsolation {
  readonly configDir: string;
  readonly stateDir: string;
  readonly dispose: () => void;
}

/** True when `inner` is `outer` itself or lives below it (after realpath symlink resolution).
 *
 *  ⚠️ `startsWith('..')` is NOT the escape test — it also matches a legitimate
 *  child directory whose name merely begins with two dots (`<root>/..state`),
 *  and reading that as an escape makes containment answer "no" for a path that
 *  is plainly inside. The escape cases are exactly three: the relative path is
 *  absolute (different roots), it is `..` itself, or it begins with `..` followed
 *  by a separator. */
function isSameOrNested(inner: string, outer: string): boolean {
  const relativePath = relative(outer, inner);
  if (relativePath === '') return true;
  if (isAbsolute(relativePath)) return false;
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`);
}

/**
 * ⚠️ Containment must be checked in BOTH directions.
 *
 * The first version only asked "is the isolated directory inside the caller's
 * state?", which misses the mirror case: a caller state that lives INSIDE the
 * isolated root — e.g. root `/tmp/r` with `ELANOUS_STATE_DIR=/tmp/r/state/existing`.
 * Both one-way checks return false there, so the run is declared isolated while
 * writing directly on top of the caller's state. Isolation is a statement about
 * two trees not touching, and touching is symmetric.
 */
function overlaps(a: string, b: string): boolean {
  return isSameOrNested(a, b) || isSameOrNested(b, a);
}

function establishDirectory(path: string): string {
  mkdirSync(path, { recursive: true });
  if (!statSync(path).isDirectory()) throw new Error('path is not a directory');
  accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
  return realpathSync(path);
}

/**
 * Establish the config/state identity for an isolated bare TUI.
 * An implicit root is owned and removed by dispose; explicit roots remain caller-owned.
 */
export function establishElanousTuiIsolation(opts: { root?: string; callerStateDir?: string; sourceConfigDir?: string }): ElanousTuiIsolation {
  let root: string;
  let owned = false;
  try {
    if (opts.root) {
      root = establishDirectory(resolve(opts.root));
    } else {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'elanous-drive-')));
      owned = true;
    }
    const callerState = opts.callerStateDir ? establishDirectory(resolve(opts.callerStateDir)) : undefined;
    if (callerState && overlaps(root, callerState)) {
      throw new Error(`isolated root ${root} overlaps caller state directory ${callerState}`);
    }
    const configDir = root;
    const stateDir = root;
    if (callerState && (overlaps(configDir, callerState) || overlaps(stateDir, callerState))) {
      throw new Error(`isolated elanous config/state overlaps caller state directory ${callerState}`);
    }
    const configPath = join(configDir, 'config.json');
    if (existsSync(configPath)) {
      debug.log('pty.drive', 'isolation-config-materialized', { configDir, outcome: 'existing' });
    } else {
      try {
        syncTestConfig(configDir, opts.sourceConfigDir);
        debug.log('pty.drive', 'isolation-config-materialized', { configDir, outcome: 'created' });
      } catch (error) {
        debug.log('pty.drive', 'isolation-config-materialized', {
          configDir,
          outcome: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      configDir,
      stateDir,
      dispose: () => { if (owned) rmSync(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    if (owned) rmSync(root!, { recursive: true, force: true });
    throw new Error(`cannot establish isolated elanous TUI root${opts.root ? ` at ${opts.root}` : ''}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The sole spawn recipe for a bare elanous TUI child. */
export function elanousTuiSpawnOptions(opts: ElanousTuiSpawnOptions): StartOpts {
  const isolated = Boolean(opts.configDir && opts.stateDir);
  if (opts.requireIsolation && !isolated) {
    throw new Error('isolated elanous TUI requires both configDir and stateDir');
  }
  const { runId } = resolveRunIdentity({ explicit: opts.runId, inherited: opts.space.runId });
  const debugLevel = process.env.ELANOUS_DEBUG_LEVEL;
  // ⭐ PTY 는 기동 때 잡은 로그인 셸 env 위에 «여기 적은 키만» 얹는다(registry `buildPtyEnv`) —
  //    부모에 건 시험 seam env 는 적어 주지 않으면 자식에 안 닿는다(run-fbe85b7c · 자식 env 실측).
  //    격리 자식에만 넘긴다. 자식도 운영 우주면 무시한다(`preambleSyncBlockMs`).
  const preambleSyncBlock = isolated ? process.env[PREAMBLE_SYNC_BLOCK_ENV]?.trim() : undefined;
  if (preambleSyncBlock) {
    debug.log('self-implement.elanous-tui-spawn', 'test-seam-env', { name: PREAMBLE_SYNC_BLOCK_ENV, value: preambleSyncBlock });
  }
  const controller = opts.controller ?? deriveChildController(process.env, process.pid);
  const channels = 'pty,inbox';
  debug.log('self-implement.elanous-tui-spawn', 'controller', { controller, channels });
  return {
    cmd: 'bun',
    args: [
      `${opts.repoRoot}/bin/elanous.mjs`,
      ...(isolated ? ['--config-dir', opts.configDir!, '--test-state-dir', opts.stateDir!] : []),
    ],
    accessMode: 'auto',
    transitionPolicy: 'open',
    // 안 넘길 때는 로그인 셸 캡처본에 그 변수가 있어도 지운다 — 비격리 자식에 seam 이 새지 않게.
    ...(preambleSyncBlock ? {} : { unsetEnv: [PREAMBLE_SYNC_BLOCK_ENV] }),
    // ⭐ 대표 2026-08-02 — 자식 화면 기본 **160×40**. 가상 PTY라 사람 터미널과 무관하고,
    //    좁으면 렌더 블록이 화면을 넘어 **관측이 잘린다**(그 실측이 `--cols/--rows` 를 열게 했다).
    cols: opts.cols ?? 160,
    rows: opts.rows ?? 40,
    workdir: opts.cwd,
    env: {
      ...(opts.stateDir ? { ELANOUS_STATE_DIR: opts.stateDir } : {}),
      ...(opts.controlInboxDir ? controlInboxEnv(opts.controlInboxDir) : {}),
// ⛔⭐ 뿌리와 «한 벌»로 간다(`OBS-T121`) — 안 주면 자식이 「파생」을 「명시 격리」로 읽는다.
            ...(opts.stateDir && opts.stateDirSource ? { ELANOUS_STATE_DIR_SOURCE: opts.stateDirSource } : {}),
      ELANOUS_PARENT_SELF_DEV_RUNS_DIR: selfDevRunsDir(),
      ELANOUS_CONTROLLER: controller,
      ELANOUS_CONTROL_CHANNELS: channels,
      ...observeOnlyFlagEnv(opts.observeOnly),
      ...(debugLevel === undefined ? {} : { ELANOUS_DEBUG_LEVEL: debugLevel }),
      ...(preambleSyncBlock ? { [PREAMBLE_SYNC_BLOCK_ENV]: preambleSyncBlock } : {}),
      ...childRunContextEnv('self-build'),
      ...childNestEnv(),
      ...harnessSpaceEnv(opts.space.kind, opts.space.id, runId),
      ...harnessBoundaryEnv(opts.cwd),
      // ⭐⭐ 자식 PTY 정체성 — 종전엔 **하니스 goal-loop 경로에만** 실렸다
      //    (`headless-elanous-driver.ts`). 그래서 `--hold` 로 띄운 TUI 는 `ELANOUS_PTY_ID` 가 없어
      //    `getCurrentPtyId()` 가 `undefined` 였고, **자기가 어느 PTY 인지 관측에 못 적었다**.
      //    ⚠️ 이것은 정체성 전파일 뿐 **pty↔session 결속이 아니다**(세션은 데몬 소유 · §0a ⑶b).
      ...(opts.ptyId ? childPtyIdentityEnv(opts.ptyId) : {}),
      // ⭐⭐ 경계에서 «묻는 길» — 종전엔 self-implement 경로에만 실렸다(`seams.ts` · `headless-elanous-driver.ts`).
      //    그래서 `dev --elanous` 자식은 경계에서 거부돼도 «요청을 남길 자리»가 없었다.
      //    📏 2026-08-07 라이브 실측: 그 자식이 `bunx` 로 거부돼 `main-tree-reject` 는 났는데
      //       같은 우주에 `request-received` 가 «0» 이었다 — 거부는 나고 물을 길이 없던 것이다.
      //    ⚠️ 우편함 경로는 `ptyId` 로 결정되므로 id 가 없으면 «안 싣는다»(fail-open · 종전과 동일).
      ...harnessBoundaryRequestsEnv(opts.ptyId ?? ''),
    },
  };
}
