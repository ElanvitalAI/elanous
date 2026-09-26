import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export interface ReleaseNoteFragment {
  pr: number;
  line: string;
  kind: 'fix' | 'feat' | 'security' | 'internal';
  docs: { path: string } | { none: string };
  target: 'next' | 'later';
  source: 'pr-body' | 'harness' | 'backfill';
  mergeSha?: string;
}

type Section = Omit<ReleaseNoteFragment, 'pr' | 'source' | 'mergeSha'>;

/** Blank out fenced code blocks (``` / ~~~) line-for-line so example headings and fields inside them are never read as the real section. */
function blankFencedCode(text: string): string {
  let fence: string | null = null;
  return text.split('\n').map((line) => {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (open) { fence = open[1]!; return ''; }
      return line;
    }
    if (open && open[1]![0] === fence[0] && open[1]!.length >= fence.length && /^ {0,3}[`~]+[ \t]*\r?$/.test(line)) fence = null;
    return '';
  }).join('\n');
}

export function parseReleaseNoteSection(rawPrBody: string): { fragment?: Section; problems: string[] } {
  const prBody = blankFencedCode(rawPrBody);
  const start = /^## 릴리스 노트[ \t]*\r?$/m.exec(prBody);
  if (!start) return { problems: [] };
  const rest = prBody.slice(start.index + start[0].length).replace(/^\r?\n/, '');
  const nextHeading = /^ {0,3}#{1,6}(?:[ \t]+|$)/m.exec(rest);
  const body = nextHeading ? rest.slice(0, nextHeading.index) : rest;
  const fields = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const match of body.matchAll(/^[ \t]*- (한 줄|종류|문서|대상):[ \t]*(.*?)[ \t]*\r?$/gm)) {
    const name = match[1]!;
    if (fields.has(name)) duplicates.add(name);
    else fields.set(name, match[2]!);
  }
  const line = fields.get('한 줄');
  const kind = fields.get('종류');
  const doc = fields.get('문서');
  const target = fields.get('대상');
  const problems: string[] = [];
  if (duplicates.has('한 줄') || !line?.trim()) problems.push('한 줄');
  if (duplicates.has('종류') || !kind || !['fix', 'feat', 'security', 'internal'].includes(kind)) problems.push('종류');
  if (duplicates.has('문서') || !doc || (doc.startsWith('없음') ? !/^없음\([^\s()]+(?:[^()]*)\)$/.test(doc) : !/^\S+$/.test(doc))) problems.push('문서');
  if (duplicates.has('대상') || (target !== 'next' && target !== 'later')) problems.push('대상');
  if (problems.length) return { problems };
  return {
    fragment: {
      line: line!, kind: kind as Section['kind'],
      docs: doc!.startsWith('없음(') ? { none: doc!.slice(3, -1) } : { path: doc! },
      target: target as Section['target'],
    },
    problems,
  };
}

export function renderReleaseNoteSection(fragment: Section): string {
  return `## 릴리스 노트\n- 한 줄: ${fragment.line}\n- 종류: ${fragment.kind}\n- 문서: ${'path' in fragment.docs ? fragment.docs.path : `없음(${fragment.docs.none})`}\n- 대상: ${fragment.target}\n`;
}

export function harnessReleaseNote(goalDocument: string, title: string): Section {
  const document = blankFencedCode(goalDocument);
  const goal = /^ {0,3}## 목표[ \t]*\r?$/m.exec(document);
  let section = '';
  if (goal) {
    const rest = document.slice(goal.index + goal[0].length);
    let end = rest.length;
    for (const heading of rest.matchAll(/^ {0,3}(#{1,2})[ \t]+([^\r\n]*?)[ \t]*\r?$/gm)) {
      if (heading[1] !== '##' || heading[2] !== '릴리스 노트') {
        end = heading.index;
        break;
      }
    }
    section = rest.slice(0, end);
  }
  return parseReleaseNoteSection(section).fragment ?? {
    line: title,
    kind: 'internal',
    docs: { none: '하니스 자동 생성' },
    target: 'next',
  };
}

export function releaseNotesDir(instanceRoot: string): string {
  return join(instanceRoot, 'release', 'notes');
}

function validFragment(value: unknown): value is ReleaseNoteFragment {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return Number.isSafeInteger(v.pr) && (v.pr as number) > 0
    && (v.mergeSha === undefined || (typeof v.mergeSha === 'string' && v.mergeSha.trim().length > 0))
    && typeof v.line === 'string' && v.line.trim().length > 0
    && ['fix', 'feat', 'security', 'internal'].includes(v.kind as string)
    && (v.target === 'next' || v.target === 'later')
    && ['pr-body', 'harness', 'backfill'].includes(v.source as string)
    && !!v.docs && typeof v.docs === 'object'
    && (('path' in v.docs && typeof v.docs.path === 'string' && v.docs.path.trim().length > 0 && !('none' in v.docs))
      || ('none' in v.docs && typeof v.docs.none === 'string' && v.docs.none.trim().length > 0 && !('path' in v.docs)));
}

const priority: Record<ReleaseNoteFragment['source'], number> = { backfill: 0, harness: 1, 'pr-body': 2 };

export function writeReleaseNote(dir: string, fragment: ReleaseNoteFragment): void {
  if (!validFragment(fragment)) throw new Error('invalid release note fragment');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${fragment.pr}.json`);
  const lock = `${path}.lock`;
  const deadline = Date.now() + 10_000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  let descriptor: number;
  while (true) {
    try { descriptor = openSync(lock, 'wx'); break; }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      if (Date.now() >= deadline) throw new Error(`release note lock timed out: ${lock}`);
      Atomics.wait(wait, 0, 0, 10);
    }
  }
  try {
    let existing: unknown;
    try { existing = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (existing !== undefined && !validFragment(existing)) throw new Error(`invalid release note: ${path}`);
    if (validFragment(existing) && priority[existing.source] >= priority[fragment.source]) return;
    const temporary = join(dir, `.${fragment.pr}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(fragment, null, 2) + '\n');
      renameSync(temporary, path);
    } finally {
      try { unlinkSync(temporary); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
  } finally {
    closeSync(descriptor);
    unlinkSync(lock);
  }
}

export type ReleaseNotes = Map<number, ReleaseNoteFragment> & { problems: string[] };

export function readReleaseNotes(dir: string): ReleaseNotes {
  const notes = new Map<number, ReleaseNoteFragment>() as ReleaseNotes;
  notes.problems = [];
  let files: string[];
  try { files = readdirSync(dir); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return notes;
    throw error;
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const value: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      if (!validFragment(value) || file !== `${value.pr}.json`) throw new Error('invalid fragment or PR filename');
      notes.set(value.pr, value);
    } catch (error) {
      notes.problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return notes;
}
