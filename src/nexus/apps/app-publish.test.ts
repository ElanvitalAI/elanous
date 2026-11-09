import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import type { AppManifest } from './app-contract.js';
import { createAppPublishRenderEntry } from './app-publish.js';

const manifests = new Map<string, AppManifest>([
  ['voice-notes', { apiVersion: 'elanous.app/v0', slug: 'voice-notes', title: 'Voice notes' }],
  ['other-app', { apiVersion: 'elanous.app/v0', slug: 'other-app', title: 'Other app' }],
]);

function publishRequest(appSlug: string, body: unknown, method = 'POST'): Request {
  return new Request(`http://nexus.invalid/v1/apps/${appSlug}/publish`, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'owner-session' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

test('APP-PUBLISH-RENDER-ENTRY authenticates owner publishing and rejects malformed routes before writing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-publish-entry-'));
  let authorized = false;
  let manifestReads = 0;
  const entry = createAppPublishRenderEntry({
    getManifest: slug => { manifestReads += 1; return manifests.get(slug); },
    authorizeOwner: () => authorized,
    rootForApp: slug => join(root, slug),
    originForApp: slug => `https://${slug}--kaist-demo.elanous.app`,
    now: () => Date.parse('2026-11-07T00:00:00.000Z'),
  });
  try {
    const wrongMethod = await entry.handleApiRequest(new Request('http://nexus.invalid/v1/apps/voice-notes/publish', { method: 'GET' }));
    expect(wrongMethod?.status).toBe(405);
    expect(manifestReads).toBe(0);

    const unauthorized = await entry.handleApiRequest(publishRequest('voice-notes', { markdown: 'private' }));
    expect(unauthorized?.status).toBe(401);
    expect(manifestReads).toBe(0);

    authorized = true;
    const unknownField = await entry.handleApiRequest(publishRequest('voice-notes', { markdown: 'hello', target: 'cloudfront' }));
    expect(unknownField?.status).toBe(400);
    const absentApp = await entry.handleApiRequest(publishRequest('missing-app', { markdown: 'hello' }));
    expect(absentApp?.status).toBe(404);
    expect(manifestReads).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('APP-PUBLISH-RENDER-ENTRY renders an immutable app-scoped share with sanitization and response version', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-publish-render-'));
  const entry = createAppPublishRenderEntry({
    getManifest: slug => manifests.get(slug),
    authorizeOwner: (_request, slug) => slug === 'voice-notes',
    rootForApp: slug => join(root, slug),
    originForApp: slug => `https://${slug}--kaist-demo.elanous.app`,
    now: () => Date.parse('2026-11-07T00:00:00.000Z'),
  });
  try {
    const published = await entry.handleApiRequest(publishRequest('voice-notes', {
      title: 'Demo notes', markdown: 'Product copy <script>alert(1)</script>\n\n**safe text**',
    }));
    expect(published?.status).toBe(201);
    const result = await published!.json() as { id: string; version: string; shareUrl: string; expiresAt: string };
    expect(result.version).toBe(result.id);
    expect(result.shareUrl).toBe(`https://voice-notes--kaist-demo.elanous.app/share/${result.id}`);

    const shareRequest = new Request(`http://voice-notes.app.localhost/share/${result.id}`, { headers: { host: 'voice-notes.app.localhost' } });
    const shared = entry.handleShareRequest(shareRequest);
    expect(shared?.status).toBe(200);
    expect(shared?.headers.get('x-app-version')).toBe(result.version);
    expect(shared?.headers.get('content-security-policy')).toContain("sandbox");
    expect(shared?.headers.get('cache-control')).toContain('max-age=300');
    const html = await shared!.text();
    expect(html).toContain('safe text');
    expect(html).not.toContain('<script>');

    const otherAppShare = entry.handleShareRequest(new Request(`https://other-app.app.localhost/share/${result.id}`, {
      headers: { host: 'other-app.app.localhost' },
    }));
    expect(otherAppShare?.status).toBe(404);
    expect(entry.handleShareRequest(new Request(`https://voice-notes.app.localhost/share/${'A'.repeat(22)}`,
      { headers: { host: 'voice-notes.app.localhost' } }))?.status).toBe(404);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
