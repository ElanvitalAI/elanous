// Explainer VO — one voice file per beat plus per-character times; the times drive caption & highlight timing.
// Usage: ELEVENLABS_API_KEY=… bun vo.ts <project>/script.json      (ElevenLabs /with-timestamps — exact word times)
//        bun vo.ts <project>/script.json                            (no key → macOS `say`, times spread evenly — a draft voice)
// Writes source/vo/<key>.mp3 ⊕ <key>.json (alignment ⊕ text hash ⊕ engine). Skips a beat whose hash is unchanged. Never prints the key.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';

const KEY = process.env.ELEVENLABS_API_KEY?.trim();
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

type Alignment = { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };

async function elevenlabs(vo: string): Promise<{ mp3: Buffer; alignment: Alignment }> {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${script.voice.id}/with-timestamps?output_format=mp3_44100_192`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY!, 'content-type': 'application/json' },
    body: JSON.stringify({ text: vo, model_id: script.voice.model, language_code: 'ko' }),
  });
  if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { audio_base64: string; alignment: Alignment };
  return { mp3: Buffer.from(data.audio_base64, 'base64'), alignment: data.alignment };
}

/** Keyless draft voice: macOS `say` → mp3 · character times spread in proportion over the measured length. */
function sayVoice(): string {
  const want = process.env.EXPLAINER_SAY_VOICE;
  if (want) return want;
  const list = spawnSync('say', ['-v', '?'], { encoding: 'utf8' });
  if (list.status !== 0) throw new Error('no ELEVENLABS_API_KEY and `say` is unavailable (macOS only) — set the key via the plugin connector');
  const ko = list.stdout.split('\n').filter((l) => /\bko_KR\b/.test(l)).map((l) => l.split(/\s{2,}|\s+\(/)[0].trim());
  const pick = ko.find((v) => /^Yuna/.test(v)) ?? ko[0];
  if (!pick) throw new Error('no Korean `say` voice installed — System Settings › Accessibility › Spoken Content, or set ELEVENLABS_API_KEY');
  return pick;
}
function say(vo: string, key: string): { mp3: Buffer; alignment: Alignment } {
  const voice = sayVoice();
  const aiff = join(dir, `${key}.tmp.aiff`), mp3 = join(dir, `${key}.tmp.mp3`);
  const r = spawnSync('say', ['-v', voice, '-o', aiff, vo], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`say failed: ${r.stderr.slice(0, 200)}`);
  const f = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', aiff, '-ar', '44100', '-b:a', '192k', mp3], { encoding: 'utf8' });
  if (f.status !== 0) throw new Error(`ffmpeg failed: ${f.stderr.slice(0, 200)}`);
  const p = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp3], { encoding: 'utf8' });
  const dur = Number(p.stdout.trim());
  if (!(dur > 0)) throw new Error('ffprobe could not measure the say output');
  const chars = [...vo];
  const weight = chars.map((c) => (/\s/.test(c) ? 0.3 : /[,.·!?]/.test(c) ? 0.8 : 1));
  const total = weight.reduce((a, b) => a + b, 0);
  const starts: number[] = [], ends: number[] = [];
  let t = 0;
  for (const w of weight) { starts.push(+t.toFixed(3)); t += (w / total) * dur; ends.push(+t.toFixed(3)); }
  const out = readFileSync(mp3);
  rmSync(aiff, { force: true }); rmSync(mp3, { force: true });
  return { mp3: out, alignment: { characters: chars, character_start_times_seconds: starts, character_end_times_seconds: ends } };
}

const engine = KEY ? 'elevenlabs' : 'say';
if (!KEY) console.log('no ELEVENLABS_API_KEY — draft voice with macOS `say` (caption times are estimates)');
for (const { key, vo } of beatKeys(script)) {
  const hash = createHash('sha256').update(`${engine === 'say' ? 'say|' : ''}${script.voice.id}|${script.voice.model}|${vo}`).digest('hex').slice(0, 16);
  const jf = join(dir, `${key}.json`);
  if (existsSync(jf) && JSON.parse(readFileSync(jf, 'utf8')).hash === hash) { console.log(`${key} cached`); continue; }
  const { mp3, alignment } = KEY ? await elevenlabs(vo) : say(vo, key);
  writeFileSync(join(dir, `${key}.mp3`), mp3);
  writeFileSync(jf, JSON.stringify({ hash, engine, vo, alignment }));
  console.log(`${key} ${(alignment.character_end_times_seconds.at(-1) ?? 0).toFixed(2)}s  ${engine}  ${vo}`);
}
