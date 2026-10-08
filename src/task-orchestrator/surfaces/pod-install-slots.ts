// GATE-INSTALL-CACHE (0.2.20) — a node-wide throttle for the release-gate shards' `bun install`.
//
// Cause, measured on the 0.2.19 gate (`elanous logs --category release-loop.gate --event pod-shard --all --include-test`):
//   · no cache is «not» the cause — the harness image carries a warm Bun cache, and a Pod that installed alone
//     (10-07 10:48–10:55 · 12:13 · 12:16) took 2.4–5.0 s with `pod-bun-cache source=none`;
//   · the same install took 150–340 s when 24 shard Pods (or ~20 isolation Pods) started together on the one 32-CPU
//     node-b node (09:3x round 1: 221–337 s · 11:4x round 3: 150–240 s · 10:34 isolation wave: 124–188 s).
//   ⇒ concurrent installs thrash the node (24 × copying node_modules out of the image cache + CPU), so a shared
//   hostPath Bun cache would not help (the bytes are already local) — fewer installs «at once» does.
//
// Concurrency safety: the hostPath holds only throttle tokens (`slot-<n>` directories), never packages. Each Pod still
// installs into its own container (its own node_modules, its own image-local Bun cache), so correctness never depends on
// the token: a lost token (Pod killed mid-install) only lowers throughput until it goes stale (`staleSeconds`), a doubled
// token (two waiters reclaiming one stale slot in the same instant) only lets one extra install run, and a waiter that
// cannot get a token within `waitSeconds` — or finds the directory unwritable — installs anyway (fail-open).
// `mkdir` is atomic on one filesystem, and every Pod on a node sees the same hostPath directory.

/** Default hostPath of the install tokens on each gate node. */
export const POD_INSTALL_SLOTS_HOST_PATH = '/var/lib/elanous/gate-install-slots';
/** Default concurrent installs per node (`release.loop.gatePodInstallSlots` · 0 = off). Alone ≈ 3–5 s ⇒ 24 shards ≈ 6 waves. */
export const POD_INSTALL_SLOTS_DEFAULT = 4;
export const POD_INSTALL_SLOTS_MOUNT = '/gate-install-slots';

/** hostPath volume ⊕ mount for the tokens. `DirectoryOrCreate` makes a root-owned 0755 directory, so the Pod also needs
 *  {@link podHostDirsInit} (the child runs as uid 1000). */
export function podInstallSlotsVolume(hostPath: string = POD_INSTALL_SLOTS_HOST_PATH) {
  return {
    volume: { name: 'install-slots', hostPath: { path: hostPath, type: 'DirectoryOrCreate' } },
    volumeMount: { name: 'install-slots', mountPath: POD_INSTALL_SLOTS_MOUNT, readOnly: false },
  };
}

/**
 * A root init container that hands the mounted hostPath directories to the child's uid. Without it a `DirectoryOrCreate`
 * hostPath stays root:root 0755 and the child's `[ -w … ]` guard silently skips it (the Bun cache option was a no-op).
 */
export function podHostDirsInit(image: string, imagePullPolicy: string, mounts: ReadonlyArray<{ name: string; mountPath: string; readOnly: boolean }>) {
  const paths = mounts.map((mount) => `'${mount.mountPath.replace(/'/g, `'\\''`)}'`).join(' ');
  return {
    name: 'host-dirs', image, imagePullPolicy,
    securityContext: { runAsUser: 0 },
    command: ['sh', '-c'],
    // Never fails the Pod: an unchanged directory only means the child falls back (no cache · no throttle).
    args: [`for d in ${paths}; do mkdir -p "$d" && chown 1000:1000 "$d" && chmod 0775 "$d" || echo "[host-dirs] could not prepare $d"; done; exit 0`],
    volumeMounts: mounts.map((mount) => ({ ...mount })),
  };
}

const int = (value: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${label}: ${value}`);
  return value;
};

/**
 * Bash that defines `install_slot_acquire` / `install_slot_release`. Acquire waits for one of `slots` tokens under `dir`
 * (polling every `pollSeconds`, default 2 s), reclaims a token older than `staleSeconds` (minute granularity), and gives up after `waitSeconds` (install runs anyway).
 * It prints `[gate] install-slot <n> waited <s>s` or `[gate] install-slot none …` for the shard log.
 */
export function installSlotScript(o: { dir?: string; slots: number; waitSeconds?: number; staleSeconds?: number; pollSeconds?: number }): string {
  const dir = `'${(o.dir ?? POD_INSTALL_SLOTS_MOUNT).replace(/'/g, `'\\''`)}'`;
  const slots = int(o.slots, 'install slots');
  const wait = int(o.waitSeconds ?? 600, 'install slot wait');
  const poll = o.pollSeconds ?? 2;
  if (!Number.isFinite(poll) || poll <= 0 || poll > 60) throw new Error(`invalid install slot poll: ${poll}`);
  const staleMinutes = Math.max(1, Math.ceil(int(o.staleSeconds ?? 900, 'install slot stale age') / 60));
  return [
    'install_slot=',
    'install_slot_acquire() {',
    `  local d=${dir} t0 now n`,
    '  t0=$(date +%s)',
    '  if [ ! -d "$d" ] || [ ! -w "$d" ]; then echo "[gate] install-slot none (directory not writable)"; return 0; fi',
    '  while :; do',
    `    for n in $(seq 0 ${slots - 1}); do`,
    '      if mkdir "$d/slot-$n" 2>/dev/null; then',
    '        install_slot="$d/slot-$n"',
    '        echo "[gate] install-slot $n waited $(( $(date +%s) - t0 ))s"; return 0',
    '      fi',
    // A token whose holder died (directory mtime older than the stale age · `find -mmin` is the same on GNU and BSD) is
    // renamed away first (rename is atomic: one reclaimer wins) and the slot is tried again on the next pass.
    `      if [ -n "$(find "$d/slot-$n" -maxdepth 0 -mmin +${staleMinutes} 2>/dev/null)" ]; then mv "$d/slot-$n" "$d/stale-$n-$$" 2>/dev/null && rm -rf "$d/stale-$n-$$"; fi`,
    '    done',
    '    now=$(date +%s)',
    `    if [ $(( now - t0 )) -ge ${wait} ]; then echo "[gate] install-slot none (waited $(( now - t0 ))s)"; return 0; fi`,
    `    sleep ${poll}`,
    '  done',
    '}',
    'install_slot_release() { if [ -n "$install_slot" ]; then rm -rf "$install_slot"; install_slot=; fi; }',
  ].join('\n');
}
