import { nativeBuildEnv, nativeBuildShimDir } from '../native/native-build-env.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { fixPrivateFiles, scanPrivateFiles } from './doctor-private-files.js';
import { checkPythonEnv, runPythonSetup } from './python-cli.js';
import { remediesFor } from './doctor-distro.js';
import { installManagedPython, installStaticTool, linuxArch, staticToolBinDir, STATIC_TOOLS, type StaticToolName } from './doctor-static-tools.js';
import { declaredPythonVersion, PYTHON_MIN_SUPPORTED } from '../python/resolve-python.js';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { checkReadiness, ghVersionAtLeast, serviceSecretEntries, SERVICE_VERSION_FOLDER, type ReadinessDeps, type ReadinessItem } from './doctor-readiness.js';

export interface DoctorFixDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  cacheDir?: string;
  configDir?: string;
  readiness?: ReadinessDeps;
  readdir?: (path: string) => string[];
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  writeFile?: (path: string, text: string, mode?: number) => void;
  appendFile?: (path: string, text: string) => void;
  mkdir?: (path: string) => void;
  lstat?: (path: string) => { mode: number; isFile: () => boolean; isSymbolicLink: () => boolean };
  chmod?: (path: string, mode: number) => void;
  rename?: (from: string, to: string) => void;
  remove?: (path: string) => void;
  temporaryPath?: (backup: string) => string;
  /** Populate an existing empty regular cache without following links. */
  fillEmptyCache?: (path: string, value: string) => boolean;
  /** 키 캐시에서 다룰 파일 이름(소문자 env 이름) — 기본 = `.env.example` 의 자격 이름. 못 얻으면 권한을 하나도 안 바꾼다. */
  keyNames?: readonly string[];
  /** 심볼릭 링크를 끝까지 푼 경로(판 폴더 해석 · 시험 주입). */
  realpath?: (path: string) => string;
  /** 명령 실행(node-pty 재빌드 · 시험 주입). */
  runCommand?: (command: string, args: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => { status: number | null; stderr: string };
  /** 재빌드 뒤 확인 — 그 판 폴더에서 `require('node-pty')` 가 되나(시험 주입). */
  verifyNodePty?: (packageDir: string) => boolean;
  /** 네이티브 빌드 심 폴더(시험 주입 · 기본 = 임시 폴더에 node→bun · node-gyp→최신). */
  shimDir?: () => string;
  /** 폴더 통째 삭제(재빌드 전 node-pty 지우기 · 시험 주입). */
  removeTree?: (path: string) => void;
  /** elanous venv 셋업(`elanous python setup --yes` 와 같은 함수 · 시험 주입) — 반환 = exit code. */
  pythonSetup?: () => number;
  /** 셋업 뒤 다시 잰 python-env 상태(시험 주입). */
  recheckPythonEnv?: () => 'ok' | 'fixable' | 'manual';
  /** node 식 아키(`process.arch`) — 시험 주입. */
  arch?: string;
  /** 정적 도구 설치(시험 주입 · 기본 = doctor-static-tools). */
  installStaticTool?: (name: StaticToolName, dest: string) => { ok: boolean; detail: string };
  /** 관리형 파이썬 설치(시험 주입). */
  installManagedPython?: (minor: string) => { python: string | null; detail: string };
}

export interface DoctorFixItem {
  id: 'private-files' | 'install-path' | 'key-cache-permissions' | 'bun-tmpdir' | 'service-file' | 'service-secrets' | 'node-pty-rebuild' | 'python-env' | 'static-tools' | 'python-managed';
  path: string;
  action: string;
  status: 'fixable' | 'skipped' | 'failed';
  reason?: string;
}

export interface DoctorFixPlan { items: DoctorFixItem[]; manual: ReadinessItem[] }
export interface DoctorFixResult {
  items: (DoctorFixItem & { result: 'fixed' | 'skipped' | 'failed' })[];
  exitCode: number;
}

type IO = Required<Omit<DoctorFixDeps, 'configDir' | 'readiness' | 'keyNames' | 'realpath' | 'runCommand' | 'verifyNodePty' | 'pythonSetup' | 'recheckPythonEnv' | 'shimDir' | 'removeTree' | 'arch' | 'installStaticTool' | 'installManagedPython'>> & { readiness: ReadinessDeps; keyNames: readonly string[] | undefined };
const cachePath = Symbol('cachePath');
type InternalFixItem = DoctorFixItem & { [cachePath]?: string };
const START = '# >>> elanous installer PATH >>>';
const END = '# <<< elanous installer PATH <<<';

function io(deps: DoctorFixDeps): IO {
  return {
    env: deps.env ?? process.env,
    home: deps.home ?? homedir(),
    cacheDir: deps.cacheDir ?? ((deps.env ?? process.env).ELANOUS_KEY_CACHE_DIR?.trim() || join(deps.home ?? homedir(), '.cache')),
    readdir: deps.readdir ?? ((path) => readdirSync(path)),
    readiness: deps.readiness ?? {},
    exists: deps.exists ?? existsSync,
    readFile: deps.readFile ?? ((path) => readFileSync(path, 'utf8')),
    writeFile: deps.writeFile ?? ((path, text, mode) => writeFileSync(path, text, mode === undefined ? undefined : { mode, flag: 'wx' })),
    appendFile: deps.appendFile ?? ((path, text) => appendFileSync(path, text)),
    mkdir: deps.mkdir ?? ((path) => mkdirSync(path, { recursive: true })),
    lstat: deps.lstat ?? lstatSync,
    chmod: deps.chmod ?? chmodSync,
    rename: deps.rename ?? renameSync,
    remove: deps.remove ?? ((path) => rmSync(path, { force: true })),
    temporaryPath: deps.temporaryPath ?? ((backup) => `${backup}.${randomUUID()}.tmp`),
    fillEmptyCache: deps.fillEmptyCache ?? (deps.readFile ? ((path, value) => {
      if (deps.readFile!(path) !== '') return false;
      (deps.chmod ?? chmodSync)(path, 0o600);
      (deps.appendFile ?? ((file, text) => appendFileSync(file, text)))(path, `${value}\n`);
      return true;
    }) : fillEmptyCache),
    keyNames: deps.keyNames ?? defaultKeyNames(),
  };
}

function startupFile(fs: IO): string {
  if (fs.readiness.platform === 'win32') return fs.env.ELANOUS_POWERSHELL_PROFILE || win32.join(fs.env.USERPROFILE || fs.home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
  return fs.env.ELANOUS_SHELL_STARTUP || join(fs.home, fs.env.SHELL?.endsWith('/zsh') ? '.zshrc' : '.bashrc');
}

function pathBlock(prefix: string, platform?: NodeJS.Platform): string {
  if (platform === 'win32') {
    const quoted = win32.join(prefix, 'bin').replace(/'/g, "''");
    return `${START}\n$env:PATH = '${quoted}' + [IO.Path]::PathSeparator + $env:PATH\n${END}`;
  }
  // scripts/install.sh shell_quote uses the POSIX single-quote escape sequence.
  const quoted = `'${join(prefix, 'bin').replace(/'/g, `'"'"'`)}'`;
  return `${START}\nexport PATH=${quoted}:"$PATH"\n${END}`;
}

const TMPDIR_START = '# >>> elanous doctor TMPDIR >>>';
const TMPDIR_END = '# <<< elanous doctor TMPDIR <<<';
/** 로드맵 8번 F4 — 리눅스에서 TMPDIR 를 bun 캐시와 같은 파일시스템(~/tmp-bun)으로(EXDEV · oven-sh/bun#38079). */
const TMPDIR_BLOCK = `${TMPDIR_START}\nmkdir -p "$HOME/tmp-bun" && export TMPDIR="$HOME/tmp-bun"\n${TMPDIR_END}`;

function tmpdirItem(fs: IO): DoctorFixItem | undefined {
  const readiness = checkReadiness(fs.readiness).items.find((item) => item.id === 'bun-tmpdir');
  if (readiness?.status !== 'fixable') return undefined;
  const path = startupFile(fs);
  try {
    if (fs.exists(path)) {
      const stat = fs.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) return { id: 'bun-tmpdir', path, action: TMPDIR_BLOCK, status: 'skipped', reason: 'startup file is not a regular file' };
      const lines = fs.readFile(path).split(/\r?\n/);
      if (lines.includes(TMPDIR_START) || lines.includes(TMPDIR_END)) {
        return { id: 'bun-tmpdir', path, action: TMPDIR_BLOCK, status: 'skipped', reason: 'TMPDIR block already exists; open a new shell' };
      }
    }
    return { id: 'bun-tmpdir', path, action: TMPDIR_BLOCK, status: 'fixable' };
  } catch {
    return { id: 'bun-tmpdir', path, action: TMPDIR_BLOCK, status: 'failed', reason: 'could not inspect startup file' };
  }
}

/** 셸 시작 파일을 (같은 권한으로) 백업한 뒤 블록을 덧붙인다 · 반환 = 덧붙이기 전 내용. */
function backupAndAppend(fs: IO, path: string, block: string, backupSuffix: string): string {
  const old = fs.exists(path) ? fs.readFile(path) : '';
  const mode = fs.exists(path) ? fs.lstat(path).mode & 0o777 : 0o600;
  fs.mkdir(fs.readiness.platform === 'win32' ? win32.dirname(path) : dirname(path));
  const backup = `${path}${backupSuffix}`;
  if (fs.exists(backup)) {
    const backupStat = fs.lstat(backup);
    if (!backupStat.isFile() || backupStat.isSymbolicLink()) throw new Error('unsafe backup');
  }
  const temporary = fs.temporaryPath(backup);
  if (fs.exists(temporary)) throw new Error('temporary backup already exists');
  try {
    fs.writeFile(temporary, old, 0o600);
    fs.chmod(temporary, 0o600);
    if ((fs.lstat(temporary).mode & 0o7777) !== 0o600) throw new Error('temporary backup mode mismatch');
    fs.chmod(temporary, mode);
    fs.rename(temporary, backup);
  } catch (error) {
    fs.remove(temporary);
    throw error;
  }
  if ((fs.lstat(backup).mode & 0o7777) !== mode) throw new Error('backup mode mismatch');
  fs.appendFile(path, `\n${block}\n`);
  return old;
}

function pathItem(fs: IO): DoctorFixItem | undefined {
  const readiness = checkReadiness(fs.readiness).items.find((item) => item.id === 'install-path');
  if (readiness?.status !== 'fixable' || typeof fs.readiness.installPrefix !== 'string') return undefined;
  const path = startupFile(fs);
  const prefix = fs.readiness.installPrefix.trim().replace(/[\\/]+$/, '');
  const block = pathBlock(prefix, fs.readiness.platform);
  try {
    if (fs.exists(path)) {
      const stat = fs.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) return { id: 'install-path', path, action: block, status: 'skipped', reason: 'startup file is not a regular file' };
      const text = fs.readFile(path);
      const lines = text.split(/\r?\n/);
      const start = lines.indexOf(START);
      if (start !== -1) {
        const end = lines.indexOf(END, start + 1);
        const inside = end === -1 ? [] : lines.slice(start + 1, end);
        return { id: 'install-path', path, action: block, status: 'skipped', reason: end === -1
          ? 'incomplete installer PATH block; inspect startup file manually'
          : inside.includes(block.split('\n')[1]!) ? 'installer PATH block already exists; open a new shell'
            : 'PATH block already points to a different installation prefix' };
      }
      if (lines.includes(END)) {
        return { id: 'install-path', path, action: block, status: 'skipped', reason: 'incomplete installer PATH block; inspect startup file manually' };
      }
    }
    return { id: 'install-path', path, action: block, status: 'fixable' };
  } catch {
    return { id: 'install-path', path, action: block, status: 'failed', reason: 'could not inspect startup file' };
  }
}

/** `.env.example` 의 자격 이름(대문자 env) → 키 캐시 파일 이름(소문자). 못 읽으면 undefined(= 아무것도 안 바꾼다). */
function defaultKeyNames(): readonly string[] | undefined {
  try {
    const example = readFileSync(join(resolve(import.meta.dir, '..', '..'), '.env.example'), 'utf8');
    const names = new Set<string>();
    for (const line of example.split('\n')) {
      const match = line.match(/^\s*(?:#\s*)?([A-Z][A-Z0-9_]*)=/);
      if (match) names.add(match[1]!.toLowerCase());
    }
    return names.size ? [...names] : undefined;
  } catch {
    return undefined;
  }
}

function cacheItems(fs: IO): InternalFixItem[] {
  // ⛔ 2026-09-24(리뷰 must-fix): 키 캐시 기본 폴더는 `~/.cache` — 다른 프로그램의 캐시가 같이 산다.
  //   ⇒ 알려진 자격 이름(소문자 env 이름)의 파일만 다룬다. 이름 목록을 못 얻으면 아무것도 안 바꾼다.
  if (!fs.keyNames || fs.keyNames.length === 0) {
    return [{ id: 'key-cache-permissions', path: '(key cache)', action: 'inspect permissions', status: 'failed', reason: 'credential names unknown — nothing changed' }];
  }
  const allowed = new Set(fs.keyNames.map((name) => name.toLowerCase()));
  try {
    if (!fs.exists(fs.cacheDir)) return [];
    const directory = fs.lstat(fs.cacheDir);
    if (directory.isSymbolicLink() || directory.isFile()) {
      return [{ id: 'key-cache-permissions', path: '(key cache)', action: 'inspect permissions', status: 'failed', reason: 'key cache is not a regular directory' }];
    }
  } catch {
    return [{ id: 'key-cache-permissions', path: '(key cache)', action: 'inspect permissions', status: 'failed', reason: 'could not inspect key cache directory' }];
  }
  let names: string[];
  try {
    names = fs.readdir(fs.cacheDir).sort();
  } catch {
    return [{ id: 'key-cache-permissions', path: '(key cache)', action: 'inspect permissions', status: 'failed', reason: 'could not list key cache directory' }];
  }
  return names.flatMap((name): InternalFixItem[] => {
    // Never open credential contents or follow links.
    if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return [];
    if (!allowed.has(name)) return [];   // 자격 파일이 아니면 건드리지 않는다
    const fullPath = join(fs.cacheDir, name);
    try {
      const stat = fs.lstat(fullPath);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o7777) === 0o600) return [];
      return [{ id: 'key-cache-permissions', path: name, [cachePath]: fullPath, action: 'chmod 600', status: 'fixable' }];
    } catch {
      return [{ id: 'key-cache-permissions', path: name, action: 'chmod 600', status: 'failed', reason: 'could not inspect cache file' }];
    }
  });
}

const SERVICE_VERSION_FOLDER_GLOBAL = new RegExp(SERVICE_VERSION_FOLDER.source, 'g');

/** 서비스 파일이 판 폴더를 가리키면 `…/current/node_modules/elanous/` 로 바꾼 본문. 바꿀 대상의 `current` 가 없으면 null. */
export function stableServiceText(text: string, exists: (path: string) => boolean): string | null {
  let missing = false;
  const next = text.replace(SERVICE_VERSION_FOLDER_GLOBAL, (match, offset: number) => {
    // 이 경로 토큰의 앞부분(설치 뿌리) — `<string>`·`=`·공백·따옴표 뒤부터.
    const before = text.slice(0, offset);
    const prefix = before.slice(before.search(/[^<>\s"'=]*$/));
    const stable = `${prefix}/current/node_modules/elanous/`;
    if (!exists(stable)) missing = true;
    return '/current/node_modules/elanous/';
  });
  return missing || next === text ? null : next;
}

function serviceSecretsItem(fs: IO): InternalFixItem | undefined {
  const service = fs.readiness.serviceFile;
  if (!service || serviceSecretEntries(service.text).length === 0) return undefined;
  return { id: 'service-secrets', path: service.path, action: 'move provider keys to private cache and remove only migrated service environment entries (takes effect on the next restart)', status: 'fixable' };
}

function fillEmptyCache(path: string, value: string): boolean {
  const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) return false;
    if (readFileSync(fd, 'utf8') !== '') return false;
    fchmodSync(fd, 0o600);
    // O_APPEND avoids writing over a value created by a concurrent writer.
    const append = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      if (fstatSync(append).size !== 0) return false;
      writeSync(append, `${value}\n`);
    } finally {
      closeSync(append);
    }
    return true;
  } finally {
    closeSync(fd);
  }
}

function migrateServiceSecrets(fs: IO, item: DoctorFixItem): DoctorFixResult['items'][number] {
  const stat = fs.lstat(item.path);
  if (!stat.isFile() || stat.isSymbolicLink()) return { ...item, result: 'failed', reason: 'service file is not a regular file' };
  const text = fs.readFile(item.path);
  const entries = serviceSecretEntries(text);
  if (!entries.length) return { ...item, result: 'skipped', reason: 'service file no longer contains provider keys' };
  const differs = new Set<string>();
  const migrated = new Set<string>();
  for (const { name, value } of entries) {
    const val = value.trim();
    if (!val) { differs.add(name); continue; }
    const path = join(fs.cacheDir, name.toLowerCase());
    if (fs.exists(path)) {
      const cacheStat = fs.lstat(path);
      if (!cacheStat.isFile() || cacheStat.isSymbolicLink()) { differs.add(name); continue; }
    }
    let cached = '';
    if (fs.exists(path)) cached = fs.readFile(path).trim().replace(/^["']|["']$/g, '');
    if (cached && cached !== val) { differs.add(name); continue; }
    if (!cached) {
      if (fs.exists(fs.cacheDir)) {
        const directory = fs.lstat(fs.cacheDir);
        if (directory.isSymbolicLink() || directory.isFile()) { differs.add(name); continue; }
      }
      fs.mkdir(fs.cacheDir);
      if (fs.exists(path)) {
        if (!fs.fillEmptyCache(path, val)) { differs.add(name); continue; }
      } else {
        fs.writeFile(path, `${val}\n`, 0o600);
        fs.chmod(path, 0o600);
      }
    }
    if ((fs.lstat(path).mode & 0o7777) !== 0o600) fs.chmod(path, 0o600);
    if ((fs.lstat(path).mode & 0o7777) !== 0o600 || fs.readFile(path).trim().replace(/^["']|["']$/g, '') !== val) {
      differs.add(name);
      continue;
    }
    migrated.add(name);
  }
  const removed = entries.filter((entry) => migrated.has(entry.name) && !differs.has(entry.name));
  const names = [...differs].sort();
  if (!removed.length) return { ...item, result: 'skipped', reason: `no service entries removed; cache differs or cannot be verified for: ${names.join(', ')}` };
  let next = text;
  for (const entry of removed.sort((a, b) => b.start - a.start)) next = next.slice(0, entry.start) + next.slice(entry.end);
  const firstBackup = `${item.path}.elanous-doctor.bak`;
  let backup = firstBackup;
  if (fs.exists(backup)) {
    backup = `${firstBackup}.${Date.now()}`;
    for (let suffix = 1; fs.exists(backup); suffix++) backup = `${firstBackup}.${Date.now()}.${suffix}`;
  }
  fs.writeFile(backup, text, 0o600);
  const temporary = fs.temporaryPath(item.path);
  fs.writeFile(temporary, next, 0o600);
  fs.chmod(temporary, stat.mode & 0o777);
  fs.rename(temporary, item.path);
  const after = serviceSecretEntries(fs.readFile(item.path));
  const verified = removed.every((entry) => !after.some((remaining) => remaining.name === entry.name));
  return { ...item, result: verified ? 'fixed' : 'failed', reason: verified
    ? `service keys migrated (backup: ${backup}); next service restart applies the change — nothing was restarted${names.length ? `; cache differs for: ${names.join(', ')} (left in service file)` : ''}`
    : 'provider keys remain in service file on recheck' };
}

function serviceItem(fs: IO): InternalFixItem | undefined {
  const service = fs.readiness.serviceFile;
  const readiness = checkReadiness(fs.readiness).items.find((entry) => entry.id === 'service-file');
  if (readiness?.status !== 'fixable' || !service) return undefined;
  const next = stableServiceText(service.text, fs.exists);
  if (next === null) return { id: 'service-file', path: service.path, action: 'point the service at .../current/node_modules/elanous', status: 'skipped', reason: 'the stable current path does not exist — run: elanous nexus install' };
  return { id: 'service-file', path: service.path, action: 'replace .../versions/<ver>/node_modules/elanous/ with .../current/node_modules/elanous/ (takes effect on the next service restart)', status: 'fixable' };
}

/** node-pty 재빌드 계획 — 판 폴더 ⊕ 고정 판 ⊕ (amzn2 면) 컴파일러 환경. 체크아웃에서 돌면(설치본 없음) 계획 없음. */
export function nodePtyRebuildPlan(deps: DoctorFixDeps): { versionDir: string; packageDir: string; spec: string; env: Record<string, string> } | undefined {
  const readiness = deps.readiness ?? {};
  const item = checkReadiness(readiness).items.find((entry) => entry.id === 'node-pty');
  if (item?.status !== 'fixable' || typeof readiness.installPrefix !== 'string') return undefined;
  try {
    const versionDir = (deps.realpath ?? realpathSync)(join(readiness.installPrefix, 'current'));
    const packageDir = join(versionDir, 'node_modules', 'elanous');
    const pkg = JSON.parse((deps.readFile ?? ((path: string) => readFileSync(path, 'utf8')))(join(packageDir, 'package.json'))) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    const version = pkg.optionalDependencies?.['node-pty'] ?? pkg.dependencies?.['node-pty'];
    if (!version) return undefined;
    // RFC #20265 A2 amzn2: node-pty 는 C++20(gcc10) · node-gyp 는 Python 3.8+ 를 요구한다.
    const env: Record<string, string> = readiness.distro === 'amzn2' ? { CC: 'gcc10-gcc', CXX: 'gcc10-g++', PYTHON: 'python3.8' } : {};
    return { versionDir, packageDir, spec: `node-pty@${version}`, env };
  } catch {
    return undefined;
  }
}

/** python-env — fixable(elanous venv 없음·선언 모듈 import 실패)일 때만. 되돌리기 = venv 폴더 삭제. */
function pythonEnvItem(deps: DoctorFixDeps): InternalFixItem | undefined {
  const item = checkReadiness(deps.readiness ?? {}).items.find((entry) => entry.id === 'python-env');
  if (item?.status !== 'fixable') return undefined;
  return { id: 'python-env', path: '~/.local/share/elanous/python/venv', action: 'elanous python setup --yes (venv --system-site-packages ⊕ requirements-python.txt) — undo: remove the venv folder', status: 'fixable' };
}

/** 패키지 관리자에 줄이 «없는» 리눅스 계열에서 빠진 rg·codex — 고정 판 정적 바이너리(sha256 검증)를 elanous bin(PATH)에.
 *  📏 2026-09-25 amazonlinux:2·2023 컨테이너에서 실측(`doctor-static-tools.ts` 머리말). sudo 불필요. */
export function staticToolsNeeded(readiness: ReadinessDeps): StaticToolName[] {
  if (readiness.platform !== 'linux') return [];
  const remedies = remediesFor(readiness.distro ?? 'unknown');
  const tools: StaticToolName[] = [];
  if (readiness.rgOnPath === false && !remedies?.rg) tools.push('rg');
  // node 를 깔 줄이 있으면 codex 는 npm 길(sudo)로 — 없을 때만 정적 바이너리(node 불필요).
  if (readiness.codexOnPath === false && readiness.nodeOnPath === false && !remedies?.node) tools.push('codex');
  // codex 바이너리는 있는데 짝이 없다 — 한 벌로 다시 깐다(elanous bin 이 PATH 앞이라 그쪽이 쓰인다).
  else if (readiness.codexOnPath === true && readiness.codexCodeModeHost === false) tools.push('codex');
  // gh 가 없거나 낡았다(배포판 gh 가 GH_MIN_VERSION 미만) — 고정 판 정적 gh(elanous bin 이 PATH 앞이라 그쪽이 쓰인다).
  if (readiness.ghOnPath === false || (readiness.ghVersion && !ghVersionAtLeast(readiness.ghVersion))) tools.push('gh');
  return tools;
}

function staticToolsItem(deps: DoctorFixDeps, fs: IO): InternalFixItem | undefined {
  const tools = staticToolsNeeded(deps.readiness ?? {});
  if (!tools.length) return undefined;
  const dir = staticToolBinDir(fs.env, fs.home);
  const names = tools.map((t) => `${t} ${STATIC_TOOLS[t].version}`).join(', ');
  if (!linuxArch(deps.arch)) return { id: 'static-tools', path: dir, action: `download ${names}`, status: 'skipped', reason: `unsupported architecture ${deps.arch ?? process.arch}` };
  return { id: 'static-tools', path: dir, action: `download pinned static ${names} (GitHub releases · sha256-verified) into ${dir} — undo: delete ${tools.join(', ')} there`, status: 'fixable' };
}

/** 관리형 파이썬이 필요한가 — 파이썬이 «없고» 배포판 파이썬 줄도 없거나, 있는 파이썬이 하한 미만. */
export function managedPythonNeeded(readiness: ReadinessDeps): boolean {
  if (readiness.platform !== 'linux') return false;
  const py = readiness.pythonEnv;
  if (py?.status !== 'manual') return false;
  if (/older than the minimum/.test(py.evidence)) return true;
  // 파이썬이 없는데 배포판 파이썬 줄이 있으면(debian) 그쪽(--sudo)이 먼저다.
  return /^no python3 found/.test(py.evidence) && !remediesFor(readiness.distro ?? 'unknown')?.pythonBase;
}

function managedPythonMinor(): string {
  const pin = declaredPythonVersion() ?? PYTHON_MIN_SUPPORTED;
  return pin.split('.').slice(0, 2).join('.');
}

function pythonManagedItem(deps: DoctorFixDeps, fs: IO): InternalFixItem | undefined {
  if (!managedPythonNeeded(deps.readiness ?? {})) return undefined;
  const minor = managedPythonMinor();
  const path = '~/.local/share/elanous/python/cpython';
  if (!linuxArch(deps.arch)) return { id: 'python-managed', path, action: `uv python install ${minor}`, status: 'skipped', reason: `unsupported architecture ${deps.arch ?? process.arch}` };
  void fs;
  return { id: 'python-managed', path, action: `uv ${STATIC_TOOLS.uv.version} (static · sha256-verified) → python ${minor} (python-build-standalone) → elanous python setup --yes — undo: remove ${path} and the elanous venv`, status: 'fixable' };
}

function nodePtyItem(deps: DoctorFixDeps): InternalFixItem | undefined {
  const plan = nodePtyRebuildPlan(deps);
  if (!plan) return undefined;
  const envText = Object.entries(plan.env).map(([key, value]) => `${key}=${value} `).join('');
  return { id: 'node-pty-rebuild', path: plan.versionDir, action: `${envText}bun add ${plan.spec} (in ${plan.versionDir}) — then require('node-pty')`, status: 'fixable' };
}

function privateFilesItem(deps: DoctorFixDeps, fs: IO): DoctorFixItem | undefined {
  const configDir = deps.configDir ?? (deps.home ? join(deps.home, '.elanous') : getElanousConfigDir());
  const scan = scanPrivateFiles(configDir, fs);
  if (scan.dirMode === null || (scan.dirMode === 0o700 && scan.loose.length === 0)) return undefined;
  return { id: 'private-files', path: configDir, action: 'chmod directory 700 and restrict private files', status: 'fixable',
    reason: `directory ${scan.dirMode.toString(8)} · files ${scan.loose.length}` };
}

export function planDoctorFixes(deps: DoctorFixDeps = {}): DoctorFixPlan {
  const fs = io(deps);
  const privateFiles = privateFilesItem(deps, fs);
  const path = pathItem(fs);
  const tmpdir = tmpdirItem(fs);
  const service = serviceItem(fs);
  const secrets = serviceSecretsItem(fs);
  const nodePty = nodePtyItem(deps);
  const python = pythonEnvItem(deps);
  const staticTools = staticToolsItem(deps, fs);
  const pythonManaged = pythonManagedItem(deps, fs);
  return {
    items: [...(path ? [path] : []), ...(tmpdir ? [tmpdir] : []), ...(secrets ? [secrets] : []), ...(service ? [service] : []), ...(nodePty ? [nodePty] : []), ...(staticTools ? [staticTools] : []), ...(pythonManaged ? [pythonManaged] : []), ...(python ? [python] : []), ...cacheItems(fs), ...(privateFiles ? [privateFiles] : [])],
    manual: checkReadiness(fs.readiness).items.filter((item) => item.status === 'manual'),
  };
}

function defaultVerifyNodePty(packageDir: string): boolean {
  const r = spawnSync(process.execPath, ['-e', "require('node-pty')"], { cwd: packageDir, encoding: 'utf8', timeout: 30_000 });
  return r.status === 0;
}

export function applyDoctorFixes(deps: DoctorFixDeps = {}, yes = false): DoctorFixResult {
  const fs = io(deps);
  const plan = planDoctorFixes(deps);
  if (!yes) return {
    items: plan.items.map((item) => ({ ...item, result: item.status === 'failed' ? 'failed' : 'skipped', reason: item.reason ?? 'requires --yes' })),
    exitCode: plan.items.some((item) => item.status === 'failed') ? 1 : 0,
  };
  const items: DoctorFixResult['items'] = [];
  for (const item of plan.items) {
    if (item.status !== 'fixable') {
      items.push({ ...item, result: item.status === 'failed' ? 'failed' : 'skipped' });
      continue;
    }
    try {
      if (item.id === 'private-files') {
        const scan = scanPrivateFiles(item.path, fs);
        if (scan.dirMode === null || (scan.dirMode === 0o700 && !scan.loose.length)) {
          items.push({ ...item, result: 'skipped', reason: 'permissions already private' });
          continue;
        }
        fixPrivateFiles(scan, fs);
        const after = scanPrivateFiles(item.path, fs);
        const repaired = after.dirMode === 0o700 && after.loose.length === 0;
        items.push({ ...item, result: repaired ? 'fixed' : 'failed', reason: repaired ? 'permissions restricted' : 'permissions remain loose' });
      } else if (item.id === 'install-path') {
        // Reinspect immediately before writing; a competing installer may have changed it.
        const current = pathItem(fs);
        if (current?.status !== 'fixable') {
          items.push({ ...item, result: current?.status === 'failed' ? 'failed' : 'skipped', reason: current?.reason ?? 'PATH state changed' });
          continue;
        }
        const old = backupAndAppend(fs, item.path, item.action, '.elanous-doctor.bak');
        const after = fs.readFile(item.path);
        // A startup-file edit only becomes active in a new shell: recheck the
        // persisted block, not the unchanged PATH of this doctor process.
        const verified = after === `${old}\n${item.action}\n` &&
          pathItem(fs)?.reason === 'installer PATH block already exists; open a new shell';
        const currentReadiness = checkReadiness(fs.readiness).items.find((entry) => entry.id === 'install-path');
        items.push({ ...item, result: verified ? 'fixed' : 'failed', reason: verified
          ? `startup file repaired; current process readiness is ${currentReadiness?.status ?? 'unknown'} until a new shell loads it`
          : 'PATH block was not present on recheck' });
      } else if (item.id === 'bun-tmpdir') {
        const current = tmpdirItem(fs);
        if (current?.status !== 'fixable') {
          items.push({ ...item, result: current?.status === 'failed' ? 'failed' : 'skipped', reason: current?.reason ?? 'TMPDIR state changed' });
          continue;
        }
        // 백업 이름을 PATH 와 다르게 — 한 번에 둘을 고치면 원본 백업이 덮이지 않게.
        const old = backupAndAppend(fs, item.path, item.action, '.elanous-doctor-tmpdir.bak');
        const verified = fs.readFile(item.path) === `${old}\n${item.action}\n` && tmpdirItem(fs)?.status === 'skipped';
        items.push({ ...item, result: verified ? 'fixed' : 'failed', reason: verified
          ? 'startup file repaired; open a new shell, then re-run the install so bun sees the new TMPDIR'
          : 'TMPDIR block was not present on recheck' });
      } else if (item.id === 'python-env') {
        const code = (deps.pythonSetup ?? (() => runPythonSetup({ yes: true }, { out: { log: () => {}, error: () => {} } })))();
        const after = (deps.recheckPythonEnv ?? (() => checkPythonEnv(false).status))();
        items.push({ ...item, result: code === 0 && after === 'ok' ? 'fixed' : 'failed', reason: code === 0 && after === 'ok'
          ? 'elanous venv ready — required modules import'
          : `elanous python setup exit ${code} · python-env ${after} after setup` });
      } else if (item.id === 'node-pty-rebuild') {
        const plan = nodePtyRebuildPlan(deps);
        if (!plan) {
          items.push({ ...item, result: 'skipped', reason: 'node-pty no longer needs a rebuild, or the installed copy is gone' });
          continue;
        }
        const runCommand = deps.runCommand ?? ((command, args, opts) => {
          const r = spawnSync(command, [...args], { cwd: opts.cwd, env: opts.env, encoding: 'utf8', timeout: 600_000 });
          return { status: r.status, stderr: r.stderr ?? '' };
        });
        // 🩸 09-24 빈 VM: 이미 깔린(잘못 빌드된) node-pty 에는 `bun add` 가 «아무것도 안 한다» — 먼저 지운다.
        //    그리고 빌드는 심(node=bun · node-gyp=최신)으로 — apt node 가 있는 기계에서 빌드가 bun 과 안 맞았다.
        (deps.removeTree ?? ((path: string) => rmSync(path, { recursive: true, force: true })))(join(plan.versionDir, 'node_modules', 'node-pty'));
        const shim = (deps.shimDir ?? (() => nativeBuildShimDir()))();
        const ran = runCommand('bun', ['add', plan.spec], { cwd: plan.versionDir, env: nativeBuildEnv({ ...fs.env, ...plan.env }, shim) });
        const verified = ran.status === 0 && (deps.verifyNodePty ?? defaultVerifyNodePty)(plan.packageDir);
        items.push({ ...item, result: verified ? 'fixed' : 'failed', reason: verified
          ? 'node-pty rebuilt and loads'
          : ran.status === 0 ? 'bun add finished but node-pty still does not load' : `bun add failed: ${ran.stderr.trim().split('\n').at(-1) ?? ran.status}` });
      } else if (item.id === 'static-tools') {
        const arch = linuxArch(deps.arch)!;
        // codex 는 짝(`codex-code-mode-host`)과 «한 벌»이다 — 없으면 셸 도구가 못 뜬다(2026-09-25 L2 실측).
        const outcomes = staticToolsNeeded(deps.readiness ?? {})
          .flatMap((tool): StaticToolName[] => (tool === 'codex' ? ['codex', 'codex-code-mode-host'] : [tool]))
          .map((tool) => (deps.installStaticTool ?? ((name, to) => installStaticTool(name, arch, to)))(tool, join(item.path, tool)));
        const ok = outcomes.length > 0 && outcomes.every((o) => o.ok);
        items.push({ ...item, result: ok ? 'fixed' : 'failed', reason: outcomes.map((o) => o.detail).join(' · ') || 'nothing to install' });
      } else if (item.id === 'python-managed') {
        const got = (deps.installManagedPython ?? ((minor) => installManagedPython(minor, { env: fs.env, home: fs.home })))(managedPythonMinor());
        if (!got.python) { items.push({ ...item, result: 'failed', reason: got.detail }); continue; }
        const code = (deps.pythonSetup ?? (() => runPythonSetup({ yes: true }, { out: { log: () => {}, error: () => {} } })))();
        const after = (deps.recheckPythonEnv ?? (() => checkPythonEnv(false).status))();
        items.push({ ...item, result: code === 0 && after === 'ok' ? 'fixed' : 'failed', reason: code === 0 && after === 'ok'
          ? `${got.detail} · elanous venv ready — required modules import`
          : `${got.detail} · elanous python setup exit ${code} · python-env ${after} after setup` });
      } else if (item.id === 'service-secrets') {
        items.push(migrateServiceSecrets(fs, item));
      } else if (item.id === 'service-file') {
        // Reread right before writing — the service file may have been reinstalled meanwhile.
        const text = fs.readFile(item.path);
        const next = stableServiceText(text, fs.exists);
        if (next === null) {
          items.push({ ...item, result: 'skipped', reason: 'service file no longer points at a version folder, or current is missing' });
          continue;
        }
        const firstBackup = `${item.path}.elanous-doctor.bak`;
        const backup = fs.exists(firstBackup) ? `${firstBackup}.${Date.now()}` : firstBackup;
        fs.writeFile(backup, text, 0o600);
        const temporary = fs.temporaryPath(item.path);
        fs.writeFile(temporary, next, 0o644);
        fs.rename(temporary, item.path);
        const verified = !SERVICE_VERSION_FOLDER.test(fs.readFile(item.path));
        items.push({ ...item, result: verified ? 'fixed' : 'failed', reason: verified
          ? `service file now uses the stable current path (backup: ${backup}); it takes effect on the next service restart — nothing was restarted`
          : 'service file still points at a version folder on recheck' });
      } else {
        const fullPath = (item as InternalFixItem)[cachePath];
        if (!fullPath) throw new Error('cache path unavailable');
        const stat = fs.lstat(fullPath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          items.push({ ...item, result: 'skipped', reason: 'cache entry is not a regular file' });
          continue;
        }
        if ((stat.mode & 0o7777) === 0o600) {
          items.push({ ...item, result: 'skipped', reason: 'permissions are already 600' });
          continue;
        }
        fs.chmod(fullPath, 0o600);
        const repaired = (fs.lstat(fullPath).mode & 0o7777) === 0o600;
        items.push({ ...item, result: repaired ? 'fixed' : 'failed', reason: repaired ? 'permissions are 600' : 'permissions remain different from 600' });
      }
    } catch {
      items.push({ ...item, result: 'failed', reason: item.id === 'key-cache-permissions' ? 'could not chmod or recheck cache file' : item.id === 'service-secrets' ? 'could not migrate cache or back up, write or recheck service file' : item.id === 'private-files' ? 'could not chmod or recheck private files' : 'could not back up, write or recheck startup file' });
    }
  }
  return { items, exitCode: items.some((item) => item.result === 'failed') ? 1 : 0 };
}

/**
 * P5 `--fix --yes --sudo`(RFC #20265 · 대표 결정 2026-09-24): «사람 한 줄» 중 `sudo ` 로 시작하는 설치 명령만 대신 친다.
 * ⛔ 암호 없는 sudo(`sudo -n true` 가 0)인 기계에서만 — 대화형 암호가 필요하면 아무것도 안 한다.
 * ⛔ 우리가 만든 처방(계열별 표)만 — 같은 명령은 한 번만 · 한 명령 실패가 다른 명령을 막지 않는다.
 */
export interface SudoFixResult {
  readonly sudoAvailable: boolean;
  readonly runs: Array<{ command: string; result: 'ran' | 'failed' | 'skipped'; detail?: string }>;
  readonly exitCode: number;
}

export function sudoFixCommands(manual: readonly ReadinessItem[]): string[] {
  // ⛔ pyenv 는 sudo 로 깔 수 없다 — `pyenv install` 이 든 처방은 사람 몫(🩸 2026-09-25 amazonlinux:2023 컨테이너에서 셸로 쳐 죽었다).
  // ⛔ 설명문이 섞인 처방(` — ` 로 안내가 이어지는 줄)은 명령이 아니다 — 셸로 치면 문법 오류로 죽는다(2026-09-25 컨테이너 실측).
  return [...new Set(manual.map((item) => item.remedy?.trim() ?? '').filter((remedy) => remedy.startsWith('sudo ') && !remedy.includes(' — ') && !remedy.includes('pyenv install')))];
}

export function applySudoFixes(
  manual: readonly ReadinessItem[],
  deps: { run?: (command: string, args: readonly string[]) => { status: number | null; stderr: string } } = {},
): SudoFixResult {
  const run = deps.run ?? ((command, args) => {
    const r = spawnSync(command, [...args], { encoding: 'utf8', timeout: 1_800_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: r.status, stderr: r.stderr ?? '' };
  });
  const probe = run('sudo', ['-n', 'true']);
  if (probe.status !== 0) return { sudoAvailable: false, runs: [], exitCode: 1 };
  const runs = sudoFixCommands(manual).map((command) => {
    // 치기 «전»에 셸에게 «명령인가»를 묻는다 — 문자열 모양으로 거르는 위 가드는 설명문 하나를 놓쳤다
    // (🩸 09-25 GCP debian-12: `… && reinstall elanous (the package must ship …)` → `Syntax error: "(" unexpected` · rc 1).
    const syntax = run('sh', ['-n', '-c', command]);
    if (syntax.status !== 0) return { command, result: 'skipped' as const, detail: 'not a shell command — read it and run the parts by hand' };
    const r = run('sh', ['-c', command]);
    return r.status === 0
      ? { command, result: 'ran' as const }
      : { command, result: 'failed' as const, detail: r.stderr.trim().split('\n').at(-1) ?? String(r.status) };
  });
  return { sudoAvailable: true, runs, exitCode: runs.some((entry) => entry.result === 'failed') ? 1 : 0 };
}

/**
 * D5 `--fix --yes --restart`(RFC doctor-fix · «확인 받고»): 서비스가 «다른 판»으로 돌 때(service-version manual)만
 * 넥서스를 재시작하고 새 `daemonSha` 가 이 코드의 커밋인지 다시 잰다.
 * ⛔ 설치본에서 도는 doctor 만 — 체크아웃이면 재시작해도 설치본 코드가 뜬다(`elanous self-update --restart` 의 몫).
 * ⛔ 재시작은 봇·PTY·진행 중 턴을 끊는다 — 그래서 `--yes` 와 «별개의» 플래그다.
 */
export interface ServiceRestartResult {
  readonly result: 'restarted' | 'skipped' | 'failed';
  readonly reason: string;
  readonly daemonSha?: string;
}

export interface ServiceRestartDeps {
  readiness: ReadinessDeps;
  run?: (command: string, args: readonly string[]) => { status: number | null; stderr: string };
  verify?: (expectedCommit: string) => Promise<{ ok: boolean; daemonSha?: string; reason?: string; unmeasured?: boolean }>;
  uid?: number;
}

export async function applyServiceRestart(deps: ServiceRestartDeps): Promise<ServiceRestartResult> {
  const version = checkReadiness(deps.readiness).items.find((entry) => entry.id === 'service-version');
  if (!version || version.status === 'unknown') return { result: 'skipped', reason: `service version was not measured${version ? ` (${version.evidence})` : ''}` };
  if (version.status === 'ok') return { result: 'skipped', reason: 'the service already runs this code' };
  const prefix = deps.readiness.installPrefix;
  if (typeof prefix !== 'string' || !prefix) {
    return { result: 'skipped', reason: 'doctor runs from a checkout — a restart would load the installed copy, not this code; use `elanous self-update --restart`' };
  }
  const expected = (deps.readiness.codeRevision ?? '').trim();
  const platform = deps.readiness.platform;
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const command = platform === 'darwin'
    ? { cmd: 'launchctl', args: ['kickstart', '-k', `gui/${uid}/com.elanous.nexus`] }
    : platform === 'linux' ? { cmd: 'systemctl', args: ['--user', 'restart', 'elanous-nexus'] } : undefined;
  if (!command) return { result: 'skipped', reason: `no service restart known for platform ${platform ?? 'unmeasured'}` };
  const run = deps.run ?? ((cmd, args) => {
    const r = spawnSync(cmd, [...args], { encoding: 'utf8', timeout: 60_000 });
    return { status: r.status, stderr: r.stderr ?? '' };
  });
  const ran = run(command.cmd, command.args);
  if (ran.status !== 0) return { result: 'failed', reason: `${command.cmd} ${command.args.join(' ')} exited ${ran.status}: ${ran.stderr.trim().split('\n').at(-1) ?? ''}` };
  const verify = deps.verify ?? (async (commit: string) => (await import('./self-update.js')).defaultVerifyRestart(commit));
  const checked = await verify(expected);
  if (checked.ok) return { result: 'restarted', reason: `daemonSha ${checked.daemonSha ?? '?'} now matches this code`, ...(checked.daemonSha ? { daemonSha: checked.daemonSha } : {}) };
  return { result: 'failed', reason: `restarted, but ${checked.unmeasured ? 'the new daemon could not be measured' : 'the new daemon does not run this code'}: ${checked.reason ?? 'unknown'}` };
}

