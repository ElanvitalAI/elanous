import { closeSync, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug, redactSecretText } from '../debug/log.js';

/** Closed status ladder plus terminal exits. */
export type RequirementStatus =
  | 'captured'
  | 'placed'
  | 'in-progress'
  | 'landed'
  | 'verified'
  | 'superseded'
  | 'dropped';

export type NfrQuality =
  | 'reliability'
  | 'performance'
  | 'cost'
  | 'security'
  | 'observability'
  | 'operability'
  | 'portability';

export type AdminArea =
  | 'legal'
  | 'ip'
  | 'account'
  | 'billing'
  | 'hardware'
  | 'partner'
  | 'publish'
  | 'people';

export type RequirementKind =
  | 'fr'
  | 'arch'
  | `nfr:${NfrQuality}`
  | `admin:${AdminArea}`;

/** Admin evidence is locations / approval ids only — never raw account or payment text. */
export interface AdminEvidence {
  approvalCardId?: string;
  documentLocation?: string;
  receiptLocation?: string;
}

export type RequirementEvidence = AdminEvidence | Record<string, string>;

export interface RequirementSource {
  kind: string;
  at: string;
  /** Forbidden on admin:* kinds — raw utterance must not enter the ledger. */
  excerpt?: string;
}

export interface RequirementEntry {
  id: string;
  statement: string;
  kind: RequirementKind;
  source: RequirementSource;
  status: RequirementStatus;
  rfc?: string[];
  cells?: string[];
  lives?: string[];
  supersedes?: string;
  owner?: string;
  tags?: string[];
  themes?: string[];
  evidence?: RequirementEvidence;
}

export type CaptureInput = Omit<RequirementEntry, 'id' | 'status'> & {
  id?: string;
  status?: RequirementStatus;
};

export interface RequirementLedgerOptions {
  stateDir?: string;
  now?: () => Date;
}

const ALLOWED_KEYS = new Set([
  'id',
  'statement',
  'kind',
  'source',
  'status',
  'rfc',
  'cells',
  'lives',
  'supersedes',
  'owner',
  'tags',
  'themes',
  'evidence',
]);

const SOURCE_ALLOWED_KEYS = new Set(['kind', 'at', 'excerpt']);

const ADMIN_EVIDENCE_KEYS = new Set(['approvalCardId', 'documentLocation', 'receiptLocation']);

/** Raw account / payment field names that must never be accepted. */
const ACCOUNT_PAYMENT_RAW_KEYS = new Set([
  'account',
  'accountNumber',
  'accountId',
  'username',
  'password',
  'login',
  'credential',
  'credentials',
  'apiKey',
  'api_key',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'payment',
  'paymentMethod',
  'cardNumber',
  'creditCard',
  'cvv',
  'iban',
  'routingNumber',
  'bankAccount',
  'billingAccount',
  'receiptText',
  'receiptBody',
  'rawReceipt',
]);

const NFR_QUALITIES: readonly NfrQuality[] = [
  'reliability',
  'performance',
  'cost',
  'security',
  'observability',
  'operability',
  'portability',
];

const ADMIN_AREAS: readonly AdminArea[] = [
  'legal',
  'ip',
  'account',
  'billing',
  'hardware',
  'partner',
  'publish',
  'people',
];

const STATUSES: readonly RequirementStatus[] = [
  'captured',
  'placed',
  'in-progress',
  'landed',
  'verified',
  'superseded',
  'dropped',
];

const LADDER: readonly RequirementStatus[] = [
  'captured',
  'placed',
  'in-progress',
  'landed',
  'verified',
];

type Event =
  | { type: 'captured'; entry: RequirementEntry }
  | { type: 'transition'; id: string; at: string; status: RequirementStatus; by?: string; note?: string; supersedes?: string };

function required(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function single(value: string, name: string): string {
  const text = required(value, name);
  if (/[\r\n]/.test(text)) throw new Error(`${name} must be one line`);
  return text;
}

function utc(value: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) {
    throw new Error(`UTC timestamp required: ${value}`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new Error(`UTC timestamp required: ${value}`);
  }
  return parsed.toISOString();
}

function assertNoSecret(value: string, name: string): string {
  if (redactSecretText(value) !== value) {
    throw new Error(`secret-shaped value rejected in ${name}`);
  }
  return value;
}

function assertNoSecretDeep(value: unknown, path: string): void {
  if (typeof value === 'string') {
    assertNoSecret(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoSecretDeep(item, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertNoSecretDeep(v, `${path}.${k}`);
    }
  }
}

function isAdminKind(kind: string): kind is `admin:${AdminArea}` {
  return kind.startsWith('admin:') && (ADMIN_AREAS as readonly string[]).includes(kind.slice('admin:'.length));
}

function isNfrKind(kind: string): kind is `nfr:${NfrQuality}` {
  return kind.startsWith('nfr:') && (NFR_QUALITIES as readonly string[]).includes(kind.slice('nfr:'.length));
}

function parseKind(kind: unknown): RequirementKind {
  if (typeof kind !== 'string') throw new Error('kind is required');
  if (kind === 'fr' || kind === 'arch') return kind;
  if (isNfrKind(kind) || isAdminKind(kind)) return kind;
  throw new Error(`invalid kind: ${kind}`);
}

function rejectAccountPaymentKeys(obj: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(obj)) {
    if (ACCOUNT_PAYMENT_RAW_KEYS.has(key)) {
      throw new Error(`account/payment raw-text field rejected: ${path}.${key}`);
    }
  }
}

function validateSource(source: unknown, kind: RequirementKind): RequirementSource {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('source is required');
  const raw = source as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!SOURCE_ALLOWED_KEYS.has(key)) throw new Error(`disallowed source key: ${key}`);
  }
  rejectAccountPaymentKeys(raw, 'source');
  if (isAdminKind(kind) && raw.excerpt !== undefined) {
    throw new Error('admin source.excerpt is forbidden');
  }
  const sourceKind = single(String(raw.kind ?? ''), 'source.kind');
  const at = utc(String(raw.at ?? ''));
  assertNoSecret(sourceKind, 'source.kind');
  const out: RequirementSource = { kind: sourceKind, at };
  if (raw.excerpt !== undefined) {
    out.excerpt = assertNoSecret(single(String(raw.excerpt), 'source.excerpt'), 'source.excerpt');
  }
  return out;
}

function validateEvidence(evidence: unknown, kind: RequirementKind): RequirementEvidence | undefined {
  if (evidence === undefined) return undefined;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('evidence must be an object');
  }
  const raw = evidence as Record<string, unknown>;
  rejectAccountPaymentKeys(raw, 'evidence');
  if (isAdminKind(kind)) {
    for (const key of Object.keys(raw)) {
      if (!ADMIN_EVIDENCE_KEYS.has(key)) {
        throw new Error(`admin evidence allows only approvalCardId, documentLocation, receiptLocation; got ${key}`);
      }
    }
    const out: AdminEvidence = {};
    for (const key of ADMIN_EVIDENCE_KEYS) {
      if (raw[key] === undefined) continue;
      out[key as keyof AdminEvidence] = assertNoSecret(single(String(raw[key]), `evidence.${key}`), `evidence.${key}`);
    }
    return out;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') throw new Error(`evidence.${key} must be a string`);
    out[key] = assertNoSecret(single(value, `evidence.${key}`), `evidence.${key}`);
  }
  return out;
}

function validateCapture(input: CaptureInput): RequirementEntry {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('capture input required');
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) throw new Error(`disallowed key: ${key}`);
  }
  rejectAccountPaymentKeys(raw, 'root');

  const kind = parseKind(raw.kind);
  const statement = assertNoSecret(single(String(raw.statement ?? ''), 'statement'), 'statement');
  const source = validateSource(raw.source, kind);
  const status: RequirementStatus = raw.status === undefined ? 'captured' : (raw.status as RequirementStatus);
  if (!(STATUSES as readonly string[]).includes(status)) throw new Error(`invalid status: ${status}`);
  if (status !== 'captured') throw new Error('capture must start as captured');

  const entry: RequirementEntry = {
    id: raw.id === undefined ? '' : assertNoSecret(single(String(raw.id), 'id'), 'id'),
    statement,
    kind,
    source,
    status,
  };

  if (raw.rfc !== undefined) {
    if (!Array.isArray(raw.rfc)) throw new Error('rfc must be a list');
    entry.rfc = raw.rfc.map((item, i) => assertNoSecret(single(String(item), `rfc[${i}]`), `rfc[${i}]`));
  }
  if (raw.cells !== undefined) {
    if (!Array.isArray(raw.cells)) throw new Error('cells must be a list');
    entry.cells = raw.cells.map((item, i) => assertNoSecret(single(String(item), `cells[${i}]`), `cells[${i}]`));
  }
  if (raw.lives !== undefined) {
    if (!Array.isArray(raw.lives)) throw new Error('lives must be a list');
    entry.lives = raw.lives.map((item, i) => assertNoSecret(single(String(item), `lives[${i}]`), `lives[${i}]`));
  }
  if (raw.supersedes !== undefined) {
    entry.supersedes = assertNoSecret(single(String(raw.supersedes), 'supersedes'), 'supersedes');
  }
  if (raw.owner !== undefined) {
    entry.owner = assertNoSecret(single(String(raw.owner), 'owner'), 'owner');
  }
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags)) throw new Error('tags must be a list');
    entry.tags = raw.tags.map((item, i) => assertNoSecret(single(String(item), `tags[${i}]`), `tags[${i}]`));
  }
  if (raw.themes !== undefined) {
    if (!Array.isArray(raw.themes)) throw new Error('themes must be a list');
    entry.themes = raw.themes.map((item, i) => assertNoSecret(single(String(item), `themes[${i}]`), `themes[${i}]`));
  }
  const evidence = validateEvidence(raw.evidence, kind);
  if (evidence !== undefined) entry.evidence = evidence;

  assertNoSecretDeep(entry, 'entry');
  return entry;
}

function canTransition(from: RequirementStatus, to: RequirementStatus): boolean {
  if (from === to) return false;
  if (to === 'superseded' || to === 'dropped') {
    return from !== 'superseded' && from !== 'dropped' && from !== 'verified';
  }
  const fromIdx = LADDER.indexOf(from as typeof LADDER[number]);
  const toIdx = LADDER.indexOf(to as typeof LADDER[number]);
  if (fromIdx < 0 || toIdx < 0) return false;
  return toIdx === fromIdx + 1;
}

export class RequirementLedger {
  readonly path: string;
  private readonly lockPath: string;
  private readonly now: () => Date;
  private readonly stateDir: string;

  constructor(options: RequirementLedgerOptions = {}) {
    this.stateDir = options.stateDir ?? elanousStateRoot();
    this.path = join(this.stateDir, 'requirements', 'requirements.jsonl');
    this.lockPath = `${this.path}.lock`;
    this.now = options.now ?? (() => new Date());
  }

  private locked<T>(fn: () => T): T {
    mkdirSync(join(this.path, '..'), { recursive: true });
    const deadline = Date.now() + 10000;
    let fd: number;
    for (;;) {
      try {
        fd = openSync(this.lockPath, 'wx', 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const pid = Number(readFileSync(this.lockPath, 'utf8'));
          if (Number.isSafeInteger(pid) && pid > 0 && Date.now() - statSync(this.lockPath).mtimeMs > 30000) {
            try {
              process.kill(pid, 0);
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
                unlinkSync(this.lockPath);
                continue;
              }
            }
          }
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        }
        if (Date.now() >= deadline) throw new Error('requirement ledger lock timeout');
        Bun.sleepSync(20);
      }
    }
    try {
      writeSync(fd, `${process.pid}`);
      return fn();
    } finally {
      closeSync(fd);
      unlinkSync(this.lockPath);
    }
  }

  private events(): Event[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, 'utf8');
    if (text && !text.endsWith('\n')) throw new Error('incomplete requirement ledger line');
    return text.split('\n').filter(Boolean).map((line, i) => {
      try {
        return JSON.parse(line) as Event;
      } catch {
        throw new Error(`invalid requirement ledger event on line ${i + 1}`);
      }
    });
  }

  private append(event: Event): void {
    const fd = openSync(this.path, 'a', 0o600);
    try {
      const bytes = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
      const size = fstatSync(fd).size;
      try {
        if (writeSync(fd, bytes) !== bytes.length) throw new Error('short requirement ledger write');
      } catch (error) {
        try {
          ftruncateSync(fd, size);
        } catch {
          /* Keep the original write failure. */
        }
        throw error;
      }
    } finally {
      closeSync(fd);
    }
  }

  private materialize(): Map<string, RequirementEntry> {
    const map = new Map<string, RequirementEntry>();
    for (const event of this.events()) {
      if (event.type === 'captured') {
        if (map.has(event.entry.id)) throw new Error(`duplicate requirement: ${event.entry.id}`);
        map.set(event.entry.id, { ...event.entry });
        continue;
      }
      const old = map.get(event.id);
      if (!old) throw new Error(`unknown requirement: ${event.id}`);
      if (!canTransition(old.status, event.status)) {
        throw new Error(`invalid requirement transition: ${old.status} → ${event.status}`);
      }
      map.set(event.id, {
        ...old,
        status: event.status,
        ...(event.supersedes ? { supersedes: event.supersedes } : {}),
      });
    }
    return map;
  }

  private nextId(at: string): string {
    const day = at.slice(2, 10).replaceAll('-', '');
    const prefix = `req-${day}-`;
    let next = 1;
    for (const entry of this.materialize().values()) {
      if (entry.id.startsWith(prefix)) {
        const n = Number(entry.id.slice(prefix.length));
        if (Number.isSafeInteger(n)) next = Math.max(next, n + 1);
      }
    }
    return `${prefix}${next}`;
  }

  list(filters: { status?: RequirementStatus | 'all'; kind?: RequirementKind } = {}): RequirementEntry[] {
    return [...this.materialize().values()]
      .filter(entry => (filters.status === undefined || filters.status === 'all' || entry.status === filters.status)
        && (filters.kind === undefined || entry.kind === filters.kind))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  show(id: string): RequirementEntry {
    const entry = this.materialize().get(id);
    if (!entry) throw new Error(`requirement not found: ${id}`);
    return entry;
  }

  /** Open a requirement at `captured`. Validates allowlist + secret rejection before any disk write. */
  capture(input: CaptureInput): RequirementEntry {
    const clean = validateCapture(input);
    return this.locked(() => {
      const at = utc(clean.source.at || this.now().toISOString());
      const id = clean.id || this.nextId(at);
      if (this.materialize().has(id)) throw new Error(`duplicate requirement: ${id}`);
      const entry: RequirementEntry = { ...clean, id, status: 'captured', source: { ...clean.source, at } };
      assertNoSecretDeep(entry, 'entry');
      this.append({ type: 'captured', entry });
      debug.log('requirements.ledger', 'captured', { id: entry.id, kind: entry.kind, status: entry.status });
      return entry;
    });
  }

  /** Advance along captured→placed→in-progress→landed→verified, or exit via superseded/dropped. */
  transition(id: string, status: RequirementStatus, opts: { by?: string; note?: string; supersedes?: string; at?: string } = {}): RequirementEntry {
    if (!(STATUSES as readonly string[]).includes(status)) throw new Error(`invalid status: ${status}`);
    if (opts.by !== undefined) assertNoSecret(single(opts.by, 'by'), 'by');
    if (opts.note !== undefined) assertNoSecret(single(opts.note, 'note'), 'note');
    if (opts.supersedes !== undefined) assertNoSecret(single(opts.supersedes, 'supersedes'), 'supersedes');
    return this.locked(() => {
      const old = this.show(id);
      if (!canTransition(old.status, status)) {
        throw new Error(`invalid requirement transition: ${old.status} → ${status}`);
      }
      const at = utc(opts.at ?? this.now().toISOString());
      this.append({
        type: 'transition',
        id,
        at,
        status,
        ...(opts.by ? { by: opts.by } : {}),
        ...(opts.note ? { note: opts.note } : {}),
        ...(opts.supersedes ? { supersedes: opts.supersedes } : {}),
      });
      debug.log('requirements.ledger', 'transition', { id, from: old.status, to: status });
      return this.show(id);
    });
  }

  /** Convenience: captured → placed (optionally attaching rfc/cells if provided on a fresh capture). */
  place(id: string, opts: { by?: string; note?: string; at?: string } = {}): RequirementEntry {
    return this.transition(id, 'placed', opts);
  }
}
