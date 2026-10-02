import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runGraph } from '../../../src/graph-runner/runner.js';

// The 24-call bound intentionally launches 24 fake CLI processes.
const slowTest = (name: string, fn: () => Promise<void>) => test(name, fn, 30000);
const dir = import.meta.dir;
const graphFile = join(dir, 'geo-check.yaml');
const steps = ['questions', 'answers', 'web', 'score', 'suggest', 'report'];
const graph = parseYaml(readFileSync(graphFile, 'utf8')) as {
  nodes: { node_id: string; recipe?: string }[];
  edges: { from: string; map: Record<string, string> }[];
};
const recipes = parseYaml(readFileSync(join(dir, 'recipes.yaml'), 'utf8')) as Record<string, { command: string }>;
const fakeSource = `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const [kind, ...args] = process.argv.slice(2);
if (process.env.GEO_CHECK_CALL_LOG) appendFileSync(process.env.GEO_CHECK_CALL_LOG, JSON.stringify({kind,args,provider:process.env.ELANOUS_LLM_PROVIDER ?? null})+'\\n');
const question = args.at(-1) || '';
if (kind === 'research') { if (process.env.GEO_CHECK_NO_WEB) { console.log(JSON.stringify({query:question+' site https://elanous.ai/',output:'omni_search — 0 hits',metadata:{}})); process.exit(0); } console.log(JSON.stringify({query:question,output:'- [Guide](https://www.elanous.ai/guide)\\n  snippet',metadata:{}})); process.exit(0); }
if (kind !== 'ask') process.exit(2);
if (process.env.GEO_CHECK_NO_BARE && args.includes('--bare')) { console.error("error: unknown option '--bare'"); process.exit(1); }
if (process.env.GEO_CHECK_ECHO_CWD) { console.log(JSON.stringify({reply:'cwd='+process.cwd()+' tool='+(process.env.ELANOUS_TOOL_CWD ?? 'none')})); process.exit(0); }
if (question.includes('Generate exactly 5')) { console.log(JSON.stringify({reply:JSON.stringify(['What is an AI assistant?', 'Which assistant is best?', 'How can I automate?', 'What tools compare?', 'How much does it cost?'])})); process.exit(0); }
if (question.includes('Using ONLY this score table') && process.env.GEO_CHECK_SUGGEST_REPLIES) { const list = JSON.parse(process.env.GEO_CHECK_SUGGEST_REPLIES); const f = process.env.GEO_CHECK_SUGGEST_COUNTER; let n = 0; try { n = Number(readFileSync(f, 'utf8')) || 0; } catch {} writeFileSync(f, String(n + 1)); console.log(JSON.stringify({reply: JSON.stringify(list[Math.min(n, list.length - 1)])})); process.exit(0); }
if (question.includes('Using ONLY this score table')) { console.log(JSON.stringify({reply:JSON.stringify([1,2,3].map(n=>({suggestion:'Write FAQ '+n,evidence:{question:'Which assistant is best?',engine:'grok'}})))})); process.exit(0); }
if (process.env.GEO_CHECK_REPLY) { console.log(JSON.stringify({provider:process.env.ELANOUS_LLM_PROVIDER,reply:process.env.GEO_CHECK_REPLY})); process.exit(0); }
if (process.env.ELANOUS_LLM_PROVIDER === 'grok' && !process.env.GEO_CHECK_ALL_CITED) { console.error('credential unavailable'); process.exit(1); }
console.log(JSON.stringify({provider:process.env.ELANOUS_LLM_PROVIDER,reply:process.env.GEO_CHECK_ALL_CITED ? 'Visit https://elanous.ai/guide for details.' : question.includes('assistant') && question.startsWith('What') ? 'Visit https://elanous.ai/guide for details.' : 'No result for this engine.'}));
`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'geo-check-'));
  const bin = join(root, 'fake-elanous');
  writeFileSync(bin, fakeSource);
  chmodSync(bin, 0o755);
  return { root, bin, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
async function step(name: string, input: Record<string, unknown>, outputs: Record<string, unknown>, bin: string, root: string, callLog?: string, extraEnv: Record<string, string> = {}) {
  const contextDir = join(root, 'run.json.contexts');
  const file = join(contextDir, `${name}.json`);
  await Bun.write(file, JSON.stringify({ input, outputs }));
  const proc = Bun.spawn(['bun', join(dir, 'run-step.ts'), name], { env: { ...process.env, GEO_CHECK_ELANOUS_BIN: bin, ELANOUS_GRAPH_CONTEXT: file, ...(callLog ? { GEO_CHECK_CALL_LOG: callLog } : {}), ...extraEnv }, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(exit).toBe(0);
  expect(err).toBe('');
  return JSON.parse(out.trim().split('\n').at(-1)!) as Record<string, any>;
}

test('six graph nodes connect only through their step recipes', () => {
  expect(graph.nodes.map(n => n.node_id)).toEqual([...steps, 'done', 'failed']);
  for (const [index, name] of steps.entries()) {
    expect(graph.nodes[index]?.recipe).toBe(`cmd:${name}`);
    expect(recipes[name]?.command).toBe(`bun "$ELANOUS_GRAPH_DIR/run-step.ts" ${name}`);
    expect(graph.edges[index]?.map).toEqual({ ok: steps[index + 1] ?? 'done', fail: 'failed' });
  }
});

test('fake CLI receives bare JSON only for answers; questions and suggest retain their ask arguments', async () => {
  const f = fixture();
  try {
    const callLog = join(f.root, 'calls.jsonl');
    const questions = await step('questions', { brand: 'Elanous' }, {}, f.bin, f.root, callLog);
    expect(questions).toMatchObject({ calls: 1, errors: 0 });
    const answers = await step('answers', { brand: 'Elanous', engines: ['openai-codex', 'grok'] }, { questions: { questions: ['Which assistant is best?'] } }, f.bin, f.root, callLog);
    expect(answers).toMatchObject({ calls: 2, errors: 1, outcome: 'ok' });
    const suggest = await step('suggest', { brand: 'Elanous' }, { score: { table: [
      { question: 'Which assistant is best?', engine: 'grok', error: 'credential unavailable', mention: false, citation: false },
    ] } }, f.bin, f.root, callLog);
    expect(suggest).toMatchObject({ calls: 1, errors: 0 });
    expect(suggest.suggestions).toHaveLength(3);

    const calls = readFileSync(callLog, 'utf8').trim().split('\n').map(row => JSON.parse(row) as { kind: string; args: string[]; provider: string | null });
    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatchObject({ kind: 'ask', provider: null });
    expect(calls[0]!.args).toEqual(['--json', 'Generate exactly 5 potential customer questions about the category of Elanous. Respond ONLY with a JSON array of 5 question strings. Do not include the brand name in any question.']);
    expect(calls[1]).toEqual({ kind: 'ask', args: ['--bare', '--json', 'Which assistant is best?'], provider: 'openai-codex' });
    expect(calls[2]).toEqual({ kind: 'ask', args: ['--bare', '--json', 'Which assistant is best?'], provider: 'grok' });
    expect(calls[3]).toMatchObject({ kind: 'ask', provider: null });
    expect(calls[3]!.args).toEqual(['--json', 'Using ONLY this score table, return a JSON array of 3 to 5 improvement suggestions. Each item: {"suggestion": "<FAQ question, FAQPage/Organization structured data, comparison document, etc.>", "evidence": <id of one cell below>}. Evidence cells (pick by id): [{"id":0,"question":"Which assistant is best?","engine":"grok","error":"credential unavailable","mention":false,"citation":false}]. Score table: [{"question":"Which assistant is best?","engine":"grok","error":"credential unavailable","mention":false,"citation":false}]']);
    expect(readFileSync(join(dir, 'run-step.ts'), 'utf8')).not.toMatch(/(?:from\s*|import\s*\()['"][^'"]*src\//);
  } finally { f.cleanup(); }
});

test('missing brand and invalid engines emit final-line JSON errors', async () => {
  const f = fixture();
  try {
    for (const input of [{}, { brand: 'Arc', engines: [] }, { brand: 'Arc', engines: 'grok' }]) {
      const result = await step('questions', input, {}, f.bin, f.root);
      expect(result).toMatchObject({ outcome: 'fail', calls: 0, errors: 1 });
      expect(result.error).toMatch(/brand is required|engines must contain/);
    }
  } finally { f.cleanup(); }
});

test('input bounds, generated unbranded questions, and empty array', async () => {
  const f = fixture();
  try {
    const q = await step('questions', { brand: 'Elanous', questions: [] }, {}, f.bin, f.root);
    expect(q.calls).toBe(1);
    expect(q.questions).toHaveLength(5);
    expect(q.questions.every((s: string) => !s.toLowerCase().includes('elanous'))).toBe(true);
    const given = await step('questions', { brand: 'Elanous', questions: ['Why?'] }, {}, f.bin, f.root);
    expect(given).toMatchObject({ questions: ['Why?'], calls: 0 });
    await Bun.write(join(f.root, 'run.json.contexts', 'bad.json'), JSON.stringify({ input: { brand: 'Arc', questions: Array(9).fill('Why?') }, outputs: {} }));
    const invalid = Bun.spawn(['bun', join(dir, 'run-step.ts'), 'questions'], { env: { ...process.env, ELANOUS_GRAPH_CONTEXT: join(f.root, 'run.json.contexts', 'bad.json') }, stdout: 'pipe', stderr: 'pipe' });
    expect(JSON.parse((await new Response(invalid.stdout).text()).trim())).toMatchObject({ outcome: 'fail', calls: 0, errors: 1 });
    expect(await invalid.exited).toBe(0);
  } finally { f.cleanup(); }
});

slowTest('scoring boundaries, normalized citation, engine errors and call cap', async () => {
  const f = fixture();
  try {
    const questions = ['What is an AI assistant?', 'Which assistant is best?'];
    const answers = await step('answers', { brand: 'Elanous' }, { questions: { questions } }, f.bin, f.root);
    expect(answers).toMatchObject({ calls: 4, errors: 2, outcome: 'ok' });
    expect(answers.answers.filter((v: any) => v.engine === 'grok').every((v: any) => v.error === 'credential unavailable')).toBe(true);
    const web = await step('web', { brand: 'Elanous' }, { questions: { questions } }, f.bin, f.root);
    expect(web).toMatchObject({ calls: 2, errors: 0 });
    const score = await step('score', { brand: 'Elanous', domain: 'https://www.elanous.ai/' }, { answers, web }, f.bin, f.root);
    expect(score.table[0]).toMatchObject({ mention: true, citation: true, rank: 3 });
    expect(score.table[1]).toMatchObject({ error: 'credential unavailable', rank: null });
    const arc = await step('score', { brand: 'Arc' }, { answers: { answers: [{ question: 'q', engine: 'openai-codex', answer: 'search architecture' }] }, web: { web: [] } }, f.bin, f.root);
    expect(arc.table[0]).toMatchObject({ mention: false, citation: null, rank: null });
    const unknownReport = await step('report', { brand: 'Arc', outDir: join(f.root, 'unknown-report') }, { score: arc, answers: { answers: [{ question: 'q', engine: 'openai-codex', answer: 'search architecture' }] }, suggest: { suggestions: [] } }, f.bin, f.root);
    expect(unknownReport.summary).toContain('Citation unknown (no domain provided).');
    expect(unknownReport.summary).not.toContain('0/1 cite');
    expect(readFileSync(unknownReport.report, 'utf8')).toContain('| unknown |');
    expect(JSON.parse(readFileSync(unknownReport.reportJson, 'utf8')).table[0].citation).toBeNull();
    const noDomain = await step('score', { brand: 'Arc', domain: 'arc.example' }, { answers: { answers: [{ question: 'q', engine: 'openai-codex', answer: 'Arc is useful; see arc.example for details.' }] }, web: { web: [] } }, f.bin, f.root);
    // A bare domain in the answer counts as a citation (goal counterexample 1 · review round 3).
    expect(noDomain.table[0]).toMatchObject({ mention: true, citation: true, rank: 1 });
    const max = await step('questions', { brand: 'Arc', questions: Array(8).fill('Which option?') }, {}, f.bin, f.root);
    expect(max.questions).toHaveLength(8);
    const cap = await step('answers', { brand: 'Elanous', questions: Array(8).fill('q'), engines: ['a', 'b', 'c'] }, { questions: { questions: Array(8).fill('q') } }, f.bin, f.root);
    expect(cap.calls).toBe(24);
    expect(cap.answers).toHaveLength(24);
    const failure = await step('answers', { brand: 'Elanous', engines: ['grok'] }, { questions: { questions: ['q'] } }, f.bin, f.root);
    expect(failure.outcome).toBe('fail');
  } finally { f.cleanup(); }
});

test('all answer engines failing routes the graph to failed', async () => {
  const f = fixture();
  const previous = process.env.GEO_CHECK_ELANOUS_BIN;
  process.env.GEO_CHECK_ELANOUS_BIN = f.bin;
  try {
    const state = await runGraph(graphFile, { input: { brand: 'Elanous', questions: ['Which assistant is best?'], engines: ['grok'] }, deps: { root: f.root } });
    expect(state.status).toBe('failed');
    expect(state.path).toEqual(['questions', 'answers', 'failed']);
  } finally {
    if (previous === undefined) delete process.env.GEO_CHECK_ELANOUS_BIN;
    else process.env.GEO_CHECK_ELANOUS_BIN = previous;
    f.cleanup();
  }
});

slowTest('fake-CLI graph run reaches done and writes one report table', async () => {
  const f = fixture();
  try {
    const repo = join(dir, '../../..');
    const input = { brand: 'Elanous', domain: 'elanous.ai', outDir: join(f.root, 'report'), questions: ['Which assistant is best?'] };
    const proc = Bun.spawn(['bun', join(repo, 'bin/elanous.mjs'), `--test=${join(f.root, 'state')}`, 'graph', 'run', graphFile, '--input', JSON.stringify(input), '--json'], {
      cwd: repo, env: { ...process.env, GEO_CHECK_ELANOUS_BIN: f.bin }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(exit).toBe(0);
    const state = JSON.parse(stdout);
    expect(state.status).toBe('done');
    expect(state.path).toEqual([...steps, 'done']);
    expect(stderr).not.toContain('graph run:');
    const markdown = readFileSync(join(f.root, 'report', 'report.md'), 'utf8');
    expect(markdown.match(/\| Question \| Engine \| Mention \| Citation \| Rank \| Error \|/g)).toHaveLength(1);
    const report = JSON.parse(readFileSync(join(f.root, 'report', 'report.json'), 'utf8'));
    expect(report.table).toHaveLength(2);
    expect(report.suggestions).toHaveLength(3);
    expect(report.suggestions.every((item: any) => report.table.some((cell: any) =>
      cell.question === item.evidence.question && cell.engine === item.evidence.engine &&
      (cell.error || !cell.mention || cell.citation === false)))).toBe(true);
  } finally { f.cleanup(); }
});

slowTest('no missing cells produce no fabricated evidence and a done report', async () => {
  const f = fixture();
  try {
    const repo = join(dir, '../../..');
    const input = { brand: 'Elanous', domain: 'https://www.elanous.ai/', outDir: join(f.root, 'complete'), questions: ['Which assistant is best?'] };
    const proc = Bun.spawn(['bun', join(repo, 'bin/elanous.mjs'), `--test=${join(f.root, 'state')}`, 'graph', 'run', graphFile, '--input', JSON.stringify(input), '--json'], {
      cwd: repo, env: { ...process.env, GEO_CHECK_ELANOUS_BIN: f.bin, GEO_CHECK_ALL_CITED: '1' }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exit).toBe(0);
    expect(JSON.parse(stdout).status).toBe('done');
    const report = JSON.parse(readFileSync(join(f.root, 'complete', 'report.json'), 'utf8'));
    expect(report.table).toHaveLength(2);
    expect(report.table.every((cell: any) => cell.mention && cell.citation)).toBe(true);
    expect(report.suggestions).toEqual([]);
    expect(readFileSync(join(f.root, 'complete', 'report.md'), 'utf8')).not.toContain('Write FAQ');
    expect(readFileSync(join(f.root, 'complete', 'report.md'), 'utf8')).toContain('| Question | Engine | Mention | Citation | Rank | Error |');
  } finally { f.cleanup(); }
});

async function citationRun(reply: string) {
  const f = fixture();
  try {
    const repo = join(dir, '../../..');
    const input = { brand: 'Elanous', domain: 'elanous.ai', engines: ['openai-codex', 'grok'], outDir: join(f.root, 'out'), questions: ['Which assistant is best?'] };
    const proc = Bun.spawn(['bun', join(repo, 'bin/elanous.mjs'), `--test=${join(f.root, 'state')}`, 'graph', 'run', graphFile, '--input', JSON.stringify(input), '--json'], {
      cwd: repo, env: { ...process.env, GEO_CHECK_ELANOUS_BIN: f.bin, GEO_CHECK_NO_WEB: '1', GEO_CHECK_REPLY: reply }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exit).toBe(0);
    expect(JSON.parse(stdout).status).toBe('done');
    return JSON.parse(readFileSync(join(f.root, 'out', 'report.json'), 'utf8')).table[0] as { mention: boolean; citation: boolean | null };
  } finally { f.cleanup(); }
}

slowTest('a bare domain in the answer is a citation even when web search returns nothing', async () => {
  expect(await citationRun('Try elanous.ai for this.')).toMatchObject({ mention: true, citation: true });
});

slowTest('a brand domain that appears only in the research query is not a citation', async () => {
  // The fake research echoes «<question> site https://elanous.ai/» as its query and returns no result links.
  expect(await citationRun('Several assistants exist; pick one that fits.')).toMatchObject({ mention: false, citation: false });
});

test('answers are asked from an empty folder, not the folder the graph runs in', async () => {
  const f = fixture();
  try {
    const repo = mkdtempSync(join(tmpdir(), 'brand-repo-'));
    writeFileSync(join(repo, 'AGENTS.md'), 'Elanous is this project.');
    const contextDir = join(f.root, 'run.json.contexts');
    const file = join(contextDir, 'answers.json');
    await Bun.write(file, JSON.stringify({ input: { brand: 'Elanous', engines: ['openai-codex'] }, outputs: { questions: { questions: ['What tools exist?'] } } }));
    const proc = Bun.spawn(['bun', join(dir, 'run-step.ts'), 'answers'], {
      cwd: repo, env: { ...process.env, GEO_CHECK_ELANOUS_BIN: f.bin, ELANOUS_GRAPH_CONTEXT: file, GEO_CHECK_ECHO_CWD: '1', ELANOUS_TOOL_CWD: repo }, stdout: 'pipe', stderr: 'pipe',
    });
    const [out, , exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(exit).toBe(0);
    const answer = String((JSON.parse(out.trim().split('\n').at(-1)!) as { answers: { answer: string }[] }).answers[0]!.answer);
    expect(answer).toContain('geo-check-');
    expect(answer).not.toContain(repo);
    expect(answer).toContain('tool=none');
    rmSync(repo, { recursive: true, force: true });
  } finally { f.cleanup(); }
});

test('an installed elanous without ask --bare falls back to plain ask and marks the row', async () => {
  const f = fixture();
  try {
    const callLog = join(f.root, 'calls.jsonl');
    const answers = await step('answers', { brand: 'Elanous', engines: ['openai-codex'] }, { questions: { questions: ['What assistant should I use?'] } }, f.bin, f.root, callLog, { GEO_CHECK_NO_BARE: '1' });
    expect(answers).toMatchObject({ calls: 1, errors: 0, outcome: 'ok' });
    expect(answers.answers[0]).toMatchObject({ engine: 'openai-codex', answer: 'Visit https://elanous.ai/guide for details.', bare: false });
    const calls = readFileSync(callLog, 'utf8').trim().split('\n').map(row => JSON.parse(row) as { args: string[] });
    expect(calls.map(c => c.args)).toEqual([['--bare', '--json', 'What assistant should I use?'], ['--json', 'What assistant should I use?']]);
  } finally { f.cleanup(); }
});

test('other ask failures are not retried without --bare', async () => {
  const f = fixture();
  try {
    const callLog = join(f.root, 'calls.jsonl');
    const answers = await step('answers', { brand: 'Elanous', engines: ['grok'] }, { questions: { questions: ['Which assistant is best?'] } }, f.bin, f.root, callLog);
    expect(answers).toMatchObject({ calls: 1, errors: 1, outcome: 'fail' });
    expect(readFileSync(callLog, 'utf8').trim().split('\n')).toHaveLength(1);
  } finally { f.cleanup(); }
});


test('A5c — reworded evidence, ids and engine case still match; a bad item is dropped, not fatal; nothing valid retries once strictly', async () => {
  const f = fixture();
  try {
    const table = [
      { question: 'Which assistant is best?', engine: 'grok', error: 'credential unavailable', mention: false, citation: false },
      { question: 'How can I automate?', engine: 'openai-codex', mention: false, citation: false },
    ];
    const run = (replies: unknown[]) => step('suggest', { brand: 'Elanous' }, { score: { table } }, f.bin, f.root, undefined, {
      GEO_CHECK_SUGGEST_REPLIES: JSON.stringify(replies), GEO_CHECK_SUGGEST_COUNTER: join(f.root, `counter-${Math.random()}`),
    });
    // reworded question · engine case · id · numeric evidence · one hallucinated cell — the last is dropped
    const mixed = await run([[
      { suggestion: 'Add an FAQ: best assistant', evidence: { question: '  "Which assistant is best"?? ', engine: 'GROK' } },
      { suggestion: 'Publish Organization structured data', evidence: { id: 1 } },
      { suggestion: 'Write a comparison page', evidence: 0 },
      { suggestion: 'Invented', evidence: { question: 'Not in the table', engine: 'grok' } },
    ]]);
    expect(mixed).toMatchObject({ calls: 1, errors: 0 });
    expect(mixed.suggestions.map((s: any) => [s.suggestion, s.evidence.engine])).toEqual([
      ['Add an FAQ: best assistant', 'grok'], ['Publish Organization structured data', 'openai-codex'], ['Write a comparison page', 'grok'],
    ]);
    // nothing valid the first time → one strict retry succeeds
    const retried = await run([[{ suggestion: 'x', evidence: { question: 'nope' } }], [{ suggestion: 'Add FAQ', evidence: 1 }]]);
    expect(retried).toMatchObject({ calls: 2, errors: 0 });
    expect(retried.suggestions).toEqual([{ suggestion: 'Add FAQ', evidence: { question: 'How can I automate?', engine: 'openai-codex' } }]);
    // still nothing valid → the honest failure
    const failed = await run([[{ suggestion: 'x', evidence: 9 }], [{ suggestion: 'y', evidence: { question: 'nope' } }]]);
    expect(failed).toMatchObject({ outcome: 'fail', calls: 2, errors: 1, error: 'suggestion missing valid score evidence' });
  } finally { f.cleanup(); }
}, 30000);
