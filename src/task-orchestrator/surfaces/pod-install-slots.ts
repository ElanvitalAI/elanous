import { spawn } from 'node:child_process';

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

/** hostPath volume ⊕ mount for the tokens. `DirectoryOrCreate` makes a root-owned 0755 directory, so the node also needs
 *  {@link prepareHostDirsOnce} (the child runs as uid 1000). */
export function podInstallSlotsVolume(hostPath: string = POD_INSTALL_SLOTS_HOST_PATH) {
  return {
    volume: { name: 'install-slots', hostPath: { path: hostPath, type: 'DirectoryOrCreate' } },
    volumeMount: { name: 'install-slots', mountPath: POD_INSTALL_SLOTS_MOUNT, readOnly: false },
  };
}

// GATE-WARM-BOOT-NO-INIT (10-15) — the root hand-over of the hostPath directories left the Pod. It was an init container
// (`host-dirs`, then folded into `isolation-gate` by GATE-WARM-BOOT), and every init container cost a container
// transition on a loaded k3d node (#27805 on node-b: init 2 → 354 s · init 1 → 41 s · none → 1 s to the child start).
// The directories live on the node and outlive every Pod, so the hand-over is a node fact: done once per node from the
// pool host (`docker exec` into each k3d node container · idempotent `mkdir -p`/`chown`/`chmod`), and the child shell only
// reports a directory it still cannot write. Never fails the Pod: an unwritable directory means the child falls back
// (no cache · no throttle), exactly as before when the hand-over failed.

const SAFE_HOST_PATH = /^\/[A-Za-z0-9._/-]+$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const HOST_DIRS_PREP_LIMIT_MS = 30_000;
export const GATE_EXTERNAL_VOLUME_SNAPSHOT_LIMIT_MS = 900_000;
export const GATE_EXTERNAL_VOLUME_SNAPSHOT_ROOT = '/var/lib/elanous/gate-volume-snapshots';

export const gateExternalVolumeSnapshotDirectoryCheckScript = 'snapshot_uid() { stat -c %u "$1" 2>/dev/null || stat -f %u "$1" 2>/dev/null || true; }\nsnapshot_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null || true; }\nsecure_snapshot_dir() { [ ! -L "$1" ] || return 1; if [ -e "$1" ]; then [ -d "$1" ] || return 1; else mkdir "$1" || return 1; chown 0:0 "$1" || return 1; chmod 0755 "$1" || return 1; fi; mode=$(snapshot_mode "$1"); [ "$(snapshot_uid "$1")" = 0 ] && [ -n "$mode" ] && [ $((0$mode & 022)) -eq 0 ]; }';

/** Host-side verifier for a copied k3d-node tree before this preparation attempt is trusted.
 * The tree root travels in ELANOUS_GATE_VOLUME_HASH_ROOT, not argv: real Node puts post-`-e` arguments in
 * process.argv[1], but the harness image's `node` is bun's shim and keeps argv empty there (measured 11-13 ·
 * every pod shard's verify stage hashed nothing and falsely reported external-volume-snapshot-content-mismatch). */
const gateVolumeSnapshotHashScript = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const root=fs.realpathSync(process.env.ELANOUS_GATE_VOLUME_HASH_ROOT||''),names=[];const walk=d=>{for(const n of fs.readdirSync(d)){const f=path.join(d,n),r=path.relative(root,f).split(path.sep).join('/');if(r==='.elanous-volume-ref.json')continue;const s=fs.lstatSync(f);names.push(r);if(s.isDirectory())walk(f)}};walk(root);names.sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));const h=crypto.createHash('sha256'),add=v=>{const b=Buffer.from(String(v)),n=Buffer.alloc(8);n.writeBigUInt64BE(BigInt(b.length));h.update(n);h.update(b)};for(const r of names){const f=path.join(root,...r.split('/')),s=fs.lstatSync(f);add(r);add(String(s.mode&0o555));if(s.isDirectory())add('directory');else if(s.isFile()){add('file');add(String(s.size));const fd=fs.openSync(f,'r'),buf=Buffer.allocUnsafe(1048576);try{let n;while((n=fs.readSync(fd,buf,0,buf.length,null))>0)h.update(buf.subarray(0,n))}finally{fs.closeSync(fd)}}else if(s.isSymbolicLink()){const t=fs.readlinkSync(f);if(path.isAbsolute(t))throw Error('volume-symlink-escapes-root:'+r);const resolved=fs.realpathSync(f),rel=path.relative(root,resolved);if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('volume-symlink-escapes-root:'+r);add('symlink');add(t)}else throw Error('volume-special-file:'+r)}process.stdout.write(h.digest('hex'));`;

/** Quarantine only the exact stale generation; keep its inode immutable for Pods that already mounted it. */
export const gateExternalVolumeSnapshotInvalidateScript = 'if [ -n "$2" ] && { [ -e "$1" ] || [ -L "$1" ]; }; then q="$1.invalid.$$"; if mv -T "$1" "$q" 2>/dev/null; then g=$(stat -c %d:%i "$q" 2>/dev/null || true); marker=$(cat "$q/.complete" 2>/dev/null || true); if [ ! -L "$q" ] && { [ "$g" != "$2" ] || [ "$marker" != "$3" ]; }; then if [ ! -e "$1" ] && [ ! -L "$1" ]; then mv -T "$q" "$1" 2>/dev/null || true; fi; fi; fi; fi';

/** Child-shell line: report (never fail on) a mounted host directory the uid-1000 child cannot write. */
/** Root hand-over inside the Pod — only for runs whose hostPath dirs could not be prepared on the node (no pool member ·
 * prep failed · prep disabled). Same lines the old `isolation-gate` init ran; it never fails the Pod. */
export function podHostDirsScript(mounts: ReadonlyArray<{ mountPath: string }>): string {
  const paths = mounts.map((mount) => `'${mount.mountPath.replace(/'/g, `'\\''`)}'`).join(' ');
  return `for d in ${paths}; do mkdir -p "$d" && chown 1000:1000 "$d" && chmod 0775 "$d" || echo "[host-dirs] could not prepare $d"; done; exit 0`;
}

export function podHostDirsCheckScript(mounts: ReadonlyArray<{ mountPath: string }>): string {
  const paths = mounts.map((mount) => `'${mount.mountPath.replace(/'/g, `'\\''`)}'`).join(' ');
  return `for d in ${paths}; do [ -d "$d" ] && [ -w "$d" ] || echo "[host-dirs] could not prepare $d (not writable by uid $(id -u) · node not prepared)"; done`;
}

/** Host-side shell (on the pool host): hand the node directories to uid 1000 in every k3d node container of `cluster`. */
export function podHostDirsNodeScript(o: { cluster: string; hostPaths: readonly string[] }): string {
  if (!SAFE_NAME.test(o.cluster)) throw new Error(`invalid k3d cluster: ${o.cluster}`);
  for (const path of o.hostPaths) if (!SAFE_HOST_PATH.test(path) || path.split('/').includes('..')) throw new Error(`invalid host dir: ${path}`);
  const inner = `for d in ${o.hostPaths.join(' ')}; do mkdir -p "$d" && chown 1000:1000 "$d" && chmod 0775 "$d" || { echo "[host-dirs] could not prepare $d"; exit 1; }; done`;
  return [
    `nodes=$(docker ps --filter label=k3d.cluster=${o.cluster} --format '{{.Names}} {{.Label "k3d.role"}}' | awk '$2=="server"||$2=="agent"{print $1}')`,
    `[ -n "$nodes" ] || { echo "[host-dirs] no k3d node for ${o.cluster}"; exit 2; }`,
    'rc=0',
    `for n in $nodes; do docker exec "$n" sh -c '${inner}' || rc=1; done`,
    'exit $rc',
  ].join('\n');
}

/** The member's current k3d server/agent container IDs, sorted — the node «generation» the hand-over memo is keyed by. */
export function podHostDirsNodeIdsScript(cluster: string): string {
  if (!SAFE_NAME.test(cluster)) throw new Error(`invalid k3d cluster: ${cluster}`);
  return `docker ps --no-trunc --filter label=k3d.cluster=${cluster} --format '{{.ID}} {{.Label "k3d.role"}}' | awk '$2=="server"||$2=="agent"{print $1}' | sort | tr '\\n' ' '`;
}

export interface HostDirsPrepResult { host: string; ok: boolean; ms: number; detail?: string }

type HostShell = (host: string | undefined, script: string, limitMs: number) => Promise<{ rc: number; output: string }>;

/**
 * Bounded shell on the pool host (`ssh <host>`) or this machine (no host); never throws. At `limitMs` the whole process
 * group is killed and the call returns rc 124 at once — a stuck `docker exec` grandchild holding the pipe must not keep
 * the caller (and the Job launch behind it) waiting for `close`.
 */
export function hostShellWithin(host: string | undefined, script: string, limitMs: number): Promise<{ rc: number; output: string }> {
  const env = 'export PATH=/opt/homebrew/bin:/usr/local/bin:$HOME/.orbstack/bin:$PATH; ';
  const [cmd, args] = host
    ? ['ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, env + script]] as const
    : ['bash', ['-c', env + script]] as const;
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (rc: number, text: string) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ rc, output: text }); } };
    let child: ReturnType<typeof spawn>;
    try { child = spawn(cmd, [...args], { stdio: ['ignore', 'pipe', 'pipe'], detached: true }); }
    catch (error) { resolve({ rc: 2, output: String(error) }); return; }
    timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(124, `${output}\n[host-dirs] timed out after ${limitMs} ms`);
    }, limitMs);
    child.stdout?.on('data', (chunk) => { output += String(chunk); });
    child.stderr?.on('data', (chunk) => { output += String(chunk); });
    child.on('error', (error) => finish(2, `${output}\n${String(error)}`));
    child.on('close', (code) => finish(code ?? 2, output));
  });
}

const prepared = new Map<string, Promise<HostDirsPrepResult>>();
type ExternalVolumeSnapshotOutcome = { ok: true; host: string; ms: number } | { ok: false; host: string; ms: number; detail: string };
const externalVolumeSnapshots = new Map<string, Promise<ExternalVolumeSnapshotOutcome>>();

export function gateExternalVolumeSnapshotNodeScript(cluster: string,
  refs: ReadonlyArray<{ kind: string; hostPath: string; contentSha256: string; identitySha256: string }>,
  snapshotRoot = GATE_EXTERNAL_VOLUME_SNAPSHOT_ROOT): string {
  if (!SAFE_NAME.test(cluster)) throw new Error(`invalid k3d cluster: ${cluster}`);
  if (!SAFE_HOST_PATH.test(snapshotRoot) || snapshotRoot.split('/').includes('..')) throw new Error('invalid gate volume snapshot root');
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const inner: string[] = ['set -eu', `base=${quote(snapshotRoot)}`, gateExternalVolumeSnapshotDirectoryCheckScript];
  for (const ref of [...refs].sort((a, b) => a.identitySha256.localeCompare(b.identitySha256))) {
    if (!SAFE_HOST_PATH.test(ref.hostPath) || ref.hostPath.split('/').includes('..')
      || !/^[a-z][a-z0-9_-]{0,40}$/.test(ref.kind) || !/^[0-9a-f]{64}$/.test(ref.contentSha256)
      || !/^[0-9a-f]{64}$/.test(ref.identitySha256)) throw new Error(`invalid-volume-ref:${ref.kind}`);
    const source = quote(ref.hostPath), identityParentPath = `${snapshotRoot}/${ref.identitySha256}`;
    const snapshotDirs: string[] = [];
    let pathPrefix = '';
    for (const component of snapshotRoot.split('/').filter(Boolean)) { pathPrefix += `/${component}`; snapshotDirs.push(pathPrefix); }
    for (const dir of [...snapshotDirs, identityParentPath, `${identityParentPath}/${ref.kind}`]) {
      inner.push(`secure_snapshot_dir ${quote(dir)} || { echo "external-volume-snapshot-parent-untrusted:${ref.kind}:${dir}" >&2; exit 5; }`);
    }
    const parent = `"$base/${ref.identitySha256}/${ref.kind}"`;
    inner.push(`expected=${quote(`${ref.contentSha256} ${ref.identitySha256}`)}`);
    // Symlinks commonly report mode 0777 even when their root-owned targets are immutable.
    // Check write bits on non-links only; ownership still covers every entry including links.
    inner.push(`snapshot_valid() { [ ! -L ${parent}/snapshot ] && [ -d ${parent}/snapshot/tree ] && [ "$(cat ${parent}/snapshot/.complete 2>/dev/null || true)" = "$expected" ] && [ "$(stat -c %u ${parent}/snapshot 2>/dev/null || true)" = 0 ] && [ -z "$(find ${parent}/snapshot ! -type l -perm /222 -print -quit 2>/dev/null)" ] && [ -z "$(find ${parent}/snapshot -not -uid 0 -print -quit 2>/dev/null)" ]; }`);
    inner.push(`snapshot_path=${parent}/snapshot`, 'existing_generation=$(stat -c %d:%i "$snapshot_path" 2>/dev/null || true)');
    inner.push(`if { [ -e "$snapshot_path" ] || [ -L "$snapshot_path" ]; } && ! snapshot_valid; then sh -c ${quote(gateExternalVolumeSnapshotInvalidateScript)} sh "$snapshot_path" "$existing_generation" "$expected" || { echo "external-volume-snapshot-invalidate-failed:${ref.kind}" >&2; exit 5; }; fi`);
    inner.push(`if [ -e ${parent}/snapshot ] || [ -L ${parent}/snapshot ]; then snapshot_valid || { echo "external-volume-snapshot-conflict:${ref.kind}" >&2; exit 5; }; else`);
    inner.push(`  tmp=${parent}/.snapshot.$$.tmp; mkdir "$tmp"`);
    inner.push(`  [ -d ${source} ] || { echo "external-volume-source-missing:${ref.kind}" >&2; exit 5; }`);
    inner.push(`  mkdir "$tmp/tree"; cp -a ${source}/. "$tmp/tree/"`);
    inner.push('  printf "%s\\n" "$expected" > "$tmp/.complete"');
    inner.push('  chown -R 0:0 "$tmp"; chmod -R a-w "$tmp"',
      `  if mv -T "$tmp" ${parent}/snapshot 2>/dev/null; then :; else rm -rf "$tmp"; snapshot_valid || { echo "external-volume-snapshot-publish-conflict:${ref.kind}" >&2; exit 5; }; fi`,
      'fi');
  }
  inner.push('exit 0');
  const verify: string[] = ['verify_root=$(mktemp -d) || exit 2', 'verify_index=0', 'for n in $nodes; do'];
  for (const ref of [...refs].sort((a, b) => a.identitySha256.localeCompare(b.identitySha256))) {
    const snapshot = `${snapshotRoot}/${ref.identitySha256}/${ref.kind}/snapshot`;
    verify.push('  mkdir "$verify_root/$verify_index"');
    verify.push(`  snapshot_generation=$(docker exec "$n" sh -c 'stat -c %d:%i "$1"' sh ${quote(snapshot)} 2>/dev/null || true)`);
    verify.push(`  if ! docker cp "$n:${snapshot}/tree" "$verify_root/$verify_index/" >/dev/null 2>&1; then echo 'external-volume-snapshot-copyback-failed:${ref.kind}' >&2; rc=1; else`);
    verify.push(`    actual=$(ELANOUS_GATE_VOLUME_HASH_ROOT="$verify_root/$verify_index/tree" node -e ${quote(gateVolumeSnapshotHashScript)} 2>/dev/null || true)`);
    verify.push(`    if [ "$actual" != ${quote(ref.contentSha256)} ]; then docker exec -i "$n" sh -c ${quote(gateExternalVolumeSnapshotInvalidateScript)} sh ${quote(snapshot)} "$snapshot_generation" ${quote(`${ref.contentSha256} ${ref.identitySha256}`)} >/dev/null 2>&1 || true; echo 'external-volume-snapshot-content-mismatch:${ref.kind}' >&2; rc=1; fi`);
    verify.push('  fi', '  verify_index=$((verify_index + 1))');
  }
  verify.push('done', 'chmod -R u+w "$verify_root" 2>/dev/null || true', 'rm -rf "$verify_root"', 'exit $rc');
  const nodes = podHostDirsNodeIdsScript(cluster);
  return `nodes=$(${nodes})\n[ -n "$nodes" ] || { echo 'no k3d node'; exit 2; }\nrc=0\nfor n in $nodes; do\n  docker exec -i "$n" sh <<'ELANOUS_GATE_VOLUME_SNAPSHOT' || rc=1\n${inner.join('\n')}\nELANOUS_GATE_VOLUME_SNAPSHOT\ndone\n${verify.join('\n')}\n`;
}

/** Snapshot hostPath inputs once per k3d node generation into a root-owned, non-writable, content-addressed tree.
 * Pods mount that tree read-only, so later changes to the source hostPath cannot race preflight and use. */
export async function prepareGateExternalVolumeSnapshotsOnce<T extends { kind: string; hostPath: string; contentSha256: string; identitySha256: string }>(o: {
  member: { sshHost?: string; k3dCluster: string };
  refs: ReadonlyArray<T>;
  shell?: HostShell;
  limitMs?: number;
}): Promise<{ ok: true; refs: Array<T>; ms: number }
  | { ok: false; host: string; ms: number; detail: string }> {
  const start = Date.now();
  const host = o.member.sshHost;
  const shell = o.shell ?? hostShellWithin;
  const limitMs = o.limitMs ?? GATE_EXTERNAL_VOLUME_SNAPSHOT_LIMIT_MS;
  const ids = await shell(host, podHostDirsNodeIdsScript(o.member.k3dCluster), limitMs)
    .catch(() => ({ rc: 2, output: '' }));
  const generation = ids.rc === 0 && ids.output.trim() ? ids.output.trim() : null;
  if (!generation) return { ok: false, host: host ?? 'local', ms: Date.now() - start, detail: 'k3d-node-generation-unmeasured' };
  const refs = [...o.refs].sort((a, b) => a.identitySha256.localeCompare(b.identitySha256));
  const key = `${host ?? 'local'}\0${o.member.k3dCluster}\0${generation}\0${refs.map((r) => `${r.kind}:${r.identitySha256}`).join(',')}`;
  let pending = externalVolumeSnapshots.get(key);
  if (!pending) {
    const script = gateExternalVolumeSnapshotNodeScript(o.member.k3dCluster, refs);
    const run: Promise<ExternalVolumeSnapshotOutcome> = shell(host, script, limitMs)
      .then((result): ExternalVolumeSnapshotOutcome => result.rc === 0
        ? { host: host ?? 'local', ok: true, ms: Date.now() - start }
        : { host: host ?? 'local', ok: false, ms: Date.now() - start, detail: result.output.trim().slice(-300) || `rc=${result.rc}` })
      .catch((error: unknown): ExternalVolumeSnapshotOutcome => ({ host: host ?? 'local', ok: false, ms: Date.now() - start, detail: String(error).slice(0, 300) }))
      .then((result) => { if (!result.ok) externalVolumeSnapshots.delete(key); return result; });
    pending = run;
    externalVolumeSnapshots.set(key, pending);
  }
  const result = await pending;
  if (result.ok === false) return { ...result, ms: Date.now() - start };
  return { ok: true, ms: Date.now() - start, refs: refs.map((ref) => ({ ...ref,
    hostPath: `${GATE_EXTERNAL_VOLUME_SNAPSHOT_ROOT}/${ref.identitySha256}/${ref.kind}/snapshot/tree` })) };
}

/** A Pod preflight rejection proves a previously memoized node snapshot is no longer trustworthy. */
export function invalidateGateExternalVolumeSnapshotMemo(o: { member: { sshHost?: string; k3dCluster: string }; refs: ReadonlyArray<{ kind: string; identitySha256: string }> }): void {
  const prefix = `${o.member.sshHost ?? 'local'}\0${o.member.k3dCluster}\0`;
  const identities = new Set(o.refs.map((ref) => `${ref.kind}:${ref.identitySha256}`));
  for (const key of externalVolumeSnapshots.keys()) {
    if (!key.startsWith(prefix)) continue;
    const recorded = key.split('\0')[3]?.split(',') ?? [];
    if (recorded.some((entry) => identities.has(entry))) externalVolumeSnapshots.delete(key);
  }
}

/**
 * Hand `hostPaths` to uid 1000 on the member's k3d nodes once per (host, cluster, node generation, path) in this process — every shard Job
 * on the same member awaits the same run, and a path already handed over (or in flight) is not run again even when it
 * comes with a different companion path. A failure is not memoized (the next Job tries again) and never throws.
 */
export async function prepareHostDirsOnce(o: { member: { sshHost?: string; k3dCluster: string }; hostPaths: readonly string[]; shell?: HostShell; limitMs?: number }): Promise<HostDirsPrepResult> {
  const host = o.member.sshHost;
  const label = host ?? 'local';
  const start = Date.now();
  const shell = o.shell ?? hostShellWithin;
  // Node generation (review mf): a recreated cluster or a new agent has other container IDs, so a hand-over remembered for
  // the old node set is not reused. Unreadable IDs → no memo at all (every path runs, success is not remembered).
  const ids = await shell(host, podHostDirsNodeIdsScript(o.member.k3dCluster), o.limitMs ?? HOST_DIRS_PREP_LIMIT_MS)
    .catch(() => ({ rc: 2, output: '' }));
  const generation = ids.rc === 0 && ids.output.trim() ? ids.output.trim() : null;
  const gen = generation ?? `unknown-${start}-${Math.random()}`;
  const keyOf = (path: string) => `${label}\0${o.member.k3dCluster}\0${gen}\0${path}`;
  const paths = [...new Set(o.hostPaths)].sort();
  const fresh = paths.filter((path) => !prepared.has(keyOf(path)));
  if (fresh.length) {
    const run = (async (): Promise<HostDirsPrepResult> => {
      const script = podHostDirsNodeScript({ cluster: o.member.k3dCluster, hostPaths: fresh });
      const r = await shell(host, script, o.limitMs ?? HOST_DIRS_PREP_LIMIT_MS);
      const ms = Date.now() - start;
      return r.rc === 0 ? { host: label, ok: true, ms } : { host: label, ok: false, ms, detail: r.output.trim().slice(-300) || `rc=${r.rc}` };
    })().catch((error: unknown) => ({ host: label, ok: false, ms: Date.now() - start, detail: String(error).slice(0, 300) }))
      .then((result) => { if (!result.ok || generation === null) for (const path of fresh) prepared.delete(keyOf(path)); return result; });
    for (const path of fresh) prepared.set(keyOf(path), run);
  }
  const results = await Promise.all(paths.map((path) => prepared.get(keyOf(path))!));
  const failed = results.find((result) => !result.ok);
  return failed ?? { host: label, ok: true, ms: Date.now() - start };
}

/** Test seam — forget the per-process hand-over memo. */
export function resetHostDirsPrepMemo(): void { prepared.clear(); }

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
    // The token is taken by bash's own noclobber create (O_EXCL), not by `mkdir`: uutils coreutils `mkdir` (0.8 · wsl gate host)
    // let two racing callers both succeed on one path (10-16 · 3 holders on 2 slots). A directory token left by an older shell still counts as held.
    '      if (set -C; : > "$d/slot-$n") 2>/dev/null; then',
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
