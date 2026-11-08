import { gateTestBaseline } from '../lib/gate-test-env.js';
import { gateDepsInstallScript } from '../../src/task-orchestrator/surfaces/pod-gate-deps.js';
import { installSlotScript } from '../../src/task-orchestrator/surfaces/pod-install-slots.js';
import { isGateSpawnLaneFile } from './spawn-lane.js';

export const shellQuoteArgument = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const quote = shellQuoteArgument;
export const asPath = (path: string) => path.startsWith('./') || path.startsWith('/') ? path : `./${path}`;

/**
 * GATE-ENV-BASELINE (W5 · 10-15) — the gate shard Pod's deterministic test env, exported before anything runs.
 * 0.2.29 gate failures were the Pod's «environment», not the code: no LLM provider · `man` stubbed · CLI spawn timeouts.
 * - `TZ=UTC` — the value `bun test` already uses when TZ is unset; pinned so a later image (or a shell profile) cannot move it.
 * - `LANG`/`LC_ALL=C.UTF-8` — the image sets no locale (POSIX); C.UTF-8 ships with glibc, so no image rebuild.
 * - `ELANOUS_TEST_FAKE_LLM=1` — the shared switch for the fake LLM provider. Its reader (UX device #27790) is not on main
 *   yet; until it lands the switch changes nothing. The reader yields to an explicit provider/endpoint, so a spawned CLI
 *   test that injects its own stub keeps it.
 * Retries, splits and file isolation all re-enter `runShard`, which builds every Pod shell here — they carry it too.
 * Provider keys are not set here on purpose: `test:deterministic` strips every credential-shaped key
 * (`scripts/lib/deterministic-env.ts` `isCredentialKey`), so a test never reaches a real provider from the Pod.
 * Binaries the image lacks (`man` pages — `git <sub> --help`) are not fixed here; see MANUAL-gate-regression-response-recipe §2a.
 */
export function gateEnvBaselineLine(env: Readonly<Record<string, string>> = gateTestBaseline(process.env)): string {
  return `export ${Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(' ')}`;
}
/**
 * The shard's Pod shell. Install once (behind the node's install slots), then run each part under the soft deadline,
 * leaving `install.log`/`install.rc`, `part-<i>.log`/`.rc`/`.junit.xml`, and `shard.timeout` (the part index) when the
 * deadline cut the shard. Real child/PTY parts have an additional 120 s test limit; a cap hit also writes
 * `shard.timeout` so the artifact reader does not mistake an unfinished child for a test verdict.
 * A part without `.rc` did not finish. The shell itself always exits 0 (as before).
 */
export function gateShardShell(o: { parts: readonly (readonly string[])[]; cdpPatterns: readonly string[]; softSeconds: number; cachePrefix: string; installSlots: number; depsDir?: string; beatSeconds?: number; parallelParts?: number; testTimeoutMs?: number; partLimitSeconds?: number; rulesBaseSha?: string; sourceBinding?: { cutSha: string; attemptId: string } }): string {
  if (o.rulesBaseSha !== undefined && !/^[0-9a-f]{40}$/.test(o.rulesBaseSha)) throw new Error('invalid rules gate base SHA');
  // The planner keeps spawn files in their own shards; reject a mixed part rather than silently lose its limit.
  for (const part of o.parts) {
    if (part.some(isGateSpawnLaneFile) && !part.every(isGateSpawnLaneFile)) throw new Error('gate spawn lane part mixed with regular tests');
  }
  const spawnParts = o.parts.flatMap((part, index) => part.length && part.every(isGateSpawnLaneFile) ? [index] : []);
  const commands = o.parts.map((part, index) => {
    const ignores = o.cdpPatterns.filter((pattern) => part.includes(pattern)).flatMap((pattern) => ['--path-ignore-patterns', pattern]);
    // One-file runs keep named pass lines so their JUnit identities can be
    // cross-checked. The package script's --dots removes those names.
    const runner = part.length === 1 ? ['bun', 'run', 'scripts/test-deterministic.ts'] : ['bun', 'run', 'test:deterministic'];
    // Bash scopes this assignment to run_part; the mixed-part shell test
    // checks that a following multi-file part gets no source tag. The common
    // run_part body changes the shell hash once for this feature; keeping the
    // multi-file invocation unchanged avoids another cache-key change.
    const warmFile = part.length === 1 ? `WARM_REFERENCE_FILE=${quote(part[0]!)} ` : '';
    const manifest = `printf '%s\\n' ${part.map(quote).join(' ')} > "$O/part-${index}.files"; `;
    return `${manifest}${warmFile}run_part ${index} ${[...runner, ...(o.testTimeoutMs !== undefined ? ['--timeout', String(o.testTimeoutMs)] : spawnParts.includes(index) ? ['--timeout=120000'] : []), ...ignores, ...part.map(asPath)].map(quote).join(' ')}`;
  });
  // Only file-isolation batches use this path. A bounded group shares one clone/install, but every test process gets
  // its own HOME, state and tmp directory; part logs/JUnit remain separate and the existing artifact reader judges them.
  const width = Math.max(1, Math.floor(o.parallelParts ?? 1));
  const isolateParts = o.parallelParts !== undefined;
  const run = width === 1 ? commands.join(' && ') : Array.from({ length: Math.ceil(commands.length / width) }, (_, group) => [
    ...commands.slice(group * width, (group + 1) * width).map((line) => `(${line}) & pids+=("$!")`),
    'for pid in "${pids[@]}"; do wait "$pid" || true; done; pids=()',
  ].join('; ')).join('; ');
  return [
    'mkdir -p "$HOME/outbox"; O="$HOME/outbox"',
    'stage_at() { printf "%s\\t%s\\n" "$1" "$2" >> "$O/stages.tsv"; }',
    'stage() { stage_at "$(date +%s)" "$1"; }',
    // This shell's first moment, captured before anything else runs so clone-end/shell-start keep their meaning.
    'shell_t=$(date +%s)',
    // Boot stages only: the container's age at shell entry. gate_end below keeps reading pod_age at its own spot.
    `boot_age=$(awk -v t="$(cut -d' ' -f22 /proc/1/stat 2>/dev/null)" -v hz="$(getconf CLK_TCK 2>/dev/null)" '{ if (t > 0 && hz > 0) print int($1 - t / hz); else print 0 }' /proc/uptime 2>/dev/null)`,
    'case "$boot_age" in ""|*[!0-9]*) boot_age=0;; esac',
    // GATE-WARM-BOOT-STAGES: boot on the Pod's own clock — prep start = the child container's PID 1 (none when the age is
    // unknown, never a guess), clone end = this shell's first line (the source checkout runs right before it).
    'if [ "$boot_age" -gt 0 ]; then stage_at "$(( shell_t - boot_age ))" prep-start; fi',
    'stage_at "$shell_t" clone-end',
    'stage_at "$shell_t" shell-start',
    ...(o.beatSeconds ? gateBeatScript(o.beatSeconds, o.installSlots > 0) : []),
    ...(o.cachePrefix ? [o.cachePrefix] : []),
    gateEnvBaselineLine(),
    `bun -e ${quote("const {createHash}=require('node:crypto');const keys=['ELANOUS_TEST_FAKE_LLM','LANG','LC_ALL','TZ'];const e=Object.fromEntries(keys.sort().map(k=>[k,process.env[k]??'']));const envFingerprint=createHash('sha256').update(JSON.stringify(e)).digest('hex');console.log(JSON.stringify({bunVersion:Bun.version,platform:process.platform,architecture:process.arch,envFingerprint,baseImageDigest:process.env.ELANOUS_GATE_BASE_IMAGE_DIGEST??''}));")} > "$O/runtime-identity.json" 2> "$O/runtime-identity.err" || rm -f "$O/runtime-identity.json"`,
    ...(o.rulesBaseSha ? [`export ELANOUS_GATE_BASE_SHA=${quote(o.rulesBaseSha)}`] : []),
    // Seconds since this container's PID 1 started (the clone ran before this shell) — 0 when /proc cannot tell.
    `pod_age=$(awk -v t="$(cut -d' ' -f22 /proc/1/stat 2>/dev/null)" -v hz="$(getconf CLK_TCK 2>/dev/null)" '{ if (t > 0 && hz > 0) print int($1 - t / hz); else print 0 }' /proc/uptime 2>/dev/null)`,
    'case "$pod_age" in ""|*[!0-9]*) pod_age=0;; esac',
    `gate_end=$(( $(date +%s) + ${Math.max(1, Math.floor(o.softSeconds))} - pod_age ))`,
    ...(o.installSlots > 0 ? [installSlotScript({ slots: o.installSlots })] : []),
    'run_part() {',
    '  local i=$1; shift',
    ...(spawnParts.length ? ['  local spawn_part=0', `  case "$i" in ${spawnParts.join('|')}) spawn_part=1;; esac`] : []),
    '  stage "part-$i-start"',
    ...(isolateParts ? [
      '  local isolated; isolated=$(mktemp -d /tmp/gate-isolate.XXXXXX) || return 1',
      '  mkdir -p "$isolated/home" "$isolated/tmp" "$isolated/state" "$isolated/config" "$isolated/cache" "$isolated/data" "$isolated/xdg-state"',
      '  local source_repo="$PWD"',
      '  local -a run_env=(env HOME="$isolated/home" TMPDIR="$isolated/tmp" ELANOUS_STATE_DIR="$isolated/state" XDG_CONFIG_HOME="$isolated/config" XDG_CACHE_HOME="$isolated/cache" XDG_DATA_HOME="$isolated/data" XDG_STATE_HOME="$isolated/xdg-state")',
      '  stage "part-$i-setup-start"',
      '  local source_sha; source_sha=$(git rev-parse HEAD) || return 1',
      '  if ! "${run_env[@]}" git clone --shared --quiet --no-checkout "$source_repo" "$isolated/repo" > "$O/part-$i.setup.log" 2>&1 || ! "${run_env[@]}" git -C "$isolated/repo" checkout --detach --quiet "$source_sha" >> "$O/part-$i.setup.log" 2>&1; then cat "$O/part-$i.setup.log" > "$O/part-$i.log"; rm -rf "$isolated"; return 1; fi',
      '  if ! bash scripts/release-loop/remote-worktree-setup.sh "$source_repo" "$isolated/repo" >> "$O/part-$i.setup.log" 2>&1; then cat "$O/part-$i.setup.log" > "$O/part-$i.log"; rm -rf "$isolated"; return 1; fi',
      '  cd "$isolated/repo" || return 1',
      '  stage "part-$i-setup-end"',
    ] : ['  local -a run_env=()']),
    '  local left=$(( gate_end - $(date +%s) ))',
    '  if [ "$left" -le 0 ]; then echo "$i" > "$O/shard.timeout"; return 1; fi',
    ...(spawnParts.length ? ['  if [ "$spawn_part" -eq 1 ] && [ "$left" -gt 120 ]; then left=120; fi'] : []),
    ...(o.partLimitSeconds ? [`  if [ "$left" -gt ${o.partLimitSeconds} ]; then left=${o.partLimitSeconds}; fi`] : []),
    '  stage "part-$i-test-start"',
    ...(spawnParts.length ? ['  local test_start; test_start=$(date +%s)'] : []),
    `  { if [ -n "\${WARM_REFERENCE_FILE:-}" ]; then printf "[warm-worker] file=%s\\n" "$WARM_REFERENCE_FILE"; ${o.sourceBinding ? `printf "[warm-worker] cut=%s attempt=%s\\n" ${quote(o.sourceBinding.cutSha)} ${quote(o.sourceBinding.attemptId)}; ` : ''}fi; "\${run_env[@]}" timeout -k 10 "$left" "$@" --reporter=junit --reporter-outfile="$O/part-$i.junit.xml"; } > "$O/part-$i.log" 2>&1`,
    '  local prc=$?',
    '  if [ -s "$O/part-$i.junit.xml" ]; then',
    '    if bun run scripts/release-loop/gate-shard-load-flaky.ts "$O/part-$i.junit.xml" "$O/part-$i.retry-files" "$O/part-$i.files"; then',
    '      local retry_index=0 retry_left retry_rc retry_file',
    '      while IFS= read -r retry_file; do',
    '        [ -n "$retry_file" ] || continue',
    '        retry_left=$(( gate_end - $(date +%s) ))',
    '        [ "$retry_left" -gt 0 ] || break',
    '        [ "$retry_left" -le 120 ] || retry_left=120',
    '        stage "part-$i-retry-$retry_index-start"',
    '        : > "$O/part-$i.retry-$retry_index.started"',
    '        timeout -k 10 "$retry_left" "${run_env[@]}" bun run scripts/test-deterministic.ts "$retry_file" --timeout 120000 --reporter=junit --reporter-outfile="$O/part-$i.retry-$retry_index.junit.xml" > "$O/part-$i.retry-$retry_index.log" 2>&1',
    '        retry_rc=$?',
    '        echo "$retry_rc" > "$O/part-$i.retry-$retry_index.rc"',
    '        stage "part-$i-retry-$retry_index-end"',
    '        retry_index=$(( retry_index + 1 ))',
    '      done < "$O/part-$i.retry-files"',
    '    fi',
    '  fi',
    '  if [ -n "${WARM_REFERENCE_FILE:-}" ] && [ -f "$O/part-$i.junit.xml" ]; then',
    '    local junit_sha; junit_sha=$(sha256sum "$O/part-$i.junit.xml" 2>/dev/null | awk \'{print $1}\')',
    '    if [ -z "$junit_sha" ]; then junit_sha=$(shasum -a 256 "$O/part-$i.junit.xml" 2>/dev/null | awk \'{print $1}\'); fi',
    '    if [[ "$junit_sha" =~ ^[a-f0-9]{64}$ ]]; then printf "[warm-worker] junit-sha256=%s\\n" "$junit_sha" >> "$O/part-$i.log"; fi',
    '  fi',
    ...(o.partLimitSeconds ? ['  if [ "$prc" -eq 124 ] || [ "$prc" -eq 137 ]; then echo "$i" > "$O/part-$i.timeout"; fi'] : []),
    ...(spawnParts.length ? ['  local test_end; test_end=$(date +%s)'] : []),
    '  stage "part-$i-test-end"',
    ...(isolateParts ? ['  stage "part-$i-cleanup-start"', '  cd "$source_repo"', '  rm -rf "$isolated"', '  stage "part-$i-cleanup-end"'] : []),
    '  stage "part-$i-end"',
    ...(spawnParts.length ? ['  if [ "$spawn_part" -eq 1 ] && { [ "$prc" -eq 124 ] || { [ "$test_end" -ge "$(( test_start + left ))" ] && { [ "$prc" -eq 137 ] || [ "$prc" -eq 143 ]; }; }; }; then echo "$i" > "$O/shard.timeout"; return 1; fi'] : []),
    '  if [ "$(date +%s)" -ge "$gate_end" ] && { [ "$prc" -eq 124 ] || [ "$prc" -eq 137 ] || [ "$prc" -eq 143 ]; }; then echo "$i" > "$O/shard.timeout"; return 1; fi',
    '  echo "$prc" > "$O/part-$i.rc"',
    '}',
    'if cd .. && cd repo; then',
    '  stage deps-start',
    // GATE-IMAGE-DEPS: link the image's baked node_modules when the lockfiles match; only a miss installs (behind a slot).
    ...gateDepsInstallScript({ log: '"$O/install.log"', installSlots: o.installSlots, ...(o.depsDir ? { depsDir: o.depsDir } : {}) }).split('\n').map((line) => `  ${line}`),
    '  echo "$irc" > "$O/install.rc"',
    '  stage deps-end',
    `  if [ "$irc" -eq 0 ]; then stage test-start; ${width > 1 ? 'pids=(); ' : ''}${run || 'true'}; stage test-end; fi`,
    'else echo 5 > "$O/install.rc"; fi',
    'stage shell-end',
    'true',
  ].join('\n');
}
/**
 * GATE-POD-STALL-FAILFAST (0.2.24) — the shard shell's live heartbeat on the Pod's stdout (everything else goes to the
 * outbox, which the host sees only after the Job ends). 10-10 0.2.24 gate: the node's containerd was unresponsive, all 28
 * shards ran to their 1697 s deadline with `finishedFiles: 0`, then retries and splits did the same for 2h+ and the node
 * never finished. The beat lets the host see «no test output yet» while the Job runs:
 * `ELANOUS_GATE_BEAT <seq> <slot|install|test> <0|1>` — the last field is 1 once any part log has a byte.
 * GATE-POD-STALL-FAILFAST ① (mid-run): once there is test output the beat adds the part logs' total bytes —
 * `ELANOUS_GATE_BEAT <seq> test 1 <bytes>` — so the host can see output stop after it started. The old 4-field line is
 * still read (no bytes = no mid-run watch).
 * It is observation only: the host hashes the shell without it into `runKey`.
 */
export function gateBeatScript(beatSeconds: number, installSlots: boolean): string[] {
  return [
    'gate_beat() {',
    '  local n=0 st t f',
    '  while :; do',
    '    n=$((n + 1)); t=0; b=0',
    '    for f in "$O"/part-*.log; do if [ -s "$f" ]; then t=1; b=$(( b + $(wc -c < "$f" 2>/dev/null || echo 0) )); fi; done',
    '    if [ -f "$O/install.rc" ]; then st=test',
    // A deps miss with no slot line yet = waiting for an install slot (bounded by the slot script; not a stall).
    ...(installSlots ? ["    elif [ -f \"$O/install.log\" ] && grep -q '^\\[gate\\] deps .* miss' \"$O/install.log\" 2>/dev/null && ! grep -q '^\\[gate\\] install-slot' \"$O/install.log\" 2>/dev/null; then st=slot"] : []),
    '    else st=install; fi',
    '    if [ "$t" = 1 ]; then echo "ELANOUS_GATE_BEAT $n $st $t $b"; else echo "ELANOUS_GATE_BEAT $n $st $t"; fi',
    `    sleep ${Math.max(1, Math.floor(beatSeconds))} >/dev/null 2>&1 </dev/null`,
    '  done',
    '}',
    'gate_beat & gate_beat_pid=$!',
    // Stopped before the shell returns, so no beat line lands between the Job's artifact lines.
    'trap \'kill "$gate_beat_pid" 2>/dev/null; wait "$gate_beat_pid" 2>/dev/null\' EXIT',
  ];
}

export const GATE_SHARD_ABORT_GRACE_SECONDS = 10;
/**
 * GATE-POD-STALL-FAILFAST ① — run inside the shard Pod (`kubectl exec … bash -c`): ends only the running test process
 * groups — the group led by a process whose argv carries `--reporter-outfile=…/outbox/part-<i>.junit.xml` (GNU `timeout`
 * leads its own group) — TERM now, KILL after the grace. It never signals PID 1's group or its own. Before the signal it
 * leaves `part-<i>.abort` (the reason) and `shard.timeout`, so the outbox reads like a deadline cut of that part
 * ({@link readShardArtifacts}: unfinished, timed out) while the shell finishes the remaining parts and its outbox.
 * Exit 0 = at least one group signalled.
 */
export function gateShardAbortScript(reason: string, graceSeconds = GATE_SHARD_ABORT_GRACE_SECONDS,
  /** Only this outbox's parts (tests: never another run's groups on the same machine); absent = any `…/outbox/` in the Pod. */
  outbox?: string): string {
  return [
    `reason=${quote(reason.replace(/[^\w .:-]/g, '_'))}`,
    `only=${quote(outbox ?? '')}`,
    // Read after the final ')' because comm can itself contain spaces and ')'. starttime is field 20 in the suffix
    // (field 22 in proc stat); pairing it with PID prevents a recycled PID from validating an old group number.
    "proc_identity() { sed 's/^.*) //' \"/proc/$1/stat\" 2>/dev/null | awk '{print $3, $20}'; }",
    "pg_of() { proc_identity \"$1\" | awk '{print $1}'; }",
    'root_pg=$(pg_of 1); my_pg=$(pg_of $$); found=0',
    'for d in /proc/[0-9]*; do',
    '  pid=${d#/proc/}',
    "  out=$(tr '\\0' '\\n' < \"$d/cmdline\" 2>/dev/null | grep -m1 -E '^--reporter-outfile=.*/outbox/part-[0-9]+\\.junit\\.xml$') || continue",
    '  if [ -n "$only" ]; then case "$out" in "--reporter-outfile=$only/part-"*) ;; *) continue;; esac; fi',
    '  identity=$(proc_identity "$pid")',
    '  pg=${identity%% *}; started=${identity#* }',
    '  case "$pg:$started" in *[!0-9:]*|:|*:|:*) continue;; esac',
    '  if [ "$pg" != "$pid" ] || [ "$pg" -le 1 ] || [ "$pg" = "$root_pg" ] || [ "$pg" = "$my_pg" ]; then continue; fi',
    // Re-read the process identity immediately before signaling. The same check guards delayed KILL so a PID/PGID
    // that disappeared and was reused during the grace interval is never signaled as if it were the original test.
    '  [ "$(proc_identity "$pid")" = "$identity" ] || continue',
    '  out=${out#--reporter-outfile=}; dir=${out%/part-*}; part=${out##*/part-}; part=${part%.junit.xml}',
    '  if [ "$(proc_identity "$pid")" = "$identity" ] && kill -TERM -- "-$pg" 2>/dev/null; then',
    '    printf "%s\\n" "$reason" > "$dir/part-$part.abort"',
    '    [ -f "$dir/shard.timeout" ] || echo "$part" > "$dir/shard.timeout"',
    '    found=$((found + 1)); echo "ELANOUS_GATE_ABORT part=$part pgid=$pg"',
    `    ( sleep ${Math.max(1, Math.floor(graceSeconds))}; [ "$(proc_identity "$pid")" = "$identity" ] && kill -KILL -- "-$pg" 2>/dev/null ) >/dev/null 2>&1 </dev/null &`,
    '  fi',
    'done',
    'echo "ELANOUS_GATE_ABORT signalled=$found"',
    '[ "$found" -gt 0 ]',
  ].join('\n');
}
