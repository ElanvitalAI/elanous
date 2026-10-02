import type { ReleaseNoteFragment } from './release-note.js';

export interface ReleaseLanding {
  sha: string;
  title: string;
  prNumber?: number;
  changedFiles: string[];
  goalPath?: string;
  releaseTarget?: 'next' | 'later';
}

export interface ReleaseManifestInput {
  version: string;
  baseline: { ref: string; sha: string };
  cutoff: { sha: string };
  landings: ReleaseLanding[];
  notes?: Map<number, ReleaseNoteFragment>;
  /** Note lines from release/next.md at the cutoff, each tied to the landing that added it when known. */
  nextMd?: NextMdNote[];
  runningGoalPaths: string[];
  publicCommandsBefore: string[];
  publicCommandsAfter: string[];
}

export interface ReleaseManifest {
  version: string;
  baseline: ReleaseManifestInput['baseline'];
  cutoff: ReleaseManifestInput['cutoff'];
  in: Array<{ sha: string; title: string; prNumber?: number; docs: 'present' | 'missing' | 'n/a'; line?: string; kind?: ReleaseNoteFragment['kind'] | NextMdKind | 'unknown'; note?: 'missing' }>;
  deferred: Array<{ sha: string; reason: 'release-target-later' | 'run-in-flight' }>;
  escalate: Array<{ kind: 'command-removed'; command: string } | { kind: 'notes-empty'; featFixLandings: number; nextMdLines: number }>;
  /** Where each IN line came from — present when next.md was read. */
  fragments?: { byPr: number; byNextMd: number; unlinked: number; unknown: number };
}

export type NextMdKind = 'feat' | 'fix' | 'security' | 'perf' | 'docs' | 'internal';
export interface NextMdNote { kind: NextMdKind; line: string; sha?: string; /** The list line as written, to find the landing that added it. */ raw?: string }

const NEXT_MD_KINDS: readonly NextMdKind[] = ['feat', 'fix', 'security', 'perf', 'docs', 'internal'];
const USER_KINDS = new Set(['feat', 'fix', 'security']);

/**
 * Read `release/next.md` note lines: the `## Feat` / `## Fix` … heading gives the kind, an explicit `- <kind> — ` prefix wins.
 * The trailing `Documentation: … Target: …` fields are dropped from the sentence; `Target: later` lines are skipped.
 */
export function parseNextMdNotes(text: string): NextMdNote[] {
  const notes: NextMdNote[] = [];
  let section: NextMdKind | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const heading = /^##\s+(\S+)\s*$/.exec(raw.trim());
    if (heading) { const kind = heading[1]!.toLowerCase(); section = (NEXT_MD_KINDS as readonly string[]).includes(kind) ? kind as NextMdKind : null; continue; }
    const item = /^-\s+(.*\S)\s*$/.exec(raw);
    if (!item) continue;
    let body = item[1]!;
    if (/\bTarget:\s*later\b/i.test(body)) continue;
    const prefix = /^(feat|fix|security|perf|docs|internal)\s+[—-]\s+/i.exec(body);
    const kind = prefix ? prefix[1]!.toLowerCase() as NextMdKind : section;
    if (!kind) continue;
    if (prefix) body = body.slice(prefix[0].length);
    body = body.replace(/\s+Documentation:.*$/s, '').replace(/\s+Target:\s*\S+\.?\s*$/, '').trim();
    if (body) notes.push({ kind, line: body, raw: raw.trim() });
  }
  return notes;
}

/** Classify the already-observed landings without reading git, run ledgers or the filesystem. */
export function buildReleaseManifest(input: ReleaseManifestInput): ReleaseManifest {
  const running = new Set(input.runningGoalPaths);
  const after = new Set(input.publicCommandsAfter);
  const result: ReleaseManifest = {
    version: input.version,
    baseline: { ...input.baseline },
    cutoff: { ...input.cutoff },
    in: [],
    deferred: [],
    escalate: [],
  };
  const nextBySha = new Map<string, NextMdNote[]>();
  const landingShas = new Set(input.landings.map((landing) => landing.sha));
  const unlinked: NextMdNote[] = [];
  for (const note of input.nextMd ?? []) {
    if (note.sha && landingShas.has(note.sha)) nextBySha.set(note.sha, [...(nextBySha.get(note.sha) ?? []), note]);
    else unlinked.push(note);
  }
  const counts = { byPr: 0, byNextMd: 0, unlinked: 0, unknown: 0 };
  for (const landing of input.landings) {
    const fragment = landing.prNumber === undefined ? undefined : input.notes?.get(landing.prNumber);
    if (landing.goalPath && running.has(landing.goalPath)) {
      result.deferred.push({ sha: landing.sha, reason: 'run-in-flight' });
    // ⭐ 줄이 없으면 IN — 명시 `release-target: later` 만 미룬다(METHOD v115 ④ · 흡수 골은 머리에 later 를 «명시»한다).
    } else if (fragment?.target === 'later' || (!fragment && landing.releaseTarget === 'later')) {
      result.deferred.push({ sha: landing.sha, reason: 'release-target-later' });
    } else {
      const docs = fragment ? ('path' in fragment.docs ? 'present' : 'n/a')
        : landing.changedFiles.some((file) => file.startsWith('release/public/docs/')) ? 'present'
        : landing.changedFiles.some((file) => file.startsWith('src/cli/') || file === 'src/index.ts') ? 'missing'
        : 'n/a';
      const base: ReleaseManifest['in'][number] = { sha: landing.sha, title: landing.title, ...(landing.prNumber === undefined ? {} : { prNumber: landing.prNumber }), docs };
      // PR fragment first, then the next.md lines this landing added; only with neither is the line unknown.
      const fromNext = fragment ? [] : nextBySha.get(landing.sha) ?? [];
      if (fragment) { counts.byPr++; result.in.push({ ...base, line: fragment.line, kind: fragment.kind }); }
      else if (fromNext.length) for (const note of fromNext) { counts.byNextMd++; result.in.push({ ...base, line: note.line, kind: note.kind }); }
      else { if (input.notes) counts.unknown++; result.in.push({ ...base, ...(input.notes ? { line: landing.title, kind: 'unknown' as const, note: 'missing' as const } : {}) }); }
    }
  }
  // A next.md line no landing in range claims still belongs to this release.
  for (const note of unlinked) { counts.unlinked++; result.in.push({ sha: note.sha ?? '', title: note.line, docs: 'n/a', line: note.line, kind: note.kind }); }
  if (input.nextMd) {
    result.fragments = counts;
    const shown = result.in.filter((entry) => entry.line && entry.kind && USER_KINDS.has(entry.kind)).length;
    const featFixLandings = input.landings.filter((landing) => /^(feat|fix)\b/i.test(landing.title)).length;
    const nextMdLines = input.nextMd.filter((note) => USER_KINDS.has(note.kind)).length;
    if (!shown && (featFixLandings || nextMdLines)) result.escalate.push({ kind: 'notes-empty', featFixLandings, nextMdLines });
  }
  for (const command of input.publicCommandsBefore) {
    if (!after.has(command)) result.escalate.push({ kind: 'command-removed', command });
  }
  return result;
}
