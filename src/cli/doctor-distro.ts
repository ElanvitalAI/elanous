// 🐧 배포판 계열 판별 ⊕ 계열별 처방 표 — `doctor` 가 «칠 한 줄»을 배포판에 맞게 댄다.
//
// 계기(2026-09-24 · RFC doctor-fix build-toolchain-and-python-by-distro · 🅢 빈 VM 셋 실측):
//   linux 면 무조건 `sudo apt-get …` 를 댔다 — Amazon Linux 에서도. `/etc/os-release` 를 읽는 코드가 0곳이었다.
// ⛔ 모르는 계열(alpine·arch·suse…)에는 명령을 «추측하지 않는다» — 처방이 없음(undefined)을 돌려준다.
// ⛔ WSL 은 계열이 아니다 — 안의 배포판(대개 Ubuntu)의 os-release 로 판별된다.
// 이 모듈은 순수하다 — 파일 읽기는 호출자(doctor-cli)가 한다.

export type DistroFamily = 'darwin' | 'debian' | 'fedora' | 'amzn2023' | 'amzn2' | 'unknown';

/** `/etc/os-release` 본문 → 키/값. 따옴표는 벗긴다. */
export function parseOsRelease(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    fields[key] = value;
  }
  return fields;
}

/** 플랫폼 ⊕ os-release 본문 → 계열. linux 인데 본문이 없으면(못 읽음) `unknown`. */
export function detectDistroFamily(platform: NodeJS.Platform | undefined, osRelease: string | null | undefined): DistroFamily {
  if (platform === 'darwin') return 'darwin';
  if (platform !== 'linux' || !osRelease) return 'unknown';
  const fields = parseOsRelease(osRelease);
  const id = (fields.ID ?? '').toLowerCase();
  const like = (fields.ID_LIKE ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const version = (fields.VERSION_ID ?? '').trim();
  if (id === 'amzn' && version === '2') return 'amzn2';
  // AL2023 는 dnf 지만 Fedora 와 저장소가 다르다(🩸 2026-09-25 컨테이너: ripgrep 이 없다) — 따로 판별한다.
  if (id === 'amzn') return 'amzn2023';
  if (id === 'debian' || id === 'ubuntu' || like.includes('debian') || like.includes('ubuntu')) return 'debian';
  if (id === 'fedora' || id === 'rhel' || id === 'amzn' || like.includes('fedora') || like.includes('rhel')) return 'fedora';
  return 'unknown';
}

export interface DistroRemedies {
  /** node-pty 를 빌드할 도구(① · RFC A2). */
  buildToolchain: string;
  /** pyenv 로 파이썬을 빌드할 의존성(② · RFC A2). */
  pythonBuildDeps: string;
  /** 시스템 파이썬으로 venv(⊕ pip)를 만들 수 있게 하는 한 줄 — 이미 되는 계열은 없음. 🩸 09-24 빈 Ubuntu 24.04 실측: 없으면 pip 없는 venv 가 생긴다. */
  pythonVenv?: string;
  /** 파이썬이 «아예 없을» 때 배포판 파이썬(⊕ venv)을 까는 한 줄 — 그 판이 선언의 major.minor 를 넘는 계열만.
   *  🩸 2026-09-25 빈 ubuntu:24.04 컨테이너 실측: 없으면 pyenv 설명문이 처방이 되어 `--sudo` 가 그것을 셸로 쳤다. */
  pythonBase?: string;
  /** gh 설치 한 줄. ⚠️ fedora·amzn2 의 gh 줄은 GitHub CLI 공식 RPM 저장소 방식이고 이 저장소에서 «안 쟀다». */
  gh: string;
  /** ripgrep 설치 한 줄(계열별 패키지 관리자로 설치). 없으면 = 그 계열 기본 저장소에 없다 — 명령을 추측하지 않는다. */
  rg?: string;
  /** codex CLI 의 node shebang 을 위한 Node 및 npm 설치 한 줄. 없으면 위와 같다. */
  node?: string;
  /** node 가 준비된 뒤 codex CLI 설치 한 줄. */
  codex?: string;
  /** jq 설치 한 줄(없는 계열에는 추측하지 않는다). */
  jq?: string;
  /** ffmpeg 설치 한 줄(기본 저장소에 없는 계열에는 두지 않는다). */
  ffmpeg?: string;
  /** 계열별 주의 한 줄(없으면 생략). */
  note?: string;
}

/** 계열 → 처방. RFC A2 표가 원천이다(실측: debian=Ubuntu 24.04 · fedora=Amazon Linux 2023 · amzn2=Amazon Linux 2 · darwin=이 맥). */
export const DISTRO_REMEDIES: Readonly<Record<Exclude<DistroFamily, 'unknown'>, DistroRemedies>> = {
  darwin: {
    buildToolchain: 'xcode-select --install',
    pythonBuildDeps: 'brew install openssl readline sqlite3 xz zlib tcl-tk',
    gh: 'brew install gh',
    jq: 'brew install jq',
    ffmpeg: 'brew install ffmpeg',
    rg: 'brew install ripgrep',
    node: 'brew install node',
    codex: 'npm install -g @openai/codex',
  },
  debian: {
    buildToolchain: 'sudo apt-get install -y build-essential',
    pythonBuildDeps: 'sudo apt-get install -y build-essential libssl-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev curl git libncurses-dev xz-utils tk-dev libffi-dev liblzma-dev',
    // 🩸 09-24 빈 GCP Ubuntu 24.04 실측: 목록 갱신 없이 `apt-get install -y gh` → «Unable to locate package gh».
    gh: 'sudo apt-get update && sudo apt-get install -y gh',
    jq: 'sudo apt-get update && sudo apt-get install -y jq',
    ffmpeg: 'sudo apt-get update && sudo apt-get install -y ffmpeg',
    rg: 'sudo apt-get update && sudo apt-get install -y ripgrep',
    node: 'Install Node.js 20+ using the official distribution instructions at https://nodejs.org/en/download',
    codex: 'sudo npm install -g @openai/codex',
    pythonVenv: 'sudo apt-get install -y python3-venv',
    pythonBase: 'sudo apt-get update && sudo apt-get install -y python3 python3-venv',
    note: 'a venv from the system python needs python3-venv (measured 2026-09-24: without it the venv has no pip)',
  },
  fedora: {
    buildToolchain: 'sudo dnf install -y gcc-c++ make',
    pythonBuildDeps: 'sudo dnf install -y gcc make patch zlib-devel bzip2 bzip2-devel readline-devel sqlite sqlite-devel openssl-devel tk-devel libffi-devel xz-devel',
    // 🩸 2026-09-25 fedora:latest 컨테이너: dnf5 는 `config-manager --add-repo` 를 모른다. gh 는 Fedora 공식 저장소에 있다.
    gh: 'sudo dnf install -y gh',
    jq: 'sudo dnf install -y jq',
    rg: 'sudo dnf install -y ripgrep',
    node: 'sudo dnf install -y nodejs npm',
    codex: 'sudo npm install -g @openai/codex',
    note: 'git is not installed by default: sudo dnf install -y git',
  },
  // 📏 2026-09-25 amazonlinux:2023 컨테이너: gh 줄(dnf4 저장소 방식)·gcc-c++ 는 성공 · ripgrep 은 기본 저장소에 없다.
  amzn2023: {
    buildToolchain: 'sudo dnf install -y gcc-c++ make',
    pythonBuildDeps: 'sudo dnf install -y gcc make patch zlib-devel bzip2 bzip2-devel readline-devel sqlite sqlite-devel openssl-devel tk-devel libffi-devel xz-devel',
    gh: "sudo dnf install -y 'dnf-command(config-manager)' && sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo && sudo dnf install -y gh",
    jq: 'sudo dnf install -y jq',
    node: 'sudo dnf install -y nodejs npm',
    codex: 'sudo npm install -g @openai/codex',
    note: 'ripgrep is not in the AL2023 base repos — install it manually; the system python3 is 3.9 (older than the declared 3.12)',
  },
  amzn2: {
    buildToolchain: 'sudo yum install -y gcc10 gcc10-c++ make && sudo amazon-linux-extras install -y python3.8  # then build with CC=gcc10-gcc CXX=gcc10-g++ PYTHON=python3.8',
    pythonBuildDeps: 'sudo yum install -y gcc make patch zlib-devel bzip2 bzip2-devel readline-devel sqlite sqlite-devel openssl11-devel tk-devel libffi-devel xz-devel',
    // 🩸 2026-09-25 amazonlinux:2 컨테이너: yum-config-manager 는 yum-utils 에 있고 기본 이미지엔 없다.
    gh: 'sudo yum install -y yum-utils && sudo yum-config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo && sudo yum install -y gh',
    jq: 'sudo yum install -y jq',
    // ⛔ rg·node 줄을 두지 않는다(🅢 수확 2026-09-24): AL2 기본 저장소에 ripgrep·nodejs 가 없고, 제3자 저장소(COPR 등)를
    //    `--sudo` 가 자동으로 붙이는 것은 위험하며 aarch64 에서는 실행도 안 된다(리뷰 must-fix). 이름만 대고 사람이 고른다.
    codex: 'sudo npm install -g @openai/codex',
    note: 'openssl-devel (1.0.2) cannot build Python 3.12 ssl — use openssl11-devel; node-pty needs C++20 (gcc10) and node-gyp needs Python 3.8+; ripgrep and nodejs are not in the AL2 base repos — install them manually',
  },
};

/** 계열의 처방 — 모르는 계열은 undefined(명령을 추측하지 않는다). */
export function remediesFor(family: DistroFamily): DistroRemedies | undefined {
  return family === 'unknown' ? undefined : DISTRO_REMEDIES[family];
}

/** 표에 명시된 도구 설치 줄만 돌려준다 — 모르는 계열·빈 칸은 undefined. */
export function toolInstallLine(tool: 'gh' | 'rg' | 'node' | 'codex' | 'jq' | 'ffmpeg', family: DistroFamily): string | undefined {
  return remediesFor(family)?.[tool];
}
