/** A goal names the simulator proof it intends to rely on; a bare test command is not a scenario name. */
export function simulationProofFromGoal(text: string): string | undefined {
  const device = /^[ \t]*신설 장치:[ \t]*(.+?)[ \t]*$/im.exec(text)?.[1]?.trim().replace(/^['"`]|['"`]$/g, '').trim();
  if (device && !/^(?:없음|미정|TBD|TODO)$/i.test(device)) return `신설 장치: ${device}`;
  const match = /^[ \t]*(?:증명 시나리오|시뮬레이션 증명):[ \t]*(.+?)[ \t]*$/im.exec(text);
  const value = match?.[1]?.trim().replace(/^['"`]|['"`]$/g, '').trim();
  return value && !/^(?:없음|미정|TBD|TODO)$/i.test(value) ? value : undefined;
}

export function hasCodeTarget(paths: readonly string[]): boolean {
  return paths.some((path) => {
    const normalized = normalizeTarget(path);
    const directory = normalized === '.' || !/[.][^/]+$/.test(normalized);
    return !/(?:^|\/)(?:test|tests|__tests__|__mocks__)(?:\/|$)/i.test(normalized)
      && !/(?:\.test|\.spec)\.[cm]?[jt]sx?$/i.test(normalized)
      && !/^(?:docs?|documentation)(?:\/|$)/i.test(normalized)
      && (directory || /\.(?:[cm]?[jt]sx?|py|swift|go|rs|c|h|cc|cpp|cxx|java|kt|kts|rb|php|sh|bash|zsh|fish|sql|html|css|vue|svelte|ya?ml|json|toml)$/i.test(normalized));
  });
}

export function goalTargetPaths(text: string, trackedPaths: readonly string[]): string[] {
  const declared = declaredGoalTargetPaths(text);
  const targets = declared.length
    ? declared.flatMap((target) => {
      const normalized = normalizeTarget(target);
      if (normalized === '.') return trackedPaths.filter((path) => hasCodeTarget([path]));
      return trackedPaths.includes(normalized) ? [normalized]
        : trackedPaths.filter((path) => path.startsWith(`${normalized}/`) && hasCodeTarget([path]));
    })
    : trackedPaths.filter((path) => text.includes(path));
  return [...new Set(targets.filter((path) => trackedPaths.includes(path)))].sort();
}

export function declaredGoalTargetPaths(text: string): string[] {
  return [...new Set([...text.matchAll(/^[ \t]*대상 경로:[ \t]*(.+?)[ \t]*$/gim)]
    .flatMap((match) => match[1]!.split(/[·,，]/).map((path) => path.trim().replace(/^['"`]|['"`]$/g, '')))
    .filter(Boolean))];
}

export function unresolvedGoalTargets(text: string, trackedPaths: readonly string[]): string[] {
  return declaredGoalTargetPaths(text).filter((path) => {
    const normalized = normalizeTarget(path);
    if (normalized === '.') return trackedPaths.length === 0;
    return !trackedPaths.includes(normalized) && !trackedPaths.some((tracked) => tracked.startsWith(`${normalized}/`));
  }).sort();
}

function normalizeTarget(path: string): string {
  const normalized = path.trim().replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  return normalized || '.';
}
