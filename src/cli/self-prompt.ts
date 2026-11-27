import type { Command } from 'commander';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildUniversalPreamble, loadProjectAnchorWithMeta, projectAnchorManifest } from '../prompt-library/universal-preamble.js';

/** Resolve a seat directory, never interpreting the seat as a filesystem path. */
export function selfPromptSeatDirectory(seat: string, root = join(homedir(), 'elanous-hq', 'seats')): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(seat)) throw new Error(`Invalid seat: ${seat}`);
  const dir = join(root, seat);
  try { if (statSync(dir).isDirectory()) return dir; } catch { /* reported below */ }
  throw new Error(`Seat directory not found: ${seat}`);
}

/** A reproducible default-context preview, not a claim about an existing session's exact prompt. */
export function selfPromptPreview(cwd: string): { prompt: string; bytes: number; sections: Array<{ title: string; bytes: number }> } {
  const prompt = buildUniversalPreamble({ cwd }).map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n\n');
  const headings = [...prompt.matchAll(/^#{1,6}\s+(.+)$/gm)];
  const sections = headings.map((heading, index) => ({
    title: heading[1]!.trim(),
    bytes: Buffer.byteLength(prompt.slice(heading.index!, headings[index + 1]?.index ?? prompt.length)),
  }));
  return { prompt, bytes: Buffer.byteLength(prompt), sections };
}

export function registerSelfPromptCommand(self: Command): void {
  self.command('prompt').description('Preview the default-context universal prompt and its section sizes')
    .option('--raw', 'print the prompt only')
    .option('--seat <seat>', 'preview the seat directory instead of the current directory')
    .action((options: { raw?: boolean; seat?: string }) => {
      const cwd = options.seat ? selfPromptSeatDirectory(options.seat) : process.cwd();
      const preview = selfPromptPreview(cwd);
      if (options.raw) process.stdout.write(preview.prompt);
      else console.log(JSON.stringify({ cwd, bytes: preview.bytes, sections: preview.sections, anchor: projectAnchorManifest(loadProjectAnchorWithMeta(cwd)) }, null, 2));
    });
}
