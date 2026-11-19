import { tracedPathReferences, verbatimOriginalAsk } from '../self-implement/goal-author.js';

/** Declared target paths, or traced path references when absent. */
export function goalTargetPaths(document: string): string[] {
  const ask = verbatimOriginalAsk(document);
  const targetLine = (ask ?? document).split(/\r?\n/)
    .map((line) => /^대상 경로:\s*(.+)$/.exec(line)?.[1])
    .find((line) => line !== undefined);
  const namedPaths = targetLine?.split(' · ').map((path) => path.trim().replace(/^`|`$/g, '')).filter(Boolean) ?? [];
  return namedPaths.length ? namedPaths : tracedPathReferences(document).map(({ path }) => path);
}
