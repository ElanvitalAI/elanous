import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

type Data = Record<string, unknown>;
const object = (v: unknown): Data => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Data : {};
const text = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
const rows = (v: unknown): Data[] => Array.isArray(v) ? v.map(object) : [];
const line = (v: unknown): string => text(v).replace(/[\r\n|]+/g, ' ');
const errorLine = (e: unknown): string => line(e instanceof Error ? e.message : String(e)).slice(0, 240) || 'unknown error';
try {
const contextPath = process.env.ELANOUS_GRAPH_CONTEXT ?? '';
const context = object(JSON.parse(readFileSync(contextPath, 'utf8')));
const input = object(context.input);
const outputs = object(context.outputs);
const stateDirectory = dirname(contextPath);
if (!stateDirectory.endsWith('.json.contexts')) throw new Error('invalid graph run context');
const defaultOutDir = stateDirectory.slice(0, -'.json.contexts'.length);
const brand = text(input.brand);
if (!brand) throw new Error('brand is required');
const engines = input.engines === undefined ? ['openai-codex', 'grok'] : strings(input.engines);
if (!engines.length || engines.length > 3 || engines.length !== new Set(engines).size || (input.engines !== undefined && (!Array.isArray(input.engines) || strings(input.engines).length !== input.engines.length))) throw new Error('engines must contain 1 to 3 distinct names');
const cli = process.env.GEO_CHECK_ELANOUS_BIN || 'elanous';

// Ask from an empty folder: run inside a brand's own repository, `elanous ask` carries that project's
// context (AGENTS.md and the like) and the answers «know» the brand — a marketer's folder inflated mentions 0/10 → 9/10.
const neutralDir = mkdtempSync(join(tmpdir(), 'geo-check-'));
function neutralEnv(engine?: string): Record<string, string | undefined> {
  const { ELANOUS_TOOL_CWD: _tool, ...rest } = process.env;
  return { ...rest, PWD: neutralDir, ...(engine ? { ELANOUS_LLM_PROVIDER: engine } : {}) };
}

async function invoke(args: string[], engine?: string): Promise<unknown> {
  const proc = Bun.spawn([cli, ...args], {
    cwd: neutralDir,
    env: neutralEnv(engine),
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exit !== 0) throw new Error(line(stderr || stdout) || `CLI exited ${exit}`);
  const last = stdout.trim().split('\n').at(-1);
  if (!last) throw new Error('CLI returned no JSON');
  return JSON.parse(last) as unknown;
}
// An installed elanous older than `ask --bare` rejects the flag; ask the plain way and mark the row so the report can say so.
async function askEngine(question: string, engine: string): Promise<{ answer: string; bare: boolean }> {
  try { return { answer: reply(await invoke(['ask', '--bare', '--json', question], engine)), bare: true }; }
  catch (e) {
    if (!/unknown option '--bare'/.test(errorLine(e))) throw e;
    return { answer: reply(await invoke(['ask', '--json', question], engine)), bare: false };
  }
}
function reply(raw: unknown): string {
  const result = object(raw);
  if (typeof result.reply !== 'string') throw new Error('ask returned no reply');
  return result.reply;
}
function parseArray(raw: string): unknown {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned) as unknown;
}
function domains(v: string): string {
  const raw = v.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
  return raw.split('/')[0]?.toLowerCase().replace(/:\d+$/, '') ?? '';
}
function urls(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(urls);
  if (typeof v === 'string') return [...v.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)].map(m => m[0]!.replace(/[.,;!?]+$/, ''));
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([key, item]) => key === 'url' && typeof item === 'string' ? [item] : urls(item));
  return [];
}
// `elanous research --json` = { query, output, metadata } — result links are `- [title](url)` lines in `output`.
// Only those links count; the query string or other fields may name the brand domain without it being a result.
function resultUrls(raw: unknown): string[] {
  const out = object(raw).output;
  if (typeof out !== 'string') return [];
  return [...out.matchAll(/^\s*-\s*\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/gm)].map(m => m[1]!);
}
// A bare domain in the answer text («see elanous.ai») is a citation too, not only an https:// link.
function mentionsHost(answer: string, host: string): boolean {
  if (!host) return false;
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9.-])(?:www\\.)?${escaped}(?![a-z0-9-])`, 'i').test(answer);
}
function cited(url: string, host: string): boolean {
  try {
    const name = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return name === host || name.endsWith(`.${host}`);
  } catch { return false; }
}
function firstMention(answer: string, name: string): number | null {
  const lower = answer.toLocaleLowerCase();
  const needle = name.toLocaleLowerCase();
  let at = lower.indexOf(needle);
  while (at >= 0) {
    const before = at ? lower[at - 1]! : '';
    const after = lower[at + needle.length] ?? '';
    if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) return at;
    at = lower.indexOf(needle, at + 1);
  }
  return null;
}
function output(result: Data, calls = 0, errors = 0): void {
  console.log(JSON.stringify({ ...result, calls, errors }));
}

async function run(step: string): Promise<void> {
  if (step === 'questions') {
    if (input.questions !== undefined && !Array.isArray(input.questions)) throw new Error('questions must be an array');
    const provided = strings(input.questions);
    if (provided.length > 8 || (Array.isArray(input.questions) && provided.length !== input.questions.length)) throw new Error('questions must contain at most 8 nonempty strings');
    if (provided.length) { output({ questions: provided }); return; }
    try {
      const response = reply(await invoke(['ask', '--json', `Generate exactly 5 potential customer questions about the category of ${brand}. Respond ONLY with a JSON array of 5 question strings. Do not include the brand name in any question.`]));
      const generated = parseArray(response);
      if (!Array.isArray(generated) || generated.length !== 5 || strings(generated).length !== 5 || strings(generated).some(q => q.toLocaleLowerCase().includes(brand.toLocaleLowerCase()))) throw new Error('ask returned invalid or branded questions');
      output({ questions: generated }, 1);
    } catch (e) { output({ outcome: 'fail', questions: [], error: errorLine(e) }, 1, 1); }
  } else if (step === 'answers') {
    const questions = strings(object(outputs.questions).questions);
    if (!questions.length || questions.length > 8) throw new Error('missing questions');
    const answers: Data[] = [];
    let failures = 0;
    for (const question of questions) for (const engine of engines) {
      try {
        const { answer, bare } = await askEngine(question, engine);
        answers.push({ question, engine, answer, ...(bare ? {} : { bare: false }) });
      }
      catch (e) { failures++; answers.push({ question, engine, error: errorLine(e) }); }
    }
    output({ answers, outcome: failures === answers.length ? 'fail' : 'ok' }, answers.length, failures);
  } else if (step === 'web') {
    const questions = strings(object(outputs.questions).questions);
    const web: Data[] = [];
    let failures = 0;
    for (const question of questions) {
      try { web.push({ question, urls: resultUrls(await invoke(['research', '--json', '--limit', '5', question])).slice(0, 5) }); }
      catch (e) { failures++; web.push({ question, urls: [], error: errorLine(e) }); }
    }
    output({ web }, questions.length, failures);
  } else if (step === 'score') {
    const answers = rows(object(outputs.answers).answers);
    const web = rows(object(outputs.web).web);
    if (!answers.length) throw new Error('missing answers');
    const domain = domains(text(input.domain));
    const table = answers.map(cell => {
      const answer = text(cell.answer);
      if (cell.error) return { question: cell.question, engine: cell.engine, error: cell.error, mention: false, citation: domain ? false : null, rank: null };
      const position = firstMention(answer, brand);
      const candidates = [...urls(answer), ...strings(web.find(row => row.question === cell.question)?.urls)];
      return { question: cell.question, engine: cell.engine, mention: position !== null,
        citation: domain ? candidates.some(url => cited(url, domain)) || mentionsHost(answer, domain) : null, rank: position === null ? null : answer.slice(0, position).trim().split(/\s+/).filter(Boolean).length + 1 };
    });
    output({ table }, 0, table.filter(cell => cell.error).length);
  } else if (step === 'suggest') {
    const table = rows(object(outputs.score).table);
    if (!table.length) throw new Error('missing score table');
    const gaps = table.filter(cell => cell.error || !cell.mention || cell.citation === false).map(cell => ({ question: cell.question, engine: cell.engine, error: cell.error ?? null, mention: cell.mention, citation: cell.citation }));
    if (!gaps.length) { output({ suggestions: [] }); return; }
    try {
      const raw = parseArray(reply(await invoke(['ask', '--json', `Using ONLY this score table, return a JSON array of 3 to 5 improvement suggestions. Each must have "suggestion" (FAQ question, FAQPage/Organization structured data, comparison document, etc.) and "evidence" containing a question and engine from the missing cells. Evidence cells: ${JSON.stringify(gaps)}. Score table: ${JSON.stringify(table)}`])));
      if (!Array.isArray(raw) || raw.length < 3 || raw.length > 5) throw new Error('invalid suggestion count');
      const suggestions = raw.map(item => {
        const candidate = object(item);
        const evidence = object(candidate.evidence);
        const match = gaps.find(cell => cell.question === evidence.question && cell.engine === evidence.engine);
        if (!text(candidate.suggestion) || !match) throw new Error('suggestion missing valid score evidence');
        return { suggestion: text(candidate.suggestion), evidence: { question: match.question, engine: match.engine } };
      });
      output({ suggestions }, 1);
    } catch (e) { output({ outcome: 'fail', suggestions: [], error: errorLine(e) }, 1, 1); }
  } else if (step === 'report') {
    const table = rows(object(outputs.score).table);
    const answers = rows(object(outputs.answers).answers);
    const suggestions = rows(object(outputs.suggest).suggestions);
    if (!table.length) throw new Error('missing score table');
    const outDir = text(input.outDir) || defaultOutDir;
    const success = table.filter(cell => !cell.error);
    const citationSummary = text(input.domain) ? `${success.filter(cell => cell.citation).length}/${success.length} cite ${text(input.domain)}.` : 'Citation unknown (no domain provided).';
    const summary = `${brand}: ${success.filter(cell => cell.mention).length}/${success.length} available answers mention the brand; ${citationSummary}`;
    const markdown = [`# GEO check — ${line(brand)}`, '', summary, '', '| Question | Engine | Mention | Citation | Rank | Error |', '| --- | --- | --- | --- | --- | --- |',
      ...table.map(cell => `| ${line(cell.question)} | ${line(cell.engine)} | ${cell.mention ? 'yes' : 'no'} | ${cell.citation === null ? 'unknown' : cell.citation ? 'yes' : 'no'} | ${cell.rank ?? '—'} | ${line(cell.error)} |`),
      '', '## Suggestions', ...suggestions.map(item => `- ${line(item.suggestion)} — ${line(object(item.evidence).question)} / ${line(object(item.evidence).engine)}`),
      '', '## Answers', ...answers.map(cell => `### ${line(cell.question)} — ${line(cell.engine)}\n\n${line(cell.error) || text(cell.answer).slice(0, 400)}\n`), ''].join('\n');
    mkdirSync(outDir, { recursive: true });
    const md = join(outDir, 'report.md');
    const json = join(outDir, 'report.json');
    writeFileSync(md, markdown, { mode: 0o600 });
    writeFileSync(json, JSON.stringify({ brand, domain: text(input.domain), summary, table, suggestions, answers }, null, 2) + '\n', { mode: 0o600 });
    output({ report: md, reportJson: json, summary }, 0, table.filter(cell => cell.error).length);
  } else throw new Error(`unknown geo-check step: ${step}`);
}

await run(process.argv[2] ?? '');
} catch (e) {
  console.log(JSON.stringify({ outcome: 'fail', error: errorLine(e), calls: 0, errors: 1 }));
}
