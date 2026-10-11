# shellcheck shell=bash
# 리눅스 노드 갈래 — node-setup.sh 가 원격 `uname -s` = Linux 일 때 source 한다(WORKER-WSL-LINUX-POOL · OP 2026-10-11 host-e-wsl 실측).
#   맥 갈래(brew·OrbStack·Chrome·~/.zshenv) 대신: apt 기본 패키지 · systemd · docker-ce(공식 apt) · docker 서비스·그룹 · ~/.docker-fleet(빈 currentContext)
#   · k3d(공식 install.sh) · kubectl(k3s 와 같은 판 · sha256 검증) · nodejs(codex CLI 셔뱅) · codex CLI(이 맥과 같은 판) · 미러(HEAD=main).
#   bun · 레지스트리 · 클러스터 · kubeconfig · 정책 · DNS · 판 대조는 맥과 «같은» 단계를 탄다(node-setup.sh).
# ⭐ 단계마다 «이미 돼 있으면 건너뛴다»(멱등) · --check 면 바꾸지 않고 → 할 일만.
# ⛔ sudo 는 «sudo -n» 으로만 — 비대화형 ssh 에서 비번을 묻고 멈추지 않는다(묻으면 ✗ ⊕ 사람이 칠 명령).
# ⛔ 코드 밖(윈도우 Startup .cmd · .wslconfig · 자격 · codexHome)은 실행하지 않는다 — linux_handoff 가 «사람 손 할 일»로 출력만.
# 아키텍처가 이 맥과 다르다(x86_64) → Pod 이미지는 그 노드에서 `ELANOUS_BUILD_REMOTE=<호스트>` 로 굽는다(맥 arm64 이미지 못 씀).

KUBECTL_VER="${ELANOUS_FLEET_KUBECTL_VERSION:-${K3S_IMAGE##*:}}"; KUBECTL_VER="${KUBECTL_VER%%-k3s*}"   # 풀의 k3s 와 같은 판
CODEX_VER="${ELANOUS_FLEET_CODEX_VERSION:-$(codex --version 2>/dev/null | awk '{print $NF}')}"          # 이 맥과 같은 판
APT_BASE="ca-certificates curl unzip git python3"                                                        # unzip = bun 설치기

linux_base() {
  ok "OS Linux $(R 'uname -m' 2>/dev/null)$(R '. /etc/os-release 2>/dev/null && printf " · %s" "$PRETTY_NAME"' 2>/dev/null)"
  # L1. apt 기본 패키지
  if R 'for c in curl unzip git python3; do command -v $c >/dev/null || exit 1; done'; then ok "기본 패키지(curl·unzip·git·python3)"
  elif [ $CHECK = 1 ]; then todo "apt 기본 패키지($APT_BASE)"
  else R "{ sudo -n apt-get update -qq && sudo -n apt-get install -y -qq $APT_BASE; } >/tmp/fleet-apt.log 2>&1" && ok "기본 패키지 (설치)" || bad "기본 패키지 설치 실패 — 원격 /tmp/fleet-apt.log (sudo 비번이면 사람이: sudo apt-get install -y $APT_BASE)"; fi
  # L2. systemd — docker·containerd 를 서비스로 띄우려면 PID 1 이 systemd 여야 한다(WSL 은 /etc/wsl.conf 로 켠다).
  if R 'test "$(ps -p 1 -o comm= 2>/dev/null)" = systemd'; then ok "systemd (PID 1)"
  else bad "systemd 가 PID 1 이 아니다 — WSL 이면 /etc/wsl.conf 에 [boot] systemd=true 뒤 wsl --shutdown(사람이)"; fi
  # L3. docker — Docker Desktop shim 이면 멈춘다: 엔진이 윈도우 쪽 Desktop VM 이라 k3d 풀이 그 VM 에 뜬다(배포판 안 docker-ce 가 아니다).
  SHIM="$(R 'p=$(command -v docker 2>/dev/null) && case "$(readlink -f "$p")" in /mnt/wsl/*|*docker-desktop*) echo shim;; esac; docker info --format "{{.OperatingSystem}}" 2>/dev/null | grep -qi "docker desktop" && echo shim' 2>/dev/null)"
  if [ -n "$SHIM" ]; then bad "docker 가 Docker Desktop shim 이다 — Desktop 설정에서 이 배포판의 WSL integration 을 끄고(사람이) 다시 돌리면 docker-ce 를 깐다"; echo; echo "✗ $HOST 미완 — 위 ✗ 를 먼저"; exit 1; fi
  LX_DOCKER_PENDING=0
  if R 'command -v dockerd >/dev/null && dpkg -s docker-ce >/dev/null 2>&1'; then ok "docker-ce (apt)"
  elif [ $CHECK = 1 ]; then todo "docker-ce 설치(공식 apt 저장소 · docker-ce·cli·containerd.io·buildx)"; LX_DOCKER_PENDING=1
  else R '{ sudo -n install -m 0755 -d /etc/apt/keyrings && . /etc/os-release && sudo -n curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc && sudo -n chmod a+r /etc/apt/keyrings/docker.asc && printf "Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n" "$ID" "$VERSION_CODENAME" "$(dpkg --print-architecture)" | sudo -n tee /etc/apt/sources.list.d/docker.sources >/dev/null && sudo -n apt-get update -qq && sudo -n apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin; } >/tmp/fleet-docker-apt.log 2>&1' && ok "docker-ce (설치 · 공식 apt)" || { bad "docker-ce 설치 실패 — 원격 /tmp/fleet-docker-apt.log (sudo 비번이면 사람이)"; LX_DOCKER_PENDING=1; }; fi
  if R 'systemctl is-enabled docker containerd >/dev/null 2>&1 && systemctl is-active docker containerd >/dev/null 2>&1'; then ok "docker·containerd 서비스(enable · active)"
  elif [ $CHECK = 1 ]; then todo "systemctl enable --now docker containerd"; LX_DOCKER_PENDING=1
  else R 'sudo -n systemctl enable --now docker containerd >/tmp/fleet-docker-svc.log 2>&1' && ok "docker·containerd 서비스 (enable --now)" || { bad "docker 서비스 기동 실패 — 원격 /tmp/fleet-docker-svc.log"; LX_DOCKER_PENDING=1; }; fi
  # 그룹은 «그룹 db»로 잰다(id -nG <사용자>) — 지금 세션 그룹이 아니라 다음 ssh 연결이 받을 그룹.
  if R 'id -nG "$(id -un)" | tr " " "\n" | grep -qx docker'; then ok "docker 그룹"
  elif [ $CHECK = 1 ]; then todo "usermod -aG docker <사용자>"; LX_DOCKER_PENDING=1
  else R 'sudo -n usermod -aG docker "$(id -un)"' && ok "docker 그룹 (추가 · 새 ssh 연결부터)" || { bad "docker 그룹 추가 실패"; LX_DOCKER_PENDING=1; }; fi
  if R 'docker info --format "{{.ServerVersion}}"' >/dev/null 2>&1; then ok "docker $(R 'docker info --format "{{.ServerVersion}} cpu={{.NCPU}} mem={{.MemTotal}}"')"
  elif [ $LX_DOCKER_PENDING = 0 ]; then bad "docker 엔진에 못 붙는다(설치·서비스·그룹은 됐다)"; fi
  # L4. 플릿 docker 설정 — 리눅스엔 키체인이 없어도 같은 DOCKER_CONFIG 를 쓴다(build.sh ELANOUS_BUILD_REMOTE). 빈 currentContext = 기본 소켓 · buildx 는 시스템 플러그인.
  if R 'test -f ~/.docker-fleet/config.json && DOCKER_CONFIG=~/.docker-fleet docker info >/dev/null 2>&1 && DOCKER_CONFIG=~/.docker-fleet docker buildx version >/dev/null 2>&1'; then ok "플릿 docker 설정(~/.docker-fleet · buildx)"
  elif [ $CHECK = 1 ]; then todo "~/.docker-fleet(빈 currentContext)"
  else R 'mkdir -p ~/.docker-fleet && { test -f ~/.docker-fleet/config.json || printf "{\"currentContext\": \"\"}\n" > ~/.docker-fleet/config.json; }'
    R 'DOCKER_CONFIG=~/.docker-fleet docker info >/dev/null 2>&1 && DOCKER_CONFIG=~/.docker-fleet docker buildx version >/dev/null 2>&1' && ok "플릿 docker 설정 (~/.docker-fleet 생성 · buildx)" || bad "플릿 docker 설정으로 docker 에 못 붙는다"; fi
}

linux_tools() {
  # L5. k3d — 공식 설치 스크립트(/usr/local/bin)
  if R 'command -v k3d' >/dev/null; then ok "k3d $(R 'k3d version | head -1 | cut -d" " -f3')"
  elif [ $CHECK = 1 ]; then todo "k3d 설치(공식 install.sh)"
  else R 'curl -fsSL https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | sudo -n bash >/tmp/fleet-k3d.log 2>&1' && R 'command -v k3d' >/dev/null && ok "k3d (설치)" || bad "k3d 설치 실패 — 원격 /tmp/fleet-k3d.log"; fi
  # L6. kubectl — 클러스터와 같은 판 · sha256 이 맞을 때만 설치한다(원격 클러스터 점검이 이것을 쓴다).
  kv="$(R 'kubectl version --client -o json 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)[\"clientVersion\"][\"gitVersion\"])"' 2>/dev/null)"
  if [ "$kv" = "$KUBECTL_VER" ]; then ok "kubectl $kv"
  elif [ $CHECK = 1 ]; then todo "kubectl $KUBECTL_VER 설치(지금 ${kv:-없음} · sha256 검증)"
  else R "{ a=\$(dpkg --print-architecture) && mkdir -p /tmp/fleet-kubectl-$KUBECTL_VER && cd /tmp/fleet-kubectl-$KUBECTL_VER && curl -fsSLo kubectl https://dl.k8s.io/release/$KUBECTL_VER/bin/linux/\$a/kubectl && curl -fsSLo kubectl.sha256 https://dl.k8s.io/release/$KUBECTL_VER/bin/linux/\$a/kubectl.sha256 && echo \"\$(cat kubectl.sha256)  kubectl\" | sha256sum --check && sudo -n install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl; } >/tmp/fleet-kubectl.log 2>&1"
    kv="$(R 'kubectl version --client -o json 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)[\"clientVersion\"][\"gitVersion\"])"' 2>/dev/null)"
    [ "$kv" = "$KUBECTL_VER" ] && ok "kubectl $kv (설치 · sha256 검증)" || bad "kubectl $KUBECTL_VER 설치 실패(sha256 이 틀리면 설치 안 함) — 원격 /tmp/fleet-kubectl.log"; fi
  # L7. nodejs — codex CLI 가 node 셔뱅이다(없으면 usage 가 «app-server exited» 로 죽는다).
  if R 'command -v node' >/dev/null; then ok "node $(R 'node --version')"
  elif [ $CHECK = 1 ]; then todo "nodejs 설치(apt · codex CLI 셔뱅)"
  else R 'sudo -n apt-get install -y -qq nodejs >/tmp/fleet-node.log 2>&1' && R 'command -v node' >/dev/null && ok "node (설치 · apt)" || bad "nodejs 설치 실패 — 원격 /tmp/fleet-node.log"; fi
  # L8. codex CLI — 이 맥과 같은 판(bun 전역)
  cv="$(R 'codex --version 2>/dev/null' 2>/dev/null | awk '{print $NF}')"
  if [ -n "$cv" ] && { [ -z "$CODEX_VER" ] || [ "$cv" = "$CODEX_VER" ]; }; then ok "codex $cv"
  elif [ $CHECK = 1 ]; then todo "codex CLI ${CODEX_VER:-?} (지금 ${cv:-없음} · bun add -g @openai/codex@<이 맥 판>)"
  elif [ -z "$CODEX_VER" ]; then bad "이 맥에 codex 가 없어 판을 모른다 — ELANOUS_FLEET_CODEX_VERSION 으로 준다"
  else R "bun add -g @openai/codex@$CODEX_VER >/tmp/fleet-codex.log 2>&1"; cv="$(R 'codex --version 2>/dev/null' 2>/dev/null | awk '{print $NF}')"
    [ "$cv" = "$CODEX_VER" ] && ok "codex $cv (설치)" || bad "codex $CODEX_VER 설치 실패 — 원격 /tmp/fleet-codex.log"; fi
}

# tailnet 이름 — 인자(ELANOUS_FLEET_TSNAME)가 먼저 · 없으면 원격 tailscale(맥 갈래와 같은 명령) · WSL 이면 윈도우 쪽 tailscale.exe.
linux_tsname() {
  if [ -n "${ELANOUS_FLEET_TSNAME:-}" ]; then TSNAME="$ELANOUS_FLEET_TSNAME"; return; fi
  [ -n "$TSNAME" ] || TSNAME="$(R 'tailscale.exe status --self --json 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)[\"Self\"][\"DNSName\"].rstrip(\".\"))"' 2>/dev/null)"
}

# 미러 — HEAD 는 main(기본 master 면 첫 clone 이 깨진다). 이미 있고 HEAD 가 master 면 symbolic-ref 만 고친다(객체는 안 건드린다).
linux_mirror() {
  if R "test -d ~/mirror/elanous-agent.git"; then
    if [ "$(R 'git --git-dir="$HOME/mirror/elanous-agent.git" symbolic-ref HEAD 2>/dev/null')" = refs/heads/main ]; then ok "호스트 git 미러 ~/mirror/elanous-agent.git (HEAD=main)"
    elif [ $CHECK = 1 ]; then todo "호스트 git 미러 HEAD 를 main 으로(git symbolic-ref HEAD refs/heads/main)"
    else R 'git --git-dir="$HOME/mirror/elanous-agent.git" symbolic-ref HEAD refs/heads/main' && ok "호스트 git 미러 (HEAD=main 으로 고침)" || bad "미러 HEAD 고치기 실패"; fi
  elif [ $CHECK = 1 ]; then todo "호스트 git 미러 ~/mirror/elanous-agent.git 생성(git init --bare -b main) ⊕ 이 맥에서 첫 push"
  else R "mkdir -p ~/mirror && git init -q --bare -b main ~/mirror/elanous-agent.git" && ok "호스트 git 미러 (생성 · HEAD=main · 첫 push 는 이 맥 크론)" || { bad "미러 생성 실패"; exit 1; }; fi
}

# 코드 밖 — 실행하지 않는다. 자격은 «어디에 무엇»만 적고 값을 읽거나 옮기지 않는다.
linux_handoff() {
  echo
  echo "✋ 사람 손 할 일 (코드 밖 · 이 스크립트는 실행하지 않는다)"
  echo "  1. 윈도우 Startup 폴더에 .cmd — wsl.exe -d <배포판 이름> (⚠️ 기본 배포판이 docker-desktop 일 수 있다 — -d 필수)"
  echo "  2. %UserProfile%\\.wslconfig — [wsl2] memory=40GB · vmIdleTimeout=-1 (뒤 wsl --shutdown)"
  echo "  3. 자격(대표 승인 뒤 · 값은 사람이 옮긴다): Pod Secret 둘 · ~/.cache/{openrouter,zai}_api_key · ~/.grok/auth.json · codex = ~/.elanous/auth.json 의 openai-codex* ⊕ ~/.codex*/auth.json"
  echo "  4. codexHome 경로를 리눅스 홈(/home/<사용자>/…)으로 — 맥 경로 그대로면 usage 가 «authentication required»"
  echo "  5. Pod 이미지는 이 노드에서 굽는다 — ELANOUS_BUILD_REMOTE=$HOST (x86_64 · 맥 arm64 이미지 못 씀)"
}
