#!/usr/bin/env bash
# 🔐 **`gws` 를 «안전하게» 부르는 한 자리** — ⛔ 이 셸의 함정 둘을 여기서 «한 번만» 막는다.
#
#   bash scripts/google/gws-safe.sh gmail users messages list --params '{"userId":"me"}'
#
# ⛔⭐ **함정 ①: 프록시** — 이 셸엔 HTTPS_PROXY 가 걸려 있고 `gws` 가 그것을 통과 못 한다
#    (문면: "tunnel error: unsuccessful"). ⇒ 프록시를 «빼고» 부른다.
#    🚨 이 한 줄이 없으면 범위가 멀쩡해도 ***401 로 「인증 실패」처럼 보인다*** — 2026-08-26 에 그렇게 오진할 뻔했다.
#
# ⛔⭐ **함정 ②: 머리말** — `gws` 는 "Using keyring backend …" 를 stdout 에 «섞는다».
#    그대로 파서에 주면 JSON 파싱이 죽고, ***그 죽음이 「API 실패」처럼 보인다***(32차에 실제로 그랬다).
#    ⇒ 첫 `{` 또는 `[` «부터» 잘라 낸다. `grep -v` 로 한 줄만 거르는 것으로는 부족했다.
#
# 📌 **왜 이 파일이 «따로» 있나**: 이 지식이 `scripts/botlab/assistant-google.sh` «안»에만 있었다.
#    Google 을 쓰는 두 번째 소비자(스킬)를 만들면서 ***복제하지 않으려고*** 뽑았다.
#    ⛔ 새 소비자는 이 파일을 «부른다» — gws 를 직접 부르지 마라.
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "⛔ 인자가 «없다» — gws 에 넘길 명령을 그대로 준다." >&2
  echo "   예: bash scripts/google/gws-safe.sh gmail users messages list --params '{\"userId\":\"me\"}'" >&2
  exit 2
fi

# ⛔⭐⭐ **크론의 `PATH` 에는 `gws` 도 `node` 도 «없다»** — 이 저장소가 «여섯 번째» 밟은 자리다.
#    🚨 2026-08-29 실측: 아침 07:30 회차가 `gws 를 못 찾았다` ×3 으로 죽었다. 손으로 돌리면 «된다».
#    ⛔⛔ 그리고 ***절대 경로만으로는 부족하다*** — `gws` 의 shebang 이 `#!/usr/bin/env node` 라
#       node 가 PATH 에 없으면 ***rc=127***이다(매뉴얼의 ④ 「있는데도 안 된다」 층).
#       📏 반증: `env -i PATH=/usr/bin:/bin <절대경로>/gws --help` ⇒ rc=127 ·
#              그 디렉터리를 PATH 에 넣으면 ⇒ rc=0.
#    ⇒ 그래서 ⓐ 실물로 «찾고» ⓑ ***찾은 것의 디렉터리를 PATH 에 넣는다***(node 가 그 옆에 산다).
resolve_gws_bin() {
  local candidate
  # ⛔⭐ **명시값은 «그것만» 쓴다** — 「이것을 써라」이지 「여기부터 찾아라」가 아니다.
  #    🚨 첫 판은 명시값이 없을 때 자동 탐색으로 «흘러내려» 갔고, 그 바람에
  #       ***「gws 가 없다」는 상황을 시험이 만들 수 없었다***(시험이 즉시 잡았다).
  if [ -n "${ELANOUS_GWS_BIN:-}" ]; then
    if [ -x "$ELANOUS_GWS_BIN" ]; then printf '%s\n' "$ELANOUS_GWS_BIN"; return 0; fi
    if command -v "$ELANOUS_GWS_BIN" >/dev/null 2>&1; then command -v "$ELANOUS_GWS_BIN"; return 0; fi
    return 0   # ⛔ 명시했는데 없으면 «없는 것»이다 — 다른 데서 찾지 않는다
  fi
  if command -v gws >/dev/null 2>&1; then command -v gws; return 0; fi
  # ⛔ nvm 은 «버전 디렉터리»가 바뀐다 — 경로를 박지 않고 훑는다(사전순 마지막 = 대개 최신).
  for candidate in "$HOME"/.nvm/versions/node/*/bin/gws /opt/homebrew/bin/gws /usr/local/bin/gws; do
    [ -x "$candidate" ] && printf '%s\n' "$candidate"
  done | tail -1
}
GWS_BIN="$(resolve_gws_bin)"
if [ -z "$GWS_BIN" ]; then
  echo "⛔ gws 를 «못 찾았다»(${ELANOUS_GWS_BIN:-gws}) — 「Google 이 안 된다」가 아니라 ***이 기계에 그 CLI 가 없다***." >&2
  echo "   본 곳: \$ELANOUS_GWS_BIN · PATH · ~/.nvm/versions/node/*/bin · /opt/homebrew/bin · /usr/local/bin" >&2
  exit 3
fi
# ⛔ 「찾았다」로 끝내지 않는다 — 그 옆의 node 를 쓸 수 있게 «뒤»에 붙인다.
#    ⚠️ «뒤»인 이유: 부르는 쪽이 준 PATH(시험의 가짜들)를 밀지 않기 위해서다.
GWS_DIR="$(cd "$(dirname "$GWS_BIN")" 2>/dev/null && pwd)" || GWS_DIR=""
[ -n "$GWS_DIR" ] && export PATH="$PATH:$GWS_DIR"

# ⛔⭐⭐⭐ **열쇠고리(Keychain)를 «쓰는» 순간 크론이 죽는다 — 그래서 저장소를 «파일»로 못 박는다.**
#    🚨 2026-08-29(36차) 실측 · ***크론 회차의 전체 문면이 스스로 답을 말했다***:
#       401 Authentication failed: Failed to get token:
#           Error while setting token in cache: OS keyring failed:
#           Platform secure storage failure: ***User interaction is not allowed.***
#           ⇒ Set GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file to use file storage.
#    ⇒ 🔑 인증은 «됐고», 갱신한 토큰을 ***Keychain 에 «쓰다가»*** 죽는다. 크론은 비대화형이라
#       그 쓰기에 필요한 사용자 확인을 못 받는다. ⛔ 「로그인이 안 됐다」가 아니다.
#
#    ⛔⭐⭐ **그리고 이 축은 `env` 로 «재현되지 않는다»** — 36차가 실제로 속았다:
#       `env -i PATH=/usr/bin:/bin …` 로 돌리면 ***성공한다***(같은 시각 크론은 실패).
#       ***보안 세션은 환경변수를 따라오지 않기 때문***이다. ⇒ 「크론과 같은 PATH 로 돌려 봤다」는
#       크론 판정이 «아니다». 판정은 ***진짜 크론 회차***로만 한다(RFC §27c ④ 가 옳았다 · 두 번).
#
#    ⚖️ **보안 결정**: 파일 저장소는 열쇠를 Keychain 대신 «파일»에 둔다. 이 기계는 이미 같은 계급의
#       결정을 한 번 했다(`~/.config/gws/credentials.json` 평문 · 대표 승인 2026-08-29). 그 디렉터리는
#       `drwx------`(0700)이다. ⛔ 명시값이 있으면 «그것을» 존중한다 — 여기서 덮어쓰지 않는다.
export GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND="${GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND:-file}"

# ⛔ 그래도 열쇠고리 오류가 나면 «이름을 대고» 말한다 — 조용히 401 로 흘리지 않는다.
diagnose_keyring_401() {
  {
    echo "⛔⭐ 이 401 은 «로그인 실패»가 아니다 — 토큰을 ***저장소에 쓰다가*** 죽었다."
    echo "     지금 백엔드: GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=${GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND:-(비어 있다)}"
    echo "     ⇒ 이 값이 file 이 «아니면» 누가 밖에서 덮어쓴 것이다(이 파일은 file 을 기본으로 준다)."
    echo "     ⇒ file 인데도 났다면 ~/.config/gws 의 쓰기 권한을 봐라(0700 이어야 한다)."
    echo "   ⛔ 「사람이 다시 로그인하면 된다」로 읽지 마라 — 그 로그인은 이미 돼 있다."
  } >&2
}

# ⛔⭐⭐ **403 을 「범위 부족」으로만 읽지 않는다 — «왜» 그 자격인지가 다른 층에 있다.**
#    🚨 2026-08-29 실측 · 외부 문서로 확인(deepwiki googleworkspace/cli 2.2-authentication):
#       gws 의 자격 해결 순서는 ***TOKEN/CREDENTIALS_FILE → credentials.enc → credentials.json → ADC*** 이고,
#       토큰 캐시는 AES-256-GCM 이며 ***그 열쇠가 OS keyring(macOS Keychain)에 산다***.
#    ⇒ 그래서 Keychain 을 «못 읽는» 세션(크론 · 에이전트 하위 프로세스)에서는
#       ***조용히 ADC 로 폴백***하고, ADC 는 gcloud 공용 클라이언트라 Gmail 같은 민감 범위가
#       «이미 차단»돼 있어 ***403 insufficientPermissions*** 가 난다.
#    📏 이 기계에서 잰 것: `gws auth status` ⇒ `storage=none` · `keyring_backend=keyring` ·
#       `token_cache_exists=true` ⊕ `security find-generic-password -s gws-cli -w` 가 ***프롬프트에 걸려 rc=124***.
#    ⛔ 그러니 「사람이 로그인만 하면 된다」로 안내하면 «틀린 길»로 보낸다 — 그 로그인은 이미 돼 있었다.
diagnose_403() {
  local storage
  storage="$("$GWS_BIN" auth status 2>/dev/null \
    | sed -n 's/.*"storage" *: *"\([^"]*\)".*/\1/p' | head -1)"
  [ "$storage" = "none" ] || return 0
  {
    echo "⛔⭐ 그런데 이 403 은 «범위만»의 문제가 아닐 수 있다 — 자격 저장소를 «못 읽고» 있다:"
    echo "     gws auth status ⇒ storage=none (keyring 을 못 읽었다) ⇒ ***ADC 로 폴백***한 것이다."
    echo "     ADC 는 gcloud 공용 클라이언트라 Gmail 등 민감 범위가 «이미 차단»돼 있다."
    echo "   ⇒ 사람이 «자기 터미널»에서 한 번(크론·에이전트도 읽을 수 있게 «파일»로 내린다):"
    echo "       gws auth export --unmasked > ~/.config/gws/credentials.json && chmod 600 ~/.config/gws/credentials.json"
    echo "     ⛔ 그 파일은 «평문 자격»이다 — 두는 것 자체가 보안 결정이다(0600 필수)."
  } >&2
}

# ── 🚧 쓰기 관문 ────────────────────────────────────────────────────────────
# ⛔⭐⭐ ***되돌릴 수 없는 것을 «규율»로만 막지 않는다.***
#    `google-workspace` 스킬의 SKILL.md 가 「명시 없으면 초안까지」라고 «부탁»하지만,
#    그것은 프롬프트다 — ***관문이 아니다***. 메일 전송·일정 삭제는 되돌릴 길이 «없다».
#    📌 브라우저 축이 같은 자리에서 같은 답을 냈다(`decideReversibility` · `actionHosts`).
#
# ⭐ **이름을 짐작하지 않는다** — Google 이 «스스로» 말한다:
#      gws schema <service.resource.method>  ⇒  "httpMethod": "GET" | "POST" | "DELETE" | …
#    📏 실측 2026-08-28: 이 조회는 ***지역*** 이다(죽은 프록시로도 답한다) · 165~181ms.
#
# ⛔ 모르면 «막는다» — 「모른다」를 「괜찮다」로 읽지 않는다(브라우저 축의 ClickKind 와 같은 규율).
gws_write_gate() {
  # gws <service> <resource> [sub-resource] <method> [flags] — 첫 «플래그» 앞까지가 위치 인자다.
  local -a pos=()
  local a
  for a in "$@"; do
    case "$a" in -*) break ;; *) pos+=("$a") ;; esac
  done
  # `schema` 자체는 조회다 — 그리고 위치 인자가 모자라면 gws 가 스스로 거절한다.
  if [ "${#pos[@]}" -lt 2 ] || [ "${pos[0]}" = "schema" ] || [ "${pos[0]}" = "auth" ]; then return 0; fi

  local path
  path=$(IFS=.; echo "${pos[*]}")
  local http
  http=$(env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy \
    "$GWS_BIN" schema "$path" 2>/dev/null \
    | sed -n '/^[[{]/,$p' \
    | python3 -c 'import sys,json
try: print((json.load(sys.stdin) or {}).get("httpMethod") or "")
except Exception: print("")' 2>/dev/null)

  case "$http" in
    GET|HEAD) return 0 ;;
    "")
      echo "⛔ 이 호출이 «읽기인지 쓰기인지» 못 알아냈다(schema $path 가 httpMethod 를 안 냈다)." >&2
      echo "   ⇒ 「모른다」를 「괜찮다」로 읽지 않는다. 읽기라면 경로를 확인하고, 쓰기라면 아래를 보라." >&2
      ;;
    *)
      echo "⛔ 이것은 «쓰기»다($http $path) — ***되돌릴 길이 없다***." >&2
      ;;
  esac
  echo "   사람이 그 «한 번»을 명시로 열어야 한다:  ELANOUS_GWS_ALLOW_WRITE=1 <같은 명령>" >&2
  return 1
}

if [ "${ELANOUS_GWS_ALLOW_WRITE:-}" != "1" ]; then
  gws_write_gate "$@" || exit 4
fi

# ⛔ 산출을 «한 번» 담는다 — 403 이면 그 «이유»를 같이 내야 하기 때문이다(diagnose_403).
#    ⚠️ 담지 않으면 파이프 뒤에서 그 판정을 할 수 없다. gws 응답은 작아 이 비용이 싸다.
GWS_RAW="$(env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy \
  "$GWS_BIN" "$@" 2>&1)"
GWS_RC=$?
printf '%s\n' "$GWS_RAW" | sed -n '/^[[{]/,$p'

# ⛔⭐ 403 을 «그냥 흘려보내지 않는다» — 자격 저장소를 못 읽어 ADC 로 폴백한 것일 수 있다.
#    📌 그 갈림이 없으면 「사람이 로그인만 하면 된다」는 «틀린 길»로 안내하게 된다.
case "$GWS_RAW" in *'"code": 403'*|*'"code":403'*) diagnose_403 ;; esac

# ⛔⭐ 401 + 열쇠고리 문면이면 «다른 병»이다 — 403(범위·ADC 폴백)과 갈라서 말한다.
case "$GWS_RAW" in *'OS keyring failed'*|*'secure storage failure'*) diagnose_keyring_401 ;; esac

exit "$GWS_RC"
