import { readFileSync, writeFileSync } from 'node:fs';
import { hwpxToMarkdown, markdownToHwpx } from './converter.js';

export function main(args: string[]): void {
  const [command, input, output] = args;
  if (!input || !output || !['to-md', 'from-md'].includes(command ?? '')) {
    throw new Error('Usage: bun plugins/elanous-hwp/cli.ts to-md input.hwpx output.md | from-md input.md output.hwpx');
  }
  if (/\.hwp$/i.test(input) || /\.hwp$/i.test(output)) throw new Error('HWP(옛 바이너리)는 지원 안 함 · hwpx 로 저장해 달라');
  if (command === 'to-md') {
    if (!/\.hwpx$/i.test(input) || !/\.md$/i.test(output)) throw new Error('Expected .hwpx input and .md output');
    writeFileSync(output, hwpxToMarkdown(readFileSync(input), input), { flag: 'wx' });
  } else {
    if (!/\.md$/i.test(input) || !/\.hwpx$/i.test(output)) throw new Error('Expected .md input and .hwpx output');
    writeFileSync(output, markdownToHwpx(readFileSync(input, 'utf8')), { flag: 'wx' });
  }
}

if (import.meta.main) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
