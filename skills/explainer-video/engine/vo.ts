// Explainer VO — one ElevenLabs /with-timestamps call per beat; the alignment drives caption & highlight timing.
// Usage: ELEVENLABS_API_KEY=… bun vo.ts <project>/script.json
// Writes source/vo/<key>.mp3 ⊕ <key>.json (alignment + text hash). Skips a beat whose text hash is unchanged. Never prints the key.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) throw new Error('ELEVENLABS_API_KEY missing — set it from the plugin connector (elanous plugin credentials video-explainer)');
const scriptPath = resolve(process.argv[2] ?? 'script.json');
const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
const dir = join(dirname(scriptPath), 'source', 'vo');
mkdirSync(dir, { recursive: true });

export function beatKeys(s: any): { key: string; vo: string }[] {
  const out: { key: string; vo: string }[] = [];
  s.intro.beats.forEach((b: any, i: number) => out.push({ key: `i-${i}`, vo: b.vo }));
  s.chapters.forEach((c: any, ci: number) => c.beats.forEach((b: any, i: number) => out.push({ key: `c${ci + 1}-${i}`, vo: b.vo })));
  s.outro.beats.forEach((b: any, i: number) => out.push({ key: `o-${i}`, vo: b.vo }));
  return out;
}

for (const { key, vo } of beatKeys(script)) {
  const hash = createHash('sha256').update(`${script.voice.id}|${script.voice.model}|${vo}`).digest('hex').slice(0, 16);
  const jf = join(dir, `${key}.json`);
  if (existsSync(jf) && JSON.parse(readFileSync(jf, 'utf8')).hash === hash) { console.log(`${key} cached`); continue; }
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${script.voice.id}/with-timestamps?output_format=mp3_44100_192`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text: vo, model_id: script.voice.model, language_code: 'ko' }),
  });
  if (!res.ok) throw new Error(`${key}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { audio_base64: string; alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } };
  writeFileSync(join(dir, `${key}.mp3`), Buffer.from(data.audio_base64, 'base64'));
  writeFileSync(jf, JSON.stringify({ hash, vo, alignment: data.alignment }));
  console.log(`${key} ${(data.alignment.character_end_times_seconds.at(-1) ?? 0).toFixed(2)}s  ${vo}`);
}
