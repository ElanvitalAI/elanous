#!/usr/bin/env bash
# One WSL worker at a time. Default is an offline plan; --apply requires SSH.
# MANUAL-windows-wsl-worker-setup-2026-10-11.md is the operational contract.
set -euo pipefail
usage() { echo 'usage: wsl-node-setup.sh <a2|a2b|b1|b2|b3|b4|b5|b6|b7|b8|b8b|train-route|side-env> --host <wsl> --distro <d> --win-user <u> [--mem 40GB] [--pod-cap 4] [--side-pid <live bun PID>] [--dry-run|--apply]' >&2; exit 2; }
[[ $# -ge 1 ]] || usage
STAGE=$1; shift
HOST='' DISTRO='' WIN_USER='' MEM=40GB POD_CAP=4 MODE=dry-run MEM_SET=0 POD_CAP_SET=0 SIDE_PID=''
while (( $# )); do
  case $1 in
    --host|--distro|--win-user|--mem|--pod-cap|--side-pid)
      (( $# >= 2 )) || usage
      case $1 in --host) HOST=$2;; --distro) DISTRO=$2;; --win-user) WIN_USER=$2;; --mem) MEM=$2; MEM_SET=1;; --pod-cap) POD_CAP=$2; POD_CAP_SET=1;; --side-pid) SIDE_PID=$2;; esac
      shift 2;;
    --dry-run) MODE=dry-run; shift;;
    --apply) MODE=apply; shift;;
    *) usage;;
  esac
done
[[ $STAGE =~ ^(a2|a2b|b1|b2|b3|b4|b5|b6|b7|b8|b8b|train-route|side-env)$ ]] || usage
if [[ $STAGE == train-route && $MODE == apply ]]; then
  echo 'train-route is a registration proposal only; --apply is unavailable' >&2
  exit 2
fi
[[ $HOST =~ ^[a-zA-Z][a-zA-Z0-9-]*$ && $DISTRO =~ ^[a-zA-Z][a-zA-Z0-9._-]*$ && $WIN_USER =~ ^[a-zA-Z][a-zA-Z0-9._-]*$ ]] || usage
[[ $MEM =~ ^[1-9][0-9]*GB$ && $POD_CAP =~ ^[1-9][0-9]*$ ]] || usage
if [[ $MODE == apply && ( $STAGE == a2 || $STAGE == b7 ) && $MEM_SET != 1 ]] || [[ $MODE == apply && $STAGE == b7 && $POD_CAP_SET != 1 ]]; then
  echo "--apply $STAGE requires explicit --mem (and --pod-cap for b7); dry-run defaults are planning examples only" >&2
  exit 2
fi
[[ -z $SIDE_PID || $SIDE_PID =~ ^[1-9][0-9]*$ ]] || usage
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CTX=pool-$HOST
PIN=$(cd /tmp && eln config get harness.imageCommit 2>/dev/null | tr -d '"[:space:]' || true)
if [[ $PIN =~ ^[0-9a-f]{12,40}$ ]]; then PIN=${PIN:0:12}
elif [[ $MODE == apply && ( $STAGE == b4 || $STAGE == b5 ) ]]; then echo 'image pin unreadable; refusing apply' >&2; exit 1
else PIN=unmeasured; fi
BUN_VER=$(bun --version 2>/dev/null || true)
CODEX_VER=$(codex --version 2>/dev/null | awk '{print $NF}' || true)
[[ -z $BUN_VER || $BUN_VER =~ ^[0-9][0-9A-Za-z.+-]*$ ]] || { echo 'invalid local bun version' >&2; exit 1; }
[[ -z $CODEX_VER || $CODEX_VER =~ ^[0-9][0-9A-Za-z.+-]*$ ]] || { echo 'invalid local codex version' >&2; exit 1; }

plan() {
  case $STAGE in
    a2) echo 'CHECK Windows profile/Startup keepalive and .wslconfig; APPLY idempotent startup .cmd and [wsl2] memory/vmIdleTimeout; RECHECK files. No WSL shutdown.';;
    a2b) echo 'CHECK Windows power settings, S4U boot task and unattended Tailscale; APPLY requires human elevated Windows PowerShell, then RECHECK. No reboot.';;
    b1) echo 'CHECK docker-ce-cli/systemd, node, k3d and checksum-verified kubectl; APPLY Ubuntu packages and binaries; RECHECK. Refuse Docker Desktop shim.';;
    b2) echo 'CHECK bun/codex versions, noninteractive links, main bare mirror, loopback registry and k3d cluster; APPLY missing parts; RECHECK.';;
    b3) human_b3;;
    b4) echo 'CHECK parent clone at installed pin, disabled error reports and elanous CLI; APPLY mirror clone, pinned install/config; RECHECK. Credentials remain human-only.';;
    b5) echo 'CHECK amd64 image tag and remote image pin; APPLY build only from clean pinned checkout, smoke Pod, then pin; RECHECK.';;
    b6) echo 'CHECK docker/pool/policies/usage/Secret names/GitHub/CLI/image; execution is read-only verification; RECHECK. Refuse B7 unless all pass.';;
    b7) echo "CHECK parentHost entry; APPLY atomic backed-up config update with podPool k3d-elanous-pool:$POD_CAP; RECHECK.";;
    b8) echo 'CHECK rail follow+pin hooks; APPLY backed-up idempotent host hooks; RECHECK. Rail process restart is OP-controlled.';;
    b8b) echo 'CHECK autopsy host scan and run-ledger CLI; APPLY backed-up host list edit; RECHECK. Watcher restart is OP-controlled.';;
    train-route) echo 'CHECK new host routing needs HOSTS, --free-host, fixed 8-shard WSL policy and disk-free; dry-run registration proposal only until host is reachable.';;
    side-env) echo 'After a real side-pr.sh job starts, --apply --side-pid <live bun PID> audits that gate child /proc environment; before then UNMEASURED.';;
  esac
}
human_b3() {
  local mac_user; mac_user=$(id -un)
  [[ $mac_user =~ ^[a-zA-Z][a-zA-Z0-9._-]*$ ]] || { echo 'Mac user unreadable' >&2; exit 1; }
  cat <<'B3_COMMANDS' | sed "s/<wsl>/$HOST/g; s/<u>/$mac_user/g"
B3: 사람만 실행 · 값은 출력하지 않음(대표 승인 뒤 프롬프트의 ! 명령):
! for k in openrouter_api_key zai_api_key; do ssh <wsl> "umask 077; mkdir -p ~/.cache; cat > ~/.cache/$k" < ~/.cache/$k; done
! ssh <wsl> 'umask 077; mkdir -p ~/.grok; cat > ~/.grok/auth.json' < ~/.grok/auth.json
! jq '{providers: (.providers | with_entries(select(.key|startswith("openai-codex"))))}' ~/.elanous/auth.json | ssh <wsl> 'umask 077; mkdir -p ~/.elanous; f=~/.elanous/auth.json; t=$(mktemp); cat > "$t"; if [ -f "$f" ]; then cp -p "$f" "$f.bak"; jq -s ".[0] * .[1]" "$f" "$t" > "$f.new"; else cp "$t" "$f.new"; fi; mv "$f.new" "$f"; rm -f "$t"; chmod 600 "$f"'
! for d in .codex .codex-new .codex-third; do ssh <wsl> "umask 077; mkdir -p ~/$d; cat > ~/$d/auth.json" < ~/$d/auth.json; done
! ssh <wsl> 'u=$(id -un); sed -i "s#/Users/<u>/#/home/$u/#g" ~/.elanous/auth.json'
GitHub device login: ssh <wsl> 'printf "\n\n\n" | BROWSER=/bin/true gh auth login -h github.com -p https -w' → 사람이 승인.
B3_COMMANDS
}
if [[ $MODE == dry-run || $STAGE == b3 || $STAGE == train-route ]]; then
  mem_label=$MEM; cap_label=$POD_CAP
  [[ $MEM_SET == 1 ]] || mem_label="$MEM(default example)"
  [[ $POD_CAP_SET == 1 ]] || cap_label="$POD_CAP(default example)"
  printf 'DRY-RUN %s host=%s distro=%s win-user=%s mem=%s pod-cap=%s pin=%s\n' "$STAGE" "$HOST" "$DISTRO" "$WIN_USER" "$mem_label" "$cap_label" "$PIN"
  plan
  if [[ $STAGE == train-route ]]; then
    printf 'train-route.py: HOSTS+=(%s), disk-free %s, route --free-%s, fixed WSL policy 8 shards; train-loop free/occupancy and side-pr PATH/host branches must join the same change. Child environment remains unmeasured until a real side job.\n' "$HOST" "$HOST" "$HOST"
  fi
  exit 0
fi
if [[ $STAGE == side-env && -z $SIDE_PID ]]; then
  echo 'UNMEASURED: run an actual side-pr.sh job, find its live bun gate child PID, then rerun side-env --apply --side-pid <PID>.' >&2
  exit 12
fi
ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" true >/dev/null || { echo "SSH unavailable: $HOST; no changes" >&2; exit 1; }
WSL_USER=$(ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" id -un)
[[ $WSL_USER =~ ^[a-zA-Z][a-zA-Z0-9._-]*$ ]] || { echo 'WSL POSIX user unreadable' >&2; exit 1; }
if [[ $STAGE == side-env ]]; then
  side="$HOME/elanous-hq/seat-state/OP/tools/train-1016/night-train/side-pr.sh"
  rg -Fq 'env -i HOME=' "$side" || { echo 'side-pr.sh lacks env -i HOME contract' >&2; exit 1; }
  ssh -o BatchMode=yes "$HOST" "python3 - '$SIDE_PID'" <<'PY'
import pathlib,sys
pid=sys.argv[1]
p=pathlib.Path('/proc')/pid
try:
    command=(p/'cmdline').read_bytes().replace(b'\0',b' ')
    executable=(p/'exe').resolve().name
    names=[v.split(b'=',1)[0] for v in (p/'environ').read_bytes().split(b'\0') if b'=' in v]
except (FileNotFoundError,PermissionError) as e:
    print(f'UNMEASURED: live gate child unavailable: {e}',file=sys.stderr);sys.exit(12)
if executable != 'bun' or b'bin/elanous.mjs' not in command or b'self gate --changed' not in command:
    print('UNMEASURED: PID is not the bun side gate child',file=sys.stderr);sys.exit(12)
leaked=[n for n in names if n.startswith((b'ELANOUS_',b'XDG_'))]
if leaked:
    print(f'FAIL: live side gate child contains {len(leaked)} ELANOUS_*/XDG_* names',file=sys.stderr);sys.exit(1)
print(f'PASS: live side gate child pid={pid} ELANOUS_*=0 XDG_*=0')
PY
  exit $?
fi

remote() {
  local phase=$1
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "bash -s -- '$STAGE' '$phase' '$DISTRO' '$WIN_USER' '$MEM' '$POD_CAP' '$PIN' '$BUN_VER' '$CODEX_VER' '$HOST'" <<'REMOTE'
set -euo pipefail
stage=$1; phase=$2; distro=$3; win_user=$4; mem=$5; cap=$6; pin=$7; bun_ver=$8; codex_ver=$9; wsl_host=${10}
need() { echo "MISSING $stage: $*"; exit 10; }
if [[ $stage == a2 || $stage == a2b ]]; then
  [[ $(cmd.exe /c echo %USERNAME% | tr -d '\r') == "$win_user" ]] || { echo 'Windows profile differs from --win-user'; exit 1; }
fi
case $stage:$phase in
  a2:check)
    profile=$(cmd.exe /c echo %USERPROFILE% | tr -d '\r'); p=$(wslpath "$profile")
    appdata=$(cmd.exe /c echo %APPDATA% | tr -d '\r'); s=$(wslpath "$appdata")/Microsoft/Windows/Start\ Menu/Programs/Startup/elanous-wsl-keepalive.cmd
    [[ -f $p/.wslconfig && -f $s ]] || need 'keepalive files'
    content=$(printf 'wsl.exe -d %s --exec /bin/true\r\npowershell -WindowStyle Hidden -Command "Start-Process wsl.exe -ArgumentList '\''-d'\'','\''%s'\'','\''--exec'\'','\''/bin/sleep'\'','\''infinity'\'' -WindowStyle Hidden"\r\n' "$distro" "$distro")
    grep -Fqx "memory=$mem" "$p/.wslconfig" && grep -Fqx 'vmIdleTimeout=-1' "$p/.wslconfig" && cmp -s "$s" <(printf '%s' "$content") || need 'keepalive content';;
  a2:apply)
    profile=$(cmd.exe /c echo %USERPROFILE% | tr -d '\r'); p=$(wslpath "$profile")
    appdata=$(cmd.exe /c echo %APPDATA% | tr -d '\r'); s=$(wslpath "$appdata")/Microsoft/Windows/Start\ Menu/Programs/Startup
    mkdir -p "$s"
    python3 - "$p/.wslconfig" "$mem" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); mem=sys.argv[2]
old=p.read_text() if p.exists() else ''
lines=old.splitlines(); out=[]; in_wsl=False; found=False
for line in lines:
    if line.strip().startswith('[') and line.strip().endswith(']'):
        if in_wsl: out.extend([f'memory={mem}','vmIdleTimeout=-1'])
        in_wsl=line.strip().lower()=='[wsl2]'; found |= in_wsl
    if in_wsl and line.strip().split('=',1)[0].strip().lower() in ('memory','vmidletimeout'): continue
    out.append(line)
if in_wsl: out.extend([f'memory={mem}','vmIdleTimeout=-1'])
if not found: out.extend(['[wsl2]',f'memory={mem}','vmIdleTimeout=-1'])
new='\n'.join(out)+'\n'
if new!=old:
    if p.exists():
        import datetime
        stamp=datetime.datetime.now().strftime('%Y%m%d%H%M%S')
        p.with_name(p.name+'.bak-elanous-'+stamp).write_text(old)
    p.write_text(new)
PY
    f="$s/elanous-wsl-keepalive.cmd"
    content=$(printf 'wsl.exe -d %s --exec /bin/true\r\npowershell -WindowStyle Hidden -Command "Start-Process wsl.exe -ArgumentList '\''-d'\'','\''%s'\'','\''--exec'\'','\''/bin/sleep'\'','\''infinity'\'' -WindowStyle Hidden"\r\n' "$distro" "$distro")
    [[ -f $f ]] && cmp -s "$f" <(printf '%s' "$content") || printf '%s' "$content" > "$f";;
  a2b:check)
    powershell.exe -NoProfile -Command '(Get-ScheduledTask -TaskName elanous-wsl-keepalive -ErrorAction SilentlyContinue).State' | tr -d '\r' | grep -Eq 'Ready|Running' || need 'S4U task'
    for key in 'SUB_SLEEP STANDBYIDLE' 'SUB_SLEEP HIBERNATEIDLE' 'SUB_DISK DISKIDLE'; do
      ac=$(/mnt/c/Windows/System32/powercfg.exe /query SCHEME_CURRENT $key | tr -d '\r' | grep -oE '0x[0-9a-fA-F]{8}' | tail -2 | head -1)
      [[ $ac == 0x00000000 ]] || need "AC power $key"
    done
    /mnt/c/Windows/System32/reg.exe query 'HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Power' /v HiberbootEnabled | tr -d '\r' | grep -Eq 'HiberbootEnabled.*0x0$' || need 'fast startup off'
    /mnt/c/Windows/System32/reg.exe query 'HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' /v NoAutoRebootWithLoggedOnUsers | tr -d '\r' | grep -Eq 'NoAutoRebootWithLoggedOnUsers.*0x1$' || need 'update reboot policy'
    /mnt/c/Windows/System32/sc.exe qc sshd | tr -d '\r' | grep -q AUTO_START || need 'sshd auto start'
    /mnt/c/Windows/System32/sc.exe qc Tailscale | tr -d '\r' | grep -q AUTO_START || need 'Tailscale auto start'
    '/mnt/c/Program Files/Tailscale/tailscale.exe' debug prefs | grep -q 'ForceDaemon.*true' || need 'unattended Tailscale';;
  a2b:apply)
    ps=$(cat <<'PS'
$ErrorActionPreference='Stop'
powercfg /hibernate off
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change disk-timeout-ac 0
reg add 'HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Power' /v HiberbootEnabled /t REG_DWORD /d 0 /f | Out-Null
reg add 'HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' /v NoAutoRebootWithLoggedOnUsers /t REG_DWORD /d 1 /f | Out-Null
Set-Service -Name sshd -StartupType Automatic
Set-Service -Name Tailscale -StartupType Automatic
& 'C:\Program Files\Tailscale\tailscale.exe' set --unattended=true | Out-Null
$distroName='__DISTRO__'
$a=New-ScheduledTaskAction -Execute 'C:\Windows\System32\wsl.exe' -Argument "-d $distroName --exec /bin/sleep infinity"
$t=New-ScheduledTaskTrigger -AtStartup
$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$p=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest
Register-ScheduledTask -TaskName elanous-wsl-keepalive -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null
PS
)
    ps=${ps//__DISTRO__/$distro}
    if ! cmd.exe /c net session >/dev/null 2>&1; then
      profile=$(cmd.exe /c echo %USERPROFILE% | tr -d '\r'); p=$(wslpath "$profile")
      script="$p/elanous-a2b-admin.ps1"
      printf '%s\n' "$ps" > "$script"
      echo "ADMIN_ACTION_REQUIRED: open elevated Windows PowerShell as $win_user and run: powershell.exe -NoProfile -ExecutionPolicy Bypass -File '$profile\\elanous-a2b-admin.ps1'" >&2
      echo 'After that, rerun a2b --apply for the check/recheck; no privileged change was attempted over SSH.' >&2
      exit 12
    fi
    encoded=$(printf '%s' "$ps" | iconv -f UTF-8 -t UTF-16LE | base64 -w0)
    powershell.exe -NoProfile -EncodedCommand "$encoded" >/dev/null
    ;;
  b1:check)
    dpkg -S /usr/bin/docker | grep -q docker-ce-cli || need 'docker-ce-cli (Docker Desktop shim refused)'
    systemctl is-active --quiet docker containerd || need 'docker/containerd active'
    command -v node >/dev/null && command -v k3d >/dev/null && command -v kubectl >/dev/null || need 'node/k3d/kubectl'
    kubectl version --client -o json 2>/dev/null | python3 -c 'import json,sys;sys.exit(0 if json.load(sys.stdin)["clientVersion"]["gitVersion"]=="v1.36.4" else 1)' || need 'kubectl version';;
  b1:apply)
    if [[ -e /usr/bin/docker ]] && ! dpkg -S /usr/bin/docker | grep -q docker-ce-cli; then echo 'Docker Desktop shim/other owner: refuse'; exit 1; fi
    sudo apt-get install -y -qq ca-certificates curl && sudo install -m 0755 -d /etc/apt/keyrings
    sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    sudo chmod a+r /etc/apt/keyrings/docker.asc
    . /etc/os-release
    printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$VERSION_CODENAME" "$(dpkg --print-architecture)" | sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null
    sudo apt-get update -qq
    sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin nodejs
    sudo systemctl enable --now docker containerd
    sudo usermod -aG docker "$USER"
    command -v k3d >/dev/null || curl -fsSL https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | sudo bash
    if ! command -v kubectl >/dev/null; then
      cd /tmp; curl -fsSLO https://dl.k8s.io/release/v1.36.4/bin/linux/amd64/kubectl
      curl -fsSLO https://dl.k8s.io/release/v1.36.4/bin/linux/amd64/kubectl.sha256
      echo "$(cat kubectl.sha256)  kubectl" | sha256sum --check
      sudo install -m 0755 kubectl /usr/local/bin/kubectl
    fi;;
  b2:check)
    [[ -n $bun_ver && -n $codex_ver ]] || { echo 'local bun/codex version unknown' >&2; exit 1; }
    [[ $(/usr/local/bin/bun --version 2>/dev/null) == "$bun_ver" ]] || need 'bun version'
    [[ $(/usr/local/bin/codex --version 2>/dev/null | awk '{print $NF}') == "$codex_ver" ]] || need 'codex version'
    [[ -d $HOME/mirror/elanous-agent.git ]] || need 'bare mirror'
    docker port k3d-elanous-registry 5000/tcp 2>/dev/null | grep -q '^127.0.0.1:5050$' || need 'loopback registry'
    k3d cluster list elanous-pool | grep -q elanous-pool || need 'cluster'
    docker exec k3d-elanous-pool-server-0 test -d /mirror-host/elanous-agent.git || need 'mirror mount'
    docker exec k3d-elanous-pool-server-0 grep -q k3d-elanous-registry /etc/rancher/k3s/registries.yaml || need 'registry wiring'
    docker network inspect k3d-elanous-pool | grep -q k3d-elanous-registry || need 'registry network';;
  b2:apply)
    [[ -n $bun_ver && -n $codex_ver ]] || { echo 'local bun/codex version unknown'; exit 1; }
    [[ $(~/.bun/bin/bun --version 2>/dev/null) == "$bun_ver" ]] || curl -fsSL https://bun.sh/install | bash -s "bun-v$bun_ver"
    [[ $(~/.bun/bin/codex --version 2>/dev/null | awk '{print $NF}') == "$codex_ver" ]] || ~/.bun/bin/bun add -g "@openai/codex@$codex_ver"
    sudo ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
    sudo ln -sf "$HOME/.bun/bin/codex" /usr/local/bin/codex
    mkdir -p ~/mirror
    [[ -d ~/mirror/elanous-agent.git ]] || git init -q --bare -b main ~/mirror/elanous-agent.git
    mkdir -p ~/.docker-fleet
    [[ -f ~/.docker-fleet/config.json ]] || printf '{"currentContext":""}\n' > ~/.docker-fleet/config.json
    docker inspect k3d-elanous-registry >/dev/null 2>&1 || k3d registry create elanous-registry --port 127.0.0.1:5050
    if ! k3d cluster list elanous-pool | grep -q elanous-pool; then
      fqdn=$(tailscale status --self --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
      tail_ip=$(tailscale ip -4)
      [[ $tail_ip =~ ^[0-9.]+$ ]] || { echo 'Tailscale IPv4 unavailable'; exit 1; }
      k3d cluster create elanous-pool --image rancher/k3s:v1.36.4-k3s1 --no-lb --api-port "$tail_ip:6550" \
        --k3s-arg "--tls-san=$wsl_host@server:0" --k3s-arg "--tls-san=$fqdn@server:0" \
        --registry-use k3d-elanous-registry:5050 --volume "$HOME/mirror:/mirror-host:ro@server:0" --wait --timeout 300s
    fi
    docker network connect k3d-elanous-pool k3d-elanous-registry 2>/dev/null || true;;
  b4:check)
    [[ -d ~/source/elanous-agent/.git ]] || need 'parent clone'
    [[ $(git -C ~/source/elanous-agent rev-parse HEAD 2>/dev/null) == "$pin"* ]] || need 'parent commit'
    [[ $(readlink ~/.local/share/elanous/current 2>/dev/null) == *"$pin" ]] || need 'installed pin'
    grep -q '"enabled"[[:space:]]*:[[:space:]]*false' ~/.elanous/config.json || need 'error reports disabled';;
  b4:apply)
    [[ -d ~/source/elanous-agent/.git ]] || git clone ~/mirror/elanous-agent.git ~/source/elanous-agent
    mkdir -p ~/.elanous
    [[ -f ~/.elanous/config.json ]] || printf '{"errorReports":{"enabled":false}}\n' > ~/.elanous/config.json
    cd ~/source/elanous-agent
    git fetch -q origin main
    git checkout --detach "$pin"
    /usr/local/bin/bun install --frozen-lockfile
    (cd apps/pwa && /usr/local/bin/bun install --frozen-lockfile)
    bash scripts/install.sh --no-modify-path --no-setup --yes
    jq '.errorReports.enabled=false | .llm += {fallbackChain:["codex-rotate","grok","codex-credits"], zaiCodingPlan:{overage:"openrouter",maxConcurrent:3}}' ~/.elanous/config.json > ~/.elanous/config.json.new
    mv ~/.elanous/config.json.new ~/.elanous/config.json;;
  *) echo "remote stage not implemented: $stage/$phase" >&2; exit 1;;
esac
REMOTE
}

ensure_context() (
  if kubectl config get-contexts -o name 2>/dev/null | grep -qx "$CTX" && kubectl --context "$CTX" version --request-timeout=8s >/dev/null 2>&1; then return 0; fi
  local tmp; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  ssh -o BatchMode=yes "$HOST" 'k3d kubeconfig get elanous-pool' > "$tmp/kc.yaml"
  python3 - "$tmp/kc.yaml" "$HOST" <<'PY'
from pathlib import Path
import re,sys
p=Path(sys.argv[1]); h=sys.argv[2]
s=p.read_text(); s=re.sub(r'server: https://[^\n]+',f'server: https://{h}:6550',s)
p.write_text(s.replace('k3d-elanous-pool',f'pool-{h}'))
PY
  mkdir -p ~/.kube
  if [[ -f ~/.kube/config ]]; then cp -p ~/.kube/config ~/.kube/config.bak-wsl-"$HOST"-"$(date +%Y%m%d%H%M%S)"; fi
  KUBECONFIG="$HOME/.kube/config:$tmp/kc.yaml" kubectl config view --flatten > "$tmp/merged.yaml"
  chmod 600 "$tmp/merged.yaml"; mv "$tmp/merged.yaml" ~/.kube/config
  kubectl --context "$CTX" version --request-timeout=8s >/dev/null
)
check_local() {
  case $STAGE in
    b5)
      ssh -o BatchMode=yes "$HOST" "curl -fsS http://localhost:5050/v2/elanous-harness/tags/list" | python3 -c 'import json,sys; sys.exit(0 if sys.argv[1] in json.load(sys.stdin).get("tags",[]) else 10)' "$PIN" || return 10
      [[ $(ssh -o BatchMode=yes "$HOST" "~/.local/share/elanous/bin/elanous config get harness.imageCommit" | tr -d '"[:space:]') == "$PIN" ]] || return 10;;
    b6)
      bash "$ROOT/scripts/fleet/node-setup.sh" "$HOST" --check >/dev/null || return 10
      ssh -o BatchMode=yes "$HOST" 'dpkg -S /usr/bin/docker' | grep -q docker-ce-cli || return 10
      kubectl --context "$CTX" get nodes -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}' | grep -qx True || return 10
      kubectl --context "$CTX" diff -f "$ROOT/docker/h1/base.yaml" -f "$ROOT/docker/h1/policy-internet.yaml" -f "$ROOT/docker/h1/policy-bedrock.yaml" -f "$ROOT/docker/h1/policy-zai.yaml" >/dev/null || return 10
      kubectl --context "$CTX" -n elanous-test get secret elanous-bedrock-aws elanous-zai-coding-plan >/dev/null || return 10
      ssh -o BatchMode=yes "$HOST" 'gh auth status >/dev/null 2>&1 && ~/.local/share/elanous/bin/elanous --version >/dev/null && ~/.local/share/elanous/bin/elanous usage >/tmp/elanous-wsl-usage-check.txt && ! grep -E "codex.*error|grok.*error|openrouter.*error|zai.*error" /tmp/elanous-wsl-usage-check.txt' || return 10
      check_local_b5 || return 10;;
    b7)
      python3 - "$HOST" "$WSL_USER" "$POD_CAP" <<'PY'
import json,sys
from pathlib import Path
p=Path.home()/'.elanous/config.json'; d=json.loads(p.read_text())
want={'host':sys.argv[1],'cwd':f'/home/{sys.argv[2]}/source/elanous-agent','podPool':f'k3d-elanous-pool:{sys.argv[3]}'}
sys.exit(0 if sum(row.get('host')==want['host'] and row==want for row in d.get('taskAgent',{}).get('parentHost',[]))==1 else 10)
PY
      ;;
    b8)
      local rail="$HOME/elanous-hq/seat-state/OP/tools/rail-hourly-1008.sh"
      rg -Fq 'wsl2_follow()' "$rail" && rg -Fq 'wsl2_pin()' "$rail" &&
        rg -Fq "$HOST 따라감" "$rail" && rg -Fq 'wsl2_follow ${want}' "$rail" &&
        rg -Fq 'wsl2_pin $c' "$rail" || return 10;;
    b8b)
      rg -q "for h in mbp node-b node-c host-e-wsl $HOST; do" "$HOME/elanous-hq/seat-state/OP/tools/autopsy-watch.sh" || return 10
      ssh -o BatchMode=yes "$HOST" '~/.local/share/elanous/bin/elanous self run-ledger --help >/dev/null' || return 10;;
  esac
}
check_local_b5() { local old=$STAGE; STAGE=b5; check_local; local rc=$?; STAGE=$old; return $rc; }
apply_local() {
  case $STAGE in
    b5)
      kubectl --context "$CTX" get nodes -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}' | grep -qx True || { echo 'B5 requires a Ready WSL pool' >&2; return 1; }
      local image_root cleanup_image=0
      if [[ $(git -C "$ROOT" rev-parse HEAD) == "$PIN"* && -z $(git -C "$ROOT" status --porcelain --untracked-files=no) ]]; then image_root=$ROOT
      else
        image_root=$(mktemp -d /tmp/elanous-wsl-image-XXXXXX)
        eln git -C "$ROOT" worktree add --detach "$image_root/repo" "$PIN"
        image_root=$image_root/repo; cleanup_image=1
      fi
      if ! (cd "$image_root" && ELANOUS_BUILD_REMOTE="$HOST" bash docker/harness/build.sh); then
        if (( cleanup_image )); then eln git -C "$ROOT" worktree remove --force "$image_root"; rmdir "${image_root%/repo}"; fi
        return 1
      fi
      if (( cleanup_image )); then eln git -C "$ROOT" worktree remove "$image_root"; rmdir "${image_root%/repo}"; fi
      ssh -o BatchMode=yes "$HOST" "curl -fsS http://localhost:5050/v2/elanous-harness/tags/list" | python3 -c 'import json,sys; sys.exit(0 if sys.argv[1] in json.load(sys.stdin).get("tags",[]) else 1)' "$PIN" || { echo 'remote registry tag missing after build' >&2; return 1; }
      local smoke=img-smoke-$$
      kubectl --context "$CTX" -n elanous-test run "$smoke" --image="k3d-elanous-registry:5050/elanous-harness:$PIN" --restart=Never --command -- sh -c 'uname -m; elanous --version'
      if ! kubectl --context "$CTX" -n elanous-test wait --for=jsonpath='{.status.phase}=Succeeded' "pod/$smoke" --timeout=120s || ! kubectl --context "$CTX" -n elanous-test logs "$smoke" | grep -q x86_64; then
        kubectl --context "$CTX" -n elanous-test logs "$smoke" >&2 || true
        kubectl --context "$CTX" -n elanous-test delete pod "$smoke" --ignore-not-found=true --wait=false >/dev/null || true
        return 1
      fi
      kubectl --context "$CTX" -n elanous-test delete pod "$smoke" --wait=false
      ssh -o BatchMode=yes "$HOST" "~/.local/share/elanous/bin/elanous config set harness.imageCommit '$PIN' --config-dir ~/.elanous" >/dev/null;;
    b6)
      # B6 only verifies. Missing credentials/Secrets require the human B3 boundary.
      echo 'B6 is verification-only; apply A2..B5 and human B3, then recheck' >&2; return 1;;
    b7)
      local old=$STAGE; STAGE=b6; check_local || { STAGE=$old; echo 'B6 not green; parentHost insertion refused' >&2; return 1; }; STAGE=$old
      python3 - "$HOST" "$WSL_USER" "$POD_CAP" <<'PY'
import json,os,sys,tempfile,time
from pathlib import Path
p=Path.home()/'.elanous/config.json'; d=json.loads(p.read_text())
want={'host':sys.argv[1],'cwd':f'/home/{sys.argv[2]}/source/elanous-agent','podPool':f'k3d-elanous-pool:{sys.argv[3]}'}
parent=d.setdefault('taskAgent',{}).setdefault('parentHost',[])
parent[:]=[row for row in parent if row.get('host')!=want['host']]+[want]
backup=p.with_name(p.name+f'.bak-wsl-{time.strftime("%Y%m%d%H%M%S")}'); backup.write_bytes(p.read_bytes())
fd,tmp=tempfile.mkstemp(dir=p.parent,prefix=p.name+'.tmp.'); os.fchmod(fd,0o600)
with os.fdopen(fd,'w') as f: json.dump(d,f,ensure_ascii=False,indent=2); f.write('\n')
os.replace(tmp,p)
PY
      ;;
    b8)
      local old=$STAGE; STAGE=b7; check_local || { STAGE=$old; echo 'B8 requires parentHost B7' >&2; return 1; }; STAGE=$old
      python3 - "$HOST" <<'PY'
from pathlib import Path
import sys,time
h=sys.argv[1]; p=Path.home()/'elanous-hq/seat-state/OP/tools/rail-hourly-1008.sh'; s=p.read_text()
if 'wsl2_follow()' not in s:
    if s.count('wsl_follow() {')!=1 or s.count('\nwsl_pin() {')!=1 or s.count('\n# 10-09 20:5x')!=1 or s.count('  wsl_pin $c\n')!=1 or s.count('wsl_follow ${want}; image_pin ${want}')!=1:
        raise SystemExit('rail anchor missing/ambiguous; no edit')
    start=s.index('wsl_follow() {'); middle=s.index('\nwsl_pin() {',start); end=s.index('\n# 10-09 20:5x',middle)
    original=s[start:end]
    if original.count('host-e-wsl')<3: raise SystemExit('rail WSL host references missing; no edit')
    block=original.replace('wsl_follow()', 'wsl2_follow()').replace('wsl_pin()', 'wsl2_pin()').replace('host-e-wsl',h)
    if 'host-e-wsl' in block or block.count(h)<3: raise SystemExit('new rail host references incomplete; no edit')
    s=s[:end]+'\n# second WSL worker installed by wsl-node-setup.sh\n'+block+'\n'+s[end:]
    s=s.replace('  wsl_pin $c\n','  wsl_pin $c\n  wsl2_pin $c\n',1)
    s=s.replace('wsl_follow ${want}; image_pin ${want}', 'wsl_follow ${want}; wsl2_follow ${want}; image_pin ${want}',1)
    backup=p.with_name(p.name+'.bak-wsl-'+time.strftime('%Y%m%d%H%M%S')); backup.write_text(p.read_text())
    p.write_text(s)
PY
      zsh -n "$HOME/elanous-hq/seat-state/OP/tools/rail-hourly-1008.sh"
      echo 'rail script changed; OP restarts its recorded PID after release window' >&2;;
    b8b)
      local old=$STAGE; STAGE=b7; check_local || { STAGE=$old; echo 'B8b requires parentHost B7' >&2; return 1; }; STAGE=$old
      ssh -o BatchMode=yes "$HOST" '~/.local/share/elanous/bin/elanous self run-ledger --help >/dev/null' || return 1
      python3 - "$HOST" <<'PY'
from pathlib import Path
import sys,time
h=sys.argv[1]; p=Path.home()/'elanous-hq/seat-state/OP/tools/autopsy-watch.sh'; s=p.read_text()
old='for h in mbp node-b node-c host-e-wsl; do'; new=f'for h in mbp node-b node-c host-e-wsl {h}; do'
if new not in s:
    if s.count(old)!=1: raise SystemExit('autopsy host anchor missing/ambiguous')
    backup=p.with_name(p.name+'.bak-wsl-'+time.strftime('%Y%m%d%H%M%S')); backup.write_text(s)
    p.write_text(s.replace(old,new,1))
PY
      zsh -n "$HOME/elanous-hq/seat-state/OP/tools/autopsy-watch.sh"
      echo 'autopsy script changed; OP restarts its exact PID after release window' >&2;;
    *) echo "local apply unavailable: $STAGE" >&2; return 1;;
  esac
}

case $STAGE in
  a2|a2b|b1|b2|b4)
    if remote check; then echo "✓ $STAGE remote ready"
    else
      rc=$?; [[ $rc == 10 ]] || { echo "✗ $STAGE check failed rc=$rc" >&2; exit 1; }
      echo "→ $STAGE apply"; remote apply
      remote check || { echo "✗ $STAGE recheck failed" >&2; exit 1; }
    fi
    if [[ $STAGE == b2 ]]; then
      eln git -C "$ROOT" push "ssh://$HOST/home/$WSL_USER/mirror/elanous-agent.git" origin/main:refs/heads/main
      ssh -o BatchMode=yes "$HOST" 'git -C ~/mirror/elanous-agent.git symbolic-ref HEAD refs/heads/main'
      ensure_context
      kubectl --context "$CTX" apply -f "$ROOT/docker/h1/base.yaml" -f "$ROOT/docker/h1/policy-internet.yaml" -f "$ROOT/docker/h1/policy-bedrock.yaml" -f "$ROOT/docker/h1/policy-zai.yaml"
    fi
    echo "✓ $STAGE ready";;
  b5|b6|b7|b8|b8b)
    if check_local; then echo "✓ $STAGE already ready"; exit 0; fi
    echo "→ $STAGE apply"; apply_local
    check_local || { echo "✗ $STAGE recheck failed" >&2; exit 1; }
    echo "✓ $STAGE ready";;
esac
