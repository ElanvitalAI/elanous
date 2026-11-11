import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';

type Data = Record<string, unknown>;
const asObject = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const str = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const sections = ['배경', '요구사항', '구성도', '데이터 흐름', '보안 등급', '비용 예측', '절감안', '대안', '결정 기록'];
const graphDir = import.meta.dir;
function resourcePaths(input: Data): { rendererDir: string; renderer: string; pdfConverter: string } {
  const candidates = [str(input.resourceRoot), str(process.env.ELANOUS_ARCHITECTURE_RESOURCE_ROOT), process.cwd(), resolve(graphDir, '../../..')].filter(Boolean);
  for (const root of candidates) {
    const rendererDir = join(root, 'skills/diagram-master/references');
    const renderer = join(rendererDir, 'engines/excalidraw/render_excalidraw.py');
    const pdfConverter = join(root, 'skills/lecture-note-digitizer/references/convert_to_pdf.py');
    if (existsSync(renderer) && existsSync(pdfConverter)) return { rendererDir, renderer, pdfConverter };
  }
  throw new Error('existing diagram-master and PDF resources missing; set absolute resourceRoot');
}

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  if (result.exitCode !== 0) throw new Error(`${command[0]} exited ${result.exitCode}: ${(stderr || stdout).slice(0, 450)}`);
  return stdout;
}
function filePath(raw: unknown, name: string): string {
  const path = str(raw);
  if (!path || !isAbsolute(path) || !existsSync(path)) throw new Error(`${name} must be an existing absolute path`);
  return path;
}
function validateHtml(html: string): void {
  for (const section of sections) {
    if (!new RegExp(`<h[1-6][^>]*>\\s*${section}\\s*</h[1-6]>`, 'iu').test(html)) throw new Error(`PDF section missing: ${section}`);
  }
  if (/(?:TODO|TBD|작성 예정|내용 입력|\{\{[^}]+\}\})/iu.test(html)) throw new Error('unfilled design placeholder');
}
function validateExcalidraw(source: string): number {
  const parsed = asObject(JSON.parse(source) as unknown);
  if (parsed.type !== 'excalidraw' || !Array.isArray(parsed.elements) || parsed.elements.length < 3) throw new Error('editable Excalidraw source missing or empty');
  return parsed.elements.length;
}
function validateReferenceQuality(html: string, source: string): { iconLibraryUrl: string; verifiedIcons: number } {
  for (const heading of ['목차', '요약', '부록']) {
    if (!new RegExp(`<h[1-6][^>]*>\\s*${heading}\\s*</h[1-6]>`, 'iu').test(html)) throw new Error(`reference PDF heading missing: ${heading}`);
  }
  if (!/<section[^>]*class="cover"/iu.test(html) || !/<img[^>]+src="architecture\.png"/iu.test(html) || !/<table\b/iu.test(html)) throw new Error('reference PDF requires cover, embedded diagram, and tables');
  const parsed = asObject(JSON.parse(source) as unknown);
  const elements = Array.isArray(parsed.elements) ? parsed.elements.map(asObject) : [];
  const labels = elements.map(element => str(element.text)).join(' ');
  const requiredLabels: Array<[string, RegExp]> = [
    ['project/account', /PROJECT|ACCOUNT/iu], ['region', /REGION/iu], ['VPC', /VPC/iu],
    ['users', /USERS|CLIENTS/iu], ['edge', /EDGE/iu], ['application', /APPLICATION|APP/iu],
    ['data', /DATA|LEDGER|DATABASE/iu], ['observability', /MONITORING|OBSERVABILITY|CLOUDWATCH/iu],
    ['security', /SECURITY|TRUST/iu], ['legend', /LEGEND/iu], ['version', /v\d+\.\d+/iu],
  ];
  for (const [name, pattern] of requiredLabels) if (!pattern.test(labels)) throw new Error(`reference diagram label missing: ${name}`);
  if ((labels.match(/[①②③④⑤⑥⑦⑧⑨]/gu) ?? []).length < 2) throw new Error('reference diagram needs numbered data flows');
  const imageFiles = asObject(parsed.files);
  const images = elements.filter(element => element.type === 'image' && str(element.fileId) && imageFiles[str(element.fileId)]);
  if (images.length < 3) throw new Error('reference diagram requires embedded official service icons');
  const metadata = asObject(parsed.metadata);
  const iconLibraryUrl = str(metadata.iconLibraryUrl);
  const registry = asObject(JSON.parse(readFileSync(join(graphDir, '../../../plugins/architecture-deliverables/references/official-gcp-icons.json'), 'utf8')) as unknown);
  if (iconLibraryUrl !== str(registry.libraryUrl)) throw new Error('official cloud icon library source missing');
  const knownAssets = asObject(registry.assets);
  const iconAssets = asObject(metadata.iconAssets);
  for (const image of images) {
    const fileId = str(image.fileId);
    const sourcePath = str(iconAssets[fileId]);
    const dataUrl = str(asObject(imageFiles[fileId]).dataURL);
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/u.exec(dataUrl);
    const expected = str(asObject(knownAssets[sourcePath]).sha256);
    if (!match || !expected || createHash('sha256').update(Buffer.from(match[1], 'base64')).digest('hex') !== expected) {
      throw new Error(`official icon provenance mismatch: ${fileId}`);
    }
  }
  return { iconLibraryUrl, verifiedIcons: images.length };
}

export function runArchitectureStep(): void {
try {
  const contextPath = filePath(process.env.ELANOUS_GRAPH_CONTEXT, 'ELANOUS_GRAPH_CONTEXT');
  const context = asObject(JSON.parse(readFileSync(contextPath, 'utf8')) as unknown);
  const input = asObject(context.input);
  const outDir = str(input.outDir) || join(dirname(contextPath), 'architecture-deliverables');
  if (!isAbsolute(outDir)) throw new Error('outDir must be absolute');
  const stageDir = outDir + '.staging';
  const htmlPath = join(stageDir, 'architecture.html');
  const sourcePath = join(stageDir, 'architecture.excalidraw');
  const pngPath = join(stageDir, 'architecture.png');
  const pdfPath = join(stageDir, 'architecture.pdf');
  const step = process.argv[2];

  if (step === 'design') {
    const designInput = filePath(input.designHtmlPath, 'designHtmlPath');
    const diagramInput = filePath(input.diagramSourcePath, 'diagramSourcePath');
    const html = readFileSync(designInput, 'utf8');
    const diagram = readFileSync(diagramInput, 'utf8');
    validateHtml(html);
    const elements = validateExcalidraw(diagram);
    const quality = validateReferenceQuality(html, diagram);
    rmSync(stageDir, { recursive: true, force: true });
    if (existsSync(outDir)) cpSync(outDir, stageDir, { recursive: true });
    else mkdirSync(stageDir, { recursive: true });
    for (const stale of ['verification.json', 'architecture.png', 'architecture.pdf']) rmSync(join(stageDir, stale), { force: true });
    copyFileSync(designInput, htmlPath);
    copyFileSync(diagramInput, sourcePath);
    console.log(JSON.stringify({ outcome: 'ok', htmlPath, sourcePath, elements, verifiedIcons: quality.verifiedIcons }));
  } else if (step === 'diagram') {
    const { rendererDir, renderer } = resourcePaths(input);
    validateExcalidraw(readFileSync(filePath(sourcePath, 'architecture.excalidraw'), 'utf8'));
    run(['uv', 'run', '--extra', 'python-engines', 'python', renderer, sourcePath, '--output', pngPath], rendererDir);
    if (!existsSync(pngPath) || readFileSync(pngPath).subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('diagram PNG not rendered');
    console.log(JSON.stringify({ outcome: 'ok', sourcePath, pngPath }));
  } else if (step === 'pdf') {
    const { rendererDir, pdfConverter } = resourcePaths(input);
    validateHtml(readFileSync(filePath(htmlPath, 'architecture.html'), 'utf8'));
    filePath(pngPath, 'architecture.png');
    run(['uv', 'run', '--extra', 'python-engines', 'python', pdfConverter, htmlPath], rendererDir);
    if (!existsSync(pdfPath) || readFileSync(pdfPath).subarray(0, 4).toString() !== '%PDF') throw new Error('architecture PDF not rendered');
    console.log(JSON.stringify({ outcome: 'ok', htmlPath, pdfPath }));
  } else if (step === 'verify') {
    const diagram = readFileSync(filePath(sourcePath, 'architecture.excalidraw'), 'utf8');
    const html = readFileSync(filePath(htmlPath, 'architecture.html'), 'utf8');
    const elements = validateExcalidraw(diagram);
    validateHtml(html);
    const quality = validateReferenceQuality(html, diagram);
    const png = readFileSync(filePath(pngPath, 'architecture.png'));
    const pdf = readFileSync(filePath(pdfPath, 'architecture.pdf'));
    if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('PNG signature invalid');
    if (pdf.subarray(0, 4).toString() !== '%PDF') throw new Error('PDF signature invalid');
    const text = run(['pdftotext', '-layout', pdfPath, '-'], stageDir);
    const missing = sections.filter(section => !text.includes(section));
    if (missing.length) throw new Error(`PDF text missing sections: ${missing.join(', ')}`);
    for (const heading of ['목차', '요약', '부록']) if (!text.includes(heading)) throw new Error(`PDF text missing ${heading}`);
    const pdfInfo = run(['pdfinfo', pdfPath], stageDir);
    const pages = Number(pdfInfo.match(/^Pages:\s+(\d+)/mu)?.[1]);
    if (!Number.isFinite(pages) || pages < 4) throw new Error('reference PDF requires at least four pages');
    const receipt = { status: 'verified', contract: 'system-architecture/cloud-expansion@2', quality: 'reference', pages, iconLibraryUrl: quality.iconLibraryUrl, verifiedIcons: quality.verifiedIcons, files: ['architecture.excalidraw', 'architecture.png', 'architecture.html', 'architecture.pdf'], pdfSections: sections, elements, pngBytes: png.length, pdfBytes: pdf.length };
    writeFileSync(join(stageDir, 'verification.json'), JSON.stringify(receipt, null, 2) + '\n');
    const backupDir = outDir + '.previous';
    rmSync(backupDir, { recursive: true, force: true });
    if (existsSync(outDir)) renameSync(outDir, backupDir);
    try { renameSync(stageDir, outDir); }
    catch (error) { if (existsSync(backupDir)) renameSync(backupDir, outDir); throw error; }
    rmSync(backupDir, { recursive: true, force: true });
    console.log(JSON.stringify({ outcome: 'ok', outDir, receipt }));
  } else throw new Error(`unknown step ${step}`);
} catch (error) {
  console.log(JSON.stringify({ outcome: 'fail', error: error instanceof Error ? error.message : String(error) }));
}

}
if (import.meta.main) runArchitectureStep();
