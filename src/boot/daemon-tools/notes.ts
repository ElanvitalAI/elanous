// DEMO-1121-VAULT-NOTES-READ (OP #103716): the chat agent reads the notes folder the member chose at onboarding
// (PWA /setup/done «Obsidian 볼트·스킬 폴더» → config obsidian.vault · resolveObsidianRoot). Two read-only tools:
// NotesSearch (which notes match) and NotesRead (one note's text). Both are rooted at that folder — never the daemon's
// cwd — and nothing outside it is reachable (path-guard resolveSafe: `..`, absolute paths elsewhere, symlinks out, and the
// credential deny-list). They write nothing.
import { readFileSync, statSync } from 'node:fs';
import type { LLMToolSpec } from '../../llm/tool-spec.js';
import { resolveObsidianRoot } from '../../acp/fs-roots.js';
import { resolveSafe } from './path-guard.js';
import { ToolSafetyError } from './types.js';

// 출처: OP #103716 데모 = 강의 노트 md 한 편 — 한 번에 모델로 넘길 본문 상한(그 너머는 truncated 로 알림).
export const NOTES_READ_MAX_BYTES = 200_000;
const NOTE_FILE = /\.(md|markdown|txt)$/i;

export interface NotesRoot { readonly available: boolean; readonly root: string }
const defaultRoot = (): NotesRoot => { const ob = resolveObsidianRoot(); return { available: ob.available, root: ob.root }; };

export function buildNotesSearchTool(): LLMToolSpec {
  return {
    name: 'NotesSearch',
    description: 'Find notes in the member\'s notes folder (the Obsidian vault chosen at onboarding) whose path or name matches '
      + 'the query (e.g. a lecture or topic name). Returns paths relative to that folder; read one with NotesRead. Read-only; '
      + 'only that folder is searched.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'words in the note\'s name or folder' }, limit: { type: 'number' } } },
  };
}

export function buildNotesReadTool(): LLMToolSpec {
  return {
    name: 'NotesRead',
    description: 'Read one note (.md/.markdown/.txt) from the member\'s notes folder by its path relative to that folder (from '
      + 'NotesSearch). Read-only; a path outside the folder is refused.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'path relative to the notes folder' } }, required: ['path'] },
  };
}

const unavailable = (): ToolSafetyError => new ToolSafetyError('unavailable', 'no notes folder is set — the member chooses it in setup («Obsidian 볼트·스킬 폴더»)');

export async function dispatchNotesSearch(args: { query?: unknown; limit?: unknown }, notesRoot: () => NotesRoot = defaultRoot): Promise<unknown> {
  const { available, root } = notesRoot();
  if (!available) throw unavailable();
  const { findNotes } = await import('../../acp/obsidian-notes.js');
  return findNotes({ vaultRoot: root, ...(typeof args.query === 'string' ? { query: args.query } : {}), ...(typeof args.limit === 'number' ? { limit: args.limit } : {}) });
}

export function dispatchNotesRead(args: { path?: unknown }, notesRoot: () => NotesRoot = defaultRoot): { path: string; content: string; size: number; truncated: boolean } {
  const { available, root } = notesRoot();
  if (!available) throw unavailable();
  if (typeof args.path !== 'string' || !args.path.trim()) throw new ToolSafetyError('path-traversal', 'path must be a non-empty string');
  if (!NOTE_FILE.test(args.path)) throw new ToolSafetyError('path-traversal', `${args.path}: only .md, .markdown or .txt notes are read`);
  const safe = resolveSafe(args.path, root);           // throws for `..`, other roots, symlinks out, deny-list
  const stat = statSync(safe);
  if (!stat.isFile()) throw new ToolSafetyError('path-traversal', `${args.path} is not a note file`);
  const buffer = readFileSync(safe);
  const truncated = buffer.length > NOTES_READ_MAX_BYTES;
  return { path: args.path, content: buffer.subarray(0, NOTES_READ_MAX_BYTES).toString('utf8'), size: stat.size, truncated };
}
