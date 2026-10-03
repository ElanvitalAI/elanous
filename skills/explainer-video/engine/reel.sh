#!/bin/zsh
# Field reel: standard full composition or instant body with cached cards.
# The layout/contrast check is advisory: phone photos behind captions often miss 3:1, and a failed check must not stop the reel.
# Usage: zsh reel.sh <folder> [--title "…"] [--sub "…"] [--instant]   (captions: <folder>/captions.txt — `파일 | 자막`)
E=${0:A:h}
if [[ $1 == --warm-cards ]]; then
  shift
  node $E/stitch.mjs --warm-cards "$@"
  exit $?
fi
F=${1:A}; shift
[[ -d $F ]] || { print -u2 "reel: no folder $F"; exit 2 }
T0=$(date +%s)
instant=0
args=()
for arg in "$@"; do
  if [[ $arg == --instant ]]; then instant=1; else args+=("$arg"); fi
done
rm -rf $F/reel
if (( instant )); then
  node $E/reel.mjs $F "${args[@]}" --part body &&
    (cd $F/reel/hf && { npx -y hyperframes@${HYPERFRAMES_VERSION:-0.8.95} check >../render.log 2>&1 || print "reel: check reported issues (continuing — user photos vary; see above)" >>../render.log }; npx -y hyperframes@${HYPERFRAMES_VERSION:-0.8.95} render --fps 30 --workers 4 --output ../body.mp4 >>../render.log 2>&1) &&
    node $E/stitch.mjs --instant $F >>$F/reel/render.log 2>&1 || { print -u2 "reel: FAILED — see $F/reel/render.log"; exit 1 }
  print "reel: $F/reel/reel-9x16.mp4 · $(( $(date +%s) - T0 ))s (instant)"
else
  node $E/reel.mjs $F "${args[@]}" && (cd $F/reel/hf && { npx -y hyperframes@${HYPERFRAMES_VERSION:-0.8.95} check >../render.log 2>&1 || print "reel: check reported issues (continuing — user photos vary; see above)" >>../render.log }; npx -y hyperframes@${HYPERFRAMES_VERSION:-0.8.95} render --fps 30 --workers 4 --output ../reel-9x16.mp4 >>../render.log 2>&1) || { print -u2 "reel: FAILED — see $F/reel/render.log"; exit 1 }
  print "reel: $F/reel/reel-9x16.mp4 · $(( $(date +%s) - T0 ))s"
fi
