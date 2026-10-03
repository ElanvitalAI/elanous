#!/usr/bin/env bun
// 스토리보드 정본 검사 ⊕ MD 생성. 기존 bun scripts/storyboard/storyboard.ts lint|render 지원.
import { runStoryboard } from '../../src/cli/storyboard-cli.js';
export { lint, render } from '../../src/storyboard/storyboard.js';
export type { Storyboard } from '../../src/storyboard/storyboard.js';

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== 'lint' && cmd !== 'render') { console.error('usage: storyboard.ts lint|render [files…]'); process.exit(2); }
  process.exitCode = runStoryboard(cmd, rest);
}
