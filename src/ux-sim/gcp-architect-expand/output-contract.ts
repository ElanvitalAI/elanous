import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export type OutputCheck = { ok: boolean; errors: string[] };
type DiagramElement = { id?: string; type: string; x: number; y: number; width: number; height: number;
  text?: string; fontSize?: number; lineHeight?: number };

function renderedTextBox(item: DiagramElement) {
  const font = item.fontSize ?? 20;
  const lines = (item.text ?? '').split('\n');
  const width = Math.max(...lines.map(line => [...line].reduce((sum, char) =>
    sum + font * (/[^\u0000-\u007f]/u.test(char) ? 1 : 0.62), 0)), 0);
  return { left: item.x, top: item.y, right: item.x + width,
    bottom: item.y + lines.length * font * (item.lineHeight ?? 1.25) };
}

/** Check rendered text against every rectangular border, including nested VPC/project bounds. */
export function diagramTextBorderCollisions(elements: DiagramElement[], inset = 5): string[] {
  const boxes = elements.filter(item => item.type === 'rectangle' && Number.isFinite(item.x)
    && Number.isFinite(item.y) && Number.isFinite(item.width) && Number.isFinite(item.height));
  const failures: string[] = [];
  for (const item of elements.filter(value => value.type === 'text')) {
    if (!item.text || !Number.isFinite(item.x) || !Number.isFinite(item.y) || !Number.isFinite(item.fontSize)) continue;
    const text = renderedTextBox(item);
    for (const box of boxes) {
      const left = box.x, top = box.y, right = left + box.width, bottom = top + box.height;
      const intersects = text.left < right + inset && text.right > left - inset
        && text.top < bottom + inset && text.bottom > top - inset;
      const within = text.left >= left + inset && text.top >= top + inset
        && text.right <= right - inset && text.bottom <= bottom - inset;
      const outside = text.right <= left - inset || text.left >= right + inset
        || text.bottom <= top - inset || text.top >= bottom + inset;
      if (intersects && !within && !outside) failures.push(`${item.id ?? '?'} ↔ ${box.id ?? '?'}`);
    }
  }
  return failures;
}

const contract = JSON.parse(readFileSync(new URL('../../../plugins/gcp-architect-expand/output-contract.json', import.meta.url), 'utf8')) as {
  requiredArtifacts: { name: string }[]; requiredSections: string[]; requiredDocumentParts: string[];
  diagramQuality: { requiredBoundaryLabels: string[]; requiredLayerLabels: string[];
    minimumNumberedFlows: number; minimumOfficialIcons: number; minimumTextBorderInsetPx: number;
    requiresLegend: boolean; requiresVersion: boolean };
};

export function verifyArchitectureOutput(directory: string): OutputCheck {
  const errors: string[] = [];
  for (const { name } of contract.requiredArtifacts) {
    const path = join(directory, name);
    if (!existsSync(path) || statSync(path).size === 0) errors.push(`missing or empty: ${name}`);
  }
  if (errors.length) return { ok: false, errors };
  try {
    const diagram = JSON.parse(readFileSync(join(directory, 'architecture.excalidraw'), 'utf8'));
    const elements = Array.isArray(diagram.elements) ? diagram.elements : [];
    if (diagram.type !== 'excalidraw' || elements.length < 5)
      errors.push('invalid editable Excalidraw diagram');
    const labels = elements.filter((item: { type: string }) => item.type === 'text')
      .map((item: { text?: string }) => item.text ?? '');
    const content = labels.join('\n');
    for (const label of [...contract.diagramQuality.requiredBoundaryLabels, ...contract.diagramQuality.requiredLayerLabels])
      if (!content.includes(label)) errors.push(`missing diagram boundary or layer: ${label}`);
    const numbers = new Set(labels.filter((value: string) => /^\d+$/.test(value)).map(Number));
    for (let n = 1; n <= contract.diagramQuality.minimumNumberedFlows; n++)
      if (!numbers.has(n)) errors.push(`missing numbered flow: ${n}`);
    if (contract.diagramQuality.requiresLegend && !content.includes('범례')) errors.push('missing diagram legend');
    if (contract.diagramQuality.requiresVersion && !/v\d+\.\d+/.test(content)) errors.push('missing diagram version');
    const collisions = diagramTextBorderCollisions(elements, contract.diagramQuality.minimumTextBorderInsetPx);
    if (collisions.length) errors.push(`diagram text-border collisions (${collisions.length}): ${collisions.join(', ')}`);
    const images = elements.filter((item: { type: string; fileId?: string }) => item.type === 'image' && item.fileId);
    if (images.length < contract.diagramQuality.minimumOfficialIcons) errors.push('insufficient official service icons');
    try {
      const provenance = JSON.parse(readFileSync(join(directory, 'icon-provenance.json'), 'utf8'));
      if (provenance.sourcePage !== 'https://cloud.google.com/icons' || !Number.isFinite(Date.parse(provenance.checkedAt)))
        errors.push('invalid official icon provenance');
      for (const image of images) {
        const source = diagram.files?.[image.fileId]?.dataURL;
        const expected = provenance.embeddedSha256?.[image.fileId];
        const actual = typeof source === 'string' && source.startsWith('data:image/png;base64,')
          ? createHash('sha256').update(Buffer.from(source.split(',')[1], 'base64')).digest('hex') : null;
        if (!actual || actual !== expected) errors.push(`icon provenance mismatch: ${image.fileId}`);
      }
    } catch { errors.push('invalid official icon provenance JSON'); }
  } catch { errors.push('invalid editable Excalidraw JSON'); }
  const png = readFileSync(join(directory, 'architecture.png'));
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) errors.push('invalid PNG render');
  const pdf = readFileSync(join(directory, 'architecture-design.pdf'));
  if (pdf.subarray(0, 5).toString() !== '%PDF-') errors.push('invalid PDF');
  const htmlPath = join(directory, 'architecture-design.html');
  if (!existsSync(htmlPath)) errors.push('missing PDF source HTML');
  else {
    const html = readFileSync(htmlPath, 'utf8');
    for (const section of contract.requiredSections) if (!html.includes(`<h2>${section}</h2>`)) errors.push(`missing section: ${section}`);
    for (const part of contract.requiredDocumentParts) if (!html.includes(`<section class="sheet" id="${part}">`))
      errors.push(`missing document part: ${part}`);
    if (!html.includes('architecture.png')) errors.push('PDF source does not embed diagram');
  }
  return { ok: errors.length === 0, errors };
}
