// Deterministic merge for `release/next.md` — two landings that each append a line to the same section
// keep both lines (union per section, same sentence once). Returns null when it cannot decide (the caller
// falls back to its usual resolver): a side deleted a line, or a stage is missing.

export const NEXT_MD_PATH = 'release/next.md';

type Section = { header: string | null; lines: string[] };

function sections(text: string): Section[] {
  const out: Section[] = [{ header: null, lines: [] }];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^## /.test(line)) out.push({ header: line.trim(), lines: [] });
    else out[out.length - 1]!.lines.push(line);
  }
  return out;
}

const key = (line: string) => line.trim();

function added(base: Section | undefined, side: Section): string[] {
  const before = new Set((base?.lines ?? []).map(key));
  return side.lines.filter((line) => key(line) !== '' && !before.has(key(line)));
}

function deletedAny(base: Section[], side: Section[]): boolean {
  for (const b of base) {
    const s = side.find((x) => x.header === b.header);
    const kept = new Set((s?.lines ?? []).map(key));
    if (b.lines.some((line) => key(line) !== '' && !kept.has(key(line)))) return true;
  }
  return false;
}

/** Union of both sides' additions over `theirs` (the branch being merged in). Null = not decidable here. */
export function resolveNextMdConflict(base: string, ours: string, theirs: string): string | null {
  const b = sections(base);
  const o = sections(ours);
  // Our side only appends (harness landings add one line); a deletion on our side is not ours to decide.
  if (deletedAny(b, o)) return null;
  const result = sections(theirs);
  for (const section of o) {
    const extra = added(b.find((x) => x.header === section.header), section);
    if (extra.length === 0) continue;
    let target = result.find((x) => x.header === section.header);
    if (!target) {
      target = { header: section.header, lines: [''] };
      result.push(target);
    }
    const present = new Set(target.lines.map(key));
    const fresh = extra.filter((line) => !present.has(key(line)));
    if (fresh.length === 0) continue;
    // Insert before the section's trailing blank lines so the blank separator stays last.
    let end = target.lines.length;
    while (end > 0 && key(target.lines[end - 1]!) === '') end -= 1;
    target.lines.splice(end, 0, ...fresh);
  }
  return result.map((section) => (section.header === null ? section.lines : [section.header, ...section.lines]).join('\n')).join('\n');
}
