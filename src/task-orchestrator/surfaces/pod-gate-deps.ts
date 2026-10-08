// GATE-IMAGE-DEPS (0.2.21 · GATE-SPEED) — the release-gate shards' dependencies come baked in the harness image.
//
// Measured on the 0.2.20 cut gate (~/.elanous/release/0.2.20/gate-logs/cut · 24 root shards · pod-<n>.log ⊕ .junit.xml):
//   install-slot wait median 156 s (max 509 s) ⊕ `bun install` root+pwa median 104 s (max 160 s) = median ≈ 260 s of a
//   ≈ 1200 s shard spent before the first test — and the shards that waited longest were the ones the 1200 s deadline cut
//   (pod-1 · 3 · 11 · 21 · 22 waited 327–509 s and ran only 215–436 s of tests). Alone the install takes seconds; 24 at
//   once thrash the node (GATE-INSTALL-CACHE). Not installing at all removes both the wait and the install.
//
// How: `docker/harness/build.sh` stages each install tree's lockfile ⊕ the install-relevant projection of its package.json
// ({@link GATE_DEPS_PROJECTION_JS}) into `gate-deps/`; the Dockerfile installs them once into {@link GATE_DEPS_DIR}
// (`--frozen-lockfile`). The layer's inputs change only when dependencies change, so the per-commit rebuild reuses it from
// the build cache. A shard links `node_modules` to the baked tree only when its own lockfile and projection are
// byte-identical to the baked ones; anything else — no baked tree (old image), a different lockfile, a different
// projection, an existing node_modules, a failed link — falls back to the old path (install slot ⊕ `bun install`).
// The link is a symlink: copying (or hard-linking across overlay layers) is the very I/O the install slots were throttling.
// Module resolution follows the real path, and the baked layout mirrors the repo (`<dir>/node_modules`,
// `<dir>/apps/pwa/node_modules`), so the parent lookup from a package inside the pwa tree is the same as before.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Baked dependency root inside the full harness image (mirrors the repo layout). */
export const GATE_DEPS_DIR = '/opt/elanous-gate-deps';
/** The install trees, relative to the repo root, in install order (same as the old `bun install && (cd apps/pwa && bun install)`). */
export const GATE_DEPS_TREES = ['.', 'apps/pwa'] as const;

/**
 * The part of a package.json that decides what `bun install` produces: dependency maps, overrides, trusted/patched
 * dependencies and the install lifecycle scripts. `version`, `description` and every other script are dropped, so a
 * release bump or a new script does not invalidate the baked layer. Run as `bun -e <this> <package.json>` (stdout).
 * ⛔ build.sh (bake) and the shard (check) run this same text — changing it simply makes the next shards fall back once.
 */
export const GATE_DEPS_PROJECTION_JS = [
  "const p=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const o={};",
  "for(const k of ['name','dependencies','devDependencies','optionalDependencies','peerDependencies','trustedDependencies','overrides','resolutions','patchedDependencies','workspaces'])if(p[k]!==undefined)o[k]=p[k];",
  "const s={};for(const k of ['preinstall','install','postinstall','prepare'])if(p.scripts&&p.scripts[k]!==undefined)s[k]=p.scripts[k];",
  "if(Object.keys(s).length)o.scripts=s;process.stdout.write(JSON.stringify(o,null,2)+'\\n');",
].join('');

/** Same projection in-process (tests · build staging). */
export function projectDepsManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['name', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'trustedDependencies', 'overrides', 'resolutions', 'patchedDependencies', 'workspaces']) {
    if (manifest[key] !== undefined) out[key] = manifest[key];
  }
  const scripts = manifest.scripts as Record<string, unknown> | undefined;
  const lifecycle: Record<string, unknown> = {};
  for (const key of ['preinstall', 'install', 'postinstall', 'prepare']) if (scripts && scripts[key] !== undefined) lifecycle[key] = scripts[key];
  if (Object.keys(lifecycle).length) out.scripts = lifecycle;
  return out;
}

/**
 * build.sh staging: `<dest>/<tree>/bun.lock` (verbatim) ⊕ `<dest>/<tree>/package.json` (the projection) for every install
 * tree. The digest (sha256 of the staged bytes, 12 hex) becomes the image label `elanous.gate-deps`.
 */
export function stageGateDeps(root: string, dest: string): { digest: string; trees: string[] } {
  const hash = createHash('sha256');
  const trees: string[] = [];
  mkdirSync(dest, { recursive: true });
  for (const tree of GATE_DEPS_TREES) {
    const lock = join(root, tree, 'bun.lock');
    const manifest = join(root, tree, 'package.json');
    if (!existsSync(lock) || !existsSync(manifest)) continue;
    const out = join(dest, tree);
    mkdirSync(out, { recursive: true });
    const lockBytes = readFileSync(lock);
    const projected = `${JSON.stringify(projectDepsManifest(JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>), null, 2)}\n`;
    writeFileSync(join(out, 'bun.lock'), lockBytes, { mode: 0o644 });
    writeFileSync(join(out, 'package.json'), projected, { mode: 0o644 });
    hash.update(`${tree}\0`).update(lockBytes).update('\0').update(projected).update('\0');
    trees.push(tree);
  }
  return { digest: hash.digest('hex').slice(0, 12), trees };
}

const sq = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Bash that installs the shard's dependencies (cwd = the repo clone) and sets `irc` (0 = ready). Each tree is linked to
 * the baked tree when it matches, else installed — only the installs take an install slot (`install_slot_acquire` /
 * `install_slot_release` from `installSlotScript` must already be defined when `installSlots > 0`). Every decision is a
 * `[gate] deps <tree> baked|miss (<why>)` line in `log` (the shard's install.log).
 */
export function gateDepsInstallScript(o: { log: string; installSlots: number; depsDir?: string }): string {
  const deps = sq(o.depsDir ?? GATE_DEPS_DIR);
  const log = o.log;
  return [
    'gate_deps_link() {',
    `  local t="$1" d=${deps} want`,
    '  [ "$t" = . ] || d="$d/$t"',
    '  if [ ! -d "$d/node_modules" ]; then echo "[gate] deps $t miss (no baked deps)"; return 1; fi',
    '  if [ -e "$t/node_modules" ] || [ -L "$t/node_modules" ]; then echo "[gate] deps $t miss (node_modules exists)"; return 1; fi',
    '  if ! cmp -s "$t/bun.lock" "$d/bun.lock"; then echo "[gate] deps $t miss (bun.lock differs)"; return 1; fi',
    `  want=$(bun -e ${sq(GATE_DEPS_PROJECTION_JS)} "$t/package.json" 2>/dev/null) || { echo "[gate] deps $t miss (package.json unreadable)"; return 1; }`,
    '  if [ "$want" != "$(cat "$d/package.json" 2>/dev/null)" ]; then echo "[gate] deps $t miss (package.json differs)"; return 1; fi',
    '  if ! ln -s "$d/node_modules" "$t/node_modules"; then echo "[gate] deps $t miss (link failed)"; return 1; fi',
    '  echo "[gate] deps $t baked"',
    '}',
    'irc=0; gate_deps_need=',
    `for t in ${GATE_DEPS_TREES.join(' ')}; do gate_deps_link "$t" >> ${log} 2>&1 || gate_deps_need="$gate_deps_need $t"; done`,
    'if [ -n "$gate_deps_need" ]; then',
    ...(o.installSlots > 0 ? [`  install_slot_acquire >> ${log} 2>&1`] : []),
    `  for t in $gate_deps_need; do (cd "$t" && bun install) >> ${log} 2>&1; irc=$?; [ "$irc" -eq 0 ] || break; done`,
    ...(o.installSlots > 0 ? ['  install_slot_release'] : []),
    'fi',
  ].join('\n');
}

/** Per-tree decisions from a shard's install log (`baked` · `miss:<why>`), for the gate's `pod-shard` observation. */
export function parseGateDeps(log: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of log.matchAll(/^\[gate\] deps (\S+) (baked|miss \(([^)]*)\))$/gm)) out[match[1]!] = match[2] === 'baked' ? 'baked' : `miss:${match[3]}`;
  return out;
}

if (import.meta.main) {
  const [cmd, dest] = process.argv.slice(2);
  if (cmd !== 'stage' || !dest) { console.error('usage: pod-gate-deps.ts stage <dir>'); process.exit(2); }
  const staged = stageGateDeps(process.cwd(), dest);
  console.log(`digest=${staged.digest} trees=${staged.trees.join(',') || '-'}`);
}
