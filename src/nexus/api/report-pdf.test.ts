import { expect, test } from 'bun:test';
import { reportPdfSurface } from './report-pdf.js';

test('ReportPdf returns the public Markdown link and caps concurrent calls per session', async () => {
  const env = {
    ELANOUS_REPORT_PDF_GCS_BUCKET: 'demo-pdf-test',
    ELANOUS_REPORT_PDF_TEST_MEMBER_IDS: 'test-member',
    GOOGLE_APPLICATION_CREDENTIALS: '/unused-demo-key',
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const url = 'https://storage.googleapis.com/demo-pdf-test/members/demo/public/20261121/123456789abc.pdf';
    let uploads = 0;
    const surface = reportPdfSurface(
      undefined, { id: 'test-member', handle: 'demo' }, crypto.randomUUID(), 'PDF로 부탁해',
      async (_title, markdown, bucket, handle) => {
        expect(markdown).toContain('출처');
        expect(bucket).toBe('demo-pdf-test');
        expect(handle).toBe('demo');
        uploads++;
        return url;
      },
    )!;
    const ctx = { cwd: '/unused', signal: new AbortController().signal };
    const args = { title: '한국어 보고서', markdown: '# 요약\n- 결론\n# 출처\nhttps://example.com' };
    const fakeToken = 'ghp_' + 'TestKey'.repeat(5);
    const rejected = [
      { ...args, title: fakeToken },
      { ...args, markdown: '시험용 가짜 키 sk-' + 'test-FAKE-DO-NOT-USE-' + '0'.repeat(16) },
      { ...args, markdown: `# 출처\n- ${fakeToken.slice(0, 5)}\u200b${fakeToken.slice(5)}` },
      { ...args, markdown: '# 출처\n- /Users/demo/elanous-hq/secrets.json' },
      { ...args, markdown: '# 출처\n- file:///srv/private/report' },
    ];
    for (const report of rejected) {
      const blocked = await surface.dispatch('ReportPdf', report, ctx);
      expect(blocked).toEqual({ error: 'PDF was blocked because it contains a credential or internal path. Remove it before retrying.' });
    }
    const cancelled = await surface.dispatch('ReportPdf', args, {
      ...ctx, signal: AbortSignal.abort(),
    });
    expect(cancelled).toEqual({ error: 'PDF generation was cancelled.' });
    expect(uploads).toBe(0);
    const output = await Promise.all(Array.from({ length: 4 }, () => surface.dispatch('ReportPdf', args, ctx)));
    expect(uploads).toBe(3);
    expect(output.slice(0, 3)).toEqual(Array(3).fill({ url, markdownLink: `[PDF 다운로드](${url})` }));
    expect(output[3]).toEqual({ error: 'This demo session has reached its limit of three PDF attempts.' });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
