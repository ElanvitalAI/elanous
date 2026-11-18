// ── Wave 6 · /memory list slash ────────────────────────────────────
//
// Mirrors Gemini's memoryCommand.ts surface — `list` enumerates
// the auto-memory index, `show <name>` prints one entry, `reload`
// re-reads from disk. elanous's memory lives at `memoryRoot()` (src/memory.ts,
// ~/.local/share/elanous/memory) with a top-level `MEMORY.md` index +
// per-entry .md files. (An earlier copy of this module pointed at Claude
// Code's ~/.claude/projects/<cwd>/memory — a different product's store.)

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { memoryRoot } from '../memory.js';

export interface MemorySlashCommandDescriptor {
  name: string;
  aliases: string[];
  description: string;
  render(args: { sub?: string; arg?: string; memoryDir?: string }): string;
}

export function buildMemorySlashCommand(): MemorySlashCommandDescriptor {
  return {
    name: 'memory',
    aliases: ['mem'],
    description:
      'Inspect elanous auto-memory: `/memory list` enumerates entries, `/memory show <name>` prints one.',
    render(args): string {
      const dir = args.memoryDir ?? defaultMemoryDir();
      const sub = (args.sub ?? 'list').toLowerCase();
      switch (sub) {
        case 'list': return listMemory(dir);
        case 'show': return args.arg ? showMemory(dir, args.arg) : 'usage: /memory show <name>';
        case 'reload': return `(reload deferred — auto-memory reads on every recall)`;
        default: return `unknown subcommand "${sub}". Try: list · show · reload`;
      }
    },
  };
}

function defaultMemoryDir(): string {
  return memoryRoot();
}

export function listMemory(dir: string): string {
  if (!existsSync(dir)) {
    return `── /memory list ─────────────────────────────────────────\n(no memory folder yet: ${dir} — it is created as you work)`;
  }
  const entries: string[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
      const path = join(dir, f);
      const st = statSync(path);
      const head = readFileSync(path, 'utf-8').split('\n').slice(0, 6).join('\n');
      const desc = head.match(/description:\s*(.+)/)?.[1] ?? '(no description)';
      const type = head.match(/type:\s*(\w+)/)?.[1] ?? 'unknown';
      entries.push(`  [${type.padEnd(8)}] ${f.replace(/\.md$/, '').padEnd(36)} ${formatBytes(st.size).padStart(8)} · ${desc.slice(0, 60)}`);
    }
  } catch (err) {
    return `── /memory list ─────────────────────────────────────────\n(cannot read: ${(err as Error).message})`;
  }
  const lines: string[] = [];
  lines.push('── /memory list ─────────────────────────────────────────');
  lines.push(`Memory dir: ${dir}`);
  lines.push(`Entries:    ${entries.length}`);
  if (entries.length > 0) {
    lines.push('');
    entries.sort();
    lines.push(...entries);
  } else {
    lines.push('(no memory entries — system populates them as you work)');
  }
  return lines.join('\n');
}

export function showMemory(dir: string, name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
  const path = join(dir, safe.endsWith('.md') ? safe : `${safe}.md`);
  if (!existsSync(path)) {
    return `── /memory show ─────────────────────────────────────────\n(no entry "${name}" — try /memory list)`;
  }
  try {
    const content = readFileSync(path, 'utf-8');
    return `── /memory show ${name} ─────────────────────────────────\n${content}`;
  } catch (err) {
    return `── /memory show ─────────────────────────────────────────\n(cannot read: ${(err as Error).message})`;
  }
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${n}B`;
}
