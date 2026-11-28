/**
 * YAML-FIRST-RATCHET (0.3.39 P0 · 대표 11-27 22:4x «다들 yaml·plugin 으로 만들고 있나») — no NEW policy-shaped constant in src/.
 *
 * S: THROTTLE-AUDIT counted ≈50 policy values (caps · windows · cooldowns · thresholds) hardcoded as TS constants
 *    (내부 문서 `YAML-SYSTEM` §3 row 6). New work kept adding more while the policy packs were being built.
 * C: nothing refused a new one — the YAML-first rule lived only in prose.
 * A: count, per file, the non-comment lines of non-test src/*.ts that declare
 *      threshold — an UPPER_SNAKE const whose name reads as a policy knob (…_MIN · _MS · _SEC · _PCT · _CAP · _LIMIT ·
 *                  _THRESHOLD · _TIMEOUT · _MAX · _HOURS · _WINDOW · _COOLDOWN · _BUDGET · _TTL · MAX_… · MIN_… ) and whose
 *                  value is a number expression (or an env read with a numeric fallback) · or a one-line knob table
 *                  (…_DEFAULTS · _POLICY · _LIMITS · _CAPS … = { key: <number>, … })
 *      place     — an UPPER_SNAKE const named …_HOST(S) · _DIR · _PATH · _ROOT · _FILE · _HOME holding an absolute / home
 *                  path literal or a host name
 *    Today's counts are frozen per file in `policy-constants.baseline.json`; a file may only go down.
 *    Not policy: unit conversions (MINUTE_MS · HOUR_MS · MS_PER_DAY …), protocol prefixes (HTTP_ · EXIT_ · ANSI_ · SIG…),
 *    and any line carrying `// not-policy: <reason>` (a real format / protocol number — the reviewer reads the reason).
 *    Hosts and HQ paths in any other shape stay with their own ratchets (resource-facts-literals · no-hardcoded-hq-paths).
 *
 *   bun run scripts/ratchets/policy-constants.ts            # check (exit 1 on growth, with where to move the value)
 *   bun run scripts/ratchets/policy-constants.ts --update   # re-snapshot (only ever lowers counts unless --grow)
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

export const ROOT = join(import.meta.dir, '..', '..');
export const BASELINE_PATH = join(import.meta.dir, 'policy-constants.baseline.json');

export const KINDS = ['threshold', 'place'] as const;
export type Kind = typeof KINDS[number];
export type Counts = Record<Kind, Record<string, number>>;

const DECL = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)\s*(?::[^=]+)?=\s*(.+?)\s*;?\s*$/u;
const POLICY_TOKENS = new Set([
  'MIN', 'MINS', 'MINUTES', 'MS', 'SEC', 'SECS', 'SECONDS', 'H', 'HOUR', 'HOURS', 'DAY', 'DAYS', 'PCT', 'PERCENT', 'RATIO',
  'CAP', 'CAPS', 'LIMIT', 'LIMITS', 'THRESHOLD', 'TIMEOUT', 'MAX', 'FLOOR', 'CEILING', 'WINDOW', 'COOLDOWN', 'BUDGET',
  'TTL', 'INTERVAL', 'RETRIES', 'ATTEMPTS', 'QUOTA', 'DEADLINE', 'STALE', 'GRACE', 'BACKOFF', 'PERIOD',
]);
/** A one-line table of knobs: `const BACKPRESSURE_DEFAULTS = { maxPendingPassive: 30, … }`. */
const TABLE_TOKENS = new Set(['DEFAULTS', 'POLICY', 'LIMITS', 'CAPS', 'THRESHOLDS', 'BUDGETS', 'TIMEOUTS', 'WINDOWS']);
const PLACE_TOKENS = new Set(['HOST', 'HOSTS', 'DIR', 'PATH', 'ROOT', 'FILE', 'HOME']);
/** Unit conversions: a fixed fact about time, not a knob (MINUTE_MS · ONE_HOUR_MS · MS_PER_DAY · SEC_IN_MS). */
const UNIT_NAME = /^(?:ONE_)?(?:MS|SEC|SECOND|MIN|MINUTE|HOUR|DAY|WEEK)S?(?:_(?:MS|SEC|IN_MS|PER_(?:SEC|SECOND|MIN|MINUTE|HOUR|DAY|WEEK)))?$/u;
const PROTOCOL_NAME = /^(?:HTTP|EXIT|ANSI|SIG[A-Z]*|ERRNO|UTF\d*|ASCII|KEYCODE|ESC)_/u;
const NOT_POLICY = /\/\/\s*not-policy:\s*\S/u;
const HOST_LIT = /(['"`])(?:node-b|minim5|node-c|mbp|mshq|gcp\d|aws\d)\1/u;
const ABS_PATH_LIT = /(['"`])(?:\/(?:Users|home|var|opt|tmp|private)\/|~\/)/u;
const FN_WORDS = new Set(['Math', 'max', 'min', 'round', 'floor', 'ceil', 'Number', 'as', 'const']);

export function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** Pure: is this RHS a number expression (literals · arithmetic · other UPPER constants · Math.max/min) or an env read with a numeric fallback? */
export function isNumericValue(rhs: string): boolean {
  if (!/\d/u.test(rhs)) return false;
  if (/process\.env/u.test(rhs)) return /(?:\?\?|\|\|)\s*\d/u.test(rhs);
  if (!/^[\w\s*+\-/().,]+$/u.test(rhs)) return false;
  const words = rhs.match(/\b[A-Za-z_]\w*/gu) ?? [];
  return words.every((w) => FN_WORDS.has(w) || /^[A-Z][A-Z0-9_]*$/u.test(w));
}

/** Pure: which policy kind (if any) a source line declares. */
export function kindOfLine(line: string): Kind | null {
  if (isCommentLine(line) || NOT_POLICY.test(line)) return null;
  const code = line.replace(/\s\/\/\s.*$/u, '');
  const m = DECL.exec(code);
  if (!m) return null;
  const [, name, rhs] = m as unknown as [string, string, string];
  if (UNIT_NAME.test(name) || PROTOCOL_NAME.test(name)) return null;
  const tokens = name.split('_');
  if (tokens.some((t) => POLICY_TOKENS.has(t)) && isNumericValue(rhs)) return 'threshold';
  if (tokens.some((t) => TABLE_TOKENS.has(t)) && /^\{.*\b\w+\s*:\s*\d/u.test(rhs)) return 'threshold';
  if (tokens.some((t) => PLACE_TOKENS.has(t)) && (HOST_LIT.test(rhs) || ABS_PATH_LIT.test(rhs))) return 'place';
  return null;
}

export function emptyCounts(): Counts { return { threshold: {}, place: {} }; }

/** Pure: per-kind counts for one file's source. */
export function countSource(rel: string, source: string, into: Counts = emptyCounts()): Counts {
  for (const line of source.split('\n')) {
    const k = kindOfLine(line);
    if (k) into[k][rel] = (into[k][rel] ?? 0) + 1;
  }
  return into;
}

/** Pure: the matching lines of one source (for the failure message). */
export function policyLines(source: string): string[] {
  return source.split('\n').flatMap((l, i) => (kindOfLine(l) ? [`${i + 1}: ${l.trim().slice(0, 120)}`] : []));
}

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'fixtures', '__fixtures__'].includes(e.name)) walk(p, out); }
    else if (/\.tsx?$/u.test(e.name) && !/\.test\.tsx?$/u.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
}

export function scanRepo(root = ROOT): Counts {
  const files: string[] = [];
  walk(join(root, 'src'), files);
  const c = emptyCounts();
  for (const f of files) countSource(relative(root, f), readFileSync(f, 'utf8'), c);
  return c;
}

export function readBaseline(path = BASELINE_PATH): Counts {
  if (!existsSync(path)) return emptyCounts();
  const j = JSON.parse(readFileSync(path, 'utf8')) as Partial<Counts>;
  return { ...emptyCounts(), ...j };
}

/** Pure: lines «file kind n > allowed» for every growth over the baseline. */
export function growth(now: Counts, base: Counts): string[] {
  const over: string[] = [];
  for (const k of KINDS) for (const [file, n] of Object.entries(now[k])) {
    const allowed = base[k][file] ?? 0;
    if (n > allowed) over.push(`${file}: ${k} ${n} > ${allowed}`);
  }
  return over.sort();
}

/** Where the value goes instead — printed on every RED (the ratchet's whole point is this text). */
export const MOVE_IT = [
  'Move the value out of TS — new work is YAML / plugin defined (👑 11-27 · docs/conductor/YAML-SYSTEM.md):',
  '  1. policy pack   graphs/policies/<area>.yaml — `version: 1`, one key per value, a comment saying why; read it by name',
  '                   (pattern: src/seat/seat-assign-wip1.ts seatAssignPolicyPath + parse · a malformed pack throws, no silent default)',
  "  2. loop agent    graphs/loop-agents/<id>/agent.yaml `policies:` block — the body reads it (pv('<key>')), not a TS const",
  '  3. plugin        plugins/<id>/plugin.json — the plugin\'s own knob next to its contributes',
  '  hosts / paths:   ask src/kit/resource-facts (world registry) or config — never a literal',
  '  a real format / protocol number (unit conversion · status code · wire size): end the line with `// not-policy: <reason>`',
  'Then re-run: bun run scripts/ratchets/policy-constants.ts',
].join('\n');

/** Pure: the full RED message for a growth list (offending files' matching lines included). */
export function failureMessage(over: readonly string[], linesOf: (file: string) => string[] = () => []): string {
  const detail = over.flatMap((o) => {
    const file = o.split(':')[0]!;
    return [o, ...linesOf(file).slice(0, 6).map((l) => `    ${file}:${l}`)];
  });
  return `policy-constants ratchet: ${over.length} file(s) gained a policy-shaped constant in src/\n${detail.join('\n')}\n${MOVE_IT}`;
}

/** Pure: the shrunk baseline (min of current and baseline; files that reached 0 drop out). */
export function shrink(now: Counts, base: Counts, grow = false): Counts {
  const out = emptyCounts();
  for (const k of KINDS) {
    const files = new Set([...Object.keys(now[k]), ...(grow ? [] : Object.keys(base[k]))]);
    for (const f of [...files].sort()) {
      const n = now[k][f] ?? 0;
      // Without --grow nothing new is admitted: a file absent from the baseline has allowance 0.
      const v = grow ? n : Math.min(n, base[k][f] ?? 0);
      if (v > 0) out[k][f] = v;
    }
  }
  return out;
}

/**
 * The pregate hook (`eln self gate` policy gates · src/self-implement/gate-cli.ts): scan the gate checkout `cwd` against
 * ITS baseline; with `--changed-files` only growth in those files is reported (a drifted main never blocks an unrelated PR).
 * A tree without the baseline file (a branch older than this ratchet · a fixture repo) is not measured here — silent 0.
 */
export function runPolicyConstantsGate(out: { args?: readonly string[]; baseRef?: string; cwd: string; log: (m: string) => void; error: (m: string) => void }): number {
  const baselinePath = join(out.cwd, relative(ROOT, BASELINE_PATH));
  if (!existsSync(baselinePath) || !existsSync(join(out.cwd, 'src'))) return 0;
  const args = out.args ?? [];
  const at = args.indexOf('--changed-files');
  const changed = at < 0 ? null : new Set(args.slice(at + 1).filter((a) => !a.startsWith('--')));
  // The caller's selected comparison base, not a frozen historical pin, is the authority for PR growth.
  if (out.baseRef && changed) {
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: out.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const base = out.baseRef === 'HEAD' ? git('rev-parse', '--verify', 'HEAD').trim() : git('merge-base', out.baseRef, 'HEAD').trim();
      const violations: string[] = [];
      for (const file of changed) {
        if (!/^src\/.*\.tsx?$/.test(file) || /(?:^|\/)(?:fixtures|__fixtures__|node_modules)\//.test(file) || /\.test\.tsx?$|\.d\.ts$/.test(file)) continue;
        const path = join(out.cwd, file);
        if (!existsSync(path)) continue;
        const tracked = git('ls-tree', '-z', '--name-only', base, '--', file);
        const previous = tracked ? git('show', `${base}:${file}`) : '';
        const allowances = new Map<string, number>();
        for (const line of previous.split('\n')) if (kindOfLine(line)) {
          const key = line.trim(); allowances.set(key, (allowances.get(key) ?? 0) + 1);
        }
        for (const [i, line] of readFileSync(path, 'utf8').split('\n').entries()) if (kindOfLine(line)) {
          const key = line.trim(), available = allowances.get(key) ?? 0;
          if (available) allowances.set(key, available - 1);
          else violations.push(`${file}:${i + 1}: ${key}`);
        }
      }
      if (violations.length) { out.error(`policy-constants: new declarations since ${base}\n${violations.join('\n')}\n${MOVE_IT}`); return 1; }
      out.log('[policy-constants-gate] PASS no new policy-shaped constant in src/');
      return 0;
    } catch (error) { out.error(`policy-constants: cannot measure merge-base: ${String(error)}`); return 1; }
  }
  const over = growth(scanRepo(out.cwd), readBaseline(baselinePath)).filter((o) => !changed || changed.has(o.split(':')[0]!));
  if (over.length) {
    out.error(failureMessage(over, (f) => policyLines(readFileSync(join(out.cwd, f), 'utf8'))));
    return 1;
  }
  out.log('[policy-constants-gate] PASS no new policy-shaped constant in src/');
  return 0;
}

if (import.meta.main) {
  const now = scanRepo();
  const base = readBaseline();
  if (process.argv.includes('--update')) {
    const next = shrink(now, base, process.argv.includes('--grow'));
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`policy-constants baseline: ${KINDS.map(k => `${k} ${Object.values(next[k]).reduce((a, b) => a + b, 0)} in ${Object.keys(next[k]).length} files`).join(' · ')}`);
  } else {
    const over = growth(now, base);
    if (over.length) { console.error(failureMessage(over, (f) => policyLines(readFileSync(join(ROOT, f), 'utf8')))); process.exit(1); }
    console.log('policy-constants ratchet: no new policy-shaped constants');
  }
}
