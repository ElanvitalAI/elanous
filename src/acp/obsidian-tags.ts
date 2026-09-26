// PLAN-ipad-notes-obsidian-typora §5 Phase O3·2 (2026-05-17) —
// Vault tag aggregate via ripgrep + frontmatter parser.
//
// Scans every `.md` file under the vault for Obsidian tag syntax and
// returns one record per unique tag with:
//   - the tag string (without leading `#`)
//   - the count of occurrences across the whole vault
//   - sample files that use the tag (capped per tag · for previewability)
//
// Two tag forms are recognised:
//   1. Inline `#tag` anywhere in the body (Obsidian convention · skip
//      headings — `## Heading` is NOT a tag).
//   2. Frontmatter `tags: [foo, bar]` or `tags:\n  - foo\n  - bar`.
//      Added C5 (2026-05-17) — walks the vault again with readFile +
//      a small inline YAML parser that handles the two `tags:` forms
//      Obsidian writes. Doesn't pull in a full YAML lib (the rest of
//      the daemon doesn't need it; iOS side handles YAML for the
//      Properties pane).

import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface TagEntry {
  /** Tag name without leading `#` (e.g. `q4-planning`). */
  tag: string;
  /** Total occurrences across the vault. */
  count: number;
  /** Sample paths that mention the tag (vault-relative, cap = 5). */
  samplePaths: string[];
}

export interface TagsResult {
  tags: TagEntry[];
  error?: string;
}

export interface FindTagsOpts {
  vaultRoot: string;
  /** Cap on the number of distinct tags returned. Default 200. */
  limit?: number;
  /** Test seam — override the rg binary path. */
  rgBin?: string;
}

/**
 * Obsidian inline tag pattern:
 *   - starts with `#`
 *   - followed by 1+ tag chars: letters, digits, `_`, `-`, `/` (nested)
 *   - NOT preceded by another tag char (so `##Heading` doesn't match)
 *   - NOT immediately followed by another `#` (so `#### Heading` doesn't
 *     accidentally match the trailing tag chars of a heading)
 *
 * rg uses Rust regex which supports look-behind only when fixed-width,
 * which `(?<![A-Za-z0-9_/])` is — so we can use it here. The pattern
 * also excludes a leading `#` immediately before our `#` to keep
 * headings out (regex starts with `(?<![A-Za-z0-9_/#])`).
 */
// 문자는 유니코드(\p{L}) — 한글 태그 `#시험`·`#AI요약` 을 영문만 보던 옛 패턴이 조용히 버렸다(2026-09-26 격리 PWA 실측).
// rg(Rust regex)는 \p{} 를 그대로 받는다 · JS 에서 쓸 땐 `u` 플래그가 필요하다.
export const TAG_PATTERN = String.raw`(?<![\p{L}\p{N}_/#])#\p{L}[\p{L}\p{N}_/-]*`;
const TAG_BODY = /^\p{L}[\p{L}\p{N}_/-]*$/u;

/**
 * Skip strings that aren't really tags even after pattern match:
 *   - pure numbers like `#1` would be filtered by pattern (must start
 *     with letter), but defensive double-check stays cheap
 *   - tags that look like markdown anchors (`#section-name` in a link)
 *     — these are valid tags syntactically; Obsidian itself counts them
 *     unless inside `[...](...)` brackets. MVP cut keeps them in.
 */
function isValidTag(tag: string): boolean {
  if (tag.length < 2) return false;
  // Trim a trailing slash (`#foo/` → `foo` — Obsidian normalises away
  // the dangling separator).
  return TAG_BODY.test(tag);
}

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.obsidian', '.trash']);

/** C5 (2026-05-17) — extract `tags:` values from a YAML frontmatter
 *  block at the top of `content`. Handles the two shapes Obsidian
 *  writes:
 *
 *  ```yaml
 *  ---
 *  tags: [foo, bar, baz]
 *  ---
 *  ```
 *
 *  ```yaml
 *  ---
 *  tags:
 *    - foo
 *    - bar
 *  ---
 *  ```
 *
 *  Returns the list of tag strings (without leading `#`). Empty when
 *  no frontmatter block, no `tags:` key, or unparseable. Exposed for
 *  unit testing the parser in isolation. */
export function extractFrontmatterTags(content: string): string[] {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return [];
  const lines = content.split(/\r?\n/);
  // Find the closing `---` (skip the first one at index 0).
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { endIdx = i; break; }
  }
  if (endIdx < 0) return [];
  // Walk frontmatter lines, find `tags:` (case-insensitive).
  const tags: string[] = [];
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i]!;
    const m = /^tags:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const inline = m[1]!.trim();
    if (inline.startsWith('[') && inline.endsWith(']')) {
      // Inline-array form. Split by comma, strip quotes + whitespace.
      const inner = inline.slice(1, -1);
      for (const raw of inner.split(',')) {
        const t = raw.trim().replace(/^['"]|['"]$/g, '');
        if (t.length > 0) tags.push(t);
      }
    } else if (inline.length > 0) {
      // Single-value form: `tags: foo`
      const t = inline.replace(/^['"]|['"]$/g, '');
      if (t.length > 0) tags.push(t);
    } else {
      // Block list form. Collect subsequent `  - foo` lines until
      // the next non-indented key (or frontmatter end).
      for (let j = i + 1; j < endIdx; j++) {
        const subLine = lines[j]!;
        const sub = /^\s+-\s+(.+?)\s*$/.exec(subLine);
        if (sub && sub[1]) {
          tags.push(sub[1].replace(/^['"]|['"]$/g, ''));
        } else {
          // Indented blank lines OK; otherwise break.
          if (/^\s+$/.test(subLine)) continue;
          if (/^\S/.test(subLine)) break;
        }
      }
    }
    // Only consider the first `tags:` occurrence — subsequent are
    // unusual frontmatter shapes and the spec doesn't define merge.
    break;
  }
  return tags.filter(t => TAG_BODY.test(t));
}

/** C5 — walk the vault, read each .md file's frontmatter, populate
 *  the same {tag → count + samples} aggregator the rg pass uses.
 *  Async readFile + readdir; per-file failures skipped silently. */
async function walkFrontmatterTags(
  vaultRoot: string,
  agg: Map<string, { count: number; samples: Set<string> }>,
  samplePerTag: number,
): Promise<void> {
  async function walk(dir: string, relPrefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      if (relPrefix === '') throw new Error('vault-unreadable');
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIR_NAMES.has(e.name)) continue;
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(join(dir, e.name), rel);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        let content = '';
        try {
          content = await readFile(join(dir, e.name), 'utf8');
        } catch {
          continue; // unreadable file → skip
        }
        const fmTags = extractFrontmatterTags(content);
        for (const tag of fmTags) {
          const slot = agg.get(tag) ?? { count: 0, samples: new Set<string>() };
          slot.count += 1;
          if (slot.samples.size < samplePerTag) slot.samples.add(rel);
          agg.set(tag, slot);
        }
      }
    }
  }
  await walk(vaultRoot, '');
}

export async function findTags(opts: FindTagsOpts): Promise<TagsResult> {
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 200;
  const rgBin = opts.rgBin ?? 'rg';
  const samplePerTag = 5;

  return await new Promise<TagsResult>((resolve) => {
    // `--pcre2` enables fixed-width lookbehind which the default rg
    // regex engine (Rust regex) refuses. PCRE2 is bundled with ripgrep
    // since v11.0 (2019); a missing PCRE2 build fails with a clear
    // "PCRE2 support is not enabled" error which the rg-spawn/exit-N
    // handlers surface unchanged.
    const rg = spawn(rgBin, [
      '--pcre2',
      '--json',
      '--line-number',
      '--type-add', 'md:*.md',
      '--type', 'md',
      '-e', TAG_PATTERN,
      opts.vaultRoot,
    ]);
    const stdoutChunks: Buffer[] = [];
    let stderr = '';
    rg.stdout.on('data', (data: Buffer) => stdoutChunks.push(data));
    rg.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    rg.on('error', (err: Error) => {
      resolve({ tags: [], error: `rg-spawn: ${err.message}` });
    });
    rg.on('close', async (code: number | null) => {
      if (code !== 0 && code !== 1) {
        resolve({ tags: [], error: `rg-exit-${code}: ${stderr.slice(0, 200)}` });
        return;
      }
      const output = Buffer.concat(stdoutChunks).toString('utf8');
      // Aggregate: tag → { count, sampleSet (capped) }
      const agg = new Map<string, { count: number; samples: Set<string> }>();
      for (const line of output.split('\n')) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type !== 'match') continue;
          const data = evt.data;
          const filePath: string = data?.path?.text ?? '';
          // Inspect submatches (rg --json emits per-match offsets)
          const submatches: Array<{ match: { text?: string } }> = data?.submatches ?? [];
          const relPath = filePath.startsWith(opts.vaultRoot + '/')
            ? filePath.slice(opts.vaultRoot.length + 1)
            : filePath;
          for (const sub of submatches) {
            const raw = sub?.match?.text ?? '';
            if (!raw.startsWith('#')) continue;
            // Strip leading `#`. Also handle a trailing `/` (`#foo/` → `foo`).
            let tag = raw.slice(1);
            tag = tag.replace(/\/$/, '');
            if (!isValidTag(tag)) continue;
            const slot = agg.get(tag) ?? { count: 0, samples: new Set<string>() };
            slot.count += 1;
            if (slot.samples.size < samplePerTag) slot.samples.add(relPath);
            agg.set(tag, slot);
          }
        } catch {
          // Skip malformed JSON lines.
        }
      }
      // C5 (2026-05-17) — additionally walk the vault for frontmatter
      // `tags:` arrays so notes that prefer YAML over inline `#tag`
      // syntax still surface in the aggregate. Per-file failures
      // skipped silently inside walkFrontmatterTags.
      try {
        await walkFrontmatterTags(opts.vaultRoot, agg, samplePerTag);
      } catch (err) {
        // Vault-level read error — surface as soft error so the rg-only
        // result still ships, with the frontmatter gap noted.
        const entries: TagEntry[] = [];
        for (const [tag, slot] of agg.entries()) {
          entries.push({
            tag,
            count: slot.count,
            samplePaths: Array.from(slot.samples).sort(),
          });
        }
        entries.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
        resolve({
          tags: entries.slice(0, limit),
          error: `frontmatter-walk: ${(err as Error).message ?? String(err)}`,
        });
        return;
      }
      const entries: TagEntry[] = [];
      for (const [tag, slot] of agg.entries()) {
        entries.push({
          tag,
          count: slot.count,
          samplePaths: Array.from(slot.samples).sort(),
        });
      }
      // Sort by count desc, then tag asc — top-N gives the most-used
      // tags first which is what the side pane wants to render.
      entries.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
      resolve({ tags: entries.slice(0, limit) });
    });
  });
}
