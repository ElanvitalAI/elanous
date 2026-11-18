/** 1121 RESEARCH-ROUTING — research entry is decided by structured fields on the question-plan call we already make,
 * not by sentence classifiers. Default = ENTER; only the plan's `localOnly: true` (or one obvious-local pre-filter)
 * skips. Missing fields, a parse failure or a plan failure enter (a missed grounding costs far more than a few seconds).
 * Design: seat-state/OP/RETHINK-RESEARCH-ROUTING-1117.md (대표 11-17 Bloom 4·5). */
import { debug } from '../debug/log.js';

/** Event names this module emits (category `research`). Registered here so `elanous logs --event` callers can import them. */
export const RESEARCH_ROUTE_CATEGORY = 'research';
export const RESEARCH_ROUTE_EVENT = 'route';
export const RESEARCH_ROUTE_MISMATCH_EVENT = 'route-mismatch';
export const RESEARCH_ROUTE_EVENTS = [RESEARCH_ROUTE_EVENT, RESEARCH_ROUTE_MISMATCH_EVENT] as const;

/** Tools that give a turn a web-grounding path; a turn whose pool has none is outside the structured route. */
export const RESEARCH_ROUTE_WEB_TOOLS: ReadonlySet<string> = new Set(['WebSearch', 'OmniSearch', 'WebFetch']);

/** Structured routing fields the question-plan call returns as its FIRST top-level field `route`. */
export interface ResearchRouteFields {
  needsFreshFacts?: boolean;
  needsCitations?: boolean;
  localOnly?: boolean;
  /** Model-written; never logged (may echo the user's words). Only its presence is observed. */
  reason?: string;
}

export type ResearchRouteDecision = {
  decision: 'entered' | 'skipped';
  by: 'structured' | 'fallback' | 'prefilter';
  /** A fixed code, never user or model text. */
  reason: ResearchRouteReason;
};

export type ResearchRouteReason =
  | 'local-only' | 'fresh-facts' | 'citations' | 'not-local'
  | 'route-missing' | 'local-only-missing' | 'plan-failed' | 'budget'
  | ObviousLocalCommand | 'route-pin-forced';

/** Keep only well-typed fields; anything else is treated as absent (→ ENTER). */
export function parseResearchRouteFields(value: unknown): ResearchRouteFields | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const fields: ResearchRouteFields = {};
  for (const key of ['needsFreshFacts', 'needsCitations', 'localOnly'] as const) {
    if (typeof record[key] === 'boolean') fields[key] = record[key] as boolean;
  }
  if (typeof record.reason === 'string' && record.reason.trim()) fields.reason = record.reason.trim().slice(0, 200);
  return Object.keys(fields).length > 0 ? fields : undefined;
}

/** Read the TOP-LEVEL `"route": {…}` object out of a still-streaming plan JSON as soon as it closes, so the verdict does
 * not wait for the rest of the plan (outputContract · questions). A `route` key nested anywhere else never counts.
 * Returns undefined until the object is complete. */
export function extractStreamedRouteFields(streamed: string): ResearchRouteFields | undefined {
  const start = topLevelValueStart(streamed, 'route');
  if (start === undefined || streamed[start] !== '{') return undefined;
  const closed = closedStreamedObject(streamed, start);
  if (closed === undefined) return undefined;
  try { return parseResearchRouteFields(JSON.parse(closed)); }
  catch { return undefined; }
}

/** GROUNDING-FIRST-ANSWER-30S (review r2 · duplicate keys) — the plan's ROOT object once it has CLOSED in the stream, with
 * its top-level keys in stream order (duplicates kept). JSON.parse keeps the LAST duplicate while a streamed reader sees
 * the FIRST, so only a closed root — no further key can arrive — with each decisive key exactly once is safe to act on.
 * Undefined while the root is still open. */
export function closedStreamedPlanRoot(streamed: string): { root: Record<string, unknown>; keys: string[] } | undefined {
  const start = streamed.indexOf('{');
  if (start < 0) return undefined;
  const text = closedStreamedObject(streamed, start);
  if (text === undefined) return undefined;
  let root: unknown;
  try { root = JSON.parse(text); } catch { return undefined; }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return undefined;
  return { root: root as Record<string, unknown>, keys: topLevelKeys(text) };
}

/** Top-level keys of a JSON object text in order, duplicates kept. String-aware; nested keys are skipped. */
export function topLevelKeys(objectText: string): string[] {
  const keys: string[] = [];
  const root = objectText.indexOf('{');
  if (root < 0) return keys;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  for (let index = root; index < objectText.length; index++) {
    const char = objectText[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        inString = false;
        if (depth !== 1) continue;
        let next = index + 1;
        while (next < objectText.length && /\s/u.test(objectText[next]!)) next++;
        if (objectText[next] !== ':') continue;
        try { keys.push(JSON.parse(objectText.slice(stringStart, index + 1)) as string); } catch { /* not a key */ }
      }
      continue;
    }
    if (char === '"') { inString = true; stringStart = index; }
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') { if (--depth === 0) break; }
  }
  return keys;
}

/** Index of the first non-space character of `key`'s value in the plan's ROOT object (depth 1), or undefined while that
 * key has not streamed yet. String-aware; keys of nested objects/arrays are skipped. */
function topLevelValueStart(streamed: string, key: string): number | undefined {
  const root = streamed.indexOf('{');
  if (root < 0) return undefined;
  const wanted = JSON.stringify(key);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  for (let index = root; index < streamed.length; index++) {
    const char = streamed[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        inString = false;
        if (depth === 1 && streamed.slice(stringStart, index + 1) === wanted) {
          let next = index + 1;
          while (next < streamed.length && /\s/u.test(streamed[next]!)) next++;
          // Only a key is followed by `:` (a value is followed by `,` or `}`).
          if (streamed[next] !== ':') continue;
          next++;
          while (next < streamed.length && /\s/u.test(streamed[next]!)) next++;
          return next < streamed.length ? next : undefined;
        }
      }
      continue;
    }
    if (char === '"') { inString = true; stringStart = index; }
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
  }
  return undefined;
}

/** The JSON object text that opens at `start` (a `{`), or undefined while it has not closed yet. String-aware. */
function closedStreamedObject(streamed: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < streamed.length; index++) {
    const char = streamed[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return streamed.slice(start, index + 1);
  }
  return undefined;
}

/** Structured verdict → decision. Only an explicit `localOnly: true` skips; everything else enters — on a turn whose
 * entry is already CONFIRMED (the caller's fast path). On an unconfirmed default entry use `settleUnconfirmedRoute`. */
export function decideResearchRoute(fields: ResearchRouteFields | undefined, missingReason: 'route-missing' | 'plan-failed' | 'budget' = 'route-missing'): ResearchRouteDecision {
  if (!fields) return { decision: 'entered', by: 'fallback', reason: missingReason };
  if (fields.localOnly === true) return { decision: 'skipped', by: 'structured', reason: 'local-only' };
  if (fields.localOnly !== false) return { decision: 'entered', by: 'fallback', reason: 'local-only-missing' };
  return {
    decision: 'entered', by: 'structured',
    reason: fields.needsFreshFacts === true ? 'fresh-facts' : fields.needsCitations === true ? 'citations' : 'not-local',
  };
}

/** OP decision after review r3 (#38087): «failure = enter» holds only once entry is CONFIRMED (a structured route that
 * says entered, or the caller's fast path). On an unconfirmed default entry a missing route, a plan failure or a blown
 * budget is a SKIP (by fallback): the turn re-enters as main's ordinary turn instead of ending in GROUNDING_UNAVAILABLE. */
export function settleUnconfirmedRoute(route: ResearchRouteDecision, requireConfirmedRoute: boolean): ResearchRouteDecision {
  if (!requireConfirmedRoute || route.decision !== 'entered') return route;
  // 🔴 1121 ROUTE-PRIVACY (RES OP82528): entry is confirmed only by an explicit `localOnly: false` WITH a need for fresh
  // facts or citations — the same single gate research-turn applies to every external search. A `not-local` route
  // (neither need) is not a confirmation: the turn re-enters as the ordinary turn, with zero external search.
  if (route.by === 'structured' && route.reason !== 'not-local') return route;
  return { decision: 'skipped', by: route.by, reason: route.reason };
}

/** Minimum verbatim run (normalized chars) of the user's own text that marks a search term as carrying raw user text. */
export const RAW_USER_TEXT_RUN_CHARS = 24;

/** True when `term` carries a verbatim run (≥ RAW_USER_TEXT_RUN_CHARS normalized chars) of the user's text — such a term
 * would send pasted logs/code/config to an external search provider. Short shared words (entity names) are fine. */
export function carriesRawUserText(term: string, userText: string): boolean {
  const norm = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const haystack = norm(term);
  const source = norm(userText);
  if (!haystack || !source) return false;
  if (haystack === source) return true;
  const run = Math.min(RAW_USER_TEXT_RUN_CHARS, source.length);
  if (haystack.length < run) return false;
  for (let index = 0; index + run <= source.length; index++) {
    if (haystack.includes(source.slice(index, index + run))) return true;
  }
  return false;
}

export type ObviousLocalCommand = 'slash-command' | 'shell-line' | 'file-path-edit';

const SLASH_COMMAND = /^\s*\/[A-Za-z][\w:-]*(?=\s|$)/u;
const SHELL_LINE = /^\s*!\S/u;
const URL_TOKEN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/giu;
/** A relative or absolute path with at least one directory and a source/config extension (documents are excluded: a
 * research answer may be asked to be written to a .md/.docx). */
const CODE_FILE_PATH = /(?:^|[\s"'`(])(?:~|\.{1,2})?\/?(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|c|cc|cpp|h|hpp|cs|sh|zsh|bash|sql|json|ya?ml|toml|css|scss|vue|svelte)(?=$|[\s"'`),:;])/iu;
const EDIT_REQUEST = /(?:고쳐|수정|바꿔|편집|리팩터|지워|삭제해|추가해|\b(?:edit|fix|change|modify|refactor|rename|delete|remove|patch|update)\b)/iu;

/** The ONE pre-filter: an obvious local command. It may only SKIP research — never block it any other way, never a
 * reason to refuse grounding for a fact question. Patterns (exhaustive): a leading slash command (`/name`), a leading
 * `!` shell line, and a source-file path (dir/…/file.<code ext>, URLs excluded) inside an edit request. */
export function obviousLocalCommand(text: string | undefined): ObviousLocalCommand | undefined {
  if (!text?.trim()) return undefined;
  if (SLASH_COMMAND.test(text)) return 'slash-command';
  if (SHELL_LINE.test(text)) return 'shell-line';
  const withoutUrls = text.replace(URL_TOKEN, ' ');
  if (CODE_FILE_PATH.test(withoutUrls) && EDIT_REQUEST.test(withoutUrls)) return 'file-path-edit';
  return undefined;
}

/** `research.route` on every eligible turn — the «event 0» of RES 11-17 cases 2·5 becomes a decision on record. */
export function logResearchRoute(sessionId: string | undefined, route: ResearchRouteDecision, extra: { hasModelReason?: boolean } = {}): void {
  debug.log(RESEARCH_ROUTE_CATEGORY, RESEARCH_ROUTE_EVENT, {
    ...(sessionId ? { sessionId } : {}),
    route: route.decision, by: route.by, reason: route.reason,
    ...(extra.hasModelReason !== undefined ? { hasModelReason: extra.hasModelReason } : {}),
  });
}

/** Shadow comparison until 11-24: the legacy sentence classifiers no longer decide; when they would have decided
 * differently from the structured verdict, record it (codes only, no text) for the 11-24 mismatch-rate report. */
export function logResearchRouteMismatch(
  sessionId: string | undefined,
  structured: ResearchRouteDecision,
  heuristicEnters: boolean,
): boolean {
  if (structured.by !== 'structured') return false;
  const heuristic = heuristicEnters ? 'entered' : 'skipped';
  if (heuristic === structured.decision) return false;
  debug.log(RESEARCH_ROUTE_CATEGORY, RESEARCH_ROUTE_MISMATCH_EVENT, {
    ...(sessionId ? { sessionId } : {}),
    structured: structured.decision, heuristic, reason: structured.reason,
  });
  return true;
}
