// SIM-WORLD-REGISTRY-NO-SHARED-EDIT (#126458 P0): expectation rows live in per-world fragments
// `worlds/expect/<world>.json` so no two seats ever edit the same file. The legacy single
// `worlds/sim-world-expect.json` still wins when present (kernel.test fixtures, --expect-file),
// and a tree with neither is a loud load failure, never a silently empty table.
// Rule 14 (OPS-RULES §14): absent (no table) → throw; malformed (foreign key, duplicate key, bad row) → throw.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseSimWorldExpectTable } from './expect.js';
import type { SimWorldExpectEntry, SimWorldExpectTable } from './types.js';

/** Load the expectation table: legacy single file first, else discover `expect/<world>.json` fragments. */
export function readSimWorldExpectTable(legacyFile: string): SimWorldExpectTable {
  if (existsSync(legacyFile)) return parseSimWorldExpectTable(readFileSync(legacyFile, 'utf8'));
  const fragmentDir = join(dirname(legacyFile), 'expect');
  if (!existsSync(fragmentDir)) throw new Error(`sim-world expect table not found: ${legacyFile} (and no ${fragmentDir} fragments)`);
  const fragments = readdirSync(fragmentDir).filter((name) => name.endsWith('.json')).sort();
  if (fragments.length === 0) throw new Error(`sim-world expect fragment dir is empty: ${fragmentDir}`);
  const entries: Record<string, SimWorldExpectEntry> = {};
  for (const name of fragments) {
    const world = name.replace(/\.json$/u, '');
    const table = parseSimWorldExpectTable(readFileSync(join(fragmentDir, name), 'utf8'));
    for (const [key, row] of Object.entries(table.entries)) {
      // duplicate first: a second fragment claiming an existing key is reported as the
      // cross-fragment duplicate it is, not masked as a foreign-key error (Rule 14).
      if (key in entries) throw new Error(`sim-world expect key duplicated across fragments: ${key}`);
      if (!key.startsWith(`${world}/`)) throw new Error(`sim-world expect fragment ${name} holds a foreign key: ${key}`);
      entries[key] = row;
    }
  }
  return { schema: 1, entries };
}
