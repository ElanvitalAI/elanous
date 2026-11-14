type Element = Record<string, unknown>;
type Diagram = { elements: Element[]; files?: Record<string, { dataURL?: string }> };
const xml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const color = (value: unknown, fallback: string): string => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/u.test(value) ? value : fallback;
const image = (diagram: Diagram, element: Element): string => {
  const data = diagram.files?.[String(element.fileId)]?.dataURL ?? '';
  return /^data:image\/(?:png|svg\+xml);base64,[A-Za-z0-9+/=]+$/u.test(data) ? data : '';
};

/** Two editable views are derived from the same validated Excalidraw elements. */
export function exportEditableDiagram(source: string): { drawio: string; svg: string } {
  const diagram = JSON.parse(source) as Diagram;
  if (!Array.isArray(diagram.elements)) throw new Error('Excalidraw elements required for exports');
  const nodes = new Map(diagram.elements.filter(element => element.type === 'rectangle' && /^node-[a-z][a-z0-9-]*$/u.test(String(element.id)) && !String(element.id).endsWith('-local-icon-box'))
    .map(element => [String(element.id), element]));
  const flowNumbers = new Map(diagram.elements.filter(element => element.type === 'text' && /^flow-\d+-number$/u.test(String(element.id)))
    .map(element => [String(element.id).replace(/-number$/u, ''), String(element.text ?? '')]));
  const parentOf = (element: Element): Element | undefined => {
    const id = String(element.id);
    const suffix = /-(?:local-icon-box|local-icon|title|body|icon)$/u.exec(id);
    return suffix ? nodes.get(id.slice(0, -suffix[0].length)) : undefined;
  };
  const cells: string[] = [];
  const svg: string[] = [];
  for (const element of diagram.elements) {
    const id = xml(element.id);
    const x = number(element.x), y = number(element.y), w = number(element.width), h = number(element.height);
    const parent = parentOf(element);
    const parentId = parent ? xml(parent.id) : '1';
    const cellX = parent ? x - number(parent.x) : x;
    const cellY = parent ? y - number(parent.y) : y;
    const stroke = color(element.strokeColor, '#334155');
    if (element.type === 'rectangle') {
      const fill = color(element.backgroundColor, '#ffffff');
      cells.push(`<mxCell id="${id}" value="" style="rounded=1;whiteSpace=wrap;html=1;strokeColor=${stroke};fillColor=${fill};${nodes.has(String(element.id)) ? 'container=1;collapsible=0;' : ''}" vertex="1" parent="${parentId}"><mxGeometry x="${cellX}" y="${cellY}" width="${w}" height="${h}" as="geometry"/></mxCell>`);
      svg.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
    } else if (element.type === 'text') {
      const label = String(element.text ?? '');
      const size = Math.max(10, Math.min(48, number(element.fontSize) || 16));
      if (!/^flow-\d+-number$/u.test(String(element.id)))
        cells.push(`<mxCell id="${id}" value="${xml(label).replace(/\n/gu, '&lt;br&gt;')}" style="text;html=1;whiteSpace=wrap;strokeColor=none;fillColor=none;fontColor=${stroke};fontSize=${size};" vertex="1" parent="${parentId}"><mxGeometry x="${cellX}" y="${cellY}" width="${w}" height="${h}" as="geometry"/></mxCell>`);
      svg.push(`<text x="${x}" y="${y + size}" fill="${stroke}" font-size="${size}" font-family="Arial,sans-serif">${label.split('\n').map((line, index) => `<tspan x="${x}" dy="${index ? size * 1.25 : 0}">${xml(line)}</tspan>`).join('')}</text>`);
    } else if (element.type === 'image') {
      const data = image(diagram, element);
      if (!data) throw new Error(`embedded icon missing for ${String(element.id)}`);
      // draw.io's style parser splits on semicolons; its image codec restores the omitted base64 marker.
      cells.push(`<mxCell id="${id}" value="" style="shape=image;image=${xml(data.replace(';base64,', ','))};strokeColor=none;fillColor=none;" vertex="1" parent="${parentId}"><mxGeometry x="${cellX}" y="${cellY}" width="${w}" height="${h}" as="geometry"/></mxCell>`);
      svg.push(`<image x="${x}" y="${y}" width="${w}" height="${h}" href="${xml(data)}"/>`);
    } else if (element.type === 'arrow') {
      const points = Array.isArray(element.points) ? element.points as unknown[][] : [];
      const end = points.at(-1) ?? [w, h];
      const x2 = x + number(end[0]), y2 = y + number(end[1]);
      const path = (points.length ? points : [[0, 0], [w, h]])
        .map((point, index) => `${index ? 'L' : 'M'} ${x + number(point[0])} ${y + number(point[1])}`).join(' ');
      const start = (element.startBinding as { elementId?: unknown } | null)?.elementId;
      const finish = (element.endBinding as { elementId?: unknown } | null)?.elementId;
      const attached = typeof start === 'string' && typeof finish === 'string' && nodes.has(start) && nodes.has(finish);
      // Preserve routed bends while the endpoints remain attached to editable node cells.
      const bends = points.slice(1, -1).map(point => `<mxPoint x="${x + number(point[0])}" y="${y + number(point[1])}"/>`).join('');
      const waypoints = bends ? `<Array as="points">${bends}</Array>` : '';
      cells.push(`<mxCell id="${id}" value="${xml(flowNumbers.get(String(element.id)) ?? '')}" style="endArrow=block;html=1;strokeColor=${stroke};${bends ? 'edgeStyle=segmentEdgeStyle;' : ''}${element.strokeStyle === 'dashed' ? 'dashed=1;' : ''}" edge="1" parent="1"${attached ? ` source="${xml(start)}" target="${xml(finish)}"` : ''}><mxGeometry relative="1" as="geometry">${waypoints}${attached ? '' : `<mxPoint x="${x}" y="${y}" as="sourcePoint"/><mxPoint x="${x2}" y="${y2}" as="targetPoint"/>`}</mxGeometry></mxCell>`);
      svg.push(`<path d="${path}" fill="none" stroke="${stroke}" stroke-width="2"${element.strokeStyle === 'dashed' ? ' stroke-dasharray="8 5"' : ''} marker-end="url(#arrow)"/>`);
    }
  }
  const drawio = `<?xml version="1.0" encoding="UTF-8"?><mxfile host="app.diagrams.net" version="24.7.17"><diagram name="Architecture" id="architecture"><mxGraphModel dx="1500" dy="1400" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="1500" pageHeight="1400"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel></diagram></mxfile>\n`;
  const svgSource = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1500" height="1400" viewBox="0 0 1500 1400"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#334155"/></marker></defs><rect width="1500" height="1400" fill="#ffffff"/>${svg.join('')}</svg>\n`;
  return { drawio, svg: svgSource };
}
