#!/bin/bash
# K10 D5b ① — test/ 파일별 커버리지(node-b). 산출: ~/f-audit/cov/<n>/lcov.info ⊕ index.tsv(file n rc secs)
set -u
A=~/f-audit; rm -rf $A && mkdir -p $A/cov $A/logs && cd $A
git clone -q --depth 1 file://$HOME/mirror/elanous-agent.git repo || exit 2
cd repo && git log --oneline -1 > $A/COMMIT && ~/.local/share/elanous/bin/bun install --frozen-lockfile >/dev/null 2>&1 || echo "install rc=$?" >> $A/COMMIT
git ls-files 'test/*.test.ts' 'test/**/*.test.ts' | grep -v '^test/integration/' | awk '{print NR"\t"$0}' > $A/list.tsv
wc -l < $A/list.tsv > $A/TOTAL
run_one() {
  n="$1"; f="$2"; s=$(date +%s)
  ( ulimit -v 8000000 2>/dev/null; timeout 120 ~/.local/share/elanous/bin/bun test "./$f" --coverage --coverage-reporter=lcov --coverage-dir "$HOME/f-audit/cov/$n" > "$HOME/f-audit/logs/$n.log" 2>&1 ); rc=$?
  printf '%s\t%s\t%s\t%s\n' "$f" "$n" "$rc" "$(( $(date +%s) - s ))" >> "$HOME/f-audit/index.tsv"
}
export -f run_one
cd $A/repo && awk -F'\t' '{print $1" "$2}' $A/list.tsv | xargs -P 8 -n 2 bash -c 'run_one "$0" "$1"'
echo DONE > $A/DONE
