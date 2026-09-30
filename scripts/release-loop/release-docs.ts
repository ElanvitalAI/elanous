import { debug } from '../../src/debug/log.js';
import type { ReleaseManifest } from '../../src/release-loop/manifest.js';

/** Render public IN lines only; keep private titles and PR numbers out of release notes. */
export function renderReleaseNotes(manifest: ReleaseManifest, version: string): string {
  const sections = [
    { heading: 'Behavior changes', kinds: ['feat', 'fix'] },
    { heading: 'Security', kinds: ['security'] },
  ] as const;
  const lines = [`# ${version}`, ''];
  let shown = 0;
  for (const section of sections) {
    const entries = manifest.in.filter((entry) => section.kinds.some((kind) => kind === entry.kind) && entry.line);
    if (!entries.length) continue;
    lines.push(`## ${section.heading}`, '');
    for (const entry of entries) {
      lines.push(`- ${entry.line!.replace(/\r?\n/g, ' ').trim()}`);
      shown++;
    }
    lines.push('');
  }
  const omitted = manifest.in.length - shown;
  if (omitted) lines.push(`Plus ${omitted} internal ${omitted === 1 ? 'change' : 'changes'}.`);
  debug.log('release-loop.docs', 'notes-rendered', { version, shown, omitted });
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Mark only the public-doc status indicator, leaving unfinished/design annotations untouched. */
export function flipNextReleaseMarkers(text: string, version: string): string {
  return text.replace(/🟡 on main(?: — next release|, in the next release)?/g, `✅ in v${version.replace(/^v/, '')}`);
}

/**
 * Fold notes that landed before the release loop (a PR appending its own line, a headline paragraph)
 * into the rendered notes instead of refusing or overwriting them. Paragraphs before any section stay
 * under the title (the headline slot); list lines the cutoff did not render keep their own `##` section
 * (lines outside any section go to «Also in this release»). A hand-written link cannot be identified
 * as generator output from its shape alone. Folding its own output again gives the same bytes.
 */
export function foldPreLandedNotes(existing: string, rendered: string): { text: string; folded: number } {
  const key = (line: string) => line.trim().replace(/\s*\(\[#\d+\]\([^)]*\)\)\s*$/, '').trim();
  // Rendered list keys per section — a pre-landed line is «already rendered» only within the same heading
  // (or anywhere, when it sits outside any section).
  const renderedBySection = new Map<string, Set<string>>();
  const renderedAll = new Set<string>();
  { let h = ''; for (const l of rendered.split(/\r?\n/)) { const t = l.trim(); if (/^##\s/.test(t)) { h = t; continue; } if (/^[-*]\s/.test(t)) { renderedAll.add(key(t)); const set = renderedBySection.get(h) ?? new Set<string>(); set.add(key(t)); renderedBySection.set(h, set); } } }
  const alreadyRendered = (line: string, section: string | null) => section === null ? renderedAll.has(key(line)) : (renderedBySection.get(section)?.has(key(line)) ?? false);
  const paragraphs: string[] = [];
  const sections = new Map<string, string[]>();
  const [title, ...rest] = rendered.trimEnd().split('\n');
  const footer = rest.find((line) => /^Plus \d+ internal changes?\.$/.test(line));
  const DEFAULT = '## Also in this release';
  let heading: string | null = null;
  for (const raw of existing.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (/^#\s/.test(trimmed) || /^Plus \d+ internal changes?\.$/.test(trimmed)) continue;
    if (!trimmed) {
      // Keep paragraph breaks (collapse runs of blank lines to one) in the headline block and in sections.
      if (heading === null) { if (paragraphs.length && paragraphs.at(-1) !== '') paragraphs.push(''); }
      else { const list = sections.get(heading)!; if (list.length && list.at(-1) !== '') list.push(''); }
      continue;
    }
    if (/^##\s/.test(trimmed)) { heading = trimmed; if (!sections.has(heading)) sections.set(heading, []); continue; }
    if (/^[-*]\s/.test(trimmed)) {
      if (alreadyRendered(trimmed, heading)) continue;
      const target = heading ?? DEFAULT;
      const list = sections.get(target) ?? [];
      if (!list.some((item) => key(item) === key(trimmed))) list.push(trimmed);
      sections.set(target, list);
    } else if (heading === null) {
      paragraphs.push(line);
    } else {
      // Prose under a section keeps its section.
      const list = sections.get(heading) ?? [];
      list.push(line);
      sections.set(heading, list);
    }
  }
  // Rendered notes = title ⊕ ordered `##` sections. A pre-landed section with the same heading merges into it.
  const renderedSections: Array<{ heading: string; lines: string[] }> = [];
  for (const line of rest) {
    if (line === footer) continue;
    if (/^##\s/.test(line.trim())) renderedSections.push({ heading: line.trim(), lines: [] });
    else if (renderedSections.length && line.trim()) renderedSections.at(-1)!.lines.push(line);
  }
  let folded = paragraphs.filter(Boolean).length;
  for (const lines of sections.values()) while (lines.at(-1) === '') lines.pop();
  for (const section of renderedSections) {
    const extra = sections.get(section.heading);
    if (!extra) continue;
    while (extra[0] === '') extra.shift();
    // A paragraph must not glue onto the rendered list above it — keep one blank line between.
    if (extra.length && !/^[-*]\s/.test(extra[0]!.trim()) && section.lines.length) section.lines.push('');
    section.lines.push(...extra);
    folded += extra.length;
    sections.delete(section.heading);
  }
  const parts = [title!, ''];
  while (paragraphs.at(-1) === '') paragraphs.pop();
  if (paragraphs.length) parts.push(paragraphs.join('\n'), '');
  for (const section of renderedSections) parts.push(section.heading, '', ...section.lines, '');
  for (const [name, lines] of sections) {
    parts.push(name, '', ...lines, '');
    folded += Math.max(lines.filter(Boolean).length, 1);
  }
  if (footer) parts.push(footer);
  return { text: `${parts.join('\n').trimEnd()}\n`, folded };
}
