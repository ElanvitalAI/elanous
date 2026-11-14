import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { generateStructuredDesign } from './structured-design.js';
import { missingPdfBodySections } from './pdf-body.js';

type Data = Record<string, unknown>;
const asObject = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const str = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const sections = ['배경', '요구사항', '구성도', '데이터 흐름', '보안 등급', '비용 예측', '절감안', '대안', '결정 기록'];
const graphDir = import.meta.dir;
const pluginRoot = str(process.env.ELANOUS_ARCHITECTURE_PLUGIN_ROOT) || resolve(graphDir, '../../../plugins/architecture-deliverables');
type OwnedRun = { outDir: string; lockPath: string; stageDir: string };
const outputFiles = ['architecture.html', 'architecture.excalidraw', 'architecture.png', 'architecture.pdf', 'verification.json'];
const bundleRootName = '.architecture-bundles';
const currentName = '.architecture-current';
function pathExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function assertOutputDirectory(outDir: string): void {
  if (pathExists(outDir) && !lstatSync(outDir).isDirectory()) throw new Error('outDir must be a real directory');
}
function publishOutputs(outDir: string, stageDir: string): void {
  assertOutputDirectory(outDir);
  mkdirSync(outDir, { recursive: true });
  const bundleRoot = join(outDir, bundleRootName);
  if (pathExists(bundleRoot) && !lstatSync(bundleRoot).isDirectory()) throw new Error('architecture bundle root must be a real directory');
  mkdirSync(bundleRoot, { recursive: true });
  const generation = basename(stageDir);
  const bundleDir = join(bundleRoot, generation);
  const current = join(outDir, currentName);
  const firstPublish = !pathExists(current);
  if (firstPublish) for (const name of outputFiles) {
    const target = join(outDir, name);
    if (pathExists(target) && lstatSync(target).isDirectory())
      throw new Error(`architecture output path is a directory: ${name}`);
  }
  if (!firstPublish && (!lstatSync(current).isSymbolicLink() || !readlinkSync(current).startsWith(`${bundleRootName}/.architecture-stage-`)))
    throw new Error('architecture current pointer is not owned by this publisher');
  if (!firstPublish) for (const name of outputFiles) {
    const target = join(outDir, name);
    if (!pathExists(target) || !lstatSync(target).isSymbolicLink() || readlinkSync(target) !== `${currentName}/${name}`)
      throw new Error(`architecture output alias changed: ${name}`);
  }
  const backupDir = firstPublish ? mkdtempSync(join(dirname(outDir), '.architecture-backup-')) : '';
  const backedUp: string[] = [];
  const installed: string[] = [];
  const nextPointer = join(outDir, `.architecture-next-${generation}`);
  let committed = false;
  try {
    // A complete, immutable generation is prepared before the only publication step.
    renameSync(stageDir, bundleDir);
    if (firstPublish) {
      // In the one-time migration, revoke the old receipt before changing any artifact.
      for (const name of [...outputFiles].reverse()) {
        const target = join(outDir, name);
        if (pathExists(target)) { renameSync(target, join(backupDir, name)); backedUp.push(name); }
      }
      for (const name of outputFiles) {
        symlinkSync(`${currentName}/${name}`, join(outDir, name));
        installed.push(name);
      }
    }
    symlinkSync(`${bundleRootName}/${generation}`, nextPointer);
    renameSync(nextPointer, current); // Atomic pointer replacement; readers see one complete generation.
    committed = true;
  } catch (error) {
    if (committed) throw error;
    try {
      if (pathExists(nextPointer)) rmSync(nextPointer);
      for (const name of installed.reverse()) rmSync(join(outDir, name), { force: true });
      for (const name of backedUp.reverse()) renameSync(join(backupDir, name), join(outDir, name));
      if (pathExists(bundleDir)) renameSync(bundleDir, stageDir);
    } catch (rollbackError) {
      throw new Error(`architecture output rollback failed; previous files retained in ${backupDir}: ${String(rollbackError)}`, { cause: error });
    }
    throw error;
  }
  if (backupDir) rmSync(backupDir, { recursive: true, force: true });
}
function stageOwnedBy(run: OwnedRun): boolean {
  if (!isAbsolute(run.stageDir) || dirname(run.stageDir) !== dirname(run.outDir) || !basename(run.stageDir).startsWith('.architecture-stage-')) return false;
  if (!existsSync(run.stageDir) || lstatSync(run.stageDir).isSymbolicLink() || !existsSync(join(run.stageDir, '.architecture-owned'))) return false;
  return readFileSync(join(run.stageDir, '.architecture-owned'), 'utf8') === run.outDir;
}
function releaseOwnedRun(run: OwnedRun): void {
  if (!existsSync(run.lockPath)) return;
  let lock: Data;
  try { lock = asObject(JSON.parse(readFileSync(run.lockPath, 'utf8')) as unknown); } catch { return; }
  if (str(lock.outDir) !== run.outDir || str(lock.stageDir) !== run.stageDir) return;
  if (stageOwnedBy(run)) rmSync(run.stageDir, { recursive: true, force: true });
  else if (existsSync(join(run.outDir, '.architecture-owned')) && readFileSync(join(run.outDir, '.architecture-owned'), 'utf8') === run.outDir)
    rmSync(join(run.outDir, '.architecture-owned'), { force: true });
  rmSync(run.lockPath, { force: true });
}
function resourcePaths(input: Data): { rendererDir: string; renderer: string; pdfConverter: string } {
  const candidates = [str(input.resourceRoot), str(process.env.ELANOUS_ARCHITECTURE_RESOURCE_ROOT), process.cwd(), resolve(graphDir, '../../..')].filter(Boolean);
  for (const root of candidates) {
    const rendererDir = join(root, 'skills/diagram-master/references');
    const renderer = join(rendererDir, 'engines/excalidraw/render_excalidraw.py');
    const pdfConverter = join(root, 'skills/lecture-note-digitizer/references/convert_to_pdf.py');
    if (existsSync(renderer) && existsSync(pdfConverter)) return { rendererDir, renderer, pdfConverter };
  }
  throw new Error('도면·PDF 리소스를 찾을 수 없습니다 — 설치본의 저장소 절대 경로를 resourceRoot로 지정하세요');
}

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  if (result.exitCode !== 0) throw new Error(`${command[0]} exited ${result.exitCode}: ${(stderr || stdout).slice(0, 450)}`);
  return stdout;
}
function ensureRendererAddon(rendererDir: string): void {
  const hint = `cd ${rendererDir} && uv sync --extra python-engines && uv run --extra python-engines playwright install chromium`;
  const python = join(rendererDir, '.venv/bin/python');
  const hasBrowser = () => {
    if (!existsSync(python)) return false;
    try {
      const check = Bun.spawnSync([python, '-c',
        'import os; from playwright.sync_api import sync_playwright; p=sync_playwright().start(); ok=os.path.exists(p.chromium.executable_path); p.stop(); raise SystemExit(0 if ok else 1)'],
        { cwd: rendererDir, stdout: 'pipe', stderr: 'pipe' });
      return check.exitCode === 0;
    } catch { return false; }
  };
  if (hasBrowser()) return;
  try {
    run(['uv', 'sync', '--extra', 'python-engines'], rendererDir);
    if (!hasBrowser()) run(['uv', 'run', '--extra', 'python-engines', 'playwright', 'install', 'chromium'], rendererDir);
  } catch (error) {
    throw new Error(`도면·PDF 선택 애드온 설치 실패 — ${hint} (${String(error).split('\n')[0]})`);
  }
  if (!hasBrowser()) throw new Error(`도면·PDF 선택 애드온 확인 실패 — ${hint}`);
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
function validateReferenceQuality(html: string, source: string): { provider: 'gcp' | 'generic'; iconLibraryUrl: string; verifiedIcons: number } {
  for (const heading of ['목차', '요약', '부록']) {
    if (!new RegExp(`<h[1-6][^>]*>\\s*${heading}\\s*</h[1-6]>`, 'iu').test(html)) throw new Error(`reference PDF heading missing: ${heading}`);
  }
  if (!/<section[^>]*class="[^"]*\bcover\b[^"]*"/iu.test(html) || !/<img[^>]+src="architecture\.png"/iu.test(html) || !/<table\b/iu.test(html)) throw new Error('reference PDF requires cover, embedded diagram, and tables');
  const parsed = asObject(JSON.parse(source) as unknown);
  const elements = Array.isArray(parsed.elements) ? parsed.elements.map(asObject) : [];
  const metadata = asObject(parsed.metadata);
  const provider = str(metadata.provider) || 'gcp';
  if (provider !== 'gcp' && provider !== 'generic') throw new Error('unsupported architecture diagram provider');
  const boxes = elements.filter(element => element.type === 'rectangle' && ['x', 'y', 'width', 'height'].every(key => typeof element[key] === 'number'));
  const within = (inner: Data, outer: Data): boolean => Number(inner.x) >= Number(outer.x) && Number(inner.y) >= Number(outer.y)
    && Number(inner.x) + Number(inner.width) <= Number(outer.x) + Number(outer.width)
    && Number(inner.y) + Number(inner.height) <= Number(outer.y) + Number(outer.height);
  const named = (pattern: RegExp): Data | undefined => boxes.filter(box => elements.some(element => element.type === 'text' && pattern.test(str(element.text)) && within(element, box)))
    .sort((a, b) => Number(a.width) * Number(a.height) - Number(b.width) * Number(b.height))[0];
  const project = named(provider === 'gcp' ? /PROJECT|ACCOUNT/iu : /SYSTEM SCOPE/iu);
  const region = named(provider === 'gcp' ? /REGION/iu : /ZONE/iu);
  const vpc = named(provider === 'gcp' ? /VPC/iu : /NETWORK/iu);
  if (!project || !region || !vpc || project === region || region === vpc || !within(region, project) || !within(vpc, region)) throw new Error('reference diagram requires nested project, region and VPC shapes');
  if (elements.filter(element => element.type === 'arrow').length < 2) throw new Error('reference diagram requires actual flow arrows');
  const labels = elements.map(element => str(element.text)).join(' ');
  const requiredLabels: Array<[string, RegExp]> = [
    ['outer boundary', provider === 'gcp' ? /PROJECT|ACCOUNT/iu : /SYSTEM SCOPE/iu],
    ['zone', provider === 'gcp' ? /REGION/iu : /ZONE/iu],
    ['network', provider === 'gcp' ? /VPC/iu : /NETWORK/iu],
    ['users', /USERS|CLIENTS/iu], ['edge', /EDGE/iu], ['application', /APPLICATION|APP/iu],
    ['data', /DATA|LEDGER|DATABASE/iu], ['observability', /MONITORING|OBSERVABILITY|CLOUDWATCH/iu],
    ['security', /SECURITY|TRUST/iu], ['legend', /LEGEND/iu], ['version', /v\d+\.\d+/iu],
  ];
  for (const [name, pattern] of requiredLabels) if (!pattern.test(labels)) throw new Error(`reference diagram label missing: ${name}`);
  if ((labels.match(/[①②③④⑤⑥⑦⑧⑨]/gu) ?? []).length < 2) throw new Error('reference diagram needs numbered data flows');
  const imageFiles = asObject(parsed.files);
  const images = elements.filter(element => element.type === 'image' && str(element.fileId) && imageFiles[str(element.fileId)]);
  if (provider === 'gcp' && images.length < 3) throw new Error('GCP reference diagram requires embedded official service icons');
  if (provider === 'generic' && images.length) throw new Error('generic reference diagram must not embed GCP service icons');
  const iconLibraryUrl = str(metadata.iconLibraryUrl);
  const registry = asObject(JSON.parse(readFileSync(join(pluginRoot, 'references/official-gcp-icons.json'), 'utf8')) as unknown);
  if (provider === 'gcp' && iconLibraryUrl !== str(registry.libraryUrl)) throw new Error('official cloud icon library source missing');
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
  return { provider, iconLibraryUrl, verifiedIcons: images.length };
}

let ownedRun: OwnedRun | undefined;
let ownEmptyLock = '';
try {
  const contextPath = filePath(process.env.ELANOUS_GRAPH_CONTEXT, 'ELANOUS_GRAPH_CONTEXT');
  const context = asObject(JSON.parse(readFileSync(contextPath, 'utf8')) as unknown);
  const input = asObject(context.input);
  const requestedOutDir = str(input.outDir) || join(dirname(contextPath), 'architecture-deliverables');
  if (!isAbsolute(requestedOutDir)) throw new Error('outDir must be absolute');
  const outDir = resolve(requestedOutDir);
  const lockPath = outDir + '.architecture-run.json';
  const step = process.argv[2];
  let stageDir = '';
  if (step !== 'design') {
    const lock = asObject(JSON.parse(readFileSync(filePath(lockPath, 'architecture run lock'), 'utf8')) as unknown);
    stageDir = str(lock.stageDir);
    const candidate = { outDir, lockPath, stageDir };
    if (!stageOwnedBy(candidate) || str(lock.outDir) !== outDir) throw new Error('architecture staging ownership mismatch');
    ownedRun = candidate;
  }
  let htmlPath = join(stageDir, 'architecture.html');
  let sourcePath = join(stageDir, 'architecture.excalidraw');
  let pngPath = join(stageDir, 'architecture.png');
  let pdfPath = join(stageDir, 'architecture.pdf');

  if (step === 'design') {
    const structuredPath = str(input.structuredDesignPath);
    if (structuredPath && (input.designHtmlPath || input.diagramSourcePath)) throw new Error('choose structuredDesignPath or finished HTML/Excalidraw inputs');
    let html: string;
    let diagram: string;
    if (structuredPath) {
      const generated = generateStructuredDesign(JSON.parse(readFileSync(filePath(structuredPath, 'structuredDesignPath'), 'utf8')) as unknown);
      html = generated.html;
      diagram = generated.diagram;
    } else {
      html = readFileSync(filePath(input.designHtmlPath, 'designHtmlPath'), 'utf8');
      diagram = readFileSync(filePath(input.diagramSourcePath, 'diagramSourcePath'), 'utf8');
    }
    validateHtml(html);
    const elements = validateExcalidraw(diagram);
    const quality = validateReferenceQuality(html, diagram);
    if (existsSync(lockPath)) throw new Error('architecture output already has an active run; inspect its lock before retrying');
    assertOutputDirectory(outDir);
    mkdirSync(dirname(outDir), { recursive: true });
    const lockFd = openSync(lockPath, 'wx');
    closeSync(lockFd);
    ownEmptyLock = lockPath;
    stageDir = mkdtempSync(join(dirname(outDir), '.architecture-stage-'));
    writeFileSync(join(stageDir, '.architecture-owned'), outDir);
    writeFileSync(lockPath, JSON.stringify({ outDir, stageDir }));
    ownedRun = { outDir, lockPath, stageDir };
    ownEmptyLock = '';
    // Stage only generated files. Unrelated files stay live throughout rendering.
    htmlPath = join(stageDir, 'architecture.html');
    sourcePath = join(stageDir, 'architecture.excalidraw');
    pngPath = join(stageDir, 'architecture.png');
    pdfPath = join(stageDir, 'architecture.pdf');
    writeFileSync(htmlPath, html, { flag: 'wx' });
    writeFileSync(sourcePath, diagram, { flag: 'wx' });
    console.log(JSON.stringify({ outcome: 'ok', htmlPath, sourcePath, elements, verifiedIcons: quality.verifiedIcons }));
  } else if (step === 'diagram') {
    const { rendererDir, renderer } = resourcePaths(input);
    validateExcalidraw(readFileSync(filePath(sourcePath, 'architecture.excalidraw'), 'utf8'));
    ensureRendererAddon(rendererDir);
    run(['uv', 'run', '--extra', 'python-engines', 'python', renderer, sourcePath, '--output', pngPath], rendererDir);
    if (!existsSync(pngPath) || readFileSync(pngPath).subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('diagram PNG not rendered');
    console.log(JSON.stringify({ outcome: 'ok', sourcePath, pngPath }));
  } else if (step === 'pdf') {
    const { rendererDir, pdfConverter } = resourcePaths(input);
    validateHtml(readFileSync(filePath(htmlPath, 'architecture.html'), 'utf8'));
    filePath(pngPath, 'architecture.png');
    ensureRendererAddon(rendererDir);
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
    const { rendererDir } = resourcePaths(input);
    const inspected = JSON.parse(run(['uv', 'run', '--extra', 'python-engines', 'python', '-c',
      'import json,pymupdf,sys; doc=pymupdf.open(sys.argv[1]); blocks=lambda p: sorted((b for b in p.get_text("blocks") if isinstance(b[4],str)),key=lambda b:(b[0]>=p.rect.width/2,b[1],b[0])); text=chr(10).join(chr(10).join(b[4] for b in blocks(p)) for p in doc if p.number>=1); print(json.dumps({"pages":len(doc),"text":text},ensure_ascii=False))',
      pdfPath], rendererDir)) as { pages: number; text: string };
    const text = inspected.text;
    const unpriced = /<td>미산정<\/td>/u.test(html);
    if (unpriced && !text.includes('미산정')) throw new Error('unpriced cost missing from PDF text');
    const missing = missingPdfBodySections(text, sections);
    if (missing.length) throw new Error(`PDF text missing sections: ${missing.join(', ')}`);
    for (const heading of ['목차', '요약', '부록']) if (!new RegExp(`^\\s*${heading}\\s*$`, 'mu').test(text)) throw new Error(`PDF heading missing ${heading}`);
    const pages = inspected.pages;
    if (!Number.isFinite(pages) || pages < 4) throw new Error('reference PDF requires at least four pages');
    const receipt = { status: 'verified', costStatus: unpriced ? 'unpriced' : 'priced',
      contract: quality.provider === 'gcp' ? 'system-architecture/cloud-expansion@2' : 'system-architecture@2',
      profile: quality.provider, quality: 'reference', pages, iconLibraryUrl: quality.iconLibraryUrl, verifiedIcons: quality.verifiedIcons,
      files: ['architecture.excalidraw', 'architecture.png', 'architecture.html', 'architecture.pdf'], pdfSections: sections,
      elements, pngBytes: png.length, pdfBytes: pdf.length,
      generation: basename(stageDir),
      immutableDirectory: `${bundleRootName}/${basename(stageDir)}`,
      sha256: Object.fromEntries(outputFiles.filter(name => name !== 'verification.json').map(name =>
        [name, createHash('sha256').update(readFileSync(join(stageDir, name))).digest('hex')])) };
    writeFileSync(join(stageDir, 'verification.json'), JSON.stringify(receipt, null, 2) + '\n');
    publishOutputs(outDir, stageDir);
    rmSync(lockPath, { force: true });
    console.log(JSON.stringify({ outcome: 'ok', outDir, receipt }));
  } else throw new Error(`unknown step ${step}`);
} catch (error) {
  if (ownedRun) {
    try { releaseOwnedRun(ownedRun); } catch { /* Cleanup must not hide the stage error. */ }
  }
  if (ownEmptyLock) rmSync(ownEmptyLock, { force: true });
  console.log(JSON.stringify({ outcome: 'fail', error: error instanceof Error ? error.message : String(error) }));
}
