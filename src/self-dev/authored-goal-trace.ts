import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendRunLedgerEntry, runLedgerDir } from '../self-implement/run-ledger.js';
import { debug } from '../debug/log.js';

/** AUTHOR-TRACE: what `harness say`/`ask` authored, kept with the run — the goal file itself may be cleaned up later,
 *  so the ledger carries path ⊕ sha256 ⊕ size and the body is archived next to the ledger. */
export interface AuthoredGoalTrace {
  path: string;
  sha256: string;
  chars: number;
  sections: number;
  archivedAt: string;
}

/** `## ` headings outside fenced code (a fence closes only on the same marker, at least as long). */
function countSections(document: string): number {
  let fence: { char: string; length: number } | null = null;
  let count = 0;
  for (const line of document.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && line.trim() === marker[1]) fence = null;
      continue;
    }
    if (marker) { fence = { char: marker[1]![0]!, length: marker[1]!.length }; continue; }
    if (/^ {0,3}##\s/.test(line)) count += 1;
  }
  return count;
}

export function authoredGoalTrace(path: string, document: string, archivedAt: string): AuthoredGoalTrace {
  return {
    path,
    sha256: createHash('sha256').update(document).digest('hex'),
    chars: [...document].length,
    sections: countSections(document),
    archivedAt,
  };
}

/** Archive the body, emit one `goal-author`/`goal-authored` observation and — when the run id is already known —
 *  append a `goal-authored` run-ledger event. At `harness say` authoring time the run id usually does not exist yet;
 *  the authoring run id (`authorRunId`, joined to the goal by `goal-id-assigned`) keys the record then. */
export function recordAuthoredGoal(
  ids: { runId?: string; authorRunId?: string },
  path: string,
  document: string,
  options: { ledgerDir?: string; archiveDir?: string } = {},
): AuthoredGoalTrace {
  const key = ids.runId ?? ids.authorRunId;
  if (!key) throw new Error('recordAuthoredGoal needs a runId or an authorRunId');
  const ledgerDir = options.ledgerDir ?? runLedgerDir();
  const archiveDir = options.archiveDir ?? join(dirname(ledgerDir), 'authored-goals');
  const digest = createHash('sha256').update(document).digest('hex');
  const archived = join(archiveDir, `${key}-${digest.slice(0, 12)}.md`);
  if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
  writeFileSync(archived, document, 'utf8');
  const trace = authoredGoalTrace(path, document, archived);
  debug.log('goal-author', 'goal-authored', { ...ids, ...trace });
  if (ids.runId) appendRunLedgerEntry({ runId: ids.runId, event: 'goal-authored', data: { ...trace, ...(ids.authorRunId ? { authorRunId: ids.authorRunId } : {}) } }, ledgerDir);
  return trace;
}
