export const INTERNAL_REF_MARKERS = [
  { marker: 'internal-doc-path', pattern: /docs\/(?:marketing|plans|goals|manual|roles|archive|measurements|brand|backlog|harness|system)(?=\/|[\s)\]}>.,;:!?'"`]|$)/g },
  { marker: 'private-pr-number', pattern: /(?:PR #\d{4,}|#\d{5,})/g },
  { marker: 'cut-hash', pattern: /(?:컷|cut) [0-9a-f]{7,40}(?![0-9a-f])/g },
] as const;

export type InternalRefHit = { file: string; line: number; marker: typeof INTERNAL_REF_MARKERS[number]['marker'] };

export function scanPackInternalRefs(files: { path: string; text: string }[]): InternalRefHit[] {
  const hits: InternalRefHit[] = [];
  for (const file of files) {
    for (const [index, line] of file.text.split(/\r?\n/).entries()) {
      for (const { marker, pattern } of INTERNAL_REF_MARKERS) {
        for (const match of line.matchAll(pattern)) {
          if (marker === 'private-pr-number') {
            const start = match.index;
            const end = start + match[0].length;
            if ((start > 0 && /[0-9a-f]/i.test(line[start - 1]!)) ||
                (end < line.length && /[0-9a-f]/i.test(line[end]!)) ||
                /^#[0-9a-f]{6}$/i.test(match[0])) continue;
          }
          hits.push({ file: file.path, line: index + 1, marker });
        }
      }
    }
  }
  return hits;
}
