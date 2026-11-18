// Ratchet on sim-world-expect.json (SIM-WORLD §4): once a scenario is green on an engine it stays green there.
// Compares the base table (main) with the head table (this PR). v1 forbids row deletion (checklist 9).
//   base row missing from head (raw row key)                       → deleted
//   EFFECTIVE (scenario, engine) was green, is red now              → green-to-red   (key `<world>/<scn>@<engine>`)
//     effective = engine row if present, else the common row (expect.ts effectiveSimWorldExpectations) — so adding an
//     engine-specific red row under a common green row, or swapping an engine green row for a common red row, is refused
//   base greenSince removed or rewritten in head (raw row key)      → green-since-changed
//   head red row that carries greenSince                            → red-with-green-since
// New rows and red → green promotions (common or engine-specific) are allowed. Pure: callers make violations loud.
import { effectiveSimWorldExpectations } from './expect.js';
import type { SimWorldExpectTable } from './types.js';

export type SimWorldRatchetViolationKind = 'deleted' | 'green-to-red' | 'green-since-changed' | 'red-with-green-since';
export interface SimWorldRatchetViolation {
  readonly key: string;
  readonly kind: SimWorldRatchetViolationKind;
}

export function checkSimWorldRatchet(base: SimWorldExpectTable, head: SimWorldExpectTable): SimWorldRatchetViolation[] {
  const violations: SimWorldRatchetViolation[] = [];
  for (const key of Object.keys(base.entries).sort()) {
    const was = base.entries[key]!;
    const now = head.entries[key];
    if (!now) violations.push({ key, kind: 'deleted' });
    // A head row that went red is reported once, as green-to-red on its effective keys below.
    else if (was.greenSince !== undefined && now.expect !== 'red' && now.greenSince !== was.greenSince) violations.push({ key, kind: 'green-since-changed' });
  }
  const before = effectiveSimWorldExpectations(base);
  const after = effectiveSimWorldExpectations(head);
  for (const [key, was] of before) {
    const now = after.get(key);
    if ((was.expect === 'green' || was.greenSince !== undefined) && now?.expect === 'red') violations.push({ key, kind: 'green-to-red' });
  }
  for (const key of Object.keys(head.entries).sort()) {
    if (head.entries[key]!.expect === 'red' && head.entries[key]!.greenSince !== undefined) violations.push({ key, kind: 'red-with-green-since' });
  }
  return violations;
}
