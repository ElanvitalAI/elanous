#!/usr/bin/env zsh
# 판올림(설치본 갱신) — UX 자리 · 내부 문서 `UX` §3a.
# origin/main 을 깨끗한 체크아웃(D)에 떼어 놓고, 설치본을 그 체크아웃으로 갱신하고 넥서스를 재시작한 뒤, 서빙 화면이 새 판인지 잰다.
# 사용: zsh scripts/ux/bump-installed.sh [<ref>=origin/main]
# ⛔ zsh 에서 set -e 는 아무것도 안 한다 — 단계는 전부 && 로 잇는다. ⛔ 채널 공지(전·후)는 이 스크립트 밖에서 사람이/자리가 한다.
REF=${1:-origin/main}
D=${UX_DEPLOY_DIR:-$TMPDIR/deploy-main}
[[ -d $D/.git || -f $D/.git ]] || { echo "deploy checkout missing: $D (git worktree add --detach $D origin/main 로 한 번 만든다)"; exit 64; }
cd "$D" && git fetch -q origin && git checkout -q --detach "$REF" && bun install --silent && (cd apps/pwa && bun install --silent) \
  && echo "[bump] checkout $(git rev-parse --short HEAD) — $(git log -1 --format=%s | cut -c1-80)" \
  && cd ~ && elanous update --from "$D" --restart \
  || { echo "[bump] FAILED — PWA 빌드가 깨졌으면 도구의 처방(cd $D/apps/pwa && bun install --force)을 먼저 본다"; exit 1; }
# 재는 칸 셋: 데몬 pid · 설치본 판 · 서빙 화면 = 설치본 out/index.html
sleep 15
launchctl list | rg com.elanous.nexus
elanous --version
CUR=~/.local/share/elanous/current
WANT=$(rg -o 'page-[a-f0-9]+\.js' -m1 "$CUR/node_modules/elanous/apps/pwa/out/index.html" | head -1)
GOT=$(curl -s --max-time 15 http://127.0.0.1:31415/app/ | rg -o 'page-[a-f0-9]+\.js' -m1 | head -1)
[[ -n $WANT && $WANT == $GOT ]] && echo "[bump] ok — serving $GOT" || { echo "[bump] MISMATCH installed=$WANT serving=$GOT"; exit 1; }
