import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { defaultAttachmentBaseDir, resolveAttachmentPath } from '../../boot/attachment-store.js';
import { detectCard, NotACardError, runCardFollowup } from '../../card-followup/core.js';
import { debug } from '../../debug/log.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { localOcrText } from '../../telegram-card-followup.js';
import { jsonResponse } from './json-response.js';

export const CARD_FOLLOWUP_PATH = '/v1/card-followup';

type CardJob = { id: string; status: 'judging' | 'running' | 'done' | 'not-card' | 'failed'; updatedAt: number; replies?: [string, string, string]; error?: string };
type CardDeps = {
  rootDir?: string;
  resolveAttachment?: typeof resolveAttachmentPath;
  ocr?: typeof localOcrText;
  detect?: typeof detectCard;
  run?: typeof runCardFollowup;
  now?: () => number;
};

function withinAttachmentStore(path: string): boolean {
  try {
    const relativePath = relative(realpathSync(defaultAttachmentBaseDir()), realpathSync(path));
    return relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
  } catch { return false; }
}

/** The in-memory set identifies only work launched by this daemon; disk is the pollable ledger. */
export function createCardFollowupJobs({
  rootDir = effectiveInstanceRoot(),
  resolveAttachment = resolveAttachmentPath,
  ocr = localOcrText,
  detect = detectCard,
  run = runCardFollowup,
  now = Date.now,
}: CardDeps = {}) {
  const base = join(rootDir, 'graph-runs', 'card-followup');
  const active = new Set<string>();
  const unavailable = new Set<string>();
  const file = (id: string) => join(base, `${id}.pwa.json`);
  const save = (job: CardJob) => {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    chmodSync(base, 0o700);
    writeFileSync(file(job.id), JSON.stringify(job), { mode: 0o600 });
    chmodSync(file(job.id), 0o600);
  };

  return {
    async post(req: Request): Promise<Response> {
      let body: unknown;
      try { body = await req.json(); } catch { body = null; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse({ error: 'bad_request' }, 400);
      const { attachmentId, context } = body as Record<string, unknown>;
      if (context !== undefined && typeof context !== 'string') return jsonResponse({ error: 'bad_request' }, 400);
      const imagePath = typeof attachmentId === 'string' ? resolveAttachment(attachmentId) : null;
      if (!imagePath || (resolveAttachment === resolveAttachmentPath && !withinAttachmentStore(imagePath))) {
        return jsonResponse({ error: 'attachment-not-found' }, 400);
      }

      const id = randomUUID();
      const update = (status: CardJob['status'], fields: Partial<Pick<CardJob, 'replies' | 'error'>> = {}) =>
        save({ id, status, updatedAt: now(), ...fields });
      update('judging');
      active.add(id);
      debug.log('card-followup.pwa', 'started', { id });
      // Start OCR on the next event-loop turn so the acceptance response precedes the work.
      setTimeout(() => {
        void (async () => {
          try {
            const ocrText = await ocr(imagePath);
            if (detect({ ocrText }).decision !== 'card') {
              update('not-card');
              debug.log('card-followup.pwa', 'not-card', { id });
              return;
            }
            update('running');
            const result = await run({ imagePath, ocrText, rootDir, runId: id, ...(context === undefined ? {} : { context }) });
            update('done', { replies: result.replies });
            debug.log('card-followup.pwa', 'done', { id });
          } catch (cause) {
            const notCard = cause instanceof NotACardError;
            // OCR·그래프 예외 문구엔 명함 원문이 섞일 수 있다 — 원장·응답엔 고정 코드만 싣는다(리뷰 must-fix).
            try {
              update(notCard ? 'not-card' : 'failed', notCard ? {} : { error: 'card-followup-failed' });
              debug.log('card-followup.pwa', notCard ? 'not-card' : 'failed', { id });
            } catch {
              unavailable.add(id);
              debug.log('card-followup.pwa', 'failed', { id });
            }
          } finally {
            active.delete(id);
          }
        })().catch(() => {
          unavailable.add(id);
          active.delete(id);
        });
      });
      return jsonResponse({ id }, 202);
    },
    get(id: string): Response {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return jsonResponse({ error: 'not-found' }, 404);
      if (unavailable.has(id)) return jsonResponse({ id, status: 'failed', error: 'card-followup-failed' });
      let job: CardJob;
      try { job = JSON.parse(readFileSync(file(id), 'utf8')) as CardJob; }
      catch { return jsonResponse({ error: 'not-found' }, 404); }
      if (job.id !== id) return jsonResponse({ error: 'not-found' }, 404);
      if ((job.status === 'judging' || job.status === 'running') && !active.has(id)) {
        return jsonResponse({ id, status: 'failed', error: 'daemon-restarted' });
      }
      const { status, replies, error } = job;
      return jsonResponse({ id, status, ...(replies ? { replies } : {}), ...(error ? { error } : {}) });
    },
  };
}

export type CardFollowupJobs = ReturnType<typeof createCardFollowupJobs>;
