#!/usr/bin/env bash
# 🔑 API 키 하나를 «이 기계 규약»에 맞게 끝까지 세팅한다 — 키만 입력하면 된다.
#
# 대표 2026-09-23: *"readkey 등으로 제가 키만 입력가능하면 다 셋팅되는 명령어 셋트로"*
#
# 이 기계의 규약은 «자리가 셋»이다:
#   ⓵ ~/.cache/<파일>                          — 값이 사는 곳 (chmod 600)
#   ⓶ ~/.config/api-key-setup/api-keys.zsh     — `_mk_key <ENV> "${cache_dir}/<파일>"`
#                                                 (~/.zshrc:119 가 이 파일을 source 한다)
#   ⓷ .../refresh_api_key_cache.sh             — AWS Secrets Manager → 다른 기계로 전파
#                                                 ⚠️ 선택 · AWS 접근 ⊕ «비밀이 거기 있어야» 한다
#
# ⛔ 이 스크립트는 ⓵⓶ 만 한다. ⓷ 는 «줄만 알려주고» 자동으로 «안» 넣는다 —
#    AWS 에 비밀이 없는 상태로 그 줄을 넣으면 그 스크립트가 `set -e` 라
#    ***다른 키 갱신까지 멈춘다.***
#
# 쓰기:
#   bash scripts/add-api-key.sh OPENROUTER_API_KEY
#   bash scripts/add-api-key.sh OPENROUTER_API_KEY --check-url https://openrouter.ai/api/v1/key
#   printf '%s' '<키>' | bash scripts/add-api-key.sh OPENROUTER_API_KEY     # 파이프
#
# ⛔ 값은 화면에 «절대» 안 찍는다 — 길이와 앞 4자만.
set -uo pipefail

CACHE_DIR="${ELANOUS_KEY_CACHE_DIR:-$HOME/.cache}"
LOADER="${ELANOUS_KEY_LOADER:-$HOME/.config/api-key-setup/api-keys.zsh}"

ENV_NAME="${1:-}"
shift || true
FILE_NAME=""
CHECK_URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --file) FILE_NAME="${2:-}"; shift 2 ;;
    --check-url) CHECK_URL="${2:-}"; shift 2 ;;
    *) echo "⛔ 모르는 인자: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$ENV_NAME" ]; then
  echo "쓰기: bash scripts/add-api-key.sh <ENV_NAME> [--file <캐시파일명>] [--check-url <URL>]" >&2
  echo "예  : bash scripts/add-api-key.sh OPENROUTER_API_KEY" >&2
  exit 2
fi

# ⛔⭐ 2026-09-23 실측 결함 — ***`case "$ENV_NAME" in [A-Z]*)` 가 «소문자도 물었다».***
#   로케일 collation 에서 `[A-Z]` 가 a-z 를 포함할 수 있다(전형적인 셸 함정).
#   ⇒ 문자 «범위» 대신 «명시 집합»으로 판정한다.
if ! printf '%s' "$ENV_NAME" | grep -qE '^[ABCDEFGHIJKLMNOPQRSTUVWXYZ][ABCDEFGHIJKLMNOPQRSTUVWXYZ0-9_]*$'; then
  echo "⛔ ENV_NAME 은 «대문자·숫자·밑줄»만 쓴다(예: OPENROUTER_API_KEY): $ENV_NAME" >&2
  exit 2
fi

[ -n "$FILE_NAME" ] || FILE_NAME="$(printf '%s' "$ENV_NAME" | tr '[:upper:]' '[:lower:]')"
TARGET="$CACHE_DIR/$FILE_NAME"

echo "🔑 $ENV_NAME 를 세팅한다"
echo "   캐시 파일 : $TARGET"
echo "   로더      : $LOADER"
echo ""

# ── ⓵ 키를 «가려서» 받는다 ─────────────────────────────────────────
# ⛔⭐ 2026-09-23 실측 결함 둘 — ***이 자리가 «멈췄고», 파이프가 «안 먹었다».***
#   ⑴ `ELANOUS_KEY_VALUE=""`(빈 값)로 부르면 `-n` 검사가 거짓이 돼 대화형 read 로 떨어졌고,
#      stdin 이 TTY 가 아니어서 ***영영 기다렸다***(600초 타임아웃으로 잡혔다).
#      ⇒ 「설정됨」과 「빈 값」을 «가른다»(`${VAR+set}`).
#   ⑵ `printf '%s' "$K" | …` 는 ***개행이 없어*** `read` 가 «비영 종료»를 낸다.
#      값은 들어왔는데 else 로 떨어져 「입력이 없다」를 냈다.
#      ⇒ 종료 코드가 아니라 ***「값이 들어왔나」***로 판정한다.
if [ "${ELANOUS_KEY_VALUE+set}" = "set" ]; then
  KEY="$ELANOUS_KEY_VALUE"
  echo "   (ELANOUS_KEY_VALUE 로 받음 — 비대화형)"
elif [ ! -t 0 ]; then
  IFS= read -r KEY || true
  if [ -n "${KEY:-}" ]; then
    echo "   (stdin 파이프로 받음)"
  else
    echo "⛔ 입력이 없다 — TTY 도 아니고 stdin 도 비었다." >&2
    echo "   대화형:  bash scripts/add-api-key.sh $ENV_NAME" >&2
    echo "   파이프:  printf '%s' '<키>' | bash scripts/add-api-key.sh $ENV_NAME" >&2
    exit 1
  fi
else
  printf '   키를 붙여넣고 Enter (화면에 안 보입니다): '
  IFS= read -rs KEY
  echo ""
fi
KEY="$(printf '%s' "${KEY:-}" | tr -d '\r\n')"
if [ -z "$KEY" ]; then echo "⛔ 빈 값이다 — 아무것도 안 했다." >&2; exit 1; fi

mkdir -p "$CACHE_DIR"
if [ -s "$TARGET" ]; then
  cp "$TARGET" "$TARGET.bak-$(date +%Y%m%d-%H%M%S)"
  echo "   ⚠️ 기존 값이 있어 백업했다"
fi
printf '%s' "$KEY" > "$TARGET"
chmod 600 "$TARGET"
echo "   ✅ ⓵ 캐시 파일 (${#KEY}자 · 앞 4자 ${KEY:0:4}… · 권한 600)"

# ── ⓶ 로더에 «없으면» 한 줄 더한다 (멱등) ───────────────────────────
if [ ! -f "$LOADER" ]; then
  echo "   ⛔ ⓶ 로더가 없다: $LOADER — 줄을 직접 넣어라:" >&2
  echo "      _mk_key $ENV_NAME \"\${cache_dir}/$FILE_NAME\"" >&2
elif grep -qE "^[[:space:]]*_mk_key[[:space:]]+$ENV_NAME([[:space:]]|$)" "$LOADER"; then
  echo "   ✅ ⓶ 로더에 이미 있다 (건드리지 않음)"
else
  cp "$LOADER" "$LOADER.bak-$(date +%Y%m%d-%H%M%S)"
  LAST=$(grep -n '^_mk_key ' "$LOADER" | tail -1 | cut -d: -f1)
  LINE="_mk_key $ENV_NAME \"\${cache_dir}/$FILE_NAME\""
  if [ -n "$LAST" ]; then
    awk -v n="$LAST" -v ins="$LINE" 'NR==n{print; print ins; next} {print}' "$LOADER" > "$LOADER.tmp" \
      && mv "$LOADER.tmp" "$LOADER"
  else
    printf '\n%s\n' "$LINE" >> "$LOADER"
  fi
  echo "   ✅ ⓶ 로더에 한 줄 추가 (백업 떠 둠)"
fi

# ── ⓷ AWS 전파는 «알려주기만» ───────────────────────────────────────
REFRESH="$(dirname "$LOADER")/refresh_api_key_cache.sh"
if [ -f "$REFRESH" ] && ! grep -q "\"$ENV_NAME\"" "$REFRESH"; then
  echo ""
  echo "   🔲 ⓷ 다른 기계에도 퍼뜨리려면 — ⛔ «자동으로 안 넣었다»"
  echo "      먼저 AWS Secrets Manager 에 비밀 «${ENV_NAME}» 을 만들고, 그 «뒤»에:"
  echo "        fetch_secret \"$ENV_NAME\" \"\${CACHE_DIR}/$FILE_NAME\""
  echo "      ⚠️ 비밀이 «없는» 상태로 넣으면 그 스크립트가 set -e 라 다른 키 갱신까지 멈춘다."
fi

# ── 검증 ────────────────────────────────────────────────────────────
echo ""
echo "   ── 확인 ──"
# ⛔⭐ 2026-09-23 실측 결함 — ***`zsh -lc` 는 `.zshrc` 를 «안 읽는다».***
#   `-l`(login)은 `.zprofile`/`.zlogin` 만 읽고, 이 기계의 로더는 `.zshrc:119` 에 걸려 있다.
#   ⇒ 그 검증은 ***부모 셸에서 «상속된» 값만*** 보게 되고, 방금 넣은 키는 언제나 「안 뜬다」가 된다.
#   🩸 실제로 그 거짓 보고를 보고 30분을 「왜 안 뜨나」에 썼다. ⇒ ***대화형(`-i`)으로 연다.***
LOADED=$(zsh -ic "printf '%s' \"\${$ENV_NAME}\"" 2>/dev/null | tr -d '\r\n')
if [ "${#LOADED}" -gt 0 ]; then
  if [ "$LOADED" = "$KEY" ]; then echo "   ✅ 새 셸에서 $ENV_NAME 가 «같은 값»으로 뜬다 (${#LOADED}자)"
  else echo "   ⚠️ 새 셸의 값이 «다르다» (${#LOADED}자) — 다른 곳에서 export 하는지 보라"; fi
else
  echo "   ⚠️ 새 셸에서 «안 뜬다» — ⛔ 「키가 틀렸다」가 아니다. 로더 연결을 보라:"
  echo "      grep -n 'api-key-setup' ~/.zshrc"
fi

if [ -n "$CHECK_URL" ]; then
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 20 -H "Authorization: Bearer $KEY" "$CHECK_URL" 2>/dev/null || echo "000")
  case "$CODE" in
    200) echo "   ✅ 라이브 확인: HTTP 200" ;;
    000) echo "   ⚠️ 라이브 확인 «못 했다»(네트워크/타임아웃) — ⛔ 「키가 틀렸다」가 «아니다»" ;;
    *)   echo "   ❌ 라이브 확인: HTTP $CODE — 키를 다시 보라" ;;
  esac
fi

echo ""
echo "   📌 지금 셸에도 먹이려면:  source $LOADER"
