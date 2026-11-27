// 판정 집사 — done-when per cell (pure · LLM 0). GREEN-DEFINITION-ONE (대표 rule · OPS-RULES §판정·증거 11-22→11-25 · memory
// judging-evidence-not-overstrict «같은 head 영수 + focused exit 0 이면 충분 · 미재현 추론 = FU»): a 🟡 cell is green when EVERY
// merged PR it cites has ① a same-head receipt (receipt head == the PR's landed head) and ② focused exit 0 (pass > 0 ∧ fail = 0,
// or the receipt's focused step exit 0; a doc-only PR has no focused set) — and no PR touches a security-4 path / carries a
// Terra security finding (those go to JUD/Terra). The E4 sim/test-universe line is NOT required: the body runs the title's
// evidence command opportunistically, and a missing/failed E4 becomes one FU cell «<cell>-E4».
// BUTLER-SIGN-MERGED-PATCHID (11-27 · 26 «merged + receipt» cells, 0 signed): «same head» and «focused exit 0» are the land
// graph's own receipt rules (src/land-graph/receipt-rules.ts — L0 doc-only · preexisting-on-main) ⊕ the #40358 patch-id reuse,
// selected by graphs/loop-agents/judge-butler/goal.yaml `green_rules`; every refusal carries a one-line reason.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { evidencePrRefs } from '../release-loop/green-triage.js';
import { isDocOnly, noFocusedStage, preexistingOnly } from '../land-graph/receipt-rules.js';
import { loadGreenRules, type FocusedOkRule, type GreenRules } from './cards.js';

export type Security4Class = 'auth' | 'secret' | 'remote-exec' | 'destroy';
export type Security4Table = ReadonlyArray<{ cls: Security4Class; re: RegExp }>;
const SEC4_CLASSES: readonly Security4Class[] = ['auth', 'secret', 'remote-exec', 'destroy'];

/** Built-in fallback — used only when graphs/policies/security4-paths.yaml is missing or malformed. Keep in step with the YAML.
 *  SEC4-PATHS-RELAX (대표 11-27 12:5x «보안을 너무 빡빡하게 보면 안 된다»): src/cli/land-graph-cli.ts is no longer security-4 —
 *  the credentialed merge call lives in the land/waiver scripts (seat-state/OP/tools pattern), who may land in org land-authority/org-map. */
export const SECURITY4_FALLBACK: Security4Table = [
  { cls: 'auth', re: /^src\/(auth|oauth|members)\/|^src\/els\/(server-auth|holder)|(^|\/)(auth|oauth|login)[^/]*(\/|$)/i },
  { cls: 'auth', re: /^src\/org\/(land-authority|org-map)\.ts$|^seat-state\/OP\/tools\/[^/]*(land|waiver)[^/]*\.(sh|ts|py|mjs)$/i },
  { cls: 'secret', re: /^src\/secret\/|(^|\/)[^/]*(secrets?|credentials?|creds?|keychain|api-?keys?)([-_./]|$)/i },
  { cls: 'remote-exec', re: /^src\/(pty|pty-shell|shell-primitive|shell-runner|ssh|exec-requests|skills\/tools\/shell)([-_./]|$)|^scripts\/[^/]*deploy|(^|\/)[^/]*(pty|spawn|remote-exec)[^/]*\.(ts|tsx|sh|py)$/i },
  { cls: 'destroy', re: /^src\/disk-steward\/|(^|\/)[^/]*(purge|wipe|destroy|rm-?rf)[^/]*$/i },
];

export const security4PolicyPath = (root = resolve(import.meta.dir, '../..')): string => join(root, 'graphs', 'policies', 'security4-paths.yaml');

/** Parse + validate the policy YAML (pure). Throws on a malformed table (caller falls back). */
export function parseSecurity4Policy(text: string): Security4Table {
  const y = (parseYaml(text) ?? {}) as { paths?: unknown };
  if (!Array.isArray(y.paths) || !y.paths.length) throw new Error('security4 policy: paths must be a non-empty list');
  return y.paths.map((e, i) => {
    const { cls, re } = (e ?? {}) as { cls?: unknown; re?: unknown };
    if (typeof cls !== 'string' || !SEC4_CLASSES.includes(cls as Security4Class)) throw new Error(`security4 policy: paths[${i}].cls must be one of ${SEC4_CLASSES.join('|')}`);
    if (typeof re !== 'string' || !re.trim()) throw new Error(`security4 policy: paths[${i}].re must be a regex string`);
    return { cls: cls as Security4Class, re: new RegExp(re, 'i') };
  });
}

/** Load the ONE table (graphs/policies/security4-paths.yaml); unreadable/malformed → the built-in fallback. */
export function loadSecurity4Paths(path = security4PolicyPath()): Security4Table {
  try { return parseSecurity4Policy(readFileSync(path, 'utf8')); } catch { return SECURITY4_FALLBACK; }
}

/** Security-4 paths (CEO 11-26) — the ONE table, from the policy YAML: the land graph (src/land-graph/land-graph.ts · JUD-RELAX land rule) re-exports it. */
export const SECURITY4_PATHS: Security4Table = loadSecurity4Paths();
/** BUTLER-SEC4-SCOPE (rail 76 · 02:01Z: 11 escalations, most of them `*-pty.test.ts`): only executable code counts —
 *  tests (`*.test.ts(x)` incl. `-pty` / `.sim`), fixtures and docs never make a PR security-4. */
export const isNonExecutablePath = (f: string): boolean =>
  /\.test\.[cm]?[jt]sx?$/iu.test(f) || /\.(patch|diff)$/iu.test(f) || /(^|\/)(fixtures?|__fixtures__|__snapshots__)\//iu.test(f) || /(^|\/)docs\//iu.test(f) || /\.md$/iu.test(f);
export function security4Hits(files: readonly string[], table: Security4Table = SECURITY4_PATHS): string[] {
  const out: string[] = [];
  for (const f of files) { if (isNonExecutablePath(f)) continue; const hit = table.find(p => p.re.test(f)); if (hit) out.push(`${hit.cls}:${f}`); }
  return out;
}

export interface CellIn { readonly id: string; readonly title?: string; readonly status: string; readonly owner?: string; readonly evidence?: string; readonly updatedAt?: string; readonly updatedBy?: string }
export type FocusedIn = { readonly pass: number; readonly fail: number } | { readonly exit: number } | null;
export interface PrFacts {
  readonly pr: number;
  readonly merged: boolean;
  /** The head that landed (land-graph ledger «landed» row, else the PR's final head); null = unknown. */
  readonly landedHead: string | null;
  readonly receipt: ReceiptFacts | null;
  /** A GREEN receipt exists only on an older head (none counts for the landed head) — named in the refusal reason. */
  readonly olderReceiptHead?: string | null;
  /** Files of the PR; null = unknown (treated as not provably safe). */
  readonly files: readonly string[] | null;
  /** Open Terra security-4 findings on that head. */
  readonly securityFindings: readonly string[];
}

/** The receipt as judged (from the land graph's Receipt · src/cli/land-graph-cli.ts defaultLandDeps().receipt). */
export interface ReceiptFacts {
  readonly head: string; readonly dir: string; readonly focusedFiles: number; readonly focused: FocusedIn;
  /** pregate grade (L0 = comment/doc-only, no focused stage) · the focused step exit (null = no focused step). */
  readonly grade?: string; readonly focusedExit?: number | null;
  /** pregate same-host focused-vs-main: head failures that also fail on main (newFailures = head-only names). */
  readonly focusedBaseline?: { readonly mine: number; readonly onMain: number; readonly newFailures: readonly string[] };
  /** Taken on this older head and reused by patch-id (#40358 reuseByPatchId · PR-own delta equal). */
  readonly reusedFrom?: string;
}

export type Verdict =
  | { readonly kind: 'sign'; readonly why: string; readonly evidence: readonly string[]; readonly e4: string | null }
  | { readonly kind: 'security'; readonly why: string; readonly hits: readonly string[] }
  | { readonly kind: 'missing'; readonly why: string; readonly missing: readonly string[] };

/** The receipt rules (goal.yaml `green_rules`) — read once per process. */
export const GREEN_RULES: GreenRules = loadGreenRules();

/** ③ — the structured evidence-run line for THIS cell with rc 0 (never body words). */
export function simEvidenceLine(cell: CellIn): string | null {
  const id = cell.id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const re = new RegExp(`^E4 (?:test|sim) 층 — .*·\\s*칸 ${id}(?:\\s|·|$).*·\\s*rc 0(?:\\s|·|$)`, 'u');
  return (cell.evidence ?? '').split(/\r?\n|⏎/u).map(l => l.trim()).find(l => re.test(l)) ?? null;
}

/** JUDGE-BUTLER-E4-RESIGN-SCOPE (JUD #195765 · MK #195749): an «<cell>-E4» cell is independent — its done line IS its own E4
 *  evidence run. The parent PR's same-head receipt + focused exit 0 (cited in its evidence) is never E4 evidence for it. */
export const isE4Cell = (id: string): boolean => /-E4$/iu.test(id.trim());
const e4RunId = (line: string): string => /runId (\S+)/u.exec(line)?.[1] ?? 'evidence-run';

export function judgeCell(cell: CellIn, facts: ReadonlyMap<number, PrFacts>, rules: GreenRules = GREEN_RULES): Verdict {
  const refs = evidencePrRefs(cell.evidence ?? '');
  const sim = simEvidenceLine(cell);
  const e4Cell = isE4Cell(cell.id);
  if (e4Cell && !sim) return { kind: 'missing', why: `E4 cell: its own E4 evidence run («E4 test|sim 층 — … · 칸 ${cell.id} · … · rc 0») — a parent PR's focused receipt is not E4 evidence`, missing: ['own E4 evidence run'] };
  const merged = refs.map(pr => facts.get(pr)).filter((f): f is PrFacts => !!f && f.merged);
  // an E4 cell that cites no PR closes on its own evidence run (an existing scene re-run · no code change)
  if (e4Cell && sim && !refs.length) { const runId = e4RunId(sim); return { kind: 'sign', why: `E4 ${runId} rc 0 (own evidence run · no PR)`, evidence: [`E4:${runId}`], e4: runId }; }
  if (!merged.length) return { kind: 'missing', why: refs.length ? `no merged PR among ${refs.map(p => `#${p}`).join(' ')}` : 'no PR in evidence', missing: ['merged PR'] };
  const missing: string[] = []; const evidence: string[] = []; const whys: string[] = []; const hits: string[] = [];
  for (const f of merged) {
    if (f.files === null) missing.push(`#${f.pr} files unknown (security-4 check needs them)`);
    else hits.push(...security4Hits(f.files));
    hits.push(...f.securityFindings.map(s => `terra:${s}`));
    if (!f.landedHead) { missing.push(`#${f.pr} landed head unknown`); continue; }
    const landed12 = f.landedHead.slice(0, 12);
    if (!f.receipt) {
      // BUTLER-SIGN-MERGED-PATCHID: an older-head receipt that did not reuse by patch-id = the PR-own delta changed since
      missing.push(f.olderReceiptHead
        ? `#${f.pr} receipt ${f.olderReceiptHead.slice(0, 12)} ≠ landed ${landed12}: PR-own delta differs (patch-id) — re-run pregate --light on ${landed12}`
        : `#${f.pr} same-head receipt (pregate --light on ${landed12})`);
      continue;
    }
    if (f.receipt.head !== f.landedHead) { missing.push(`#${f.pr} receipt head ${f.receipt.head.slice(0, 12)} ≠ landed ${landed12} (re-run pregate on the landed head)`); continue; }
    if (f.receipt.reusedFrom && !rules.sameHead.includes('patch-id')) { missing.push(`#${f.pr} receipt reused by patch-id from ${f.receipt.reusedFrom.slice(0, 12)} — green_rules.same_head has no patch-id (re-run pregate on ${landed12})`); continue; }
    if (!f.receipt.reusedFrom && !rules.sameHead.includes('exact')) { missing.push(`#${f.pr} exact-head receipt not accepted by green_rules.same_head`); continue; }
    const fx = f.receipt.focused;
    const ok = (r: FocusedOkRule) => rules.focusedOk.includes(r);
    const fb = f.receipt.focusedBaseline;
    const noStage = f.receipt.focusedFiles === 0 || noFocusedStage({ focusedCount: f.receipt.focusedFiles, grade: f.receipt.grade, focusedExit: f.receipt.focusedExit });
    const docOnly = noStage && f.files !== null && isDocOnly(f.files);
    let focusedTxt: string | null = null;
    if (noStage) {
      if (!docOnly) { missing.push(`#${f.pr} focused stage (empty focused set on a code PR)`); continue; }
      if (ok('doc-only-L0')) focusedTxt = 'doc-only';
    } else if (fx !== null && 'exit' in fx) {
      if (fx.exit === 0 && ok('step-exit-0')) focusedTxt = 'focused exit 0';
      else if (fx.exit !== 0 && preexistingOnly(fb) && ok('preexisting-on-main')) focusedTxt = `focused preexisting-only (${fb!.mine} also red on main)`;
    } else if (fx !== null) {
      if (fx.fail === 0 && fx.pass > 0 && ok('pass')) focusedTxt = `focused ${fx.pass}/0`;
      else if (fx.fail > 0 && preexistingOnly(fb) && ok('preexisting-on-main')) focusedTxt = `focused ${fx.pass}/${fx.fail} preexisting-only (new 0 · ${fb!.mine} also red on main)`;
    }
    if (!focusedTxt) {
      const seen = fx === null ? 'unreadable' : 'exit' in fx ? `exit ${fx.exit}` : `${fx.pass} pass ${fx.fail} fail`;
      const base = fb ? ` · baseline new ${fb.newFailures.length}${fb.newFailures.length ? ` (${fb.newFailures.slice(0, 2).join(', ')})` : ''}` : '';
      missing.push(`#${f.pr} focused exit 0 (${seen}${base})`); continue;
    }
    // the evidence ref stays «#PR@head dir focused» (the veto fingerprint); the patch-id reuse is told in the why only
    const ref = `#${f.pr}@${landed12} ${f.receipt.dir.split('/').pop()} ${focusedTxt}`;
    evidence.push(ref);
    whys.push(f.receipt.reusedFrom ? `${ref} (receipt of ${f.receipt.reusedFrom.slice(0, 12)} · PR-own patch-id equal)` : ref);
  }
  if (hits.length) return { kind: 'security', why: `security-4: ${[...new Set(hits)].slice(0, 4).join(', ')} — JUD/Terra signs this one`, hits: [...new Set(hits)] };
  if (missing.length) return { kind: 'missing', why: missing.join(' · '), missing };
  const runId = sim ? e4RunId(sim) : null;
  return { kind: 'sign', why: `${whys.join(' · ')}${runId ? ` · E4 ${runId} rc 0` : ' · E4 없음 → FU'}`, evidence: [...evidence, ...(runId ? [`E4:${runId}`] : [])], e4: runId };
}

/** BUTLER-RESCAN: the judging rules' version — a change re-judges every cell the butler escalated as security-4. */
/** BUTLER-E4-AUTORUN: the only gap is the E4 sim/test-universe evidence line. */
export const signWithoutE4 = (v: Verdict): boolean => v.kind === 'sign' && v.e4 === null;

export const RULES_VERSION: string = (() => {
  const src = [SECURITY4_PATHS.map(p => `${p.cls}:${p.re.source}`).join('|'), isNonExecutablePath.toString(), judgeCell.toString(), simEvidenceLine.toString(), JSON.stringify(GREEN_RULES), isE4Cell.toString()].join('\n');
  return new Bun.CryptoHasher('sha256').update(src).digest('hex').slice(0, 12);
})();
