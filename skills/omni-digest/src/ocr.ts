/** Upstage Document OCR — absorbed from photo-intake-ocr (Python → TypeScript) */

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { env } from './env.js';

const API_URL = 'https://api.upstage.ai/v1/document-digitization';

/** Resolve Upstage API key: env → cache file → zshrc */
function getUpstageApiKey(): string {
  let key = env('UPSTAGE_API_KEY');
  if (key) return key;

  const cachePath = resolve(process.env.HOME || '~', '.cache', 'upstage_api_key');
  if (existsSync(cachePath)) {
    key = readFileSync(cachePath, 'utf-8').trim();
    if (key) return key;
  }

  try {
    key = execSync('zsh -lc "source ~/.zshrc >/dev/null 2>&1; printenv UPSTAGE_API_KEY"', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (key) return key;
  } catch { /* ignore */ }

  throw new Error('UPSTAGE_API_KEY를 찾을 수 없습니다. .env, ~/.cache/upstage_api_key, 또는 ~/.zshrc에 설정하세요.');
}

/** Guess MIME type from extension */
function guessMime(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop() || '';
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    bmp: 'image/bmp', tiff: 'image/tiff', webp: 'image/webp',
    pdf: 'application/pdf',
  };
  return map[ext] || 'application/octet-stream';
}

export interface OcrResult {
  text: string;
  json?: any;
}

/**
 * Run Upstage Document OCR on a local file.
 * Returns extracted text (and optionally full JSON).
 */
export async function upstageOcr(filePath: string, opts?: { textOnly?: boolean; model?: string }): Promise<OcrResult> {
  const apiKey = getUpstageApiKey();
  const model = opts?.model || 'ocr';
  const fileName = filePath.split('/').pop() || 'file';
  const mimeType = guessMime(filePath);
  const fileBytes = readFileSync(filePath);

  const boundary = '----OmniDigestUpstageOCRBoundary';
  const bodyParts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
  ];

  const textEncoder = new TextEncoder();
  const parts: Uint8Array[] = [
    textEncoder.encode(bodyParts[0]),
    textEncoder.encode(bodyParts[1]),
    fileBytes,
    textEncoder.encode(`\r\n--${boundary}--\r\n`),
  ];

  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const body = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) { body.set(p, offset); offset += p.length; }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Upstage OCR error: ${res.status} ${errText}`);
  }

  const payload = await res.json();
  const text = payload.text || '';

  if (opts?.textOnly) return { text };
  return { text, json: payload };
}

/**
 * Fallback OCR via OCR.space API (for when Upstage is unavailable).
 */
export async function ocrSpaceFallback(filePath: string): Promise<string> {
  const apiKey = env('OCR_API_KEY');
  if (!apiKey) throw new Error('OCR_API_KEY 없음');

  const fileBytes = readFileSync(filePath);
  const fileName = filePath.split('/').pop() || 'file';

  const formData = new FormData();
  formData.append('file', new Blob([fileBytes]), fileName);
  formData.append('language', 'kor');
  formData.append('isOverlayRequired', 'false');
  formData.append('OCREngine', '2');

  const res = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    headers: { apikey: apiKey },
    body: formData,
  });
  if (!res.ok) throw new Error(`OCR.space error: ${res.status}`);
  const data = await res.json();
  return data.ParsedResults?.map((r: any) => r.ParsedText).join('\n') || '';
}

/**
 * Run OCR with automatic fallback: Upstage → OCR.space
 */
export async function runOcr(filePath: string): Promise<string> {
  // Try Upstage first
  try {
    const result = await upstageOcr(filePath, { textOnly: true });
    if (result.text.trim().length > 10) {
      console.log(`  Upstage OCR 성공 (${result.text.length.toLocaleString()}자)`);
      return result.text;
    }
  } catch (e: any) {
    console.log(`  Upstage OCR 실패: ${e.message}`);
  }

  // Try OCR.space fallback
  try {
    const text = await ocrSpaceFallback(filePath);
    if (text.trim().length > 10) {
      console.log(`  OCR.space 폴백 성공 (${text.length.toLocaleString()}자)`);
      return text;
    }
  } catch (e: any) {
    console.log(`  OCR.space 폴백 실패: ${e.message}`);
  }

  return '';
}
