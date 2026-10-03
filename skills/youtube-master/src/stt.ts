import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { env } from './env.js';
import type { SttEngine, TranscribeResult } from './types.js';

async function uploadFormData(
  url: string,
  headers: Record<string, string>,
  fields: Record<string, string>,
  filePath: string,
): Promise<Response> {
  const buffer = await readFile(filePath);
  const blob = new Blob([buffer], { type: 'audio/mpeg' });
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    form.append(k, v);
  }
  form.append('file', blob, basename(filePath));
  return fetch(url, { method: 'POST', headers, body: form });
}

// ── ElevenLabs ──

async function transcribeElevenLabs(chunk: string, lang: string, model: string): Promise<string> {
  const apiKey = env('ELEVENLABS_API_KEY') || env('XI_API_KEY');
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY 또는 XI_API_KEY가 없습니다.');
  console.log(`  ElevenLabs STT: ${model}`);
  const res = await uploadFormData(
    'https://api.elevenlabs.io/v1/speech-to-text',
    { 'xi-api-key': apiKey },
    { model_id: model, language_code: lang, diarize: 'false', timestamps_granularity: 'word' },
    chunk,
  );
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.text || '').trim();
  if (!text) throw new Error('ElevenLabs 응답이 비었습니다.');
  return text;
}

// ── OpenAI Audio API ──

async function transcribeOpenAI(chunk: string, lang: string, model: string): Promise<string> {
  const apiKey = env('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY가 없습니다.');
  console.log(`  OpenAI STT: ${model}`);
  const res = await uploadFormData(
    'https://api.openai.com/v1/audio/transcriptions',
    { Authorization: `Bearer ${apiKey}` },
    { model, response_format: 'text', language: lang },
    chunk,
  );
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const text = (await res.text()).trim();
  if (!text) throw new Error('OpenAI 응답이 비었습니다.');
  return text;
}

// ── Gemini API ──

function geminiApiKey(): string {
  const key = env('GEMINI_API_KEY') || env('GOOGLE_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY 또는 GOOGLE_API_KEY가 없습니다.');
  return key;
}

async function geminiUploadFile(filePath: string): Promise<{ uri: string; name: string }> {
  const apiKey = geminiApiKey();
  const buffer = await readFile(filePath);
  const startRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(buffer.byteLength),
        'X-Goog-Upload-Header-Content-Type': 'audio/mpeg',
      },
      body: JSON.stringify({ file: { display_name: basename(filePath) } }),
    },
  );
  const uploadUrl = startRes.headers.get('X-Goog-Upload-URL');
  if (!uploadUrl) throw new Error('Gemini Files API 업로드 URL을 받지 못했습니다.');

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(buffer.byteLength),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: buffer,
  });
  const data = await uploadRes.json();
  const fileInfo = data.file || {};
  if (!fileInfo.uri) throw new Error('Gemini Files API 업로드 응답에 file.uri가 없습니다.');
  return { uri: fileInfo.uri, name: fileInfo.name };
}

async function geminiDeleteFile(fileName: string): Promise<void> {
  try {
    const apiKey = geminiApiKey();
    await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`, { method: 'DELETE' });
  } catch { /* ignore */ }
}

async function transcribeGemini(chunk: string, lang: string, model: string): Promise<string> {
  const apiKey = geminiApiKey();
  console.log(`  Gemini STT: ${model}`);
  const fileInfo = await geminiUploadFile(chunk);
  const langName = lang === 'ko' ? 'Korean' : lang;
  const prompt =
    'Transcribe this audio faithfully. ' +
    'Return only the transcript text, with no summary, no markdown, and no commentary. ' +
    `The spoken language is primarily ${langName}. ` +
    'Preserve meaningful line breaks when helpful.';
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { file_data: { mime_type: 'audio/mpeg', file_uri: fileInfo.uri } },
            ],
          }],
        }),
      },
    );
    const data = await res.json();
    const texts: string[] = [];
    for (const cand of data.candidates || []) {
      for (const part of cand.content?.parts || []) {
        if (part.text) texts.push(part.text);
      }
    }
    const text = texts.join('\n').trim();
    if (!text) throw new Error('Gemini transcription 응답이 비었습니다.');
    return text;
  } finally {
    await geminiDeleteFile(fileInfo.name);
  }
}

// ── Orchestrator ──

type EngineFn = (chunk: string, lang: string, model: string) => Promise<string>;

const ENGINE_MAP: Record<SttEngine, { fn: EngineFn; modelEnv: string; modelDefault: string }> = {
  elevenlabs: { fn: transcribeElevenLabs, modelEnv: 'ELEVENLABS_TRANSCRIBE_MODEL', modelDefault: 'scribe_v2' },
  openai:     { fn: transcribeOpenAI,     modelEnv: 'OPENAI_TRANSCRIBE_MODEL',     modelDefault: 'gpt-4o-mini-transcribe' },
  gemini:     { fn: transcribeGemini,     modelEnv: 'GEMINI_TRANSCRIBE_MODEL',     modelDefault: 'gemini-3.1-flash-lite-preview' },
};

const FALLBACK_ORDER: Record<SttEngine, SttEngine[]> = {
  elevenlabs: ['elevenlabs', 'openai', 'gemini'],
  openai:     ['openai', 'gemini', 'elevenlabs'],
  gemini:     ['gemini', 'openai', 'elevenlabs'],
};

export async function transcribeChunks(chunks: string[]): Promise<TranscribeResult> {
  const preferred = (env('YOUTUBE_SUMMARY2_STT', 'elevenlabs').toLowerCase()) as SttEngine;
  const engines = FALLBACK_ORDER[preferred] || FALLBACK_ORDER.elevenlabs;
  const texts: string[] = [];
  let engineUsed: SttEngine | null = null;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`  STT chunk ${i + 1}/${chunks.length}: ${basename(chunk)}`);
    let text = '';
    const tried: string[] = [];
    for (const engine of engines) {
      tried.push(engine);
      const cfg = ENGINE_MAP[engine];
      const model = env(cfg.modelEnv, cfg.modelDefault);
      try {
        text = await cfg.fn(chunk, 'ko', model);
        if (text.trim()) {
          engineUsed ??= engine;
          break;
        }
      } catch (e: any) {
        console.log(`  ${engine} 실패: ${e.message}`);
      }
    }
    if (!text.trim()) throw new Error(`모든 STT 엔진 실패: ${tried.join(', ')}`);
    texts.push(text.trim());
  }

  const transcript = texts.filter(Boolean).join('\n\n');
  if (!transcript.trim()) throw new Error('STT 전사 결과가 비어 있습니다.');
  console.log(`  STT 완료 (엔진: ${engineUsed})`);
  return { transcript, chunkTexts: texts, engine: engineUsed! };
}
