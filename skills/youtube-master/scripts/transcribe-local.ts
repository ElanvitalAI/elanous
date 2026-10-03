import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initEnv } from '../src/env.js';
import { transcribeChunks } from '../src/stt.js';

initEnv();

const chunksDir = process.argv[2];
const outFile = process.argv[3];
if (!chunksDir || !outFile) {
  console.error('usage: tsx transcribe-local.ts <chunksDir> <outFile>');
  process.exit(1);
}

const files = (await readdir(chunksDir))
  .filter(f => f.startsWith('chunk_') && f.endsWith('.mp3'))
  .sort()
  .map(f => join(chunksDir, f));

console.log(`Transcribing ${files.length} chunks...`);
const result = await transcribeChunks(files);
await writeFile(outFile, result.transcript, 'utf-8');
console.log(`\nDONE. engine=${result.engine}, chars=${result.transcript.length}`);
console.log(`Saved to ${outFile}`);
