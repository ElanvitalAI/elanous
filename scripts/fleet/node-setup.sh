#!/bin/bash
# 로컬 플릿 노드 셋업 — 원격 맥 한 대를 «Pod 풀 ⊕ 시험 샤딩» 노드로 (MANUAL-local-fleet-node-setup).
#   bash scripts/fleet/node-setup.sh <호스트> [--check]
#   <호스트>  ssh 로 닿는 이름(예: node-b · node-c) — 이 맥에서 `ssh -o BatchMode=yes <호스트> true` 가 돼야 한다.
#   --check  아무것도 바꾸지 않고 상태만 본다(단계마다 ✓ · ✗ · → 할 일).
# ⭐ 단계마다 «이미 돼 있으면 건너뛴다» — 몇 번 돌려도 같은 결과(재현 가능한 셋업).
# ⛔ 원격의 다른 컨테이너·앱은 건드리지 않는다. 이 맥의 ~/.kube/config 는 바꾸기 전에 백업한다.
set -u
HOST="${1:?usage: node-setup.sh <host> [--check]}"; CHECK=0; [ "${2:-}" = "--check" ] && CHECK=1
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
K3S_IMAGE="${ELANOUS_FLEET_K3S_IMAGE:-rancher/k3s:v1.36.4-k3s1}"   # 풀의 모든 노드가 «같은 판» — 판이 갈리면 같은 Job 이 노드마다 다르게 돈다
API_PORT="${ELANOUS_FLEET_API_PORT:-6550}"
CLUSTER=elanous-pool; CTX="pool-$HOST"
BUN_VER="$(bun --version 2>/dev/null)"                              # 이 맥과 같은 bun
unset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy
R() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "export PATH=\$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:\$HOME/.orbstack/bin:\$PATH HOMEBREW_NO_AUTO_UPDATE=1; unset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy; $1"; }
ok() { printf '  ✓ %s\n' "$1"; }; bad() { printf '  ✗ %s\n' "$1"; FAIL=1; }; todo() { printf '  → %s\n' "$1"; TODO=$((TODO+1)); }
FAIL=0; TODO=0
echo "▶ 노드 $HOST$([ $CHECK = 1 ] && echo ' (점검만)')"

# 1. ssh
R true >/dev/null 2>&1 && ok "ssh" || { bad "ssh 불통 — 이 맥에서 ssh 키·Tailscale 확인"; exit 1; }
# 2. brew · docker(OrbStack)
R 'command -v brew' >/dev/null && ok "brew" || bad "brew 없음 — https://brew.sh 로 먼저 설치(사람이)"
if R 'docker info --format "{{.ServerVersion}}"' >/dev/null 2>&1; then ok "docker $(R 'docker info --format "{{.ServerVersion}} cpu={{.NCPU}} mem={{.MemTotal}}"')"; else bad "docker 없음·꺼짐 — OrbStack 을 설치·실행(사람이 · ⛔ OrbStack 내장 k8s 는 NetworkPolicy 를 집행 안 한다 · k3d 를 쓴다)"; fi
# 2b. ssh 비로그인 PATH — zsh 는 비대화형 ssh 명령에서도 ~/.zshenv 를 읽는다. 여기에 brew·docker·OrbStack 경로를 둔다.
#     그래야 `DOCKER_HOST=ssh://<호스트>` 와 원격 명령이 PATH 우회 없이 docker·k3d 를 찾는다(09-25: 기본 PATH 는 /usr/bin:/bin:/usr/sbin:/sbin 뿐이었다).
if ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" 'command -v docker >/dev/null && command -v brew >/dev/null'; then ok "ssh 비로그인 PATH(docker·brew)"
elif [ $CHECK = 1 ]; then todo "~/.zshenv 에 PATH 블록(비로그인 ssh 가 docker·brew 를 찾게)"
elif [ "$(R 'basename "$SHELL"')" != "zsh" ]; then bad "기본 셸이 zsh 가 아니다 — 비로그인 PATH 를 손으로(사람이)"
else R 'grep -q ">>> elanous fleet >>>" ~/.zshenv 2>/dev/null || printf "%s\n" "# >>> elanous fleet >>> (scripts/fleet/node-setup.sh · 비로그인 ssh 가 docker·brew·k3d 를 찾게)" "export PATH=\"/opt/homebrew/bin:/usr/local/bin:\$HOME/.orbstack/bin:\$PATH\"" "# <<< elanous fleet <<<" >> ~/.zshenv'
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" 'command -v docker >/dev/null' && ok "ssh 비로그인 PATH (~/.zshenv 블록 추가)" || bad "~/.zshenv 를 넣었는데도 docker 를 못 찾는다"; fi
# 2c. 플릿 전용 docker 설정 — 기본 설정이 자격을 macOS 키체인(credsStore)에서 꺼내면 비대화형 ssh 에선 키체인이 잠겨 공개 이미지 받기도 막힌다(09-25 node-c).
#     ~/.docker-fleet = 자격 저장소 없이 «현재 컨텍스트»만 그대로 ⊕ cli-plugins(buildx) 링크 — 빠지면 옛 빌더로 떨어져 TARGETARCH 가 비고 아키텍처별 단계가 깨진다(09-25 node-c). 원격 빌드(build.sh ELANOUS_BUILD_REMOTE)가 이것을 쓴다.
if R 'test -f ~/.docker-fleet/config.json && DOCKER_CONFIG=~/.docker-fleet docker info >/dev/null 2>&1 && DOCKER_CONFIG=~/.docker-fleet docker buildx version >/dev/null 2>&1'; then ok "플릿 docker 설정(~/.docker-fleet · buildx)"
elif [ $CHECK = 1 ]; then todo "~/.docker-fleet(키체인 없는 docker 설정)"
else R 'mkdir -p ~/.docker-fleet && ctx=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser(\"~/.docker/config.json\"))).get(\"currentContext\",\"\"))" 2>/dev/null); printf "{\"currentContext\": \"%s\"}\n" "$ctx" > ~/.docker-fleet/config.json; [ -e ~/.docker-fleet/contexts ] || ln -s ~/.docker/contexts ~/.docker-fleet/contexts; [ -e ~/.docker-fleet/cli-plugins ] || [ ! -d ~/.docker/cli-plugins ] || ln -s ~/.docker/cli-plugins ~/.docker-fleet/cli-plugins'
  R 'DOCKER_CONFIG=~/.docker-fleet docker info >/dev/null 2>&1 && DOCKER_CONFIG=~/.docker-fleet docker buildx version >/dev/null 2>&1' && ok "플릿 docker 설정 (~/.docker-fleet 생성 · buildx)" || bad "플릿 docker 설정으로 docker 에 못 붙는다"; fi
# 3. bun — 이 맥과 «같은 판»(시험 샤딩은 판이 같아야 비교된다).
#    ⛔ 원격에 «다른 판» bun 이 이미 있으면 덮어쓰지 않는다(그 기계의 다른 일이 쓴다) — ~/.bun-<판> 에 나란히 둔다.
#    ⛔ 나란히 설치할 땐 설치기가 셸 설정에 PATH 를 덧붙여 기본 bun 을 가로채지 않게, 셸 설정 파일을 전후로 되돌린다.
FLEET_BUN="\$HOME/.bun-$BUN_VER/bin/bun"
have="$(R 'bun --version' 2>/dev/null)"; side="$(R "$FLEET_BUN --version" 2>/dev/null)"
if [ "$have" = "$BUN_VER" ]; then ok "bun $have (~/.bun)"
elif [ "$side" = "$BUN_VER" ]; then ok "bun $side (~/.bun-$BUN_VER · 기본 bun 은 ${have:-없음} 그대로)"
elif [ $CHECK = 1 ]; then todo "bun $BUN_VER 설치(기본 bun ${have:-없음} — $([ -n "$have" ] && echo '건드리지 않고 ~/.bun-'"$BUN_VER"' 에 나란히' || echo '~/.bun'))"
elif [ -z "$have" ]; then R "curl -fsSL https://bun.sh/install | bash -s bun-v$BUN_VER >/dev/null 2>&1"; [ "$(R 'bun --version')" = "$BUN_VER" ] && ok "bun $BUN_VER (설치 · ~/.bun)" || bad "bun 설치 실패"
else R "for f in .zshrc .bashrc .bash_profile .zprofile .profile .config/fish/config.fish; do [ -f \$HOME/\$f ] && cp -p \$HOME/\$f \$HOME/\$f.fleet-bak; done; curl -fsSL https://bun.sh/install | BUN_INSTALL=\$HOME/.bun-$BUN_VER bash -s bun-v$BUN_VER >/dev/null 2>&1; for f in .zshrc .bashrc .bash_profile .zprofile .profile .config/fish/config.fish; do [ -f \$HOME/\$f.fleet-bak ] && mv \$HOME/\$f.fleet-bak \$HOME/\$f; done"; [ "$(R "$FLEET_BUN --version")" = "$BUN_VER" ] && ok "bun $BUN_VER (설치 · ~/.bun-$BUN_VER · 기본 bun $have 그대로)" || bad "bun 나란히 설치 실패"; fi
# 4. Chrome (CDP 시험 레인 · 이 맥과 같은 조건)
if R 'test -d "/Applications/Google Chrome.app"'; then ok "Chrome"
elif [ $CHECK = 1 ]; then todo "Chrome 설치"
else R 'brew install --cask google-chrome >/tmp/fleet-chrome.log 2>&1' && ok "Chrome (설치)" || bad "Chrome 설치 실패 — 원격 /tmp/fleet-chrome.log"; fi
# 5. k3d
if R 'command -v k3d' >/dev/null; then ok "k3d $(R 'k3d version | head -1 | cut -d" " -f3')"
elif [ $CHECK = 1 ]; then todo "k3d 설치"
else R 'brew install k3d >/tmp/fleet-k3d.log 2>&1' && ok "k3d (설치)" || bad "k3d 설치 실패"; fi
# 6. 클러스터 elanous-pool — API 를 0.0.0.0:<포트> 로 · 인증서 SAN = 호스트 이름 ⊕ tailnet 이름
TSNAME="$(R '(tailscale status --self --json 2>/dev/null || /Applications/Tailscale.app/Contents/MacOS/Tailscale status --self --json 2>/dev/null) | python3 -c "import json,sys;print(json.load(sys.stdin)[\"Self\"][\"DNSName\"].rstrip(\".\"))"' 2>/dev/null)"
# 5b. 노드 로컬 레지스트리 — 델타 판올림(대표 2026-09-26): 원격 빌드가 여기로 push 하면 «없는 층만» 올라가고
#     Pod 는 커밋 태그로 pull 한다(종전 `k3d image import` 는 4GB 전체를 클러스터 저장소로 매번 복사했다).
REGISTRY="${ELANOUS_FLEET_REGISTRY:-elanous-registry}"; REG_PORT="${ELANOUS_FLEET_REGISTRY_PORT:-5050}"
# ⛔ 레지스트리는 노드의 «루프백»에만 연다 — 🩸 2026-09-26: `0.0.0.0:5050` 이라 tailnet 의 누구든 인증 없이 목록·푸시가 됐다
#   (Pod 는 커밋 태그로 pull 하므로 그 태그를 덮으면 곧 공급망 위험). 노드 안 빌드는 localhost 로 푸시하고, 클러스터는 docker 내부 이름으로 받는다.
REG_BIND="$(R "docker port k3d-$REGISTRY 5000/tcp" 2>/dev/null | head -1)"
if [ -n "$REG_BIND" ] && [ "${REG_BIND#127.0.0.1:}" != "$REG_BIND" ]; then ok "레지스트리 k3d-$REGISTRY :$REG_PORT (루프백)"
elif [ -n "$REG_BIND" ] && [ $CHECK = 1 ]; then bad "레지스트리 k3d-$REGISTRY 가 $REG_BIND 에 열려 있다 — 루프백으로 다시 만들어야 한다"
elif [ -n "$REG_BIND" ]; then R "k3d registry delete $REGISTRY >/dev/null 2>&1; k3d registry create $REGISTRY --port 127.0.0.1:$REG_PORT >/tmp/fleet-registry.log 2>&1 && (docker network connect k3d-$CLUSTER k3d-$REGISTRY 2>/dev/null || true)" && ok "레지스트리 k3d-$REGISTRY 를 루프백으로 다시 만들었다(이미지는 다음 동기화에서 다시 푸시)" || { bad "레지스트리 재생성 실패 — 원격 /tmp/fleet-registry.log"; exit 1; }
elif [ $CHECK = 1 ]; then todo "레지스트리 k3d-$REGISTRY :$REG_PORT 생성(루프백)"
else R "k3d registry create $REGISTRY --port 127.0.0.1:$REG_PORT >/tmp/fleet-registry.log 2>&1" && ok "레지스트리 k3d-$REGISTRY :$REG_PORT (생성 · 루프백)" || { bad "레지스트리 생성 실패 — 원격 /tmp/fleet-registry.log"; exit 1; }
# ⛔ 레지스트리는 클러스터 네트워크에도 붙어 있어야 Pod 가 `k3d-<레지스트리>` 이름을 푼다 — 🩸 2026-09-26: 루프백으로 다시 만든 레지스트리가
#   `bridge` 에만 붙어 kubelet 이 `lookup k3d-elanous-registry: no such host` → Pod `ImagePullBackOff`(🅕 첫 Pod 사용에서 발견). 멱등.
[ $CHECK = 1 ] || R "docker network inspect k3d-$CLUSTER >/dev/null 2>&1 && (docker network connect k3d-$CLUSTER k3d-$REGISTRY 2>/dev/null || true)" >/dev/null 2>&1
fi
# 클러스터가 그 레지스트리를 쓰나 — 안 쓰면(옛 클러스터) 돌고 있는 Job 이 없을 때만 다시 만든다.
REG_WIRED=0; R "docker exec k3d-$CLUSTER-server-0 cat /etc/rancher/k3s/registries.yaml 2>/dev/null | grep -q k3d-$REGISTRY" && REG_WIRED=1
if R "k3d cluster list $CLUSTER" >/dev/null 2>&1 && [ $REG_WIRED = 0 ]; then
  RUNNING="$(R "KUBECONFIG=\$(k3d kubeconfig write $CLUSTER) kubectl get jobs -A --no-headers 2>/dev/null | grep -vc Complete || true" 2>/dev/null | tail -1)"; RUNNING="${RUNNING:-0}"
  if [ $CHECK = 1 ]; then todo "클러스터 $CLUSTER 가 레지스트리를 안 쓴다 — 다시 만든다(도는 Job ${RUNNING:-?}개)"
  elif [ "${RUNNING:-0}" != "0" ]; then bad "클러스터 $CLUSTER 를 다시 만들어야 하는데 도는 Job 이 ${RUNNING}개 — 끝난 뒤 다시"; exit 1
  else R "k3d cluster delete $CLUSTER >/dev/null 2>&1" && ok "클러스터 $CLUSTER (레지스트리 연결 위해 지움)"; fi
fi
if R "k3d cluster list $CLUSTER" >/dev/null 2>&1; then ok "클러스터 $CLUSTER"
elif [ $CHECK = 1 ]; then todo "클러스터 $CLUSTER 생성($K3S_IMAGE · API :$API_PORT · SAN $HOST ${TSNAME:-} · 레지스트리 k3d-$REGISTRY:$REG_PORT)"
else
  SAN="--k3s-arg --tls-san=$HOST@server:0"; [ -n "$TSNAME" ] && SAN="$SAN --k3s-arg --tls-san=$TSNAME@server:0"
  R "k3d cluster create $CLUSTER --image $K3S_IMAGE --no-lb --api-port 0.0.0.0:$API_PORT $SAN --registry-use k3d-$REGISTRY:$REG_PORT --wait --timeout 300s >/tmp/fleet-k3d-create.log 2>&1" && ok "클러스터 $CLUSTER (생성 · 레지스트리 k3d-$REGISTRY)" || { bad "클러스터 생성 실패 — 원격 /tmp/fleet-k3d-create.log"; exit 1; }
fi
# 7. 이 맥 kubeconfig 에 컨텍스트 pool-<호스트>
# ⛔ «있다»로 끝내지 않는다 — 클러스터를 다시 만들면 인증서가 바뀌어 옛 컨텍스트가 x509 로 죽는다(2026-09-26 node-b:
#   monad-pool → elanous-pool 재생성 뒤 «✓ 컨텍스트» 라 말하고 모든 kubectl 이 실패했다). 붙는지까지 잰다.
CTX_STATE=absent
if kubectl config get-contexts -o name 2>/dev/null | grep -qx "$CTX"; then
  if kubectl --context "$CTX" version --request-timeout=8s >/dev/null 2>&1; then CTX_STATE=ok; else CTX_STATE=stale; fi
fi
if [ $CTX_STATE = ok ]; then ok "kubeconfig 컨텍스트 $CTX"
elif [ $CHECK = 1 ]; then todo "kubeconfig 에 $CTX $([ $CTX_STATE = stale ] && echo '갱신(붙지 않는다 — 인증서가 바뀌었다)' || echo '추가')"
else
  if [ $CTX_STATE = stale ]; then
    # 병합은 «앞 파일이 이긴다» — 옛 항목을 먼저 지워야 새 인증서가 들어간다.
    cp ~/.kube/config ~/.kube/config.bak-fleet-"$HOST"-stale-"$(date +%Y%m%d%H%M%S)"
    kubectl config delete-context "$CTX" >/dev/null 2>&1; kubectl config delete-cluster "$CTX" >/dev/null 2>&1; kubectl config delete-user "admin@$CTX" >/dev/null 2>&1
  fi
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  R "k3d kubeconfig get $CLUSTER" > "$TMP/kc.yaml" || { bad "kubeconfig 못 받음"; exit 1; }
  python3 - "$TMP/kc.yaml" "$HOST" "$API_PORT" <<'PY'
import re, sys
p, host, port = sys.argv[1:]
s = open(p).read()
s = re.sub(r'server: https://[^\n]+', f'server: https://{host}:{port}', s)
s = s.replace('k3d-elanous-pool', f'pool-{host}')
open(p, 'w').write(s)
PY
  cp ~/.kube/config ~/.kube/config.bak-fleet-"$HOST"-"$(date +%Y%m%d%H%M%S)"
  KUBECONFIG=~/.kube/config:"$TMP/kc.yaml" kubectl config view --flatten > "$TMP/merged.yaml" && chmod 600 "$TMP/merged.yaml" && mv "$TMP/merged.yaml" ~/.kube/config && ok "kubeconfig 컨텍스트 $CTX (추가 · 현재 컨텍스트는 그대로)" || bad "kubeconfig 병합 실패"
fi
# 8. 네임스페이스 ⊕ 격리 정책
if kubectl --context "$CTX" --request-timeout=10s get ns elanous-test >/dev/null 2>&1; then ok "elanous-test 네임스페이스"
elif [ $CHECK = 1 ]; then todo "base.yaml ⊕ policy-internet.yaml 적용"
else kubectl --context "$CTX" apply -f "$ROOT/docker/h1/base.yaml" -f "$ROOT/docker/h1/policy-internet.yaml" >/dev/null && ok "elanous-test 네임스페이스 ⊕ 정책 (적용)" || bad "적용 실패"; fi
# 9. 판 대조 — k3s · 노드 준비
v="$(kubectl --context "$CTX" --request-timeout=10s get nodes -o jsonpath='{.items[0].status.nodeInfo.kubeletVersion}' 2>/dev/null)"
want="${K3S_IMAGE##*:}"; want="${want/-k3s/+k3s}"
[ "$v" = "$want" ] && ok "k3s $v" || bad "k3s ${v:-응답 없음} ≠ 기대 $want"
echo
if [ $FAIL = 0 ] && [ $TODO -gt 0 ]; then echo "→ $HOST 할 일 $TODO — --check 없이 다시 돌리면 채운다"; exit 2
elif [ $FAIL = 0 ]; then echo "✓ $HOST 준비됨 — 풀에 넣기: ELANOUS_POD_POOL='…,$CTX@$HOST:<상한>'"; else echo "✗ $HOST 미완 — 위 ✗ 를 먼저"; fi
exit $FAIL
