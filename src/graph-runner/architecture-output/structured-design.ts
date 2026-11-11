import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Row = Record<string, unknown>;
const obj = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const value = (row: Row, key: string): string => typeof row[key] === 'string' ? String(row[key]).trim() : '';
const items = (row: Row, key: string): Row[] => Array.isArray(row[key]) ? (row[key] as unknown[]).map(obj) : [];
const text = (input: unknown, name: string): string => {
  if (typeof input !== 'string' || !input.trim()) throw new Error(`structured design ${name} required`);
  return input.trim();
};
const escaped = (input: unknown): string => String(input ?? '').replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const circled = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨'];
const LAYERS = ['users', 'edge', 'application', 'data', 'observability', 'security'] as const;
const LAYER_LABELS: Record<string, string> = { users: 'USERS', edge: 'EDGE', application: 'APPLICATION', data: 'DATA', observability: 'OBSERVABILITY', security: 'SECURITY' };
const LAYER_X: Record<string, number> = { users: 60, edge: 390, application: 720, data: 1050, observability: 1050, security: 60 };
const COLORS: Record<string, string> = { users: '#ea580c', edge: '#2563eb', application: '#1d4ed8', data: '#16a34a', observability: '#64748b', security: '#dc2626' };
const pluginRoot = process.env.ELANOUS_ARCHITECTURE_PLUGIN_ROOT || resolve(import.meta.dir, '../../../plugins/architecture-deliverables');
const iconDataPath = join(pluginRoot, 'references/official-gcp-icon-data.json');
const registryPath = join(pluginRoot, 'references/official-gcp-icons.json');

export interface StructuredDesignResult { html: string; diagram: string; nodeCount: number; flowCount: number; }

export function generateStructuredDesign(raw: unknown): StructuredDesignResult {
  const d = obj(raw);
  if (d.schemaVersion !== 1) throw new Error('structured design schemaVersion must be 1');
  const title = text(d.title, 'title');
  const version = text(d.version, 'version');
  if (!/^v?\d+\.\d+$/u.test(version)) throw new Error('structured design version must be major.minor');
  const summary = text(d.summary, 'summary');
  const background = text(d.background, 'background');
  const deployment = obj(d.deployment);
  const provider = value(deployment, 'provider').toLowerCase();
  if (provider !== 'gcp' && provider !== 'generic') throw new Error('structured design provider must be gcp or generic');
  const project = text(deployment.project, 'deployment.project');
  const region = text(deployment.region, 'deployment.region');
  const vpc = text(deployment.vpc, 'deployment.vpc');
  const nodes = items(d, 'nodes');
  const flows = items(d, 'flows');
  if (nodes.length < 4 || flows.length < 2 || flows.length > 9) throw new Error('structured design needs at least 4 nodes and 2–9 flows');
  for (const section of ['requirements', 'security', 'capacity', 'costs', 'savings', 'alternatives', 'decisions']) {
    if (items(d, section).length === 0) throw new Error(`structured design ${section} requires rows`);
  }
  const requiredColumns: Record<string, string[]> = {
    requirements: ['id', 'kind', 'statement', 'verification'], security: ['class', 'data', 'controls'],
    capacity: ['item', 'assumption', 'verification'], costs: ['item', 'formula'],
    savings: ['name', 'mechanism', 'guardrail'], alternatives: ['name', 'when', 'tradeoff'],
    decisions: ['id', 'decision', 'rationale', 'revisit'],
  };
  for (const [section, keys] of Object.entries(requiredColumns)) {
    for (const [index, row] of items(d, section).entries()) {
      for (const key of keys) text(row[key], `${section}[${index}].${key}`);
    }
  }
  for (const [index, row] of items(d, 'references').entries()) {
    text(row.title, `references[${index}].title`);
    text(row.url, `references[${index}].url`);
  }
  const seen = new Set<string>();
  const perLayer: Record<string, number> = {};
  const positions = new Map<string, { x: number; y: number; w: number; h: number; layer: string; zone: string }>();
  for (const node of nodes) {
    const id = text(node.id, 'node.id');
    if (!/^[a-z][a-z0-9-]*$/u.test(id)) throw new Error(`node id must be lowercase slug: ${id}`);
    const layer = text(node.layer, `node ${id} layer`).toLowerCase();
    if (!LAYERS.includes(layer as typeof LAYERS[number])) throw new Error(`unknown layer ${layer}`);
    if (seen.has(id)) throw new Error(`duplicate node ${id}`);
    seen.add(id);
    text(node.label, `node ${id} label`);
    text(node.service, `node ${id} service`);
    if (node.details !== undefined && (!Array.isArray(node.details) || node.details.some(detail => typeof detail !== 'string' || !detail.trim())))
      throw new Error(`node ${id} details must be nonempty strings`);
    if (Array.isArray(node.details) && node.details.length > 2) throw new Error(`node ${id} supports at most 2 detail lines`);
    if (node.icon !== undefined && (typeof node.icon !== 'string' || !node.icon.trim())) throw new Error(`node ${id} icon must be a nonempty source path`);
    const zone = text(node.zone, `node ${id} zone`);
    if (!['external', 'project', 'vpc'].includes(zone)) throw new Error(`invalid zone ${zone}`);
    if (layer === 'users' && zone !== 'external') throw new Error('users layer must be external');
    if (layer === 'edge' && zone !== 'project' && !(provider === 'gcp' && zone === 'external')) throw new Error('edge layer must be in project');
    if (['application', 'data'].includes(layer) && zone !== 'vpc' && !(provider === 'gcp' && zone === 'project')) throw new Error(`${layer} layer must be in VPC or managed project scope`);
    if (layer === 'observability' && zone !== 'vpc' && !(provider === 'gcp' && zone === 'project')) throw new Error('observability layer must be in VPC or managed project scope');
    if (layer === 'security' && zone !== 'external') throw new Error('security control layer must be external');
    const row = perLayer[layer] ?? 0;
    if (row >= (layer === 'security' || layer === 'observability' ? 2 : 3)) throw new Error(`too many nodes in layer: ${layer}`);
    perLayer[layer] = row + 1;
    const x = zone === 'external' ? 60 : layer === 'observability' && row === 1 ? 720 : LAYER_X[layer]!;
    const y = layer === 'observability' ? 905 : layer === 'security' ? 750 + row * 150 : 370 + row * 180;
    positions.set(id, { x, y, w: 260, h: 140, layer, zone });
  }
  for (const flow of flows) {
    if (!positions.has(value(flow, 'from')) || !positions.has(value(flow, 'to'))) throw new Error('flow endpoint is not a declared node');
    text(flow.label, 'flow.label');
    if (!['sync', 'async', 'telemetry'].includes(value(flow, 'kind'))) throw new Error('flow.kind must be sync, async, or telemetry');
  }
  for (const row of items(d, 'costs')) {
    if (typeof row.monthlyUsd !== 'number' || !Number.isFinite(row.monthlyUsd) || row.monthlyUsd < 0) throw new Error('costs.monthlyUsd must be a nonnegative finite number');
  }

  let seq = 0;
  const shape = (id: string, type: string, x: number, y: number, width: number, height: number, strokeColor: string, backgroundColor = 'transparent'): Row => ({
    id, type, x, y, width, height, angle: 0, strokeColor, backgroundColor, fillStyle: 'solid', strokeWidth: 2,
    strokeStyle: 'solid', roughness: 0, opacity: 100, seed: 50000 + ++seq, version: 1, versionNonce: 70000 + seq,
    isDeleted: false, groupIds: [], boundElements: null, updated: 1, link: null, locked: false,
    ...(type === 'rectangle' ? { roundness: { type: 3 } } : {}),
  });
  const label = (id: string, content: string, x: number, y: number, width: number, size = 18, color = '#233b57'): Row => ({
    ...shape(id, 'text', x, y, width, Math.max(26, content.split('\n').length * size * 1.4), color),
    text: content, originalText: content, fontSize: size, fontFamily: 3, textAlign: 'left', verticalAlign: 'middle', lineHeight: 1.25, containerId: null,
  });
  const elements: Row[] = [];
  elements.push(label('title', title.toUpperCase(), 55, 45, 1260, 31, '#123b69'));
  elements.push(label('subtitle', `architecture ${version.startsWith('v') ? version : 'v' + version}  ·  ${region}  ·  generated from structured design`, 55, 95, 1260, 17, '#52657b'));
  elements.push(shape('project-boundary', 'rectangle', 355, 205, 1015, 920, '#93c5fd', '#f8fbff'));
  elements.push(label('project-label', `${provider === 'gcp' ? 'GOOGLE CLOUD PROJECT' : 'SYSTEM SCOPE'}  ·  ${project}`, 380, 225, 900, 20, '#1d4ed8'));
  elements.push(shape('region-boundary', 'rectangle', 690, 275, 650, 800, '#60a5fa'));
  elements.push(label('region-label', `${provider === 'gcp' ? 'REGION' : 'ZONE'}  ${region}`, 715, 293, 590, 18, '#1d4ed8'));
  const privateNodes = [...positions.values()].filter(pos => pos.zone === 'vpc');
  if (privateNodes.length) {
    // Source: the VPC boundary is drawn around only nodes declared as VPC resources; managed services may sit in project scope.
    const minX = Math.min(...privateNodes.map(pos => pos.x)) - 20;
    const minY = Math.min(...privateNodes.map(pos => pos.y)) - 35;
    const maxX = Math.max(...privateNodes.map(pos => pos.x + pos.w)) + 20;
    const maxY = Math.max(...privateNodes.map(pos => pos.y + pos.h)) + 20;
    elements.push(shape('vpc-boundary', 'rectangle', minX, minY, maxX - minX, maxY - minY, '#3b82f6', '#eff6ff'));
    elements.push(label('vpc-label', `${provider === 'gcp' ? 'VPC' : 'NETWORK'}  ${vpc}`, minX + 25, minY + 9, maxX - minX - 50, 17, '#1e40af'));
  } else {
    // Source: the shared deliverable contract requires a VPC shape; an empty boundary does not claim managed services are inside it.
    elements.push(shape('vpc-boundary', 'rectangle', 700, 750, 300, 120, '#3b82f6', '#eff6ff'));
    elements.push(label('vpc-label', provider === 'gcp' ? 'VPC · EMPTY' : `NETWORK ${vpc}`, 725, 765, 250, 17, '#1e40af'));
  }
  const files: Row = {};
  const iconAssets: Row = {};
  const registry = obj(JSON.parse(readFileSync(registryPath, 'utf8')) as unknown);
  const assets = obj(registry.assets);
  const iconData = obj(JSON.parse(readFileSync(iconDataPath, 'utf8')) as unknown);
  let iconCount = 0;
  for (const node of nodes) {
    const id = value(node, 'id');
    const pos = positions.get(id)!;
    const color = COLORS[pos.layer]!;
    elements.push(shape(`node-${id}`, 'rectangle', pos.x, pos.y, pos.w, pos.h, color, '#ffffff'));
    elements.push(label(`node-${id}-title`, LAYER_LABELS[pos.layer]!, pos.x + 20, pos.y + 12, pos.w - 65, 17, color));
    elements.push(label(`node-${id}-body`, [value(node, 'label'), value(node, 'service'), ...(Array.isArray(node.details) ? node.details.map(String) : [])].filter(Boolean).join('\n'), pos.x + 20, pos.y + 51, pos.w - 30, 14, '#334155'));
    const icon = value(node, 'icon');
    if (icon) {
      if (provider !== 'gcp') throw new Error('generic design uses editable vector shapes without GCP icons');
      const expected = value(obj(assets[icon]), 'sha256');
      if (!expected) throw new Error(`official icon source not registered: ${icon}`);
      const encoded = value(iconData, icon);
      if (!encoded) throw new Error(`official icon bytes missing: ${icon}`);
      const bytes = Buffer.from(encoded, 'base64');
      if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`official icon bytes mismatch: ${icon}`);
      const fileId = `icon-${createHash('sha256').update(icon).digest('hex').slice(0, 12)}`;
      files[fileId] = { id: fileId, mimeType: 'image/png', dataURL: `data:image/png;base64,${bytes.toString('base64')}`, created: 1, lastRetrieved: 1 };
      iconAssets[fileId] = icon;
      elements.push({ ...shape(`node-${id}-icon`, 'image', pos.x + pos.w - 50, pos.y + 15, 30, 30, color), fileId, scale: [1, 1], status: 'saved' });
      iconCount++;
    }
  }
  if (provider === 'gcp' && iconCount < 3) throw new Error('GCP structured design requires at least 3 official icon nodes');
  for (const [index, flow] of flows.entries()) {
    const from = positions.get(value(flow, 'from'))!;
    const to = positions.get(value(flow, 'to'))!;
    const right = to.x > from.x;
    const left = to.x < from.x;
    const x1 = right ? from.x + from.w : left ? from.x : from.x + from.w / 2;
    const y1 = right || left ? from.y + from.h / 2 : from.y + from.h;
    const x2 = right ? to.x : left ? to.x + to.w : to.x + to.w / 2;
    const y2 = right || left ? to.y + to.h / 2 : to.y;
    const kind = value(flow, 'kind');
    const color = kind === 'async' ? '#8b5cf6' : kind === 'telemetry' ? '#64748b' : '#2563eb';
    elements.push({ ...shape(`flow-${index + 1}`, 'arrow', x1, y1, x2 - x1, y2 - y1, color), points: [[0,0],[x2-x1,y2-y1]],
      strokeStyle: kind === 'sync' ? 'solid' : 'dashed', startArrowhead: null, endArrowhead: 'arrow', elbowed: false, roundness: null, startBinding: null, endBinding: null });
    elements.push(label(`flow-${index + 1}-number`, circled[index]!, (x1+x2)/2 - 10, (y1+y2)/2 - 32, 32, 22, color));
  }
  elements.push(shape('legend-box', 'rectangle', 55, 1170, 1290, 105, '#cbd5e1', '#f8fafc'));
  elements.push(label('legend', 'LEGEND   → synchronous request      ⇢ asynchronous event      ⋯ telemetry', 80, 1190, 1190, 17, '#334155'));
  elements.push(label('legend-note', 'Boundaries are logical. Flow numbers correspond to the data flow table in the PDF.', 80, 1230, 1190, 14, '#64748b'));
  const diagram = JSON.stringify({ type: 'excalidraw', version: 2, source: 'elanous/architecture-deliverables', elements,
    appState: { viewBackgroundColor: '#ffffff' }, files, metadata: { provider, iconLibraryUrl: provider === 'gcp' ? 'https://cloud.google.com/icons' : '', iconAssets, structuredSchemaVersion: 1 } }, null, 2) + '\n';

  const table = (headers: string[], rows: string[][]): string => `<table class="table"><thead><tr>${headers.map(h => `<th>${escaped(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${escaped(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const sectionRows = (name: string, keys: string[]): string[][] => items(d, name).map(row => keys.map(key => String(row[key] ?? '')));
  const flowRows = flows.map((flow, index) => [circled[index]!, value(flow, 'from'), value(flow, 'to'), value(flow, 'label'), value(flow, 'kind')]);
  const costRows = items(d, 'costs').map(row => [value(row, 'item'), value(row, 'formula'), String(row.monthlyUsd ?? '')]);
  const referenceHtml = items(d, 'references').map(row => `<li>${escaped(value(row, 'title'))}: ${escaped(value(row, 'url'))}</li>`).join('');
  const css = readFileSync(join(pluginRoot, 'references/structured-template.css'), 'utf8');
  // Source: the flow table needs a dedicated page when the diagram has more than six numbered flows.
  const longFlow = flows.length > 6;
  const tocRows = longFlow
    ? [['요약 · 배경 · 요구사항','2'],['구성도','3'],['데이터 흐름','4'],['보안 등급 · 용량','5'],['비용 예측 · 절감안 · 대안','6'],['결정 기록 · 부록','7']]
    : [['요약 · 배경 · 요구사항','2'],['구성도 · 데이터 흐름','3'],['보안 등급 · 용량','4'],['비용 예측 · 절감안 · 대안','5'],['결정 기록 · 부록','6']];
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escaped(title)}</title><style>${css}</style></head><body>
<section class="cover"><div><p class="kicker">SYSTEM ARCHITECTURE / ${provider === 'gcp' ? 'GOOGLE CLOUD' : 'GENERAL'}</p><h1>${escaped(title)}</h1><p class="subtitle">${escaped(summary)}</p></div><div class="meta">Architecture ${escaped(version)} · ${escaped(region)} · Structured design input v1</div></section>
<section class="page"><p class="head">01 / SUMMARY</p><h2>목차</h2>${table(['내용','쪽'],tocRows)}<h2>요약</h2><div class="summary">${escaped(summary)}</div><h2>배경</h2><p>${escaped(background)}</p><h2>요구사항</h2>${table(['ID','유형','요구사항','검증'],sectionRows('requirements',['id','kind','statement','verification']))}</section>
<section class="page"><p class="head">02 / ARCHITECTURE</p><h2>구성도</h2><img class="diagram" src="architecture.png" alt="Structured system architecture diagram"><p class="caption">${provider === 'gcp' ? 'Google Cloud official icons · ' : ''}editable source: architecture.excalidraw · architecture ${escaped(version)}</p>${longFlow ? '</section><section class="page"><p class="head">03 / DATA FLOW</p>' : ''}<h2>데이터 흐름</h2>${table(['#','출발','도착','동작','형식'],flowRows)}</section>
<section class="page"><p class="head">${longFlow ? '04' : '03'} / SECURITY AND SCALE</p><h2>보안 등급</h2>${table(['등급','데이터','통제'],sectionRows('security',['class','data','controls']))}<h2>용량·확장</h2>${table(['항목','가정','검증'],sectionRows('capacity',['item','assumption','verification']))}</section>
<section class="page"><p class="head">${longFlow ? '05' : '04'} / COST AND OPTIONS</p><h2>비용 예측</h2><p>입력의 가정 단가를 사용한 계획값이며 공급자 견적이 아니다.</p>${table(['항목','산식','월 USD'],costRows)}<h2>절감안</h2>${table(['안','기제','안전 조건'],sectionRows('savings',['name','mechanism','guardrail']))}<h2>대안</h2>${table(['대안','선택 기준','보류 이유'],sectionRows('alternatives',['name','when','tradeoff']))}</section>
<section class="page"><p class="head">${longFlow ? '06' : '05'} / DECISIONS AND SOURCES</p><h2>결정 기록</h2>${table(['ID','결정','근거','재검토 조건'],sectionRows('decisions',['id','decision','rationale','revisit']))}<h2>부록</h2><h3>출처</h3><ul>${referenceHtml}</ul><h3>검증 범위</h3><p>구조화 JSON에서 편집 도식과 문서 원고를 생성한 뒤 기존 diagram-master 및 PDF 조판 경로로 렌더한다. 아이콘 바이트·문서 절·PDF 페이지를 검증한다. 설계 타당성과 실제 비용은 별도 검토 대상이다.</p></section></body></html>`;
  return { html, diagram, nodeCount: nodes.length, flowCount: flows.length };
}
