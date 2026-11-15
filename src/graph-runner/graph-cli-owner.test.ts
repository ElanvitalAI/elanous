import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGraphCliVerifiedOwner } from './graph-cli-owner.js';

test('CLI build graph passes only the official app-bound owner and rejects missing or mismatched sessions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-cli-owner-'));
  try {
    const graph = join(root, 'app-build.yaml');
    writeFileSync(graph, 'nodes:\n  - { id: reserve, type: capability, requires: source-build.reserve@1 }\n');
    const session = { nexusUrl: 'https://api.elanous.ai', sessionToken: 'aps_private_fixture', appSlug: 'app-slot' };
    let lookups = 0;
    const resolveOwner = async () => { lookups++; return { id: 'official-member' }; };
    expect(await resolveGraphCliVerifiedOwner(graph, { appSlug: 'app-slot', ownerId: 'forged' },
      { readSession: () => session, resolveOwner })).toBe('official-member');
    expect(lookups).toBe(1);
    expect(await resolveGraphCliVerifiedOwner(graph, { appSlug: 'foreign-slot' },
      { readSession: () => session, resolveOwner })).toBeUndefined();
    expect(await resolveGraphCliVerifiedOwner(graph, { appSlug: 'app-slot' },
      { readSession: () => undefined, resolveOwner })).toBeUndefined();
    expect(lookups).toBe(1);
    expect(await resolveGraphCliVerifiedOwner(graph, { appSlug: 'app-slot' },
      { readSession: () => session, resolveOwner: async () => undefined })).toBeUndefined();
    writeFileSync(graph, 'nodes:\n  - { id: read, type: capability, requires: store.events@1 }\n');
    expect(await resolveGraphCliVerifiedOwner(graph, {}, { readSession: () => session, resolveOwner })).toBeUndefined();
    expect(lookups).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
