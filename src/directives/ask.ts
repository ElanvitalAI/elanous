// `directives ask` and the DirectiveSearch seat tool — one natural-language question over the utterance index.
// Three shapes: search («어제 로스터 얘기한 거»), did-I-say («11월 23일에 X 라고 한 적 있어?») and theme history
// («지난 일주일 동안 발행 관련 요청 내역»). The topic goes to the hybrid (meaning + words) search; the period and
// channel come from the parser's explicit vocabulary. No LLM: history is grouped by day with representative lines.
import { dedupeUtterances, type DirectiveIndex, type DirectiveFilters, type Utterance } from './directive-index.js';
import { directiveKey, embedPending, hybridSearchDirectives, topicWords, vectorsFor, MEANING_FLOOR, type DirectiveHit, type EmbedFn, type EmbedPendingResult } from './directive-semantic.js';
import { parseNaturalQuery, type AskIntent, type NaturalQuery } from './natural-query.js';

/** A did-I-say answer is «yes» when every topic word is there or the meaning is this close. */
export const SAID_SIMILARITY = 0.75;
/** Two utterances belong to one theme at this cosine (or this word overlap without vectors). */
const THEME_SIMILARITY = 0.8;
const THEME_OVERLAP = 0.34;

export interface AskOptions {
  embed?: EmbedFn | null;
  now?: number;
  limit?: number;
  group?: 'day' | 'theme';
  /** Explicit overrides — win over what the question says. */
  since?: string; until?: string; source?: string;
  /** Rows embedded before answering (the rest wait for `directives sync`). */
  embedMax?: number;
}
export interface AskRow {
  ts: string; kst: string; day: string; channels: string[]; text: string; snippet: string;
  similarity: number | null; matchedBy: DirectiveHit['matchedBy'] | 'period'; context: string | null;
}
export interface AskGroup { label: string; count: number; rows: AskRow[] }
export interface AskResult {
  question: string; parsed: NaturalQuery; intent: AskIntent; mode: 'hybrid' | 'keyword'; note: string | null;
  embedding: EmbedPendingResult | null;
  rows: AskRow[];
  said?: { yes: boolean; day: string | null; otherDays: string[] };
  groups?: AskGroup[];
  summary?: string[];
}

const KST_MS = 9 * 3_600_000;
const kstDay = (ts: string) => new Date(Date.parse(ts) + KST_MS).toISOString().slice(0, 10);
const kstClock = (ts: string) => new Date(Date.parse(ts) + KST_MS).toISOString().slice(11, 16);
const kstStamp = (ts: string) => `${kstDay(ts)} ${kstClock(ts)} KST`;
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** A short window of the utterance around the first topic word. */
export function snippetOf(text: string, words: readonly string[], width = 140): string {
  const flat = oneLine(text);
  if (flat.length <= width) return flat;
  const lower = flat.toLowerCase();
  const at = words.map(word => lower.indexOf(word.toLowerCase())).filter(i => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, Math.min(at - Math.floor(width / 3), flat.length - width));
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + width)}${start + width < flat.length ? '…' : ''}`;
}

function toRow(index: DirectiveIndex, utterance: Utterance & Partial<DirectiveHit>, words: readonly string[]): AskRow {
  const before = index.db.prepare('SELECT text FROM directives WHERE agent=? AND session_id=? AND ts < ? ORDER BY ts DESC LIMIT 1')
    .get(utterance.agent, utterance.session_id, utterance.ts) as { text: string } | null;
  return {
    ts: utterance.ts, kst: kstStamp(utterance.ts), day: kstDay(utterance.ts), channels: utterance.channels, text: utterance.text,
    snippet: snippetOf(utterance.text, words), similarity: utterance.similarity ?? null, matchedBy: utterance.matchedBy ?? 'period',
    context: before ? snippetOf(before.text, [], 70) : null,
  };
}
/** RRF first; a tie goes to the line holding every topic word, then to the closer meaning. */
const byRank = (a: DirectiveHit, b: DirectiveHit) => b.rrf - a.rrf || Number(b.allWords) - Number(a.allWords) || (b.similarity ?? -1) - (a.similarity ?? -1);
const isMatch = (hit: DirectiveHit) => hit.allWords || (hit.similarity ?? 0) >= MEANING_FLOOR;
const isSaid = (hit: DirectiveHit) => hit.allWords || (hit.similarity ?? 0) >= SAID_SIMILARITY;

async function themeGroups(index: DirectiveIndex, rows: readonly (Utterance & Partial<DirectiveHit>)[]): Promise<Array<{ rows: Array<Utterance & Partial<DirectiveHit>> }>> {
  const { cosine } = await import('../domains/knowledge.js');
  const vectors = vectorsFor(index, rows);
  const clusters: Array<{ head: Utterance; rows: Array<Utterance & Partial<DirectiveHit>> }> = [];
  const overlap = (a: string, b: string) => {
    const left = new Set(topicWords(a)); const right = new Set(topicWords(b));
    const shared = [...left].filter(word => right.has(word)).length;
    return shared / Math.max(1, new Set([...left, ...right]).size);
  };
  for (const row of rows) {
    const vector = vectors.get(directiveKey(row));
    const home = clusters.find(cluster => {
      const head = vectors.get(directiveKey(cluster.head));
      return vector && head ? cosine(vector, head) >= THEME_SIMILARITY : overlap(row.text, cluster.head.text) >= THEME_OVERLAP;
    });
    if (home) home.rows.push(row); else clusters.push({ head: row, rows: [row] });
  }
  return clusters.sort((a, b) => b.rows.length - a.rows.length);
}

export async function askDirectives(index: DirectiveIndex, question: string, opts: AskOptions = {}): Promise<AskResult> {
  const now = opts.now ?? Date.now();
  const parsed = parseNaturalQuery(question, now);
  if (opts.since) parsed.since = opts.since;
  if (opts.until) parsed.until = opts.until;
  if (opts.source) parsed.source = opts.source;
  let embed = opts.embed ?? null;
  let embedding: EmbedPendingResult | null = null;
  if (embed) {
    embedding = await embedPending(index, embed, opts.embedMax ?? 200);
    // A down embedder is asked once, not once more for the question.
    if (embedding.error && embedding.embedded === 0) embed = null;
  }
  const filters: DirectiveFilters = { since: parsed.since, until: parsed.until, agent: parsed.source };
  const limit = Math.max(1, Math.min(200, opts.limit ?? 10));
  const words = topicWords(parsed.topic);
  const result: AskResult = { question, parsed, intent: parsed.intent, mode: embed ? 'hybrid' : 'keyword', note: null, embedding, rows: [] };
  if (!embed && opts.embed) result.note = `임베더 응답 없음(${embedding?.error?.slice(0, 80) ?? 'error'}) — 키워드로만 찾음`;

  if (!parsed.topic) {
    // No topic: everything said in the period, newest first (or grouped for history).
    const rows = index.utterances(filters).map(row => toRow(index, row, []));
    result.mode = 'keyword';
    result.rows = parsed.intent === 'history' ? rows : rows.reverse().slice(0, limit);
    if (parsed.intent === 'history') Object.assign(result, historyShape(rows));
    return result;
  }
  const search = async (f: DirectiveFilters, pool: number) => {
    const found = await hybridSearchDirectives(index, parsed.topic, f, { embed, pool });
    result.mode = found.mode;
    result.note ??= found.note;
    return found.hits;
  };

  if (parsed.intent === 'said') {
    const hits = await search(filters, 200);
    const said = hits.filter(isSaid);
    const shown = dedupeUtterances(said.length ? said : hits.filter(isMatch)) as Array<Utterance & DirectiveHit>;
    result.rows = shown.sort(byRank).slice(0, Math.min(limit, 5)).map(row => toRow(index, row, words));
    let otherDays: string[] = [];
    if (!said.length && (parsed.since || parsed.until)) {
      const elsewhere = (await search({ agent: parsed.source }, 500)).filter(isSaid);
      otherDays = [...new Set(elsewhere.map(hit => kstDay(hit.ts)))].sort().reverse().slice(0, 5);
      if (!result.rows.length) result.rows = (dedupeUtterances(elsewhere) as Array<Utterance & DirectiveHit>).sort(byRank).slice(0, 3).map(row => toRow(index, row, words));
    }
    result.said = { yes: said.length > 0, day: parsed.day ?? null, otherDays };
    return result;
  }
  if (parsed.intent === 'history') {
    const hits = (await search(filters, 2000)).filter(isMatch);
    const utterances = (dedupeUtterances(hits) as Array<Utterance & DirectiveHit>);
    const rows = utterances.map(row => toRow(index, row, words));
    result.rows = rows;
    const themes = await themeGroups(index, utterances);
    const themeRows = themes.map(theme => theme.rows.map(row => rows[utterances.indexOf(row as Utterance & DirectiveHit)]!));
    Object.assign(result, historyShape(rows, opts.group === 'theme' ? themeRows : undefined, themeRows));
    return result;
  }
  const hits = await search(filters, Math.max(limit * 4, 40));
  result.rows = (dedupeUtterances(hits) as Array<Utterance & DirectiveHit>).sort(byRank).slice(0, limit).map(row => toRow(index, row, words));
  return result;
}

/** Day (or theme) groups oldest first and a 3–5 line account of how the request moved. */
function historyShape(rows: AskRow[], byTheme?: AskRow[][], themes?: AskRow[][]): Pick<AskResult, 'groups' | 'summary'> {
  const groups: AskGroup[] = byTheme
    ? byTheme.map(list => ({ label: `«${snippetOf(list[0]!.text, [], 40)}»`, count: list.length, rows: list }))
    : [...new Set(rows.map(row => row.day))].map(day => {
      const list = rows.filter(row => row.day === day);
      return { label: day, count: list.length, rows: list };
    });
  if (!rows.length) return { groups, summary: [] };
  const channels = new Map<string, number>();
  for (const row of rows) for (const channel of row.channels) channels.set(channel, (channels.get(channel) ?? 0) + 1);
  const perDay = new Map<string, number>();
  for (const row of rows) perDay.set(row.day, (perDay.get(row.day) ?? 0) + 1);
  const peak = [...perDay.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
  const first = rows[0]!; const last = rows.at(-1)!;
  const summary = [
    `총 ${rows.length}건 · ${perDay.size}일 · 채널 ${[...channels.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`,
    `처음 ${first.kst} «${snippetOf(first.text, [], 60)}»`,
  ];
  if (perDay.size > 1 && peak[1] > 1) summary.push(`가장 많은 날 ${peak[0]} (${peak[1]}건)`);
  if (last !== first) summary.push(`마지막 ${last.kst} «${snippetOf(last.text, [], 60)}»`);
  if (themes && themes.length > 1) summary.push(`갈래 ${themes.length}개: ${themes.slice(0, 3).map(list => `«${snippetOf(list[0]!.text, [], 24)}» ${list.length}`).join(' · ')}`);
  return { groups, summary };
}

function periodLine(result: AskResult): string {
  const p = result.parsed;
  const kst = (iso?: string) => (iso ? kstStamp(iso) : undefined);
  const parts = [
    `기간 ${kst(p.since) ?? '처음'} ~ ${kst(p.until) ?? '지금'}`,
    ...(p.source ? [`채널 ${p.source}`] : []),
    `주제 «${p.topic || '(전부)'}»`,
    `방식 ${result.mode === 'hybrid' ? '의미+키워드' : '키워드'}`,
  ];
  return `물음 이해: ${parts.join(' · ')}`;
}
const sim = (row: AskRow) => (row.similarity === null ? '' : ` · 유사 ${row.similarity.toFixed(2)}`);

export function renderAsk(result: AskResult, format: 'text' | 'md' = 'text'): string {
  const md = format === 'md';
  const out: string[] = md ? [`# ${result.question}`, '', `> ${periodLine(result)}`] : [periodLine(result)];
  if (result.note) out.push(md ? `> ${result.note}` : result.note);
  const line = (row: AskRow, clockOnly = false) => {
    const when = clockOnly ? kstClock(row.ts) : row.kst;
    return md ? `- **${when}** · ${row.channels.join('+')}${sim(row)} — ${row.snippet}`
      : `${when} · ${row.channels.join('+')}${sim(row)} · ${row.snippet}${row.context ? `\n   ↳ 직전: ${row.context}` : ''}`;
  };
  if (md) out.push('');
  if (result.said) {
    const { yes, day, otherDays } = result.said;
    out.push(yes ? `예 — ${day ? `${day} 에 ` : ''}그렇게 말한 적이 있다 (가까운 ${result.rows.length}건)`
      : otherDays.length ? `아니오 — 그날은 없고 ${otherDays.join(' · ')} 에 있음`
      : `아니오 — ${day ? '그날도 다른 날도 ' : ''}찾지 못함`);
    for (const row of result.rows) out.push(line(row));
    return out.join('\n');
  }
  if (result.groups) {
    if (!result.rows.length) out.push('못 찾음 — 그 기간에 이 주제의 발화 없음');
    for (const group of result.groups) {
      out.push(md ? `\n## ${group.label} (${group.count}건)\n` : `${group.label} (${group.count}건)`);
      for (const row of group.rows) out.push(md ? line(row, group.label === row.day) : `  ${line(row, group.label === row.day)}`);
    }
    if (result.summary?.length) {
      out.push(md ? '\n## 흐름\n' : '흐름:');
      for (const entry of result.summary) out.push(md ? `- ${entry}` : `  ${entry}`);
    }
    return out.join('\n');
  }
  if (!result.rows.length) out.push('못 찾음 — 조건과 일치하는 발화 없음');
  for (const row of result.rows) out.push(line(row));
  return out.join('\n');
}
