import { homedir } from 'node:os';
import { join } from 'node:path';
import { searchVflowReferences, type VflowQuery } from '../src/video-pipeline/vflow-reference.js';

const args = process.argv.slice(2);
let file = join(homedir(), 'docs', 'ref', 'vflow', 'prompts.ndjson');
const query: { -readonly [K in keyof VflowQuery]: VflowQuery[K] } = { limit: 5 };
let json = false;
const techniques: string[] = [];
const terms: string[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === '--json') { json = true; continue; }
  if (['--file', '--model', '--technique', '--category', '--limit', '--camera', '--lighting', '--mood', '--max-seconds'].includes(arg)) {
    const value = args[++i];
    if (!value || value.startsWith('--')) {
      console.error(`값이 필요한 옵션: ${arg}`);
      process.exit(1);
    }
    switch (arg) {
      case '--file': file = value; break;
      case '--model': query.model = value; break;
      case '--technique': techniques.push(value); break;
      case '--category': query.category = value; break;
      case '--camera': query.camera = value; break;
      case '--lighting': query.lighting = value; break;
      case '--mood': query.mood = value; break;
      case '--limit': {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 0) {
          console.error(`--limit 은 0 이상의 정수여야 합니다: ${value}`);
          process.exit(1);
        }
        query.limit = parsed;
        break;
      }
      case '--max-seconds': {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0 || !value.trim()) {
          console.error(`--max-seconds 은 0 이상의 숫자여야 합니다: ${value}`);
          process.exit(1);
        }
        query.maxSeconds = parsed;
        break;
      }
    }
  } else if (arg.startsWith('--')) {
    console.error(`알 수 없는 옵션: ${arg}`);
    process.exit(1);
  } else {
    terms.push(arg);
  }
}
query.terms = terms;
query.techniques = techniques;
const result = searchVflowReferences(file, query);
if (!result.available) {
  console.error(`입력 파일을 읽을 수 없습니다: ${file} (${result.reason})`);
  process.exit(1);
}
if (json) {
  console.log(JSON.stringify(result.rows.map(({ url, model, category, name, prompt, keywords, author, authorUrl, video }) =>
    ({ url, model, category, name, prompt, keywords, author, authorUrl, video: video ?? null }))));
  if (result.matches === 0) console.error(`일치 0 · 읽은 줄 ${result.read}`);
} else if (result.matches === 0) {
  console.log(`일치 0 · 읽은 줄 ${result.read}`);
} else {
  for (const row of result.rows) {
    console.log(`${row.name} · ${row.model}\n${row.url}\n${row.author ?? ''}\n${row.prompt.slice(0, 240)}${row.video?.url ? `\n${row.video.url}` : ''}`);
  }
}
if (result.skipped) console.error(`건너뛴 줄 ${result.skipped}`);
