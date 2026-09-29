// elanous 가 쓰는 파이썬을 «한 곳»에서 정한다 — RFC-doctor-fix-build-toolchain-and-python-by-distro-2026-09-24 A5 (대표 결정: 표준 = elanous 소유 venv).
// 🩸 종전: `~/.pyenv/versions/3.12.12/bin/python3` 하드코딩 5곳 · bare `python3` · 크론 PATH 에 pyenv shims 끼우기 — 필요 패키지 선언 0곳.
// 해석 순서(셸판 scripts/lib/resolve-python.sh 와 «같은» 순서):
//   ① ELANOUS_PYTHON  ② elanous venv(~/.local/share/elanous/python/venv)  ③ pyenv 의 .python-version 판  ④ PATH 의 python3
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve, win32 } from 'node:path';
import { spawnSync } from 'node:child_process';

export type PythonSource = 'env' | 'elanous-venv' | 'pyenv' | 'managed' | 'path';
export interface PythonResolution { path: string; source: PythonSource }

export interface PythonDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (p: string) => boolean;
  repoRoot?: string;
  /** 선언 판(.python-version) — 시험 주입용. null = 선언 없음. */
  declared?: string | null;
  /** 폴더 목록(관리형 파이썬 후보 · 시험 주입). */
  readdir?: (p: string) => string[];
  platform?: NodeJS.Platform;
  /** uv python find probe (injected for Windows tests). */
  runUv?: (version: string) => { status: number | null; stdout: string };
  /** Check the uv result's actual interpreter version. */
  probeUv?: (python: string) => PythonProbe;
  /** Check a Windows PATH interpreter before preferring it to uv. */
  probePath?: (python: string) => PythonProbe;
}

export const REPO_ROOT = resolve(import.meta.dir, '..', '..');

/** 설치물 영역(상태 폴더 ~/.elanous 가 «아니다» — 도구 체인이고 판 정리와 무관). */
export function elanousVenvDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const path = process.platform === 'win32' || /^[a-z]:[\\/]/i.test(home) ? win32 : { join };
  const data = env.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share');
  return path.join(data, 'elanous', 'python', 'venv');
}

/** uv 로 받은 «관리형» 파이썬 뿌리(`doctor --fix` 의 python-managed · 2026-09-25) — 배포판 파이썬이 없거나 하한 미만인 기계용. */
export function managedPythonRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const data = env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share');
  return join(data, 'elanous', 'python', 'cpython');
}

/** 관리형 파이썬 후보 — `cpython-<ver>-…` 폴더들 중 가장 새 판(이름 역순)의 `bin/python3`. */
export function managedPythonCandidate(root: string, readdir: (p: string) => string[], exists: (p: string) => boolean): string | null {
  let names: string[];
  try { names = readdir(root); } catch { return null; }
  const versionOf = (n: string) => (n.match(/^cpython-(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
  const sorted = names.filter((n) => /^cpython-\d+\.\d+\.\d+/.test(n)).sort((a, b) => {
    const [x, y] = [versionOf(a), versionOf(b)];
    for (let i = 0; i < 3; i++) if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  });
  for (const name of sorted) {
    const candidate = join(root, name, 'bin', 'python3');
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function declaredPythonVersion(repoRoot: string = REPO_ROOT, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): string | null {
  try {
    const v = read(join(repoRoot, '.python-version')).split('\n')[0]?.trim() ?? '';
    return /^\d+\.\d+(\.\d+)?$/.test(v) ? v : null;
  } catch { return null; }
}

export function resolvePython(deps: PythonDeps = {}): PythonResolution | null {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const exists = deps.exists ?? existsSync;
  const windows = (deps.platform ?? process.platform) === 'win32';
  const usable = (p: string) => !(windows && /[\\/]WindowsApps[\\/]/i.test(p)) && exists(p);
  const explicit = env.ELANOUS_PYTHON?.trim();
  if (explicit && usable(explicit)) return { path: explicit, source: 'env' };
  const venv = windows ? win32.join(elanousVenvDir(env, home), 'Scripts', 'python.exe') : join(elanousVenvDir(env, home), 'bin', 'python');
  if (usable(venv)) return { path: venv, source: 'elanous-venv' };
  const version = deps.declared !== undefined ? deps.declared : declaredPythonVersion(deps.repoRoot ?? REPO_ROOT);
  if (version && !windows) {
    const pyenv = join(env.PYENV_ROOT?.trim() || join(home, '.pyenv'), 'versions', version, 'bin', 'python3');
    if (exists(pyenv)) return { path: pyenv, source: 'pyenv' };
  }
  // 관리형(uv) 파이썬 — PATH 의 배포판 파이썬(하한 미만일 수 있다)보다 먼저 본다.
  if (!windows) {
    const managed = managedPythonCandidate(managedPythonRoot(env, home), deps.readdir ?? ((p) => readdirSync(p)), exists);
    if (managed) return { path: managed, source: 'managed' };
  }
  for (const dir of (env.PATH ?? '').split(windows ? ';' : delimiter).filter(Boolean)) {
    const candidate = windows ? win32.join(dir, 'python.exe') : join(dir, 'python3');
    if (!usable(candidate)) continue;
    if (windows) {
      const probe = (deps.probePath ?? ((python) => probePython(python, [])))(candidate);
      if (!probe.version || !versionAtLeast(probe.version, PYTHON_MIN_SUPPORTED)) continue;
    }
    return { path: candidate, source: 'path' };
  }
  if (windows) {
    const runUv = deps.runUv ?? ((floor: string) => {
      const r = spawnSync('uv', ['python', 'find', floor], { encoding: 'utf8', timeout: 10_000 });
      return { status: r.status, stdout: r.stdout ?? '' };
    });
    try {
      const found = runUv(`>=${PYTHON_MIN_SUPPORTED}`);
      const candidate = found.stdout.trim();
      if (found.status === 0 && /^[a-z]:[\\/]/i.test(candidate) && /[\\/]python\.exe$/i.test(candidate) && usable(candidate)) {
        const probe = (deps.probeUv ?? ((python) => probePython(python, [])))(candidate);
        if (probe.version && versionAtLeast(probe.version, PYTHON_MIN_SUPPORTED)) return { path: candidate, source: 'managed' };
      }
    } catch { return null; }
  }
  return null;
}

/** requirements 파일 → [{pip, module}] — `# import: <모듈>` 주석이 모듈 이름의 정본. */
export function parseRequirements(text: string): Array<{ pip: string; module: string }> {
  return text.split('\n').flatMap((line) => {
    const body = line.split('#')[0]!.trim();
    if (!body) return [];
    const pip = body.split(/[<>=!~ ]/)[0]!;
    const module = /#\s*import:\s*([A-Za-z0-9_.]+)/.exec(line)?.[1] ?? pip.replace(/-/g, '_');
    return [{ pip, module }];
  });
}

export interface PythonProbe { version: [number, number, number] | null; missing: string[]; error?: string; hasPip?: boolean; hasEnsurepip?: boolean }

/** 그 파이썬으로 «실제로» 버전과 모듈 설치 여부를 잰다(추측하지 않는다).
 *  ⚠️ import 가 아니라 `find_spec` — pandas·yfinance 를 실제로 불러오면 doctor 한 번에 수 초가 든다(09-24 실측: doctor 시험 5초 초과). */
export function probePython(python: string, modules: readonly string[], run = spawnSync): PythonProbe {
  const code = `import importlib.util,json,sys\nm=[]\nfor n in ${JSON.stringify([...modules])}:\n  try:\n    if importlib.util.find_spec(n) is None: m.append(n)\n  except Exception: m.append(n)\nhas=lambda n: importlib.util.find_spec(n) is not None\nprint(json.dumps({"v":list(sys.version_info[:3]),"m":m,"pip":has("pip"),"ensurepip":has("ensurepip")}))`;
  const r = run(python, ['-c', code], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) return { version: null, missing: [...modules], error: (r.stderr || r.error?.message || `exit ${r.status}`).toString().slice(0, 300) };
  try {
    const parsed = JSON.parse(String(r.stdout).trim().split('\n').at(-1) ?? '{}') as { v: [number, number, number]; m: string[]; pip?: boolean; ensurepip?: boolean };
    return { version: parsed.v, missing: parsed.m, ...(parsed.pip !== undefined ? { hasPip: parsed.pip } : {}), ...(parsed.ensurepip !== undefined ? { hasEnsurepip: parsed.ensurepip } : {}) };
  } catch (error) {
    return { version: null, missing: [...modules], error: String(error) };
  }
}

export type PythonEnvStatus = 'ok' | 'fixable' | 'manual';
export interface PythonEnvCheck { status: PythonEnvStatus; evidence: string; remedy?: string; resolution: PythonResolution | null }

/** 파이썬 «최소 요구» (major.minor). `.python-version` 은 개발 기기 pyenv 고정판(정확한 판)이고, 이것은 «돌 수 있는 하한»이다.
 *  📏 2026-09-25 debian:12(Python 3.11.2) 컨테이너: 저장소 .py 52개가 3.11 로 전부 컴파일 · requirements(필수·선택) 9개 설치·import 성공.
 *  ⇒ 배포판 기본 파이썬이 3.11 인 기계(debian 12)가 pyenv 빌드 없이 선다. 올리려면 그 실측을 다시 하고 올린다. */
export const PYTHON_MIN_SUPPORTED = '3.11';

/** Windows remedy for an unusable interpreter, keyed by WHERE it was picked from — installing a newer python does
 *  not help while an explicit setting or an old venv keeps winning the resolution order. */
export function windowsPythonRemedy(source: PythonSource): string {
  if (source === 'env') {
    // ELANOUS_PYTHON is explicit and wins over every other candidate — point it at a supported interpreter (or clear it).
    return "uv python install 3.12; if ($LASTEXITCODE -eq 0) { $py = (uv python find 3.12); [Environment]::SetEnvironmentVariable('ELANOUS_PYTHON', $py, 'User'); $env:ELANOUS_PYTHON = $py; elanous python setup --yes }";
  }
  if (source === 'elanous-venv') return 'uv python install 3.12; if ($LASTEXITCODE -eq 0) { elanous python setup --yes }';
  return 'uv python install 3.12';
}

export function versionAtLeast(have: readonly number[], want: string): boolean {
  const [wm = 0, wn = 0] = want.split('.').map(Number);
  return have[0]! > wm || (have[0] === wm && have[1]! >= wn);
}

/** A Windows venv made with an obsolete interpreter must be rebuilt, even if pip works. */
export function venvNeedsRecreation(probe: PythonProbe, platform: NodeJS.Platform = process.platform): boolean {
  return probe.hasPip !== true || (platform === 'win32' && (!probe.version || !versionAtLeast(probe.version, PYTHON_MIN_SUPPORTED)));
}

/** 준비 항목 `python-env` 의 판정(순수 — 탐침 결과를 받는다). */
export function evaluatePythonEnv(input: {
  resolution: PythonResolution | null;
  declared: string | null;
  probe: PythonProbe | null;
  venvExists: boolean;
  /** 선언 파일(requirements-python.txt)을 읽었나 — 못 읽으면 «모듈 0개»가 거짓 ok 가 된다(09-24 빈 VM 실측: 설치본에 안 실렸다). */
  declarationsFound?: boolean;
  /** venv 기반 파이썬이 venv ⊕ pip 를 만들 수 있나(ensurepip). */
  baseHasEnsurepip?: boolean;
  /** 계열별 venv 한 줄(예: sudo apt-get install -y python3-venv). */
  venvRemedy?: string;
  platform?: NodeJS.Platform;
}): PythonEnvCheck {
  const { resolution, declared, probe, venvExists } = input;
  if (input.declarationsFound === false) return { status: 'manual', evidence: 'requirements-python.txt was not found next to this elanous — the install is missing its python declarations', remedy: 'elanous self-update (this release shipped without requirements-python.txt — 0.1.0 did)', resolution };
  if (input.baseHasEnsurepip === false && (!venvExists || probe?.hasPip === false)) {
    return { status: 'manual', evidence: 'the base python cannot create a venv with pip (ensurepip missing)', ...(input.venvRemedy ? { remedy: `${input.venvRemedy} && elanous python setup --yes` } : { remedy: 'install the venv/ensurepip package for your python, then: elanous python setup --yes' }), resolution };
  }
  // 하한(floor)으로 판정하고, 처방(pyenv)은 개발 고정판(pin)을 댄다.
  const floor = PYTHON_MIN_SUPPORTED;
  const pin = declared ?? floor;
  const windows = (input.platform ?? process.platform) === 'win32';
  if (!resolution) return windows
    ? { status: 'manual', evidence: 'no python.exe found (ELANOUS_PYTHON · elanous venv · PATH · uv)', remedy: 'uv python install 3.12', resolution }
    : { status: 'manual', evidence: 'no python3 found (ELANOUS_PYTHON · elanous venv · pyenv · PATH)', remedy: `install Python ${floor}+ (pyenv install ${pin}) — see RFC-doctor-fix-build-toolchain-and-python-by-distro A2`, resolution };
  if (!probe?.version) return { status: 'manual', evidence: `${resolution.path} did not run: ${probe?.error ?? 'not probed'}`, remedy: windows
    ? windowsPythonRemedy(resolution.source)
    : `install Python ${floor}+`, resolution };
  const v = probe.version.join('.');
  if (!versionAtLeast(probe.version, floor)) {
    const remedy = windows
      ? windowsPythonRemedy(resolution.source)
      : `pyenv install ${pin} (install your distribution's Python build dependencies first) · then: elanous python setup --yes`;
    return { status: 'manual', evidence: `${resolution.source} python ${v} is older than the minimum ${floor}`, remedy, resolution };
  }
  if (!venvExists) return { status: 'fixable', evidence: `python ${v} (${resolution.source}) · elanous venv missing`, remedy: 'elanous python setup --yes', resolution };
  if (probe.hasPip === false) return { status: 'fixable', evidence: `elanous venv python ${v} has no pip — recreate it`, remedy: 'elanous python setup --yes', resolution };
  if (probe.missing.length) return { status: 'fixable', evidence: `elanous venv python ${v} · missing modules: ${probe.missing.join(', ')}`, remedy: 'elanous python setup --yes', resolution };
  return { status: 'ok', evidence: `python ${v} (${resolution.source}) · required modules import`, resolution };
}

/** venv 의 «기반» 파이썬 — pyenv 선언 판이 있으면 그것(스킬 패키지가 거기 깔려 있다) · 없으면 venv 가 아닌 해석 결과. */
export function venvBasePython(deps: PythonDeps = {}): PythonResolution | null {
  const env = { ...(deps.env ?? process.env) };
  const home = deps.home ?? homedir();
  const exists = deps.exists ?? existsSync;
  const venv = (deps.platform ?? process.platform) === 'win32'
    ? win32.join(elanousVenvDir(env, home), 'Scripts', 'python.exe')
    : join(elanousVenvDir(env, home), 'bin', 'python');
  return resolvePython({ ...deps, env, exists: (p) => p !== venv && exists(p) });
}
