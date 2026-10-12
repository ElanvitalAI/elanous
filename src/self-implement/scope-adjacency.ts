// SCOPE-HELD-DELIVER (0.2.25) — which out-of-scope edits sit right next to a declared target.
// 10-11~12: 34 scope-held runs auto-answered «Stay in scope» after 30 unanswered minutes and threw away finished work;
// the outside files were a declared file's same-folder neighbours (its other tests, a sibling helper, the folder's
// plugin.json). Those are adjacent: the run goes on to its gate instead of parking on a question nobody answers.

const normalize = (path: string): string => path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
const dirOf = (path: string): string => { const at = path.lastIndexOf('/'); return at < 0 ? '' : path.slice(0, at); };

/** Split out-of-scope files into those adjacent to a declared target and the rest. A file is adjacent when it sits in
 *  the same folder as a declared file. A declared folder adds nothing (its contents are already in scope), and a
 *  declared repo-root file adds nothing (the root holds the whole repo's config). */
export function classifyOutOfScope(outsideFiles: readonly string[], declaredPaths: readonly string[]): { adjacent: string[]; other: string[] } {
  const folders = new Set<string>();
  for (const declared of declaredPaths.map(normalize)) {
    const dir = dirOf(declared);
    // A path with an extension names a file; without one it names a folder.
    if (dir && /\.[A-Za-z0-9]+$/.test(declared.slice(dir.length + 1))) folders.add(dir);
  }
  const adjacent: string[] = [];
  const other: string[] = [];
  for (const file of outsideFiles) (folders.has(dirOf(normalize(file))) ? adjacent : other).push(file);
  return { adjacent, other };
}
