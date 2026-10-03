import { deflateRawSync, inflateRawSync } from 'node:zlib';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
const HH = 'http://www.hancom.co.kr/hwpml/2011/head';
/** HWPX section root lives in the section namespace (OWPML `hs:sec`), not the paragraph one. */
const HS = 'http://www.hancom.co.kr/hwpml/2011/section';
const OPF = 'http://www.idpf.org/2007/opf/';
const HWP_NOTICE = 'HWP(옛 바이너리)는 지원 안 함 · hwpx 로 저장해 달라';

type XmlNode = { name: string; attrs: Record<string, string>; children: XmlNode[]; content: (XmlNode | string)[] };
const local = (name: string) => name.split(':').pop()!;
const xmlEscape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function unescapeXml(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (entity[0] !== '#') return named[entity] ?? `&${entity};`;
    const cp = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    if (cp > 0x10ffff || cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) throw new Error('Invalid XML character');
    return String.fromCodePoint(cp);
  });
}
function parseXml(xml: string): XmlNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('External XML entities are not supported');
  const root: XmlNode = { name: '', attrs: {}, children: [], content: [] };
  const stack = [root];
  const tokens = xml.match(/<[^>]*>|[^<]+/g) ?? [];
  for (const token of tokens) {
    if (token.startsWith('<?') || token.startsWith('<!--')) continue;
    if (token.startsWith('</')) {
      if (local(stack.at(-1)!.name) !== local(token.slice(2, -1).trim()) || stack.length === 1) throw new Error('Invalid HWPX XML');
      stack.pop();
    } else if (token.startsWith('<')) {
      if (token.startsWith('<!')) throw new Error('Unsupported HWPX XML declaration');
      const match = /^<([\w:.-]+)(?:\s|\/?>)/.exec(token);
      if (!match) throw new Error('Invalid HWPX XML');
      const attrs: Record<string, string> = {};
      for (const attr of token.slice(match[0].length).matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g)) attrs[local(attr[1]!)] = unescapeXml(attr[3]!);
      const node: XmlNode = { name: local(match[1]!), attrs, children: [], content: [] };
      stack.at(-1)!.children.push(node);
      stack.at(-1)!.content.push(node);
      if (!token.endsWith('/>')) stack.push(node);
    } else {
      stack.at(-1)!.content.push(unescapeXml(token));
    }
  }
  if (stack.length !== 1 || root.children.length !== 1) throw new Error('Invalid HWPX XML');
  return root.children[0]!;
}
const children = (node: XmlNode, name: string) => node.children.filter(child => child.name === name);
const descendants = (node: XmlNode, name: string): XmlNode[] => node.children.flatMap(child => [ ...(child.name === name ? [child] : []), ...descendants(child, name) ]);
const nodeText = (node: XmlNode): string => node.name === 'lineBreak' ? '\n' : node.name === 'tab' ? '\t' : node.content.map(part => typeof part === 'string' ? (node.name === 't' ? part : '') : nodeText(part)).join('');

function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}
function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { eocd = i; break; }
  }
  if (eocd < 0 || view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) throw new Error('Invalid HWPX ZIP');
  if (view.getUint16(eocd + 8, true) !== view.getUint16(eocd + 10, true) || view.getUint32(eocd + 16, true) + view.getUint32(eocd + 12, true) > eocd) throw new Error('Invalid HWPX ZIP directory');
  const count = view.getUint16(eocd + 10, true);
  if (count > 1024) throw new Error('HWPX ZIP has too many entries');
  let cursor = view.getUint32(eocd + 16, true);
  const entries = new Map<string, Uint8Array>();
  const directoryEnd = view.getUint32(eocd + 16, true) + view.getUint32(eocd + 12, true);
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > directoryEnd || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('Invalid HWPX ZIP directory');
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true), packed = view.getUint32(cursor + 20, true), size = view.getUint32(cursor + 24, true);
    const nameLen = view.getUint16(cursor + 28, true), extraLen = view.getUint16(cursor + 30, true), commentLen = view.getUint16(cursor + 32, true);
    if (flags & 1 || size > 32 * 1024 * 1024 || packed > 32 * 1024 * 1024 || cursor + 46 + nameLen + extraLen + commentLen > bytes.length) throw new Error('Unsupported HWPX ZIP entry');
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));
    const offset = view.getUint32(cursor + 42, true);
    if (offset + 30 > bytes.length || view.getUint32(offset, true) !== 0x04034b50) throw new Error('Invalid HWPX ZIP entry');
    const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    if (start + packed > bytes.length) throw new Error('Truncated HWPX ZIP entry');
    const content = method === 0 ? bytes.slice(start, start + packed) : method === 8 ? inflateRawSync(bytes.subarray(start, start + packed), { maxOutputLength: 32 * 1024 * 1024 }) : null;
    if (!content || content.length !== size || crc32(content) !== crc || entries.has(name)) throw new Error('Invalid HWPX ZIP entry: ' + name);
    entries.set(name, content);
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  if (cursor !== directoryEnd) throw new Error('Invalid HWPX ZIP directory');
  return entries;
}
function writeZip(files: [string, string][]): Uint8Array {
  const parts: Uint8Array[] = [], directory: Uint8Array[] = [];
  let offset = 0;
  const uint16 = (view: DataView, at: number, n: number) => view.setUint16(at, n, true);
  const uint32 = (view: DataView, at: number, n: number) => view.setUint32(at, n >>> 0, true);
  for (const [name, value] of files) {
    const filename = encoder.encode(name), body = encoder.encode(value);
    const method = name === 'mimetype' ? 0 : 8;
    const packed = method === 0 ? body : deflateRawSync(body);
    const crc = crc32(body);
    const header = new Uint8Array(30 + filename.length), h = new DataView(header.buffer);
    uint32(h, 0, 0x04034b50); uint16(h, 4, 20); uint16(h, 6, 0x800); uint16(h, 8, method);
    uint32(h, 14, crc); uint32(h, 18, packed.length); uint32(h, 22, body.length); uint16(h, 26, filename.length);
    header.set(filename, 30);
    parts.push(header, packed);
    const central = new Uint8Array(46 + filename.length), c = new DataView(central.buffer);
    uint32(c, 0, 0x02014b50); uint16(c, 4, 20); uint16(c, 6, 20); uint16(c, 8, 0x800); uint16(c, 10, method);
    uint32(c, 16, crc); uint32(c, 20, packed.length); uint32(c, 24, body.length); uint16(c, 28, filename.length); uint32(c, 42, offset);
    central.set(filename, 46); directory.push(central);
    offset += header.length + packed.length;
  }
  const dirSize = directory.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  uint32(e, 0, 0x06054b50); uint16(e, 8, files.length); uint16(e, 10, files.length); uint32(e, 12, dirSize); uint32(e, 16, offset);
  const result = new Uint8Array(offset + dirSize + end.length);
  let pos = 0;
  for (const part of [...parts, ...directory, end]) { result.set(part, pos); pos += part.length; }
  return result;
}
function sections(zip: Map<string, Uint8Array>): { paths: string[]; paraProps: Map<string, XmlNode> } {
  const container = zip.get('META-INF/container.xml');
  if (!container) throw new Error('HWPX container.xml is missing');
  const path = descendants(parseXml(decoder.decode(container)), 'rootfile')[0]?.attrs['full-path'];
  const opf = path && zip.get(path);
  if (!opf || !path) throw new Error('HWPX package is missing');
  const pkg = parseXml(decoder.decode(opf));
  const manifest = new Map(descendants(pkg, 'item').map(item => [item.attrs.id, item.attrs.href]));
  const base = path.slice(0, path.lastIndexOf('/') + 1);
  const ordered = descendants(pkg, 'itemref').map(ref => {
    const href = manifest.get(ref.attrs.idref);
    if (!href) return undefined;
    const relative = [...base.split('/'), ...href.split('/')].reduce<string[]>((parts, part) => {
      if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part);
      return parts;
    }, []).join('/');
    return relative.endsWith('.xml') && zip.has(relative) && parseXml(decoder.decode(zip.get(relative)!)).name === 'sec' ? relative : undefined;
  }).filter((name): name is string => !!name);
  if (!ordered.length) throw new Error('HWPX section is missing');
  const headerHref = [...manifest.values()].find(href => href?.endsWith('header.xml'));
  const headerPath = headerHref && [...base.split('/'), ...headerHref.split('/')].reduce<string[]>((parts, part) => {
    if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part);
    return parts;
  }, []).join('/');
  const header = headerPath && zip.get(headerPath);
  const paraProps = new Map<string, XmlNode>();
  if (header) for (const prop of descendants(parseXml(decoder.decode(header)), 'paraPr')) {
    if (prop.attrs.id !== undefined) paraProps.set(prop.attrs.id, prop);
  }
  return { paths: ordered, paraProps };
}
function tableMarkdown(table: XmlNode): string {
  const cellText = (tc: XmlNode): string => {
    const paragraphs = descendants(tc, 'p');
    const text = paragraphs.length ? paragraphs.map(nodeText).join('\n') : nodeText(tc);
    return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>');
  };
  const rows = children(table, 'tr').map(tr => children(tr, 'tc').map(cellText));
  if (!rows.length) return '';
  return [rows[0], rows[0]!.map(() => '---'), ...rows.slice(1)].map(row => '| ' + row.join(' | ') + ' |').join('\n');
}
function paragraphMarkdown(p: XmlNode, paraProps: Map<string, XmlNode>): string[] {
  const blocks: string[] = [];
  let text = '';
  const prop = paraProps.get(p.attrs.paraPrIDRef ?? '');
  const heading = prop && children(prop, 'heading')[0];
  const level = heading?.attrs.type === 'OUTLINE' ? Number(heading.attrs.level) : NaN;
  const prefix = Number.isInteger(level) && level >= 0 && level <= 5 ? '#'.repeat(level + 1) + ' ' : '';
  const flush = () => {
    if (text.trim()) blocks.push(prefix + text.trim());
    text = '';
  };
  const visit = (node: XmlNode): void => {
    if (node.name === 'tbl') {
      flush();
      const md = tableMarkdown(node);
      if (md) blocks.push(md);
    } else if (node.name === 't' || node.name === 'lineBreak' || node.name === 'tab') {
      text += nodeText(node);
    } else {
      for (const part of node.content) if (typeof part !== 'string') visit(part);
    }
  };
  for (const run of children(p, 'run')) visit(run);
  flush();
  return blocks;
}
export function hwpxToMarkdown(bytes: Uint8Array, filename = 'document.hwpx'): string {
  const oleSignature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (/\.hwp$/i.test(filename) || (bytes.length >= oleSignature.length && oleSignature.every((byte, i) => bytes[i] === byte))) throw new Error(HWP_NOTICE);
  const zip = readZip(bytes);
  if (decoder.decode(zip.get('mimetype') ?? new Uint8Array()) !== 'application/hwp+zip') throw new Error('Not an HWPX document');
  const { paths, paraProps } = sections(zip);
  const blocks = paths.flatMap(path => children(parseXml(decoder.decode(zip.get(path)!)), 'p').flatMap(p => paragraphMarkdown(p, paraProps)));
  return blocks.length ? blocks.join('\n\n') + '\n' : '';
}
export function markdownToHwpx(markdown: string): Uint8Array {
  const paragraphs = markdown.replace(/\r\n/g, '\n').trim().split(/\n\s*\n/).filter(Boolean).flatMap(block => {
    const lines = block.split('\n');
    if (lines.some(line => /^\|.*\|$/.test(line))) throw new Error('Markdown tables are not supported by the minimal HWPX writer');
    const result: { style: number; text: string }[] = [];
    let body: string[] = [];
    const flush = () => {
      if (body.length) result.push({ style: 0, text: body.join('\n') });
      body = [];
    };
    for (const line of lines) {
      const heading = /^(#{1,6}) +(.+)$/.exec(line);
      if (heading) {
        flush();
        result.push({ style: heading[1]!.length, text: heading[2]! });
      } else body.push(line);
    }
    flush();
    return result;
  }).map(({ style, text }) => {
    const content = text.split('\n').map(line => line.split('\t').map(xmlEscape).join('<hp:tab/>')).join('<hp:lineBreak/>');
    return `<hp:p id="0" paraPrIDRef="${style}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${content}</hp:t></hp:run></hp:p>`;
  }).join('');
  const section = `<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hs="${HS}" xmlns:hp="${HP}"><hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:secPr id="0" textDirection="HORIZONTAL" spaceColumns="0" tabStop="8000"><hp:pagePr landscape="WIDELY" width="59528" height="84188" gutterType="LEFT_ONLY"/><hp:pageMargin left="5660" right="5660" top="5660" bottom="5660"/></hp:secPr></hp:run></hp:p>${paragraphs}</hs:sec>`;
  const langs = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];
  const fonts = langs.map(lang => `<hh:fontface lang="${lang}" fontCnt="1"><hh:font id="0" face="Malgun Gothic" type="TTF" isEmbedded="0"/></hh:fontface>`).join('');
  const fontRefs = langs.map(lang => `${lang.toLowerCase()}="0"`).join(' ');
  const charProps = `<hh:charPr id="0" height="1000" textColor="#000000" shadeColor="none" bold="0" italic="0"><hh:fontRef ${fontRefs}/></hh:charPr>`;
  const paraProps = Array.from({ length: 7 }, (_, i) => `<hh:paraPr id="${i}" tabPrIDRef="0"><hh:heading type="${i ? 'OUTLINE' : 'NONE'}" level="${i ? i - 1 : 0}"/><hh:align horizontal="LEFT" vertical="BASELINE"/></hh:paraPr>`).join('');
  const header = `<?xml version="1.0" encoding="UTF-8"?><hh:head xmlns:hh="${HH}" version="1.4" secCnt="1"><hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList><hh:fontfaces itemCnt="1">${fonts}</hh:fontfaces><hh:charProperties itemCnt="1">${charProps}</hh:charProperties><hh:paraProperties itemCnt="7">${paraProps}</hh:paraProperties><hh:styles itemCnt="1"><hh:style id="0" type="PARA" name="Normal" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042"/></hh:styles></hh:refList></hh:head>`;
  const content = `<?xml version="1.0" encoding="UTF-8"?><opf:package xmlns:opf="${OPF}" version="1.0"><opf:metadata/><opf:manifest><opf:item id="header" href="header.xml" media-type="application/xml"/><opf:item id="section0" href="section0.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="header"/><opf:itemref idref="section0"/></opf:spine></opf:package>`;
  return writeZip([
    ['mimetype', 'application/hwp+zip'],
    ['version.xml', '<?xml version="1.0" encoding="UTF-8"?><HWPVersion major="5" minor="0" micro="0" buildNumber="0"/>'],
    ['META-INF/container.xml', '<?xml version="1.0" encoding="UTF-8"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></rootfiles></container>'],
    ['Contents/content.hpf', content], ['Contents/header.xml', header], ['Contents/section0.xml', section],
  ]);
}
