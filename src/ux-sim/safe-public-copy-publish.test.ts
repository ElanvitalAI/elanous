import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSafePublicCopyPublish } from './safe-public-copy-publish.js';

describe('safe public-copy publication device', () => {
  test('redacts a launch draft, calls real publish and serve handlers, and records no external write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'safe-public-copy-publish-'));
    const secret = 'abcdef0123456789zz';
    try {
      const evidence = await runSafePublicCopyPublish({
        root,
        title: 'Release note',
        draft: `# Release update\n\nOPENROUTER_API_KEY=abcdef0123456789zz\n\n<SCRIPT>window.__launch_copy_exfiltrate=1</SCRIPT>\n<img src=x\tonerror=window.__other_payload=1>\n<svg onload=window.__svg_payload=1></svg>`,
        secretValues: [secret, 'not-present-secret'],
      });
      expect(evidence.status).toBe(201);
      expect(evidence.servedStatus).toBe(200);
      expect(evidence.internalUrl).toContain('/d/');
      expect(evidence.publicUrl).toBeUndefined();
      expect(evidence.safeMarkdown).toContain('OPENROUTER_API_KEY=***');
      expect(evidence.storedMarkdown).toBe(evidence.safeMarkdown);
      expect(evidence.redaction).toEqual({ changed: true, secretValuesRemoved: 1 });
      expect(evidence.scriptInjectionRemoved).toBe(true);
      expect(evidence.servedHtml).not.toMatch(/<script\b/i);
      expect(evidence.servedHtml).not.toMatch(/<svg[^>]*\bonload\s*=/i);
      expect(evidence.servedHtml).not.toContain("__launch_copy_exfiltrate");
      expect(evidence.servedHtml).not.toContain("__other_payload");
      expect(evidence.servedHtml).not.toMatch(/\bonerror\s*=/i);
      expect(evidence.servedHtml).toContain('Release update');
      expect(evidence.publicUploadBoundaryCalls).toBe(1);
      expect(evidence.externalWrites).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });


  test('an input secret the redactor does not recognize stops before the artifact store is created', async () => {
    const root = mkdtempSync(join(tmpdir(), 'safe-public-copy-unredacted-'));
    try {
      await expect(runSafePublicCopyPublish({
        root,
        title: 'Release note',
        draft: "Unclassified marker: unclassified-marker-zz-31415926",
        secretValues: ['unclassified-marker-zz-31415926'],
      })).rejects.toThrow('redaction left 1 input secret value');
      expect(existsSync(join(root, 'docs'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
