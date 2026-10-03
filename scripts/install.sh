#!/usr/bin/env bash
# Install elanous from this checkout, a local tarball, or a tarball URL.
#
# 🆕 2026-09-24 (결정 「sh 를 실행하면 알아서 설치되는 구조」) — claude·grok 의 네이티브 설치기와 같은 모양:
#   $PREFIX/versions/<version>[-<커밋12>]/ 판별 본체(각자 node_modules) ← 옛 판은 남는다(롤백 · 체크아웃 설치는 커밋이 이름)
#   $PREFIX/current  → versions/<version>                                ← 전환은 심링크 하나
#   $PREFIX/bin/elanous → current 판을 절대 경로 bun 으로 실행하는 sh 래퍼     ← PATH 에 넣는 «고정» 경로
#   ⛔ 기본 PREFIX 는 상태 폴더(~/.elanous)가 «아니다» — 설치물과 상태(auth·logs·worktrees)를 가른다.
#   bun 이 없으면 공식 설치기로 먼저 깐다(--no-bootstrap-bun 으로 끈다).
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/install.sh [--prefix PATH] [--source PATH.tgz|URL] [--no-modify-path] [--no-bootstrap-bun] [--no-install-deps] [--no-setup] [--yes] [--allow-downgrade] [--help]
       curl -fsSL https://github.com/ElanvitalAI/elanous/releases/latest/download/install.sh | bash

Install elanous without contacting a package registry.
  --prefix PATH       installation root (default: $ELANOUS_INSTALL_PREFIX or ${XDG_DATA_HOME:-$HOME/.local/share}/elanous)
                      layout: versions/<version>[-<commit12>]/ · current -> versions/… · bin/elanous
                      (a checkout install names its folder by commit, so reinstalling keeps the previous one)
  --source PATH.tgz   install an existing local package tarball
  --source URL        download the package tarball (https://…/*.tgz) and install it
                      (or set $ELANOUS_INSTALL_SOURCE; without either, fetch the verified latest release)
  --no-modify-path    do not append the elanous PATH block to a shell startup file
  --no-bootstrap-bun  fail instead of installing bun with its official installer when bun is missing
  --no-install-deps  do not install missing prerequisites with apt even when running as root
  --no-setup          do not start first-time setup in this window after installing (interactive terminals only)
  --yes               do not ask before updating an existing installation
  --allow-downgrade   allow installing a version older than the one already installed
  --help, -h          show this help
EOF
}

shell_quote() {
  printf "'%s'" "${1//\'/\'\"\'\"\'}"
}

PREFIX="${ELANOUS_INSTALL_PREFIX:-${XDG_DATA_HOME:-${HOME:?HOME is required}/.local/share}/elanous}"
SOURCE="${ELANOUS_INSTALL_SOURCE:-}"
MODIFY_PATH=1
BOOTSTRAP_BUN=1
INSTALL_DEPS=1
RUN_SETUP=1
ASSUME_YES=0
ALLOW_DOWNGRADE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --prefix)
      [ "$#" -ge 2 ] || { echo "⛔ --prefix needs a path" >&2; exit 2; }
      PREFIX="$2"; shift 2 ;;
    --source)
      [ "$#" -ge 2 ] || { echo "⛔ --source needs a .tgz path" >&2; exit 2; }
      SOURCE="$2"; shift 2 ;;
    --no-modify-path) MODIFY_PATH=0; shift ;;
    --no-bootstrap-bun) BOOTSTRAP_BUN=0; shift ;;
    --no-install-deps) INSTALL_DEPS=0; shift ;;
    --no-setup) RUN_SETUP=0; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --allow-downgrade) ALLOW_DOWNGRADE=1; shift ;;
    *) echo "⛔ unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# INST1 — one language per run: English by default, Korean when the locale is Korean (override: ELANOUS_INSTALL_LANG=en|ko).
case "${ELANOUS_INSTALL_LANG:-${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}}" in
  ko*) INSTALL_LANG=ko ;;
  *) INSTALL_LANG=en ;;
esac
t() { if [ "$INSTALL_LANG" = ko ]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }

# Interactive = a person is at a terminal. `curl … | bash` gives us the script on stdin, so look at
# stdout and /dev/tty, not stdin (rustup does the same). CI never counts as interactive.
# ELANOUS_INSTALL_INTERACTIVE=0|1 overrides the probe (tests, wrappers).
INTERACTIVE=0
if [ -n "${ELANOUS_INSTALL_INTERACTIVE:-}" ]; then
  [ "$ELANOUS_INSTALL_INTERACTIVE" = 1 ] && INTERACTIVE=1
elif [ -z "${CI:-}" ] && [ -t 1 ] && { : </dev/tty; } 2>/dev/null; then
  INTERACTIVE=1
fi

# bun 이 없으면 공식 설치기로 먼저 깐다 — «sh 한 번이면 알아서» (claude·grok 설치기와 같은 기대).
# ⛔ 끄면(--no-bootstrap-bun) 공식 설치 명령을 안내하고 rc 127 로 멈춘다.
# 🩸 2026-09-24 빈 VM 실측: 비대화 셸(ssh 명령·크론)은 ~/.bun/bin 이 PATH 에 없어 «이미 깐» bun 을 못 보고 또 설치했다.
#    ⇒ 표준 위치에 있으면 그것을 쓴다.
# 전에 둔 $PREFIX/bin/bun 이 «끊어진» 링크(고리 포함)면 먼저 걷는다 — 0.1.0 설치기가 재설치 때 자기 자신을 가리키는
# 고리를 만들었다(09-25 GCP debian-12). 걷으면 아래 표준 위치(~/.bun/bin/bun) 탐색이 이어받는다.
if [ -L "$PREFIX/bin/bun" ] && [ ! -e "$PREFIX/bin/bun" ]; then
  echo "removing a broken bun link at $PREFIX/bin/bun (left by an earlier install)" >&2
  rm -f "$PREFIX/bin/bun"
fi
if ! command -v bun >/dev/null 2>&1 && [ -x "${BUN_INSTALL:-$HOME/.bun}/bin/bun" ]; then
  export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
fi
# Match doctor-distro.ts families when a required command is absent; do not source os-release as shell code.
required_command_family() {
  local id='' id_like='' version='' key value family='unknown' like
  if [ "$(uname -s)" = 'Darwin' ]; then
    family='darwin'
  elif [ "$(uname -s)" = 'Linux' ] && [ -r "${ELANOUS_INSTALL_OS_RELEASE_FILE:-/etc/os-release}" ]; then
    while IFS='=' read -r key value; do
      value="${value#\"}"; value="${value%\"}"
      value="${value#\'}"; value="${value%\'}"
      case "$key" in
        ID) id="$value" ;;
        ID_LIKE) id_like="$value" ;;
        VERSION_ID) version="$value" ;;
      esac
    done < "${ELANOUS_INSTALL_OS_RELEASE_FILE:-/etc/os-release}"
    if [ "$id" = 'amzn' ] && [ "$version" = '2' ]; then
      family='amzn2'
    elif [ "$id" = 'debian' ] || [ "$id" = 'ubuntu' ]; then
      family='debian'
    else
      for like in $id_like; do
        case "$like" in debian|ubuntu) family='debian'; break ;; esac
      done
      if [ "$family" = 'unknown' ]; then
        case "$id" in fedora|rhel|amzn) family='fedora' ;; esac
        for like in $id_like; do
          case "$like" in fedora|rhel) family='fedora' ;; esac
        done
      fi
    fi
  fi
  printf '%s' "$family"
}

required_command_hint() {
  local package="$1" family
  family="$(required_command_family)"
  if [ "$package" = 'bun' ] && [ "$family" != 'unknown' ]; then
    echo '   curl -fsSL https://bun.sh/install | bash' >&2
    return
  fi
  case "$family" in
    debian) echo "   ${SUDO}apt-get install -y $package" >&2 ;;
    fedora) echo "   ${SUDO}dnf install -y $package" >&2 ;;
    amzn2) echo "   ${SUDO}yum install -y $package" >&2 ;;
    darwin) echo "   brew install $package" >&2 ;;
    *) echo "   (install the '$package' package with your package manager)" >&2 ;;
  esac
}

# root(컨테이너·클라우드 이미지)엔 sudo 가 없는 일이 흔하다 — 안내 줄에 sudo 를 붙이면 그대로 쳐도 실패한다(09-25 베어 ubuntu:24.04 실측).
SUDO='sudo '
[ "$(id -u 2>/dev/null)" = 0 ] && SUDO=''

# 빠진 선행 명령을 «한 번에» 모아 한 줄로 댄다. bun 은 여기서 세지 않는다(없으면 아래에서 공식 설치기로 깐다).
missing_prerequisites() {
  MISSING=()
  if ! command -v bun >/dev/null 2>&1 && [ "$BOOTSTRAP_BUN" -eq 1 ]; then
    command -v curl >/dev/null 2>&1 || MISSING+=(curl)
    command -v unzip >/dev/null 2>&1 || MISSING+=(unzip)   # bun 공식 설치기가 쓴다
  fi
  command -v git >/dev/null 2>&1 || MISSING+=(git)
}
missing_prerequisites
INSTALLED_DEPS=''
DEPS_INSTALL_FAILED=0
if [ "${#MISSING[@]}" -gt 0 ] && [ "$INSTALL_DEPS" -eq 1 ] && [ "$SUDO" = '' ] &&
   command -v apt-get >/dev/null 2>&1 && [ "$(required_command_family)" = debian ]; then
  DEPS_TO_INSTALL=("${MISSING[@]}")
  # Fresh container images ship with empty package lists — refresh once, then install without prompts.
  if DEBIAN_FRONTEND=noninteractive apt-get update -qq >&2 &&
     DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${DEPS_TO_INSTALL[@]}" >&2; then
    INSTALLED_DEPS="${DEPS_TO_INSTALL[*]}"
    echo "installed: $INSTALLED_DEPS" >&2
    missing_prerequisites
  else
    DEPS_INSTALL_FAILED=1
    echo '⛔ 자동 설치 실패 — 아래를 직접 실행하라 (automatic install failed — run the command below yourself):' >&2
  fi
fi
if [ "${#MISSING[@]}" -gt 0 ] || [ "$DEPS_INSTALL_FAILED" -eq 1 ]; then
  echo "⛔ required command missing: ${MISSING[*]}. Install it, then rerun this script:" >&2
  required_command_hint "${MISSING[*]}"
  exit 127
fi

# bun 판은 고정한다 — 기계마다 «그날의 최신»이 깔리면 같은 판을 설치해도 다르게 돈다.
# Pod 이미지(docker/harness/Dockerfile `ARG BUN_VERSION`)와 같은 판. ELANOUS_BUN_VERSION=latest 면 고정하지 않는다.
BUN_PIN="${ELANOUS_BUN_VERSION:-1.4.2}"
if ! command -v bun >/dev/null 2>&1 && [ "$BOOTSTRAP_BUN" -eq 1 ]; then
  echo "bun not found — installing bun ${BUN_PIN} with its official installer (https://bun.sh/install)" >&2
  if [ "$BUN_PIN" = latest ]; then BUN_ARGS=(); else BUN_ARGS=("bun-v${BUN_PIN}"); fi
  if curl -fsSL https://bun.sh/install | bash -s ${BUN_ARGS[@]+"${BUN_ARGS[@]}"} >&2; then
    export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
  else
    echo "⚠️ bun bootstrap failed" >&2
  fi
fi

# Keep this explicit set aligned with catalog/external-commands.yaml required entries.
REQUIRED_COMMANDS=(git bun)
HARNESS_COMMANDS=(gh rg codex)
for command in "${REQUIRED_COMMANDS[@]}"; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "⛔ required command missing: $command. Install it, then rerun this script:" >&2
    required_command_hint "$command"
    exit 127
  fi
done
for command in "${HARNESS_COMMANDS[@]}"; do
  command -v "$command" >/dev/null 2>&1 || echo "$(t "⚠️ harness command missing: $command (see Next below)" "⚠️ 하니스가 쓰는 명령이 없습니다: $command (아래 «다음» 참고)")" >&2
done

# bun 의 «실제 실행 파일» — PATH 의 이름이 아니라 bun 이 스스로 말하는 경로(링크를 끝까지 푼 것).
# 🩸 09-25 GCP debian-12 재설치: 로그인 셸은 $PREFIX/bin 이 PATH 맨 앞이라 `command -v bun` 이 우리가 전에 둔
#    $PREFIX/bin/bun 링크 «자신»을 가리켰고, `ln -sfn` 이 그것을 자기 자신으로 덮어 고리를 만들었다
#    (`bun: Too many levels of symbolic links` · 설치 rc 127 · 이후 `elanous` 가 전부 죽음). 업데이트·재설치 경로 전부가 여기를 지난다.
BUN_EXEC="$(bun -e 'process.stdout.write(process.execPath)' 2>/dev/null || true)"
# 래퍼에는 PATH 에 의존하지 않는 절대 실행 경로만 박는다. bun 이 경로를 못 대면(비정상 bun) PATH 에서 찾은 절대 경로로 물러서고,
# 그래도 절대 경로가 없으면 설치를 중단한다.
{ [ -n "$BUN_EXEC" ] && [ -x "$BUN_EXEC" ]; } || BUN_EXEC="$(command -v bun 2>/dev/null || true)"
case "$BUN_EXEC" in
  /*) [ -x "$BUN_EXEC" ] || { echo "⛔ bun executable is not available: $BUN_EXEC" >&2; exit 127; } ;;
  *) echo '⛔ bun executable absolute path is unavailable' >&2; exit 127 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
TMP=""
cleanup() { [ -z "$TMP" ] || rm -rf "$TMP"; }
trap cleanup EXIT

mkdir -p "$PREFIX"
PREFIX="$(cd "$PREFIX" && pwd -P)"
if [ "$MODIFY_PATH" -eq 1 ]; then
  STARTUP="${ELANOUS_SHELL_STARTUP:-}"
  if [ -z "$STARTUP" ]; then
    case "${SHELL:-}" in
      */zsh) STARTUP="$HOME/.zshrc" ;;
      *) STARTUP="$HOME/.bashrc" ;;
    esac
  fi
  mkdir -p "$(dirname "$STARTUP")"
  touch "$STARTUP"
  MARKER_START='# >>> elanous installer PATH >>>'
  MARKER_END='# <<< elanous installer PATH <<<'
  PATH_LINE="export PATH=$(shell_quote "$PREFIX/bin"):\"\$PATH\""
  if grep -Fqx "$MARKER_START" "$STARTUP" && ! grep -Fqx "$PATH_LINE" "$STARTUP"; then
    echo "⛔ PATH block already points to a different installation prefix" >&2
    exit 1
  fi
  # bash 는 로그인 셸이 ~/.profile 을 읽고, ~/.bashrc 는 «비대화형이면 맨 앞에서 return» 한다(Debian 기본).
  # 🩸 2026-09-25 빈 debian:12 컨테이너: `bash -lc elanous`(= ssh 원격 명령·스크립트) → command not found. 그래서 ~/.profile 에도 쓴다.
  # zsh 도 같다: ~/.zshrc 는 «대화형» 만 읽고 `ssh host cmd`(비대화형)는 ~/.zshenv 만 읽는다.
  # 🩸 2026-09-28 node-b: ssh 원격 명령이 설치본을 못 찾아 🅣 의 원격 실행 태스크가 not-done 이 됐다. 그래서 ~/.zshenv 에도 쓴다.
  LOGIN_STARTUP=""
  if [ -z "${ELANOUS_SHELL_STARTUP:-}" ] && [ "$STARTUP" = "$HOME/.zshrc" ]; then
    LOGIN_STARTUP="$HOME/.zshenv"
  fi
  if [ -z "${ELANOUS_SHELL_STARTUP:-}" ] && [ "$STARTUP" = "$HOME/.bashrc" ]; then
    LOGIN_STARTUP="$HOME/.profile"
  fi
  if [ -n "$LOGIN_STARTUP" ]; then
    touch "$LOGIN_STARTUP"
    if grep -Fqx "$MARKER_START" "$LOGIN_STARTUP" && ! grep -Fqx "$PATH_LINE" "$LOGIN_STARTUP"; then
      echo "⛔ PATH block in $LOGIN_STARTUP already points to a different installation prefix" >&2
      exit 1
    fi
  fi
fi

# A standalone installer fetches a verified release; explicit sources and checkouts keep their existing paths.
IS_CHECKOUT=0
if [ -f "$SCRIPT_DIR/install.sh" ] && [ -f "$REPO_ROOT/package.json" ] && grep -q '"name": *"elanous"' "$REPO_ROOT/package.json" 2>/dev/null; then
  IS_CHECKOUT=1
fi
if [ -z "$SOURCE" ] && [ "$IS_CHECKOUT" -eq 0 ]; then
  RELEASE_BASE="${ELANOUS_RELEASE_BASE:-https://github.com/ElanvitalAI/elanous/releases}"
  if [ -n "${ELANOUS_VERSION:-}" ]; then
    RELEASE_DIR="${RELEASE_BASE%/}/download/v${ELANOUS_VERSION}/"
  else
    RELEASE_DIR="${RELEASE_BASE%/}/latest/download/"
  fi
  PACKAGE_URL="${RELEASE_DIR}elanous.tgz"
  CHECKSUM_URL="${RELEASE_DIR}SHA256SUMS"
  command -v curl >/dev/null 2>&1 || { echo "⛔ download failed: $PACKAGE_URL (curl missing)" >&2; exit 1; }
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/elanous-install.XXXXXX")" || { echo "⛔ mktemp failed" >&2; exit 1; }
  curl -fsSL -o "$TMP/package.tgz" "$PACKAGE_URL" || { echo "⛔ download failed: $PACKAGE_URL" >&2; exit 1; }
  curl -fsSL -o "$TMP/SHA256SUMS" "$CHECKSUM_URL" || { echo "⛔ download failed: $CHECKSUM_URL" >&2; exit 1; }
  EXPECTED="$(awk '$2 == "elanous.tgz" && $1 ~ /^[[:xdigit:]]+$/ && length($1) == 64 { print $1; exit }' "$TMP/SHA256SUMS")"
  [ -n "$EXPECTED" ] || { echo "⛔ checksum missing for elanous.tgz: $CHECKSUM_URL" >&2; exit 1; }
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$TMP/package.tgz" | cut -d ' ' -f 1)"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "$TMP/package.tgz" | cut -d ' ' -f 1)"
  else
    echo "⛔ SHA-256 verification needs sha256sum or shasum" >&2; exit 1
  fi
  [ "$(printf '%s' "$EXPECTED" | tr 'A-F' 'a-f')" = "$(printf '%s' "$ACTUAL" | tr 'A-F' 'a-f')" ] || { echo "⛔ checksum mismatch for $PACKAGE_URL: expected $EXPECTED actual $ACTUAL" >&2; exit 1; }
  METADATA_SOURCE="$PACKAGE_URL"
  INSTALL_TARBALL="$TMP/package.tgz"
  DOWNLOADED=1
fi

case "$SOURCE" in
  http://*|https://*)
    command -v curl >/dev/null 2>&1 || { echo "⛔ --source URL needs curl" >&2; exit 127; }
    TMP="$(mktemp -d "${TMPDIR:-/tmp}/elanous-install.XXXXXX")" || { echo "⛔ mktemp failed" >&2; exit 1; }
    curl -fsSL -o "$TMP/package.tgz" "$SOURCE" || { echo "⛔ download failed: $SOURCE" >&2; exit 1; }
    METADATA_SOURCE="$SOURCE"
    INSTALL_TARBALL="$TMP/package.tgz"
    SOURCE=""
    DOWNLOADED=1
    ;;
esac

if [ "${DOWNLOADED:-0}" -eq 1 ]; then
  :
elif [ -n "$SOURCE" ]; then
  [ -f "$SOURCE" ] || { echo "⛔ source tarball missing: $SOURCE" >&2; exit 2; }
  TARBALL="$(cd "$(dirname "$SOURCE")" && pwd -P)/$(basename "$SOURCE")"
  METADATA_SOURCE="$TARBALL"
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/elanous-install.XXXXXX")" || { echo "⛔ mktemp failed" >&2; exit 1; }
  INSTALL_TARBALL="$TMP/package.tgz"
  cp "$TARBALL" "$INSTALL_TARBALL"
else
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/elanous-install.XXXXXX")" || { echo "⛔ mktemp failed" >&2; exit 1; }
  # 🆕 2026-09-24: 패키지가 PWA 빌드(apps/pwa/out/)를 싣는다 — 체크아웃에 빌드가 없으면 설치본에 웹 화면이 없다. 막지 않고 말한다.
  if [ ! -f "$REPO_ROOT/apps/pwa/out/index.html" ]; then
    echo "⚠ PWA build not found (apps/pwa/out/index.html) — the installed copy will have no web UI. Build it first: bun bin/elanous.mjs nexus build" >&2
  fi
  (cd "$REPO_ROOT" && bun pm pack --destination "$TMP" >/dev/null)
  TARBALL="$(find "$TMP" -maxdepth 1 -type f -name '*.tgz' -print -quit)"
  [ -n "$TARBALL" ] || { echo "⛔ package tarball was not created" >&2; exit 1; }
  INSTALL_TARBALL="$TARBALL"
  METADATA_SOURCE="$REPO_ROOT"
  # Only a checkout install is this repo. A missing git or a failed
  # rev-parse stays an empty value, same as before — the install does not die.
  METADATA_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
  # 체크아웃 설치는 package.json 버전이 늘 같다 — 폴더를 «버전 ⊕ 짧은 커밋»으로 지어야 재설치가
  # 앞 판을 덮지 않는다(롤백 = current 심링크 하나). 추적 파일이 커밋과 다르면 `-dirty` 를 붙인다.
  if [ -n "$METADATA_COMMIT" ]; then
    VERSION_SUFFIX="-$(printf '%s' "$METADATA_COMMIT" | cut -c1-12)"
    if [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no 2>/dev/null || true)" ]; then
      VERSION_SUFFIX="$VERSION_SUFFIX-dirty"
    fi
  fi
fi

# 버전을 «설치 전에» tarball 에서 읽는다 — 그래야 versions/<version>[-<커밋 12자>] 으로 곧장 깔고, 같은 판 재설치는
# 예전처럼 같은 폴더에 덮어쓴다(옛 판 폴더는 건드리지 않는다 = 롤백 가능).
PACKAGE_VERSION="$(tar -xzOf "$INSTALL_TARBALL" package/package.json 2>/dev/null | bun -e 'const t=await Bun.stdin.text(); try { process.stdout.write(String(JSON.parse(t).version ?? "")) } catch {}' || true)"
[ -n "$PACKAGE_VERSION" ] || { echo "⛔ package version missing in tarball: $INSTALL_TARBALL" >&2; exit 1; }
case "$PACKAGE_VERSION" in */*|*..*) echo "⛔ unsafe package version: $PACKAGE_VERSION" >&2; exit 1 ;; esac

# INST1 — an existing installation is never moved silently: no downgrade without --allow-downgrade
# (10-01: a running mbp went 0.2.7 → 0.2.6 unnoticed), and an interactive re-run asks before updating.
INSTALLED_VERSION=""
if [ -f "$PREFIX/install.json" ]; then
  INSTALLED_VERSION="$(bun -e 'try { const j=JSON.parse(await Bun.file(process.argv.at(-1)).text()); process.stdout.write(String(j.version ?? "")) } catch {}' "$PREFIX/install.json" || true)"
fi
if [ -n "$INSTALLED_VERSION" ]; then
  ORDER="$(bun -e 'const [a,b]=process.argv.slice(-2); try { process.stdout.write(String(Bun.semver.order(a,b))) } catch { process.stdout.write("0") }' "$PACKAGE_VERSION" "$INSTALLED_VERSION" || echo 0)"
  if [ "$ORDER" = "-1" ] && [ "$ALLOW_DOWNGRADE" -eq 0 ]; then
    echo "⛔ $(t "elanous $INSTALLED_VERSION is installed; $PACKAGE_VERSION is older, so nothing was changed. To go back on purpose, rerun with --allow-downgrade." "elanous $INSTALLED_VERSION 이(가) 설치돼 있고 $PACKAGE_VERSION 은(는) 더 낮은 판이라 아무것도 바꾸지 않았습니다. 일부러 내리려면 --allow-downgrade 를 붙여 다시 실행하세요.")" >&2
    exit 3
  fi
  if [ "$INTERACTIVE" -eq 1 ] && [ "$ASSUME_YES" -eq 0 ]; then
    printf '%s ' "$(t "elanous $INSTALLED_VERSION is already installed. Update to $PACKAGE_VERSION? [Y/n]" "elanous $INSTALLED_VERSION 이(가) 이미 설치돼 있습니다. $PACKAGE_VERSION 로 업데이트할까요? [Y/n]")"
    if [ -n "${ELANOUS_INSTALL_ANSWER+x}" ]; then ANSWER="$ELANOUS_INSTALL_ANSWER"; else ANSWER=""; read -r ANSWER </dev/tty || ANSWER=""; fi
    echo ""
    case "$ANSWER" in
      n|N|no|NO|No|아니오|아니요)
        echo "$(t "Left elanous $INSTALLED_VERSION as it is." "elanous $INSTALLED_VERSION 을(를) 그대로 두었습니다.")"
        exit 0 ;;
    esac
  fi
fi
VERSION_NAME="$PACKAGE_VERSION${VERSION_SUFFIX:-}"
VERSION_DIR="$PREFIX/versions/$VERSION_NAME"
mkdir -p "$VERSION_DIR"
if [ ! -f "$VERSION_DIR/package.json" ]; then
  printf '{"private":true}\n' > "$VERSION_DIR/package.json"
fi
# 🩸 2026-09-24 빈 GCP VM 실측: `--offline` 만 쓰면 bun 캐시가 빈 새 기계에서 의존성이 «전부» failed to resolve — 어떤
#    새 기계에서도 설치가 안 됐다(이 맥은 캐시가 차 있어 가려졌다). ⇒ 캐시로 먼저(빠르고 네트워크 없음) ⊕ 실패하면 레지스트리.
# 🩸 2026-09-24 빈 VM 실측: apt `nodejs npm` 이 있으면 PATH 의 node(v18)·node-gyp(9.3.0)가 node-pty 를 빌드해
#    bun 이 불러오는 순간 panic(uv_version_string)으로 죽었다. ⇒ 빌드 동안만 node=bun · node-gyp=최신 심을 PATH 앞에
#    (src/native/native-build-env.ts 와 같은 심).
NATIVE_SHIM="$(mktemp -d "${TMPDIR:-/tmp}/elanous-native-build.XXXXXX")"
ln -s "$BUN_EXEC" "$NATIVE_SHIM/node"
printf '#!/bin/sh\nexec "%s" x node-gyp@latest "$@"\n' "$BUN_EXEC" > "$NATIVE_SHIM/node-gyp"
chmod +x "$NATIVE_SHIM/node-gyp"
if ! (cd "$VERSION_DIR" && PATH="$NATIVE_SHIM:$PATH" bun add --no-save --offline "$INSTALL_TARBALL" >/dev/null 2>&1); then
  echo "dependencies not in the local bun cache — fetching them from the npm registry" >&2
  # bun prints «Blocked N postinstalls» and progress noise here — keep it out of the screen unless this step fails.
  ADD_LOG="$(mktemp "${TMPDIR:-/tmp}/elanous-bun-add.XXXXXX")"
  ADD_RC=0
  (cd "$VERSION_DIR" && PATH="$NATIVE_SHIM:$PATH" bun add --no-save "$INSTALL_TARBALL") >"$ADD_LOG" 2>&1 || ADD_RC=$?
  if [ "$ADD_RC" -ne 0 ]; then
    tail -n 20 "$ADD_LOG" >&2
    rm -f "$ADD_LOG"; rm -rf "$NATIVE_SHIM"
    exit "$ADD_RC"
  fi
  rm -f "$ADD_LOG"
fi
rm -rf "$NATIVE_SHIM"
ln -sfn "versions/$VERSION_NAME" "$PREFIX/current"
mkdir -p "$PREFIX/bin"
# 절대 bun 경로를 설치 때 박고 엔트리는 current 를 거친다 — cron/systemd 의 짧은 PATH 와 판 전환 모두 지원.
WRAPPER="$PREFIX/bin/.elanous-$$"
BUN_MISSING_MSG="$(t 'bun not found: %s — run the installer again' 'bun 을 찾을 수 없습니다: %s — 설치기를 다시 실행하세요')"
printf '#!/bin/sh\n# elanous-wrapper\nif [ ! -x %s ]; then\n  printf '\''%s\\n'\'' %s >&2\n  exit 127\nfi\nexec %s %s "$@"\n' \
  "$(shell_quote "$BUN_EXEC")" "$BUN_MISSING_MSG" "$(shell_quote "$BUN_EXEC")" "$(shell_quote "$BUN_EXEC")" \
  "$(shell_quote "$PREFIX/current/node_modules/elanous/bin/elanous.mjs")" > "$WRAPPER"
chmod +x "$WRAPPER"
mv -f "$WRAPPER" "$PREFIX/bin/elanous"
ELN="$PREFIX/bin/eln"
ELN_ON_PATH="$(command -v eln 2>/dev/null || true)"
if { [ -n "$ELN_ON_PATH" ] && [ "$ELN_ON_PATH" != "$ELN" ]; } ||
   { { [ -e "$ELN" ] || [ -L "$ELN" ]; } &&
     { [ -L "$ELN" ] || [ ! -f "$ELN" ] || [ "$(sed -n '2p' "$ELN")" != '# elanous-wrapper' ]; }; }; then
  echo "⚠ eln: $(t 'already used by another program, so it was not created — run elanous instead.' '이미 다른 프로그램이 eln 을 써서 만들지 않았습니다 — elanous 로 실행하세요.')"
  ELN_AVAILABLE=0
else
  cp "$PREFIX/bin/elanous" "$ELN"
  ELN_AVAILABLE=1
fi
# 대화형 셸은 bun 도 같은 bin 에서 찾는다(래퍼 자체는 이 링크나 PATH 에 의존하지 않는다).
case "$BUN_EXEC" in
  "$PREFIX/bin/bun"|"$PREFIX/bin/bun/") ;;   # 자기 자신에게 잇지 않는다(고리)
  *) ln -sfn "$BUN_EXEC" "$PREFIX/bin/bun" ;;
esac

INSTALLED_PACKAGE="$PREFIX/current/node_modules/elanous/package.json"
VERSION="$(bun -e 'const p=JSON.parse(await Bun.file(process.argv.at(-1)).text()); process.stdout.write(p.version)' "$INSTALLED_PACKAGE")"
[ -n "$VERSION" ] || { echo "⛔ package version missing: $INSTALLED_PACKAGE" >&2; exit 1; }
INSTALLED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
bun -e 'const [version,versionDir,source,installedAt,commit]=process.argv.slice(-5); console.log(JSON.stringify({version,versionDir,source,installedAt,...(commit ? {commit} : {})}))' \
  "$VERSION" "versions/$VERSION_NAME" "$METADATA_SOURCE" "$INSTALLED_AT" "${METADATA_COMMIT:-}" > "$PREFIX/install.json"
# 판 폴더에도 같은 것을 둔다 — `elanous --version` 은 «자기 판»의 것을 읽는다(롤백한 판이 마지막 설치의 커밋을 말하지 않게).
cp "$PREFIX/install.json" "$VERSION_DIR/install.json"

# Darwin only: bun blocks dependency lifecycle scripts in the install prefix,
# so the repo postinstall chmod never reaches this copy of spawn-helper.
# Missing file or chmod failure must not fail the install.
if [ "$(uname -s)" = "Darwin" ]; then
  if [ -n "${ELANOUS_INSTALL_SPAWN_HELPER_CHMOD:-}" ]; then
    "$ELANOUS_INSTALL_SPAWN_HELPER_CHMOD" "$PREFIX"/current/node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true
  else
    chmod +x "$PREFIX"/current/node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true
  fi
fi

if [ "$MODIFY_PATH" -eq 1 ] && ! grep -Fqx "$MARKER_START" "$STARTUP"; then
  printf '\n%s\n%s\n%s\n' "$MARKER_START" "$PATH_LINE" "$MARKER_END" >> "$STARTUP"
fi
if [ "$MODIFY_PATH" -eq 1 ] && [ -n "${LOGIN_STARTUP:-}" ] && ! grep -Fqx "$MARKER_START" "$LOGIN_STARTUP"; then
  printf '\n%s\n%s\n%s\n' "$MARKER_START" "$PATH_LINE" "$MARKER_END" >> "$LOGIN_STARTUP"
fi

echo "$(t "Installed elanous $VERSION at $PREFIX/bin/elanous" "elanous $VERSION 을(를) 설치했습니다: $PREFIX/bin/elanous")"
[ -z "$INSTALLED_DEPS" ] || echo "installed: $INSTALLED_DEPS"

# ── 다음 걸음 (2026-09-23 · Phase 3 「사람 손」) ─────────────────────────
# ⛔ 설치가 끝나도 «무엇을 더 쳐야 하나»를 안 말하면, 빠뜨린 손이 나중에 «다른 원인의 얼굴»로 나타난다
#   (예: 로그인 누락이 quota-exhausted 로 분류됐다 — 09-21 실측). 그래서 «지금 상태»로 계산해 말한다.
#   provider 설정은 «안» 적는다 — 빈 config(auto)는 로그인만 있으면 런타임이 codex 로 고른다(#19950).
# --no-setup keeps the prompt above but never starts setup.
START_SETUP=$INTERACTIVE
[ "$RUN_SETUP" -eq 1 ] || START_SETUP=0

echo ""
echo "$(t 'Next:' '다음:')"
STEP=1
# INST1 order: new shell → elanous (first-time setup, which also signs in) → missing tools → harness say.
case ":$PATH:" in
  *":$PREFIX/bin:"*) ;;
  *) if [ "$START_SETUP" -eq 1 ]; then :; elif [ "$MODIFY_PATH" -eq 1 ]; then echo "  $STEP) $(t "open a new shell (or: source $STARTUP)" "새 셸을 여세요(또는: source $STARTUP)")"; STEP=$((STEP + 1)); else echo "  $STEP) $(t "add $PREFIX/bin to PATH" "$PREFIX/bin 을 PATH 에 넣으세요")"; STEP=$((STEP + 1)); fi ;;
esac
if [ "$START_SETUP" -eq 0 ]; then
  echo "  $STEP) $(t "Run: $PREFIX/bin/elanous   # first-time setup (in a new shell: elanous)" "실행: $PREFIX/bin/elanous   # 첫 설정(새 셸에서는: elanous)")"; STEP=$((STEP + 1))
fi
# 🆕 2026-09-24 빈 VM 실측: 하니스(codex 백엔드)는 Codex CLI 를 자식으로 띄우는데 빈 기계엔 codex·node 가 «둘 다» 없었다.
#    ⚠️ 아래 설치 줄은 빈 기계에서 아직 «안 쟀다» — `elanous doctor` 의 codex 줄이 판정한다.
# C++20 toolchain must precede node-pty's rebuild; only suggest missing prerequisites.
if ! command -v make >/dev/null 2>&1 || ! command -v c++ >/dev/null 2>&1; then
  case "$(uname -s)" in
    Darwin) BUILD_HINT='xcode-select --install' ;;
    Linux)
      OS_ID='' OS_LIKE=''
      if [ -r "${ELANOUS_INSTALL_OS_RELEASE_FILE:-/etc/os-release}" ]; then
        while IFS='=' read -r key value; do
          value="${value#\"}"; value="${value%\"}"
          case "$key" in ID) OS_ID="$value" ;; ID_LIKE) OS_LIKE="$value" ;; esac
        done < "${ELANOUS_INSTALL_OS_RELEASE_FILE:-/etc/os-release}"
      fi
      BUILD_HINT=''
      case " $OS_ID $OS_LIKE " in
        *' debian '*|*' ubuntu '*) BUILD_HINT='sudo apt-get install -y build-essential' ;;
        *' fedora '*) BUILD_HINT='sudo dnf groupinstall -y "Development Tools"' ;;
      esac ;;
    *) BUILD_HINT='' ;;
  esac
  if [ -n "$BUILD_HINT" ]; then
    echo "  $STEP) $BUILD_HINT"; STEP=$((STEP + 1))
  fi
  echo "  $STEP) elanous doctor --fix --yes       # $(t 'rebuild node-pty after installing build tools' '빌드 도구를 깐 뒤 node-pty 다시 빌드')"; STEP=$((STEP + 1))
fi
if ! command -v rg >/dev/null 2>&1; then
  if [ -z "${OS_ID:-}" ] && [ -r "${ELANOUS_INSTALL_OS_RELEASE_FILE:-/etc/os-release}" ]; then
    while IFS='=' read -r key value; do
      value="${value#\"}"; value="${value%\"}"
      case "$key" in ID) OS_ID="$value" ;; ID_LIKE) OS_LIKE="$value" ;; esac
    done < "${ELANOUS_INSTALL_OS_RELEASE_FILE:-/etc/os-release}"
  fi
  case "$(uname -s)" in
    Darwin) RG_HINT='brew install ripgrep' ;;
    Linux) case " ${OS_ID:-} ${OS_LIKE:-} " in
      *' debian '*|*' ubuntu '*) RG_HINT='sudo apt-get install -y ripgrep' ;;
      *' fedora '*) RG_HINT='sudo dnf install -y ripgrep' ;;
      *) RG_HINT="$(t 'install ripgrep (rg) with your package manager' '패키지 관리자로 ripgrep(rg)을 설치하세요')" ;;
    esac ;;
    *) RG_HINT="$(t 'install ripgrep (rg) with your package manager' '패키지 관리자로 ripgrep(rg)을 설치하세요')" ;;
  esac
  echo "  $STEP) $RG_HINT"; STEP=$((STEP + 1))
fi
if ! command -v codex >/dev/null 2>&1; then
  if ! command -v node >/dev/null 2>&1; then
    echo "  $STEP) $(t 'install Node.js 20+ (the Codex CLI runs on node)   # e.g. your package manager or https://nodejs.org' 'Node.js 20 이상을 설치하세요(Codex CLI 가 node 로 돕니다)   # 예: 패키지 관리자 또는 https://nodejs.org')"; STEP=$((STEP + 1))
  fi
  echo "  $STEP) npm install -g @openai/codex      # $(t 'the harness drives the Codex CLI' '하니스가 Codex CLI 를 씁니다')"; STEP=$((STEP + 1))
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "  $STEP) $(t 'install gh, then: gh auth login   # the harness opens pull requests with it' 'gh 를 설치한 뒤: gh auth login   # 하니스가 PR 을 열 때 씁니다')"; STEP=$((STEP + 1))
elif ! gh auth status >/dev/null 2>&1; then
  echo "  $STEP) gh auth login                     # $(t 'the harness opens pull requests with it' '하니스가 PR 을 열 때 씁니다')"; STEP=$((STEP + 1))
fi
if [ "$ELN_AVAILABLE" -eq 1 ]; then
  echo "  $STEP) $(t 'eln harness say "<one line of what you want>" (or: elanous harness say)' 'eln harness say "<하고 싶은 일 한 줄>" (또는: elanous harness say)')"
else
  echo "  $STEP) $(t 'elanous harness say "<one line of what you want>"' 'elanous harness say "<하고 싶은 일 한 줄>"')"
fi
echo "  $(t 'check anytime: elanous setup --non-interactive' '언제든 점검: elanous setup --non-interactive')"

# INST2 — finish in the same window: start first-time setup with the absolute wrapper (no source, no new shell).
if [ "$START_SETUP" -eq 1 ]; then
  echo ""
  echo "$(t 'Starting first-time setup… (skip it next time with --no-setup)' '첫 설정을 시작합니다… (다음에 건너뛰려면 --no-setup)')"
  case ":$PATH:" in
    *":$PREFIX/bin:"*) ;;
    *) echo "  $(t "(new shells will find elanous on PATH; this window uses $PREFIX/bin/elanous)" "(새 셸에서는 PATH 로 elanous 를 찾습니다 · 이 창은 $PREFIX/bin/elanous 를 씁니다)")" ;;
  esac
  # INST3 (10-01 · node-c tmux): a wizard whose stdin is a fresh open of /dev/tty never saw a key on macOS — its event
  # loop cannot watch that fd (the same binary started from a shell, which hands over the real tty, worked). So give it
  # the real terminal device; fall back to /dev/tty only when there is none.
  SETUP_TTY=/dev/tty
  REAL_TTY="$(ps -o tty= -p $$ 2>/dev/null | tr -d ' ')"
  case "$REAL_TTY" in
    ''|'?'|'??') ;;
    *) if [ -r "/dev/$REAL_TTY" ] && [ -w "/dev/$REAL_TTY" ]; then SETUP_TTY="/dev/$REAL_TTY"; fi ;;
  esac
  if [ -n "${ELANOUS_INSTALL_SETUP_EXEC:-}" ]; then
    ELANOUS_INSTALL_SETUP_TTY="$SETUP_TTY" exec "$ELANOUS_INSTALL_SETUP_EXEC" "$PREFIX/bin/elanous"
  fi
  exec "$PREFIX/bin/elanous" <"$SETUP_TTY"
fi
