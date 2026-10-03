import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { debug } from './debug/log.js';
import { effectiveInstanceRoot } from './instance/resolve.js';
import { lastJsonObject, runGraph, type GraphRunState } from './graph-runner/runner.js';
import type { TgIncoming } from './telegram.js';

const GRAPH = resolve(import.meta.dir, '../plugins/card-followup/graphs/card-followup.yaml');
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

// Captionless photos start a run only when they look like a business card (OP 10-02 18:54 · cheap signals first, ambiguous → nothing).
export type CardDetectDecision = 'card' | 'skip' | 'ambiguous';
export function cardShape(width?: number, height?: number): { decision: 'skip' | 'pass'; signal: string } {
  if (!width || !height) return { decision: 'pass', signal: 'ratio:unknown' };
  const ratio = Math.max(width, height) / Math.min(width, height);
  if (ratio < 1.15) return { decision: 'skip', signal: 'ratio:square' };
  if (ratio > 2.0) return { decision: 'skip', signal: 'ratio:screenshot' };
  return { decision: 'pass', signal: `ratio:${ratio.toFixed(2)}` };
}
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{4}/;
const WEB = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|co\.kr|kr|io|ai|net|org)\b/i;
const TITLE = /대표|이사|팀장|부장|과장|실장|매니저|주식회사|\(주\)|\b(?:CEO|CTO|COO|CFO|Director|Manager|Founder|Inc|Ltd|Corp)\b/i;
/** Card text is short and carries contact patterns; long text is a document. Returns signal names only, never the text. */
export function cardText(ocr: string | null): { decision: CardDetectDecision; signal: string } {
  if (ocr === null) return { decision: 'ambiguous', signal: 'ocr:unavailable' };
  const chars = ocr.replace(/\s+/g, '').length;
  if (chars < 15) return { decision: 'ambiguous', signal: `ocr:chars<15` };
  if (chars > 700) return { decision: 'skip', signal: 'ocr:document' };
  const hits = ([['email', EMAIL], ['phone', PHONE], ['web', WEB], ['title', TITLE]] as const).filter(([, re]) => re.test(ocr)).map(([name]) => name);
  const signal = `ocr:${hits.join(',') || 'none'}`;
  if (hits.length >= 2) return { decision: 'card', signal };
  return { decision: hits.length === 0 ? 'skip' : 'ambiguous', signal };
}
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

const obj = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const line = (value: unknown): string => (typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value)).replace(/[\r\n]+/g, ' ') || '—';

function isNotACard(state: GraphRunState): boolean {
  if (state.status !== 'failed') return false;
  const read = state.nodes.find((node) => node.nodeId === 'read-card');
  if (!read || !read.ok) return false;
  const output = lastJsonObject(read.output);
  if (output?.outcome === 'ok' && output.card && typeof output.card === 'object') {
    const card = obj(output.card);
    return !['name', 'company', 'title', 'email', 'phone', 'url', 'linkedin'].some((field) => text(card[field]));
  }
  return output?.outcome === 'fail' && typeof output.reason === 'string'
    && /\bnot a (?:business )?card\b|명함이?\s*아님|명함이?\s*아닙니다/i.test(output.reason);
}

function validateReport(report: Record<string, unknown>): void {
  const card = obj(report.card), fit = obj(report.fit), approach = obj(report.approach);
  const next = obj(report.nextAction), draft = obj(report.draft);
  const score = fit.score;
  if (report.sent !== false || !text(card.name) || !text(card.company)
    || !(score === null || (typeof score === 'number' && Number.isFinite(score)))
    || !text(fit.label) || !text(approach.problem) || !text(approach.proposal)
    || !text(approach.channel) || !text(next.what) || !text(next.due)
    || !text(draft.subject) || !text(draft.body)) {
    throw new Error('incomplete or sent card report');
  }
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
        const verdict = cardText(await (deps.ocrText ?? localOcrText)(localPath));
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
        const state = await (deps.runGraph ?? runGraph)(GRAPH, { runId, deps: { root }, input: {
          image: localPath!, outDir: dir, ...(caption ? { context: caption } : {}),
        } });
        if (!deps.runGraph) {
          const statePath = join(base, `${runId}.json`);
          chmodSync(statePath, 0o600);
          const contexts = `${statePath}.contexts`;
          try {
            chmodSync(contexts, 0o700);
            for (const file of readdirSync(contexts)) chmodSync(join(contexts, file), 0o600);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        if (isNotACard(state)) {
          log('not-a-card');
          return;
        }
        if (state.status !== 'done') throw new Error('graph did not finish');
        const report = obj(JSON.parse(readFileSync(join(dir, 'followup.json'), 'utf8')));
        validateReport(report);
        const card = obj(report.card), fit = obj(report.fit), approach = obj(report.approach);
        const next = obj(report.nextAction), draft = obj(report.draft);
        const summary = `① 요약\n${line(card.name)} · ${line(card.company)} · ${line(card.title)}\n타겟 판정: ${line(fit.score)} · ${line(fit.label)}`;
        const strategy = `② 전략\n${[approach.problem, approach.proposal, approach.channel].map(line).join('\n')}\n다음 행동: ${line(next.what)} · ${line(next.due)}`;
        const mail = `③ 팔로업 초안 (보내지 않았습니다)\n제목: ${line(draft.subject)}\n${text(draft.body)}`;
        const markdown = readFileSync(join(dir, 'followup.md'));
        const crmLine = picked === 'crm'
          ? /^## ② CRM 한 줄\r?\n파일: [^\r\n]*\r?\n([^\r\n]+)/m.exec(markdown.toString('utf8'))?.[1]
          : undefined;
        if (picked === 'crm' && !crmLine) throw new Error('CRM row missing from report');
        const messages = picked === 'strategy' ? [strategy] : picked === 'draft' ? [mail] : picked === 'crm' ? [`CRM 한 줄\n${crmLine}`] : [summary, strategy, mail];
        for (const message of messages) await deps.sendMessage(ctx.chatId, message, reply);
        const sent = await deps.sendDocument(ctx.chatId, markdown, 'followup.md', { ...reply, mimeType: 'text/markdown' });
        if (sent === undefined) throw new Error('document delivery failed');
        log('replied');
      } catch {
        log('failed');
        try {
          await deps.sendMessage(ctx.chatId, '명함 정리에 실패했습니다. 다시 시도해 주세요.', reply);
        } catch { /* Telegram delivery itself failed; the failure is already observed. */ }
      } finally {
        if (!deps.runGraph) {
          // The runner may throw before returning its state; seal any partial state and contexts too.
          const statePath = join(base, `${runId}.json`);
          try { chmodSync(statePath, 0o600); } catch { /* no state yet */ }
          const contexts = `${statePath}.contexts`;
          try {
            chmodSync(contexts, 0o700);
            for (const file of readdirSync(contexts)) chmodSync(join(contexts, file), 0o600);
          } catch { /* no contexts yet */ }
        }
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
