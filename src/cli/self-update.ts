import { existsSync, mkdirSync, readFileSync, realpathSync, readlinkSync, readdirSync, statSync, rmSync, symlinkSync, renameSync, writeFileSync, lstatSync } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { homedir, platform, userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';
import { decideRestartNeeded, type RestartNeededResult } from './nexus-restart-needed.js';
import { debug } from '../debug/log.js';
import { envLiteral } from '../platform/env-literal.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { getUserConfig } from '../user-config.js';
import { planEdgeRail, type EdgeRailInput, type EdgeRailPlan } from './self-update-canary.js';
import { loadRunLedger } from '../self-implement/run-ledger.js';

export interface SelfUpdateOptions {
  from?: string;
  restart?: boolean;
  json?: boolean;
  /** 남길 최근 판 수(롤백용). 기본 3. 0 이하면 정리하지 않는다. */
  keep?: number;
  /** 실패(exit≠0)를 알림으로도 보낸다 — 무인(크론) 실행용. 🩸 없으면 pilot 이 더럽거나 설치가 실패해도 조용히 며칠씩 멈춘다. */
  alert?: boolean;
  /** 명시적으로 요청한 경우에만 체크아웃 설치 전 PWA 빌드를 건너뛴다. */
  skipPwaBuild?: boolean;
  /** 설치된 릴리스에서만 사용한다. 체크아웃 갱신에는 적용하지 않는다. */
  version?: string;
  /** 판 사이 dev 빌드 설치 — versions/<판>-dev.<sha12> · install.json channel:'dev'. 사람 승인 명령. */
  dev?: boolean;
  /** install.json 의 이전 versionDir 로 current 를 되돌린다. 이전이 없으면 거부. */
  rollback?: boolean;
  /** Canary rollout action; legacy --auto on|off|status is handled by the CLI scheduler. */
  auto?: boolean;
  dryRun?: boolean;
  seat?: string;
  quietWindow?: boolean;
  failureRate?: EdgeRailInput['failureRate'];
  /** Unique ID of an independently successful canary run; no id means no new run. */
  canaryRunId?: string;
}

export interface SelfUpdateDeps {
  cliRoot?: string;
  git?: (cwd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
  decide?: (opts: { to: string; cwd: string; out: { log: (s: string) => void; error: (s: string) => void } }) => Promise<RestartNeededResult>;
  run?: (command: string, args: string[], cwd: string, options?: { timeout?: number }) => { status: number | null; stderr: string; stdout?: string };
  installedVersion?: () => string;
  /** 캐너리 시작 «뒤»에 시작해 `completed` 로 끝난 런인가(주입 안 하면 런 원장 `canaryRunSucceededInLedger`). */
  canaryRunSucceeded?: (runId: string, sinceIso: string) => boolean;
  /** 재시작 뒤 데몬이 이 커밋으로 떴나(주입 안 하면 `/v1/health` 를 최대 90초 폴링). */
  verifyRestart?: (expectedCommit: string) => Promise<VerifyRestartResult>;
  /** 판 목록(이름) — 되돌릴 판 찾기. */
  listVersions?: () => string[];
  /** `current` 를 그 판으로 원자적으로 바꾼다. */
  relinkCurrent?: (versionName: string) => void;
  /** 무인 실패 알림(주입 안 하면 sendOutbound 'alert' — 야간 무음 규칙 포함). */
  alert?: (text: string) => void;
  /** 판 폴더 정리 — 주입하지 않으면 `~/.local/share/elanous/versions` 를 실제로 지운다. */
  pruneVersions?: (plan: { current: string; daemonSha: string; keep: number }) => VersionPruneOutcome;
  os?: NodeJS.Platform;
  uid?: number;
  /** relay 가 싣는 파일(저장소 상대) — 주입 안 하면 `scripts/openai-relay-server.ts` 에서 상대 import 를 따라 모은다. */
  relayFiles?: (checkout: string) => string[];
  /** 텔레그램 러너 서비스(`elanous telegram service --install`)가 깔려 있나 — 주입 안 하면 서비스 파일 존재로 본다. */
  telegramRunnerInstalled?: () => boolean;
  out?: { log: (s: string) => void; error: (s: string) => void };
  /** 판올림 성공 알림(주입 안 하면 sendOutbound 'report' · 시험에선 안 보냄). */
  notice?: (text: string) => void;
  /**
   * 설치 루트(versions · current · install.json). 주입하지 않으면 ~/.local/share/elanous.
   * 시험은 임시 루트만 넘긴다 — 실물 심링크·재시작을 만지지 않는다.
   */
  installRoot?: string;
  /** 패키지 버전(package.json). 주입하지 않으면 체크아웃 package.json. */
  packageVersion?: (checkout: string) => string;
  /** 재시작을 실제로 호출해도 되는지. NODE_ENV=test · ELANOUS_TEST_HOME 이면 기본 false. */
  allowLiveRestart?: boolean;
  /** Automatic edge-rail inputs; injected in tests, never a service registration. */
  now?: () => Date;
  stateDir?: string;
  edgeRailConfig?: () => Pick<EdgeRailInput, 'canaryOkRuns' | 'failureMultiplier' | 'minSamples'>;
  installEdgeRail?: (options: SelfUpdateOptions, deps: SelfUpdateDeps) => Promise<SelfUpdateResult>;
  rollbackEdgeRail?: (deps: Pick<SelfUpdateDeps, 'installRoot'>) => ReturnType<typeof rollbackDevInstall>;
  restartEdgeRail?: () => Promise<boolean>;
}

export interface SelfUpdateResult {
  exitCode: 0 | 1 | 2;
  installedVersion: string | null;
  decision: RestartNeededResult | null;
  restarted: boolean;
  reason: string;
  /** 체크아웃에서 PWA 빌드가 성공한 HEAD 커밋(12자)과 빌드 시각. */
  pwaBuiltCommit?: string;
  pwaBuiltAt?: string;
  /** 릴리스 갱신에 사용한 기준 URL 및 결정 출처. */
  releaseBase?: string;
  releaseBaseSource?: 'option' | 'env' | 'install-source' | 'default';
  /** 설치 뒤 옛 판 정리 결과. 정리를 건너뛰었으면 `skipped` 에 이유. */
  prune?: VersionPruneOutcome;
  /** 재시작 뒤 건강 — ok · rolled-back(직전 판으로 되돌려 회복) · rollback-failed · no-rollback-target. */
  health?: 'ok' | 'rolled-back' | 'rollback-failed' | 'no-rollback-target' | 'unmeasured';
  /** --dev 설치 또는 --rollback 이 옮긴 current 대상(versions/<name>). */
  current?: string;
  /** install.json channel. dev 설치면 'dev'. */
  channel?: string;
  /** --dev 가 남긴 이전 versionDir. */
  previous?: string;
  rolledBackTo?: string;
  /** relay(`com.elanous.openai-relay`) 판정 — 넥서스와 «따로» 본다(T5 · 2026-09-24). */
  relay?: RelayUpdateOutcome;
  /** 텔레그램 러너(`com.elanous.telegram` · `elanous-telegram.service`) 판정 — 🆕 2026-09-25. */
  telegramRunner?: RelayUpdateOutcome;
  edgeRail?: EdgeRailPlan;
  missingFixes?: string;
  /** 실패율 측정 원천이 없으면 자동 되돌림이 판단되지 않는다 — 측정 원천은 다음 조각(EDGE-RAIL2 범위 밖). */
  autoRollback?: 'active' | 'inactive-no-failure-rate';
}

export interface RelayUpdateOutcome {
  verdict: 'restarted' | 'unchanged' | 'unknown' | 'failed' | 'skipped';
  reason: string;
  /** 바뀐 relay 파일(최대 10). */
  paths?: string[];
}

export const RELAY_ENTRY = 'scripts/openai-relay-server.ts';
export const RELAY_LAUNCHD_LABEL = 'com.elanous.openai-relay';

/** 데몬 커밋→새 커밋 구간에 relay 파일이 바뀌었으면(그리고 `--restart` 면) relay 만 재시작한다. 순수에 가깝게 — 부작용은 `run` 하나. */
export function updateRelay(
  decision: RestartNeededResult,
  checkout: string,
  restart: boolean,
  deps: Pick<SelfUpdateDeps, 'relayFiles' | 'os' | 'uid'>,
  git: (cwd: string, args: string[]) => { status: number | null; stdout: string; stderr: string },
  run: (command: string, args: string[], cwd: string) => { status: number | null; stderr: string },
): RelayUpdateOutcome {
  const from = decision.from;
  const to = decision.to;
  if (!from || !to) return { verdict: 'unknown', reason: '데몬 커밋 또는 새 커밋을 모름 — relay 판정 불가(재시작 안 함)' };
  const diff = git(checkout, ['diff', '-z', '--name-only', `${from}..${to}`]);
  if (diff.status !== 0) return { verdict: 'unknown', reason: `git diff 실패: ${diff.stderr.trim() || diff.status}` };
  const changed = new Set(diff.stdout.split('\0').filter(Boolean));
  const relayFiles = (deps.relayFiles ?? ((root: string) => relayImportClosure(root)))(checkout);
  if (!relayFiles.length) return { verdict: 'unknown', reason: `relay 진입 파일을 못 읽음: ${RELAY_ENTRY}` };
  const touched = relayFiles.filter((file) => changed.has(file));
  if (!touched.length) return { verdict: 'unchanged', reason: `relay 파일 ${relayFiles.length}개 중 바뀐 것 없음` };
  const paths = touched.slice(0, 10);
  if (!restart) return { verdict: 'skipped', reason: '--restart 없음: relay 재시작하지 않음', paths };
  const os = deps.os ?? platform();
  if (os !== 'darwin') return { verdict: 'skipped', reason: `relay 재시작 미지원 플랫폼: ${os}`, paths };
  const uid = deps.uid ?? process.getuid?.() ?? userInfo().uid;
  try {
    const restarted = run('launchctl', ['kickstart', '-k', `gui/${uid}/${RELAY_LAUNCHD_LABEL}`], checkout);
    if (restarted.status !== 0) return { verdict: 'failed', reason: `relay 재시작 실패: ${restarted.stderr.trim() || restarted.status}`, paths };
  } catch (error) {
    return { verdict: 'failed', reason: `relay 재시작 실패: ${String(error)}`, paths };
  }
  return { verdict: 'restarted', reason: `relay 파일 ${touched.length}개 바뀜 → 재시작`, paths };
}

/**
 * 텔레그램 러너 — 설치돼 있고 «새 커밋»이 깔렸으면 재시작한다(🆕 2026-09-25 텔레그램 분리 운영 전환 준비).
 * 🩸 종전엔 self-update 에 텔레그램이 «0줄»이라 러너가 옛 판으로 영영 돌았다.
 * 러너는 봇 코드 대부분을 싣는다(import 폐포가 사실상 전체) — relay 처럼 파일로 가르지 않고 «판이 바뀌었나»로 본다.
 * 재시작 비용은 몇 초 · 그 사이 온 메시지는 텔레그램 서버가 보관한다 · 미션은 분리 프로세스라 안 끊긴다.
 */
export function updateTelegramRunner(
  decision: RestartNeededResult,
  restart: boolean,
  deps: Pick<SelfUpdateDeps, 'telegramRunnerInstalled' | 'os' | 'uid'>,
  run: (command: string, args: string[], cwd: string) => { status: number | null; stderr: string },
  cwd: string,
): RelayUpdateOutcome {
  const os = deps.os ?? platform();
  const installed = (deps.telegramRunnerInstalled ?? (() => existsSync(os === 'darwin'
    ? join(homedir(), 'Library', 'LaunchAgents', 'com.elanous.telegram.plist')
    : join(homedir(), '.config', 'systemd', 'user', 'elanous-telegram.service'))))();
  if (!installed) return { verdict: 'skipped', reason: '러너 서비스 없음(telegram.poller=nexus) — 해당 없음' };
  const from = decision.from?.trim();
  const to = decision.to?.trim();
  if (!from || !to) return { verdict: 'unknown', reason: '데몬 커밋 또는 새 커밋을 모름 — 러너 재시작 안 함' };
  if (to.startsWith(from) || from.startsWith(to)) return { verdict: 'unchanged', reason: '같은 커밋 — 러너 재시작 불필요' };
  if (!restart) return { verdict: 'skipped', reason: '--restart 없음: 러너 재시작하지 않음' };
  const [command, args] = os === 'darwin'
    ? ['launchctl', ['kickstart', '-k', `gui/${deps.uid ?? process.getuid?.() ?? userInfo().uid}/com.elanous.telegram`]] as const
    : os === 'linux' ? ['systemctl', ['--user', 'restart', 'elanous-telegram.service']] as const : [null, []] as const;
  if (!command) return { verdict: 'skipped', reason: `러너 재시작 미지원 플랫폼: ${os}` };
  try {
    const r = run(command, [...args], cwd);
    if (r.status !== 0) return { verdict: 'failed', reason: `러너 재시작 실패: ${r.stderr.trim() || r.status}` };
  } catch (error) {
    return { verdict: 'failed', reason: `러너 재시작 실패: ${String(error)}` };
  }
  return { verdict: 'restarted', reason: `새 커밋(${from.slice(0, 12)}→${to.slice(0, 12)}) — 러너 재시작` };
}

/** relay 진입 파일에서 상대 import 를 따라간 파일 집합(저장소 상대 · `.ts`). 못 읽는 파일은 건너뛴다. */
export function relayImportClosure(checkout: string, entry: string = RELAY_ENTRY, read: (path: string) => string = (path) => readFileSync(path, 'utf8')): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const rel = queue.shift()!;
    if (seen.has(rel)) continue;
    let source: string;
    try { source = read(join(checkout, rel)); } catch { continue; }
    seen.add(rel);
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = join(dirname(rel), match[1]!).replace(/\.js$/, '.ts');
      queue.push(target.endsWith('.ts') ? target : `${target}.ts`);
    }
  }
  return [...seen].sort();
}

/** 판 이름 `<ver>-<commit12>[-dirty]` 에서 커밋. */
export function versionCommit(name: string): string {
  return /-([0-9a-f]{12})(?:-dirty)?$/.exec(name)?.[1] ?? '';
}

/** 데몬이 돌던 sha 의 판(되돌릴 곳). 설치한 판 자신은 빼고, 여럿이면 이름순 마지막. */
export function rollbackTarget(versions: readonly string[], daemonSha: string, installed: string): string | null {
  const sha = daemonSha.replace(/-dirty$/, '').trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return null;
  const hits = versions.filter((v) => v !== installed && versionCommit(v) !== '' && (versionCommit(v).startsWith(sha) || sha.startsWith(versionCommit(v))));
  return hits.length ? [...hits].sort().at(-1)! : null;
}

const VERSIONS_DIR = () => join(homedir(), '.local/share/elanous/versions');

/** 시험·ELANOUS_TEST_HOME 에서는 실물 재시작을 호출하지 않는다. */
export function liveRestartBlocked(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'test' || Boolean(env.ELANOUS_TEST_HOME?.trim());
}

export interface InstallRecord {
  version?: string;
  versionDir?: string;
  source?: string;
  installedAt?: string;
  commit?: string;
  channel?: string;
  previous?: string;
}

export function defaultInstallRoot(): string {
  return join(homedir(), '.local/share/elanous');
}

export function readInstallRecord(root: string): InstallRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, 'install.json'), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as InstallRecord;
  } catch {
    return null;
  }
}

/** install.json 의 version·commit. 못 읽으면 둘 다 «unknown». */
export function readInstalledIdentity(root: string = defaultInstallRoot()): { installedVersion: string; installedCommit: string } {
  const record = readInstallRecord(root);
  const version = typeof record?.version === 'string' && record.version.trim() ? record.version.trim() : '';
  const commit = typeof record?.commit === 'string' && record.commit.trim() ? record.commit.trim() : '';
  return { installedVersion: version || 'unknown', installedCommit: commit || 'unknown' };
}

const VERSION_DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function versionDirName(versionDir: string | undefined): string | null {
  if (typeof versionDir !== 'string') return null;
  if (!/^versions\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(versionDir) || versionDir.includes('..')) return null;
  return basename(versionDir);
}

/** 판 디렉터리에 실행 진입 파일이 있나(설치기가 실제로 내용을 깔았나). */
export function installEntryExists(root: string, versionName: string): boolean {
  return existsSync(join(root, 'versions', versionName, 'node_modules', 'elanous', 'bin', 'elanous.mjs'));
}

/** 판 이름 «<판>-<커밋12>» · «<판>-dev.<커밋12>» 에서 판·커밋을 읽는다(되돌림 메타 일치용). */
export function parseVersionDirName(name: string): { version: string; commit: string } | null {
  const m = /^(.+?)-(?:dev\.)?([0-9a-f]{12})(?:-dirty)?$/.exec(name);
  return m ? { version: m[1]!, commit: m[2]! } : null;
}

/** current 심링크를 versions/<name> 으로 원자적으로 옮긴다. 대상 폴더가 없으면 거부. */
export function relinkInstallCurrent(root: string, versionName: string): void {
  if (!VERSION_DIR_NAME.test(versionName) || versionName.includes('..')) throw new Error(`잘못된 판 이름: ${versionName}`);
  if (!existsSync(join(root, 'versions', versionName))) throw new Error(`판 디렉터리 없음: ${versionName}`);
  // EDGE-RAIL-VERIFY(10-06 05:30 사고): 진입 파일이 없는 판으로는 current 를 옮기지 않는다(빈 판 → 전역 elanous·크론 전부 실패).
  if (!installEntryExists(root, versionName)) throw new Error(`빈 판(진입 파일 없음): ${versionName} — current 를 옮기지 않는다`);
  const tmp = join(root, `.current-dev-${process.pid}`);
  rmSync(tmp, { force: true });
  symlinkSync(`versions/${versionName}`, tmp);
  renameSync(tmp, join(root, 'current'));
}

function checkoutPackageVersion(checkout: string): string {
  const parsed = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof parsed.version !== 'string' || !parsed.version.trim()) throw new Error('package.json version 없음');
  return parsed.version.trim();
}

/**
 * 판 사이 dev 빌드 — versions/<판>-dev.<sha12> 를 만들고 current 를 옮긴다.
 * install.json 에 channel:'dev' 와 이전 versionDir(previous) 를 남긴다. 실제 설치기·재시작은 부르지 않는다.
 */
export function installDevBuild(checkout: string, commit: string, deps: Pick<SelfUpdateDeps, 'installRoot' | 'packageVersion'> & { runInstaller?: () => { status: number | null; stderr: string } } = {}): { versionName: string; versionDir: string; previous: string; record: InstallRecord } {
  const sha12 = commit.trim().toLowerCase().slice(0, 12);
  if (!/^[0-9a-f]{12}$/.test(sha12)) throw new Error(`dev 설치 커밋이 12자가 아님: ${commit}`);
  const root = deps.installRoot ?? defaultInstallRoot();
  const prior = readInstallRecord(root);
  const previous = versionDirName(prior?.versionDir) ? prior!.versionDir! : (typeof prior?.previous === 'string' ? prior.previous : '');
  // EDGE-RAIL-VERIFY: 빈 디렉터리를 만들고 current 만 옮기던 길(10-06 05:30 사고)을 버리고, 정식 길과 같은 설치기로 내용을 깐다.
  if (!deps.runInstaller) throw new Error('dev 설치기 없음 — 빈 판을 깔지 않는다');
  // install.sh 는 current 를 «먼저» 옮기고 뒤에서 실패할 수 있다 — 실패·빈 판 어느 쪽이든 이전 판·install.json 으로 되돌린다.
  const restore = (why: string, versionName: string | null): never => {
    const previousName = versionDirName(previous);
    if (previousName && installEntryExists(root, previousName)) relinkInstallCurrent(root, previousName);
    if (prior) writeFileSync(join(root, 'install.json'), `${JSON.stringify(prior, null, 2)}\n`);
    try { debug.log('self-update', 'dev-install-refused', { why, versionName, kept: previousName ?? null }); } catch { /* 관측 실패가 막지 않는다 */ }
    throw new Error(`${why}: ${versionName ?? '?'} — current 를 이전 판(${previousName ?? '없음'})으로 유지`);
  };
  let result: { status: number | null; stderr: string };
  try { result = deps.runInstaller(); }
  catch (error) { return restore(`설치기 예외(${String(error).slice(0, 200)})`, null); }
  const after = readInstallRecord(root);
  const versionName = versionDirName(after?.versionDir);
  if (result.status !== 0) return restore(`설치기 실패(rc=${result.status}: ${result.stderr.slice(0, 200)})`, versionName);
  if (!versionName || !installEntryExists(root, versionName)) return restore('빈 판(진입 파일 없음)', versionName);
  const versionDir = `versions/${versionName}`;
  const record: InstallRecord = {
    ...(after ?? {}),
    versionDir,
    channel: 'dev',
    ...(previous && previous !== versionDir ? { previous } : {}),
  };
  writeFileSync(join(root, 'install.json'), `${JSON.stringify(record, null, 2)}\n`);
  return { versionName, versionDir, previous, record };
}

/** install.json.previous 의 판으로 current 를 되돌린다. previous 가 없으면 거부(exit 2). */
export function rollbackDevInstall(deps: Pick<SelfUpdateDeps, 'installRoot'> = {}): { ok: true; versionName: string; record: InstallRecord } | { ok: false; reason: string } {
  const root = deps.installRoot ?? defaultInstallRoot();
  const prior = readInstallRecord(root);
  const previousName = versionDirName(prior?.previous);
  if (!prior || !previousName) return { ok: false, reason: '이전 판(install.json previous)이 없다 — rollback 거부' };
  if (!existsSync(join(root, 'versions', previousName))) return { ok: false, reason: `이전 판 디렉터리 없음: ${previousName}` };
  const currentName = versionDirName(prior.versionDir);
  relinkInstallCurrent(root, previousName);
  const parsed = parseVersionDirName(previousName);
  const record: InstallRecord = {
    ...prior,
    ...(parsed ? { version: parsed.version, commit: parsed.commit } : {}),
    versionDir: `versions/${previousName}`,
    channel: prior.channel === 'dev' ? undefined : prior.channel,
    previous: currentName ? `versions/${currentName}` : undefined,
    installedAt: new Date().toISOString(),
  };
  if (!record.channel) delete record.channel;
  if (!record.previous) delete record.previous;
  writeFileSync(join(root, 'install.json'), `${JSON.stringify(record, null, 2)}\n`);
  return { ok: true, versionName: previousName, record };
}

/** `unmeasured` = 건강을 «잴 수» 없었다(REST 주소를 한 번도 못 얻음) — 「건강하지 않다」와 다르다. 되돌리지 않는다. */
export interface VerifyRestartResult { ok: boolean; daemonSha?: string; reason?: string; unmeasured?: boolean }

export async function defaultVerifyRestart(expectedCommit: string): Promise<VerifyRestartResult> {
  const { runNexusShow, joinRestHealthUrl, defaultProbeHealth } = await import('./nexus-show.js');
  const deadline = Date.now() + 90_000;
  let last = '';
  let sawRestUrl = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    try {
      const captured: string[] = [];
      const shown = await runNexusShow({ format: 'json', out: { log: (x) => captured.push(x), error: (x) => captured.push(x) } });
      const base = shown.urls?.rest.loopback;
      if (!base) { last = 'rest url 없음'; continue; }
      sawRestUrl = true;
      const health = await defaultProbeHealth(joinRestHealthUrl(base));
      const sha = typeof health?.daemonSha === 'string' ? health.daemonSha.trim() : '';
      if (!sha) { last = '데몬 무응답'; continue; }
      if (expectedCommit.startsWith(sha) || sha.startsWith(expectedCommit)) return { ok: true, daemonSha: sha };
      last = `daemonSha ${sha} ≠ ${expectedCommit}`;
    } catch (error) {
      last = String(error);
    }
  }
  // 🩸 2026-09-24: 비-리더 워크트리에서 돌리면 테스트 우주를 봐서 REST 주소가 «없다» — 그것을 「건강 실패」로 접으면
  //    멀쩡한 재시작을 옛 판으로 되돌린다. 못 잰 것은 못 잰 것으로 돌려준다.
  return { ok: false, reason: last || '시간 초과', ...(sawRestUrl ? {} : { unmeasured: true }) };
}

function defaultRelinkCurrent(versionName: string): void {
  const root = join(homedir(), '.local/share/elanous');
  const tmp = join(root, `.current-rollback-${process.pid}`);
  rmSync(tmp, { force: true });
  symlinkSync(`versions/${versionName}`, tmp);
  renameSync(tmp, join(root, 'current'));
}

/** 판올림 성공 알림 한 줄(대표 09-28 «수정·배포 과정이 매끄럽지 않다») — 사람이 «무엇을 해야 새 판을 보나»를 바로 안다. */
export function formatUpdateNotice(result: Pick<SelfUpdateResult, 'installedVersion' | 'restarted' | 'decision' | 'pwaBuiltCommit'>): string | null {
  if (!result.installedVersion) return null;
  const restartLine = result.restarted
    ? '넥서스 재시작함 — 열린 PWA 탭의 터미널·채팅 연결이 끊겼다 → **새로고침** 하면 다시 붙는다'
    : '넥서스 재시작 안 함(화면·스크립트만 바뀜)';
  const pwaLine = result.pwaBuiltCommit || result.restarted
    ? 'PWA 새 화면: 열린 탭은 **새로고침** 해야 보인다'
    : 'PWA 변경 없음';
  return [`🔄 **운영 판올림** \`${result.installedVersion}\``, `  • ${restartLine}`, `  • ${pwaLine}`].join('\n');
}

function defaultNotice(text: string): void {
  // 시험에선 텔레그램으로 나가지 않는다.
  if (process.env.NODE_ENV === 'test') return;
  import('../domains/outbound-alert.js').then((m) => { m.sendOutbound(text, 'ops-report'); }).catch(() => {});
}

function defaultAlert(text: string): void {
  import('../domains/outbound-alert.js').then((m) => { m.sendOutbound(text, 'ops-alert'); }).catch(() => {});
}

export interface VersionPruneOutcome {
  removed: string[];
  kept: string[];
  skipped?: string;
}

/**
 * 야간 자동 설치는 하룻밤에 한 판(약 641MB · 2026-09-24 실측)을 쌓는다. 설치기는 옛 판을 안 지운다.
 * 남기는 것: `current` 가 가리키는 판 · 지금 데몬이 도는 판(판정의 `from` sha) · 최근 `keep` 판(롤백용).
 * ⛔ 데몬 판을 모르면(판정 실패·데몬 무응답) 아무것도 지우지 않는다 — 도는 데몬의 파일을 지울 수 있어서.
 */
export function planVersionPrune(
  entries: ReadonlyArray<{ name: string; mtimeMs: number }>,
  current: string,
  daemonSha: string,
  keep: number,
): VersionPruneOutcome {
  const all = entries.map((e) => e.name);
  if (keep <= 0) return { removed: [], kept: all, skipped: 'keep<=0' };
  const sha = daemonSha.replace(/-dirty$/, '').trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return { removed: [], kept: all, skipped: `데몬 판 모름: ${daemonSha || '없음'}` };
  if (!all.includes(current)) return { removed: [], kept: all, skipped: `current 판이 목록에 없음: ${current}` };
  const commitOf = (name: string) => /-([0-9a-f]{12})(?:-dirty)?$/.exec(name)?.[1] ?? '';
  const isDaemon = (name: string) => {
    const c = commitOf(name);
    return c !== '' && (c.startsWith(sha) || sha.startsWith(c));
  };
  if (!all.some(isDaemon)) return { removed: [], kept: all, skipped: `데몬 판(${sha})이 목록에 없음` };
  const newest = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, keep).map((e) => e.name);
  const kept = all.filter((n) => n === current || isDaemon(n) || newest.includes(n));
  return { removed: all.filter((n) => !kept.includes(n)), kept };
}

function defaultPruneVersions(plan: { current: string; daemonSha: string; keep: number }): VersionPruneOutcome {
  const dir = join(homedir(), '.local/share/elanous/versions');
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, mtimeMs: statSync(join(dir, d.name)).mtimeMs }));
  const outcome = planVersionPrune(entries, plan.current, plan.daemonSha, plan.keep);
  for (const name of outcome.removed) rmSync(join(dir, name), { recursive: true, force: true });
  return outcome;
}

/**
 * 자식 PATH 앞에 «지금 이 CLI 를 돌리는 bun» 의 폴더를 붙인다.
 * 🩸 2026-09-24 실측: 크론의 PATH 는 `/usr/bin:/bin` 뿐이라 설치기가 `bun` 을 못 찾고 «공식 설치기로 bun 을 새로 깔려» 든다.
 *    야간 자동 self-update 가 크론에서 돌므로, 이미 떠 있는 bun 을 쓰게 한다(중복 설치·네트워크 없음).
 */
export function childPath(env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): string {
  const bunDir = dirname(execPath);
  const current = env.PATH ?? '';
  return current.split(':').includes(bunDir) ? current : [bunDir, current].filter(Boolean).join(':');
}

// bun 1.4 는 maxBuffer(기본 1MiB)를 넘는 출력을 자르고 자식을 죽인다 — 설치·빌드 로그는 그보다 클 수 있다.
const SPAWN_MAX_BUFFER = 64 * 1024 * 1024;

const execute = (command: string, args: string[], cwd: string, options?: { timeout?: number }) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: options?.timeout, maxBuffer: SPAWN_MAX_BUFFER, env: { ...process.env, PATH: childPath() } });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.error?.message ?? result.stderr ?? '' };
};

export interface ReleaseUpdateOptions {
  version?: string;
  restart?: boolean;
  json?: boolean;
  alert?: boolean;
  keep?: number;
}

export interface ReleaseUpdateDeps {
  packageRoot?: string;
  exists?: (path: string) => boolean;
  fetchInstaller?: (url: string) => Promise<string>;
  run?: (command: string, args: string[], cwd: string, input?: string, env?: NodeJS.ProcessEnv) => { status: number | null; stderr: string };
  os?: NodeJS.Platform;
  uid?: number;
  out?: { log: (text: string) => void; error: (text: string) => void };
  alert?: (text: string) => void;
  pruneVersions?: (plan: { current: string; previous: string; keep: number; prefix: string }) => VersionPruneOutcome;
  /** 릴리스 기준 URL 주입 — 환경변수와 설치 출처보다 우선한다. */
  releaseBase?: string;
}

function pruneReleaseVersions(plan: { current: string; previous: string; keep: number; prefix: string }): VersionPruneOutcome {
  const dir = join(plan.prefix, 'versions');
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, mtimeMs: statSync(join(dir, entry.name)).mtimeMs }));
  const all = entries.map((entry) => entry.name);
  if (plan.keep <= 0) return { removed: [], kept: all, skipped: 'keep<=0' };
  if (!plan.current || !plan.previous || !all.includes(plan.current) || !all.includes(plan.previous)) {
    return { removed: [], kept: all, skipped: '현재 또는 직전 판을 확인할 수 없음' };
  }
  const newest = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, plan.keep).map((entry) => entry.name);
  const kept = all.filter((name) => name === plan.current || name === plan.previous || newest.includes(name));
  const removed = all.filter((name) => !kept.includes(name));
  for (const name of removed) rmSync(join(dir, name), { recursive: true, force: true });
  return { removed, kept };
}

/** The build identity of an install.json — version, version folder and commit; empty when it cannot be read. */
function installedBuild(metadata: unknown): string {
  if (typeof metadata !== 'object' || metadata === null) return '';
  const { version, versionDir, commit } = metadata as { version?: unknown; versionDir?: unknown; commit?: unknown };
  if (typeof version !== 'string' || !version || typeof versionDir !== 'string' || !versionDir) return '';
  return JSON.stringify([version, versionDir, typeof commit === 'string' ? commit : '']);
}

/** A release update never packs the checkout: the downloaded installer verifies its own release tarball. */
export async function runReleaseUpdate(options: ReleaseUpdateOptions = {}, deps: ReleaseUpdateDeps = {}): Promise<SelfUpdateResult> {
  const out = deps.out ?? console;
  let selection: Pick<SelfUpdateResult, 'releaseBase' | 'releaseBaseSource'> = {};
  const finish = (result: SelfUpdateResult): SelfUpdateResult => {
    result = { ...result, ...selection };
    if (options.alert && result.exitCode !== 0) (deps.alert ?? defaultAlert)(`⛔ elanous self-update 실패(exit ${result.exitCode}): ${result.reason}`);
    if (options.json) out.log(JSON.stringify(result));
    else out.log(`release-update: installed=${result.installedVersion ?? 'none'} restarted=${result.restarted} reason=${result.reason}`);
    return result;
  };
  const fail = (exitCode: 1 | 2, reason: string): SelfUpdateResult => finish({ exitCode, installedVersion: null, decision: null, restarted: false, reason });
  const packageRoot = resolve(deps.packageRoot ?? resolve(import.meta.dir, '../..'));
  const exists = deps.exists ?? existsSync;
  const holder = resolve(packageRoot, '..', '..');
  const parent = resolve(holder, '..');
  const prefix = basename(parent) === 'versions' && exists(join(resolve(parent, '..'), 'install.json'))
    ? resolve(parent, '..')
    : basename(holder) === 'current' && exists(join(parent, 'install.json')) ? parent
    : exists(join(holder, 'install.json')) ? holder : null;
  if (!prefix) return fail(2, `설치 prefix 확인 실패 (install.json 없음): ${packageRoot}`);
  const version = options.version?.trim();
  if (options.version !== undefined && (!version || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version))) {
    return fail(2, `잘못된 릴리스 버전: ${options.version}`);
  }
  const source = readInstallSource(packageRoot, exists);
  const inferred = source?.match(/^(https?:\/\/[^?#]+|file:\/\/[^?#]+)\/(?:latest\/download|download\/v[^/]+)\/elanous\.tgz$/)?.[1];
  const base = (deps.releaseBase ?? process.env.ELANOUS_RELEASE_BASE ?? inferred ?? 'https://github.com/ElanvitalAI/elanous/releases').replace(/\/+$/, '');
  selection = { releaseBase: base, releaseBaseSource: deps.releaseBase !== undefined ? 'option' : process.env.ELANOUS_RELEASE_BASE !== undefined ? 'env' : inferred ? 'install-source' : 'default' };
  const isTailnet = (value: string | null): boolean => {
    try { return value !== null && new URL(value).hostname.toLowerCase().endsWith('.ts.net'); }
    catch { return false; }
  };
  if (isTailnet(source) && !isTailnet(base)) return fail(2, '내부 설치본을 공개 기준으로 바꾸지 않는다');
  const url = `${base}/${version ? `download/v${version}` : 'latest/download'}/install.sh`;
  let installer: string;
  try {
    installer = await (deps.fetchInstaller ?? (async (address) => {
      const response = await fetch(address);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    }))(url);
    if (!installer.trim()) throw new Error('empty installer');
  } catch (error) {
    return fail(1, `설치기 다운로드 실패 (${url}): ${String(error)}`);
  }
  let previous = '';
  let previousBuild = '';
  let replacedDev: { from: string; to: string } | null = null;
  try {
    const metadata: unknown = JSON.parse(readFileSync(join(prefix, 'install.json'), 'utf8'));
    previousBuild = installedBuild(metadata);
    if (typeof metadata === 'object' && metadata !== null && (metadata as { channel?: unknown }).channel === 'dev') {
      const fromDir = typeof (metadata as { versionDir?: unknown }).versionDir === 'string' ? (metadata as { versionDir: string }).versionDir : '';
      replacedDev = { from: fromDir, to: '' };
    }
    if (typeof metadata === 'object' && metadata !== null && 'versionDir' in metadata && typeof metadata.versionDir === 'string') {
      const dir = metadata.versionDir;
      if (/^versions\/[a-zA-Z0-9._-]+$/.test(dir) && !dir.includes('..')) previous = basename(dir);
    }
  } catch { previous = ''; }
  const run = deps.run ?? ((command: string, args: string[], cwd: string, input?: string, env?: NodeJS.ProcessEnv) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', input, maxBuffer: SPAWN_MAX_BUFFER, env: { ...process.env, ...env, PATH: childPath() } });
    return { status: result.status, stderr: result.error?.message ?? result.stderr ?? '' };
  });
  try {
    const install = run('bash', ['-s', '--', '--no-modify-path', '--prefix', prefix], prefix, installer, envLiteral({ ELANOUS_VERSION: version ?? '', ELANOUS_INSTALL_SOURCE: '', ELANOUS_RELEASE_BASE: base }));
    if (install.status !== 0) return fail(1, `설치 실패: ${install.stderr.trim() || install.status}`);
    const metadata: unknown = JSON.parse(readFileSync(join(prefix, 'install.json'), 'utf8'));
    const installedVersion = typeof metadata === 'object' && metadata !== null && 'version' in metadata && typeof metadata.version === 'string'
      ? metadata.version : null;
    if (!installedVersion) return fail(1, '설치판 확인 실패: install.json version 없음');
    if (replacedDev) {
      const toDir = typeof metadata === 'object' && metadata !== null && typeof (metadata as { versionDir?: unknown }).versionDir === 'string'
        ? (metadata as { versionDir: string }).versionDir : installedVersion;
      replacedDev = { from: replacedDev.from, to: toDir };
      try { debug.log('self-update', 'dev-replaced', replacedDev); } catch { /* 관측 실패가 갱신을 막지 않는다 */ }
    }
    const internalRevision = isTailnet(source) && version?.match(/^(.*)-([0-9a-f]{12})$/);
    if (version && installedVersion !== version && (!internalRevision || installedVersion !== internalRevision[1])) {
      return fail(1, `설치판 버전 불일치: 요청 ${version}, 설치 ${installedVersion}`);
    }
    let prune: VersionPruneOutcome;
    try {
      const current = typeof metadata === 'object' && metadata !== null && 'versionDir' in metadata && typeof metadata.versionDir === 'string'
        && /^versions\/[a-zA-Z0-9._-]+$/.test(metadata.versionDir) && !metadata.versionDir.includes('..') ? basename(metadata.versionDir) : '';
      prune = (deps.pruneVersions ?? pruneReleaseVersions)({ current, previous, keep: options.keep ?? 3, prefix });
    } catch (error) {
      prune = { removed: [], kept: [], skipped: `정리 실패: ${String(error)}` };
    }
    if (!options.restart) return finish({ exitCode: 0, installedVersion, decision: null, restarted: false, prune, reason: '--restart 없음: 재시작하지 않음' });
    // REL6: the same build again (version · folder · commit unchanged) leaves the running daemon as it is.
    if (previousBuild && previousBuild === installedBuild(metadata)) {
      return finish({ exitCode: 0, installedVersion, decision: null, restarted: false, prune, reason: `already at ${installedVersion} · restart skipped` });
    }
    const os = deps.os ?? platform();
    const command = os === 'darwin' ? 'launchctl' : os === 'linux' ? 'systemctl' : null;
    if (!command) return finish({ exitCode: 1, installedVersion, decision: null, restarted: false, prune, reason: `지원하지 않는 플랫폼: ${os}` });
    const args = os === 'darwin' ? ['kickstart', '-k', `gui/${deps.uid ?? process.getuid?.() ?? userInfo().uid}/com.elanous.nexus`] : ['--user', 'restart', 'elanous-nexus'];
    const restart = run(command, args, prefix);
    return finish({ exitCode: restart.status === 0 ? 0 : 1, installedVersion, decision: null, restarted: restart.status === 0, prune, reason: restart.status === 0 ? '재시작 완료' : `재시작 실패: ${restart.stderr.trim() || restart.status}` });
  } catch (error) {
    return fail(1, `설치 또는 재시작 실패: ${String(error)}`);
  }
}

/** 설치본의 `install.json` 에서 `source` 를 읽는다 — prefix 는 판 폴더·`current`·prefix 셋 중 install.json 이 있는 곳. */
function readInstallSource(cliRoot: string, exists: (path: string) => boolean, readText: (path: string) => string = (p) => readFileSync(p, 'utf8')): string | null {
  const holder = resolve(cliRoot, '..', '..');
  const parent = resolve(holder, '..');
  const prefix = basename(parent) === 'versions' && exists(join(resolve(parent, '..'), 'install.json')) ? resolve(parent, '..')
    : basename(holder) === 'current' && exists(join(parent, 'install.json')) ? parent
    : exists(join(holder, 'install.json')) ? holder : null;
  if (!prefix) return null;
  try {
    const metadata = JSON.parse(readText(join(prefix, 'install.json'))) as { source?: unknown };
    return typeof metadata.source === 'string' && metadata.source.trim() ? metadata.source.trim() : null;
  } catch {
    return null;
  }
}

/** Output only; never uses a title to decide whether to install. */
export function missingFixCommitTitles(checkout: string, installed: string, main: string, git: NonNullable<SelfUpdateDeps['git']>): string {
  if (!/^[a-f0-9]{12,40}$/i.test(installed) || !/^[a-f0-9]{12,40}$/i.test(main)) return 'main 엔 있고 운영엔 없는 수리: 판정 불가';
  const result = git(checkout, ['log', '--format=%s', '--no-merges', `${installed}..${main}`]);
  if (result.status !== 0) return 'main 엔 있고 운영엔 없는 수리: 판정 불가';
  const titles = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /\bfix(?:es|ed)?\b|(?:^|[(:])fix[:)]/i.test(line))
    .map((line) => line.replace(/[\r\n\t]+/g, ' ').slice(0, 160)).slice(0, 10);
  return `main 엔 있고 운영엔 없는 수리: ${titles.length ? titles.join(' · ') : '없음'}`;
}

interface EdgeRailState { canary: NonNullable<EdgeRailInput['canary']>; mainCommit: string; lastRunId?: string; countedRunIds?: string[]; failureRate?: NonNullable<EdgeRailInput['failureRate']>; promoted?: boolean; rolledBack?: boolean }

function saveEdgeRailState(file: string, state: EdgeRailState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}

/** 런 원장에서: `start` 가 캐너리 시작 이후이고 마지막 `run-status` 가 `completed` 인 런만 참. 못 읽으면 거짓. */
export function canaryRunSucceededInLedger(runId: string, sinceIso: string, dir?: string): boolean {
  try {
    const entries = (dir ? loadRunLedger(runId, dir) : loadRunLedger(runId)) ?? [];
    const started = Date.parse(entries.find((entry) => entry.event === 'start')?.timestamp ?? '');
    const last = entries.filter((entry) => entry.event === 'run-status').at(-1);
    return Number.isFinite(started) && started >= Date.parse(sinceIso) && last?.data.runStatus === 'completed';
  } catch { return false; }
}

async function restartEdgeRail(deps: SelfUpdateDeps, checkout: string): Promise<boolean> {
  if (deps.restartEdgeRail) return deps.restartEdgeRail();
  if (deps.allowLiveRestart === false || (deps.allowLiveRestart !== true && liveRestartBlocked())) return false;
  const os = deps.os ?? platform();
  const command = os === 'darwin' ? 'launchctl' : os === 'linux' ? 'systemctl' : null;
  if (!command) return false;
  const args = os === 'darwin' ? ['kickstart', '-k', `gui/${deps.uid ?? process.getuid?.() ?? userInfo().uid}/com.elanous.nexus`] : ['--user', 'restart', 'elanous-nexus'];
  return (deps.run ?? execute)(command, args, checkout).status === 0;
}

export async function runEdgeRailUpdate(options: SelfUpdateOptions, deps: SelfUpdateDeps = {}): Promise<SelfUpdateResult> {
  const out = deps.out ?? console;
  const root = deps.installRoot ?? defaultInstallRoot();
  const record = readInstallRecord(root);
  const checkout = resolve(options.from ?? record?.source ?? deps.cliRoot ?? resolve(import.meta.dir, '../..'));
  const stateFile = join(deps.stateDir ?? elanousStateRoot(), 'self-update-edge-rail.json');
  const git = deps.git ?? ((cwd: string, args: string[]) => execute('git', args, cwd));
  const fail = (reason: string): SelfUpdateResult => {
    const result: SelfUpdateResult = { exitCode: 2, installedVersion: null, decision: null, restarted: false, reason };
    out.log(options.json ? JSON.stringify(result) : `self-update --auto: hold — ${reason}`);
    return result;
  };
  if (options.dev || options.rollback || options.version || options.restart) return fail('--auto cannot combine with --dev, --rollback, --version or --restart');
  if (options.seat !== 'OP' && options.seat !== 'TC' && options.seat !== 'MK' && options.seat !== 'UX') return fail('--auto requires a known --seat (OP|TC|MK|UX)');
  if (!record?.commit) return fail('installed commit unknown');
  const currentName = versionDirName(record.versionDir);
  if (!currentName || !installEntryExists(root, currentName)) return fail('installed entry missing');
  try {
    if (readlinkSync(join(root, 'current')) !== record.versionDir) return fail('current does not match installed record');
  } catch { return fail('current is not a version link'); }
  if (!options.from && (!record.source || /^(?:https?:|file:)/.test(record.source))) return fail('local checkout source unknown — use --from');
  if (!existsSync(join(checkout, 'scripts', 'install.sh'))) return fail('checkout installer missing');
  const verifiedRoot = git(checkout, ['rev-parse', '--show-toplevel']);
  try {
    if (verifiedRoot.status !== 0 || !verifiedRoot.stdout.trim() || realpathSync(verifiedRoot.stdout.trim()) !== realpathSync(checkout)) return fail('checkout git root mismatch');
  } catch { return fail('checkout git root mismatch'); }
  const head = git(checkout, ['rev-parse', '--verify', 'main']);
  if (head.status !== 0 || !/^[a-f0-9]{12,40}$/i.test(head.stdout.trim())) return fail('main commit unknown');
  if (!options.dryRun) {
    const tracked = git(checkout, ['diff', '--quiet', 'HEAD', '--']);
    const working = git(checkout, ['rev-parse', '--verify', 'HEAD']);
    if (tracked.status !== 0 || working.status !== 0 || working.stdout.trim() !== head.stdout.trim()) return fail('main is not the clean checkout HEAD');
    const untracked = git(checkout, ['ls-files', '--others', '--exclude-standard']);
    if (untracked.status !== 0 || untracked.stdout.trim()) return fail('checkout contains untracked files');
  }
  let state: EdgeRailState | null = null;
  if (existsSync(stateFile)) {
    try {
      const value: unknown = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (value && typeof value === 'object' && 'canary' in value && 'mainCommit' in value) state = value as EdgeRailState;
      else return fail('invalid edge-rail state');
    } catch { return fail('invalid edge-rail state'); }
  }
  const mainCommit = head.stdout.trim();
  const config = deps.edgeRailConfig?.() ?? getUserConfig().harness?.edgeRail ?? {};
  const canary = state?.mainCommit === mainCommit ? state.canary : null;
  const observed = (deps.now ?? (() => new Date()))();
  if (!options.dryRun && canary && canary.okRuns < (config.canaryOkRuns ?? 3) && options.seat === 'OP' && (record.commit.startsWith(mainCommit) || mainCommit.startsWith(record.commit))
    && !options.failureRate && options.canaryRunId?.trim() && options.canaryRunId !== state?.lastRunId
    // 같은 런을 두 번 세지 않고, 캐너리 시작 뒤 «성공으로 끝난» 런만 센다(임의·과거·실패 id 로 승격을 열지 못하게).
    && !(state?.countedRunIds ?? []).includes(options.canaryRunId.trim())
    && (deps.canaryRunSucceeded ?? canaryRunSucceededInLedger)(options.canaryRunId.trim(), canary.startedAt)
    && Number.isFinite(observed.getTime()) && observed.getTime() >= Date.parse(canary.startedAt)) {
    const health = await (deps.verifyRestart ?? defaultVerifyRestart)(mainCommit);
    if (health.ok && health.daemonSha && (health.daemonSha.startsWith(mainCommit) || mainCommit.startsWith(health.daemonSha)) && state) {
      state = { ...state, canary: { ...canary, okRuns: canary.okRuns + 1 }, lastRunId: options.canaryRunId, countedRunIds: [...(state.countedRunIds ?? []), options.canaryRunId.trim()] };
      saveEdgeRailState(stateFile, state);
    }
  }
  const input: EdgeRailInput = {
    // 설정에서는 세 수치만 받는다 — 여분 키가 판단 입력(seat·failureRate·canary…)을 덮지 못하게.
    ...(config.canaryOkRuns !== undefined ? { canaryOkRuns: config.canaryOkRuns } : {}),
    ...(config.failureMultiplier !== undefined ? { failureMultiplier: config.failureMultiplier } : {}),
    ...(config.minSamples !== undefined ? { minSamples: config.minSamples } : {}),
    now: observed, mainCommit, installed: record.commit, seat: options.seat,
    canary: state?.mainCommit === mainCommit ? state.canary : null,
    failureRate: options.failureRate ?? (state?.mainCommit === mainCommit ? state.failureRate : null) ?? null,
    quietWindow: options.quietWindow === true, promoted: state?.mainCommit === mainCommit ? state.promoted : false,
  };
  // 이 main 은 이미 되돌렸다 — 새 main 이 올 때까지 다시 깔거나 승격하지 않는다.
  const plan = state?.mainCommit === mainCommit && state.rolledBack
    ? { decision: 'hold' as const, reason: 'this main was rolled back; waiting for a new main' }
    : planEdgeRail(input);
  const fixes = missingFixCommitTitles(checkout, record.commit, mainCommit, git);
  if (!options.dryRun) try { debug.log('self-update.edge-rail', 'plan', { decision: plan.decision, reason: plan.reason, seat: options.seat, mainCommit, installed: record.commit, fixes }); } catch { /* log sink optional */ }
  const emit = (result: SelfUpdateResult): SelfUpdateResult => {
    const autoRollback = input.failureRate ? 'active' as const : 'inactive-no-failure-rate' as const;
    const merged = { ...result, edgeRail: plan, missingFixes: fixes, autoRollback };
    out.log(options.json ? JSON.stringify(merged) : `self-update --auto: ${plan.decision} — ${plan.reason} · ${fixes}${autoRollback === 'active' ? '' : ' · 자동 되돌림 비활성 — 실패율 측정 원천 없음'}`);
    return merged;
  };
  if (options.dryRun || plan.decision === 'hold' || plan.decision === 'wait-quiet') return emit({ exitCode: 0, installedVersion: null, decision: null, restarted: false, reason: plan.reason });
  if (plan.decision === 'rollback' && (!record.previous || !versionDirName(record.previous))) return emit({ exitCode: 2, installedVersion: null, decision: null, restarted: false, reason: 'no previous version for rollback' });
  if (plan.decision === 'rollback' && !deps.restartEdgeRail && liveRestartBlocked()) return emit({ exitCode: 2, installedVersion: null, decision: null, restarted: false, reason: 'live restart blocked' });
  if (plan.decision === 'rollback') {
    const rolled = (deps.rollbackEdgeRail ?? rollbackDevInstall)(deps);
    if (!rolled.ok) return emit({ exitCode: 2, installedVersion: null, decision: null, restarted: false, reason: rolled.reason });
    // 되돌린 main 은 표시해 둔다 — 캐너리 OK 수가 남아 있어도 다음 실행이 다시 승격하지 못하게.
    if (state?.mainCommit === mainCommit) saveEdgeRailState(stateFile, { ...state, promoted: false, rolledBack: true });
    else saveEdgeRailState(stateFile, { mainCommit, canary: { seat: 'OP', okRuns: 0, startedAt: input.now.toISOString() }, rolledBack: true });
    const restarted = await restartEdgeRail(deps, checkout);
    const health = restarted ? await (deps.verifyRestart ?? defaultVerifyRestart)(rolled.record.commit ?? '') : null;
    const confirmed = !!(health?.ok && health.daemonSha && rolled.record.commit
      && (health.daemonSha.startsWith(rolled.record.commit) || rolled.record.commit.startsWith(health.daemonSha)));
    return emit({ exitCode: confirmed ? 0 : 1, installedVersion: rolled.versionName, decision: null, restarted, current: `versions/${rolled.versionName}`, reason: confirmed ? plan.reason : `${plan.reason}; rollback health not confirmed` });
  }
  if (!deps.restartEdgeRail && liveRestartBlocked()) return emit({ exitCode: 2, installedVersion: null, decision: null, restarted: false, reason: 'live restart blocked' });
  const installer = deps.installEdgeRail ?? ((next: SelfUpdateOptions, injected: SelfUpdateDeps) => runUpdateForInstallation(next, { cliRoot: injected.cliRoot, checkout: injected }));
  // The existing --from dev installer checks entry existence and restores current even when install.sh fails after relinking.
  const installed = await installer({ from: checkout, dev: true, restart: false }, { ...deps, notice: () => {}, out: { log: () => {}, error: () => {} } });
  if (installed.exitCode !== 0) return emit(installed);
  const nextRecord = readInstallRecord(root);
  const nextName = versionDirName(nextRecord?.versionDir);
  let currentLink = '';
  try { currentLink = readlinkSync(join(root, 'current')); } catch { /* no valid installed current */ }
  if (!nextName || !installEntryExists(root, nextName) || nextRecord?.commit !== mainCommit || currentLink !== nextRecord.versionDir) {
    const rolled = record.versionDir && nextRecord?.previous === record.versionDir ? (deps.rollbackEdgeRail ?? rollbackDevInstall)(deps) : null;
    return emit({ ...installed, exitCode: 1, reason: `installed entry/commit not confirmed${rolled?.ok ? '; previous build restored' : '; rollback not confirmed'}` });
  }
  const restarted = await restartEdgeRail(deps, checkout);
  // 설치한 판이 재시작·건강에서 실패해 되돌렸으면 같은 main 을 다시 깔지 않게 표시한다.
  const markRolledBack = (): void => saveEdgeRailState(stateFile, { mainCommit, canary: { seat: 'OP', okRuns: 0, startedAt: input.now.toISOString() }, rolledBack: true });
  if (!restarted) {
    const rolled = record.versionDir && readInstallRecord(root)?.previous === record.versionDir
      ? (deps.rollbackEdgeRail ?? rollbackDevInstall)(deps) : null;
    if (rolled?.ok) markRolledBack();
    return emit({ ...installed, exitCode: 1, restarted: false, reason: `${plan.reason}; restart not confirmed${rolled?.ok ? '; previous build restored' : '; rollback not confirmed'}` });
  }
  const verified = await (deps.verifyRestart ?? defaultVerifyRestart)(mainCommit);
  if (!verified.ok || !verified.daemonSha || !(verified.daemonSha.startsWith(mainCommit) || mainCommit.startsWith(verified.daemonSha))) {
    const rolled = record.versionDir && readInstallRecord(root)?.previous === record.versionDir
      ? (deps.rollbackEdgeRail ?? rollbackDevInstall)(deps) : null;
    if (rolled?.ok) { markRolledBack(); await restartEdgeRail(deps, checkout); }
    return emit({ ...installed, exitCode: 1, restarted: true, reason: `${plan.reason}; restarted build health not confirmed${rolled?.ok ? '; previous build restored' : '; rollback not confirmed'}` });
  }
  if (plan.decision === 'canary-install') {
    const next: EdgeRailState = { mainCommit, canary: { seat: 'OP', okRuns: 0, startedAt: input.now.toISOString() }, ...(options.failureRate ? { failureRate: options.failureRate } : {}) };
    saveEdgeRailState(stateFile, next);
  } else if (state?.mainCommit === mainCommit && plan.decision === 'promote-all') {
    saveEdgeRailState(stateFile, { ...state, promoted: true });
  }
  return emit({ ...installed, restarted: true });
}

/** Route an installed CLI by where it was installed from: a release URL → release installer, a local checkout → git update. */
export async function runUpdateForInstallation(
  options: SelfUpdateOptions = {},
  deps: { cliRoot?: string; exists?: (path: string) => boolean; readText?: (path: string) => string; release?: ReleaseUpdateDeps; checkout?: SelfUpdateDeps } = {},
): Promise<SelfUpdateResult> {
  const cliRoot = resolve(deps.cliRoot ?? resolve(import.meta.dir, '../..'));
  if (options.auto) return runEdgeRailUpdate(options, { cliRoot, ...deps.checkout });
  const exists = deps.exists ?? existsSync;
  const holder = resolve(cliRoot, '..', '..');
  const parent = resolve(holder, '..');
  const installed = basename(parent) === 'versions' && exists(join(resolve(parent, '..'), 'install.json'))
    || basename(holder) === 'current' && exists(join(parent, 'install.json'))
    || exists(join(holder, 'install.json'));
  if (!options.from && installed) {
    // ⛔⭐ 설치본이라고 전부 «릴리스» 설치본이 아니다 — 이 기계의 설치본은 체크아웃에서 깔렸고 `install.json.source` 가 그 경로다
    //   (2026-09-25 실측: `~/.local/share/elanous/install.json` source = pilot 체크아웃). 그것을 릴리스로 보내면 없는 공개판을 받으러 간다.
    //   ⇒ source 가 http(s) 면 릴리스 · 로컬 경로면 그 체크아웃으로 git 갱신 · 못 읽으면 멈춘다(추측하지 않는다).
    const source = readInstallSource(cliRoot, exists, deps.readText);
    if (source && /^https?:\/\/|^file:\/\//.test(source)) {
      return runReleaseUpdate({ version: options.version, restart: options.restart, json: options.json, alert: options.alert, keep: options.keep }, { packageRoot: cliRoot, ...deps.release });
    }
    if (source && options.version === undefined && exists(join(source, 'scripts/install.sh'))) {
      return runSelfUpdate({ ...options, from: source }, { cliRoot, ...deps.checkout });
    }
    const result: SelfUpdateResult = { exitCode: 2, installedVersion: null, decision: null, restarted: false,
      reason: source ? `설치 출처가 릴리스도 체크아웃도 아니다(또는 --version 은 릴리스 설치본 전용): ${source}` : '설치 출처(install.json source)를 못 읽었다 — --from <체크아웃> 으로 지정하라' };
    const out = deps.checkout?.out ?? console;
    out.log(options.json ? JSON.stringify(result) : `self-update: ${result.reason}`);
    return result;
  }
  if (options.dev || options.rollback) {
    return runSelfUpdate(options, { cliRoot, ...deps.checkout });
  }
  if (options.version !== undefined) {
    const result: SelfUpdateResult = { exitCode: 2, installedVersion: null, decision: null, restarted: false, reason: '--version 은 릴리스 설치본에서만 사용 가능' };
    const out = deps.checkout?.out ?? console;
    out.log(options.json ? JSON.stringify(result) : `self-update: ${result.reason}`);
    return result;
  }
  return runSelfUpdate(options, { cliRoot, ...deps.checkout });
}

export async function runSelfUpdate(options: SelfUpdateOptions = {}, deps: SelfUpdateDeps = {}): Promise<SelfUpdateResult> {
  const out = deps.out ?? console;
  const git = deps.git ?? ((cwd, args) => execute('git', args, cwd));
  const run = deps.run ?? execute;
  const checkout = resolve(options.from ?? deps.cliRoot ?? resolve(import.meta.dir, '../..'));
  const sendAlert = deps.alert ?? defaultAlert;
  let alerted = false;
  const alertOnce = (text: string): void => { alerted = true; sendAlert(text); };
  let relayOutcome: RelayUpdateOutcome | undefined;
  let runnerOutcome: RelayUpdateOutcome | undefined;
  let pwaBuild: Pick<SelfUpdateResult, 'pwaBuiltCommit' | 'pwaBuiltAt'> | undefined;
  const emit = (raw: SelfUpdateResult): SelfUpdateResult => {
    const withBuild: SelfUpdateResult = pwaBuild ? { ...raw, ...pwaBuild } : raw;
    const withRelay: SelfUpdateResult = relayOutcome && !withBuild.relay ? { ...withBuild, relay: relayOutcome } : withBuild;
    const result: SelfUpdateResult = runnerOutcome && !withRelay.telegramRunner ? { ...withRelay, telegramRunner: runnerOutcome } : withRelay;
    // ⭐ 셀프힐(되돌림) 로직이라 관측을 logs.db 에 남긴다 — /tmp 로그 한 줄로는 `elanous logs` 가 못 본다.
    //   조회: elanous logs --category self-update --event finished
    try {
      debug.log('self-update', 'finished', {
        exitCode: result.exitCode, installedVersion: result.installedVersion, verdict: result.decision?.verdict ?? null,
        daemonFrom: result.decision?.from ?? null, restarted: result.restarted, health: result.health ?? null,
        rolledBackTo: result.rolledBackTo ?? null, pruned: result.prune?.removed ?? null, pruneSkipped: result.prune?.skipped ?? null,
        relay: result.relay?.verdict ?? null,
        telegramRunner: result.telegramRunner?.verdict ?? null,
        reason: result.reason, checkout,
      });
    } catch { /* 관측 실패가 갱신을 막지 않는다 */ }
    if (options.alert && result.exitCode !== 0 && !alerted) alertOnce(`⛔ elanous self-update 실패(exit ${result.exitCode}): ${result.reason}`);
    if (result.exitCode === 0) {
      const notice = formatUpdateNotice(result);
      if (notice) (deps.notice ?? defaultNotice)(notice);
    }
    if (options.json) out.log(JSON.stringify(result));
    else out.log(`self-update: installed=${result.installedVersion ?? 'none'} decision=${result.decision?.verdict ?? 'unknown'} restarted=${result.restarted} pruned=${result.prune ? (result.prune.skipped ? `skip(${result.prune.skipped})` : result.prune.removed.length) : 'n/a'} reason=${result.reason}`);
    return result;
  };
  const reject = (reason: string): SelfUpdateResult => emit({ exitCode: 2, installedVersion: null, decision: null, restarted: false, reason });
  if (options.rollback) {
    const rolled = rollbackDevInstall(deps);
    if (!rolled.ok) return reject(rolled.reason);
    return emit({
      exitCode: 0, installedVersion: rolled.versionName, decision: null, restarted: false,
      current: `versions/${rolled.versionName}`, previous: rolled.record.previous, channel: rolled.record.channel,
      reason: `rollback: current → ${rolled.versionName}`,
    });
  }
  try {
    if (!existsSync(join(checkout, 'scripts/install.sh'))) return reject(`체크아웃 없음 또는 설치기 없음: ${checkout}`);
    const root = git(checkout, ['rev-parse', '--show-toplevel']);
    if (root.status !== 0 || realpathSync(root.stdout.trim()) !== realpathSync(checkout)) return reject(`git 체크아웃 아님: ${checkout}`);
    const head = git(checkout, ['rev-parse', '--verify', 'HEAD']);
    if (head.status !== 0 || !head.stdout.trim()) return reject(`체크아웃 HEAD 확인 실패: ${checkout}`);
    const dirty = git(checkout, ['diff', '--quiet', 'HEAD', '--']);
    if (dirty.status !== 0) return reject(dirty.status === 1 ? '추적 파일 변경: 체크아웃이 더러움' : `git diff 실패: ${dirty.stderr}`);

    if (options.dev) {
      try {
        const installed = installDevBuild(checkout, head.stdout.trim(), { ...deps, runInstaller: () => run('bash', [join(checkout, 'scripts/install.sh'), '--no-modify-path', ...(deps.installRoot ? ['--prefix', deps.installRoot] : [])], checkout) });
        return emit({
          exitCode: 0,
          installedVersion: installed.versionName,
          decision: null,
          restarted: false,
          current: installed.versionDir,
          channel: 'dev',
          previous: installed.previous || undefined,
          reason: `dev 설치: current → ${installed.versionName}`,
        });
      } catch (error) {
        return emit({ exitCode: 1, installedVersion: null, decision: null, restarted: false, reason: `dev 설치 실패: ${error instanceof Error ? error.message : String(error)}` });
      }
    }

    const silence = { log: (_s: string) => {}, error: (_s: string) => {} };
    let decision: RestartNeededResult;
    try {
      decision = await (deps.decide ?? decideRestartNeeded)({ to: head.stdout.trim(), cwd: checkout, out: silence });
    } catch (error) {
      decision = { exitCode: 2, reason: `판정 실패: ${String(error)}` };
    }
    const depsDirs = options.skipPwaBuild ? [checkout] : [checkout, join(checkout, 'apps/pwa')];
    for (const dir of depsDirs) {
      const started = Date.now();
      let ok = false;
      let tail = '';
      try {
        const installed = run('bun', ['install', '--frozen-lockfile'], dir, { timeout: 15 * 60_000 });
        ok = installed.status === 0;
        tail = (installed.stderr?.trim() || installed.stdout?.trim() || '').split(/\r?\n/).filter((line) => line.trim()).at(-1)?.trim().slice(0, 500) ?? '';
      } catch (error) {
        tail = String(error).split(/\r?\n/).at(-1)?.trim().slice(0, 500) ?? '';
      }
      try { debug.log('self-update', 'deps-install', { dir, ok, ms: Date.now() - started }); }
      catch { /* 관측 실패가 갱신을 막지 않는다 */ }
      if (!ok) return emit({ exitCode: 1, installedVersion: null, decision, restarted: false, reason: `의존 설치 실패: ${tail || '출력 없음'}` });
    }
    if (!options.skipPwaBuild) {
      const commit = head.stdout.trim().slice(0, 12);
      const started = Date.now();
      let ok = false;
      let tail = '';
      try {
        const build = run('bun', ['bin/elanous.mjs', 'nexus', 'build'], checkout, { timeout: 15 * 60_000 });
        ok = build.status === 0;
        tail = (build.stderr?.trim() || build.stdout?.trim() || '').split(/\r?\n/).filter((line) => line.trim()).at(-1)?.trim().slice(0, 500) ?? '';
      } catch (error) {
        tail = String(error).split(/\r?\n/).at(-1)?.trim().slice(0, 500) ?? '';
      }
      const ms = Date.now() - started;
      try {
        debug.log('self-update', 'pwa-build', { ok, commit, ms });
        debug.log('self-update', 'pwa-build-tail', { commit, tail: tail || '출력 없음' });
      } catch { /* 관측 실패가 갱신을 막지 않는다 */ }
      if (!ok) return emit({ exitCode: 1, installedVersion: null, decision, restarted: false, reason: `PWA 빌드 실패: ${tail || '출력 없음'}` });
      pwaBuild = { pwaBuiltCommit: commit, pwaBuiltAt: new Date().toISOString() };
    }
    let install: ReturnType<NonNullable<SelfUpdateDeps['run']>>;
    try {
      install = run('bash', [join(checkout, 'scripts/install.sh'), '--no-modify-path'], checkout);
    } catch (error) {
      return emit({ exitCode: 1, installedVersion: null, decision, restarted: false, reason: `설치 실패: ${String(error)}` });
    }
    if (install.status !== 0) return emit({ exitCode: 1, installedVersion: null, decision, restarted: false, reason: `설치 실패: ${install.stderr}` });
    let installedVersion: string;
    try {
      installedVersion = (deps.installedVersion ?? (() => basename(readlinkSync(join(homedir(), '.local/share/elanous/current')))))();
    } catch (error) {
      return emit({ exitCode: 1, installedVersion: null, decision, restarted: false, reason: `설치판 확인 실패: ${String(error)}` });
    }
    let prune: VersionPruneOutcome;
    try {
      prune = (deps.pruneVersions ?? defaultPruneVersions)({ current: installedVersion, daemonSha: decision.from ?? '', keep: options.keep ?? 3 });
    } catch (error) {
      prune = { removed: [], kept: [], skipped: `정리 실패: ${String(error)}` };
    }
    // T5(2026-09-24): relay 는 넥서스와 «따로» 판정한다 — 종전엔 넥서스만 재시작해 relay 가 옛 판으로 계속 돌았다.
    //   ⚠️ relay 가 도는 커밋을 묻는 길이 없어 «데몬 커밋 → 새 커밋» 구간으로 본다(두 서비스는 같은 설치에서 뜬다).
    const relay = updateRelay(decision, checkout, options.restart === true, deps, git, run);
    relayOutcome = relay;
    try { debug.log('self-update', 'relay', { ...relay, installedVersion }); } catch { /* 관측 실패가 갱신을 막지 않는다 */ }
    runnerOutcome = updateTelegramRunner(decision, options.restart === true, deps, run, checkout);
    try { debug.log('self-update', 'telegram-runner', { ...runnerOutcome, installedVersion }); } catch { /* */ }
    if (runnerOutcome.verdict === 'failed' && options.alert) alertOnce(`⚠️ elanous self-update: 텔레그램 러너 재시작 실패 — ${runnerOutcome.reason}`);
    // ⛔ `build`(PWA 만 바뀜)도 재시작한다 — 이 길은 새 판을 `versions/<새 판>` 에 깔고 `current` 를 옮긴다.
    //    도는 넥서스는 «부팅 때의» 판 디렉터리에서 정적 파일을 서빙하므로, 재시작 없이는 새 PWA 가 영영 안 보인다
    //    (2026-09-28 실측: decision=build · restarted=false 뒤에도 운영이 옛 빌드 id 를 서빙 → kickstart 뒤에야 새 id).
    //    `build = 재빌드만` 은 체크아웃에서 도는 데몬(같은 apps/pwa/out 을 읽는다)의 전제였다.
    const needsRestart = (decision.verdict === 'restart' && decision.exitCode === 11) || (decision.verdict === 'build' && decision.exitCode === 10);
    if (!needsRestart) {
      return emit({ exitCode: 0, installedVersion, decision, restarted: false, prune, relay, reason: decision.exitCode === 2 ? `판정 모름: ${decision.reason ?? '이유 없음'}` : `판정 ${decision.verdict ?? 'unknown'}: 재시작 불필요` });
    }
    if (!options.restart) return emit({ exitCode: 0, installedVersion, decision, restarted: false, prune, reason: '--restart 없음: 재시작하지 않음' });
    const os = deps.os ?? platform();
    const command = os === 'darwin' ? 'launchctl' : os === 'linux' ? 'systemctl' : null;
    if (!command) return emit({ exitCode: 1, installedVersion, decision, restarted: false, prune, reason: `지원하지 않는 플랫폼: ${os}` });
    if (deps.allowLiveRestart === false || (deps.allowLiveRestart !== true && liveRestartBlocked())) {
      return emit({ exitCode: 0, installedVersion, decision, restarted: false, prune, reason: '테스트 가드: 실물 재시작 0' });
    }
    const args = os === 'darwin' ? ['kickstart', '-k', `gui/${deps.uid ?? process.getuid?.() ?? userInfo().uid}/com.elanous.nexus`] : ['--user', 'restart', 'elanous-nexus'];
    try {
      const restarted = run(command, args, checkout);
      if (restarted.status !== 0) return emit({ exitCode: 1, installedVersion, decision, restarted: false, prune, reason: `재시작 실패: ${restarted.stderr}` });
      // 🆕 2026-09-24: 야간 자동(04:33)은 아무도 안 보는 시각이다 — 새 판이 부팅에 실패하면 데몬이 죽은 채 남는다.
      //    ⇒ 건강을 확인하고, 실패하면 데몬이 돌던 판(정리 규칙이 보존)으로 `current` 를 되돌려 다시 띄운다.
      const verify = deps.verifyRestart ?? defaultVerifyRestart;
      const first = await verify(versionCommit(installedVersion) || installedVersion);
      try { debug.log('self-update', 'restart-verified', { installedVersion, ok: first.ok, unmeasured: first.unmeasured ?? false, daemonSha: first.daemonSha ?? null, reason: first.reason ?? null }); } catch { /* */ }
      if (first.ok) return emit({ exitCode: 0, installedVersion, decision, restarted: true, prune, health: 'ok', reason: '재시작 완료 · 건강 확인' });
      const alert = alertOnce;
      if (first.unmeasured) {
        alert(`⚠️ elanous self-update: ${installedVersion} 재시작 뒤 건강을 «잴 수» 없었다(${first.reason ?? '이유 없음'}) — 되돌리지 않음. 확인: elanous nexus show · elanous doctor`);
        return emit({ exitCode: 1, installedVersion, decision, restarted: true, prune, health: 'unmeasured', reason: `재시작 뒤 건강 측정 불가: ${first.reason ?? '이유 없음'} · 되돌리지 않음` });
      }
      const target = rollbackTarget((deps.listVersions ?? (() => readdirSync(VERSIONS_DIR())))(), decision.from ?? '', installedVersion);
      if (!target) {
        alert(`⛔ elanous self-update: ${installedVersion} 재시작 뒤 건강 실패(${first.reason ?? '이유 없음'}) — 되돌릴 판을 못 찾았습니다. 확인: elanous doctor · launchctl print gui/$(id -u)/com.elanous.nexus`);
        return emit({ exitCode: 1, installedVersion, decision, restarted: true, prune, health: 'no-rollback-target', reason: `재시작 뒤 건강 실패: ${first.reason ?? '이유 없음'} · 되돌릴 판 없음` });
      }
      try { debug.log('self-update', 'rollback-start', { installedVersion, target, reason: first.reason ?? null }); } catch { /* */ }
      (deps.relinkCurrent ?? defaultRelinkCurrent)(target);
      const again = run(command, args, checkout);
      const second = again.status === 0 ? await verify(versionCommit(target)) : { ok: false, reason: `재시작 실패: ${again.stderr}` };
      const health = second.ok ? 'rolled-back' as const : 'rollback-failed' as const;
      alert(`${second.ok ? '⚠️' : '⛔'} elanous self-update: ${installedVersion} 가 재시작 뒤 건강 실패(${first.reason ?? '이유 없음'}) → ${target} 로 되돌림 — ${second.ok ? '회복' : `회복 실패(${second.reason ?? ''})`}. 원인 확인 전까지 야간 설치는 같은 판을 다시 깔 수 있다.`);
      return emit({ exitCode: 1, installedVersion, decision, restarted: true, prune, health, rolledBackTo: target, reason: `재시작 뒤 건강 실패: ${first.reason ?? '이유 없음'} → ${target} 로 되돌림(${second.ok ? '회복' : '회복 실패'})` });
    } catch (error) {
      return emit({ exitCode: 1, installedVersion, decision, restarted: false, prune, reason: `재시작 실패: ${String(error)}` });
    }
  } catch (error) {
    return reject(`체크아웃 확인 실패: ${String(error)}`);
  }
}
