#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/rail-register-test.XXXXXX")
mkdir -p "$tmp/bin" "$tmp/home"
cat >"$tmp/bin/els" <<'EOF'
#!/bin/sh
printf 'els %s\n' "$*" >>"$CALLS"
exit "${ELS_EXIT:-0}"
EOF
cat >"$tmp/bin/eln" <<'EOF'
#!/bin/sh
printf 'eln %s\n' "$*" >>"$CALLS"
exit "${ELN_EXIT:-0}"
EOF
chmod +x "$tmp/bin/els" "$tmp/bin/eln"
export HOME="$tmp/home" PATH="$tmp/bin:$PATH" CALLS="$tmp/calls"
: >"$CALLS"
sh "$root/scripts/rail-update-register.sh"
printf 'els update-all\neln loop trigger register --update\n' >"$tmp/expected"
cmp "$tmp/expected" "$CALLS"
: >"$CALLS"
rc=0
ELS_EXIT=17 sh "$root/scripts/rail-update-register.sh" || rc=$?
[ "$rc" -eq 17 ]
printf 'els update-all\n' >"$tmp/expected"
cmp "$tmp/expected" "$CALLS"
: >"$CALLS"
rc=0
ELN_EXIT=23 sh "$root/scripts/rail-update-register.sh" || rc=$?
[ "$rc" -eq 23 ]
printf 'els update-all\neln loop trigger register --update\n' >"$tmp/expected"
cmp "$tmp/expected" "$CALLS"
printf 'PASS success order and exactly one registration; update failure exit=17 and no registration; registration failure exit=23; evidence=%s\n' "$tmp"
