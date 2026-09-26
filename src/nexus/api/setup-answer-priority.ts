import { readFileSync, writeFileSync } from 'node:fs';
import { debug } from '../../debug/log.js';
import { ANSWER_PRIORITY_CHOICES, type AnswerPriority } from '../../onboarding.js';
import { getUserConfig, reloadUserConfig, userConfigPath } from '../../user-config.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
  });
}

// Locate a direct JSON member without reserializing its siblings. Values may contain
// escaped quotes, nested objects and arrays; the scan never treats their keys as siblings.
function scanValue(text: string, start: number): number {
  const first = text[start];
  if (first === '"') {
    let escaped = false;
    for (let i = start + 1; i < text.length; i++) {
      if (!escaped && text[i] === '"') return i + 1;
      if (!escaped && text[i] === '\\') escaped = true;
      else escaped = false;
    }
  } else if (first === '{' || first === '[') {
    const close = first === '{' ? '}' : ']';
    let pos = start + 1;
    while (pos < text.length) {
      pos = skipSpace(text, pos);
      if (text[pos] === close) return pos + 1;
      if (text[pos] === ',' || text[pos] === ':') { pos++; continue; }
      pos = scanValue(text, pos);
    }
  } else {
    let pos = start;
    while (pos < text.length && !/[\s,}\]]/.test(text[pos]!)) pos++;
    return pos;
  }
  throw new Error('invalid config JSON');
}

function skipSpace(text: string, pos: number): number {
  while (/\s/.test(text[pos] ?? '')) pos++;
  return pos;
}

class DuplicateConfigKeyError extends Error {}

function member(text: string, start: number, name: string): { start: number; end: number } | null {
  let pos = start + 1;
  let found: { start: number; end: number } | null = null;
  while (true) {
    pos = skipSpace(text, pos);
    if (text[pos] === '}') return found;
    const keyEnd = scanValue(text, pos);
    const key = JSON.parse(text.slice(pos, keyEnd)) as string;
    const colon = skipSpace(text, keyEnd);
    if (text[colon] !== ':') throw new Error('invalid config JSON');
    const valueStart = skipSpace(text, colon + 1);
    const valueEnd = scanValue(text, valueStart);
    if (key === name) {
      if (found) throw new DuplicateConfigKeyError(`duplicate config key: ${name}`);
      found = { start: valueStart, end: valueEnd };
    }
    pos = skipSpace(text, valueEnd);
    if (text[pos] === ',') pos++;
  }
}

function insertMember(text: string, start: number, key: string, value: string): string {
  const end = scanValue(text, start) - 1;
  const hasMembers = skipSpace(text, start + 1) < end;
  return text.slice(0, end) + `${hasMembers ? ',' : ''}${JSON.stringify(key)}:${value}` + text.slice(end);
}

/** Change only the JSON span of llm.answerPriority; preserve all other bytes. */
function writeAnswerPriority(value: AnswerPriority): void {
  const path = userConfigPath();
  let source: string;
  try { source = readFileSync(path, 'utf8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    source = '{}\n';
  }
  const parsed = JSON.parse(source) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config JSON must be an object');
  const root = skipSpace(source, 0);
  const llm = member(source, root, 'llm');
  const next = !llm
    ? insertMember(source, root, 'llm', JSON.stringify({ answerPriority: value }))
    : (() => {
      const current = (parsed as { llm?: unknown }).llm;
      if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('config llm must be an object');
      const answer = member(source, llm.start, 'answerPriority');
      return answer
        ? source.slice(0, answer.start) + JSON.stringify(value) + source.slice(answer.end)
        : insertMember(source, llm.start, 'answerPriority', JSON.stringify(value));
    })();
  writeFileSync(path, next, 'utf8');
}

/** GET /v1/setup/answer-priority */
export function handleAnswerPriorityGet(): Response {
  const value = getUserConfig().llm.answerPriority ?? null;
  return json({ value, effective: value ?? 'balanced', choices: ANSWER_PRIORITY_CHOICES.map(({ value, label, description }) => ({ value, label, description })) });
}

/** POST /v1/setup/answer-priority */
export async function handleAnswerPrioritySet(req: Request): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); }
  catch { return json({ error: 'invalid-json', reason: '본문이 JSON 객체가 아니다' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'invalid-body', reason: '본문은 { value } 객체여야 한다' }, 400);
  }
  const fields = Object.keys(body).filter((key) => key !== 'value');
  if (fields.length) return json({ error: 'unknown-fields', reason: `알 수 없는 칸: ${fields.join(', ')}`, fields }, 400);
  const raw = (body as { value?: unknown }).value;
  const choice = ANSWER_PRIORITY_CHOICES.find((item) => item.value === raw);
  if (!choice) return json({ error: 'invalid-answer-priority', reason: '허용되지 않은 답변 깊이' }, 400);
  try { writeAnswerPriority(choice.value); }
  catch (error) {
    if (error instanceof DuplicateConfigKeyError) {
      return json({ error: 'duplicate-config-key', reason: error.message }, 400);
    }
    throw error;
  }
  reloadUserConfig();
  debug.log('pwa.settings', 'answer-priority-set', { value: choice.value });
  return json({ value: choice.value });
}
