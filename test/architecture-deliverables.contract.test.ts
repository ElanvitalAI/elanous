import { expect, test } from 'bun:test';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { installPlugin } from '../src/plugins/install/plugin-install.js';
import { installedPluginGraphs } from '../src/exec-requests/planner.js';
import { createPluginRouteAdapter } from '../src/plugins/core/route-adapter.js';
import { generateStructuredDesign } from '../src/graph-runner/architecture-output/structured-design.js';
import { exportEditableDiagram } from '../src/graph-runner/architecture-output/editable-exports.js';
import { missingPdfBodySections } from '../src/graph-runner/architecture-output/pdf-body.js';
import { runGraph } from '../src/graph-runner/runner.js';
import { createArchitectureDeliverablesRegistry } from '../src/graph-runner/capability-providers/architecture-deliverables.js';
import { runArchitectureDeliverables, verifyArchitectureBundleArtifacts } from '../src/graph-runner/architecture-deliverables.js';
import { simCli } from '../src/ux-sim/in-process-cli.js';

const dir = join(import.meta.dir, '../plugins/architecture-deliverables');
const stepPath = join(import.meta.dir, '../src/graph-runner/architecture-output/run-step.ts');
const required = ['architecture.excalidraw', 'architecture.drawio', 'architecture.svg', 'architecture.png', 'architecture.html', 'architecture.pdf', 'verification.json'];
const legacySampleRequired = ['architecture.excalidraw', 'architecture.png', 'architecture.html', 'architecture.pdf', 'verification.json'];
const sections = ['배경', '요구사항', '구성도', '데이터 흐름', '보안 등급', '비용 예측', '절감안', '대안', '결정 기록'];

test('plugin declares the four-stage output contract and installs', async () => {
  const plugin = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as Record<string, any>;
  const ext = plugin.extensions['ai.elanous'];
  expect(ext.outputContract.requiredFiles).toEqual(required);
  expect(ext.outputContract.pdfSections).toEqual(sections);
  expect(ext.outputContract.diagramQuality.layers).toEqual(['users', 'edge', 'application', 'data', 'observability', 'security']);
  expect(ext.outputContract.pdfQuality).toEqual(['cover', 'table of contents', 'executive summary', 'embedded diagram', 'tables', 'appendix']);
  const graph = parseYaml(readFileSync(join(dir, 'graphs/architecture-deliverables.yaml'), 'utf8')) as { apiVersion: string; nodes: Array<{ id: string; requires: string }>; edges: Array<{ from: string; map: Record<string, string> }> };
  expect(graph.apiVersion).toBe('elanous.dev/graph/v2');
  expect(graph.nodes.map(n => n.id)).toEqual(['design', 'diagram', 'pdf', 'verify']);
  expect(graph.nodes.map(n => n.requires)).toEqual(['architecture.design@1', 'architecture.diagram@1', 'architecture.pdf@1', 'architecture.verify@1']);
  expect(graph.edges.map(e => e.map.ok)).toEqual(['diagram', 'pdf', 'verify', 'done']);
  const root = mkdtempSync(join(tmpdir(), 'architecture-plugin-test-'));
  try {
    const installed = await installPlugin(dir, { root, yes: true });
    expect(installed.name).toBe('architecture-deliverables');
    expect(existsSync(join(installed.path, 'graphs/architecture-deliverables.yaml'))).toBe(true);
    const catalog = installedPluginGraphs(join(root, 'plugins'));
    expect(catalog.errors).toEqual([]);
    expect(catalog.graphs.find(graph => graph.id === 'architecture-deliverables')?.inputKeys).toEqual(['structuredDesignPath', 'outDir', 'resourceRoot']);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);

test('architecture graph is discoverable as an executable plugin tool', () => {
  const adapter = createPluginRouteAdapter({ pluginRoot: join(dir, '..'), dispatchCore: async () => undefined });
  const tool = adapter.hostTools([]).find(tool => tool.name === 'architecture_deliverables');
  expect(tool).toMatchObject({ pluginId: 'architecture-deliverables', handlerRef: './graph:architecture-deliverables' });
  expect(tool?.allowedGraphIds).toContain('architecture-deliverables');
});

test('GCP reference samples meet the professional diagram and integrated PDF contract', () => {
  for (const name of ['cloud-sim', 'solar-ticketing-gcp']) {
    const sample = join(dir, '../../docs/samples/architecture-deliverables', name);
    const source = JSON.parse(readFileSync(join(sample, 'architecture.excalidraw'), 'utf8')) as { elements: Array<{ type: string; text?: string }>; files: Record<string, unknown>; metadata: { iconLibraryUrl: string } };
    const labels = source.elements.map(element => element.text ?? '').join(' ');
    for (const label of ['PROJECT', 'REGION', 'VPC', 'USERS', 'EDGE', 'APPLICATION', 'LEGEND', 'TRUST']) expect(labels).toContain(label);
    expect(source.elements.filter(element => element.type === 'image').length).toBeGreaterThanOrEqual(3); // Source: #36522
    expect(Object.keys(source.files).length).toBeGreaterThanOrEqual(3); // Source: #36522
    expect(source.metadata.iconLibraryUrl).toBe('https://cloud.google.com/icons');
    const html = readFileSync(join(sample, 'architecture.html'), 'utf8');
    for (const heading of ['목차', '요약', '부록']) expect(new RegExp(`<h2[^>]*>${heading}</h2>`, 'u').test(html)).toBe(true);
    expect(html).toContain('src="architecture.png"');
    const receipt = JSON.parse(readFileSync(join(sample, 'verification.json'), 'utf8')) as { contract: string; pages: number; quality: string; verifiedIcons: number };
    expect(receipt.contract).toBe('system-architecture/cloud-expansion@2');
    expect(receipt.quality).toBe('reference');
    expect(receipt.pages).toBeGreaterThanOrEqual(6); // Source: #36522
    expect(receipt.verifiedIcons).toBe(6);
  }
});

test('AWS and local requirements produce separate editable sources with honest icon provenance', () => {
  const sample = JSON.parse(readFileSync(join(dir, 'examples/structured-ticketing-gcp.json'), 'utf8')) as Record<string, any>;
  const aws = JSON.parse(JSON.stringify(sample)) as Record<string, any>;
  aws.deployment.provider = 'aws';
  const registry = JSON.parse(readFileSync(join(dir, 'references/official-aws-icons.json'), 'utf8')) as { assets: Record<string, unknown> };
  const icons = Object.keys(registry.assets);
  for (const [index, node] of aws.nodes.filter((node: Record<string, unknown>) => node.icon).entries()) node.icon = icons[index % icons.length];
  aws.nodes.find((node: Record<string, unknown>) => node.id === 'booking').subnet = 'app-private';
  const result = generateStructuredDesign(aws);
  const exports = exportEditableDiagram(result.diagram);
  expect(result.diagram).toContain('https://aws.amazon.com/architecture/icons/');
  expect(result.diagram).toContain('SUBNET · app-private');
  expect(exports.drawio).toContain('<mxGraphModel');
  expect(exports.drawio).toContain('shape=image;image=data:image/png,');
  expect(exports.drawio).not.toContain('image=data:image/png;base64,');
  expect(exports.svg).toContain('<svg');
  expect(exports.svg).toContain('<image');
  expect((exports.drawio.match(/endArrow=block/gu) ?? []).length).toBe(aws.flows.length);
  aws.nodes[1].icon = 'fake-icon.png';
  expect(() => generateStructuredDesign(aws)).toThrow('official icon source not registered');
  const local = JSON.parse(JSON.stringify(sample)) as Record<string, any>;
  local.deployment.provider = 'local';
  for (const node of local.nodes) delete node.icon;
  for (const [index, node] of local.nodes.entries()) node.localIcon = ['laptop', 'relay', 'process', 'tailnet', 'sqlite', 'docker'][index % 6];
  const localSource = generateStructuredDesign(local);
  expect(localSource.diagram).toContain('SYSTEM SCOPE');
  expect(localSource.diagram).not.toContain('https://cloud.google.com/icons');
  expect(localSource.diagram).toContain('SQLITE');
  expect(localSource.diagram).toContain('RELAY');
  expect(exportEditableDiagram(localSource.diagram).drawio).toContain('<mxGraphModel');
});

test('draw.io node content and flows stay attached when a node moves', () => {
  const input = JSON.parse(readFileSync(join(dir, 'examples/structured-ticketing-pro.json'), 'utf8')) as { nodes: Array<{ id: string }>; flows: Array<{ from: string; to: string }> };
  const source = generateStructuredDesign(input);
  const drawio = exportEditableDiagram(source.diagram).drawio;
  const elements = (JSON.parse(source.diagram) as { elements: Array<{ id: string; y: number; height: number; groupIds: string[]; startBinding?: { elementId: string }; endBinding?: { elementId: string } }> }).elements;
  const vpcLabel = elements.find(element => element.id === 'vpc-label')!;
  const firstSubnet = elements.find(element => element.id === 'subnet-booking')!;
  expect(vpcLabel.y + vpcLabel.height).toBeLessThanOrEqual(firstSubnet.y);
  const regionLabel = elements.find(element => element.id === 'region-label')!;
  expect(regionLabel.y + regionLabel.height).toBeLessThan(vpcLabel.y);
  for (const node of input.nodes) {
    expect(drawio).toContain(`id="node-${node.id}"`);
    expect(elements.find(element => element.id === `node-${node.id}-body`)?.groupIds).toEqual([`group-node-${node.id}`]);
    for (const suffix of ['title', 'body', 'icon']) {
      if (drawio.includes(`id="node-${node.id}-${suffix}"`))
        expect(drawio).toMatch(new RegExp(`id="node-${node.id}-${suffix}"[^>]*parent="node-${node.id}"`, 'u'));
    }
  }
  for (const [index, flow] of input.flows.entries())
    {
      expect(drawio).toMatch(new RegExp(`id="flow-${index + 1}"[^>]*source="node-${flow.from}" target="node-${flow.to}"`, 'u'));
      expect(elements.find(element => element.id === `flow-${index + 1}`)?.startBinding?.elementId).toBe(`node-${flow.from}`);
      expect(elements.find(element => element.id === `flow-${index + 1}`)?.endBinding?.elementId).toBe(`node-${flow.to}`);
      expect(drawio).toMatch(new RegExp(`id="flow-${index + 1}" value="${['①','②','③','④','⑤','⑥','⑦','⑧','⑨'][index]}"`, 'u'));
      expect(drawio).not.toContain(`id="flow-${index + 1}-number"`);
    }
  expect(drawio).not.toContain('as="sourcePoint"');
  const sample = join(dir, '../../docs/samples/architecture-deliverables/sysarch-pro-ticketing');
  expect(readFileSync(join(sample, 'architecture.drawio'), 'utf8')).toBe(drawio);
});

test('payment attempt, webhook and refund keep separate attached draw.io routes', () => {
  const input = JSON.parse(readFileSync(join(dir, 'examples/structured-ticketing-pro.json'), 'utf8')) as object;
  const generated = generateStructuredDesign(input);
  const drawio = exportEditableDiagram(generated.diagram).drawio;
  expect(generated.diagram).toContain('EXTERNAL SYSTEM');
  const routes = [5, 6, 7].map(index => {
    const cell = drawio.match(new RegExp(`<mxCell id="flow-${index}"[^>]*>[\\s\\S]*?<\\/mxCell>`, 'u'))?.[0] ?? '';
    expect(cell).toContain('source="node-');
    expect(cell).toContain('target="node-');
    expect(cell).toContain('edgeStyle=segmentEdgeStyle');
    const waypoints = cell.match(/<Array as="points">([\s\S]*?)<\/Array>/u)?.[1] ?? '';
    expect((waypoints.match(/<mxPoint /gu) ?? []).length).toBe(2);
    return waypoints;
  });
  expect(new Set(routes).size).toBe(3);
  expect(routes[0]).not.toBe(routes[2]);
});

test('professional ticketing component table and saved bundle match the request flow', () => {
  const sample = join(dir, '../../docs/samples/architecture-deliverables/sysarch-pro-ticketing');
  const input = JSON.parse(readFileSync(join(dir, 'examples/structured-ticketing-pro.json'), 'utf8')) as object;
  const generated = generateStructuredDesign(input);
  const html = readFileSync(join(sample, 'architecture.html'), 'utf8');
  expect(html).toBe(generated.html);
  expect(html).toContain('GKE booking pods</td><td>예약 HTTP 요청과 좌석 hold를 처리하고 안정적인 결제 시도 키로 외부 결제를 호출한다.');
  expect(html).toContain('Memorystore Redis</td><td>입장 토큰과 읽기 캐시를 저장한다.');
  expect(html).toContain('Amazon EKS 예약 API / GKE 예약 API');
  expect(html).toContain('Amazon ElastiCache for Redis / Memorystore for Redis');
  expect(html).not.toContain('Cloud Run jobs');
  for (const fact of ['External payment provider', 'payment attempt with stable idempotency key', 'signed webhook: duplicate or out of order',
    'refund with stable key; query and reconcile result', '결제 웹훅 서명·이벤트 ID 검증', 'refund:paymentAttemptId:expired-hold', '대행사 결과를 조회']) expect(html).toContain(fact);
  const receipt = JSON.parse(readFileSync(join(sample, 'verification.json'), 'utf8')) as { status: string; sha256: Record<string, string> };
  expect(receipt.status).toBe('verified');
  for (const name of required.filter(name => name !== 'verification.json'))
    expect(createHash('sha256').update(readFileSync(join(sample, name))).digest('hex')).toBe(receipt.sha256[name]);
});

test('AWS and local ticketing inputs describe their actual nodes and icon provenance', () => {
  const load = (name: string): Record<string, any> => JSON.parse(readFileSync(join(dir, `examples/${name}`), 'utf8')) as Record<string, any>;
  const aws = load('structured-ticketing-aws.json');
  const local = load('structured-ticketing-local.json');
  expect(aws.title).toContain('AWS');
  expect(local.title).toContain('local operator host');
  expect(aws.title).not.toContain('Google Cloud');
  expect(local.title).not.toContain('Google Cloud');
  expect(aws.nodes.find((node: Record<string, string>) => node.id === 'payment').zone).toBe('external');
  expect(aws.flows.filter((flow: Record<string, string>) => flow.to === 'payment').map((flow: Record<string, string>) => flow.label)).toEqual([
    'payment attempt with stable idempotency key', 'refund with stable key; query and reconcile result',
  ]);
  expect(aws.flows.some((flow: Record<string, string>) => flow.from === 'payment' && flow.to === 'booking' && flow.label.includes('signed webhook'))).toBe(true);
  expect(aws.requirements.find((row: Record<string, string>) => row.id === 'R2').verification).toContain('환불 중복 0');
  expect(aws.nodes.find((node: Record<string, string>) => node.id === 'queue').zone).toBe('project');
  expect(aws.nodes.find((node: Record<string, string>) => node.id === 'observe').zone).toBe('project');
  expect(aws.nodes.find((node: Record<string, string>) => node.id === 'booking').details).toContain('Lambda concurrency cap');
  expect(local.nodes.find((node: Record<string, string>) => node.id === 'booking').details).toContain('Single-process limit');
  expect(aws.references.some((row: Record<string, string>) => row.title === 'Google Cloud icons')).toBe(false);
  expect(local.references.some((row: Record<string, string>) => row.title === 'Google Cloud icons')).toBe(false);
  const edge = aws.nodes.find((node: Record<string, string>) => node.id === 'edge');
  expect(edge.icon).toContain('Arch_Amazon-CloudFront_48.png');
  expect(edge.service).toContain('CloudFront');
  expect(edge.purpose).toContain('AWS WAF');
  const awsSource = JSON.parse(generateStructuredDesign(aws).diagram) as { metadata: { iconAssets: Record<string, string> } };
  expect(Object.values(awsSource.metadata.iconAssets)).toContain(edge.icon);
  const awsElements = (JSON.parse(generateStructuredDesign(aws).diagram) as { elements: Array<{ id: string; x: number; y: number; width: number; height: number }> }).elements;
  const vpc = awsElements.find(element => element.id === 'vpc-boundary')!;
  for (const id of ['node-queue', 'node-observe']) {
    const node = awsElements.find(element => element.id === id)!;
    expect(node.y >= vpc.y + vpc.height || node.y + node.height <= vpc.y || node.x >= vpc.x + vpc.width || node.x + node.width <= vpc.x).toBe(true);
  }
  expect(local.nodes.find((node: Record<string, string>) => node.id === 'booking').purpose).toContain('동기 예약 요청');
  expect(local.nodes.find((node: Record<string, string>) => node.id === 'fans').details).not.toContain('100k concurrent');
  expect(generateStructuredDesign(local).diagram).not.toContain('100k concurrent');
  expect(local.security.some((row: Record<string, string>) => row.controls.includes('공개 CDN·WAF 없음'))).toBe(true);
  expect(local.capacity.some((row: Record<string, string>) => row.assumption.includes('Pod·오토스케일 없음'))).toBe(true);
  expect(generateStructuredDesign(local).html).not.toContain('CDN 공개 객체만 공유 캐시');
});

test('public relay pattern excludes tailnet-only Serve and names an actual public ingress', () => {
  const pack = join(dir, '../../packs/system-architecture-public');
  const library = JSON.parse(readFileSync(join(pack, 'references/pattern-library.json'), 'utf8')) as { patterns: Array<Record<string, any>> };
  const publicPattern = library.patterns.find(pattern => pattern.id === 'local-relay-public')!;
  const publicCard = JSON.parse(readFileSync(join(pack, 'content/pattern-local-relay-public.json'), 'utf8')) as { body: string; source: string };
  const privatePattern = library.patterns.find(pattern => pattern.id === 'local-single-node')!;
  expect(publicPattern.components).toContain('public HTTPS relay or Tailscale Funnel');
  expect(publicPattern.components).not.toContain('relay or tailnet serve');
  expect(publicPattern.placement).toContain('Tailscale Serve는 tailnet 내부 전용');
  expect(publicCard.body).toContain('Tailscale Serve는 tailnet 내부 전용');
  expect(publicCard.source).toBe('https://tailscale.com/docs/features/tailscale-funnel');
  expect(privatePattern.placement).toContain('Tailscale Serve는 tailnet 회원 내부 접근만 허용');
});

test('GCP API Gateway knowledge uses a labeled integration category icon, not Apigee', () => {
  const pack = join(dir, '../../packs/system-architecture-public');
  const data = JSON.parse(readFileSync(join(pack, 'references/component-knowledge.json'), 'utf8')) as { components: Array<Record<string, string>> };
  const gateway = data.components.find(component => component.id === 'api-gateway')!;
  const card = JSON.parse(readFileSync(join(pack, 'content/component-api-gateway.json'), 'utf8')) as { body: string };
  expect(gateway.gcpIconScope).toBe('category');
  expect(gateway.gcpIconKey).toBe('Category Icons/Integration Services/PNG/IntegrationServices-512-color.png');
  expect(card.body).toContain('공식 Integration Services 범주 아이콘');
  expect(card.body).not.toContain('Apigee');
});

test('all PR samples contain an editable source, rendered PNG, and complete PDF', () => {
  for (const name of ['cloud-sim', 'ticketing', 'solar-ticketing-gcp']) {
    const sample = join(dir, '../../docs/samples/architecture-deliverables', name);
    for (const file of legacySampleRequired) expect(existsSync(join(sample, file))).toBe(true);
    const source = JSON.parse(readFileSync(join(sample, 'architecture.excalidraw'), 'utf8')) as { type: string; elements: unknown[] };
    expect(source.type).toBe('excalidraw');
    expect(source.elements.length).toBeGreaterThan(10); // Source: #36522
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
    const run = Bun.spawnSync(['bun', stepPath, 'design'], { env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context }, stdout: 'pipe', stderr: 'pipe' });
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
    const run = Bun.spawnSync(['bun', stepPath, 'design'], { env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context }, stdout: 'pipe', stderr: 'pipe' });
    const result = JSON.parse(new TextDecoder().decode(run.stdout).trim()) as { outcome: string; error: string };
    expect(result.outcome).toBe('fail');
    expect(result.error).toContain('official icon provenance mismatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('design rejects labels when region and VPC shapes do not nest', () => {
  const root = mkdtempSync(join(tmpdir(), 'architecture-shape-test-'));
  try {
    const sample = join(dir, '../../docs/samples/architecture-deliverables/cloud-sim');
    const source = JSON.parse(readFileSync(join(sample, 'architecture.excalidraw'), 'utf8')) as { elements: Array<{ id: string; x: number }> };
    source.elements.find(element => element.id === 'region')!.x = 2000;
    const altered = join(root, 'altered.excalidraw');
    writeFileSync(altered, JSON.stringify(source));
    const context = join(root, 'run.json');
    writeFileSync(context, JSON.stringify({ input: { designHtmlPath: join(sample, 'architecture.html'), diagramSourcePath: altered, outDir: join(root, 'out') } }));
    const run = Bun.spawnSync(['bun', stepPath, 'design'], { env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context }, stdout: 'pipe' });
    const result = JSON.parse(new TextDecoder().decode(run.stdout).trim()) as { outcome: string; error: string };
    expect(result.outcome).toBe('fail');
    expect(result.error).toContain('nested project, region and VPC');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('existing staging and previous sibling directories are never deleted', () => {
  const root = mkdtempSync(join(tmpdir(), 'architecture-ownership-test-'));
  try {
    const sample = join(dir, '../../docs/samples/architecture-deliverables/cloud-sim');
    const outDir = join(root, 'out');
    for (const suffix of ['.staging', '.previous']) {
      mkdirSync(outDir + suffix);
      writeFileSync(join(outDir + suffix, 'sentinel.txt'), 'owner data');
    }
    const context = join(root, 'run.json');
    writeFileSync(context, JSON.stringify({ input: { designHtmlPath: join(sample, 'architecture.html'), diagramSourcePath: join(sample, 'architecture.excalidraw'), outDir } }));
    const run = Bun.spawnSync(['bun', stepPath, 'design'], { env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context }, stdout: 'pipe' });
    expect(JSON.parse(new TextDecoder().decode(run.stdout).trim()).outcome).toBe('ok');
    for (const suffix of ['.staging', '.previous']) expect(readFileSync(join(outDir + suffix, 'sentinel.txt'), 'utf8')).toBe('owner data');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('design does not follow previous output symlinks outside the output directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'architecture-symlink-test-'));
  try {
    const sample = join(dir, '../../docs/samples/architecture-deliverables/cloud-sim');
    const outDir = join(root, 'out');
    mkdirSync(outDir);
    for (const name of ['architecture.html', 'architecture.excalidraw']) {
      const target = join(root, `${name}.sentinel`);
      writeFileSync(target, `external ${name}`);
      symlinkSync(target, join(outDir, name));
    }
    const context = join(root, 'run.json');
    writeFileSync(context, JSON.stringify({ input: { designHtmlPath: join(sample, 'architecture.html'),
      diagramSourcePath: join(sample, 'architecture.excalidraw'), outDir } }));
    const run = Bun.spawnSync(['bun', stepPath, 'design'],
      { env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context }, stdout: 'pipe' });
    const result = JSON.parse(new TextDecoder().decode(run.stdout).trim()) as { outcome: string };
    expect(result.outcome).toBe('ok');
    const lock = JSON.parse(readFileSync(outDir + '.architecture-run.json', 'utf8')) as { stageDir: string };
    for (const name of ['architecture.html', 'architecture.excalidraw']) {
      expect(readFileSync(join(root, `${name}.sentinel`), 'utf8')).toBe(`external ${name}`);
      expect(lstatSync(join(lock.stageDir, name)).isSymbolicLink()).toBe(false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verify preserves unrelated files added or changed while rendering', () => {
  const root = mkdtempSync(join(tmpdir(), 'architecture-concurrent-output-'));
  try {
    const sample = join(dir, '../../docs/samples/architecture-deliverables/cloud-sim');
    const outDir = join(root, 'out');
    mkdirSync(outDir);
    writeFileSync(join(outDir, 'notes.txt'), 'before');
    const context = join(root, 'run.json');
    writeFileSync(context, JSON.stringify({ input: { designHtmlPath: join(sample, 'architecture.html'),
      diagramSourcePath: join(sample, 'architecture.excalidraw'), outDir } }));
    const step = (name: string) => {
      const child = Bun.spawnSync(['bun', stepPath, name],
        { env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context }, stdout: 'pipe', stderr: 'pipe' });
      const stdout = new TextDecoder().decode(child.stdout).trim();
      const stderr = new TextDecoder().decode(child.stderr).trim();
      if (child.exitCode !== 0 || !stdout)
        throw new Error(`architecture ${name} did not return a result (exit=${child.exitCode}): ${stderr}`);
      return JSON.parse(stdout) as { outcome: string; error?: string };
    };
    expect(step('design').outcome).toBe('ok');
    const lock = JSON.parse(readFileSync(outDir + '.architecture-run.json', 'utf8')) as { stageDir: string };
    copyFileSync(join(sample, 'architecture.png'), join(lock.stageDir, 'architecture.png'));
    copyFileSync(join(sample, 'architecture.pdf'), join(lock.stageDir, 'architecture.pdf'));
    writeFileSync(join(outDir, 'notes.txt'), 'changed during render');
    writeFileSync(join(outDir, 'late.txt'), 'added during render');
    const result = step('verify');
    expect(result.outcome).toBe('ok');
    expect(readFileSync(join(outDir, 'notes.txt'), 'utf8')).toBe('changed during render');
    expect(readFileSync(join(outDir, 'late.txt'), 'utf8')).toBe('added during render');
    expect(JSON.parse(readFileSync(join(outDir, 'verification.json'), 'utf8')).status).toBe('verified');
    const first = JSON.parse(readFileSync(join(outDir, 'verification.json'), 'utf8')) as { generation: string; immutableDirectory: string; sha256: Record<string, string> };
    const firstDir = join(outDir, first.immutableDirectory);
    expect(readlinkSync(join(outDir, '.architecture-current'))).toBe(first.immutableDirectory);
    for (const name of required) expect(readlinkSync(join(outDir, name))).toBe(`.architecture-current/${name}`);
    for (const [name, digest] of Object.entries(first.sha256))
      expect(createHash('sha256').update(readFileSync(join(firstDir, name))).digest('hex')).toBe(digest);

    // A second publish changes only one pointer; a reader can pin the old verified bundle.
    expect(step('design').outcome).toBe('ok');
    const secondLock = JSON.parse(readFileSync(outDir + '.architecture-run.json', 'utf8')) as { stageDir: string };
    copyFileSync(join(sample, 'architecture.png'), join(secondLock.stageDir, 'architecture.png'));
    copyFileSync(join(sample, 'architecture.pdf'), join(secondLock.stageDir, 'architecture.pdf'));
    expect(step('verify').outcome).toBe('ok');
    const second = JSON.parse(readFileSync(join(outDir, 'verification.json'), 'utf8')) as { generation: string; immutableDirectory: string };
    expect(second.generation).not.toBe(first.generation);
    expect(readlinkSync(join(outDir, '.architecture-current'))).toBe(second.immutableDirectory);
    expect(readFileSync(join(firstDir, 'verification.json'), 'utf8')).toContain(first.generation);
    expect(readFileSync(join(outDir, 'notes.txt'), 'utf8')).toBe('changed during render');
  } finally { rmSync(root, { recursive: true, force: true }); }
  // 출처: the installed graph integration below uses the same 30s renderer budget.
}, 30000);

test('first publish refuses an occupied output directory without deleting its contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'architecture-occupied-output-'));
  try {
    const sample = join(dir, '../../docs/samples/architecture-deliverables/cloud-sim');
    const outDir = join(root, 'out');
    const occupied = join(outDir, 'architecture.pdf');
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, 'owner.txt'), 'preserve this directory');
    writeFileSync(join(outDir, 'verification.json'), 'previous receipt');
    const context = join(root, 'run.json');
    writeFileSync(context, JSON.stringify({ input: { designHtmlPath: join(sample, 'architecture.html'),
      diagramSourcePath: join(sample, 'architecture.excalidraw'), outDir } }));
    const step = (name: string) => JSON.parse(new TextDecoder().decode(Bun.spawnSync(['bun', stepPath, name],
      { env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context }, stdout: 'pipe' }).stdout).trim()) as { outcome: string; error?: string };
    expect(step('design').outcome).toBe('ok');
    const lock = JSON.parse(readFileSync(outDir + '.architecture-run.json', 'utf8')) as { stageDir: string };
    copyFileSync(join(sample, 'architecture.png'), join(lock.stageDir, 'architecture.png'));
    copyFileSync(join(sample, 'architecture.pdf'), join(lock.stageDir, 'architecture.pdf'));
    const result = step('verify');
    expect(result.outcome).toBe('fail');
    expect(result.error).toContain('architecture output path is a directory: architecture.pdf');
    expect(readFileSync(join(occupied, 'owner.txt'), 'utf8')).toBe('preserve this directory');
    expect(readFileSync(join(outDir, 'verification.json'), 'utf8')).toBe('previous receipt');
    expect(existsSync(join(outDir, '.architecture-current'))).toBe(false);
    expect(existsSync(outDir + '.architecture-run.json')).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
  // 출처: the installed graph integration below uses the same 30s renderer budget.
}, 30000);

test('failed diagram releases owned staging so the same output can be retried', () => {
  const root = mkdtempSync(join(tmpdir(), 'architecture-retry-test-'));
  try {
    const sample = join(dir, '../../docs/samples/architecture-deliverables/cloud-sim');
    const outDir = join(root, 'out');
    const context = join(root, 'run.json');
    writeFileSync(context, JSON.stringify({ input: { designHtmlPath: join(sample, 'architecture.html'),
      diagramSourcePath: join(sample, 'architecture.excalidraw'), outDir } }));
    const step = (name: string) => JSON.parse(new TextDecoder().decode(Bun.spawnSync(['bun', stepPath, name],
      { env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context }, stdout: 'pipe' }).stdout).trim()) as { outcome: string };
    expect(step('design').outcome).toBe('ok');
    const lock = JSON.parse(readFileSync(outDir + '.architecture-run.json', 'utf8')) as { stageDir: string };
    writeFileSync(join(lock.stageDir, 'architecture.excalidraw'), '{bad-json');
    expect(step('diagram').outcome).toBe('fail');
    expect(existsSync(lock.stageDir)).toBe(false);
    expect(existsSync(outDir + '.architecture-run.json')).toBe(false);
    expect(step('design').outcome).toBe('ok');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installed plugin graph renders and verifies with explicit existing resource root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'architecture-installed-'));
  try {
    const installed = await installPlugin(dir, { root, yes: true, deferRuntimePreparation: true });
    const sample = join(dir, '../../docs/samples/architecture-deliverables/cloud-sim');
    const outDir = join(root, 'output');
    const input = { designHtmlPath: join(sample, 'architecture.html'), diagramSourcePath: join(sample, 'architecture.excalidraw'), outDir, resourceRoot: join(dir, '../..') };
    const run = await runGraph(join(installed.path, 'graphs/architecture-deliverables.yaml'), { input, quiet: true,
      deps: { root: join(root, 'isolation'), capabilityProviders: createArchitectureDeliverablesRegistry(installed.path) } });
    expect(run.status).toBe('done');
    expect(JSON.parse(readFileSync(join(outDir, 'verification.json'), 'utf8')).status).toBe('verified');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test('CLI selects the installed graph provider from its plugin declaration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'architecture-declared-provider-'));
  try {
    const installed = await installPlugin(dir, { root, yes: true, deferRuntimePreparation: true });
    const outDir = join(root, 'output');
    const input = { structuredDesignPath: join(dir, 'examples/structured-general.json'), outDir, resourceRoot: join(dir, '../..') };
    const result = await simCli(['graph', 'run', join(installed.path, 'graphs/architecture-deliverables.yaml'),
      '--input', JSON.stringify(input), '--json'], { mode: 'spawn', stateRoot: join(root, 'isolation'),
      allowPaths: [['graph', 'run']], timeoutMs: 60_000 }); // Source: #36522
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(outDir, 'verification.json'), 'utf8')).status).toBe('verified');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 65_000);

test('structured JSON input generates editable diagram, HTML, PNG and PDF in an installed graph', async () => {
  const root = mkdtempSync(join(tmpdir(), 'architecture-structured-'));
  try {
    const installed = await installPlugin(dir, { root, yes: true, deferRuntimePreparation: true });
    const outDir = join(root, 'output');
    const run = await runArchitectureDeliverables({ pluginRoot: installed.path, structuredDesignPath: join(dir, 'examples/structured-ticketing-gcp.json'),
      outDir, resourceRoot: join(dir, '../..'), stateRoot: join(root, 'isolation') });
    expect(run.receipt.status).toBe('verified');
    const source = JSON.parse(readFileSync(join(outDir, 'architecture.excalidraw'), 'utf8')) as { metadata: { structuredSchemaVersion: number }; elements: Array<{ id: string }> };
    expect(source.metadata.structuredSchemaVersion).toBe(1);
    expect(source.elements.some(element => element.id === 'node-ledger')).toBe(true);
    expect(readFileSync(join(outDir, 'architecture.html'), 'utf8')).toContain('Cloud SQL');
    expect(JSON.parse(readFileSync(join(outDir, 'verification.json'), 'utf8')).status).toBe('verified');
    expect(readFileSync(join(outDir, 'architecture.pdf')).subarray(0, 4).toString()).toBe('%PDF');
    for (const name of ['architecture.drawio', 'architecture.svg']) {
      const path = join(run.bundleDir, name);
      const original = readFileSync(path);
      rmSync(path);
      expect(() => verifyArchitectureBundleArtifacts(run.bundleDir, run.receipt.sha256)).toThrow(`bundle artifact missing: ${name}`);
      writeFileSync(path, Buffer.concat([original, Buffer.from('\nmodified')]));
      expect(() => verifyArchitectureBundleArtifacts(run.bundleDir, run.receipt.sha256)).toThrow(`digest mismatch: ${name}`);
      writeFileSync(path, original);
      const missingDigest = { ...run.receipt.sha256 };
      delete missingDigest[name];
      expect(() => verifyArchitectureBundleArtifacts(run.bundleDir, missingDigest)).toThrow(`receipt digest missing: ${name}`);
    }
    expect(() => verifyArchitectureBundleArtifacts(run.bundleDir, run.receipt.sha256)).not.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test('structured input rejects undeclared flow targets before writing output', () => {
  const source = JSON.parse(readFileSync(join(dir, 'examples/structured-ticketing-gcp.json'), 'utf8')) as { flows: Array<{ to: string }> };
  source.flows[0]!.to = 'missing-service';
  expect(() => generateStructuredDesign(source)).toThrow('flow endpoint is not a declared node');
});

test('structured input rejects blank table rows before rendering', () => {
  const source = JSON.parse(readFileSync(join(dir, 'examples/structured-ticketing-gcp.json'), 'utf8')) as { requirements: object[] };
  source.requirements = [{}];
  expect(() => generateStructuredDesign(source)).toThrow('requirements[0].id');
});

test('all permitted layer combinations have no overlapping node boxes', () => {
  const source = JSON.parse(readFileSync(join(dir, 'examples/structured-ticketing-gcp.json'), 'utf8')) as { nodes: Array<{ id: string; label: string; layer: string; zone: string; service: string }> };
  const add = (id: string, layer: string, zone: string) => ({ id, label: id, layer, zone, service: id });
  source.nodes.push(add('fans-two', 'users', 'external'), add('fans-three', 'users', 'external'));
  source.nodes.push(add('edge-two', 'edge', 'project'), add('edge-three', 'edge', 'project'));
  source.nodes.push(add('app-two', 'application', 'vpc'), add('app-three', 'application', 'vpc'));
  source.nodes.splice(source.nodes.findIndex(node => node.layer === 'data'), 0, add('archive', 'data', 'project'));
  source.nodes.push({ id: 'alerts', label: 'Alerts', layer: 'observability', zone: 'vpc', service: 'Alerting' });
  source.nodes.push(add('security-two', 'security', 'external'));
  for (const nodes of [source.nodes, [...source.nodes].reverse()]) {
    source.nodes = nodes;
    const diagram = JSON.parse(generateStructuredDesign(source).diagram) as { elements: Array<{ id: string; x: number; y: number; width: number; height: number }> };
    const boxes = diagram.elements.filter(element => nodes.some(node => element.id === `node-${node.id}`));
    const overlaps = (a: typeof boxes[number], b: typeof boxes[number]) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    expect(boxes).toHaveLength(nodes.length);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(overlaps(boxes[i]!, boxes[j]!)).toBe(false);
      }
    }
    const projectData = boxes.find(box => box.id === 'node-archive')!;
    const secondObserve = boxes.find(box => box.id === 'node-alerts')!;
    expect(overlaps(projectData, secondObserve)).toBe(false);
    const legend = diagram.elements.find(element => element.id === 'legend-box')!;
    expect(legend.y).toBeGreaterThanOrEqual(Math.max(...boxes.map(box => box.y + box.height)));
  }
  expect(generateStructuredDesign(source).diagram).not.toContain('private data IP');
});

test('general system design uses the shared template without GCP branding or icons', () => {
  const source = JSON.parse(readFileSync(join(dir, 'examples/structured-general.json'), 'utf8')) as object;
  const generated = generateStructuredDesign(source);
  const diagram = JSON.parse(generated.diagram) as { files: Record<string, unknown>; metadata: { provider: string } };
  expect(diagram.metadata.provider).toBe('generic');
  expect(Object.keys(diagram.files)).toHaveLength(0);
  expect(generated.diagram).toContain('SYSTEM SCOPE');
  expect(generated.html).toContain('SYSTEM ARCHITECTURE / GENERAL');
  expect(generated.html).not.toContain('Google Cloud official icons');
});

test('general profile completes the same v2 output graph', async () => {
  const root = mkdtempSync(join(tmpdir(), 'architecture-general-'));
  try {
    const installed = await installPlugin(dir, { root, yes: true, deferRuntimePreparation: true });
    const result = await runArchitectureDeliverables({ pluginRoot: installed.path,
      structuredDesignPath: join(dir, 'examples/structured-general.json'), outDir: join(root, 'output'),
      resourceRoot: join(dir, '../..'), stateRoot: join(root, 'isolation') });
    expect(result.receipt.contract).toBe('system-architecture@2');
    expect(readFileSync(join(root, 'output/architecture.pdf')).subarray(0, 4).toString()).toBe('%PDF');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test('v2 output graph fails closed without the common capability provider', async () => {
  const root = mkdtempSync(join(tmpdir(), 'architecture-no-provider-'));
  try {
    const run = await runGraph(join(dir, 'graphs/architecture-deliverables.yaml'), { input: {
      structuredDesignPath: join(dir, 'examples/structured-general.json'), outDir: join(root, 'output'), resourceRoot: join(dir, '../..'),
    }, quiet: true, deps: { root: join(root, 'state') } });
    expect(run.status).toBe('failed');
    expect(run.path).toEqual(['design', 'failed']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('PDF body sections cannot be satisfied by a contents row alone', () => {
  const text = '목차\n요약 · 배경 · 요구사항\n구성도 · 데이터 흐름\n';
  expect(missingPdfBodySections(text, ['배경', '요구사항', '구성도'])).toEqual(['배경', '요구사항', '구성도']);
  expect(missingPdfBodySections(text + '\n배경\n이 절에는 실제 시스템 배경과 트래픽 가정을 상세히 설명한다.\n', ['배경', '요구사항'])).toEqual(['요구사항']);
  const standaloneToc = '목차\n배경\n2\n요구사항\n3\n구성도\n4\n';
  expect(missingPdfBodySections(standaloneToc, ['배경', '요구사항', '구성도'])).toEqual(['배경', '요구사항', '구성도']);
  expect(missingPdfBodySections('결정 기록\n6\n부록\n실제 부록 내용이 길게 이어져도 결정 기록 본문은 비어 있다.\n', ['결정 기록'])).toEqual(['결정 기록']);
  expect(missingPdfBodySections('결정 기록\n6\n부록 A. 운영 가정\n부록 내용이 충분히 길어도 앞 결정 기록의 본문은 아니다.\n', ['결정 기록'])).toEqual(['결정 기록']);
});

test('a trailing slash on a new output directory keeps the lock beside that directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'architecture-slash-output-'));
  try {
    const sample = join(dir, '../../docs/samples/architecture-deliverables/cloud-sim');
    const outDir = join(root, 'new-output');
    const context = join(root, 'run.json');
    writeFileSync(context, JSON.stringify({ input: { designHtmlPath: join(sample, 'architecture.html'),
      diagramSourcePath: join(sample, 'architecture.excalidraw'), outDir: `${outDir}/` } }));
    const run = Bun.spawnSync(['bun', stepPath, 'design'],
      { env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context }, stdout: 'pipe' });
    expect(JSON.parse(new TextDecoder().decode(run.stdout).trim()).outcome).toBe('ok');
    expect(existsSync(outDir + '.architecture-run.json')).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
