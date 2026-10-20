// ── Extractor tests ──
//
// Covers the logic we can drive without binary fixtures:
//   - readText (temp .txt)
//   - truncation at MAX_EXTRACT_BYTES
//   - extractXlsx (workbook built in memory, written via XLSX.writeFile)
//
// DOCX extraction is verified manually. A minimal PDF fixture is generated
// below to exercise the lazy parser on an actual PDF, without extra deps.

import { describe, test, expect, afterAll } from 'bun:test';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as XLSX from 'xlsx';

import sharp from 'sharp';

import {
  readText,
  extractPdf,
  extractXlsx,
  loadAttachment,
  loadAllAttachments,
  MAX_EXTRACT_BYTES,
  XLSX_MAX_ROWS_PER_SHEET,
} from '../src/extractors';
import { clearImageCache } from '../src/image/utils';
import { createContextRegistry, addAttachment } from '../src/context';

const tmpDir = mkdtempSync(join(tmpdir(), 'elanous-ext-'));
const created: string[] = [];

function tmpPath(name: string): string {
  const p = join(tmpDir, name);
  created.push(p);
  return p;
}

afterAll(() => {
  for (const p of created) {
    try { unlinkSync(p); } catch { /* ignore */ }
  }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ═══════════════════════════════════════════
// 1. readText
// ═══════════════════════════════════════════

describe('readText', () => {
  test('reads a short UTF-8 file verbatim', async () => {
    const p = tmpPath('hello.txt');
    writeFileSync(p, '안녕하세요 world\n');
    const res = await readText(p);

    expect(res.text).toBe('안녕하세요 world\n');
    expect(res.truncated).toBe(false);
    expect(res.extractedBytes).toBe(Buffer.byteLength('안녕하세요 world\n', 'utf-8'));
  });

  test('truncates when content exceeds MAX_EXTRACT_BYTES', async () => {
    const p = tmpPath('big.txt');
    // 'a' = 1 byte → write MAX + 500 bytes
    const huge = 'a'.repeat(MAX_EXTRACT_BYTES + 500);
    writeFileSync(p, huge);

    const res = await readText(p);
    expect(res.truncated).toBe(true);
    expect(res.text.length).toBeGreaterThan(MAX_EXTRACT_BYTES);   // trailer adds a few bytes
    expect(res.text).toContain('truncated');
    expect(res.text).toContain(`original ${MAX_EXTRACT_BYTES + 500} bytes`);
  });

  test('boundary: exact MAX_EXTRACT_BYTES → not truncated', async () => {
    const p = tmpPath('exact.txt');
    writeFileSync(p, 'a'.repeat(MAX_EXTRACT_BYTES));
    const res = await readText(p);

    expect(res.truncated).toBe(false);
    expect(res.extractedBytes).toBe(MAX_EXTRACT_BYTES);
  });

  test('multi-byte UTF-8 truncation does not emit invalid codepoints', async () => {
    const p = tmpPath('mbcs.txt');
    // Korean syllables are 3 bytes each. 10,000 syllables = 30,000 bytes.
    writeFileSync(p, '한'.repeat(10_000));

    const res = await readText(p);
    expect(res.truncated).toBe(true);
    // Ensure decoded head does not end with a replacement char from mid-codepoint cut.
    // (Buffer→string decoding drops incomplete trailing bytes, so no U+FFFD expected.)
    expect(res.text.includes('\uFFFD')).toBe(false);
  });
});

// ═══════════════════════════════════════════
// 2. extractPdf — parser imports only on PDF requests
// ═══════════════════════════════════════════

test('extractPdf loads the renderer on demand and reads a real PDF', async () => {
  // A small PDF with a single Helvetica text object, no PDF writer dependency.
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    (() => {
      const stream = 'BT /F1 18 Tf 25 150 Td (Lazy PDF smoke) Tj ET\n';
      return `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`;
    })(),
  ];
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.concat(chunks).length);
    chunks.push(Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`));
  }
  const xref = Buffer.concat(chunks).length;
  chunks.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`));
  for (const offset of offsets.slice(1)) chunks.push(Buffer.from(`${String(offset).padStart(10, '0')} 00000 n \n`));
  chunks.push(Buffer.from(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  const p = tmpPath('lazy.pdf');
  writeFileSync(p, Buffer.concat(chunks));
  const result = await extractPdf(p);
  expect(result.text).toContain('Lazy PDF smoke');
  expect(result.meta?.pages).toBe(1);
});

// ═══════════════════════════════════════════
// 3. extractXlsx
// ═══════════════════════════════════════════

describe('extractXlsx', () => {
  test('serialises every sheet with header and CSV body', async () => {
    const p = tmpPath('two-sheets.xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['name', 'qty'],
      ['apple', 3],
      ['pear',  5],
    ]), 'Inventory');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['id'], [1], [2], [3],
    ]), 'Ids');
    XLSX.writeFile(wb, p);

    const res = await extractXlsx(p);
    expect(res.meta?.sheets).toBe(2);
    expect(res.truncated).toBe(false);
    expect(res.text).toContain('# Sheet: Inventory');
    expect(res.text).toContain('# Sheet: Ids');
    expect(res.text).toContain('name,qty');
    expect(res.text).toContain('apple,3');
    expect(res.text).toContain('pear,5');
  });

  test('caps rows at XLSX_MAX_ROWS_PER_SHEET and notes truncation', async () => {
    const p = tmpPath('wide.xlsx');
    const rows: (string | number)[][] = [['idx']];
    for (let i = 1; i <= XLSX_MAX_ROWS_PER_SHEET + 50; i++) rows.push([i]);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Big');
    XLSX.writeFile(wb, p);

    const res = await extractXlsx(p);
    const expectedCsvTotal = rows.length;
    expect(res.text).toContain(`first ${XLSX_MAX_ROWS_PER_SHEET} of ${expectedCsvTotal} rows`);
    // Last included idx should be XLSX_MAX_ROWS_PER_SHEET - 1 (header + 99 data rows = 100 total).
    expect(res.text).toContain(`\n${XLSX_MAX_ROWS_PER_SHEET - 1}`);
    // Row beyond the cap must not appear.
    expect(res.text).not.toContain(`\n${XLSX_MAX_ROWS_PER_SHEET + 1}`);
  });

  test('skips empty sheets without crashing', async () => {
    const p = tmpPath('mixed.xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['ok']]), 'Data');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), 'Empty');
    XLSX.writeFile(wb, p);

    const res = await extractXlsx(p);
    expect(res.text).toContain('# Sheet: Data');
    expect(res.text).not.toContain('# Sheet: Empty');
  });
});

// ═══════════════════════════════════════════
// 3. loadAttachment / loadAllAttachments
// ═══════════════════════════════════════════

function registerText(
  reg: ReturnType<typeof createContextRegistry>,
  path: string,
  kind: 'text' | 'md' = 'text',
) {
  return addAttachment(reg, {
    kind,
    sourcePath: path,
    filename: path.split('/').pop()!,
    sizeBytes: 0,
    mtime: 1,
  });
}

describe('loadAttachment', () => {
  test('populates text and marks loaded=true for txt', async () => {
    const p = tmpPath('load.txt');
    writeFileSync(p, 'payload');
    const reg = createContextRegistry();
    const att = registerText(reg, p);

    expect(att.loaded).toBe(false);
    await loadAttachment(att);

    expect(att.loaded).toBe(true);
    expect(att.text).toBe('payload');
    expect(att.extractedBytes).toBe(7);
  });

  test('is idempotent — second call short-circuits', async () => {
    const p = tmpPath('idem.md');
    writeFileSync(p, 'one');
    const reg = createContextRegistry();
    const att = registerText(reg, p, 'md');

    await loadAttachment(att);
    writeFileSync(p, 'changed on disk');
    await loadAttachment(att);

    expect(att.text).toBe('one');   // second call returned early, didn't re-read
  });

  test('loads image attachments via the M2 image pipeline', async () => {
    clearImageCache();
    const p = tmpPath('pipe.png');
    const buf = await sharp({
      create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 100, b: 50 } },
    }).png().toBuffer();
    writeFileSync(p, buf);

    const reg = createContextRegistry();
    const att = addAttachment(reg, {
      kind: 'image',
      sourcePath: p,
      filename: 'pipe.png',
      sizeBytes: buf.length,
      mtime: 1,
    });

    await loadAttachment(att);
    expect(att.loaded).toBe(true);
    expect(att.mediaType).toBe('image/png');
    expect(att.base64).toBeDefined();
    expect(att.base64!.length).toBeGreaterThan(0);
    expect(att.dimensions).toEqual({ w: 40, h: 30 });
  });

  test('image load is idempotent — second call short-circuits', async () => {
    clearImageCache();
    const p = tmpPath('idem.png');
    const buf = await sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).png().toBuffer();
    writeFileSync(p, buf);

    const reg = createContextRegistry();
    const att = addAttachment(reg, {
      kind: 'image',
      sourcePath: p,
      filename: 'idem.png',
      sizeBytes: buf.length,
      mtime: 1,
    });

    await loadAttachment(att);
    const firstB64 = att.base64;

    // Rewrite to a different image — second call should NOT re-encode (att.loaded already true).
    const replacement = await sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).png().toBuffer();
    writeFileSync(p, replacement);
    await loadAttachment(att);

    expect(att.base64).toBe(firstB64);
  });

  test('image load failure degrades to a text placeholder instead of silently dropping', async () => {
    clearImageCache();
    const p = tmpPath('broken.png');
    // Valid PNG magic but garbage IHDR — sharp will reject.
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]));

    const reg = createContextRegistry();
    const att = addAttachment(reg, {
      kind: 'image',
      sourcePath: p,
      filename: 'broken.png',
      sizeBytes: 9,
      mtime: 1,
    });

    // Silence the expected warning from loadAttachment's catch arm.
    const origWarn = console.warn;
    console.warn = () => { /* swallow */ };
    try {
      await loadAttachment(att);
    } finally {
      console.warn = origWarn;
    }

    // Graceful degrade: attachment marked loaded with a text placeholder so
    // buildMessagesWithContext routes it through the text-section path; no
    // base64, so the multimodal image block is skipped cleanly.
    expect(att.loaded).toBe(true);
    expect(att.base64).toBeUndefined();
    expect(att.text).toBeDefined();
    expect(att.text!).toContain(`[Image #${att.id}: unable to load`);
    expect(att.text!).toContain(p);
  });
});

describe('loadAllAttachments', () => {
  test('loads every text-kind attachment concurrently', async () => {
    const a = tmpPath('multi-a.txt'); writeFileSync(a, 'AAA');
    const b = tmpPath('multi-b.md');  writeFileSync(b, 'BBB');

    const reg = createContextRegistry();
    const ra = registerText(reg, a, 'text');
    const rb = registerText(reg, b, 'md');

    await loadAllAttachments(reg);

    expect(ra.loaded).toBe(true);
    expect(rb.loaded).toBe(true);
    expect(ra.text).toBe('AAA');
    expect(rb.text).toBe('BBB');
  });

  test('skips already-loaded entries', async () => {
    const p = tmpPath('skipme.txt'); writeFileSync(p, 'v1');
    const reg = createContextRegistry();
    const att = registerText(reg, p);

    await loadAllAttachments(reg);
    writeFileSync(p, 'v2');
    await loadAllAttachments(reg);

    expect(att.text).toBe('v1');
  });
});
