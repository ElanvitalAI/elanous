import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { debug } from '../debug/log.js';
import { listChecklist, setItem } from './checklist.js';
import { evidencePlan, landedButYellow, type MergedChecklistPr } from './landed-but-yellow.js';
import { assignedVersions, evidenceAdd } from './feature-store.js';

export interface MergedPrChecklistDeps {
  readPr?: (number: number, cwd: string) => { state: string; baseRefName: string; title: string; body: string | null; mergedAt: string };
  versions?: () => string[];
  checklist?: typeof listChecklist;
  addEvidence?: typeof evidenceAdd;
  setStatus?: typeof setItem;
  log?: typeof debug.log;
}

/** A confirmed main merge is the only entry. The existing checklist matcher owns PR-to-cell decisions. */
export function syncMergedPrChecklist(number: number, cwd: string, goalFile?: string, deps: MergedPrChecklistDeps = {}): void {
  const log = deps.log ?? debug.log.bind(debug);
  const pr = (deps.readPr ?? ((n, dir) => JSON.parse(execFileSync('gh', ['pr', 'view', String(n), '--json', 'state,baseRefName,title,body,mergedAt'], { cwd: dir, encoding: 'utf8', timeout: 30_000 })) as ReturnType<NonNullable<MergedPrChecklistDeps['readPr']>>))(number, cwd);
  if (pr.state !== 'MERGED' || pr.baseRefName !== 'main') return;
  const merged: MergedChecklistPr = { number, title: pr.title, body: pr.body, mergedAt: pr.mergedAt };
  const versions = deps.versions?.() ?? (() => {
    let recorded: string[] = [];
    try { recorded = readdirSync(join(releaseLedgerRoot(), 'release')).filter((version) => /^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/.test(version)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return [...new Set([...assignedVersions(), ...recorded])];
  })();
  let goal: string | undefined;
  if (goalFile) {
    try { goal = readFileSync(goalFile, 'utf8'); }
    catch (error) { log('release.checklist', 'merged-pr-goal-unreadable', { pr: number, goalFile, error: String(error) }); }
  }
  // The audit matcher owns explicit-label and evidence decisions on both PR surfaces.
  // The shared matcher only accepts a whole `칸: X` line. A designated label in the body (`칸: X — …` at a line head)
  // or in the title is restated as such a line; prose mentions are not (the audit command's contract is unchanged).
  const designated = [...goalCells(pr.body ?? ''), ...titleCells(pr.title)];
  // Only the restated labels go to the matcher — raw body text (quotes, fences, indented code) never does.
  const prForMatch = { ...merged, title: '', body: designated.map((id) => `칸: ${id}`).join('\n') };
  const matches = [...new Set(versions)].flatMap((version) => {
    const snapshot = (deps.checklist ?? listChecklist)(version);
    // The audit excludes green/done; evidence still applies to already-green cells.
    const candidates = snapshot.items.map((item) => ({ ...item, status: 'yellow' as const }));
    return landedButYellow(candidates, [prForMatch])
      .filter((row) => row.prs.some((p) => p.basis === 'cell-line'))
      .map((row) => ({ version, snapshot, row }));
  });
  const counts = new Map<string, number>();
  for (const { row } of matches) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  for (const [id, count] of counts) {
    if (count > 1) log('release.checklist', 'merged-pr-cell-ambiguous', { pr: number, id, versions: matches.filter((match) => match.row.id === id).map((match) => match.version) });
  }
  for (const { version, snapshot, row } of matches) {
    if (counts.get(row.id) !== 1) continue;
    for (const { id, ref } of evidencePlan([row])) {
      (deps.addEvidence ?? evidenceAdd)(id, version, ref, 'harness', snapshot.released, snapshot.dev);
      log('release.checklist', 'merged-pr-evidence-added', { version, id, pr: number, ref });
    }
    if (goal && declaresCompletion(goal)) {
      if (!goalCells(goal).has(row.id)) {
        log('release.checklist', 'merged-pr-status-skipped', { version, id: row.id, pr: number, reason: 'goal-does-not-name-cell' });
        continue;
      }
      const from = snapshot.items.find((item) => item.id === row.id)!.status;
      if (from !== 'green' && from !== 'done') {
        (deps.setStatus ?? setItem)(version, row.id, { status: 'green' }, 'harness');
        log('release.checklist', 'merged-pr-status-green', { version, id: row.id, pr: number, from, to: 'green' });
      }
    }
  }
  const found = new Set(matches.map(({ row }) => row.id));
  const missing = [...new Set(designated)].filter((id) => !found.has(id));
  if (!designated.length) log('release.checklist', 'merged-pr-cell-not-found', { pr: number });
  for (const id of missing) log('release.checklist', 'merged-pr-cell-not-found', { pr: number, id });
}

const LABEL_IDS = '([A-Za-z0-9_-]+(?:[ \\t]*,[ \\t]*[A-Za-z0-9_-]+)*)';
const LABEL_END = '(?=[ \\t]*$|[ \\t]+[—–·(-])';
const DESIGNATION = new RegExp(`^ {0,3}(?:#{1,6}[ \\t]+|[-*][ \\t]+)?칸[ \\t]*:[ \\t]*${LABEL_IDS}${LABEL_END}`);

/** Lines of a Markdown document outside fenced code (closed only by the same marker, at least as long), 4-space
 *  indented code and `>` quotes — the only lines that may designate a cell or declare completion. */
function proseLines(text: string): string[] {
  const lines: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && line.trim() === marker[1]) fence = null;
      continue;
    }
    if (marker) { fence = { char: marker[1]![0]!, length: marker[1]!.length }; continue; }
    if (/^( {4}|\t)/.test(line) || /^ {0,3}>/.test(line)) continue;
    lines.push(line);
  }
  return lines;
}

/** Cell ids a document designates on a line head: `칸: X[, Y]`, optionally after a heading or list marker. */
export function goalCells(goal: string): Set<string> {
  const ids = new Set<string>();
  for (const line of proseLines(goal)) {
    const label = DESIGNATION.exec(line);
    if (!label) continue;
    for (const id of label[1]!.split(',')) ids.add(id.trim());
  }
  return ids;
}

/** `이 칸 완료` counts only as a standalone prose line, not inside code or a quote. */
export function declaresCompletion(goal: string): boolean {
  return proseLines(goal).some((line) => /^\s*이 칸 완료\s*$/.test(line));
}

/** A PR title is one authored line: `칸: X — …` may follow a short prefix such as `[TC]` or 「…」. */
export function titleCells(title: string): Set<string> {
  const ids = new Set<string>();
  for (const label of title.matchAll(new RegExp(`(?<![A-Za-z0-9가-힣])칸[ \\t]*:[ \\t]*${LABEL_IDS}${LABEL_END}`, 'g'))) {
    for (const id of label[1]!.split(',')) ids.add(id.trim());
  }
  return ids;
}
