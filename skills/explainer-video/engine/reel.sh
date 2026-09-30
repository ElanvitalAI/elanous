#!/bin/zsh
# Field reel in one command: folder of phone photos/clips → <folder>/reel/<name>-9x16.mp4 · prints the elapsed seconds.
# Usage: zsh reel.sh <folder> [--title "…"] [--sub "…"]   (captions: <folder>/captions.txt — `파일 | 자막`)
E=${0:A:h}; F=${1:A}; shift
[[ -d $F ]] || { print -u2 "reel: no folder $F"; exit 2 }
T0=$(date +%s)
rm -rf $F/reel && node $E/reel.mjs $F "$@" && (cd $F/reel/hf && npx -y hyperframes@${HYPERFRAMES_VERSION:-0.8.95} check >../render.log 2>&1 && npx -y hyperframes@${HYPERFRAMES_VERSION:-0.8.95} render --fps 30 --workers 4 --output ../reel-9x16.mp4 >>../render.log 2>&1) || { print -u2 "reel: FAILED — see $F/reel/render.log"; exit 1 }
print "reel: $F/reel/reel-9x16.mp4 · $(( $(date +%s) - T0 ))s"
