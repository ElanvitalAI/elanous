// NEXUS · launchd install (Phase N-5 PR ψ)
//
// `elanous nexus install --launchd`:
//   1. Render plist (XML) with KeepAlive{SuccessfulExit=false} + ThrottleInterval=10
//      so launchd respawns on exit ≠ 0 (which includes the 75 graceful-restart code
//      from PR χ) but stays put after `elanous nexus --stop` (exit 0).
//   2. Write to ~/Library/LaunchAgents/com.elanous.nexus.plist (mode 0o600 —
//      EnvironmentVariables 가 provider API 키를 담으므로 소유자 전용).
//   3. (default) `launchctl bootstrap gui/<uid> <plist>` — load + start.
//      `--no-start` skips the bootstrap call.
//
// `elanous nexus uninstall --launchd`:
//   1. `launchctl bootout gui/<uid>/<label>` (idempotent — bootout failure on
//       missing unit is treated as success).
//   2. Remove the plist file.
//
// `elanous nexus status --launchd` / statusLaunchd():
//   - `launchctl print gui/<uid>/<label>` → parse 'state = ' for running/loaded.
//
// Cross-platform guard: `installLaunchd({ platformOverride: 'linux' })` returns
// `{ outcome: 'not-supported', reason }` so callers + tests don't need a real
// macOS host.

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join as joinPath } from 'node:path';
import { nexusLogsDir } from '../paths.js';
import { runCli as defaultRunCli, type RunCli } from '../config/secrets/cli-helper.js';
import { debug } from '../../debug/log.js';
import { PROVIDER_ENV_SPEC, summarizeAuxiliaryAiEnv, type AuxiliaryAiEnvVar } from '../../setup/llm-env-detect.js';

export const LAUNCHD_LABEL = 'com.elanous.nexus';
export const LAUNCHD_DEFAULT_THROTTLE_SECONDS = 10;

export interface RenderLaunchdPlistOpts {
  label?: string;
  /** ProgramArguments — first element is the executable. */
  command: string[];
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  throttleSeconds?: number;
  env?: Record<string, string>;
}

export function renderLaunchdPlist(opts: RenderLaunchdPlistOpts): string {
  const label = opts.label ?? LAUNCHD_LABEL;
  const throttle = opts.throttleSeconds ?? LAUNCHD_DEFAULT_THROTTLE_SECONDS;
  const args = opts.command.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');
  const envEntries = Object.entries(opts.env ?? {});
  const envBlock = envEntries.length === 0
    ? ''
    : '  <key>EnvironmentVariables</key>\n  <dict>\n' +
      envEntries
        .map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`)
        .join('\n') +
      '\n  </dict>\n';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>${throttle}</integer>
  <key>WorkingDirectory</key>
  <string>${escapeXml(opts.workingDirectory)}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(opts.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(opts.stderrPath)}</string>
${envBlock}</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface LaunchdEnvironment {
  platform: NodeJS.Platform;
  uid: number;
  plistDir: string;
  plistPath: string;
  label: string;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  command: string[];
  bootstrapTarget: string;
  serviceTarget: string;
}

export interface LaunchdOpts {
  platformOverride?: NodeJS.Platform;
  uid?: number;
  label?: string;
  command?: string[];
  workingDirectory?: string;
  plistDir?: string;
  /** Override `nexusLogsDir()`-derived stdout/stderr paths. */
  stdoutPath?: string;
  stderrPath?: string;
  throttleSeconds?: number;
  env?: Record<string, string>;
  /** Skip the launchctl bootstrap call (writes plist only). */
  noStart?: boolean;
  runCli?: RunCli;
  writePlist?: (path: string, body: string) => void;
}

export function resolveLaunchdEnvironment(opts: LaunchdOpts = {}): LaunchdEnvironment {
  const platform = opts.platformOverride ?? process.platform;
  const uid = opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
  const label = opts.label ?? LAUNCHD_LABEL;
  const plistDir = opts.plistDir ?? joinPath(homedir(), 'Library', 'LaunchAgents');
  const plistPath = joinPath(plistDir, `${label}.plist`);
  const command = opts.command ?? defaultCommand();
  const workingDirectory = opts.workingDirectory ?? defaultServiceWorkingDirectory();
  const stdoutPath = opts.stdoutPath ?? joinPath(nexusLogsDir(), 'nexus-stdout.log');
  const stderrPath = opts.stderrPath ?? joinPath(nexusLogsDir(), 'nexus-stderr.log');
  return {
    platform,
    uid,
    plistDir,
    plistPath,
    label,
    workingDirectory,
    stdoutPath,
    stderrPath,
    command,
    bootstrapTarget: `gui/${uid}`,
    serviceTarget: `gui/${uid}/${label}`,
  };
}

/**
 * 서비스의 작업 폴더 기본값.
 * - 체크아웃에서 install → 그 트리(데몬의 git SHA(daemonSha)·상대경로가 정확해진다 · homedir 이면 rev-parse 실패).
 * - **설치본**에서 install → 홈(systemd 와 같다). 설치본의 판은 `install.json` 이 말하므로 트리가 필요 없고,
 *   cwd 를 쓰면 «install 을 친 폴더»가 박힌다 — 🩸 09-26 운영 plist 가 사람 작업 트리(pilot)를 가리켰다(로드맵 09-26 P: pilot 의존 완전 제거).
 */
export function defaultServiceWorkingDirectory(
  script: string | undefined = process.argv[1],
  cwd: string = process.cwd(),
  home: string = homedir(),
): string {
  const installed = !!script && script.includes('/node_modules/elanous/') && /\/(versions\/[^/]+|current)\/node_modules\//.test(script);
  return installed ? home : cwd;
}

function defaultCommand(): string[] {
  return nexusRunCommand();
}

/**
 * 서비스 파일(launchd · systemd)에 박을 `nexus run` 명령.
 * launchd·systemd 는 최소 PATH 로 띄운다 — bare `elanous` 를 못 찾아 exec 가 실패한다(launchd status 78 ·
 * systemd 는 `/usr/bin` 등 고정 경로에서만 찾는다). 그래서 인터프리터(process.execPath) ⊕ 스크립트 절대경로.
 * 🩸 2026-09-24: bun 은 argv[1] 을 «실경로»로 준다 — 설치본이면 `…/versions/<판>/node_modules/elanous/bin/elanous.mjs`.
 *    그 경로를 박으면 야간 설치가 새 판을 깔아도 데몬은 영영 옛 판으로 뜨고, 그 판이 정리되면 못 뜬다.
 *    ⇒ 설치본이면 고정 경로 `…/current/node_modules/elanous/…` 로 바꾼다.
 */
export function nexusRunCommand(
  execPath: string = process.execPath,
  script: string | undefined = process.argv[1],
  exists: (p: string) => boolean = existsSync,
): string[] {
  if (execPath && script) return [execPath, stableInstalledScriptPath(script, exists), 'nexus', 'run'];
  return ['elanous', 'nexus', 'run']; // fallback (테스트/비정상 argv)
}

/** `…/versions/<판>/node_modules/elanous/<rest>` → `…/current/node_modules/elanous/<rest>` (current 가 있을 때만). */
export function stableInstalledScriptPath(script: string, exists: (p: string) => boolean = existsSync): string {
  const m = /^(.*)\/versions\/[^/]+\/(node_modules\/elanous\/.*)$/.exec(script);
  if (!m) return script;
  const stable = `${m[1]}/current/${m[2]}`;
  return exists(stable) ? stable : script;
}

export function providerSecretNames(): string[] {
  // 여러 provider 가 같은 키를 쓴다(예: OPENAI_API_KEY) — 이름은 한 번만.
  return [...new Set(PROVIDER_ENV_SPEC.flatMap((spec) => [spec.primaryKeyEnv, ...(spec.aliasKeyEnvs ?? [])]).filter((n): n is string => Boolean(n)))];
}

function defaultEnv(): Record<string, string> {
  // launchd 최소 PATH 보완 — install 시점의 PATH 를 상속해 데몬 러너가 부르는
  // 도구(bun/git/tailscale/python 등 · adopt 된 크론 스크립트 의존)를 찾게 한다.
  const env: Record<string, string> = { HOME: homedir() };
  if (process.env.PATH) env.PATH = process.env.PATH;
  // ★ provider «비밀이 아닌» 설정(모델·base URL)만 plist 로 스냅샷한다.
  //   ⛔ 2026-09-24 (재시작 최소화 RFC S1) — 키는 더 이상 plist 에 굽지 않는다. 07-22 처방(「launchd 는 셸 env 를
  //   못 봐 데몬이 키 없이 떠 401」)은 이제 데몬 부팅의 `hydrateEnvFromKeyCache`(키 캐시 → env · `#20109`)가 맡고,
  //   install 은 셸에만 있던 키를 키 캐시(600)로 옮긴다(`persistProviderKeysToCache`). 굽던 판의 결손 = 평문 비밀 ⊕
  //   키 회전 뒤 «옛 키» 고정(운영에서 xAI 가 실제로 캐시와 달랐다).
  const secrets = new Set(providerSecretNames());
  for (const spec of PROVIDER_ENV_SPEC) {
    for (const name of [spec.modelEnv, spec.baseUrlEnv]) {
      if (!name || name in env || secrets.has(name)) continue;
      const val = process.env[name]?.trim();
      if (val) env[name] = val;
    }
  }
  return env;
}

export interface KeyCachePersistResult {
  /** 셸 env 에만 있어서 키 캐시에 새로 쓴 이름. */
  written: string[];
  /** 캐시에 이미 있는데 셸 env 와 값이 다른 이름 — 캐시를 덮지 않는다(데몬은 캐시를 쓴다). */
  differs: string[];
}

/** install 시점 셸 env 의 provider 키를 키 캐시(`~/.cache/<소문자 이름>` · 600)로 — 값은 반환·로그하지 않는다. */
export function persistProviderKeysToCache(
  env: NodeJS.ProcessEnv = process.env,
  dir: string = env.ELANOUS_KEY_CACHE_DIR?.trim() || joinPath(homedir(), '.cache'),
): KeyCachePersistResult {
  const written: string[] = [];
  const differs: string[] = [];
  for (const name of providerSecretNames()) {
    const val = env[name]?.trim();
    if (!val) continue;
    const path = joinPath(dir, name.toLowerCase());
    let cached = '';
    try { cached = readFileSync(path, 'utf8').trim().replace(/^["']|["']$/g, ''); } catch { /* 없음 */ }
    if (!cached) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, `${val}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
      written.push(name);
    } else if (cached !== val) {
      differs.push(name);
    }
  }
  return { written, differs };
}

export interface AuxiliaryAiEnvNotice {
  vars: AuxiliaryAiEnvVar[];
}

export function auxiliaryAiEnvNotice(env: NodeJS.ProcessEnv = process.env): AuxiliaryAiEnvNotice | undefined {
  const vars = summarizeAuxiliaryAiEnv(env);
  return vars.length > 0 ? { vars } : undefined;
}

export function renderAuxiliaryAiEnvNotice(notice: AuxiliaryAiEnvNotice): string[] {
  return [
    `         ${notice.vars.length} auxiliary AI key${notice.vars.length === 1 ? '' : 's'} were found in this shell but are not added to the launchd plist, so the daemon cannot access them:`,
    ...notice.vars.map(({ name, usedBy }) => `         ${name} (${usedBy})`),
    '         Review each integration’s supported setup if you want the daemon to use these keys.',
  ];
}

export type InstallOutcome =
  | { outcome: 'installed'; plistPath: string; bootstrapped: boolean; env: LaunchdEnvironment; auxiliaryAiEnvNotice?: AuxiliaryAiEnvNotice; keyCache?: KeyCachePersistResult }
  | { outcome: 'not-supported'; reason: string }
  | { outcome: 'error'; reason: string; plistPath?: string };

export async function installLaunchd(opts: LaunchdOpts = {}): Promise<InstallOutcome> {
  const env = resolveLaunchdEnvironment(opts);
  if (env.platform !== 'darwin') {
    return { outcome: 'not-supported', reason: `launchd install is macOS-only (current: ${env.platform})` };
  }
  const notice = auxiliaryAiEnvNotice();
  // 명시 env 를 준 호출(시험·특수 설치)은 셸 키를 건드리지 않는다.
  const keyCache = opts.env ? undefined : persistProviderKeysToCache();

  const plistBody = renderLaunchdPlist({
    label: env.label,
    command: env.command,
    workingDirectory: env.workingDirectory,
    stdoutPath: env.stdoutPath,
    stderrPath: env.stderrPath,
    ...(opts.throttleSeconds !== undefined ? { throttleSeconds: opts.throttleSeconds } : {}),
    env: opts.env ?? defaultEnv(),
  });

  const writePlist = opts.writePlist ?? defaultWritePlist;
  try {
    writePlist(env.plistPath, plistBody);
    if (debug.enabled) {
      debug.log('nexus.install.launchd.write', env.plistPath, { label: env.label });
    }
  } catch (err) {
    return { outcome: 'error', reason: `failed to write plist: ${(err as Error).message}`, plistPath: env.plistPath };
  }

  if (opts.noStart) {
    return { outcome: 'installed', plistPath: env.plistPath, bootstrapped: false, env, ...(notice ? { auxiliaryAiEnvNotice: notice } : {}), ...(keyCache ? { keyCache } : {}) };
  }

  const cli = opts.runCli ?? defaultRunCli;
  // Idempotent bootstrap: if it's already loaded, bootout first, then bootstrap.
  // launchctl returns non-zero when the unit isn't loaded — silent recovery.
  await cli(['launchctl', 'bootout', env.serviceTarget]).catch(() => undefined);
  // bootout 은 서비스 종료를 비동기로 진행 — 곧바로 bootstrap 하면 아직 로드된
  // 상태와 충돌해 exit 5(Input/output error) 가 난다. 짧게 대기 후 진행(최초
  // install 은 bootout 이 no-op 이라 이 대기가 무해).
  await new Promise((resolve) => setTimeout(resolve, 800));
  const result = await cli(['launchctl', 'bootstrap', env.bootstrapTarget, env.plistPath]);
  if (result.exitCode !== 0) {
    return {
      outcome: 'error',
      reason: `launchctl bootstrap exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
      plistPath: env.plistPath,
    };
  }
  // WORLD-REGISTRY: an elanous installer registers what it bootstrapped (fail-open — never fails the install).
  try { (require('../../resource-ledger/world-register.js') as typeof import('../../resource-ledger/world-register.js')).registerLaunchdQuietly({ label: LAUNCHD_LABEL, plist: env.plistPath, purpose: 'nexus daemon', owner: 'TC' }); } catch { /* fail-open */ }
  return { outcome: 'installed', plistPath: env.plistPath, bootstrapped: true, env, ...(notice ? { auxiliaryAiEnvNotice: notice } : {}), ...(keyCache ? { keyCache } : {}) };
}

export type UninstallOutcome =
  | { outcome: 'uninstalled'; plistPath: string; removedFile: boolean; bootedOut: boolean }
  | { outcome: 'not-supported'; reason: string }
  | { outcome: 'not-installed'; plistPath: string }
  | { outcome: 'error'; reason: string; plistPath?: string };

export async function uninstallLaunchd(opts: LaunchdOpts = {}): Promise<UninstallOutcome> {
  const env = resolveLaunchdEnvironment(opts);
  if (env.platform !== 'darwin') {
    return { outcome: 'not-supported', reason: `launchd install is macOS-only (current: ${env.platform})` };
  }

  const cli = opts.runCli ?? defaultRunCli;
  const bootoutResult = await cli(['launchctl', 'bootout', env.serviceTarget]).catch((err) => ({
    exitCode: 1,
    stdout: '',
    stderr: (err as Error).message,
  }));
  // Bootout exit code 36 = "Unknown service" (not loaded) — treat as success.
  const bootedOut = bootoutResult.exitCode === 0;

  const writePlist = opts.writePlist; // tests can stub remove via this
  let removedFile = false;
  if (existsSync(env.plistPath)) {
    if (writePlist) {
      // tests using writePlist stub get a synthetic remove signal.
      try { unlinkSync(env.plistPath); removedFile = true; } catch { /* ignore */ }
    } else {
      try { unlinkSync(env.plistPath); removedFile = true; } catch (err) {
        return { outcome: 'error', reason: `failed to remove plist: ${(err as Error).message}`, plistPath: env.plistPath };
      }
    }
  } else if (!bootedOut) {
    return { outcome: 'not-installed', plistPath: env.plistPath };
  }

  return { outcome: 'uninstalled', plistPath: env.plistPath, removedFile, bootedOut };
}

export type StatusOutcome =
  | { outcome: 'running'; plistPath: string; loaded: true; pid?: number; raw: string }
  | { outcome: 'loaded'; plistPath: string; loaded: true; raw: string }
  | { outcome: 'not-loaded'; plistPath: string }
  | { outcome: 'not-supported'; reason: string }
  | { outcome: 'error'; reason: string };

export async function statusLaunchd(opts: LaunchdOpts = {}): Promise<StatusOutcome> {
  const env = resolveLaunchdEnvironment(opts);
  if (env.platform !== 'darwin') {
    return { outcome: 'not-supported', reason: `launchd install is macOS-only (current: ${env.platform})` };
  }

  const cli = opts.runCli ?? defaultRunCli;
  const result = await cli(['launchctl', 'print', env.serviceTarget]);
  if (result.exitCode !== 0) {
    return { outcome: 'not-loaded', plistPath: env.plistPath };
  }
  const text = result.stdout || '';
  // launchctl print emits 'state = running' or 'state = not running'.
  const stateMatch = text.match(/state\s*=\s*(\S+)/);
  const pidMatch = text.match(/pid\s*=\s*(\d+)/);
  const state = stateMatch?.[1] ?? '';
  if (state === 'running') {
    const out: StatusOutcome = { outcome: 'running', plistPath: env.plistPath, loaded: true, raw: text };
    if (pidMatch) out.pid = parseInt(pidMatch[1]!, 10);
    return out;
  }
  return { outcome: 'loaded', plistPath: env.plistPath, loaded: true, raw: text };
}

function defaultWritePlist(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // 0o600 (was 0o644·2026-07-22) — EnvironmentVariables 가 이제 provider API 키를
  //   스냅샷하므로 world-readable 금지. 소유자 전용.
  writeFileSync(path, body, { mode: 0o600 });
  // ⚠️ writeFileSync 의 mode 는 **파일 생성 시에만** 적용된다 — 기존 plist(예: 0o644)
  //   덮어쓰기(재설치)에는 mode 가 안 먹어 world-readable 로 남는다. 시크릿(API 키) 노출
  //   방지로 항상 명시 chmod(2026-07-22 재설치 실측 버그 수복).
  try { chmodSync(path, 0o600); } catch { /* fail-soft — 권한 변경 실패는 설치 자체를 막지 않음 */ }
}
