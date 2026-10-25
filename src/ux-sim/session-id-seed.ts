// Seed stored sessions under chosen ids (TUI-RESUME-PICKER). The store only mints random UUIDs,
// so «two sessions share their first 8 characters» can't be reached through createSession alone:
// create it for real, then rename its transcript and its index row to the chosen id.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendMessage, createSession, sessionFile, sessionRoot } from '../session/index.js';

export function seedSessionWithId(id: string, title: string, turns = 2, root: string = sessionRoot()): string {
  const minted = createSession({ source: 'tui', title }, root).id;
  for (let i = 0; i < turns; i++) {
    appendMessage(minted, { role: i % 2 === 0 ? 'user' : 'assistant', content: `${title} ${i + 1}`, ts: new Date().toISOString() }, root);
  }
  renameStoredSession(minted, id, root);
  return id;
}

/** Move a stored session's transcript and index row to `id`. */
function renameStoredSession(from: string, id: string, root: string): void {
  renameSync(sessionFile(from, root), sessionFile(id, root));
  const indexFile = join(root, 'index.json');
  const rows = JSON.parse(readFileSync(indexFile, 'utf-8')) as Array<{ id: string }>;
  for (const row of rows) if (row.id === from) row.id = id;
  writeFileSync(indexFile, JSON.stringify(rows, null, 2));
}

export interface LongSessionSeed {
  id: string;
  rows: number;
  userTurns: number;
  firstUser: string;
  lastAssistant: string;
}

/**
 * A synthetic long session shaped like the n8n case (`elanous-session-c01bd3` · 379 rows, mostly tool
 * rows): each turn is one user message, seven tool rows, one assistant reply, until `rows` rows exist.
 * Text is generated — no real transcript is copied.
 */
export function seedLongSession(id: string, rows = 379, root: string = sessionRoot()): LongSessionSeed {
  const minted = createSession({ source: 'tui', title: `긴 대화 ${rows}행` }, root).id;
  const ts = () => new Date().toISOString();
  let written = 0;
  let turn = 0;
  let lastAssistant = '';
  while (written < rows) {
    turn += 1;
    appendMessage(minted, { role: 'user', content: `턴 ${turn} 질문`, ts: ts() }, root);
    written += 1;
    for (let k = 0; k < 7 && written < rows - 1; k++, written++) {
      appendMessage(minted, { role: 'tool', content: '', toolName: 'Bash', toolArgs: { command: `echo ${turn}-${k}` }, toolResult: `${turn}-${k}`, ts: ts() }, root);
    }
    if (written < rows) {
      lastAssistant = `턴 ${turn} 답 · 끝`;
      appendMessage(minted, { role: 'assistant', content: lastAssistant, ts: ts() }, root);
      written += 1;
    }
  }
  renameStoredSession(minted, id, root);
  return { id, rows: written, userTurns: turn, firstUser: '턴 1 질문', lastAssistant };
}
