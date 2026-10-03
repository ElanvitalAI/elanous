import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { debug } from './debug/log.js';
import { effectiveInstanceRoot } from './instance/resolve.js';
import { runGraph } from './graph-runner/runner.js';
import { cardShape, detectCard, runCardFollowup, NotACardError, type CardDetectDecision } from './card-followup/core.js';
import type { TgIncoming } from './telegram.js';

// Latin keywords are whole words only — «postcard» or «cardinal» is not a card request (review round 3).
const KEYWORD = /명함|전략|메일\s*초안|초안|팔로업|\bcard\b|\bCRM\b/i;
/** Untagged albums start one graph run, not one per photo (chatId:mediaGroupId → first seen at). */
const startedAlbums = new Map<string, number>();
const ALBUM_TTL_MS = 10 * 60_000;
function firstOfAlbum(chatId: number, mediaGroupId: string | undefined, now: number): boolean {
  if (!mediaGroupId) return true;
  for (const [key, at] of startedAlbums) if (now - at > ALBUM_TTL_MS) startedAlbums.delete(key);
  const key = `${chatId}:${mediaGroupId}`;
  if (startedAlbums.has(key)) return false;
  startedAlbums.set(key, now);
  return true;
}

export { cardShape, cardText } from './card-followup/core.js';
const OCR_SCRIPT = resolve(import.meta.dir, '../scripts/ocr-text-regions.swift');
/** Local macOS Vision OCR (no network · no new dependency); null where it cannot run. */
export function localOcrText(path: string, timeoutMs = 30_000): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((done) => {
    let out = '';
    let child: ReturnType<typeof spawn>;
    try { child = spawn('swift', [OCR_SCRIPT, path], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { done(null); return; }
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(null); }, timeoutMs);
    child.stdout?.on('data', (chunk) => { out += String(chunk); });
    child.once('error', () => { clearTimeout(timer); done(null); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { done(null); return; }
      done(out.split('\n').map((l) => /^\s+[\d.]+\s+(.*?)\s+box=/.exec(l)?.[1]).filter(Boolean).join('\n'));
    });
  });
}

type Picked = 'all' | 'strategy' | 'draft' | 'crm';
export interface CardPhotoDeps {
  isOwner: (userId: number) => boolean;
  isFieldAlbum?: (id: string) => boolean;
  downloadFile: (fileId: string, destDir: string) => Promise<{ localPath: string }>;
  sendMessage: (chatId: number, text: string, opts: { replyTo: number; threadId?: number }) => Promise<unknown>;
  sendDocument: (chatId: number, body: string | Buffer, filename: string, opts: { replyTo: number; threadId?: number; mimeType?: string }) => Promise<unknown>;
  runGraph?: typeof runGraph;
  rootDir?: () => string;
  /** OCR text of a downloaded photo, or null when unavailable (default: local macOS Vision). */
  ocrText?: (path: string) => Promise<string | null>;
}

function pick(caption: string): Picked {
  if (/\bCRM\b/i.test(caption)) return 'crm';
  if (/메일\s*초안|초안/i.test(caption)) return 'draft';
  if (/전략/.test(caption)) return 'strategy';
  return 'all';
}

/** Starts a private graph run without blocking the Telegram message turn. */
export async function maybeHandleCardPhoto(ctx: TgIncoming, deps: CardPhotoDeps): Promise<boolean> {
  const photo = ctx.attachments.find((att) => att.kind === 'photo');
  const caption = ctx.text.trim();
  if (!ctx.isDm || ctx.isGroup || !deps.isOwner(ctx.userId) || !photo
    || (ctx.mediaGroupId && deps.isFieldAlbum?.(ctx.mediaGroupId))
    || /#현장/.test(caption) || (caption && !KEYWORD.test(caption))) return false;
  const detect = (decision: CardDetectDecision, signal: string) =>
    debug.log('telegram.card-followup', 'detect', { chatId: ctx.chatId, decision, signal });
  if (!caption) {
    const shape = cardShape(photo.width, photo.height);
    if (shape.decision === 'skip') { detect('skip', shape.signal); return false; }
  }
  // Album items after the first: a keyword caption sits on one item only, so later items follow the normal flow.
  if (!firstOfAlbum(ctx.chatId, ctx.mediaGroupId, Date.now())) return false;

  const picked = pick(caption);
  const started = Date.now();
  const reply = { replyTo: ctx.messageId, ...(ctx.threadId === undefined ? {} : { threadId: ctx.threadId }) };
  const log = (event: 'started' | 'not-a-card' | 'replied' | 'failed') =>
    debug.log('card.followup', event, { chatId: ctx.chatId, picked, ms: Date.now() - started });

  try {
    const root = (deps.rootDir ?? effectiveInstanceRoot)();
    const base = join(root, 'graph-runs', 'card-followup');
    const runId = randomUUID();
    const dir = join(base, runId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(base, 0o700);
    chmodSync(dir, 0o700);
    const prepare = async (): Promise<string | null> => {
      const { localPath } = await deps.downloadFile(photo.fileId, dir);
      chmodSync(localPath, 0o600);
      if (!caption) {
        const verdict = detectCard({ width: photo.width, height: photo.height, ocrText: await (deps.ocrText ?? localOcrText)(localPath) });
        detect(verdict.decision, verdict.signal);
        if (verdict.decision !== 'card') { rmSync(dir, { recursive: true, force: true }); return null; }
      }
      log('started');
      await deps.sendMessage(ctx.chatId, '명함으로 보고 정리하는 중입니다(1~3분)', reply);
      return localPath;
    };
    // A keyword caption is an explicit request: download before returning. A bare photo is judged in the background.
    const prepared = caption ? await prepare() : null;
    void (async () => {
      let localPath = prepared;
      try {
        if (!caption) {
          try { localPath = await prepare(); } catch { log('failed'); return; }
          if (!localPath) return;
        }
        let result;
        try {
          result = await runCardFollowup({ imagePath: localPath!, ocrText: null,
            runGraph: deps.runGraph ?? runGraph, rootDir: root, outDir: dir, runId,
            ...(caption ? { context: caption } : {}),
          });
        } catch (error) {
          if (error instanceof NotACardError) { log('not-a-card'); return; }
          throw error;
        }
        const markdown = readFileSync(result.followupPath!);
        const crmLine = picked === 'crm'
          ? /^## ② CRM 한 줄\r?\n파일: [^\r\n]*\r?\n([^\r\n]+)/m.exec(markdown.toString('utf8'))?.[1]
          : undefined;
        if (picked === 'crm' && !crmLine) throw new Error('CRM row missing from report');
        const messages = picked === 'strategy' ? [result.replies[1]] : picked === 'draft' ? [result.replies[2]] : picked === 'crm' ? [`CRM 한 줄\n${crmLine}`] : result.replies;
        for (const message of messages) await deps.sendMessage(ctx.chatId, message, reply);
        const sent = await deps.sendDocument(ctx.chatId, markdown, 'followup.md', { ...reply, mimeType: 'text/markdown' });
        if (sent === undefined) throw new Error('document delivery failed');
        log('replied');
      } catch {
        log('failed');
        try {
          await deps.sendMessage(ctx.chatId, '명함 정리에 실패했습니다. 다시 시도해 주세요.', reply);
        } catch { /* Telegram delivery itself failed; the failure is already observed. */ }
      }
    })();
  } catch {
    log('failed');
    // A bare photo was never claimed as a card — failing to prepare it stays silent.
    if (caption) {
      try {
        await deps.sendMessage(ctx.chatId, '명함 정리에 실패했습니다. 다시 시도해 주세요.', reply);
      } catch { /* Telegram delivery itself failed; the failure is already observed. */ }
    }
  }
  return !!caption;
}
