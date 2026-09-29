import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';

import { nexusLogsDir, getTestStateRoot } from '../nexus/paths.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { isPidAlive } from '../process/pid-liveness.js';
import { DEFAULT_NEXUS_HTTP_PORT } from '../nexus/default-port.js';
import {
  checkSetupStatus,
  renderSetupStatus,
  setupBootMode,
  type SetupCheckResult,
} from '../nexus/setup-status.js';
import {
  isAliveNexusLock,
  readNexusLock,
  type NexusLockMeta,
} from '../nexus/supervisor/lock.js';

type BgChildHandle = Pick<ChildProcess, 'pid' | 'unref'>;

type BgChildProbeResult = 'alive' | 'exited';

const DEFAULT_CHILD_PROBE_DELAY_MS = 350;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultProbeChild(child: BgChildHandle): BgChildProbeResult {
  if (child.pid === undefined) return 'exited';
  // ⛔ EPERM 은 「죽음」이 아니다 — 공용 판정으로 모았다(2026-09-20 전수).
  //   ⚠️ 여기선 «내 자식»이라 EPERM 이 날 일이 드물지만, 사용자 전환·setuid 뒤엔 난다.
  return isPidAlive(child.pid) ? 'alive' : 'exited';
}

export function lastMeaningfulLogLine(logPath: string): string | undefined {
  let text = '';
  try {
    text = readFileSync(logPath, 'utf-8');
  } catch {
    return undefined;
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // ⛔ 「마지막 비공백 줄」을 그냥 내면 ***스택 프레임***이 나온다 — 원인이 그 위에 있다.
  //    📏 실측(2026-09-01 · 이 결함을 낳은 바로 그 로그):
  //      error: Isolated instance requires an explicit tool cwd; …   ⇐ 사람이 봐야 할 줄
  //            at resolveToolCwd (…/tool-cwd.ts:74:15)
  //            at runNexus (…/nexus/index.ts:1055:21)
  //            at async <anonymous> (…/index.ts:10125:13)             ⇐ 마지막 비공백 줄
  //    ⇒ 스택 프레임(`at …`)을 뒤에서부터 걷어내고, 그래도 남는 마지막 줄을 낸다.
  //    ⛔ 「오류 줄만 찾기」로 좁히지 않는다 — 오류 문면이 `error:` 로 시작한다는 보장이 없고,
  //       그러면 사유가 «아예 없어지는» 쪽으로 기운다. 걷어내되, 다 걷히면 원래 마지막 줄로 되돌린다.
  const isStackFrame = (line: string): boolean => /^at\s/.test(line);
  const withoutTrailingFrames = [...lines];
  while (withoutTrailingFrames.length > 1 && isStackFrame(withoutTrailingFrames.at(-1)!)) {
    withoutTrailingFrames.pop();
  }
  return withoutTrailingFrames.at(-1) ?? lines.at(-1);
}

export interface BgLaunchOpts {
  forwardArgs?: string[];
  childEnv?: Record<string, string>;
  force?: boolean;
  spawnFn?: (cmd: string, args: string[], opts: SpawnOptions) => BgChildHandle;
  logPathFn?: (stamp: string) => string;
  out?: { log: (s: string) => void; error: (s: string) => void };
  setupStatus?: SetupCheckResult;
  now?: () => number;
  childProbeDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  probeChildFn?: (child: BgChildHandle) => BgChildProbeResult;
  readLockFn?: () => NexusLockMeta | null;
  isAliveLockFn?: (meta: NexusLockMeta) => boolean;
}

export interface BgLaunchResult {
  exitCode: number;
  pid?: number;
  logPath?: string;
}

function defaultLogPath(stamp: string): string {
  mkdirSync(nexusLogsDir(), { recursive: true });
  return joinPath(nexusLogsDir(), `nexus-${stamp}.log`);
}

function httpSummary(opts: BgLaunchOpts): string {
  const args = opts.forwardArgs ?? [];
  let host = '127.0.0.1';
  let port = String(DEFAULT_NEXUS_HTTP_PORT);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--http-host' && typeof args[i + 1] === 'string') host = args[i + 1]!;
    if (args[i] === '--http-port' && typeof args[i + 1] === 'string') port = args[i + 1]!;
  }
  return `http://${host}:${port}`;
}

function printExistingLock(out: { log: (s: string) => void; error: (s: string) => void }, lock: NexusLockMeta): void {
  out.error('elanous nexus already running:');
  out.error(`  pid       ${lock.pid}`);
  out.error(`  host      ${lock.host}`);
  out.error(`  startedAt ${lock.startedAt}`);
  out.error('');
  out.error('Use `elanous nexus status` to inspect, `elanous nexus stop` to terminate, or `--force` to take over.');
}

export async function runBgLaunch(opts: BgLaunchOpts = {}): Promise<BgLaunchResult> {
  const out = opts.out ?? console;
  const readLockFn = opts.readLockFn ?? readNexusLock;
  const isAliveLockFn = opts.isAliveLockFn ?? isAliveNexusLock;
  if (!opts.force) {
    const lock = readLockFn();
    if (lock && isAliveLockFn(lock)) {
      printExistingLock(out, lock);
      return { exitCode: 1 };
    }
  }

  const setup = opts.setupStatus ?? checkSetupStatus({ argvBin: process.argv[1] ?? '' });
  const boot = setupBootMode(setup);
  if (boot.mode === 'refuse') {
    out.error('✗ elanous nexus --bg: setup incomplete');
    renderSetupStatus(setup, out);
    out.log('');
    out.log('  Run `elanous nexus` (interactive) once to walk through the wizard.');
    return { exitCode: 1 };
  }
  const setupMode = boot.mode === 'setup';

  const argvBin = process.argv[1] ?? '';
  if (!argvBin) {
    out.error('elanous nexus --bg: could not determine argv[1] for self-detach spawn.');
    return { exitCode: 1 };
  }

  const stamp = String((opts.now ?? Date.now)());
  const logPath = (opts.logPathFn ?? defaultLogPath)(stamp);
  mkdirSync(nexusLogsDir(), { recursive: true });
  const logFd = openSync(logPath, 'a', 0o644);
  // Child runs `nexus run` (no `--headless` — the new auto-detect path
  // resolves lifecycle from TTY + ELANOUS_NEXUS_BG_PARENT=1 below). The
  // env var pins inline mode even if the spawned harness somehow has a
  // TTY surface attached, so the child blocks here as a daemon
  // instead of trying to fork itself.
  // 2026-05-13 · config-dir-unify — propagate config-dir + test
  // state-root overrides to the detached daemon via argv rather than
  // env vars (removed ELANOUS_DAEMON_DIR / ELANOUS_NEXUS_DIR inheritance).
  // The child's own `applyConfigDirFlagFromArgv` /
  // `applyTestStateDirFlagFromArgv` extractors run pre-Commander so
  // these flags never reach subcommand option parsing.
  const inheritedDirArgs: string[] = [];
  const configDir = getElanousConfigDir();
  inheritedDirArgs.push('--config-dir', configDir);
  const testStateDir = getTestStateRoot();
  if (testStateDir !== undefined) {
    inheritedDirArgs.push('--test-state-dir', testStateDir);
  }
  const args = [
    argvBin,
    ...inheritedDirArgs,
    'nexus',
    'run',
    ...(opts.force ? ['--force'] : []),
    ...(opts.forwardArgs ?? []),
  ];
  const spawnFn = opts.spawnFn ?? ((cmd, childArgs, spawnOpts) => spawn(cmd, childArgs, spawnOpts));
  try {
    const child = spawnFn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        ELANOUS_TEST_COORDINATOR_LEASE_PORT: undefined,
        ELANOUS_TEST_COORDINATOR_LEASE_TOKEN: undefined,
        ELANOUS_TEST_COORDINATOR_LEASE_ID: undefined,
        ...opts.childEnv,
        ELANOUS_NEXUS_BG_PARENT: '1',
        ...(setupMode ? { ELANOUS_NEXUS_SETUP_MODE: '1' } : {}),
      },
    });
    child.unref();
    await (opts.sleepFn ?? sleep)(opts.childProbeDelayMs ?? DEFAULT_CHILD_PROBE_DELAY_MS);
    const childState = (opts.probeChildFn ?? defaultProbeChild)(child);
    if (childState === 'exited') {
      const lastLine = lastMeaningfulLogLine(logPath);
      out.error('elanous nexus --bg: detached child exited during startup.');
      if (lastLine) out.error(`  reason    ${lastLine}`);
      out.error(`  log       ${logPath}`);
      return { exitCode: 1, pid: child.pid, logPath };
    }
    if (setupMode) {
      out.log(`셋업 모드로 떴습니다 — 브라우저로 셋업: ${httpSummary(opts)}/app/setup/ (빠진 것: ${boot.missing.join(', ')})`);
    }
    out.log('elanous nexus: started in background');
    out.log(`  pid       ${child.pid ?? '(unknown)'}`);
    out.log(`  log       ${logPath}`);
    out.log(`  http      ${httpSummary(opts)}`);
    out.log('  status    elanous nexus status');
    out.log('  stop      elanous nexus stop');
    return { exitCode: 0, pid: child.pid, logPath };
  } catch (err) {
    out.error(`elanous nexus --bg: failed to spawn detached child: ${(err as Error).message}`);
    return { exitCode: 1 };
  } finally {
    try { closeSync(logFd); } catch { /* best-effort */ }
  }
}
