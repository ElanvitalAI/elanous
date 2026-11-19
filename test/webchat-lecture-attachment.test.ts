import { describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { saveAttachmentBlob } from '../src/boot/attachment-store';
import { handleAttachmentGet } from '../src/nexus/api/meta-api';
import { fetchLectureNote, isLectureNoteAttachment } from '../apps/pwa/src/lib/attachment-content';

describe('webchat lecture note extraction', () => {
  test('requires authentication and redacts before truncating Korean lecture notes', async () => {
    const input = `삼성전자 | 목표가 80,000원\napi_key=abcdefghijk12345\n${'주가 전망\n'.repeat(1800)}`;
    const saved = await saveAttachmentBlob({ blob: new Blob([input]), filename: 'lecture.md' });
    if (!saved.ok) throw new Error(saved.reason);
    const { id, path } = saved.entry;
    const url = `http://localhost/v1/attachments/${id}?extract=text`;
    try {
      expect((await handleAttachmentGet(new Request(url), id, { bearerToken: 'test-token' })).status).toBe(401);
      const response = await handleAttachmentGet(new Request(url, { headers: { authorization: 'Bearer test-token' } }), id, { bearerToken: 'test-token' });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.json();
      expect(body.text).toContain('삼성전자 | 목표가 80,000원');
      expect(body.text).not.toContain('abcdefghijk12345');
      expect(body.text).toContain('api_key=***');
      expect(body.truncated).toBe(true);
    } finally { unlinkSync(path); }
  });

  test('extracts a real DOCX lecture note and masks the key', async () => {
    const fixture = Bun.file('test/fixtures/webchat/lecture-note.docx');
    const saved = await saveAttachmentBlob({ blob: fixture, filename: 'lecture.docx' });
    if (!saved.ok) throw new Error(saved.reason);
    const { id, path } = saved.entry;
    try {
      const response = await handleAttachmentGet(new Request(`http://localhost/v1/attachments/${id}?extract=text`), id, { noAuth: true });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.text).toContain('삼성전자 | 목표가 80,000원');
      expect(body.text).toContain('API_KEY=***');
      expect(body.text).not.toContain('abcdefghijk12345');
      expect(body.truncated).toBe(false);
    } finally { unlinkSync(path); }
  });

  test('sends bearer to daemon attachment id and never uses an external download URL', async () => {
    const oldFetch = globalThis.fetch;
    const seen: { url?: string; authorization?: string } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.authorization = (init?.headers as Record<string, string>).authorization;
      return Response.json({ text: '삼성전자 | 80,000원', truncated: false });
    }) as typeof fetch;
    const note = { id: 'att-abc-def', filename: 'lecture.PDF', mediaType: 'application/pdf', size: new Blob(['강의']).size, downloadUrl: 'https://other.invalid' };
    try {
      expect(isLectureNoteAttachment(note)).toBe(true);
      expect((await fetchLectureNote(note, { baseUrl: 'https://daemon.example/', token: 'test-token' })).text).toBe('삼성전자 | 80,000원');
      expect(seen.url).toBe('https://daemon.example/v1/attachments/att-abc-def?extract=text');
      expect(seen.authorization).toBe('Bearer test-token');
    } finally { globalThis.fetch = oldFetch; }
  });
});
