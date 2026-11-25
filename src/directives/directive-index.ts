// Public-build stand-in for src/directives/directive-index.ts (the owner's local utterance index, excluded by
// release/public-export.yaml). Public modules (ask, directive-semantic, the DirectiveSearch tool, sim scenarios) type
// against this surface; in the public build the index is not available and constructing it says so plainly.
import type { Database } from 'bun:sqlite';
import type { DirectiveAgent, SourceOptions } from './sources.js';

// Self-contained on purpose: this file is type-checked where it lives (release/public/directives) and where it lands.
/** Same shape as src/directives/version-at.ts VersionOptions. */
interface VersionOptions { releaseRoot?: string; repoRoot?: string; codenames?: Record<string, string> }

export interface DirectiveRow {
  ts: string; agent: DirectiveAgent; session_id: string; cwd: string | null;
  track: string | null; released: string | null; dev: string | null;
  codename: string | null; text: string; source_file: string; line_no: number;
}
/** `agent` takes one channel or a comma list (`codex,elanous`). `order` defaults to newest first. */
export interface DirectiveFilters { since?: string; until?: string; version?: string; agent?: DirectiveAgent | string; track?: string; limit?: number; offset?: number; order?: 'asc' | 'desc' }
/** One utterance after merging the copies relayed through several channels. */
export interface Utterance extends DirectiveRow { channels: DirectiveAgent[] }
/** Same words within this window on several channels are one utterance relayed, not a repeat. */
export const RELAY_WINDOW_MS = 2 * 60_000;
function relayKey(text: string): string { return text.replace(/\s+/g, ' ').trim(); }
function sameWords(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  // A relay wraps the person's words (mail head, «[TG-OP]» tag); a short line inside another is too weak to merge.
  return short.length >= 12 && long.includes(short);
}
/** Merges one utterance relayed through several channels: the earliest copy stays, every channel is kept. */
export function dedupeUtterances(rows: readonly DirectiveRow[]): Utterance[] {
  const ordered = [...rows].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const merged: Array<Utterance & { key: string; at: number; origins: Set<string> }> = [];
  for (const row of ordered) {
    const key = relayKey(row.text);
    const at = Date.parse(row.ts);
    const origin = `${row.agent}\0${row.session_id}`;
    let same: (typeof merged)[number] | undefined;
    for (let i = merged.length - 1; i >= 0 && at - merged[i]!.at <= RELAY_WINDOW_MS; i--) {
      const prior = merged[i]!;
      // Inside one session a repeated line is the person repeating it, not a relay.
      if (!prior.origins.has(origin) && sameWords(prior.key, key)) { same = prior; break; }
    }
    if (same) {
      if (!same.channels.includes(row.agent)) same.channels.push(row.agent);
      same.origins.add(origin);
      continue;
    }
    merged.push({ ...row, channels: [row.agent], key, at, origins: new Set([origin]) });
  }
  return merged.map(({ key: _key, at: _at, origins: _origins, ...row }) => row);
}
export interface SyncResult {
  perSource: Record<DirectiveAgent, { files: number; directives: number }>;
  added: number; skipped: number; missingSources: DirectiveAgent[]; lastSync: string;
  timings: { walk: { ms: number; files: number }; parse: { ms: number; openedFiles: number; newLines: number }; insert: { ms: number; newDirectives: number }; search: { ms: number } };
}
export interface IndexOptions extends SourceOptions, VersionOptions { stateDir?: string; sessionLabels?: Record<string, string> }

const UNAVAILABLE = 'The directive index is local-only and is not part of this build.';

export function directiveDbPath(_stateDir?: string): string { throw new Error(UNAVAILABLE); }

export class DirectiveIndex {
  readonly db!: Database;
  constructor(_options: IndexOptions = {}) { throw new Error(UNAVAILABLE); }
  close(): void { throw new Error(UNAVAILABLE); }
  sync(_full = false): SyncResult { throw new Error(UNAVAILABLE); }
  dailyRequirements(_since: string, _until: string): DirectiveRow[] { throw new Error(UNAVAILABLE); }
  utterances(_filters: Omit<DirectiveFilters, 'limit' | 'offset' | 'order'> = {}): Utterance[] { throw new Error(UNAVAILABLE); }
  lastSync(): string | null { throw new Error(UNAVAILABLE); }
  count(): number { throw new Error(UNAVAILABLE); }
  filterClause(_filters: DirectiveFilters = {}): { where: string[]; params: Array<string | number> } { throw new Error(UNAVAILABLE); }
  search(_query = '', _filters: DirectiveFilters = {}): DirectiveRow[] { throw new Error(UNAVAILABLE); }
}
