// Keep migration and retirement advice separate from the active slash registry:
// a retired name must never be advertised as an available command.
export const RETIRED_SLASH_ADVICE: Readonly<Record<string, { kind: 'moved' | 'retired'; use: string }>> = {
  // These four entry points moved into the harness command.
  ask: { kind: 'moved', use: '/harness ask <무엇을 왜 고칠지 한 문장>' },
  say: { kind: 'moved', use: '/harness ask <무엇을 왜 고칠지 한 문장>' },
  implement: { kind: 'moved', use: '/harness ask <무엇을 왜 고칠지 한 문장>' },
  dev: { kind: 'moved', use: '/harness dev <무엇을 왜 고칠지 한 문장>' },
  // Retired rich-UI and auxiliary commands from the slash registration tests.
  ui: { kind: 'retired', use: '/help' }, workspace: { kind: 'retired', use: '/help' },
  ws: { kind: 'retired', use: '/help' }, window: { kind: 'retired', use: '/help' },
  win: { kind: 'retired', use: '/help' }, scratch: { kind: 'retired', use: '/help' },
  sc: { kind: 'retired', use: '/help' }, 'acp-vw': { kind: 'retired', use: '/help' },
  'claude-vw': { kind: 'retired', use: '/help' }, 'pty-pane': { kind: 'retired', use: '/help' },
  'pty-view': { kind: 'retired', use: '/help' }, fullscreen: { kind: 'retired', use: '/help' },
  fs: { kind: 'retired', use: '/help' }, view: { kind: 'retired', use: '/help' },
  ctoggle: { kind: 'retired', use: '/help' }, cache: { kind: 'retired', use: '/help' },
  perf: { kind: 'retired', use: '/help' }, 'pty-list': { kind: 'retired', use: '/help' },
  ptys: { kind: 'retired', use: '/help' }, 'sweep-tool-results': { kind: 'retired', use: '/help' },
  budget: { kind: 'retired', use: '/tokens' }, b: { kind: 'retired', use: '/tokens' },
  route: { kind: 'retired', use: '/help' }, llm: { kind: 'retired', use: '/model' },
  'browser-cdp': { kind: 'retired', use: '/help' }, bcdp: { kind: 'retired', use: '/help' },
  dm: { kind: 'retired', use: '/help' }, surf: { kind: 'retired', use: '/help' },
  'codex-vw': { kind: 'retired', use: '/help' }, 'skill-triggers': { kind: 'retired', use: '/help' },
  triggers: { kind: 'retired', use: '/help' }, git: { kind: 'retired', use: '/help' },
  memorize: { kind: 'retired', use: '/memory' }, 'mem-compact': { kind: 'retired', use: '/memory' },
  sim: { kind: 'retired', use: '/help' }, simulator: { kind: 'retired', use: '/help' },
  'turn-slider': { kind: 'retired', use: '/help' }, turnslider: { kind: 'retired', use: '/help' },
  tslider: { kind: 'retired', use: '/help' }, playground: { kind: 'retired', use: '/help' },
  pg: { kind: 'retired', use: '/help' }, branch: { kind: 'retired', use: '/help' },
  audit: { kind: 'retired', use: '/help' }, 'substrate-stats': { kind: 'retired', use: '/help' },
  sst: { kind: 'retired', use: '/help' }, usage: { kind: 'retired', use: '/tokens' },
  stats: { kind: 'retired', use: '/help' }, 'codex-setup': { kind: 'retired', use: '/help' },
  'codex-init': { kind: 'retired', use: '/help' }, hint: { kind: 'retired', use: '/help' },
  media: { kind: 'retired', use: '/help' }, mv: { kind: 'retired', use: '/help' },
};

function distanceAtMostTwo(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    if (Math.min(...current) > 2) return 3;
    previous = current;
  }
  return previous[b.length]!;
}

/** Plain lines: the caller applies its existing warning/muted presentation. */
export function unknownSlashReply(name: string, registered: readonly string[]): string[] {
  const slashName = name.replace(/^\//, '').toLowerCase();
  const advice = Object.hasOwn(RETIRED_SLASH_ADVICE, slashName)
    ? RETIRED_SLASH_ADVICE[slashName] : undefined;
  if (advice?.kind === 'moved') {
    return [`/${slashName} has moved; use ${advice.use}`];
  }
  if (advice) return [`/${slashName} is retired; use ${advice.use}`];

  const suggestions = [...new Set(registered)]
    .filter((candidate) => !Object.hasOwn(RETIRED_SLASH_ADVICE, candidate))
    .map((candidate) => ({ candidate, distance: distanceAtMostTwo(slashName, candidate) }))
    .filter(({ distance }) => distance <= 2)
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, 3)
    .map(({ candidate }) => `/${candidate}`);
  return [
    `Unknown command: /${slashName}`,
    ...(suggestions.length ? [`Did you mean: ${suggestions.join(', ')}?`] : []),
    'Type /help for the list of commands.',
  ];
}
