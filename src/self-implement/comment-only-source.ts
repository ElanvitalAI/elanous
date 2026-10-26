import ts from 'typescript';

/** Exclude importer expansion only when non-comment bytes and comment boundaries
 * are identical. The TypeScript parser finds comments within JSDoc that a bare
 * scanner can misread because their prose contains backticks. */
export function isCommentOnlySourceChange(before: string, after: string, path: string): boolean {
  if (before === after || !/\.(?:[cm]?[jt]sx?)$/.test(path)) return false;
  const kind = /\.(?:[cm]?[jt]sx)$/.test(path) ? ts.ScriptKind.TSX
    : /\.(?:[cm]?js)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const collect = (source: string): { masked: string; comments: string[] } | null => {
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
    if (file.parseDiagnostics.length) return null;
    const ranges = new Map<number, ts.CommentRange>();
    const add = (found: ts.CommentRange[] | undefined) => {
      for (const range of found ?? []) ranges.set(range.pos, range);
    };
    const visit = (node: ts.Node) => {
      add(ts.getLeadingCommentRanges(source, node.getFullStart()));
      add(ts.getTrailingCommentRanges(source, node.getEnd()));
      ts.forEachChild(node, visit);
    };
    visit(file);
    const comments: string[] = [];
    let masked = '';
    let end = 0;
    for (const range of [...ranges.values()].sort((left, right) => left.pos - right.pos)) {
      if (range.pos < end) return null;
      const comment = source.slice(range.pos, range.end);
      comments.push(comment);
      masked += source.slice(end, range.pos) + `\u0000C${range.kind}:${comment.match(/\r\n|\r|\n/g)?.join('') ?? ''}\u0000`;
      end = range.end;
    }
    return { masked: masked + source.slice(end), comments };
  };
  const old = collect(before);
  const current = collect(after);
  if (!old || !current || old.masked !== current.masked || old.comments.length !== current.comments.length) return false;
  const directive = /^(?:\/\/\/|\/\/[#@])|@|(?:eslint|istanbul|coverage|#__PURE__|__NO_SIDE_EFFECTS__)/i;
  // Any unquoted @ may be a TypeScript/JSDoc tag, including newly introduced ones.
  // A backticked example username such as `@example_bot` is prose, not a tag.
  const semanticText = (comment: string) => comment.trim().replace(/`[^`\r\n]*`/g, '');
  let changed = false;
  for (let index = 0; index < old.comments.length; index++) {
    const prior = old.comments[index]!;
    const next = current.comments[index]!;
    if (prior === next) continue;
    changed = true;
    // Ordinary inline block comments and line comments stay in the importer set.
    // This exemption is intentionally limited to JSDoc prose edits.
    if (!prior.startsWith('/**') || !next.startsWith('/**')) return false;
    if (directive.test(semanticText(prior)) || directive.test(semanticText(next))) return false;
  }
  return changed;
}
