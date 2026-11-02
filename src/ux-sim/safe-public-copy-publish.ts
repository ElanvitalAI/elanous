import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecretText } from '../debug/log.js';
import { handleMarkdownPublish, handleMarkdownServe, type MarkdownPublishDeps } from '../nexus/api/markdown-publish.js';
import { createGlobalRequestLimiter } from '../nexus/api/request-limiter.js';
import { createPublishArtifactStore } from '../publishing/artifact-store.js';
import { MarkdownPublisher } from '../publishing/markdown-publisher.js';
import { createMarkdownRenderer } from '../publishing/markdown-renderer.js';
import type { PublishMarkdownResult, PublishRequest } from '../publishing/types.js';

export interface SafePublicCopyPublishOptions {
  root: string;
  draft: string;
  title: string;
  secretValues: readonly string[];
}

export interface SafePublicCopyPublishEvidence {
  status: number;
  servedStatus: number;
  publishId: string;
  internalUrl: string;
  publicUrl?: string;
  safeMarkdown: string;
  storedMarkdown: string;
  servedHtml: string;
  redaction: { changed: boolean; secretValuesRemoved: number };
  scriptInjectionRemoved: boolean;
  publicUploadBoundaryCalls: number;
  externalWrites: 0;
}

const ORIGIN = 'https://publish.example.test';

/** Runs the production redactor, POST handler, publisher, renderer, artifact store and GET handler.
 *  The injected public-upload boundary records its call and returns unavailable; it never writes externally. */
export async function runSafePublicCopyPublish(options: SafePublicCopyPublishOptions): Promise<SafePublicCopyPublishEvidence> {
  const presentSecrets = options.secretValues.filter((secret) =>
    secret.length > 0 && (options.draft.includes(secret) || options.title.includes(secret)));
  const safeMarkdown = redactSecretText(options.draft);
  const safeTitle = redactSecretText(options.title);
  const unresolvedSecrets = presentSecrets.filter((secret) => safeMarkdown.includes(secret) || safeTitle.includes(secret));
  if (unresolvedSecrets.length > 0) {
    throw new Error('safe-copy redaction left ' + unresolvedSecrets.length + ' input secret value(s)');
  }
  const store = createPublishArtifactStore({ root: options.root });
  const render = createMarkdownRenderer(ORIGIN);
  const publisher = new MarkdownPublisher({
    store,
    origin: ORIGIN,
    render,
    now: () => Date.parse('2026-11-02T00:00:00.000Z'),
    randomBytes: (size) => Buffer.alloc(size, 0x2a),
  });
  let publicUploadBoundaryCalls = 0;
  const deps: MarkdownPublishDeps = {
    publisher,
    limiter: createGlobalRequestLimiter(),
    store,
    publishToS3: () => { publicUploadBoundaryCalls += 1; return null; },
  };
  const request: PublishRequest = { markdown: safeMarkdown, title: safeTitle, target: 'funnel' };
  const response = handleMarkdownPublish(JSON.stringify(request), deps);
  if (response.status !== 201) throw new Error(`safe-copy publish failed: HTTP ${response.status}`);
  const result = await response.json() as PublishMarkdownResult;
  const served = handleMarkdownServe(result.id, deps, 'funnel');
  const servedHtml = await served.text();
  const storedMarkdown = readFileSync(join(options.root, 'docs', result.id, 'source.md'), 'utf8');
  const publicUrl = 'publicUrl' in result && typeof result.publicUrl === 'string' ? result.publicUrl : undefined;
  const inputHadExecutableMarkup = /<script\b/i.test(options.draft) || /\bon[a-z]+\s*=/i.test(options.draft);
  const servedHtmlHasExecutableMarkup = /<script\b/i.test(servedHtml) || /\bon[a-z]+\s*=/i.test(servedHtml);
  return {
    status: response.status,
    servedStatus: served.status,
    publishId: result.id,
    internalUrl: result.url,
    ...(publicUrl ? { publicUrl } : {}),
    safeMarkdown,
    storedMarkdown,
    servedHtml,
    redaction: {
      changed: safeMarkdown !== options.draft || safeTitle !== options.title,
      secretValuesRemoved: presentSecrets.length,
    },
    scriptInjectionRemoved: inputHadExecutableMarkup && !servedHtmlHasExecutableMarkup,
    publicUploadBoundaryCalls,
    externalWrites: 0,
  };
}
