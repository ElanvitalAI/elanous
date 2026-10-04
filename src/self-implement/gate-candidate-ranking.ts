import type { GateCallerReason } from './gate-scope.js';

export interface GateCallerCandidate {
  readonly file: string;
  readonly reasons: readonly GateCallerReason[];
}

/** Path segments between `file` and the nearest changed path's directory (0 = same directory). */
function directoryDistance(file: string, changedPaths: readonly string[]): number {
  const dir = file.split('/').slice(0, -1);
  let best = Infinity;
  for (const changed of changedPaths) {
    const other = changed.split('/').slice(0, -1);
    let shared = 0;
    while (shared < dir.length && shared < other.length && dir[shared] === other[shared]) shared += 1;
    best = Math.min(best, dir.length - shared + other.length - shared);
  }
  return best;
}

/**
 * Rank gate caller tests by closeness to the change, nearest first (GATE-CALLERS2 — the cap keeps the head).
 * A `route` candidate names a route on a changed diff line, so it ranks with touched tests (distance 0);
 * otherwise the distance is the shortest reverse-import path from a changed file (direct importer = 1,
 * unreachable = after every reachable candidate). Equal distances prefer the test nearest a changed file
 * in the directory tree, then numeric-aware path order. Inputs are not modified.
 * `importersByFile` maps each imported file to its immediate importers (tests or sources).
 */
export function rankGateCallerCandidates<T extends GateCallerCandidate>(
  changedPaths: readonly string[],
  candidates: readonly T[],
  importersByFile: ReadonlyMap<string, readonly string[]>,
): T[] {
  const distances = new Map<string, number>();
  const queue: string[] = [];
  for (const path of changedPaths) {
    if (distances.has(path)) continue;
    distances.set(path, 0);
    queue.push(path);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const source = queue[index]!;
    const nextDistance = distances.get(source)! + 1;
    for (const importer of importersByFile.get(source) ?? []) {
      if (distances.has(importer)) continue;
      distances.set(importer, nextDistance);
      queue.push(importer);
    }
  }
  const keys = new Map(candidates.map((candidate) => [candidate, {
    distance: candidate.reasons.includes('route') ? 0 : distances.get(candidate.file) ?? Infinity,
    directory: directoryDistance(candidate.file, changedPaths),
  }]));
  return [...candidates].sort((left, right) => {
    const a = keys.get(left)!;
    const b = keys.get(right)!;
    return (a.distance - b.distance || 0) || (a.directory - b.directory || 0)
      || left.file.localeCompare(right.file, undefined, { numeric: true });
  });
}
