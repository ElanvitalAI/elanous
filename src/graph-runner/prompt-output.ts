/**
 * GRAPH-LLM-JSON-OUTPUT (0.3.30 P0) — a `prompt:` recipe may declare the JSON its reply must be, e.g.
 * `output: { fields: { verdict: [pass, fail], reason: string }, outcome: verdict, retries: 2 }`. Every field is required
 * (`string` · `number` · `boolean` · an enum list); the `outcome` enum field becomes the node's `outcome` (the key edges
 * read); a miss is retried with what was wrong (0..3, default 1). Pure — the runner wiring is the next slice (hotspot).
 */

export type PromptOutputFieldType = 'string' | 'number' | 'boolean' | readonly string[];

export interface PromptOutputSpec {
  readonly fields: Readonly<Record<string, PromptOutputFieldType>>;
  readonly outcome?: string;
  readonly retries: number;
}

/** 출처: one corrective round usually fixes a miss; more than three only burns tokens on a broken prompt. */
export const PROMPT_OUTPUT_MAX_RETRIES = 3;
export const PROMPT_OUTPUT_DEFAULT_RETRIES = 1;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_FIELDS = 12; // 출처: a routable output is a handful of keys, not a document.
const REASON_CHARS = 200; // the reason fed back to the model and the ledger is one short line

/** Parse the recipe's `output` block. A string is the refusal reason (the recipe is invalid). */
export function parsePromptOutputSpec(raw: unknown): PromptOutputSpec | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'output must be a map';
  const block = raw as Record<string, unknown>;
  if (Object.keys(block).some((key) => !['fields', 'outcome', 'retries'].includes(key))) return 'output allows only fields, outcome, retries';
  const fields = block.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return 'output.fields must be a map';
  const entries = Object.entries(fields as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_FIELDS) return `output.fields needs 1..${MAX_FIELDS} fields`;
  const parsed: Record<string, PromptOutputFieldType> = {};
  for (const [name, type] of entries) {
    if (!FIELD_NAME.test(name)) return `output.fields name is not a lower_snake key: ${name}`;
    if (type === 'string' || type === 'number' || type === 'boolean') parsed[name] = type;
    else if (Array.isArray(type) && type.length > 0 && type.every((item) => typeof item === 'string' && item.length > 0)
      && new Set(type).size === type.length) parsed[name] = [...type];
    else return `output.fields.${name} must be string, number, boolean or a list of distinct strings`;
  }
  let outcome: string | undefined;
  if (block.outcome !== undefined) {
    if (typeof block.outcome !== 'string' || !Object.hasOwn(parsed, block.outcome)) return 'output.outcome must name a declared field';
    if (!Array.isArray(parsed[block.outcome])) return 'output.outcome must be an enum (list) field';
    outcome = block.outcome;
  }
  const retries = block.retries === undefined ? PROMPT_OUTPUT_DEFAULT_RETRIES : block.retries;
  if (typeof retries !== 'number' || !Number.isSafeInteger(retries) || retries < 0 || retries > PROMPT_OUTPUT_MAX_RETRIES) {
    return `output.retries must be an integer 0..${PROMPT_OUTPUT_MAX_RETRIES}`;
  }
  return { fields: parsed, ...(outcome ? { outcome } : {}), retries };
}

const short = (text: string): string => (text.length > REASON_CHARS ? `${text.slice(0, REASON_CHARS - 1)}…` : text);

const SCAN_CHARS = 20_000; // 출처: the routable object is small — scan the reply's tail only,
const MAX_PARSES = 400; //      and give up after a bounded number of parses.

/** The last `{…}` object in the reply (models often wrap JSON in prose or a code fence). */
function lastObject(reply: string): Record<string, unknown> | undefined {
  const text = reply.length > SCAN_CHARS ? reply.slice(-SCAN_CHARS) : reply;
  let parses = 0;
  // lastIndexOf(ch, -1) clamps to index 0 — step past 0 explicitly or a leading brace loops forever.
  const before = (ch: string, from: number): number => (from > 0 ? text.lastIndexOf(ch, from - 1) : -1);
  for (let end = text.lastIndexOf('}'); end >= 0; end = before('}', end)) {
    for (let start = text.lastIndexOf('{', end); start >= 0; start = before('{', start)) {
      if (++parses > MAX_PARSES) return undefined;
      try {
        const value: unknown = JSON.parse(text.slice(start, end + 1));
        if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
      } catch { /* not this span */ }
    }
  }
  return undefined;
}

export type PromptOutputCheck = { readonly ok: true; readonly value: Readonly<Record<string, unknown>> } | { readonly ok: false; readonly reason: string };

/** Does the reply carry exactly the declared fields with the declared types? Extra keys are dropped, not an error. */
export function checkPromptOutput(reply: string, spec: PromptOutputSpec): PromptOutputCheck {
  const object = lastObject(reply);
  if (!object) return { ok: false, reason: 'no JSON object in the reply' };
  const value: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(spec.fields)) {
    if (!Object.hasOwn(object, name)) return { ok: false, reason: `missing field ${name}` };
    const got = object[name];
    const fits = Array.isArray(type) ? typeof got === 'string' && type.includes(got)
      : type === 'number' ? typeof got === 'number' && Number.isFinite(got) : typeof got === type;
    if (!fits) return { ok: false, reason: short(`field ${name} must be ${Array.isArray(type) ? `one of ${type.join('|')}` : type}`) };
    value[name] = got;
  }
  return { ok: true, value };
}

/** The schema line appended to the prompt (and repeated on a retry). */
export function promptOutputInstruction(spec: PromptOutputSpec): string {
  const shape = Object.entries(spec.fields).map(([name, type]) =>
    `"${name}": ${Array.isArray(type) ? type.map((item) => JSON.stringify(item)).join(' | ') : type}`).join(', ');
  return `Reply with only one JSON object: { ${shape} }.`;
}

export interface StructuredPromptResult {
  readonly ok: boolean;
  /** The node's stored output: the declared fields, plus `outcome` when the spec names one. Null when every attempt failed. */
  readonly output: Readonly<Record<string, unknown>> | null;
  readonly attempts: number;
  readonly error?: string;
}

/** Ask, check, and on a miss ask again with what was wrong (at most `retries` more times). */
export async function runStructuredPrompt(prompt: string, spec: PromptOutputSpec, callLLM: (text: string) => Promise<string>): Promise<StructuredPromptResult> {
  const instruction = promptOutputInstruction(spec);
  let text = `${prompt}\n\n${instruction}`;
  let reason = '';
  for (let attempt = 1; attempt <= spec.retries + 1; attempt++) {
    const checked = checkPromptOutput(await callLLM(text), spec);
    if (checked.ok) {
      const output = spec.outcome ? { ...checked.value, outcome: checked.value[spec.outcome] } : checked.value;
      return { ok: true, output, attempts: attempt };
    }
    reason = checked.reason;
    text = `${prompt}\n\nYour previous reply was not usable: ${reason}. ${instruction}`;
  }
  return { ok: false, output: null, attempts: spec.retries + 1, error: `output schema not met after ${spec.retries + 1} attempts: ${reason}` };
}
