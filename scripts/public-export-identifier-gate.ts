#!/usr/bin/env bun
/**
 * LAND10-SHIFT-LEFT — the public-export identifier check, moved left from `release prepare` into the light pregate.
 *
 * Situation: `release prepare` runs `scripts/public-export.ts --out`, whose private-redaction step refuses to rewrite a
 *   code identifier (an unquoted object key or a variable named like a private host in the off-repo redaction table).
 * Complication: PRs landed without that check — 0.3.38 prepare failed twice (#40609 · #40614) on keys merged hours earlier.
 * Question: can the PR that adds such an identifier fail before it lands?
 * Answer: yes — this runs the same identifier assertion (`redactionIdentifierHits`) over the PR's own changed export files.
 *   `test/rules-contract.test.ts` calls it, so it runs inside the pregate `rules-and-ratchets` stage (every grade, before
 *   focused tests). Only identifiers are checked here; the full marker leak check stays with `pr land`/harness gates.
 *   Manifest transforms are comment-scoped (release/public-export.yaml), so they never change an identifier — the raw text
 *   is what prepare checks for identifiers.
 *
 *   bun scripts/public-export-identifier-gate.ts --base <sha>              # files changed since <sha> (worktree ⊕ untracked)
 *   bun scripts/public-export-identifier-gate.ts --changed-files a.ts b.ts
 *   exit 1 = hits (file:line:col + fix hint) · 0 = clean or «못 쟀다» (said on stderr, never silently)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { publicExportChangedFiles } from './ci-public-export-leak-gate.js';
import { loadPrivateRedactions, privateRedactionsPath, redactionIdentifierHits, type PrivateRedaction, type RedactionIdentifierHit } from './public-export.js';

export interface IdentifierGateResult {
  /** false = not measured (no redaction table · no diff base) — the caller says «못 쟀다», it is not «clean». */
  readonly measured: boolean;
  readonly files: number;
  readonly hits: readonly RedactionIdentifierHit[];
  readonly note?: string;
}

export const IDENTIFIER_FIX_HINT = "quote the key ('…': value) or rename the identifier — release prepare's private redaction refuses to rewrite code identifiers";

/** Changed paths since `base` (committed ⊕ worktree ⊕ untracked); deleted paths are dropped (nothing left to export). */
export function changedFilesSince(base: string, root: string): string[] {
  const diff = spawnSync('git', ['diff', '--name-only', '--diff-filter=d', base], { cwd: root, encoding: 'utf8' });
  if (diff.status !== 0) throw new Error(`git diff ${base} failed: ${String(diff.stderr).trim()}`);
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  if (untracked.status !== 0) throw new Error(`git ls-files --others failed: ${String(untracked.stderr).trim()}`);
  return [...new Set(`${diff.stdout}\n${untracked.stdout}`.split('\n').map((line) => line.trim()).filter(Boolean))];
}

export function identifierGate(
  changedFiles: readonly string[],
  root: string,
  redactions: readonly PrivateRedaction[] | null = loadPrivateRedactions(),
): IdentifierGateResult {
  const exported = publicExportChangedFiles(changedFiles, root).filter((file) => existsSync(join(root, file)));
  if (!redactions) {
    return { measured: false, files: exported.length, hits: [], note: `private redaction table absent (${privateRedactionsPath()})` };
  }
  const hits: RedactionIdentifierHit[] = [];
  for (const file of exported) {
    const text = readFileSync(join(root, file), 'utf8');
    if (text.includes('\u0000')) continue;
    hits.push(...redactionIdentifierHits(file, text, redactions));
  }
  hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  return { measured: true, files: exported.length, hits };
}

/** One line per hit — the private value itself is never printed (only its placeholder), so receipts stay exportable. */
export function formatIdentifierHit(hit: RedactionIdentifierHit): string {
  return `${hit.file}:${hit.line}:${hit.column} code identifier matches a private redaction (→ ${hit.placeholder}) · fix: ${IDENTIFIER_FIX_HINT}`;
}

export function summarizeIdentifierGate(result: IdentifierGateResult): string {
  if (!result.measured) return `PUBLIC-EXPORT-IDENTIFIERS 못 쟀다 — ${result.note ?? 'unknown'} · ${result.files} changed export files unchecked`;
  return `PUBLIC-EXPORT-IDENTIFIERS ${result.hits.length ? 'RED' : 'ok'} — ${result.files} changed export files · ${result.hits.length} identifier hits`;
}

export function runIdentifierGate(io: { args: readonly string[]; cwd: string; log: (line: string) => void; error: (line: string) => void }): number {
  const baseAt = io.args.indexOf('--base');
  const filesAt = io.args.indexOf('--changed-files');
  let files: string[];
  if (filesAt >= 0) files = io.args.slice(filesAt + 1).filter((arg) => !arg.startsWith('--'));
  else if (baseAt >= 0 && io.args[baseAt + 1]) {
    try { files = changedFilesSince(io.args[baseAt + 1]!, io.cwd); }
    catch (error) { io.error(`PUBLIC-EXPORT-IDENTIFIERS 못 쟀다 — ${error instanceof Error ? error.message : String(error)}`); return 0; }
  } else {
    io.error('usage: bun scripts/public-export-identifier-gate.ts --base <sha> | --changed-files <file…>');
    return 2;
  }
  const result = identifierGate(files, io.cwd);
  (result.measured ? io.log : io.error)(summarizeIdentifierGate(result));
  for (const hit of result.hits) io.error(`  ${formatIdentifierHit(hit)}`);
  return result.hits.length ? 1 : 0;
}

if (import.meta.main) {
  process.exit(runIdentifierGate({ args: process.argv.slice(2), cwd: resolve(import.meta.dir, '..'), log: console.log, error: console.error }));
}
