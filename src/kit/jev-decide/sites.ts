// KIT jev-decide · site table loader — every Jev call site is a row in graphs/policies/jev-sites.yaml (questions · threshold ·
// timeout · audience · usage site), not a TypeScript constant (JEV-DECIDE-KIT · north star «everything YAML-definable»).
//
// Read order: the built-in `graphs/policies/jev-sites.yaml` ⊕ an optional override `<state>/jev/jev-sites.yaml` (each
// top-level key it names replaces the built-in one). Re-read only when a file changes.
//
// 세 얼굴: 관측 = {@link readJevSites}().source / .problems (the kit logs them with each call's site) · 판단 근거 = the YAML
// (an invalid row or question is dropped with a reason in `problems`) · 수복과 인계 = a broken or missing table has no
// questions: callers fall back to their non-Jev path — Jev never blocks a caller.
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import type { JevQuestion } from '../../decide/jev.js';

/** Who the state belongs to. `member` data leaves the process only to a loopback endpoint (IP literal). */
export type JevAudience = 'hq-seat' | 'member';

export interface JevSite {
  readonly id: string;
  /** The `site` on the `llm.usage` row and on the `jev.decide` log line. */
  readonly usageSite: string;
  readonly audience: JevAudience;
  readonly timeoutMs: number;
  /** The site's decision threshold (its meaning is the site's: top probability, noul extreme, durable minimum …). */
  readonly threshold: number;
  /** Fixed question text. A choice question with no `criteria` is completed by the caller (per-call choices). */
  readonly questions: Readonly<Record<string, JevQuestion | { type: 'choice'; instructions: string }>>;
  /** Site-specific scalar knobs (a mode switch · a second threshold · a cap) — the site's code names and reads them. */
  readonly params: Readonly<Record<string, string | number | boolean>>;
  /** True when the row came from the YAML (false = the defaults row for an unknown site). */
  readonly declared: boolean;
}

export interface JevBreakerPolicy {
  readonly creditCooldownMs: number;
  readonly rateLimitCooldownMs: number;
  readonly cardTo: string;
}

export interface JevSitesTable {
  readonly sites: Readonly<Record<string, JevSite>>;
  readonly defaults: { readonly audience: JevAudience; readonly timeoutMs: number; readonly threshold: number };
  readonly breaker: JevBreakerPolicy;
  readonly source: readonly string[];
  readonly problems: readonly string[];
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const ADDRESS = /^[A-Z][A-Z0-9_-]{0,63}$/u;
const isAudience = (v: unknown): v is JevAudience => v === 'hq-seat' || v === 'member';
const prob = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1 ? v : undefined);
const seconds = (v: unknown, max: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? v * 1000 : undefined);

/** The built-in floor when the YAML names nothing (strict egress · 5 s · 0.9). */
export const EMPTY_JEV_SITES: JevSitesTable = {
  sites: {},
  defaults: { audience: 'member', timeoutMs: 5_000, threshold: 0.9 },
  breaker: { creditCooldownMs: 30 * 60_000, rateLimitCooldownMs: 60_000, cardTo: 'OP' },
  source: [], problems: [],
};

/** One question row → a Jev question, or a reason. Choices may be a list (no descriptions) or a word → description map. */
function questionFrom(raw: unknown, where: string, problems: string[]): JevSite['questions'][string] | null {
  const q = obj(raw);
  const type = q.type;
  const instructions = typeof q.instructions === 'string' ? q.instructions.trim() : '';
  if (type !== 'noul' && type !== 'choice' && type !== 'score') { problems.push(`${where}: type ${String(type)} is not noul/choice/score`); return null; }
  if ('options' in q || 'levels' in q) { problems.push(`${where}: options/levels do not exist — use criteria`); return null; }
  if (!instructions) { problems.push(`${where}: instructions missing`); return null; }
  if (type === 'noul') {
    const c = obj(q.criteria);
    const t = typeof c.true === 'string' ? c.true : undefined;
    const f = typeof c.false === 'string' ? c.false : undefined;
    return { type: 'noul', instructions, ...(t || f ? { criteria: { ...(t ? { true: t } : {}), ...(f ? { false: f } : {}) } } : {}) };
  }
  if (type === 'score') {
    const levels = Array.isArray(q.criteria) ? q.criteria.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
    if (levels.length < 2 || levels.length > 10) { problems.push(`${where}: score needs 2..10 criteria levels`); return null; }
    return { type: 'score', instructions, criteria: levels };
  }
  if (q.criteria === undefined) return { type: 'choice', instructions };
  const entries: Array<[string, string | null]> = Array.isArray(q.criteria)
    ? q.criteria.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((w) => [w.trim(), null])
    : Object.entries(obj(q.criteria)).map(([w, d]) => [w.trim(), typeof d === 'string' && d.trim() ? d.trim() : null]);
  if (entries.length < 2 || entries.length > 255) { problems.push(`${where}: choice needs 2..255 criteria`); return null; }
  return { type: 'choice', instructions, criteria: Object.fromEntries(entries) };
}

/** Parse one table document (already merged). Pure: invalid rows are dropped and named in `problems`. */
export function jevSitesFrom(raw: unknown, source: readonly string[] = []): JevSitesTable {
  const doc = obj(raw);
  const problems: string[] = [];
  if (doc.version !== 1) { problems.push(`version ${String(doc.version)} is not 1 — empty table`); return { ...EMPTY_JEV_SITES, source, problems }; }
  const d = obj(doc.defaults);
  const defaults = {
    audience: isAudience(d.audience) ? d.audience : EMPTY_JEV_SITES.defaults.audience,
    timeoutMs: seconds(d.timeoutSeconds, 120) ?? EMPTY_JEV_SITES.defaults.timeoutMs,
    threshold: prob(d.threshold) ?? EMPTY_JEV_SITES.defaults.threshold,
  };
  const b = obj(doc.breaker);
  const credit = typeof b.creditCooldownMinutes === 'number' && b.creditCooldownMinutes > 0 && b.creditCooldownMinutes <= 24 * 60 ? b.creditCooldownMinutes * 60_000 : undefined;
  const cardTo = typeof b.cardTo === 'string' && ADDRESS.test(b.cardTo.trim().toUpperCase()) ? b.cardTo.trim().toUpperCase() : undefined;
  const breaker: JevBreakerPolicy = {
    creditCooldownMs: credit ?? EMPTY_JEV_SITES.breaker.creditCooldownMs,
    rateLimitCooldownMs: seconds(b.rateLimitCooldownSeconds, 3600) ?? EMPTY_JEV_SITES.breaker.rateLimitCooldownMs,
    cardTo: cardTo ?? EMPTY_JEV_SITES.breaker.cardTo,
  };
  const sites: Record<string, JevSite> = {};
  for (const [id, rowRaw] of Object.entries(obj(doc.sites))) {
    const row = obj(rowRaw);
    const usageSite = typeof row.usageSite === 'string' && row.usageSite.trim() ? row.usageSite.trim() : id;
    if (row.audience !== undefined && !isAudience(row.audience)) problems.push(`sites.${id}: audience ${String(row.audience)} is not hq-seat/member — default used`);
    const questions: Record<string, JevSite['questions'][string]> = {};
    for (const [name, q] of Object.entries(obj(row.questions))) {
      const parsed = questionFrom(q, `sites.${id}.questions.${name}`, problems);
      if (parsed) questions[name] = parsed;
    }
    const params: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(obj(row.params))) {
      if (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) params[k] = v;
      else problems.push(`sites.${id}.params.${k}: not a scalar`);
    }
    sites[id] = {
      id, usageSite, params,
      audience: isAudience(row.audience) ? row.audience : defaults.audience,
      timeoutMs: seconds(row.timeoutSeconds, 120) ?? defaults.timeoutMs,
      threshold: prob(row.threshold) ?? defaults.threshold,
      questions, declared: true,
    };
  }
  return { sites, defaults, breaker, source, problems };
}

export const BUILTIN_JEV_SITES_FILE = join(resolve(import.meta.dir, '../../..'), 'graphs', 'policies', 'jev-sites.yaml');
export function jevSitesOverrideFile(root: string = join(elanousStateRoot(), 'jev')): string {
  return join(root, 'jev-sites.yaml');
}

const mtime = (file: string): number | null => { try { return statSync(file).mtimeMs; } catch { return null; } };
const cache = new Map<string, { stamp: string; table: JevSitesTable }>();

/** The table in force. `files` defaults to [built-in, override]; a file that does not exist is skipped. Never throws. */
export function readJevSites(files?: readonly string[]): JevSitesTable {
  let list: readonly string[];
  try { list = files ?? [BUILTIN_JEV_SITES_FILE, jevSitesOverrideFile()]; } catch { list = [BUILTIN_JEV_SITES_FILE]; }
  const present = list.filter((f) => mtime(f) !== null);
  const stamp = present.map((f) => `${f}@${mtime(f)}`).join('|');
  const key = list.join('|');
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) return hit.table;
  let merged: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const file of present) {
    try { merged = { ...merged, ...obj(parseYaml(readFileSync(file, 'utf8'))) }; }
    catch (error) { problems.push(`${file}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`); }
  }
  if (present.length === 0) problems.push('no jev-sites.yaml found — no site questions');
  const parsed = jevSitesFrom(merged, present);
  const table = problems.length ? { ...parsed, problems: [...problems, ...parsed.problems] } : parsed;
  cache.set(key, { stamp, table });
  return table;
}

/** The row for `id`; an unknown id gets the defaults row (strict egress · no questions · usageSite = id). */
export function jevSite(id: string, table: JevSitesTable = readJevSites()): JevSite {
  return table.sites[id] ?? { id, usageSite: id, audience: table.defaults.audience, timeoutMs: table.defaults.timeoutMs, threshold: table.defaults.threshold, questions: {}, params: {}, declared: false };
}

/** One fixed question of a site, completed with per-call choice criteria when the YAML leaves them to the caller. */
export function jevSiteQuestion(site: JevSite, name: string, criteria?: Readonly<Record<string, string | null>>): JevQuestion | undefined {
  const q = site.questions[name];
  if (!q) return undefined;
  if (q.type === 'choice' && !('criteria' in q && q.criteria)) {
    if (!criteria || Object.keys(criteria).length < 2) return undefined;
    return { type: 'choice', instructions: q.instructions, criteria: { ...criteria } };
  }
  if (q.type === 'choice' && criteria) return { type: 'choice', instructions: q.instructions, criteria: { ...criteria } };
  return q as JevQuestion;
}
