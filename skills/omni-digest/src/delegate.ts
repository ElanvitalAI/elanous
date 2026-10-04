/** Delegate to youtube-master only (X is now absorbed). Use a process, not a cross-skill import: each skill can ship alone. */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { SKILL_DIR } from './env.js';
import type { SummaryFormat, OutputTarget, FORMAT_TO_SUBSKILL } from './types.js';

const FMT: Record<SummaryFormat, string> = { essential: 'brief', rich: 'detailed', 'rich-cards': 'cards' };

function targetFor(targets: OutputTarget[]): string {
  if (targets.includes('obsidian')) return 'obsidian';
  const m: Record<string, string> = { web: 'web-html', 'web-deploy': 'web-deploy', pdf: 'pdf', markdown: 'markdown' };
  return m[targets[0]] || 'obsidian';
}

export interface DelegateResult { markdown: string; fullOutput: string; savedPath: string | null; }

export function delegateYouTube(url: string, format: SummaryFormat, targets: OutputTarget[], message?: string): DelegateResult {
  const script = resolve(SKILL_DIR, '..', 'youtube-master', 'scripts', 'main.ts');
  const args = [script, url, '--format', FMT[format], '--target', targetFor(targets), '--print'];
  if (message) args.push('--message', message);
  console.log(`  [delegate] youtube-master: format=${FMT[format]}, target=${targetFor(targets)}`);
  const output = execFileSync(process.execPath, args, {
    encoding: 'utf-8', timeout: 300_000, maxBuffer: 10 * 1024 * 1024,
    cwd: resolve(SKILL_DIR, '..', 'youtube-master'),
  });
  const begin = '---BEGIN_YOUTUBE_MASTER_MARKDOWN---';
  const end = '---END_YOUTUBE_MASTER_MARKDOWN---';
  let md = '';
  const bi = output.indexOf(begin), ei = output.indexOf(end);
  if (bi !== -1 && ei !== -1) md = output.slice(bi + begin.length, ei).trim();
  const sp = output.match(/저장 완료:\s*(.+)/);
  return { markdown: md, fullOutput: output, savedPath: sp ? sp[1].trim() : null };
}
