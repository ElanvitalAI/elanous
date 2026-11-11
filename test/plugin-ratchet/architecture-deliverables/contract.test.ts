import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { installPlugin } from '../../../src/plugins/install/plugin-install.js';
import { installedPluginGraphs } from '../../../src/exec-requests/planner.js';
import { simCli } from '../../../src/ux-sim/in-process-cli.js';

const dir = join(import.meta.dir, '../../../plugins/architecture-deliverables');
const required = ['architecture.excalidraw', 'architecture.png', 'architecture.html', 'architecture.pdf', 'verification.json'];
const sections = ['배경', '요구사항', '구성도', '데이터 흐름', '보안 등급', '비용 예측', '절감안', '대안', '결정 기록'];

test('plugin declares the four-stage output contract and installs', async () => {
  const plugin = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as Record<string, any>;
  const ext = plugin.extensions['ai.elanous'];
  expect(ext.outputContract.requiredFiles).toEqual(required);
  expect(ext.outputContract.pdfSections).toEqual(sections);
  expect(ext.outputContract.diagramQuality.layers).toEqual(['users', 'edge', 'application', 'data', 'observability', 'security']);
  expect(ext.outputContract.pdfQuality).toEqual(['cover', 'table of contents', 'executive summary', 'embedded diagram', 'tables', 'appendix']);
  const graph = parseYaml(readFileSync(join(dir, 'graphs/architecture-deliverables.yaml'), 'utf8')) as { nodes: Array<{ node_id: string }>; edges: Array<{ from: string; map: Record<string, string> }> };
  expect(graph.nodes.map(n => n.node_id)).toEqual(['design', 'diagram', 'pdf', 'verify', 'done', 'failed']);
  expect(graph.edges.map(e => e.map.ok)).toEqual(['diagram', 'pdf', 'verify', 'done']);
  const root = mkdtempSync(join(tmpdir(), 'architecture-plugin-test-'));
  try {
    const installed = await installPlugin(dir, { root, yes: true });
    expect(installed.name).toBe('architecture-deliverables');
    expect(existsSync(join(installed.path, 'graphs/architecture-deliverables.yaml'))).toBe(true);
    const catalog = installedPluginGraphs(join(root, 'plugins'));
    expect(catalog.errors).toEqual([]);
    expect(catalog.graphs.find(graph => graph.id === 'architecture-deliverables')?.inputKeys).toEqual(['designHtmlPath', 'diagramSourcePath', 'outDir']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GCP reference samples meet the professional diagram and integrated PDF contract', () => {
  for (const name of ['cloud-sim', 'solar-ticketing-gcp']) {
    const sample = join(dir, '../../docs/samples/architecture-deliverables', name);
    const source = JSON.parse(readFileSync(join(sample, 'architecture.excalidraw'), 'utf8')) as { elements: Array<{ type: string; text?: string }>; files: Record<string, unknown>; metadata: { iconLibraryUrl: string } };
    const labels = source.elements.map(element => element.text ?? '').join(' ');
    for (const label of ['PROJECT', 'REGION', 'VPC', 'USERS', 'EDGE', 'APPLICATION', 'LEGEND', 'TRUST']) expect(labels).toContain(label);
    expect(source.elements.filter(element => element.type === 'image').length).toBeGreaterThanOrEqual(3); // source: docs/samples/architecture-deliverables/cloud-sim/verification.json
    expect(Object.keys(source.files).length).toBeGreaterThanOrEqual(3); // source: docs/samples/architecture-deliverables/cloud-sim/verification.json
    expect(source.metadata.iconLibraryUrl).toBe('https://cloud.google.com/icons');
    const html = readFileSync(join(sample, 'architecture.html'), 'utf8');
    for (const heading of ['목차', '요약', '부록']) expect(new RegExp(`<h2[^>]*>${heading}</h2>`, 'u').test(html)).toBe(true);
    expect(html).toContain('src="architecture.png"');
    const receipt = JSON.parse(readFileSync(join(sample, 'verification.json'), 'utf8')) as { contract: string; pages: number; quality: string; verifiedIcons: number };
    expect(receipt.contract).toBe('system-architecture/cloud-expansion@2');
    expect(receipt.quality).toBe('reference');
    // The cloud sample's tables span seven pages; ticketing remains six.
    expect(receipt.pages).toBe(name === 'cloud-sim' ? 7 : 6);
    expect(receipt.verifiedIcons).toBe(6);
  }
});

test('all PR samples contain an editable source, rendered PNG, and complete PDF', () => {
  for (const name of ['cloud-sim', 'ticketing', 'solar-ticketing-gcp']) {
    const sample = join(dir, '../../docs/samples/architecture-deliverables', name);
    for (const file of required) expect(existsSync(join(sample, file))).toBe(true);
    const source = JSON.parse(readFileSync(join(sample, 'architecture.excalidraw'), 'utf8')) as { type: string; elements: unknown[] };
    expect(source.type).toBe('excalidraw');
    expect(source.elements.length).toBeGreaterThan(10); // source: docs/samples/architecture-deliverables/cloud-sim/verification.json
    expect(readFileSync(join(sample, 'architecture.png')).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(readFileSync(join(sample, 'architecture.pdf')).subarray(0, 4).toString()).toBe('%PDF');
    const receipt = JSON.parse(readFileSync(join(sample, 'verification.json'), 'utf8')) as { status: string; pdfSections: string[] };
    expect(receipt.status).toBe('verified');
    expect(receipt.pdfSections).toEqual(sections);
  }
});

test('design step rejects an HTML source missing a required PDF section', () => {
  const root = mkdtempSync(join(tmpdir(), 'architecture-output-test-'));
  try {
    const sample = join(dir, '../../docs/samples/architecture-deliverables/cloud-sim');
    const html = join(root, 'invalid.html');
    writeFileSync(html, readFileSync(join(sample, 'architecture.html'), 'utf8').replace('<h2>보안 등급</h2>', '<h2>기타</h2>'));
    const outDir = join(root, 'out');
    mkdirSync(outDir, { recursive: true });
    for (const stale of ['verification.json', 'architecture.png', 'architecture.pdf']) writeFileSync(join(outDir, stale), 'stale previous success');
    const context = join(root, 'run.json');
    writeFileSync(context, JSON.stringify({ input: { designHtmlPath: html, diagramSourcePath: join(sample, 'architecture.excalidraw'), outDir } }));
    const run = Bun.spawnSync(['bun', join(dir, '../../src/ux-sim/architecture-deliverables/run-step.ts'), 'design'], { env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context }, stdout: 'pipe', stderr: 'pipe' });
    const result = JSON.parse(new TextDecoder().decode(run.stdout).trim()) as { outcome: string; error: string };
    expect(result.outcome).toBe('fail');
    expect(result.error).toContain('보안 등급');
    expect(existsSync(join(root, 'out/architecture.html'))).toBe(false);
    for (const stale of ['verification.json', 'architecture.png', 'architecture.pdf']) expect(readFileSync(join(outDir, stale), 'utf8')).toBe('stale previous success');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('official icon provenance rejects a relabeled arbitrary image', () => {
  const root = mkdtempSync(join(tmpdir(), 'architecture-icon-test-'));
  try {
    const sample = join(dir, '../../docs/samples/architecture-deliverables/cloud-sim');
    const source = JSON.parse(readFileSync(join(sample, 'architecture.excalidraw'), 'utf8')) as { files: Record<string, { dataURL: string }> };
    source.files['gcp-app-icon']!.dataURL = source.files['gcp-edge-icon']!.dataURL;
    const altered = join(root, 'altered.excalidraw');
    writeFileSync(altered, JSON.stringify(source));
    const context = join(root, 'run.json');
    writeFileSync(context, JSON.stringify({ input: { designHtmlPath: join(sample, 'architecture.html'), diagramSourcePath: altered, outDir: join(root, 'out') } }));
    const run = Bun.spawnSync(['bun', join(dir, '../../src/ux-sim/architecture-deliverables/run-step.ts'), 'design'], { env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context }, stdout: 'pipe', stderr: 'pipe' });
    const result = JSON.parse(new TextDecoder().decode(run.stdout).trim()) as { outcome: string; error: string };
    expect(result.outcome).toBe('fail');
    expect(result.error).toContain('official icon provenance mismatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installed plugin graph renders and verifies with explicit existing resource root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'architecture-installed-'));
  try {
    const installed = await installPlugin(dir, { root, yes: true });
    const sample = join(dir, '../../docs/samples/architecture-deliverables/cloud-sim');
    const outDir = join(root, 'output');
    const input = { designHtmlPath: join(sample, 'architecture.html'), diagramSourcePath: join(sample, 'architecture.excalidraw'), outDir, resourceRoot: join(dir, '../..') };
    const run = await simCli(['graph', 'run', join(installed.path, 'graphs/architecture-deliverables.yaml'), '--input', JSON.stringify(input), '--json'], {
      allowPaths: [['graph', 'run']], stateRoot: join(root, 'isolation'), cwd: root,
      env: { ELANOUS_ARCHITECTURE_RESOURCE_ROOT: join(dir, '../..') },
    });
    expect({ exit: run.exitCode, stderr: run.stderr, stdout: run.stdout.slice(-500) }).toMatchObject({ exit: 0 });
    expect(run.stderr).toContain('[graph] done ok');
    expect(JSON.parse(readFileSync(join(outDir, 'verification.json'), 'utf8')).status).toBe('verified');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);
