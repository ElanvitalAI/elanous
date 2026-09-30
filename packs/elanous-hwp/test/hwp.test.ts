import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve(import.meta.dir, '../scripts/hwp.py');
const folder = mkdtempSync(join(tmpdir(), 'elanous-hwp-'));
const sample = join(folder, 'sample.md');
const output = join(folder, 'out.hwpx');
const markdown = '# 훈련 보고서\n\n**훈련 목표**\n\n- NCS 역량\n\n| 코드 | 능력단위 |\n| --- | --- |\n| 0101 | 훈련 운영 |\n| 0202 | 평가 관리 |\n\n| 항목 | 결과 |\n| --- | --- |\n| 성과 | 완료 |\n';
writeFileSync(sample, markdown);

function run(...args: string[]) {
  const result = spawnSync('python3', [script, ...args], { encoding: 'utf-8' });
  expect(result.stderr).toBe('');
  return { status: result.status, body: JSON.parse(result.stdout) as Record<string, unknown> };
}

describe('HWP/HWPX pack', () => {
  test('two-column table and heading round-trip through ZIP/OWPML; template font in header', () => {
    const written = run('write', sample, '--template', 'report', '-o', output);
    expect(written.status).toBe(0);
    expect(written.body.ok).toBe(true);
    const zip = readFileSync(output);
    expect(zip.subarray(0, 4).toString()).toBe('PK\x03\x04');
    const inspect = spawnSync('python3', ['-m', 'zipfile', '-l', output], { encoding: 'utf-8' });
    expect(inspect.stdout).toContain('Contents/section0.xml');
    // A separate HWPX consumer must resolve the OPF hrefs relative to content.hpf.
    const external = spawnSync('python3', [resolve(import.meta.dir, 'consumer.py'), output], { encoding: 'utf-8' });
    expect(external.stderr).toBe('');
    expect(external.status).toBe(0);
    const consumed = JSON.parse(external.stdout) as { paths: string[]; text: string; cells: string[]; tables: number };
    expect(consumed.tables).toBe(2);
    expect(consumed.paths).toEqual(['Contents/header.xml', 'Contents/section0.xml']);
    expect(consumed.text).toContain('훈련 보고서');
    expect(consumed.cells).toEqual(['코드', '능력단위', '0101', '훈련 운영', '0202', '평가 관리', '항목', '결과', '성과', '완료']);
    // Optional independent library: installed only in the caller's environment, never bundled.
    if (process.env.ELANOUS_HWP_VERIFY_PYTHON_HWPX === '1') {
      const thirdParty = spawnSync('python3', [resolve(import.meta.dir, 'verify-python-hwpx.py'), output], { encoding: 'utf-8' });
      expect(thirdParty.stderr).toBe('');
      expect(thirdParty.status).toBe(0);
      expect(JSON.parse(thirdParty.stdout)).toEqual({ consumer: 'python-hwpx', sections: 1, tables: 2, heading: '훈련 보고서', cells: [['코드', '능력단위', '0101', '훈련 운영', '0202', '평가 관리'], ['항목', '결과', '성과', '완료']] });
    }
    const read = run('read', output);
    expect(read.status).toBe(0);
    expect(read.body.markdown).toContain('# 훈련 보고서');
    expect(read.body.markdown).toContain('| 0101 | 훈련 운영 |');
    expect(read.body.markdown).toContain('| 0202 | 평가 관리 |');
    expect(read.body.markdown).toContain('| 성과 | 완료 |');
    expect(read.body.markdown).toContain('**훈련 목표**');
    expect(read.body.markdown).toContain('• NCS 역량');
    const readCopy = join(folder, 'sample-read.md');
    const rewritten = join(folder, 'sample-again.hwpx');
    writeFileSync(readCopy, read.body.markdown as string);
    expect(run('write', readCopy, '-o', rewritten).status).toBe(0);
    const again = spawnSync('python3', [resolve(import.meta.dir, 'consumer.py'), rewritten], { encoding: 'utf-8' });
    expect(again.status).toBe(0);
    const roundTrip = JSON.parse(again.stdout) as { cells: string[]; tables: number };
    expect(roundTrip.tables).toBe(consumed.tables);
    expect(roundTrip.cells).toEqual(consumed.cells);
    const header = spawnSync('python3', ['-c', 'import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).read("Contents/header.xml").decode())', output], { encoding: 'utf-8' });
    expect(header.stdout).toContain('맑은 고딕');
  });

  test('escaped pipes survive a second write without splitting the table or changing cells', () => {
    const source = join(folder, 'pipes.md');
    const first = join(folder, 'pipes.hwpx');
    const markdownCopy = join(folder, 'pipes-read.md');
    const second = join(folder, 'pipes-again.hwpx');
    writeFileSync(source, '# 기호 보고서\n\n| 항목 | 설명 |\n| --- | --- |\n| A\\|B | 한\\|둘 |\n| 역슬래시 | 경로\\\\\\|이름 |\n');
    expect(run('write', source, '-o', first).status).toBe(0);
    const read = run('read', first);
    expect(read.status).toBe(0);
    expect(read.body.markdown).toContain('A\\|B');
    writeFileSync(markdownCopy, read.body.markdown as string);
    const rewritten = run('write', markdownCopy, '-o', second);
    expect(rewritten).toEqual({ status: 0, body: { ok: true, output: second, template: 'report' } });
    const consumer = resolve(import.meta.dir, 'consumer.py');
    const inspect = (path: string) => {
      const result = spawnSync('python3', [consumer, path], { encoding: 'utf-8' });
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout) as { cells: string[]; tables: number };
    };
    const original = inspect(first);
    const roundTrip = inspect(second);
    expect(original.tables).toBe(1);
    expect(roundTrip.tables).toBe(original.tables);
    expect(roundTrip.cells).toEqual(original.cells);
    expect(roundTrip.cells).toEqual(['항목', '설명', 'A|B', '한|둘', '역슬래시', '경로\\|이름']);
  });

  test('fill markers in table cells, preserve source and page count', () => {
    const form = join(folder, 'form.md');
    const formHwpx = join(folder, 'form.hwpx');
    const filledHwpx = join(folder, 'filled.hwpx');
    const fields = join(folder, 'fields.json');
    writeFileSync(form, '# {{제목}}\n\n| 이름 | 소속 |\n| --- | --- |\n| {{이름}} | {{기관}} |\n');
    writeFileSync(fields, JSON.stringify({ 제목: '보고서', 이름: '홍길동', 기관: '기업' }));
    expect(run('write', form, '-o', formHwpx).status).toBe(0);
    const original = readFileSync(formHwpx);
    const result = run('fill', formHwpx, '--fields', fields, '-o', filledHwpx);
    expect(result.status).toBe(0);
    expect(result.body.filled).toBe(3);
    expect(result.body.pagesBefore).toBe(result.body.pagesAfter);
    expect(readFileSync(formHwpx)).toEqual(original);
    const read = run('read', filledHwpx);
    expect(read.body.markdown).toContain('| 홍길동 | 기업 |');
    expect(read.body.markdown).toContain('# 보고서');
    expect(run('fill', formHwpx, '--fields', fields, '-o', formHwpx).body.error).toContain('덮어쓸');
    expect(run('fill', formHwpx, '--fields', fields, '-o', filledHwpx).body.error).toContain('이미 있습니다');
  });

  test('absent pyhwp reports installation hint without traceback', () => {
    const file = join(folder, 'fake.hwp');
    writeFileSync(file, 'not an HWP');
    const proc = spawnSync('python3', [script, 'read', file], { encoding: 'utf-8', env: { ...process.env, PATH: '/usr/bin:/bin' } });
    expect(proc.stderr).toBe('');
    expect(proc.status).toBe(1);
    const body = JSON.parse(proc.stdout);
    expect(body.error).toContain('python -m pip install pyhwp');
  });

  // body order comes from content.hpf spine, not section file names.
  test('read follows the package spine even when section file names disagree with the order', () => {
    const src = join(folder, 'spine.hwpx');
    const py = [
      'import zipfile, sys',
      "c='<container xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\"><rootfiles><rootfile full-path=\"Contents/content.hpf\"/></rootfiles></container>'",
      "pkg='<opf:package xmlns:opf=\"http://www.idpf.org/2007/opf/\"><opf:manifest><opf:item id=\"a\" href=\"body/zz.xml\" media-type=\"application/xml\"/><opf:item id=\"b\" href=\"body/aa.xml\" media-type=\"application/xml\"/></opf:manifest><opf:spine><opf:itemref idref=\"a\"/><opf:itemref idref=\"b\"/></opf:spine></opf:package>'",
      "sec=lambda t: '<hs:sec xmlns:hs=\"http://www.hancom.co.kr/hwpml/2011/section\" xmlns:hp=\"http://www.hancom.co.kr/hwpml/2011/paragraph\"><hp:p><hp:run><hp:t>'+t+'</hp:t></hp:run></hp:p></hs:sec>'",
      'z=zipfile.ZipFile(sys.argv[1],"w")',
      'z.writestr("mimetype","application/hwp+zip"); z.writestr("META-INF/container.xml",c); z.writestr("Contents/content.hpf",pkg)',
      'z.writestr("Contents/body/zz.xml",sec("FIRST")); z.writestr("Contents/body/aa.xml",sec("SECOND")); z.close()',
    ].join('\n');
    expect(spawnSync('python3', ['-c', py, src], { encoding: 'utf-8' }).status).toBe(0);
    const read = run('read', src);
    expect(read.status).toBe(0);
    const text = JSON.stringify(read.body);
    expect(text.indexOf('FIRST')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('FIRST')).toBeLessThan(text.indexOf('SECOND'));
  });

  // only the line after the header is the delimiter; a data row of «---» survives.
  test('a data row whose cells are all --- is kept', () => {
    const md = join(folder, 'dash.md');
    const out = join(folder, 'dash.hwpx');
    writeFileSync(md, '| 항목 | 값 |\n| --- | --- |\n| --- | --- |\n| 끝 | 1 |\n');
    expect(run('write', md, '--template', 'report', '-o', out).status).toBe(0);
    const back = JSON.stringify(run('read', out).body);
    expect(back).toContain('끝');
    expect((back.match(/\| --- \| --- \|/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
