import { afterEach, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseGraphTemplateYaml } from '../../src/self-implement/graph-yaml.js';
import { decideGraphApproval, runGraph } from '../../src/graph-runner/runner.js';
import { debug } from '../../src/debug/log.js';
import { collect, draft, html, pdf, render, runStage } from './node.js';

const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });
const folder = () => {
  const path = mkdtempSync(join(tmpdir(), 'lecture-note-test-'));
  fixtures.push(path);
  return path;
};

const graphPath = resolve(import.meta.dir, '../../graphs/lecture/lecture-note.yaml');

test('collect → draft → render without renderer → html → skipped pdf; only output subtree changes', async () => {
  const dir = folder();
  const summary = '# 강의 요약\n강의 순서와 원칙';
  writeFileSync(join(dir, 'summary.md'), summary);
  writeFileSync(join(dir, 'sketch.png'), 'image stays untouched');
  const out = join(dir, 'lecture-note');
  const opts = { toolsPath: '', llm: async (prompt: string) => {
    expect(prompt).toContain(summary);
    expect(prompt).toContain('Mermaid 우선');
    return '# 강의 노트\n## 개념\n수식 \\( E = mc^2 \\)는 에너지다.\n> 강조 \\( x^2 + y^2 = z^2 \\)\n```mermaid\nflowchart TB\n A-->B\n```\n## 결론\n```mermaid\nflowchart LR\n B-->C\n```';
  } };
  expect(collect(dir, opts).inputs).toBe(2);
  expect(JSON.parse(readFileSync(join(out, 'inputs.json'), 'utf8')).map((i: { kind: string }) => i.kind).sort()).toEqual(['image', 'markdown']);
  expect((await draft(dir, opts)).diagrams).toBe(2);
  expect([...readFileSync(join(out, 'notes.md'), 'utf8').matchAll(/```mermaid/g)]).toHaveLength(2);
  const renderLog = spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(render(dir, opts)).toMatchObject({ diagrams: 2, rendered: 0 });
    expect(renderLog).toHaveBeenCalledWith('렌더러 없음: 2');
  } finally { renderLog.mockRestore(); }
  expect(html(dir, opts).html).toBe('yes');
  const page = readFileSync(join(out, 'notes.html'), 'utf8');
  expect([...page.matchAll(/<pre><code class="language-mermaid">/g)]).toHaveLength(2);
  expect(page).toContain('수식 \\( E = mc^2 \\)는 에너지다.');
  expect(page).toContain('<blockquote>\n<p>강조 \\( x^2 + y^2 = z^2 \\)</p>\n</blockquote>');
  expect(page).toContain('<div class="toc">');
  expect(page).toContain('href="#sec-1"');
  expect(page).not.toContain('<img src="diagram-');
  const pdfLog = spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(pdf(dir, opts)).toMatchObject({ outcome: 'skipped', pdf: 'skipped', inputs: 2, diagrams: 2, rendered: 0, html: 'yes' });
    expect(pdfLog).toHaveBeenCalledWith('PDF 엔진 없음 — HTML 이 산출물');
  } finally { pdfLog.mockRestore(); }
  expect(readdirSync(dir).sort()).toEqual(['lecture-note', 'sketch.png', 'summary.md']);
  expect(readFileSync(join(dir, 'sketch.png'), 'utf8')).toBe('image stays untouched');
  expect(readFileSync(join(dir, 'summary.md'), 'utf8')).toBe(summary);
  expect(readdirSync(out).sort()).toEqual(['inputs.json', 'notes.html', 'notes.md']);
});

test('stage observation reports the lecture note counts', async () => {
  const dir = folder();
  writeFileSync(join(dir, 'summary.md'), '강의 내용');
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const result = await runStage('collect', dir, { toolsPath: '' });
    expect(result.inputs).toBe(1);
    expect(log).toHaveBeenCalledWith('lecture.note', 'collect', {
      inputs: 1, diagrams: 0, rendered: 0, pdf: 'skipped',
    });
  } finally { log.mockRestore(); }
});

test('graph runner template validates and requires an approval before rendering', () => {
  const source = readFileSync(graphPath, 'utf8');
  const parsed = parseGraphTemplateYaml(source, graphPath);
  expect(parsed.errors).toEqual([]);
  expect(parsed.template?.graphId).toBe('lecture-note');
  const doc = parseYaml(source) as { loop: { exec_request: boolean; inputs: string[]; trigger: { events: string[] } } };
  expect(doc.loop).toMatchObject({ exec_request: true, inputs: ['folder'], trigger: { events: ['manual'] } });
  const template = parsed.template!;
  expect(template.nodes.map(n => n.nodeId)).toEqual(['collect', 'draft', 'confirm', 'render', 'html', 'pdf', 'done', 'failed']);
  expect(template.nodes.find(n => n.nodeId === 'confirm')).toMatchObject({ kind: 'hitl', recipe: 'approval:confirm' });
  expect(template.edges.find(e => e.from === 'draft')?.map?.ok).toBe('confirm');
  expect(template.edges.find(e => e.from === 'confirm')?.map?.ok).toBe('render');
  expect(template.edges.find(e => e.from === 'pdf')?.map).toMatchObject({ ok: 'done', skipped: 'done', fail: 'failed', error: 'failed' });
  for (const stage of ['collect', 'draft', 'render', 'html']) expect(template.edges.find(e => e.from === stage)?.map?.fail).toBe('failed');
  const recipes = parseYaml(readFileSync(join(import.meta.dir, '../../graphs/lecture/recipes.yaml'), 'utf8')) as Record<string, { command?: string; approval?: string }>;
  expect(recipes.confirm?.approval).toBe('{"kind":"lecture-outline"}');
  for (const stage of ['collect', 'draft', 'render', 'html', 'pdf']) expect(recipes[stage]?.command).toBe(`bun "$ELANOUS_GRAPH_DIR/../../scripts/lecture-note/node.ts" ${stage}`);
});

test('PDF collection without pdftotext records absence; HTML uses rendered PNG and preserves tables', async () => {
  const dir = folder();
  writeFileSync(join(dir, 'handout.pdf'), '%PDF-1.4');
  const opts = { toolsPath: '', llm: async () => '# 강의 노트\n<a id="part1"></a>\n## 첫 부분\n| 항목 | 값 |\n| --- | --- |\n| 개념 | 비교 |\n```mermaid\nflowchart LR\n A-->B\n```\n---\n\n<a id="appendix"></a>\n# 부록: 다이어그램 목록\n| # | 파일명 |' };
  collect(dir, opts);
  const out = join(dir, 'lecture-note');
  const inputs = JSON.parse(readFileSync(join(out, 'inputs.json'), 'utf8')) as { name: string; kind: string; text: string }[];
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toMatchObject({ name: 'handout.pdf', kind: 'pdf', text: 'PDF 텍스트 없음 — pdftotext 없음' });
  await draft(dir, opts);
  writeFileSync(join(out, 'diagram-1.png'), 'fake rendered image');
  expect(html(dir, opts).rendered).toBe(1);
  const page = readFileSync(join(out, 'notes.html'), 'utf8');
  expect(page).toContain('<img src="diagram-1.png" alt="diagram-1">');
  expect(page).toContain('<table>');
  expect(page).toContain('<a id="part1"></a>');
  expect(page).not.toContain('부록: 다이어그램 목록');
  expect(readFileSync(join(out, 'notes.md'), 'utf8')).toContain('부록: 다이어그램 목록');
});

test('graph execution pauses at confirm; PDF skipped still finishes', async () => {
  const root = folder();
  const calls: string[] = [];
  const runBash = async (command: string) => {
    const stage = command.match(/node\.ts\" (collect|draft|render|html|pdf)/)?.[1];
    if (!stage) throw new Error(`unexpected command: ${command}`);
    calls.push(stage);
    return { stdout: `lecture-note /tmp inputs=1 diagrams=0 rendered=0 html=yes pdf=skipped\n${JSON.stringify({ outcome: stage === 'pdf' ? 'skipped' : 'ok' })}\n`, stderr: '', exitCode: 0 };
  };
  const deps = { root, runBash, processStartMs: () => null };
  const pending = await runGraph(graphPath, { input: { folder: root }, deps });
  expect(pending.status).toBe('awaiting-approval');
  expect(pending.pending?.nodeId).toBe('confirm');
  expect(pending.pending?.message).toBe('{"kind":"lecture-outline"}');
  expect(calls).toEqual(['collect', 'draft']);
  decideGraphApproval('lecture-note', pending.runId, 'approved', 'human', root);
  const finished = await runGraph(graphPath, { resumeRunId: pending.runId, deps });
  expect(finished.status).toBe('done');
  expect(finished.path).toEqual(['collect', 'draft', 'confirm', 'render', 'html', 'pdf', 'done']);
  expect(calls).toEqual(['collect', 'draft', 'render', 'html', 'pdf']);
});

test('renderer execution error fails rather than reporting renderer absence', async () => {
  const dir = folder();
  writeFileSync(join(dir, 'summary.md'), '강의');
  collect(dir, { toolsPath: '' });
  await draft(dir, { llm: async () => '# 강의\n```mermaid\nflowchart LR\n A-->B\n```' });
  const tools = join(dir, 'fake-tools');
  mkdirSync(tools);
  const uv = join(tools, 'uv');
  writeFileSync(uv, '#!/bin/sh\necho "invalid mermaid" >&2\nexit 2\n');
  chmodSync(uv, 0o755);
  expect(() => render(dir, { toolsPath: tools })).toThrow('Mermaid 렌더 실패 (diagram-1, exit=2): invalid mermaid');
  expect(readdirSync(join(dir, 'lecture-note')).sort()).toEqual(['diagram-1.mmd', 'inputs.json', 'notes.md']);
});

test('PDF conversion error fails, but a missing Playwright engine skips', () => {
  const dir = folder();
  const out = join(dir, 'lecture-note');
  mkdirSync(out);
  writeFileSync(join(out, 'notes.html'), '<html></html>');
  const tools = join(dir, 'fake-tools');
  mkdirSync(tools);
  const python = join(tools, 'python3');
  writeFileSync(python, '#!/bin/sh\necho "conversion error" >&2\nexit 2\n');
  chmodSync(python, 0o755);
  expect(() => pdf(dir, { toolsPath: tools })).toThrow('PDF 변환 실패 (exit=2): conversion error');
  writeFileSync(python, '#!/bin/sh\necho "ModuleNotFoundError: No module named \'playwright\'" >&2\nexit 1\n');
  expect(pdf(dir, { toolsPath: tools })).toMatchObject({ outcome: 'skipped', pdf: 'skipped' });
  writeFileSync(python, '#!/bin/sh\necho "BrowserType.launch: Executable doesn\x27t exist at /missing/chromium" >&2\nexit 1\n');
  expect(pdf(dir, { toolsPath: tools })).toMatchObject({ outcome: 'skipped', pdf: 'skipped' });
});

test('PDF failure after human approval reaches failed, unlike engine absence', async () => {
  const root = folder();
  const deps = { root, processStartMs: () => null, runBash: async (command: string) => ({
    stdout: `${JSON.stringify({ outcome: command.endsWith(' pdf') ? 'fail' : 'ok' })}\n`,
    stderr: '', exitCode: command.endsWith(' pdf') ? 1 : 0,
  }) };
  const pending = await runGraph(graphPath, { input: { folder: root }, deps });
  expect(pending.status).toBe('awaiting-approval');
  decideGraphApproval('lecture-note', pending.runId, 'approved', 'human', root);
  const finished = await runGraph(graphPath, { resumeRunId: pending.runId, deps });
  expect(finished.status).toBe('failed');
  expect(finished.path).toEqual(['collect', 'draft', 'confirm', 'render', 'html', 'pdf', 'failed']);
});

test('collect reads shared course materials without modifying sources/common', () => {
  const dir = folder();
  const common = join(dir, 'sources/common');
  mkdirSync(common, { recursive: true });
  writeFileSync(join(common, 'syllabus.md'), '강의 계획');
  expect(collect(dir, { toolsPath: '' }).inputs).toBe(1);
  expect(JSON.parse(readFileSync(join(dir, 'lecture-note/inputs.json'), 'utf8'))[0])
    .toMatchObject({ name: 'sources/common/syllabus.md', text: '강의 계획' });
  expect(readdirSync(common)).toEqual(['syllabus.md']);
});

test('CLI reads graph context and ends with an outcome JSON for graph runner', () => {
  const dir = folder();
  writeFileSync(join(dir, 'summary.md'), '# 요약');
  const result = spawnSync(process.execPath, [join(import.meta.dir, 'node.ts'), 'collect'], {
    encoding: 'utf8', env: { ...process.env, ELANOUS_GRAPH_CONTEXT: JSON.stringify({ input: { folder: dir } }) },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`lecture-note ${dir} inputs=1 diagrams=0 rendered=0 html=no pdf=skipped`);
  expect(result.stdout.trim().split('\n').at(-1)).toBe('{"outcome":"ok"}');
  expect(readdirSync(dir).sort()).toEqual(['lecture-note', 'summary.md']);
});

test('dangling symlink at an output artifact cannot redirect or be overwritten', () => {
  const dir = folder();
  const target = join(folder(), 'elsewhere.json');
  mkdirSync(join(dir, 'lecture-note'));
  symlinkSync(target, join(dir, 'lecture-note/inputs.json'));
  writeFileSync(join(dir, 'summary.md'), 'untouched');
  expect(() => collect(dir)).toThrow('출력 파일이 안전하지 않다');
  expect(readdirSync(resolve(target, '..'))).toEqual([]);
});

test('a symlinked output directory cannot escape the lecture folder', () => {
  const dir = folder();
  const elsewhere = folder();
  writeFileSync(join(dir, 'summary.md'), 'untouched');
  symlinkSync(elsewhere, join(dir, 'lecture-note'));
  expect(() => collect(dir)).toThrow('출력 폴더가 안전하지 않다');
  expect(readdirSync(elsewhere)).toEqual([]);
});
