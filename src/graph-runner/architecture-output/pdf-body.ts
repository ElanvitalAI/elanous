export function missingPdfBodySections(text: string, sections: readonly string[]): string[] {
  const lines = text.split(/\r?\n/u);
  const headings = new Set([...sections, '목차', '요약', '부록']);
  const isBoundary = (line: string): boolean => headings.has(line.trim()) || /^부록(?:\s|$)|^appendix(?:\s|$)/iu.test(line.trim());
  return sections.filter(section => !lines.some((line, index) => {
    if (line.trim() !== section) return false;
    const next = lines.findIndex((candidate, offset) => offset > index && isBoundary(candidate));
    const body = lines.slice(index + 1, next < 0 ? undefined : next)
      .filter(candidate => !/^\s*(?:\d+|ARCHITECTURE DESIGN \/ \d+)\s*$/iu.test(candidate))
      .join(' ').replace(/\s+/gu, '');
    // A table-of-contents heading followed only by a page number is not body.
    return (body.match(/[\p{L}\p{N}]/gu) ?? []).length >= 20;
  }));
}
