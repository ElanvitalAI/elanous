#!/bin/zsh
# 공개 영상 누출 관문 — 1초 한 장(또는 --fps N) 전수 OCR → 금지 목록 → 초 단위 표(hits.tsv).
# 사용: scripts/media/ocr-leak-scan.sh <영상> <산출 폴더> [--fps N]
# 한계: tesseract eng — 한글 칸·이모지는 사람 눈으로 따로 본다(내부 문서 `TC` §2). 걸림은 오독이 많다 → 그 초 프레임을 눈으로 대조한다.
V=$1; O=$2; FPS=1
[ "${3:-}" = "--fps" ] && FPS=${4:-1}
[ -f "$V" ] && [ -n "$O" ] || { echo "사용: $0 <영상> <산출 폴더> [--fps N]" >&2; exit 2; }
command -v tesseract >/dev/null && command -v ffmpeg >/dev/null || { echo "tesseract·ffmpeg 가 필요하다" >&2; exit 2; }
mkdir -p "$O/f" && ffmpeg -loglevel error -i "$V" -vf "fps=$FPS" "$O/f/%05d.png" || exit 2
# 금지: 홈 경로 · 실명 계정 표지 · 사설 호스트 · tailnet · 금액 · 크레딧 수 · 메일 · 키·토큰 모양(elanous 단기 토큰 elt_ · bearer · GitHub 토큰 · 40자+ 연속)
PAT='/Users/|msb[0-9]|\bmbp\b|tail[0-9a-f]{4,}|ts\.net|\$[0-9]|USD|credit[s]? *[0-9]|@gmail|api[_-]?key|sk-[A-Za-z0-9]{8}|elt_[A-Za-z0-9_-]{6}|bearer|ghs_|gh[po]_|[A-Za-z0-9_-]{40,}'
[ -n "${OCR_EXTRA_PATTERN:-}" ] && PAT="$PAT|$OCR_EXTRA_PATTERN"   # 계정 실명 등은 저장소에 적지 않고 환경변수로 준다
: > "$O/hits.tsv"
for f in "$O"/f/*.png; do
  n=${${f:t:r}#0*}; s=$(( (n - 1) / FPS ))
  t=$(tesseract "$f" - -l eng --psm 11 2>/dev/null)
  print -r -- "$t" > "$O/f/${f:t:r}.txt"
  print -r -- "$t" | grep -inE "$PAT" | grep -vE '^[0-9]+:[^ ]*run-[0-9a-f]{8}-[0-9a-f-]{27}$' \
    | while read -r line; do print -r -- "$s\t$line" >> "$O/hits.tsv"; done
done
print "frames=$(ls "$O"/f/*.png | wc -l | tr -d ' ') hits=$(wc -l < "$O/hits.tsv" | tr -d ' ')"
