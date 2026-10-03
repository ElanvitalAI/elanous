import { expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { hwpxToMarkdown, markdownToHwpx } from './converter.js';
import { main } from './cli.js';
import plugin from './plugin.js';
import { loadPluginManifestFromDir } from '../../src/plugins/core/manifest.js';

const fixture = join(import.meta.dir, 'fixtures/fixed.hwpx');

function zipEntry(bytes: Uint8Array, wanted: string): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i + 30 < bytes.length; i++) {
    if (view.getUint32(i, true) !== 0x04034b50) continue;
    const method = view.getUint16(i + 8, true), length = view.getUint32(i + 18, true);
    const nameLength = view.getUint16(i + 26, true), extraLength = view.getUint16(i + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(i + 30, i + 30 + nameLength));
    const start = i + 30 + nameLength + extraLength;
    if (name === wanted) {
      const data = bytes.subarray(start, start + length);
      return method === 8 ? inflateRawSync(data).toString() : new TextDecoder().decode(data);
    }
    i = start + length - 1;
  }
  throw new Error(`Missing ZIP entry: ${wanted}`);
}

test('fixed deflated HWPX sample reads actual outline property, ordinary nonzero paragraph, ordered mixed run and GFM tables', () => {
  const sample = readFileSync(fixture);
  const header = zipEntry(sample, 'Contents/header.xml');
  const section = zipEntry(sample, 'Contents/section0.xml');
  expect(header).toContain('<hh:paraPr id="2"><hh:heading type="NONE" level="0"/>');
  expect(header).toContain('<hh:paraPr id="4"><hh:heading type="OUTLINE" level="0"/>');
  expect(section).toContain('<hp:t>표 앞</hp:t><hp:tbl>');
  expect(section).toContain('</hp:tbl><hp:t>표 뒤</hp:t>');
  expect(hwpxToMarkdown(sample)).toBe('# 고정 제목\n\n첫 문단 & 값 이어짐\n\n| 항목 | 내용 |\n| --- | --- |\n| 번호 | A\\|B |\n\n표 앞\n\n| 칸 |\n| --- |\n\n표 뒤\n');
});

test('fixed HWPX sample preserves interleaved text, line break and tab controls', () => {
  const sample = readFileSync(join(import.meta.dir, 'fixtures/fixed-controls.hwpx'));
  expect(zipEntry(sample, 'Contents/section0.xml')).toContain('<hp:t>앞<hp:lineBreak/>중간<hp:tab/>뒤</hp:t>');
  expect(hwpxToMarkdown(sample)).toBe(hwpxToMarkdown(readFileSync(fixture)) + '\n앞\n중간\t뒤\n');
});

test('multiline paragraphs and headings round-trip without extra paragraph breaks', () => {
  const markdown = '# 제목\n\n이어지는 제목\n\n첫 줄\n둘째 줄\n\n## 다음 절\n\n탭\t사이\n';
  const hwpx = markdownToHwpx(markdown);
  expect(zipEntry(hwpx, 'Contents/section0.xml')).toContain('<hp:t>첫 줄<hp:lineBreak/>둘째 줄</hp:t>');
  expect(hwpxToMarkdown(hwpx)).toBe(markdown);
  expect(hwpxToMarkdown(markdownToHwpx('첫 줄\n둘째 줄\n'))).toBe('첫 줄\n둘째 줄\n');
});

test('adjacent ATX headings terminate at the end of their line even without blank separators', () => {
  const hwpx = markdownToHwpx('# 제목\n본문\n## 다음 제목\n');
  const section = zipEntry(hwpx, 'Contents/section0.xml');
  const paragraphs = [...section.matchAll(/<hp:p id="0" paraPrIDRef="(\d+)"[^>]*><hp:run charPrIDRef="0"><hp:t>([^<]+)<\/hp:t><\/hp:run><\/hp:p>/g)];
  expect([...section.matchAll(/<hp:p\b/g)]).toHaveLength(4); // section properties paragraph + three content paragraphs
  expect(paragraphs.map(match => [match[1], match[2]])).toEqual([['1', '제목'], ['0', '본문'], ['2', '다음 제목']]);
  expect(hwpxToMarkdown(hwpx)).toBe('# 제목\n\n본문\n\n## 다음 제목\n');
});

test('fixed HWPX table sample retains cell line breaks and multiple cell paragraphs within GFM rows', () => {
  const sample = readFileSync(join(import.meta.dir, 'fixtures/fixed-table-controls.hwpx'));
  const section = zipEntry(sample, 'Contents/section0.xml');
  expect(section).toContain('<hp:t>A|B<hp:lineBreak/>C</hp:t>');
  expect(section).toContain('<hp:t>번호</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>둘째</hp:t>');
  expect(hwpxToMarkdown(sample)).toBe('# 고정 제목\n\n첫 문단 & 값 이어짐\n\n| 항목 | 내용 |\n| --- | --- |\n| 번호<br>둘째 | A\\|B<br>C |\n\n표 앞\n\n| 칸 |\n| --- |\n\n표 뒤\n');
});

test('Markdown headings and paragraphs write a real HWPX ZIP and round-trip unchanged', () => {
  const markdown = '# 보고서\n\n첫 문단 & <내용>\n\n## 다음 절\n\n두 번째 문단\n';
  const hwpx = markdownToHwpx(markdown);
  expect(new TextDecoder().decode(hwpx.subarray(0, 2))).toBe('PK');
  const header = zipEntry(hwpx, 'Contents/header.xml');
  expect(header).toContain('<hh:paraPr id="0" tabPrIDRef="0"><hh:heading type="NONE" level="0"/>');
  expect(header).toContain('<hh:paraPr id="1" tabPrIDRef="0"><hh:heading type="OUTLINE" level="0"/>');
  expect(header).toContain('<hh:paraPr id="2" tabPrIDRef="0"><hh:heading type="OUTLINE" level="1"/>');
  expect(hwpxToMarkdown(hwpx)).toBe(markdown);
  expect(() => markdownToHwpx('| 이름 | 값 |\n| --- | --- |\n')).toThrow('Markdown tables are not supported');
});

test('host plugin tools expose both conversions', async () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, 'plugin.json'), 'utf8'));
  expect(manifest.extensions['ai.elanous'].trust).toBe('official');
  expect(manifest.main).toBe('./plugin.ts');
  const loaded = loadPluginManifestFromDir(import.meta.dir, { id: 'elanous-hwp' });
  expect(loaded.inferred).toBe(false);
  expect(loaded.manifest.main).toBe('./plugin.ts');
  const dir = mkdtempSync(join(tmpdir(), 'elanous-hwpx-tools-'));
  try {
    expect(plugin.llmTools?.map(tool => tool.name)).toEqual(['HwpxToMarkdown', 'MarkdownToHwpx']);
    const markdown = await plugin.llmTools![0]!.handler({ path: fixture }, {} as never);
    expect(markdown).toEqual({ markdown: hwpxToMarkdown(readFileSync(fixture)) });
    const input = join(dir, 'input.md'), output = join(dir, 'output.hwpx');
    writeFileSync(input, '# 제목\n\n본문\n');
    expect(await plugin.llmTools![1]!.handler({ path: input, output }, {} as never)).toEqual({ output });
    expect(hwpxToMarkdown(readFileSync(output))).toBe('# 제목\n\n본문\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI converts files without overwriting output and rejects old HWP binary with guidance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-hwpx-'));
  try {
    const md = join(dir, 'read.md');
    main(['to-md', fixture, md]);
    expect(readFileSync(md, 'utf8')).toContain('| 번호 | A\\|B |');
    const processMd = join(dir, 'process.md');
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, 'cli.ts'), 'to-md', fixture, processMd]);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(processMd, 'utf8')).toBe(readFileSync(md, 'utf8'));
    expect(() => main(['to-md', fixture, md])).toThrow();
    const input = join(dir, 'input.md'), output = join(dir, 'out.hwpx');
    writeFileSync(input, '# 제목\n\n본문\n');
    main(['from-md', input, output]);
    expect(existsSync(output)).toBe(true);
    expect(hwpxToMarkdown(readFileSync(output))).toBe('# 제목\n\n본문\n');
    expect(() => main(['to-md', join(dir, 'old.hwp'), md])).toThrow('HWP(옛 바이너리)는 지원 안 함 · hwpx 로 저장해 달라');
    expect(() => hwpxToMarkdown(new Uint8Array(), 'old.hwp')).toThrow('HWP(옛 바이너리)는 지원 안 함 · hwpx 로 저장해 달라');
    expect(() => hwpxToMarkdown(new Uint8Array())).toThrow('Invalid HWPX ZIP');
    expect(() => hwpxToMarkdown(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'old.hwpx')).toThrow('HWP(옛 바이너리)는 지원 안 함 · hwpx 로 저장해 달라');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// TC review must-fix (#23276): the section root must be OWPML `hs:sec` in the section namespace. This reads the written ZIP
// with its own local-header walk + node:zlib (not the plugin's readZip / namespace-stripping parser) so the check is independent.
test('written HWPX section0.xml root is hs:sec bound to the section namespace', () => {
  const zip = Buffer.from(markdownToHwpx('# Title\n\nbody'));
  let section: string | undefined;
  for (let at = 0; at + 30 <= zip.length && zip.readUInt32LE(at) === 0x04034b50;) {
    const method = zip.readUInt16LE(at + 8), size = zip.readUInt32LE(at + 18), nameLen = zip.readUInt16LE(at + 26), extra = zip.readUInt16LE(at + 28);
    const name = zip.subarray(at + 30, at + 30 + nameLen).toString('utf8');
    const data = zip.subarray(at + 30 + nameLen + extra, at + 30 + nameLen + extra + size);
    if (name === 'Contents/section0.xml') section = (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    at += 30 + nameLen + extra + size;
  }
  expect(section).toBeDefined();
  const root = /<([A-Za-z]+):sec\b([^>]*)>/.exec(section!);
  expect(root?.[1]).toBe('hs');
  expect(root?.[2]).toContain('xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"');
  expect(root?.[2]).toContain('xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"');
  expect(section!.trimEnd().endsWith('</hs:sec>')).toBe(true);
  expect(section).not.toMatch(/<hp:sec[\s>]/);
});
