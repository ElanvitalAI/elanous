const SECRET_FIELD = /token|secret|password|authorization|key/i;
const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SECRET_VALUE = /(?:\b(?:bearer|basic)\s+\S+|\b(?:token|secret|password|authorization|api[-_]?key|access[-_]?key|private[-_]?key)\b\s*(?:is|[=:])\s*["']?\S+|\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}))\b/i;
const MAX_FIELDS = 32;
// Review R2: only lifecycle events the host needs to see, and no free text. Event names must start with a known
// lifecycle prefix; string fields survive only when they are short code-like values in a fixed set of keys.
const EVENT_ALLOWED = /^(?:gate|gated|review|reviewed|repair|repaired|rework|merge|merged|pr|land|landed|stage|round|supervisor|child|plan|planned|decompose|decomposed|shard|stall|harvest|decision|run|pipeline|progress|human|start|started|finish|finished|done|implement|implemented|commit|test|typecheck)(?:-(?:started|finished|round|opened|closed|failed|passed|blocked|done|entry|node|outcome|delivery|decision|stop|merged|ready|requested|resolved|result|fix|must-fix|verdict|skipped|origin|cleared))*$/;
const CODE_FIELDS = new Set(['stage', 'outcome', 'verdict', 'status', 'kind', 'phase', 'role', 'result']);
const CODE_VALUE = /^[a-z0-9_.:-]{1,40}$/i;

function secretValues(root: Record<string, unknown>): string[] {
  const secrets: string[] = [];
  const pending: unknown[] = [root];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [name, value] of Object.entries(current)) {
      if (SECRET_FIELD.test(name) && typeof value === 'string' && value.length >= 3) secrets.push(value);
      if (value && typeof value === 'object') pending.push(value);
    }
  }
  return secrets;
}

/** Project bounded ledger metadata, excluding named secrets and recognizable credential values. */
export function ledgerLineToLogEvent(line: string, runId: string): {
  category: string;
  event: string;
  data: Record<string, unknown>;
} | undefined {
  let entry: unknown;
  try { entry = JSON.parse(line); } catch { return undefined; }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !('event' in entry) || typeof entry.event !== 'string') return undefined;
  // The real run-ledger writer wraps observer fields in `data`; older/synthetic lines can be flat.
  const details = 'data' in entry && entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)
    ? entry.data as Record<string, unknown> : undefined;
  const sources = [entry, details].filter((source): source is Record<string, unknown> => source !== undefined);
  const knownSecrets = secretValues(entry);
  const containsCredential = (value: string) => SECRET_VALUE.test(value) || knownSecrets.some((secret) => value.includes(secret));
  if (containsCredential(entry.event) || !EVENT_ALLOWED.test(entry.event)) return undefined;

  const data: Record<string, unknown> = { runId };
  let fields = 0;
  for (const source of sources) {
    for (const [name, value] of Object.entries(source)) {
      if (name === 'event' || name === 'runId' || name === 'data' || !SAFE_FIELD.test(name) || SECRET_FIELD.test(name)) continue;
      if (fields >= MAX_FIELDS) break;
      const countName = `${name}Count`;
      const outputName = Array.isArray(value) || value && typeof value === 'object' ? countName : name;
      if (!SAFE_FIELD.test(outputName) || SECRET_FIELD.test(outputName) || Object.hasOwn(data, outputName)) continue;
      if (typeof value === 'string') {
        // Free text (reasons, messages, patches) never leaves the pod ledger; only short code values in known keys.
        if (!CODE_FIELDS.has(name) || !CODE_VALUE.test(value) || containsCredential(value)) continue;
        data[name] = value;
      } else if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' || value === null) {
        data[name] = value;
      } else if (Array.isArray(value) || value && typeof value === 'object') {
        data[countName] = Array.isArray(value) ? value.length : Object.keys(value).length;
      } else continue;
      fields += 1;
    }
  }
  return { category: 'self-implement.pod.ledger', event: entry.event, data };
}
