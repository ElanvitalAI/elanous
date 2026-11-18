import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetStrayMergeAttempts, strayMergeRunCount } from './memory-db-path.js';
import { openSurfaceEventsDb, recordEvent, surfaceEventsDbPath } from './surface-events.js';
import { knowledgeDbPath, openKnowledgeDb } from './knowledge.js';

// NIGHTLY-CONDENSE-INPUT-PATH — the openers fold a stray memory DB into the canonical one at most once per process.

const originalStateDir = process.env.ELANOUS_STATE_DIR;
const dirs: string[] = [];
afterEach(() => {
  resetStrayMergeAttempts();
  if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = originalStateDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function universe(): { state: string; strayEvents: string; strayKnowledge: string } {
  const state = mkdtempSync(join(tmpdir(), 'memory-db-stray-'));
  dirs.push(state);
  process.env.ELANOUS_STATE_DIR = state;
  const strays = { strayEvents: join(state, 'stray', 'surface_events.db'), strayKnowledge: join(state, 'stray', 'knowledge.db') };
  resetStrayMergeAttempts(name => name === 'surface_events.db' ? strays.strayEvents : strays.strayKnowledge);
  return { state, ...strays };
}

test('two opens of the production surface-events path in one process make one merge attempt', () => {
  const { strayEvents } = universe();
  const stray = openSurfaceEventsDb(strayEvents);
  const first = recordEvent(stray, { surface: 'context:external', direction: 'outbound', text: 'before' });
  stray.close();

  const a = openSurfaceEventsDb();
  // A pre-fix writer keeps writing the stray: its size/mtime marker no longer matches.
  const writer = openSurfaceEventsDb(strayEvents);
  recordEvent(writer, { surface: 'context:external', direction: 'outbound', text: 'after' });
  writer.close();
  const b = openSurfaceEventsDb();
  try {
    expect(strayMergeRunCount(surfaceEventsDbPath())).toBe(1);
    // The second open neither re-scanned nor took the write lock: only the first stray row is folded in.
    expect((b.prepare('SELECT id FROM events').all() as Array<{ id: string }>).map(row => row.id)).toEqual([first]);
    expect((b.prepare('SELECT id FROM events_fts').all() as Array<{ id: string }>).map(row => row.id)).toEqual([first]);
  } finally { a.close(); b.close(); }
  // A new process (reset) makes the next attempt and picks up the later row, without duplicates.
  resetStrayMergeAttempts(name => name === 'surface_events.db' ? strayEvents : undefined);
  const c = openSurfaceEventsDb();
  try { expect((c.prepare('SELECT text FROM events ORDER BY text').all() as Array<{ text: string }>).map(row => row.text)).toEqual(['after', 'before']); }
  finally { c.close(); }
});

test('openKnowledgeDb on the production path merges docs and docs_fts from the stray file once', () => {
  const { strayKnowledge } = universe();
  const stray = openKnowledgeDb(strayKnowledge);
  stray.run(`INSERT INTO docs(id, ts, kind, text, embed_model, embedding) VALUES ('doc-1', '2026-11-16T01:00:00.000Z', 'note', 'stray doc', 'fake', x'00')`);
  stray.run(`INSERT INTO docs_fts(id, search_text) VALUES ('doc-1', 'stray doc')`);
  stray.close();

  const first = openKnowledgeDb();
  first.close();
  const db = openKnowledgeDb();
  try {
    expect(strayMergeRunCount(knowledgeDbPath())).toBe(1);
    expect((db.prepare('SELECT id, text FROM docs').all() as Array<{ id: string; text: string }>)).toEqual([{ id: 'doc-1', text: 'stray doc' }]);
    expect((db.prepare('SELECT id FROM docs_fts').all() as Array<{ id: string }>).map(row => row.id)).toEqual(['doc-1']);
  } finally { db.close(); }
});
