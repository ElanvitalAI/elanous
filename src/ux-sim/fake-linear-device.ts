import type { BrowserHandDeps } from '../tool-runtime/browser-hand-runtime.js';

interface FakeLinearAttachment {
  issueId: string;
  title: string;
  url: string;
}

/** Fake Linear's network API while preserving the production coordinator's calls. */
export function createFakeLinearDevice() {
  const uploads: Array<{ filename: string; contentType: string; body: Buffer }> = [];
  const attachments: FakeLinearAttachment[] = [];
  const comments: Array<{ issueId: string; body: string }> = [];

  const deps: Pick<BrowserHandDeps, 'upload' | 'attach' | 'reflectSelection'> = {
    upload: async input => {
      uploads.push({ filename: input.filename, contentType: input.contentType, body: Buffer.from(input.body) });
      return `https://linear-sim.invalid/files/${uploads.length}`;
    },
    attach: async input => {
      attachments.push({ issueId: input.issueId, title: input.title, url: input.url });
      return `linear-attachment-${attachments.length}`;
    },
    reflectSelection: async input => {
      comments.push(input);
      return true;
    },
  };

  return { deps, uploads, attachments, comments };
}
