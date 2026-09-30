import { closeSync, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug, redactSecretText } from '../debug/log.js';
import { createVersionResolver, type VersionOptions, type Versions } from '../directives/version-at.js';
import { getUserConfig } from '../user-config.js';

export type DecisionCategory = 'secret' | 'publish' | 'money' | 'security' | 'scope' | 'irreversible' | 'other';
export type DecisionTrack = 'S' | 'T' | 'F' | 'O';
export interface DecisionOption { key: string; label: string; consequence: string }
export type Recommendation = { option: string; why: string } | { skipped: true; reason: string };
export type DecisionActor = { kind: 'human' } | { kind: 'auto'; agent: string; track?: DecisionTrack; delegation: string };
export interface DecisionEntry {
  id: string; title: string; category: DecisionCategory; scqa: { s: string; c: string; q?: string; a?: string };
  options: DecisionOption[]; recommendation: Recommendation; raisedAt?: string; importedAt?: string;
  raisedBy: { agent: string; track?: DecisionTrack; session?: string }; version?: Versions;
  status: 'open' | 'decided' | 'withdrawn'; refs?: string[];
  decidedAt?: string; decidedBy?: DecisionActor; choice?: string; note?: string; versionAtDecision?: Versions;
  withdrawnAt?: string; withdrawReason?: string;
  history: Array<{ type: 'raised' | 'options-added' | 'decided' | 'withdrawn'; at?: string; by: string; version?: Versions; choice?: string; reason?: string }>;
}
export type RaiseInput = Pick<DecisionEntry, 'title' | 'category' | 'scqa' | 'options' | 'recommendation' | 'raisedBy' | 'refs'> & { raisedAt?: string };
type Event = { type: 'raised'; entry: DecisionEntry } | { type: 'options-added'; id: string; at: string; options: DecisionOption[]; by: string } | { type: 'decided'; id: string; at?: string; by: DecisionActor; choice?: string; version?: Versions; note?: string } | { type: 'withdrawn'; id: string; at: string; reason: string; version: Versions };
export interface DecisionLedgerOptions extends VersionOptions { stateDir?: string; now?: () => Date; resolveVersion?: (at: string) => Versions }
const CATEGORIES: readonly string[] = ['secret', 'publish', 'money', 'security', 'scope', 'irreversible', 'other'];
const TRACKS: readonly string[] = ['S', 'T', 'F', 'O'];

function required(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
function single(value: string, name: string): string {
  const text = required(value, name);
  if (/[\r\n]/.test(text)) throw new Error(`${name} must be one line`);
  return text;
}
function safe(value: string): string {
  return redactSecretText(value)
    .replace(/\bsk-[a-z0-9-]{16,}\b/gi, '[REDACTED]')
    .replace(/\b(?:gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '[REDACTED]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
}
function utc(value: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) throw new Error(`UTC timestamp required: ${value}`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error(`UTC timestamp required: ${value}`);
  return parsed.toISOString();
}
function scqaField(value: string, name: string): string {
  const original = required(value, `SCQA ${name}`);
  const sentences = original.split(/[.!?。！？]+(?:\s+|$)/).filter(part => part.trim());
  if (Array.from(original).length > 240 || sentences.length > 2) throw new Error(`SCQA ${name} exceeds 2 sentences or 240 characters`);
  return safe(original);
}
function validate(input: RaiseInput, historical = false): RaiseInput {
  const title = safe(single(input.title, 'title'));
  if (!CATEGORIES.includes(input.category)) throw new Error('invalid category');
  if (!input.raisedBy?.agent) throw new Error('raisedBy.agent is required');
  if (input.raisedBy.track && !TRACKS.includes(input.raisedBy.track)) throw new Error('invalid track');
  const s = scqaField(input.scqa.s, 's');
  const c = scqaField(input.scqa.c, 'c');
  const q = input.scqa.q?.trim() ? scqaField(input.scqa.q, 'q') : undefined;
  const a = input.scqa.a?.trim() ? scqaField(input.scqa.a, 'a') : undefined;
  if (q && q === c) throw new Error('SCQA Q repeats C — leave Q empty');
  if (!Array.isArray(input.options) || (input.options.length < 2 && !(historical && input.options.length === 0))) throw new Error('at least two options required');
  const options = input.options.map(o => ({ key: single(o.key, 'option key'), label: safe(single(o.label, 'option label')), consequence: safe(single(o.consequence, 'option consequence')) }));
  if (options.some(o => !/^[a-z]$/.test(o.key)) || new Set(options.map(o => o.key)).size !== options.length) throw new Error('option keys must be unique lowercase letters');
  const recommendation = 'skipped' in input.recommendation
    ? { skipped: true as const, reason: safe(single(input.recommendation.reason, 'skip reason')) }
    : { option: input.recommendation.option, why: safe(single(input.recommendation.why, 'recommendation why')) };
  if ('option' in recommendation && !options.some(o => o.key === recommendation.option)) throw new Error('recommended option not found');
  return { ...input, title, scqa: { s, c, ...(q ? { q } : {}), ...(a ? { a } : {}) }, options, recommendation,
    raisedBy: { agent: safe(single(input.raisedBy.agent, 'agent')), ...(input.raisedBy.track ? { track: input.raisedBy.track } : {}), ...(input.raisedBy.session ? { session: safe(single(input.raisedBy.session, 'session')) } : {}) },
    ...(input.refs ? { refs: input.refs.map(r => safe(single(r, 'ref'))) } : {}) };
}

export class DecisionLedger {
  readonly path: string;
  private readonly lockPath: string;
  private readonly now: () => Date;
  private versionResolver?: (at: string) => Versions;
  private readonly versionOptions: DecisionLedgerOptions;
  constructor(options: DecisionLedgerOptions = {}) {
    this.path = join(options.stateDir ?? elanousStateRoot(), 'decisions', 'decisions.jsonl');
    this.lockPath = `${this.path}.lock`;
    this.now = options.now ?? (() => new Date());
    this.versionOptions = options;
    this.versionResolver = options.resolveVersion;
  }
  private version(at: string): Versions {
    if (!this.versionResolver) {
      const release = getUserConfig().raw.release as { codenames?: Record<string, string> } | undefined;
      this.versionResolver = createVersionResolver({ releaseRoot: this.versionOptions.releaseRoot, repoRoot: this.versionOptions.repoRoot,
        codenames: this.versionOptions.codenames ?? release?.codenames });
    }
    return this.versionResolver(at);
  }
  private locked<T>(fn: () => T): T {
    mkdirSync(join(this.path, '..'), { recursive: true });
    const deadline = Date.now() + 10000;
    let fd: number;
    for (;;) {
      try { fd = openSync(this.lockPath, 'wx', 0o600); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // Only a dead, old owner can be reclaimed; never steal a live process's lock.
        try {
          const pid = Number(readFileSync(this.lockPath, 'utf8'));
          if (Number.isSafeInteger(pid) && pid > 0 && Date.now() - statSync(this.lockPath).mtimeMs > 30000) {
            try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') { unlinkSync(this.lockPath); continue; } }
          }
        } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; }
        if (Date.now() >= deadline) throw new Error('decision ledger lock timeout');
        Bun.sleepSync(20);
      }
    }
    try { writeSync(fd, `${process.pid}`); return fn(); }
    finally { closeSync(fd); unlinkSync(this.lockPath); }
  }
  private events(): Event[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, 'utf8');
    if (text && !text.endsWith('\n')) throw new Error('incomplete decision ledger line');
    return text.split('\n').filter(Boolean).map((line, i) => {
      try { return JSON.parse(line) as Event; }
      catch { throw new Error(`invalid decision ledger event on line ${i + 1}`); }
    });
  }
  private append(event: Event): void { this.appendBatch([event]); }
  private appendBatch(events: Event[]): void {
    const fd = openSync(this.path, 'a', 0o600);
    try {
      const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8');
      const size = fstatSync(fd).size;
      try {
        if (writeSync(fd, bytes) !== bytes.length) throw new Error('short decision ledger write');
      } catch (error) {
        try { ftruncateSync(fd, size); } catch { /* Keep the original write failure. */ }
        throw error;
      }
    } finally { closeSync(fd); }
  }
  list(filters: { status?: 'open' | 'decided' | 'all'; since?: string; version?: string; decidedBy?: 'human' | 'auto'; category?: DecisionCategory } = {}): DecisionEntry[] {
    if (filters.since && !Number.isFinite(Date.parse(filters.since))) throw new Error('invalid since date');
    if (filters.status && !['open', 'decided', 'all'].includes(filters.status)) throw new Error('invalid status');
    if (filters.decidedBy && !['human', 'auto'].includes(filters.decidedBy)) throw new Error('invalid decided-by');
    if (filters.category && !CATEGORIES.includes(filters.category)) throw new Error('invalid category');
    const map = new Map<string, DecisionEntry>();
    for (const event of this.events()) {
      if (event.type === 'raised') {
        if (map.has(event.entry.id)) throw new Error(`duplicate decision: ${event.entry.id}`);
        map.set(event.entry.id, event.entry);
      } else {
        const old = map.get(event.id);
        if (!old || old.status !== 'open') throw new Error(`invalid decision transition: ${event.id}`);
        if (event.type === 'options-added') {
          if (old.options.length || event.options.length < 2) throw new Error(`invalid options transition: ${event.id}`);
          map.set(event.id, { ...old, options: event.options, history: [...old.history, { type: 'options-added', at: event.at, by: event.by }] });
          continue;
        }
        if (event.type === 'decided' && (event.choice ? !old.options.some(option => option.key === event.choice) : old.options.length !== 0 || !old.refs?.length)) throw new Error(`invalid decision option: ${event.id}`);
        if (event.type === 'decided') map.set(event.id, { ...old, status: 'decided', ...(event.at ? { decidedAt: event.at } : {}), decidedBy: event.by, choice: event.choice,
          ...(event.version ? { versionAtDecision: event.version } : {}), ...(event.note ? { note: event.note } : {}),
          history: [...old.history, { type: 'decided', ...(event.at ? { at: event.at } : {}), by: event.by.kind, choice: event.choice, ...(event.version ? { version: event.version } : {}) }] });
        else map.set(event.id, { ...old, status: 'withdrawn', withdrawnAt: event.at, withdrawReason: event.reason,
          history: [...old.history, { type: 'withdrawn', at: event.at, by: 'agent', reason: event.reason, version: event.version }] });
      }
    }
    return [...map.values()].filter(e => (filters.status === 'all' || e.status === (filters.status ?? 'open'))
      && (!filters.since || (e.raisedAt !== undefined && e.raisedAt >= new Date(filters.since).toISOString()))
      && (!filters.version || [e.version?.released, e.version?.dev, e.version?.codename, e.versionAtDecision?.released, e.versionAtDecision?.dev, e.versionAtDecision?.codename].some(v => v === filters.version || v?.startsWith(`${filters.version}-`)))
      && (!filters.decidedBy || e.decidedBy?.kind === filters.decidedBy)
      && (!filters.category || e.category === filters.category)).sort((a, b) => (b.raisedAt ?? b.importedAt ?? '').localeCompare(a.raisedAt ?? a.importedAt ?? '') || a.id.localeCompare(b.id));
  }
  show(id: string): DecisionEntry { const entry = this.list({ status: 'all' }).find(e => e.id === id); if (!entry) throw new Error(`decision not found: ${id}`); return entry; }
  raise(input: RaiseInput): DecisionEntry {
    const clean = validate(input);
    return this.locked(() => {
      const at = utc(clean.raisedAt ?? this.now().toISOString());
      const day = at.slice(0, 10).replaceAll('-', '');
      const prefix = `D-${day}-`;
      let next = 1;
      for (const entry of this.list({ status: 'all' })) {
        if (entry.id.startsWith(prefix)) next = Math.max(next, Number(entry.id.slice(prefix.length)) + 1);
      }
      const id = `${prefix}${String(next).padStart(2, '0')}`;
      const version = this.version(at);
      const entry: DecisionEntry = { ...clean, id, raisedAt: at, version, status: 'open', history: [{ type: 'raised', at, by: clean.raisedBy.agent, version }] };
      this.append({ type: 'raised', entry });
      debug.log('decisions', 'raised', { id, category: entry.category, by: entry.raisedBy.agent });
      return entry;
    });
  }
  decide(id: string, choice: string, by: DecisionActor, note?: string, decidedAt?: string): DecisionEntry {
    if (!by || (by.kind !== 'human' && by.kind !== 'auto')) throw new Error('decidedBy is required');
    if (by.kind === 'auto') {
      single(by.delegation, 'delegation'); single(by.agent, 'agent');
      if (by.track && !TRACKS.includes(by.track)) throw new Error('invalid track');
      by = { ...by, agent: safe(single(by.agent, 'agent')), delegation: safe(single(by.delegation, 'delegation')) };
    }
    return this.locked(() => {
      const old = this.show(id);
      if (old.status !== 'open') throw new Error(`decision already closed: ${id}`);
      if (!old.options.some(o => o.key === choice)) throw new Error(`option not found: ${choice}`);
      const at = utc(decidedAt ?? this.now().toISOString());
      if (old.raisedAt && at < old.raisedAt) throw new Error('decision before raise');
      this.append({ type: 'decided', id, at, by, choice, version: this.version(at), ...(note ? { note: safe(single(note, 'note')) } : {}) });
      debug.log('decisions', 'decided', { id, category: old.category, by: by.kind });
      return this.show(id);
    });
  }
  /** Import an open historical request with known alternatives and an unknown original time. */
  importOpen(input: RaiseInput): DecisionEntry {
    const clean = validate(input);
    if (!clean.refs?.length) throw new Error('historical source reference required');
    return this.locked(() => {
      const existing = this.list({ status: 'all' });
      if (clean.refs?.some(ref => existing.some(e => e.refs?.includes(ref)))) throw new Error('source already imported');
      const importedAt = this.now().toISOString();
      const at = clean.raisedAt ? utc(clean.raisedAt) : undefined;
      const prefix = `D-${(at ?? importedAt).slice(0, 10).replaceAll('-', '')}-`;
      const next = existing.reduce((n, e) => e.id.startsWith(prefix) ? Math.max(n, Number(e.id.slice(prefix.length)) + 1) : n, 1);
      const id = `${prefix}${String(next).padStart(2, '0')}`;
      const version = at ? this.version(at) : undefined;
      const entry: DecisionEntry = { ...clean, id, ...(at ? { raisedAt: at, version } : {}), importedAt, status: 'open',
        history: [{ type: 'raised', ...(at ? { at, version } : {}), by: clean.raisedBy.agent }] };
      this.append({ type: 'raised', entry });
      debug.log('decisions', 'raised', { id, category: entry.category, by: entry.raisedBy.agent });
      return entry;
    });
  }
  /** Import an open historical request whose source contains no alternatives yet. */
  importPending(input: RaiseInput): DecisionEntry {
    if (!input.refs?.length || input.options.length !== 0) throw new Error('historical source without alternatives required');
    const clean = validate(input, true);
    return this.locked(() => {
      const existing = this.list({ status: 'all' });
      if (clean.refs?.some(ref => existing.some(e => e.refs?.includes(ref)))) throw new Error('source already imported');
      const importedAt = this.now().toISOString();
      const at = clean.raisedAt ? utc(clean.raisedAt) : undefined;
      const prefix = `D-${(at ?? importedAt).slice(0, 10).replaceAll('-', '')}-`;
      const next = existing.reduce((n, e) => e.id.startsWith(prefix) ? Math.max(n, Number(e.id.slice(prefix.length)) + 1) : n, 1);
      const id = `${prefix}${String(next).padStart(2, '0')}`;
      const version = at ? this.version(at) : undefined;
      const entry: DecisionEntry = { ...clean, id, ...(at ? { raisedAt: at, version } : {}), importedAt, status: 'open', history: [{ type: 'raised', ...(at ? { at, version } : {}), by: clean.raisedBy.agent }] };
      this.append({ type: 'raised', entry });
      debug.log('decisions', 'raised', { id, category: entry.category, by: entry.raisedBy.agent });
      return entry;
    });
  }
  addOptions(id: string, options: DecisionOption[], agent: string): DecisionEntry {
    if (!Array.isArray(options) || options.length < 2) throw new Error('at least two options required');
    const clean = options.map(o => ({ key: single(o.key, 'option key'), label: safe(single(o.label, 'option label')), consequence: safe(single(o.consequence, 'option consequence')) }));
    if (clean.some(o => !/^[a-z]$/.test(o.key)) || new Set(clean.map(o => o.key)).size !== clean.length) throw new Error('option keys must be unique lowercase letters');
    return this.locked(() => {
      const old = this.show(id);
      if (old.status !== 'open' || old.options.length) throw new Error('options already present or decision closed');
      this.append({ type: 'options-added', id, at: this.now().toISOString(), options: clean, by: safe(single(agent, 'agent')) });
      return this.show(id);
    });
  }
  /** Record a documented decision with unknown time; a failed import leaves no half-raised entry. */
  importRecorded(input: RaiseInput, choice: string | undefined, by: DecisionActor, note: string): DecisionEntry {
    if (!input.refs?.length) throw new Error('historical source reference required');
    const clean = validate(input, true);
    if (choice ? !clean.options.some(o => o.key === choice) : clean.options.length !== 0) throw new Error(`option not found: ${choice}`);
    if (by.kind === 'auto') {
      single(by.agent, 'agent'); single(by.delegation, 'delegation');
      if (by.track && !TRACKS.includes(by.track)) throw new Error('invalid track');
      by = { ...by, agent: safe(single(by.agent, 'agent')), delegation: safe(single(by.delegation, 'delegation')) };
    }
    const cleanNote = safe(single(note, 'note'));
    return this.locked(() => {
      const existing = this.list({ status: 'all' });
      if (clean.refs?.some(ref => existing.some(e => e.refs?.includes(ref)))) throw new Error('source already imported');
      const importedAt = this.now().toISOString();
      const at = clean.raisedAt ? utc(clean.raisedAt) : undefined;
      const prefix = `D-${(at ?? importedAt).slice(0, 10).replaceAll('-', '')}-`;
      const next = existing.reduce((n, e) => e.id.startsWith(prefix) ? Math.max(n, Number(e.id.slice(prefix.length)) + 1) : n, 1);
      const id = `${prefix}${String(next).padStart(2, '0')}`;
      const version = at ? this.version(at) : undefined;
      const entry: DecisionEntry = { ...clean, id, ...(at ? { raisedAt: at, version } : {}), importedAt, status: 'open',
        history: [{ type: 'raised', ...(at ? { at, version } : {}), by: clean.raisedBy.agent }] };
      this.appendBatch([{ type: 'raised', entry }, { type: 'decided', id, by, ...(choice ? { choice } : {}), note: cleanNote }]);
      debug.log('decisions', 'raised', { id, category: entry.category, by: entry.raisedBy.agent });
      debug.log('decisions', 'decided', { id, category: entry.category, by: by.kind });
      return this.show(id);
    });
  }
  /** Resume a partially imported historical item only if its recorded alternatives still match the source. */
  completeRecorded(id: string, choice: string | undefined, by: DecisionActor, note: string, sourceOptions: DecisionOption[]): DecisionEntry {
    if (by.kind === 'auto') {
      single(by.agent, 'agent'); single(by.delegation, 'delegation');
      if (by.track && !TRACKS.includes(by.track)) throw new Error('invalid track');
      by = { ...by, agent: safe(single(by.agent, 'agent')), delegation: safe(single(by.delegation, 'delegation')) };
    }
    const cleanNote = safe(single(note, 'note'));
    return this.locked(() => {
      const entry = this.show(id);
      if (entry.status !== 'open') throw new Error(`decision already closed: ${id}`);
      if (JSON.stringify(entry.options) !== JSON.stringify(sourceOptions)) throw new Error('previously imported options differ from source');
      if (choice ? !entry.options.some(o => o.key === choice) : entry.options.length !== 0) throw new Error(`option not found: ${choice}`);
      this.append({ type: 'decided', id, by, ...(choice ? { choice } : {}), note: cleanNote });
      debug.log('decisions', 'decided', { id, category: entry.category, by: by.kind });
      return this.show(id);
    });
  }
  withdraw(id: string, reason: string): DecisionEntry {
    const clean = safe(single(reason, 'reason'));
    return this.locked(() => {
      const old = this.show(id);
      if (old.status !== 'open') throw new Error(`decision already closed: ${id}`);
      const at = this.now().toISOString();
      this.append({ type: 'withdrawn', id, at, reason: clean, version: this.version(at) });
      debug.log('decisions', 'withdrawn', { id, category: old.category, by: 'agent' });
      return this.show(id);
    });
  }
}

export interface MarkdownImportResult { imported: string[]; existing: string[]; unread: string[]; incomplete: string[] }
// The document is a fixed historical seed, not a general Markdown grammar. Preserve each source reference and report every unparseable numbered row.
export function importDecisionMarkdown(ledger: DecisionLedger, path: string): MarkdownImportResult {
  const source = readFileSync(path, 'utf8');
  // Identify the source by its real file path so relative and absolute spellings of the same document share refs.
  const sourceId = realpathSync(resolve(path));
  const lines = source.split('\n');
  const imported: string[] = [], existing: string[] = [], unread: string[] = [], incomplete: string[] = [];
  const headings = lines.map((line, i) => ({ line, i })).filter(x => /^### (?:\(옛\) )?[ABC]\d+\.|^\| [D][1-5] \||^- \*\*E[1-4] /.test(x.line));
  const seen = new Set<string>();
  for (const { line, i } of headings) {
    const match = /(?:^### (?:\(옛\) )?|^\| |^- \*\*)([A-E]\d+)/.exec(line);
    if (!match) continue;
    const code = match[1]!;
    if (seen.has(code)) continue;
    seen.add(code);
    const ref = `${sourceId}#${code}`;
    const previous = ledger.list({ status: 'all' }).find(e => e.refs?.includes(ref));
    if (previous && (previous.status !== 'open' || !['C4', 'D1', 'D2', 'D3', 'D4', 'D5', 'E1', 'E2', 'E3', 'E4'].includes(code))) {
      existing.push(code);
      if (!previous.options.length) incomplete.push(`${code}: 원문에 선택지 없음; add-options 로 보완 가능`);
      continue;
    }
    const end = lines.findIndex((l, n) => n > i && (/^### |^## |^---$/.test(l) || (code.startsWith('D') && /^\| D\d+ \|/.test(l)) || (code.startsWith('E') && /^- \*\*E\d+ /.test(l))));
    const block = lines.slice(i, end < 0 ? undefined : end).join('\n');
    const oldHeading = !['C4', 'C5'].includes(code) || line.startsWith('### (옛)') ? -1 : lines.findIndex(l => l.startsWith(`### (옛) ${code}.`));
    const oldEnd = oldHeading < 0 ? -1 : lines.findIndex((l, n) => n > oldHeading && (/^### |^## |^---$/.test(l)));
    const optionBlock = oldHeading < 0 ? block : `${block}\n${lines.slice(oldHeading, oldEnd < 0 ? undefined : oldEnd).join('\n')}`;
    try {
      const cells = code.startsWith('D') ? line.split('|').map(s => s.trim()) : [];
      const text = (code.startsWith('D') ? cells[2] : line.replace(/^### (?:\(옛\) )?[ABC]\d+\.\s*|^- \*\*E\d+\s*/, '')).replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim();
      const title = text.split(/[.!?。！？](?:\s|$)/)[0]!.slice(0, 120);
      const context = (code.startsWith('D') ? cells[3] : block.split('\n').slice(1).filter(l => l.startsWith('- ')).map(l => l.replace(/^- \*\*[^*]+\*\*:\s*/, '')).find(Boolean)) ?? text;
      const shortContext = context.replace(/`[^`]+`/g, '관련 경로').split(/[.!?。！？]/)[0]!.slice(0, 220);
      const category: DecisionCategory = /키|토큰|로그인/.test(title) ? 'secret' : /게시|공개|릴리스|티저|npm/.test(title) ? 'publish' : /구매|유료|결제|크레딧/.test(title) ? 'money' : /인가|인증|샌드박스/.test(title) ? 'security' : /범위|0\.2\.7|루프/.test(title) ? 'scope' : 'other';
      const explicitOptions = /\*\*선택지\*\*: ([^\n]+)/.exec(optionBlock)?.[1];
      const choices = explicitOptions ? [...explicitOptions.matchAll(/([ⓐⓑⓒ])\s*([^ⓐⓑⓒ]+)/g)].map((m) => {
        const source = m[2]!.trim();
        const [label, consequence] = source.split(/\s*[—–]\s*/, 2);
        return { key: ({ 'ⓐ': 'a', 'ⓑ': 'b', 'ⓒ': 'c' } as Record<string, string>)[m[1]!]!, label: label!.slice(0, 120), consequence: (consequence ?? '원문에 결과 미기재').slice(0, 240) };
      }) : [];
      if (choices.length === 1) throw new Error('source specifies only one option');
      const options = choices;
      const rec = /\*\*🅢 권고\*\*: ([^\n]+)/.exec(optionBlock)?.[1];
      const recommendedKey = rec && options.find(o => rec.includes(o.key === 'a' ? 'ⓐ' : o.key === 'b' ? 'ⓑ' : 'ⓒ'))?.key;
      const recommendation: Recommendation = rec && recommendedKey
        ? { option: recommendedKey, why: rec.slice(0, 240) }
        : { skipped: true, reason: rec ? `원문 권고(선택지 키 미상): ${rec.slice(0, 180)}` : '원문에 권고가 없음 (가져오면서 생성하지 않음)' };
      const historical = ['C4', ...Array.from({ length: 5 }, (_, n) => `D${n + 1}`), ...Array.from({ length: 4 }, (_, n) => `E${n + 1}`)].includes(code);
      // C and A come from the source text only; a field the source does not state stays «미상» rather than describing the import itself.
      const complicationLine = code.startsWith('D') ? cells[3] : block.split('\n').find(l => /^- \*\*(왜|무엇이 막혀 있나|지금)\*\*/.test(l))?.replace(/^- \*\*[^*]+\*\*:\s*/, '');
      const firstSentence = (value: string) => value.replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim().split(/[.!?。！？](?:\s|$)/)[0]!.slice(0, 220);
      const complication = complicationLine ? firstSentence(complicationLine) : '미상(원문에 따로 적힌 문제 없음)';
      const answer = historical ? firstSentence(text) || '미상(원문에서 결정 문장을 읽지 못함)' : undefined;
      const input: RaiseInput = { title, category, scqa: { s: shortContext, c: complication, ...(answer ? { a: answer } : {}) }, options, recommendation, raisedBy: { agent: 'unknown', track: 'S' }, refs: [ref] };
      if (historical) {
        // Only C4 states both alternatives and a chosen key; D/E record decisions without fabricating options or timestamps.
        const choice = code === 'C4' && /L16\s*→\s*\*\*0\.2\.7 N1\*\*/.test(line) && options.some(o => o.key === 'b' && /0\.2\.7/.test(o.label)) ? 'b' : undefined;
        if (code === 'C4' && !choice) throw new Error('source does not identify a documented option and chosen key');
        const by: DecisionActor = code.startsWith('D') ? { kind: 'auto', agent: 'unknown', track: 'S', delegation: '대표 09-30 01:4x 결정사항 S 에게' } : { kind: 'human' };
        if (previous) { ledger.completeRecorded(previous.id, choice, by, `문서 ${code}: ${text}`, options); existing.push(code); }
        else { ledger.importRecorded(input, choice, by, `문서 ${code}: ${text}`); imported.push(code); }
      } else if (!options.length) { ledger.importPending(input); imported.push(code); }
      else { ledger.importOpen(input); imported.push(code); }
      if (!options.length) incomplete.push(`${code}: 원문에 선택지 없음; ${historical ? '선택 키 미상' : 'add-options 로 보완 후 결정 가능'}`);
    } catch (error) {
      if (error instanceof Error && (error.message === 'source already imported' || (error.message.startsWith('decision already closed:') && previous?.status === 'open'))) {
        const concurrent = ledger.list({ status: 'all' }).find(e => e.refs?.includes(ref));
        if (concurrent && (error.message === 'source already imported' || concurrent.status === 'decided')) {
          existing.push(code);
          if (!concurrent.options.length) incomplete.push(`${code}: 원문에 선택지 없음; add-options 로 보완 가능`);
          continue;
        }
      }
      unread.push(`${code}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const code of ['A1','A2', ...Array.from({ length: 5 }, (_, n) => `B${n+1}`), ...Array.from({ length: 7 }, (_, n) => `C${n+1}`), ...Array.from({ length: 5 }, (_, n) => `D${n+1}`), ...Array.from({ length: 4 }, (_, n) => `E${n+1}`)]) {
    if (!seen.has(code)) unread.push(`${code}: source item not found`);
  }
  return { imported, existing, unread, incomplete };
}
