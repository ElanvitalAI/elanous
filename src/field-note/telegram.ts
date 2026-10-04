import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateFieldNote, type FieldPhoto, type TranscriptEntry } from './index.js';
import { transcribeFieldAudio, type FieldAudio, type TranscriptionEngine } from './transcribe.js';
import type { TgIncoming, TgIncomingAttachment } from '../telegram.js';

interface SavedMedia { kind: 'photo' | 'voice' | 'audio'; file: string; receivedAt: string; messageId: number }
interface NoteWindow { title: string; start: string; end: string; status: 'open' | 'done'; openedBy: number; media: SavedMedia[]; notePath?: string }

export interface TelegramFieldNoteDeps {
  rootDir: string;
  download: (fileId: string) => Promise<{ localPath: string }>;
  reply: (ctx: TgIncoming, text: string) => Promise<void>;
  engine?: TranscriptionEngine;
  decodeAudio?: (file: string, recordedAt: string) => FieldAudio;
  now?: () => Date;
}

/** Decode Telegram's Ogg/Opus (or audio file) into NOTE3a's 16kHz mono float PCM. */
export function decodeFieldAudio(file: string, recordedAt: string): FieldAudio {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', '16000', 'pipe:1'], { maxBuffer: 1024 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`음성 디코딩 실패: ${result.stderr.toString().trim() || result.error?.message || 'ffmpeg'}`);
  if (result.stdout.length % 4) throw new Error('음성 디코딩 실패: 잘못된 PCM 길이');
  const bytes = result.stdout;
  const samples = new Float32Array(bytes.length / 4);
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readFloatLE(i * 4);
  return { samples, sampleRate: 16000, recordedAt };
}

function windowPath(ctx: TgIncoming, root: string): string {
  const bot = (ctx.botId ?? 'bot').replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(root, 'field-notes', 'telegram', bot, String(ctx.chatId), String(ctx.threadId ?? 0), String(ctx.userId), 'window.json');
}

function readWindow(path: string): NoteWindow | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as NoteWindow : null;
}

function saveWindow(path: string, window: NoteWindow): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(window, null, 2) + '\n');
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function parseWindow(text: string, now: Date): { title: string; start: string; end: string } | null {
  const match = /^노트:\s*(.+?)\s+(\d{2}):(\d{2})\s*[~～]\s*(\d{2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [, title, h1, m1, h2, m2] = match;
  if (!Number.isFinite(now.getTime()) || +h1! > 23 || +h2! > 23 || +m1! > 59 || +m2! > 59) return null;
  const local = new Date(now.getTime() + 9 * 60 * 60_000).toISOString().slice(0, 10);
  const start = new Date(`${local}T${h1}:${m1}:00+09:00`);
  const end = new Date(`${local}T${h2}:${m2}:00+09:00`);
  if (end <= start) return null;
  return { title: title!.trim(), start: start.toISOString(), end: end.toISOString() };
}

export async function handleTelegramFieldNote(ctx: TgIncoming, deps: TelegramFieldNoteDeps): Promise<boolean> {
  const text = ctx.text.trim();
  const path = windowPath(ctx, deps.rootDir);
  if (text.startsWith('노트:')) {
    const parsed = parseWindow(text, ctx.receivedAt ? new Date(ctx.receivedAt) : (deps.now ?? (() => new Date()))());
    if (!parsed) await deps.reply(ctx, '노트 시간 형식: 노트: 세미나 18:00~20:00');
    else {
      const previous = readWindow(path);
      if (previous?.status === 'open' && previous.media.length) {
        await deps.reply(ctx, '열린 노트 창이 있습니다 — 먼저 노트 만들기를 완료하세요.');
        return true;
      }
      saveWindow(path, { ...parsed, status: 'open', openedBy: ctx.messageId, media: [] });
      await deps.reply(ctx, `노트 창 열림 · ${parsed.title} · ${text.slice(text.lastIndexOf(' ') + 1)}`);
    }
    return true;
  }
  if (text !== '노트 만들기' && !ctx.attachments.some((a) => a.kind === 'photo' || a.kind === 'voice' || a.kind === 'audio')) return false;
  const window = readWindow(path);
  if (text === '노트 만들기') {
    if (!window || window.status !== 'open') {
      await deps.reply(ctx, '열린 노트 창 없음');
      return true;
    }
    if (window.media.some((item) => item.kind !== 'photo') && !deps.engine) {
      await deps.reply(ctx, '전사 엔진 없음 — NOTE3a 전사 엔진을 설정해 주세요. 모은 파일은 유지됩니다.');
      return true;
    }
    try {
      const photos: FieldPhoto[] = window.media.filter((item) => item.kind === 'photo').map((item) => ({ file: item.file, exifTakenAt: item.receivedAt }));
      const transcript: TranscriptEntry[] = [];
      for (const item of window.media.filter((m) => m.kind !== 'photo')) {
        const audio = (deps.decodeAudio ?? decodeFieldAudio)(item.file, item.receivedAt);
        transcript.push(...await transcribeFieldAudio(audio, deps.engine!));
      }
      const markdown = await generateFieldNote(photos, transcript, {
        summarize: async (entries) => entries.map((entry) => `${entry.timestamp} · ${entry.speaker}: ${entry.text}`).join('\n'),
      });
      const notePath = join(path, '..', `note-${window.openedBy}.md`);
      const noteTemp = `${notePath}.${randomUUID()}.tmp`;
      try {
        writeFileSync(noteTemp, `# ${window.title}\n\n시간 창: ${window.start} ~ ${window.end}\n\n${markdown}`);
        renameSync(noteTemp, notePath);
      } finally {
        if (existsSync(noteTemp)) unlinkSync(noteTemp);
      }
      saveWindow(path, { ...window, status: 'done', notePath });
      await deps.reply(ctx, `노트 생성 · ${notePath}`);
    } catch (error) {
      await deps.reply(ctx, `노트 생성 실패 · ${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  }
  if (!window || window.status !== 'open') return false;
  const media = ctx.attachments.filter((a): a is TgIncomingAttachment & { kind: 'photo' | 'voice' | 'audio' } =>
    a.kind === 'photo' || a.kind === 'voice' || a.kind === 'audio');
  if (!media.length) return false;
  const receivedAt = ctx.receivedAt ?? (deps.now ?? (() => new Date()))().toISOString();
  if (ctx.messageId <= window.openedBy || receivedAt < window.start || receivedAt > window.end) return false;
  const dir = join(path, '..', 'media');
  mkdirSync(dir, { recursive: true });
  try {
    for (const [index, item] of media.entries()) {
      if (window.media.some((saved) => saved.messageId === ctx.messageId && saved.kind === item.kind)) continue;
      const downloaded = await deps.download(item.fileId);
      const extension = item.kind === 'photo' ? 'jpg' : item.kind === 'voice' ? 'ogg'
        : item.mimeType === 'audio/mpeg' ? 'mp3' : item.mimeType === 'audio/ogg' ? 'ogg' : 'audio';
      const file = join(dir, `${ctx.messageId}-${index}.${extension}`);
      try { copyFileSync(downloaded.localPath, file); }
      finally { try { unlinkSync(downloaded.localPath); } catch { /* download may be reused by the caller */ } }
      window.media.push({ kind: item.kind, file, receivedAt, messageId: ctx.messageId });
      saveWindow(path, window);
    }
    await deps.reply(ctx, `노트 파일 모음 · 사진 ${window.media.filter((m) => m.kind === 'photo').length}장 · 음성 ${window.media.filter((m) => m.kind !== 'photo').length}개`);
  } catch (error) {
    await deps.reply(ctx, `노트 파일 저장 실패 · ${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
}
