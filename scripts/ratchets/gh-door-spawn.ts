/**
 * GH-DOOR-SPAWN ratchet (GH-PROXY-LAYER · 0.3.40 P0 · CEO 11-28 21:0x «git 문제가 너무 많이 · proxy 등 기본 조치») — no NEW direct
 * `gh` child process in src/ outside the one gh door.
 *
 * S: 11-28 the GitHub secondary limit froze the land graph twice. #40718 put a governor (cooldown · per-seat budget · shared
 *    open-PR snapshot) in the gh gateway (src/git-fs/gh-cli.ts), but ~64 src files still spawn `gh` themselves — outside it.
 * C: nothing refused the 65th.
 * A: count, per file, the non-comment lines of non-test src/**\/*.ts(x) that start a `gh` child directly —
 *      spawn · spawnSync · execFile · execFileSync · Bun.spawn · Bun.spawnSync with a literal 'gh' (or ['gh', …]) first,
 *      exec · execSync with a command string starting `gh `.
 *    The door files (DOOR_FILES) are exempt. Today's counts are frozen per file in gh-door-spawn.baseline.json; a file may only
 *    go down (burn-down: move a call to runGhCliWithResult / runGhCliWithResultAsync, then `--update`).
 *
 *   bun run scripts/ratchets/gh-door-spawn.ts            # check (exit 1 on growth, with the door to use)
 *   bun run scripts/ratchets/gh-door-spawn.ts --update   # re-snapshot (only ever lowers counts)
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const ROOT = join(import.meta.dir, '..', '..');
export const BASELINE_PATH = join(import.meta.dir, 'gh-door-spawn.baseline.json');
/** The gh door: the governed gateway and the shim's transparent door. */
export const DOOR_FILES: ReadonlySet<string> = new Set(['src/git-fs/gh-cli.ts', 'src/kit/gh-proxy/door.ts']);
export const GUIDANCE = 'gh 직접 spawn 금지 — src/git-fs/gh-cli.ts 의 runGhCliWithResult / runGhCliWithResultAsync (governor: 쿨다운·자리 예산·기록) 로';

const SPAWN_GH = /\b(?:Bun\.spawnSync|Bun\.spawn|spawnSync|spawn|execFileSync|execFile)\(\s*\[?\s*(['"`])gh\1/;
const EXEC_GH = /\b(?:execSync|exec)\(\s*(['"`])gh\s/;

export interface Baseline { schema: 1; counts: Record<string, number> }

export function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** Pure: direct gh child starts in one source. */
export function countSource(source: string): number {
  let n = 0;
  for (const line of source.split('\n')) {
    if (isCommentLine(line)) continue;
    const code = line.replace(/\s\/\/\s.*$/u, '');
    if (SPAWN_GH.test(code) || EXEC_GH.test(code)) n++;
  }
  return n;
}

const SOURCE = /\.tsx?$/;
const NOT_SOURCE = /(?:\.test\.tsx?|\.d\.ts)$/;

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'fixtures' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && SOURCE.test(e.name) && !NOT_SOURCE.test(e.name)) out.push(p);
  }
}

export function scanRepo(root = ROOT): Record<string, number> {
  const files: string[] = [];
  walk(join(root, 'src'), files);
  const counts: Record<string, number> = {};
  for (const f of files.sort()) {
    const rel = relative(root, f).split('\\').join('/');
    if (DOOR_FILES.has(rel)) continue;
    const n = countSource(readFileSync(f, 'utf8'));
    if (n > 0) counts[rel] = n;
  }
  return counts;
}

export function readBaseline(path = BASELINE_PATH): Baseline {
  return JSON.parse(readFileSync(path, 'utf8')) as Baseline;
}

/** Pure: «file n > allowed» for every file over its baseline (a file absent from the baseline is allowed 0). */
export function growth(now: Record<string, number>, base: Record<string, number>): string[] {
  return Object.entries(now).filter(([f, n]) => n > (base[f] ?? 0)).map(([f, n]) => `${f} ${n} > ${base[f] ?? 0}`);
}

/** Pure: the shrunk baseline (min of current and baseline; files that reached 0 drop out). */
export function shrink(now: Record<string, number>, base: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [f, b] of Object.entries(base)) { const n = Math.min(b, now[f] ?? 0); if (n > 0) out[f] = n; }
  return out;
}

export const total = (c: Record<string, number>): number => Object.values(c).reduce((a, b) => a + b, 0);

if (import.meta.main) {
  const now = scanRepo();
  const base = readBaseline();
  if (process.argv.includes('--update')) {
    const next: Baseline = { schema: 1, counts: shrink(now, base.counts) };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`gh-door-spawn baseline: ${Object.keys(next.counts).length} files · ${total(next.counts)} calls (was ${total(base.counts)})`);
    process.exit(0);
  }
  const grown = growth(now, base.counts);
  console.log(`gh-door-spawn: ${Object.keys(now).length} files · ${total(now)} direct gh calls (baseline ${total(base.counts)})`);
  if (grown.length) {
    for (const g of grown) console.error(`RED ${g} — ${GUIDANCE}`);
    process.exit(1);
  }
}
