export type MustFixVerdict = 'resolved' | 'unresolved' | 'unknown';

/** Match only named evidence in a PR's final patch, never an earlier review round. */
export function matchMustFix(mustFix: string, finalDiff: string): MustFixVerdict {
  const names = [...mustFix.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!.trim()).filter(Boolean);
  if (!names.length) return 'unknown';
  const files = [...finalDiff.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map((match) => ({
    path: match[2]!, start: match.index!,
  }));
  if (!files.length) return 'unresolved';
  const fileNames = names.filter((name) => /\.(?:[a-z][a-z0-9]*)$/i.test(name) && !name.includes('('));
  const target = names.find((name) => !fileNames.includes(name) && name.endsWith('()'))
    ?? names.find((name) => !fileNames.includes(name));
  if (!fileNames.length && !target) return 'unknown';
  const symbol = target?.replace(/\(\)$/, '');
  const boundary = symbol ? new RegExp(`(^|[^\\w$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`) : null;
  // Review transport adds a must-fix label; it does not change the request.
  const request = mustFix.replace(/^\s*must[-\s]?fix\s*:\s*/i, '').trim();
  const touchOnly = /^`[^`\n]+`\s*(?:을|를)\s*확인해\s*주세요\.?$/.test(request);
  for (const [index, file] of files.entries()) {
    if (fileNames.length && !fileNames.some((name) => file.path === name || file.path.endsWith(`/${name}`))) continue;
    const patch = finalDiff.slice(file.start, files[index + 1]?.start ?? finalDiff.length);
    for (const hunk of patch.split(/(?=^@@ )/m).slice(1)) {
      const changes = hunk.split('\n').filter((line) => /^[+-](?![+-])/.test(line));
      if (!changes.length) continue;
      const changedSymbol = !boundary || changes.some((line) => boundary.test(line));
      if (!changedSymbol && boundary && !boundary.test(hunk.split('\n', 1)[0] ?? '')) continue;
      if (touchOnly) {
        if (changedSymbol) return 'resolved';
        continue;
      }
      if (!changedSymbol && !changes.some((line) => /\b(?:markStopped|unlinkSync|rmSync)\b/.test(line))) continue;
      return 'unknown';
    }
  }
  return 'unresolved';
}
