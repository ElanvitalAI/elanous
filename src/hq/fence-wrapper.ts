import { spawnSync } from 'node:child_process';
import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { createPatch } from 'diff';

const quote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

/** Only the installed entrypoint runs the fence; never use a checkout as a fallback.
 * Arbiter (cloud-vm) outage retains the current lease and forbids promotion;
 * this wrapper does not change the fence's lease or promotion decisions.
 * cron runs with PATH=/usr/bin:/bin, so bun is baked in as an absolute path (OP 10-06 NO-GO). */
export function renderHqFenceWrapper({ entry, configDir, bun, logFile }: { entry: string; configDir: string; bun: string; logFile?: string }): string {
  if (!isAbsolute(bun)) throw new Error(`hq-fence: bun must be an absolute path: ${bun}`);
  const log = logFile ?? join(configDir, 'logs', 'hq-fence.log');
  return `#!/bin/sh
# Arbiter (cloud-vm) outage: retain the lease, do not promote; hq fence owns that decision.
ENTRY=${quote(entry)}
CONFIG_DIR=${quote(configDir)}
# cron has no PATH for bun — the absolute path was resolved when this wrapper was installed.
BUN=${quote(bun)}
LOG=${quote(log)}
# Last resort when no alert path works: one line in a log file, no bun needed.
log_line() {
  mkdir -p "$(dirname "$LOG")" 2>/dev/null
  printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG" 2>/dev/null
}
# The alert goes through the same installed entry; PATH \`elanous\` is only a fallback when the entry itself is missing.
# Alert bun: the installed one first, then usual absolute install locations (still no PATH lookup).
alert_bun() {
  for b in "$BUN" "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
    if [ -x "$b" ]; then echo "$b"; return 0; fi
  done
  return 1
}
alert() {
  if [ -f "$ENTRY" ] && AB=$(alert_bun); then
    if "$AB" "$ENTRY" --config-dir "$CONFIG_DIR" hq fence-wrapper alert "$1"; then return 0; fi
    echo "hq-fence: owner alert failed: $1" >&2
    log_line "owner alert failed: $1"
    return 0
  fi
  if command -v elanous >/dev/null 2>&1 && elanous --config-dir "$CONFIG_DIR" hq fence-wrapper alert "$1"; then return 0; fi
  echo "hq-fence: owner alert failed: $1" >&2
  log_line "owner alert failed: $1"
}
if [ ! -x "$BUN" ]; then
  echo "hq-fence: bun missing or not executable: $BUN" >&2
  # Exactly one line on disk; the alert is tried only through an absolute fallback bun (never PATH).
  log_line "bun missing or not executable: $BUN (rc=127)"
  if [ -f "$ENTRY" ] && AB=$(alert_bun); then
    "$AB" "$ENTRY" --config-dir "$CONFIG_DIR" hq fence-wrapper alert "hq-fence: bun missing or not executable: $BUN (rc=127)" || echo "hq-fence: owner alert failed (fallback bun $AB)" >&2
  fi
  exit 127
fi
if [ ! -f "$ENTRY" ] || [ ! -r "$ENTRY" ]; then
  echo "hq-fence: installed entrypoint missing: $ENTRY" >&2
  alert "hq-fence: installed entrypoint missing: $ENTRY"
  exit 1
fi
cd "$(dirname "$ENTRY")/.." || { alert "hq-fence: installed directory missing"; exit 1; }
if [ $# -lt 1 ] || [ -z "$1" ]; then
  echo "hq-fence: role required" >&2
  alert "hq-fence: role required"
  exit 2
fi
ROLE=$1
shift
"$BUN" "$ENTRY" --config-dir "$CONFIG_DIR" hq fence --role "$ROLE" -- /bin/sh -c "$*"
rc=$?
if [ "$rc" -ne 0 ]; then alert "hq-fence: fence failed (rc=$rc, role=$ROLE)"; fi
exit "$rc"
`;
}

/** Absolute bun for the wrapper: this process when it is bun, else `command -v bun` resolved now (install time). */
export function resolveHqFenceBun(deps: { isBun?: boolean; execPath?: string; lookup?: () => string } = {}): string {
  const isBun = deps.isBun ?? typeof process.versions.bun === 'string';
  const candidate = isBun
    ? (deps.execPath ?? process.execPath)
    : (deps.lookup ?? (() => spawnSync('/bin/sh', ['-c', 'command -v bun'], { encoding: 'utf8' }).stdout ?? ''))().trim();
  if (!candidate || !isAbsolute(candidate)) throw new Error(`hq-fence: cannot resolve an absolute bun path (got ${JSON.stringify(candidate)})`);
  return realpathSync(candidate);
}

export function installedHqFenceEntry(home = homedir()): string {
  return join(home, '.local', 'share', 'elanous', 'current', 'node_modules', 'elanous', 'bin', 'elanous.mjs');
}

/** Literal \`cd <path>\` lines only — a worktree path built from a variable is not detected. */
export function repositoryWorktreeCdWarning(body: string): string | undefined {
  return body.split('\n').some(line => /^\s*cd\s+(?:['"]?[^\s'";]+\/)?(?:wt-[^\s'";]+|[^\s'";]+\/repo\.worktrees\/[^\s'";]+)(?:['"]?\s*(?:&&|\|\||;|#|$))/.test(line))
    ? 'hq fence-audit: warning — hq-fence wrapper cd targets a repository worktree' : undefined;
}

export function installHqFenceWrapper(configDir: string, body: string, yes: boolean, deps: {
  now?: () => Date;
} = {}): { path: string; preview: string; backup?: string } {
  const path = join(configDir, 'bin', 'hq-fence');
  let present = false;
  try { present = !!lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (present && !lstatSync(path).isFile()) throw new Error(`hq-fence: refusing non-regular wrapper: ${path}`);
  const old = present ? readFileSync(path, 'utf8') : undefined;
  const preview = `hq-fence proposed: ${path}\n${body}\n${createPatch(path, old ?? '', body, 'existing', 'proposed')}`;
  if (!yes) return { path, preview };
  let backup: string | undefined;
  if (present) {
    const backups = join(configDir, 'backups');
    mkdirSync(backups, { recursive: true });
    const stamp = (deps.now ?? (() => new Date()))().toISOString().replaceAll(':', '-');
    backup = join(backups, `hq-fence.${stamp}`);
    copyFileSync(path, backup, constants.COPYFILE_EXCL);
  }
  mkdirSync(dirname(path), { recursive: true });
  const tempDir = mkdtempSync(join(dirname(path), '.hq-fence-'));
  try {
    const temp = join(tempDir, 'hq-fence');
    writeFileSync(temp, body, { flag: 'wx', mode: 0o755 });
    chmodSync(temp, 0o755);
    renameSync(temp, path);
  } finally { rmSync(tempDir, { recursive: true, force: true }); }
  return { path, preview, ...(backup ? { backup } : {}) };
}
