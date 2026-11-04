#!/bin/zsh
emulate -L zsh
set -euo pipefail

root=${0:A:h:h}
terra_model=$(cd "$root" && bun -e "import('./src/llm/model-defaults.ts').then(({tierModel}) => console.log(tierModel('better', 'openai-codex')))" )
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
repo=$tmp/repo
queue_dir=$tmp/seat
rr=$tmp/reviews
mkdir -p $repo $queue_dir $rr $tmp/ev $tmp/gates
cd $repo
git init -q --initial-branch=main
git config user.email test@example.invalid
git config user.name test
echo node_modules/ > .gitignore
print base > readme.txt
git add .gitignore readme.txt
git commit -qm base
base=$(git rev-parse HEAD)
git switch -qc feature/land-test
print change > change.txt
git add change.txt
git commit -qm change
head=$(git rev-parse HEAD)
git update-ref refs/remotes/origin/main $base
mkdir -p node_modules

cat > "$tmp/gh" <<'GH'
#!/bin/sh
cat "$GH_FIXTURE"
GH
cat > "$tmp/product" <<'PRODUCT'
#!/bin/sh
printf '✓ overlap: fixture pass\n'
PRODUCT
chmod +x "$tmp/gh" "$tmp/product"
cat > "$tmp/pr.json" <<JSON
{"headRefOid":"$head","headRefName":"feature/land-test","isDraft":false,"state":"OPEN","body":""}
JSON
cat > "$rr/card-error-9001-${head[1,12]}.json" <<JSON
{"pr":9001,"headCommit":"$head","error":"review attempt could not run"}
JSON
cat > "$rr/card-pass-9001-${head[1,12]}.json" <<JSON
{"pr":9001,"headCommit":"$head","reviewed":true,"verdict":"pass","mustFix":[],"model":"$terra_model"}
JSON
print -r -- $'9001\told-head\tfeature/land-test\told-evidence' > "$queue_dir/land-queue.tsv"
print -r -- $'# pr\thead\n9001\told-head' > "$queue_dir/land-queue.front.tsv"

output=$(GH_STUB="$tmp/gh" GH_FIXTURE="$tmp/pr.json" LAND_PRODUCT_STUB="$tmp/product" \
  LAND_Q="$queue_dir/land-queue.tsv" LAND_EVDIR="$tmp/ev" LAND_RR_DIR="$rr" \
  LAND_SEAT_TREE="$repo" LAND_GATE_ROOT="$tmp/gates" LAND_NO_FETCH=1 \
  zsh "$root/land-enqueue.sh" 9001 "$repo" --expected-head "$head" --front 2>&1)
print -r -- "$output"
[[ "$output" == *"review-error-ignored=card-error-9001-${head[1,12]}.json"* ]]
[[ $(grep -c "^9001[[:space:]]" "$queue_dir/land-queue.front.tsv") == 1 ]]
[[ $(cut -f2 "$queue_dir/land-queue.front.tsv" | tail -1) == "$head" ]]
[[ $(grep -c "^9001[[:space:]]" "$queue_dir/land-queue.tsv") == 1 ]]
print 'PASS land-enqueue review-error NOTES and --front re-registration'
