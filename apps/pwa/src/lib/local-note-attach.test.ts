import { describe, expect, test } from 'bun:test';
import {
  composeTurnText, formatLocalNote, ingestLocalNotes, LOCAL_NOTE_MAX_BYTES, maskSecrets,
} from './local-note-attach';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Uint8Array): number => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
async function deflateRaw(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
}
async function makeZip(name: string, content: Uint8Array, method: 0 | 8): Promise<Uint8Array> {
  const data = method === 8 ? await deflateRaw(content) : content;
  const nm = new TextEncoder().encode(name);
  const lh = new Uint8Array(30 + nm.length); const lv = new DataView(lh.buffer);
  lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(8, method, true);
  lv.setUint32(14, crc32(content), true); lv.setUint32(18, data.length, true); lv.setUint32(22, content.length, true); lv.setUint16(26, nm.length, true);
  lh.set(nm, 30);
  const ch = new Uint8Array(46 + nm.length); const cv = new DataView(ch.buffer);
  cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(10, method, true);
  cv.setUint32(16, crc32(content), true); cv.setUint32(20, data.length, true); cv.setUint32(24, content.length, true); cv.setUint16(28, nm.length, true);
  ch.set(nm, 46);
  const end = new Uint8Array(22); const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true); ev.setUint32(12, ch.length, true); ev.setUint32(16, lh.length + data.length, true);
  return Uint8Array.from([...lh, ...data, ...ch, ...end]);
}
const docXml = (paras: string[]): Uint8Array => new TextEncoder().encode(`<?xml version="1.0"?><w:document><w:body>${paras.map((p) => `<w:p>${p}</w:p>`).join('')}</w:body></w:document>`);

const file = (name: string, body: string | Uint8Array): File => new File([body as BlobPart], name);
const AWS = 'AKIAABCDEFGHIJKLMNOP';
const SK = 'sk-ant-api03-abcdefghijklmnop1234';

describe('maskSecrets', () => {
  test('masks keys, tokens, key=value, private keys, rrn; keeps prose', () => {
    const raw = `삼성전자 목표가 90000\n${AWS}\napi_key = "${SK}"\n비밀번호: hunter22\nBearer abcdefghijklmnopqrstuv\n-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n900101-1234567`;
    const out = maskSecrets(raw);
    for (const leak of [AWS, SK, 'hunter22', 'abcdefghijklmnopqrstuv', 'MIIB', '1234567']) expect(out).not.toContain(leak);
    expect(out).toContain('삼성전자 목표가 90000');
    expect(maskSecrets(out)).toBe(out);
  });
});

describe('ingestLocalNotes', () => {
  test('accepts txt/md, masks at read time', async () => {
    const r = await ingestLocalNotes([file('a.md', `메모 ${AWS}`), file('b.txt', 'ok')]);
    expect(r.refused).toEqual([]);
    expect(r.accepted.map((n) => n.meta.filename)).toEqual(['a.md', 'b.txt']);
    expect(r.accepted[0]!.text).not.toContain(AWS);
  });
  test('refuses oversize (no truncation), pdf, other types, binary, over-total', async () => {
    const big = file('big.txt', 'x'.repeat(LOCAL_NOTE_MAX_BYTES + 1));
    const r = await ingestLocalNotes([big, file('n.pdf', 'x'), file('n.doc', 'x'), file('n.png', 'x'), file('bin.txt', new Uint8Array([65, 0, 66]))]);
    expect(r.accepted).toEqual([]);
    expect(r.refused.map((x) => x.filename)).toEqual(['big.txt', 'n.pdf', 'n.doc', 'n.png', 'bin.txt']);
    expect(r.refused[0]!.reason).toContain('100KB');
    expect(r.refused[1]!.reason).toContain('pdf');
    const total = await ingestLocalNotes([file('c.txt', 'x'.repeat(2000))], 299 * 1024);
    expect(total.refused[0]!.reason).toContain('300KB');
  });
});

describe('docx ingest', () => {
  const body = [`<w:r><w:t>목표가 &amp; 근거</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t xml:space="preserve"> 90000</w:t></w:r>`, `<w:r><w:t>api_key=${SK}</w:t></w:r>`];
  for (const method of [0, 8] as const) {
    test(`extracts text, masks secrets (method ${method})`, async () => {
      const zip = await makeZip('word/document.xml', docXml(body), method);
      const r = await ingestLocalNotes([file('lec.docx', zip)]);
      expect(r.refused).toEqual([]);
      expect(r.accepted[0]!.text).toContain('목표가 & 근거\t 90000\n');
      expect(r.accepted[0]!.text).not.toContain(SK);
    });
  }
  test('corrupt zip, missing document.xml, oversize text, pdf refused', async () => {
    const good = await makeZip('word/document.xml', docXml(body), 8);
    const other = await makeZip('word/other.xml', docXml(body), 0);
    const big = await makeZip('word/document.xml', docXml([`<w:r><w:t>${'x'.repeat(LOCAL_NOTE_MAX_BYTES + 1)}</w:t></w:r>`]), 8);
    const r = await ingestLocalNotes([
      file('trunc.docx', good.subarray(0, good.length - 30)), file('junk.docx', 'not a zip at all'), file('other.docx', other), file('big.docx', big), file('x.pdf', 'x'),
    ]);
    expect(r.accepted).toEqual([]);
    expect(r.refused.map((x) => x.filename)).toEqual(['trunc.docx', 'junk.docx', 'other.docx', 'big.docx', 'x.pdf']);
    expect(r.refused[0]!.reason).toContain('docx');
    expect(r.refused[3]!.reason).toContain('100KB');
    expect(r.refused[4]!.reason).toContain('pdf는 지원하지 않습니다');
  });
});

describe('real composition path', () => {
  test('composeTurnText of an ingested note never carries the raw secret; no-attachment turn is unchanged', async () => {
    const { accepted } = await ingestLocalNotes([file('lec.md', `핵심: 분할매수\napi_key=${SK}`)]);
    const notes = accepted.map((n) => formatLocalNote(n.meta.filename, n.text));
    const turn = composeTurnText({ notes, attachLines: [], text: '요약해줘' });
    expect(turn.startsWith('[강의 노트: lec.md]\n핵심: 분할매수')).toBe(true);
    expect(turn.endsWith('\n\n요약해줘')).toBe(true);
    expect(turn).not.toContain(SK);
    // even if an unmasked body reached the formatter, it is masked again
    expect(formatLocalNote('x.txt', `token=${SK}`)).not.toContain(SK);
    expect(composeTurnText({ notes: [], attachLines: [], text: 'hi' })).toBe('hi');
  });
});
