#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { debug } from '../../src/debug/log.js';
import { streamLLM } from '../../src/llm.js';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';

export type Stage = 'collect' | 'draft' | 'render' | 'html' | 'pdf';
export interface Input { name: string; kind: 'pdf' | 'image' | 'markdown'; text: string }
export interface Counts { inputs: number; diagrams: number; rendered: number; html: 'yes' | 'no'; pdf: 'yes' | 'skipped' }
export interface StageResult extends Counts { outcome: 'ok' | 'skipped' }
export interface StageOptions {
  llm?: (prompt: string) => Promise<string>;
  toolsPath?: string;
  referenceRoot?: string;
}

const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../skills');
const kinds: Record<string, Input['kind']> = {
  '.pdf': 'pdf', '.md': 'markdown', '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image',
};
const mermaid = /^```mermaid\s*\n([\s\S]*?)^```\s*$/gm;
const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function pathStatus(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function outputDir(folder: string): string {
  if (!lstatSync(folder).isDirectory()) throw new Error(`강의 폴더가 아니다: ${folder}`);
  const dir = join(resolve(folder), 'lecture-note');
  const status = pathStatus(dir);
  if (status && (status.isSymbolicLink() || !status.isDirectory())) throw new Error('lecture-note 출력 폴더가 안전하지 않다');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function artifact(dir: string, name: string): string {
  const path = join(dir, name);
  const status = pathStatus(path);
  if (status && (status.isSymbolicLink() || !status.isFile())) throw new Error(`출력 파일이 안전하지 않다: ${path}`);
  return path;
}

function binary(name: string, path = process.env.PATH ?? ''): string | undefined {
  for (const part of path.split(':').filter(Boolean)) {
    const at = join(part, name);
    if (existsSync(at) && statSync(at).isFile()) return at;
  }
  return undefined;
}

function run(bin: string, args: string[], dir: string, timeout: number): ReturnType<typeof spawnSync> {
  return spawnSync(bin, args, { cwd: dir, encoding: 'utf8', timeout, maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, HOME: dir, XDG_CACHE_HOME: dir, XDG_CONFIG_HOME: dir, UV_CACHE_DIR: dir, PYTHONDONTWRITEBYTECODE: '1' } });
}

function readInputs(dir: string): Input[] {
  const value: unknown = JSON.parse(readFileSync(join(dir, 'inputs.json'), 'utf8'));
  if (!Array.isArray(value) || !value.every((item) => item && typeof item.name === 'string' && typeof item.kind === 'string' && typeof item.text === 'string')) {
    throw new Error('inputs.json 형식 오류');
  }
  return value as Input[];
}

function counts(dir: string): Counts {
  const inputs = existsSync(join(dir, 'inputs.json')) ? readInputs(dir).length : 0;
  const notes = existsSync(join(dir, 'notes.md')) ? readFileSync(join(dir, 'notes.md'), 'utf8') : '';
  const diagrams = [...notes.matchAll(mermaid)].length;
  const rendered = [...Array(diagrams).keys()].filter(i => existsSync(join(dir, `diagram-${i + 1}.png`))).length;
  return { inputs, diagrams, rendered, html: existsSync(join(dir, 'notes.html')) ? 'yes' : 'no', pdf: existsSync(join(dir, 'notes.pdf')) ? 'yes' : 'skipped' };
}

export function collect(folder: string, options: StageOptions = {}): StageResult {
  const dir = outputDir(folder);
  const files: Input[] = [];
  const pdfText = binary('pdftotext', options.toolsPath);
  const sources = resolve(folder, 'sources/common');
  const scan = [{ base: folder, prefix: '' }, ...(pathStatus(sources)?.isDirectory() && !pathStatus(sources)?.isSymbolicLink()
    ? [{ base: sources, prefix: 'sources/common/' }] : [])];
  for (const { base, prefix } of scan) for (const entry of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const kind = kinds[extname(entry.name).toLowerCase()];
    if (!entry.isFile() || !kind) continue;
    const at = join(base, entry.name);
    const text = kind === 'markdown' ? readFileSync(at, 'utf8') : kind === 'image' ? '이미지 — 시각 자료 (텍스트 추출 없음)' :
      pdfText ? (() => {
        const result = run(pdfText, ['-layout', at, '-'], dir, 60000);
        return result.status === 0 ? String(result.stdout) : 'PDF 텍스트 없음 — pdftotext 추출 실패';
      })() : 'PDF 텍스트 없음 — pdftotext 없음';
    files.push({ name: prefix + entry.name, kind, text });
  }
  writeFileSync(artifact(dir, 'inputs.json'), JSON.stringify(files, null, 2) + '\n');
  return { ...counts(dir), outcome: 'ok' };
}

const instructions = `강의 자료로 종합 디지털 강의 노트 Markdown만 작성하라.
강의 진행 순서를 유지하고 손필기/슬라이드의 시각 정보와 요약의 텍스트를 통합하라. 읽지 못한 이미지는 추측하지 말고 출처를 표시하라.
다이어그램은 Mermaid 우선으로 해당 설명 위치에 \`\`\`mermaid 코드블록으로 내장하라 (곡선·자유형은 코드로 억지 변환하지 않는다).
비교·분류는 표로, 실제 사례는 별도 사례 박스로, 핵심 원칙은 인용문으로 표시하라.
수식은 KaTeX 인라인 \\( ... \\) 형식, 강조 수식은 > \\( ... \\) 형식으로 쓰고 $$ 블록 수식이나 볼드/코드 수식은 쓰지 마라.
강의 개요 바로 아래에 해당 주차 신규 용어집 표(| 약어 | 영문 | 한국어 | 정의 |)를 배치하라.
목차와 각 헤딩 위의 영문 앵커를 만들고, 맨 끝에 다이어그램 목록 부록을 둬라. 근거 없는 내용은 만들어내지 마라.`;

export async function draft(folder: string, options: StageOptions = {}): Promise<StageResult> {
  const dir = outputDir(folder);
  const inputs = readInputs(dir);
  if (!inputs.length) throw new Error('강의 자료가 없다');
  const prompt = `${instructions}\n\n자료:\n${inputs.map(i => `### ${i.name} (${i.kind})\n${i.text}`).join('\n\n')}`;
  const ask = options.llm ?? ((request: string) => streamLLM([{ role: 'user', content: request }], () => {}));
  const notes = (await ask(prompt)).trim();
  if (!notes) throw new Error('LLM 초안이 비었다');
  writeFileSync(artifact(dir, 'notes.md'), notes + '\n');
  return { ...counts(dir), outcome: 'ok' };
}

export function render(folder: string, options: StageOptions = {}): StageResult {
  const dir = outputDir(folder);
  const notes = readFileSync(join(dir, 'notes.md'), 'utf8');
  const renderer = join(options.referenceRoot ?? ownRoot, 'diagram-master/references/engines/mermaid/render_mermaid.py');
  const uv = binary('uv', options.toolsPath);
  let unavailable = 0;
  for (const [i, match] of [...notes.matchAll(mermaid)].entries()) {
    const png = artifact(dir, `diagram-${i + 1}.png`);
    if (existsSync(png)) rmSync(png);
    if (!uv || !existsSync(renderer)) { unavailable++; continue; }
    const mmd = artifact(dir, `diagram-${i + 1}.mmd`);
    writeFileSync(mmd, match[1]!);
    const result = run(uv, ['run', 'python', renderer, mmd, '--output', png], dir, 120000);
    if (result.status !== 0 || !existsSync(png)) {
      if (existsSync(png)) rmSync(png);
      throw new Error(`Mermaid 렌더 실패 (diagram-${i + 1}, exit=${result.status}): ${result.error?.message ?? result.stderr ?? result.stdout ?? 'PNG 없음'}`);
    }
  }
  if (unavailable) console.log(`렌더러 없음: ${unavailable}`);
  return { ...counts(dir), outcome: 'ok' };
}

function markdownHtml(text: string): string {
  let suffix = 0;
  while (text.includes(`LECTUREMATHOPEN${suffix}`) || text.includes(`LECTUREMATHCLOSE${suffix}`)) suffix++;
  const open = `LECTUREMATHOPEN${suffix}`;
  const close = `LECTUREMATHCLOSE${suffix}`;
  const protectedText = text.replace(/\\\(/g, open).replace(/\\\)/g, close);
  return String(unified().use(remarkParse).use(remarkGfm)
    .use(remarkRehype).use(rehypeSanitize).use(rehypeStringify).processSync(protectedText))
    .replaceAll(open, '\\(').replaceAll(close, '\\)');
}

export function html(folder: string, options: StageOptions = {}): StageResult {
  const dir = outputDir(folder);
  const notes = readFileSync(join(dir, 'notes.md'), 'utf8');
  const template = readFileSync(join(options.referenceRoot ?? ownRoot, 'lecture-note-digitizer/references/html-template.md'), 'utf8');
  const css = template.match(/```css\n([\s\S]*?)\n```/)?.[1];
  if (!css) throw new Error('HTML 템플릿 CSS 없음');
  let n = 0;
  const withoutAppendix = notes.replace(/\n(?:---\n\n)?(?:<a id="appendix"><\/a>\n)?#+ 부록: 다이어그램 목록[\s\S]*$/u, '');
  const anchored = withoutAppendix.replace(/^<a id="([a-zA-Z0-9-]+)"><\/a>$/gm, (_match, id: string) => `\n\nLECTURE_ANCHOR_${id}_END\n\n`);
  const body = markdownHtml(anchored.replace(mermaid, (_block, source: string) => {
    const png = `diagram-${++n}.png`;
    return existsSync(join(dir, png)) ? `\n\n![diagram-${n}](${png})\n\n` : `\n\n\`\`\`mermaid\n${source}\`\`\`\n\n`;
  })).replace(/<p><img src="(diagram-\d+\.png)" alt="(diagram-\d+)"><\/p>/g,
    '<div class="diagram-container"><img src="$1" alt="$2"></div>')
    .replace(/<p>LECTURE_ANCHOR_([a-zA-Z0-9-]+)_END<\/p>/g, '<a id="$1"></a>');
  const title = notes.match(/^# (.+)$/m)?.[1] ?? '강의 노트';
  const sections: string[] = [];
  let heading = 0;
  const numbered = body.replace(/<(h[12])>(.*?)<\/\1>/g, (_m, tag: string, label: string) => {
    const id = `sec-${++heading}`;
    sections.push(`<li><a href="#${id}">${label}</a></li>`);
    return `<${tag} id="${id}">${label}</${tag}>`;
  });
  const page = `<!DOCTYPE html>\n<html lang="ko"><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>` +
    '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">' +
    '<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>' +
    '<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js" onload="renderMathInElement(document.body,{delimiters:[{left:\'\\\\(\',right:\'\\\\)\',display:false}]});"></script>' +
    `<style>${css}</style></head><body><div class="cover"><h1>${escapeHtml(title)}</h1></div>` +
    `<div class="toc"><h2>목차</h2><ol>${sections.join('\n')}</ol></div><div class="section">${numbered}</div></body></html>\n`;
  writeFileSync(artifact(dir, 'notes.html'), page);
  return { ...counts(dir), outcome: 'ok' };
}

export function pdf(folder: string, options: StageOptions = {}): StageResult {
  const dir = outputDir(folder);
  const source = artifact(dir, 'notes.html');
  if (!existsSync(source)) throw new Error('notes.html 없음');
  const converter = join(options.referenceRoot ?? ownRoot, 'lecture-note-digitizer/references/convert_to_pdf.py');
  const python = binary('python3', options.toolsPath);
  const target = artifact(dir, 'notes.pdf');
  if (existsSync(target)) throw new Error('기존 notes.pdf 를 덮어쓰지 않는다');
  const result = python && existsSync(converter) ? run(python, [converter, source], dir, 120000) : undefined;
  const engineMissing = !result || (result.status !== 0 && !result.error &&
    (/^ModuleNotFoundError: No module named ['"]playwright['"]$/m.test(String(result.stderr)) ||
      /BrowserType\.launch: Executable doesn't exist at/.test(String(result.stderr))));
  if (engineMissing) {
    if (existsSync(target)) rmSync(target);
    console.log('PDF 엔진 없음 — HTML 이 산출물');
    return { ...counts(dir), pdf: 'skipped', outcome: 'skipped' };
  }
  if (result && (result.status !== 0 || !existsSync(target))) {
    if (existsSync(target)) rmSync(target);
    throw new Error(`PDF 변환 실패 (exit=${result.status}): ${result.error?.message ?? result.stderr ?? result.stdout ?? 'PDF 없음'}`);
  }
  return { ...counts(dir), outcome: 'ok' };
}

export async function runStage(stage: Stage, folder: string, options: StageOptions = {}): Promise<StageResult> {
  const result = stage === 'collect' ? collect(folder, options) : stage === 'draft' ? await draft(folder, options) :
    stage === 'render' ? render(folder, options) : stage === 'html' ? html(folder, options) : pdf(folder, options);
  debug.log('lecture.note', stage, { inputs: result.inputs, diagrams: result.diagrams, rendered: result.rendered, pdf: result.pdf });
  return result;
}

function folderFromContext(): string {
  const arg = process.argv.indexOf('--folder');
  if (arg >= 0) {
    const folder = process.argv[arg + 1];
    if (!folder) throw new Error('--folder 값 없음');
    return resolve(folder.replace(/^~(?=\/)/, homedir()));
  }
  const context = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!context) throw new Error('input.folder 필요');
  const data: unknown = JSON.parse(context.trim().startsWith('{') ? context : readFileSync(context, 'utf8'));
  const folder = (data as { input?: { folder?: unknown } })?.input?.folder;
  if (typeof folder !== 'string' || !folder.trim()) throw new Error('input.folder 필요');
  const expanded = folder.replace(/^~(?=\/)/, homedir());
  if (!isAbsolute(expanded)) throw new Error('input.folder 절대 경로 필요');
  return resolve(expanded);
}

if (import.meta.main) {
  const stage = process.argv[2];
  if (!['collect', 'draft', 'render', 'html', 'pdf'].includes(stage ?? '')) throw new Error('stage: collect|draft|render|html|pdf');
  let folder = '';
  try {
    folder = folderFromContext();
    const result = await runStage(stage as Stage, folder);
    console.log(`lecture-note ${folder} inputs=${result.inputs} diagrams=${result.diagrams} rendered=${result.rendered} html=${result.html} pdf=${result.pdf}`);
    console.log(JSON.stringify({ outcome: result.outcome }));
  } catch (error) {
    console.error(error);
    console.log(JSON.stringify({ outcome: 'fail', reason: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
