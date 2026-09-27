#!/usr/bin/env bash
# Remove a elanous installation made by scripts/install.sh (한 줄 설치의 짝 · PLAN-one-line-public-installer P5).
#   bash scripts/uninstall.sh [--prefix PATH] [--keep-path] [--dry-run]
#   curl -fsSL https://github.com/ElanvitalAI/elanous/releases/latest/download/uninstall.sh | bash
#
# 지우는 것: 설치 폴더($PREFIX — versions/·current·bin/·install.json) ⊕ 설치기가 쓴 PATH 블록(마커 사이 · ~/.zshrc·~/.bashrc·~/.profile).
# ⛔ 설치 폴더를 «통째로» 지우지 않는다 — 설치물 넷만 지우고, 그 밖의 것이 남으면 폴더를 지킨다.
#    🩸 09-25: 기억 저장소 기본 위치가 ${XDG_DATA_HOME:-~/.local/share}/elanous/memory — 설치 폴더 «안»이라 `rm -rf $PREFIX` 가 사용자 기억을 지웠다.
# ⛔ 지우지 «않는» 것: 상태 폴더 ~/.elanous(로그인·로그·원장·설정) — 되돌릴 수 없으니 사람이 직접 지운다(경로만 알려 준다).
# ⛔ 서비스(launchd·systemd)를 여기서 끄지 않는다 — 이 기계의 다른 설치본이 쓸 수 있다. 켜 뒀으면 먼저 `elanous nexus uninstall --launchd|--systemd-user`.
# ⛔ install.json 이 없는 폴더는 «설치 폴더가 아니다» — 지우지 않고 멈춘다(추측으로 지우지 않는다).
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/uninstall.sh [--prefix PATH] [--keep-path] [--dry-run] [--help]
  --prefix PATH  installation root (default: $ELANOUS_INSTALL_PREFIX or ${XDG_DATA_HOME:-$HOME/.local/share}/elanous)
  --keep-path    leave the PATH block in shell startup files
  --dry-run      print what would be removed, change nothing
The state folder (~/.elanous: logins, logs, ledgers, config) is never removed here.
EOF
}

PREFIX="${ELANOUS_INSTALL_PREFIX:-${XDG_DATA_HOME:-${HOME:?HOME is required}/.local/share}/elanous}"
KEEP_PATH=0
DRY=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --prefix) [ "$#" -ge 2 ] || { echo "⛔ --prefix needs a path" >&2; exit 2; }; PREFIX="$2"; shift 2 ;;
    --keep-path) KEEP_PATH=1; shift ;;
    --dry-run) DRY=1; shift ;;
    *) echo "⛔ unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

STATE_DIR="$HOME/.elanous"
PREFIX="${PREFIX%/}"
case "$PREFIX" in
  ""|"/"|"$HOME"|"$STATE_DIR") echo "⛔ refusing to remove $PREFIX — not an installation root" >&2; exit 2 ;;
esac
if [ ! -f "$PREFIX/install.json" ]; then
  echo "⛔ no install.json in $PREFIX — not a elanous installation made by install.sh (nothing removed)" >&2
  exit 2
fi

MARKER_START='# >>> elanous installer PATH >>>'
MARKER_END='# <<< elanous installer PATH <<<'
STARTUPS=()
for f in "${ELANOUS_SHELL_STARTUP:-}" "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
  [ -n "$f" ] && [ -f "$f" ] && grep -Fqx "$MARKER_START" "$f" && STARTUPS+=("$f")
done

echo "remove: $PREFIX/{versions,current,bin,install.json}"
if [ "$KEEP_PATH" -eq 0 ]; then for f in "${STARTUPS[@]+"${STARTUPS[@]}"}"; do echo "remove PATH block: $f"; done; fi
if [ "$DRY" -eq 1 ]; then echo "(dry run — nothing changed)"; exit 0; fi

rm -rf -- "${PREFIX:?}/versions" "$PREFIX/current" "$PREFIX/install.json"
# bin may contain a different eln (or other user commands); remove only our marked alias.
ELN="$PREFIX/bin/eln"
if [ -f "$ELN" ] && [ ! -L "$ELN" ] && [ "$(sed -n '2p' "$ELN")" = '# elanous-wrapper' ]; then
  rm -f -- "$ELN"
fi
rm -f -- "$PREFIX/bin/elanous" "$PREFIX/bin/bun"
rmdir -- "$PREFIX/bin" 2>/dev/null || true
KEPT=""
if ! rmdir -- "$PREFIX" 2>/dev/null; then KEPT="$(ls -A -- "$PREFIX" 2>/dev/null | tr '\n' ' ')"; fi
if [ "$KEEP_PATH" -eq 0 ]; then
  for f in "${STARTUPS[@]+"${STARTUPS[@]}"}"; do
    tmp="$(mktemp "${TMPDIR:-/tmp}/elanous-uninstall.XXXXXX")"
    awk -v s="$MARKER_START" -v e="$MARKER_END" '$0==s{skip=1;next} skip&&$0==e{skip=0;next} !skip{print}' "$f" > "$tmp"
    cat "$tmp" > "$f" && rm -f "$tmp"
  done
fi

echo "Uninstalled elanous from $PREFIX"
if [ -n "$KEPT" ]; then
  echo "  kept in $PREFIX: ${KEPT% } — not part of the installation (memory/ holds your memories) — remove it yourself if you want"
fi
if [ -d "$STATE_DIR" ]; then
  echo "  kept state: $STATE_DIR (logins, logs, ledgers, config) — remove it yourself if you want a clean slate"
fi
echo "  if you installed the background service: elanous nexus uninstall --launchd (macOS) or --systemd-user (Linux) — run it before uninstalling next time"
