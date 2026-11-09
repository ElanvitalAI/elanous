// P-3 §6.9 (2026-05-07) — composer attachment → ContentBlock[]
// converter unit tests.

import { describe, expect, test } from 'bun:test';

import type { AttachmentMeta } from './upload-attachment';
import { withFakeFetchDevice } from '../test-devices/fake-fetch';
import {
  buildPromptUserContentFromAttachments,
  isImageAttachment,
  isProviderUserMessageVisionCapable,
} from './attachment-content';

const baseUrl = 'https://daemon.local';
function withMockFetch<T>(body: ArrayBuffer | string, ok: boolean, run: () => Promise<T>): Promise<T> {
  const ab = typeof body === 'string'
    ? new TextEncoder().encode(body).buffer
    : body;
  return withFakeFetchDevice([
    { url: '/v1/attachments/img-1', response: () => new Response(ab, { status: ok ? 200 : 500 }) },
    { url: '/v1/attachments/img-2', response: () => new Response(ab, { status: ok ? 200 : 500 }) },
  ], run);
}

const imageAttachment: AttachmentMeta = {
  id: 'img-1',
  filename: 'photo.png',
  mediaType: 'image/png',
  size: 1024,
  downloadUrl: '/v1/attachments/img-1',
  path: '/Users/me/.elanous/attachments/img-1-photo.png',
};

const docAttachment: AttachmentMeta = {
  id: 'doc-1',
  filename: 'spec.pdf',
  mediaType: 'application/pdf',
  size: 8192,
  downloadUrl: '/v1/attachments/doc-1',
  path: '/Users/me/.elanous/attachments/doc-1-spec.pdf',
};

describe('isImageAttachment', () => {
  test('image/* mediaType → true', () => {
    expect(isImageAttachment(imageAttachment)).toBe(true);
    expect(isImageAttachment({ ...imageAttachment, mediaType: 'image/jpeg' })).toBe(true);
    expect(isImageAttachment({ ...imageAttachment, mediaType: 'IMAGE/PNG' })).toBe(true);
  });

  test('non-image mediaType → false', () => {
    expect(isImageAttachment(docAttachment)).toBe(false);
    expect(isImageAttachment({ ...docAttachment, mediaType: 'text/plain' })).toBe(false);
  });
});

describe('isProviderUserMessageVisionCapable', () => {
  test('known vision providers → true', () => {
    expect(isProviderUserMessageVisionCapable('anthropic')).toBe(true);
    expect(isProviderUserMessageVisionCapable('openai')).toBe(true);
    expect(isProviderUserMessageVisionCapable('codex')).toBe(true);
    expect(isProviderUserMessageVisionCapable('openai-codex')).toBe(true);
    expect(isProviderUserMessageVisionCapable('gemini')).toBe(true);
    expect(isProviderUserMessageVisionCapable('grok')).toBe(true);
  });

  test('local-llm prefix → true (default-permissive · daemon strips when text-only)', () => {
    expect(isProviderUserMessageVisionCapable('local-llm:host:qwen3-vl')).toBe(true);
    expect(isProviderUserMessageVisionCapable('local-llm:host:qwen-coder')).toBe(true);
  });

  test('auto / undefined → true (default-permissive)', () => {
    expect(isProviderUserMessageVisionCapable('auto')).toBe(true);
    expect(isProviderUserMessageVisionCapable(undefined)).toBe(true);
  });

  test('unknown provider → false (conservative — composer toasts)', () => {
    expect(isProviderUserMessageVisionCapable('unknown-brand-xyz')).toBe(false);
  });
});

describe('buildPromptUserContentFromAttachments — Q1=B order + image base64', () => {
  test('returns null when no attachments', async () => {
    const out = await buildPromptUserContentFromAttachments(
      'hello',
      [],
      { baseUrl },
    );
    expect(out).toBeNull();
  });

  test('text first, image second (Q1=B) — bytes base64-encoded from fetch', async () => {
    const blocks = await withMockFetch('TINY', true, () =>
      buildPromptUserContentFromAttachments(
        'describe',
        [imageAttachment],
        { baseUrl },
      ),
    );
    expect(blocks).not.toBeNull();
    expect(blocks!.length).toBe(2);
    expect(blocks![0]).toEqual({ type: 'text', text: 'describe' });
    expect(blocks![1]!.type).toBe('image');
    expect((blocks![1] as unknown as { mimeType: string }).mimeType).toBe('image/png');
    // 'TINY' → base64 'VElOWQ=='
    expect((blocks![1] as unknown as { data: string }).data).toBe('VElOWQ==');
  });

  test('image-only (no text) — text block omitted, image alone', async () => {
    const blocks = await withMockFetch('A', true, () =>
      buildPromptUserContentFromAttachments(
        '',
        [imageAttachment],
        { baseUrl },
      ),
    );
    expect(blocks!.length).toBe(1);
    expect(blocks![0]!.type).toBe('image');
  });

  test('multiple images preserve order', async () => {
    const second: AttachmentMeta = { ...imageAttachment, id: 'img-2', filename: 'photo2.png' };
    const blocks = await withMockFetch('A', true, () =>
      buildPromptUserContentFromAttachments(
        'compare',
        [imageAttachment, second],
        { baseUrl },
      ),
    );
    expect(blocks!.length).toBe(3);
    expect(blocks!.map((b) => b.type)).toEqual(['text', 'image', 'image']);
  });

  test('non-image attachment → resource_link block', async () => {
    const blocks = await withMockFetch('A', true, () =>
      buildPromptUserContentFromAttachments(
        'check',
        [docAttachment],
        { baseUrl },
      ),
    );
    expect(blocks!.length).toBe(2);
    expect(blocks![1]!.type).toBe('resource_link');
    expect((blocks![1] as unknown as { uri: string }).uri).toContain('file://');
    expect((blocks![1] as unknown as { name: string }).name).toBe('spec.pdf');
  });

  test('image fetch failure → text fallback block (turn still proceeds)', async () => {
    const blocks = await withMockFetch('error', false, () =>
      buildPromptUserContentFromAttachments(
        'try',
        [imageAttachment],
        { baseUrl },
      ),
    );
    expect(blocks!.length).toBe(2);
    expect(blocks![1]!.type).toBe('text');
    expect((blocks![1] as unknown as { text: string }).text).toContain('image fetch failed');
    expect((blocks![1] as unknown as { text: string }).text).toContain('photo.png');
  });

  test('mixed image + doc — Q1=B order preserved, both block kinds present', async () => {
    const blocks = await withMockFetch('A', true, () =>
      buildPromptUserContentFromAttachments(
        'review',
        [imageAttachment, docAttachment],
        { baseUrl },
      ),
    );
    expect(blocks!.length).toBe(3);
    expect(blocks!.map((b) => b.type)).toEqual(['text', 'image', 'resource_link']);
  });

  test('forwards bearer token via Authorization header', async () => {
    let observedHeader: string | undefined;
    await withFakeFetchDevice([{ url: '/v1/attachments/img-1', response: (request) => {
      observedHeader = request.headers.authorization;
      return new Response(new ArrayBuffer(0));
    } }], async () => {
      await buildPromptUserContentFromAttachments(
        '',
        [imageAttachment],
        { baseUrl, token: 'tok-xyz' },
      );
    });
    expect(observedHeader).toBe('Bearer tok-xyz');
  });
});
