/** Actions accepted directly by the next TUI input router. */
export type NextTuiRouteAction = 'quit' | 'help' | 'command';
export type NextTuiMaturity = 'experimental' | 'beta' | 'stable';

export interface NextTuiRouteContext {
  readonly role: string;
  readonly maturity: NextTuiMaturity;
  readonly flags: ReadonlySet<string>;
}

export interface NextTuiRoute {
  readonly id: string;
  readonly action: NextTuiRouteAction;
  /** Optional branch module loaded only when this route is selected. */
  readonly branchModule?: string;
  /** Host capability needed by the branch. New kinds require an explicit entry adapter. */
  readonly branchHost?: 'sidetab' | 'terminal' | 'context' | 'now' | 'app' | 'harness' | 'memory' | 'decide' | 'plugin-wizard' | 'loop';
  readonly slash: readonly string[];
  readonly slashPrefixes: readonly string[];
  /** Fixed phrases; ordinary conversational text continues to the model. */
  readonly phrases: readonly string[];
  /** Narrow natural-language intents owned by a route; ordinary requests stay with chat. */
  readonly phrasePatterns?: readonly RegExp[];
  readonly roles: readonly string[];
  readonly minimumMaturity: NextTuiMaturity;
  readonly requiredFlags: readonly string[];
  /** Short first-use help text. Slash names remain visible even when omitted. */
  readonly helpSummary?: string;
}

export const NEXT_TUI_NEW_SESSION_SLASHES = ['/new', '/clear', '/session new'] as const;

const MATURITY_RANK: Readonly<Record<NextTuiMaturity, number>> = {
  experimental: 0,
  beta: 1,
  stable: 2,
};

/**
 * Single routing and gate table for next-TUI built-ins. Keep phrase matching
 * narrow so normal requests such as "도움말 문구를 작성해 줘" stay chat turns.
 */
export const NEXT_TUI_ROUTE_REGISTRY: readonly NextTuiRoute[] = [
  {
    id: 'session.quit',
    action: 'quit',
    slash: ['/quit', '/exit'],
    slashPrefixes: [],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
    helpSummary: 'Quit',
  },
  {
    id: 'help.next',
    action: 'help',
    slash: ['/help', '/help next'],
    slashPrefixes: [],
    phrases: ['도움말', '사용법'],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
    helpSummary: 'Command and key guide',
  },
  {
    id: 'session.new',
    action: 'command',
    slash: NEXT_TUI_NEW_SESSION_SLASHES,
    slashPrefixes: [],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
    helpSummary: 'New chat',
  },
  {
    id: 'session.compact',
    action: 'command',
    slash: ['/compact'],
    slashPrefixes: [],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
    helpSummary: 'Compact chat',
  },
  {
    id: 'session.resume',
    action: 'command',
    slash: ['/session', '/sessions', '/session list', '/sessions list', '/session ls', '/sessions ls'],
    slashPrefixes: ['/resume', '/session load', '/sessions load', '/session resume', '/sessions resume'],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
    helpSummary: 'Resume a previous chat',
  },
  {
    id: 'loop',
    action: 'command',
    branchModule: '../tui-client/next-loop-command.js',
    branchHost: 'loop',
    slash: [],
    slashPrefixes: ['/loop'],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
    helpSummary: 'Repeatable jobs',
  },
  {
    id: 'model',
    action: 'command',
    slash: [],
    slashPrefixes: ['/model', '/provider'],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
    helpSummary: 'fast|normal|deep · /provider alias',
  },
  {
    id: 'status',
    action: 'command',
    slash: ['/status', '/st'],
    slashPrefixes: [],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
    helpSummary: 'Model · connection settings · account status',
  },
  {
    id: 'remaining',
    action: 'command',
    slash: ['/remaining'],
    slashPrefixes: ['/remaining'],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
    helpSummary: 'Combined usage and remaining quota',
  },
  {
    id: 'harness',
    action: 'command',
    branchModule: './branches/harness.js',
    branchHost: 'harness',
    slash: [],
    slashPrefixes: ['/harness'],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
    helpSummary: 'Harness commands',
  },
  {
    id: 'memory',
    action: 'command',
    branchModule: './branches/memory.js',
    branchHost: 'memory',
    slash: ['/memory', '/mem'],
    slashPrefixes: ['/memory', '/mem'],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
    helpSummary: 'List and view memories',
  },
  {
    id: 'decide',
    action: 'command',
    branchModule: './branches/decide.js',
    branchHost: 'decide',
    slash: ['/decide', '/dec'],
    slashPrefixes: ['/decide', '/dec'],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
    helpSummary: 'View and answer open decisions',
  },
  {
    id: 'sidetab',
    action: 'command',
    branchModule: './branches/sidetab/route.js',
    branchHost: 'sidetab',
    slash: ['/side', '/sidetab'],
    slashPrefixes: ['/side', '/sidetab'],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
    helpSummary: 'Session/PTY list · /side new · /side kill',
  },
  {
    // GRAPH-VIEW-DETAIL-SIDETAB (개정 5): keyboard way into a graph loop's detail (Ctrl/Alt+click is the mouse way).
    id: 'graph',
    action: 'command',
    slash: ['/graph'],
    slashPrefixes: ['/graph'],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
    helpSummary: 'Graph loop detail · /graph [loopId[:node]] · Ctrl+G',
  },
  {
    id: 'terminal',
    action: 'command',
    branchModule: './branches/term/route.js',
    branchHost: 'terminal',
    slash: ['/term', '/terminal'],
    slashPrefixes: ['/term', '/terminal'],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
    helpSummary: 'PTY commands · /term help is read-only',
  },

  {
    id: 'now',
    action: 'command',
    branchModule: './branches/now.js',
    branchHost: 'now',
    slash: [],
    slashPrefixes: ['/now'],
    phrases: ['지금 상황'],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
    helpSummary: 'Current context and sources',
  },
  {
    id: 'context',
    action: 'command',
    branchModule: './branches/context.js',
    branchHost: 'context',
    slash: ['/context', '/ctx'],
    slashPrefixes: ['/context', '/ctx'],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
    helpSummary: 'Attachment list and removal',
  },
  {
    id: 'app',
    action: 'command',
    branchModule: './branches/app/index.js',
    branchHost: 'app',
    slash: ['/app'],
    slashPrefixes: ['/app'],
    phrases: ['앱 상태'],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
    helpSummary: 'App contract, simulation, status',
  },
  {
    id: 'plugin.wizard',
    action: 'command',
    branchModule: './branches/plugin-wizard.js',
    branchHost: 'plugin-wizard',
    slash: [],
    slashPrefixes: [],
    phrases: ['플러그인 만들어 줘', '플러그인 만들어줘'],
    phrasePatterns: [/^.{2,}는 플러그인$/u, /^.+ 플러그인 만들어 줘$/u, /^.+ 플러그인 만들어줘$/u],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
  },
  {
    id: 'signals',
    action: 'command',
    slash: ['/signals'],
    slashPrefixes: ['/signals'],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
    helpSummary: 'Check signals',
  },
  {
    // TUI-REGRESS-R4 (MAT1c) — /directive is a live command in the slash catalog
    // (src/chat/index.ts SLASH_COMMANDS · «(운영) 지시를 Linear 이슈로 기록») and the chat
    // surface shows it to the owner (src/chat/pickers/state.ts owner unhide). The Next TUI
    // route table never carried it after the registry migration (#35409), so the palette
    // lost the command. Registry-only route: entry.ts keeps no dedicated dispatch for it,
    // so Enter falls through to the person's turn and the model receives "/directive <text>".
    id: 'directive',
    action: 'command',
    slash: ['/directive'],
    slashPrefixes: ['/directive'],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
    helpSummary: '(운영) 지시를 Linear 이슈로 기록',
  },
];

const NEXT_TUI_EXACT_SLASH_ROUTES = new Map<string, NextTuiRoute[]>();
const NEXT_TUI_ROUTE_ORDER = new Map(NEXT_TUI_ROUTE_REGISTRY.map((route, index) => [route, index]));
export function buildNextTuiPrefixSlashIndex(routes: readonly NextTuiRoute[]): Map<string, NextTuiRoute[]> {
  const index = new Map<string, NextTuiRoute[]>();
  for (const route of routes) {
    for (const prefix of route.slashPrefixes) {
      // Index by the first token, then check the complete prefix at lookup time.
      // Prefixes may contain spaces (for example `/session list`).
      const commandEnd = prefix.indexOf(' ');
      const command = commandEnd < 0 ? prefix : prefix.slice(0, commandEnd);
      const candidates = index.get(command) ?? [];
      candidates.push(route);
      index.set(command, candidates);
    }
  }
  return index;
}
const NEXT_TUI_PREFIX_SLASH_ROUTES = buildNextTuiPrefixSlashIndex(NEXT_TUI_ROUTE_REGISTRY);
for (const route of NEXT_TUI_ROUTE_REGISTRY) {
  for (const slash of route.slash) {
    const candidates = NEXT_TUI_EXACT_SLASH_ROUTES.get(slash) ?? [];
    candidates.push(route);
    NEXT_TUI_EXACT_SLASH_ROUTES.set(slash, candidates);
  }
}
const NEXT_TUI_PHRASE_PATTERN_ROUTES = NEXT_TUI_ROUTE_REGISTRY.filter((route) => route.phrasePatterns?.length);

const NEXT_TUI_KEY_HELP_LINES: readonly string[] = [
  'Keys',
  'Enter send · Esc cancel · PgUp/PgDn scroll chat · Ctrl+Q quit',
  'Ctrl+\\ toggle · ↑/↓ select · Enter on empty input=attach',
  'New PTY: s shell · e elanous · c codex subscribe · l claude code subscribe',
  'PTY detach: Ctrl+\\ then d',
  'Esc returns to input',
];

export const NEXT_TUI_INPUT_CONTEXT: NextTuiRouteContext = {
  role: 'human',
  maturity: 'stable',
  flags: new Set(),
};

/** Candidate commands shown while a human types `/` in the Next TUI composer. */
export function nextTuiSlashCandidates(prefix: string, context = NEXT_TUI_INPUT_CONTEXT): Array<{ value: string; description: string }> {
  const query = prefix.toLocaleLowerCase();
  const values = new Map<string, string>();
  for (const route of NEXT_TUI_ROUTE_REGISTRY) {
    if (!routeIsEnabled(route, context)) continue;
    for (const value of [...route.slash, ...route.slashPrefixes]) {
      const name = value.slice(1);
      if (name.toLocaleLowerCase().startsWith(query)) values.set(value, route.helpSummary ?? route.id);
    }
  }
  return [...values].sort(([a], [b]) => a.localeCompare(b)).map(([value, description]) => ({ value, description }));
}

function normalizeRouteInput(input: string): string {
  return input.trim();
}

function routeIsEnabled(route: NextTuiRoute, context: NextTuiRouteContext): boolean {
  if (!route.roles.includes(context.role)) return false;
  if (MATURITY_RANK[context.maturity] < MATURITY_RANK[route.minimumMaturity]) return false;
  for (const flag of route.requiredFlags) if (!context.flags.has(flag)) return false;
  return true;
}

/** Match the complete registered prefix, including any words after its command token. */
export function matchesNextTuiSlashPrefix(input: string, prefix: string): boolean {
  return input === prefix || input.startsWith(`${prefix} `);
}

/** Build first-use help directly from the routes the current user can invoke. */
export function buildNextTuiHelpLines(
  context: NextTuiRouteContext = NEXT_TUI_INPUT_CONTEXT,
  routes: readonly NextTuiRoute[] = NEXT_TUI_ROUTE_REGISTRY,
): readonly string[] {
  const commandLines = routes
    .filter((route) => routeIsEnabled(route, context))
    .map((route) => {
      const commands = [...new Set([...route.slash, ...route.slashPrefixes])];
      if (commands.length === 0) return null;
      return `${commands.join(' · ')}${route.helpSummary ? ` — ${route.helpSummary}` : ''}`;
    })
    .filter((line): line is string => line !== null);

  // The rendered history keeps only the viewport's last rows; the separator
  // pushed the first-use heading above that window on a 24-row terminal.
  // NEXT-TUI-UI-ENGLISH: fixed help chrome (headings, summaries, keys) is English.
  return ['Commands', ...commandLines, ...NEXT_TUI_KEY_HELP_LINES];
}

/** Resolve slash commands, fixed phrases, and explicitly narrow phrase patterns through the shared gate table. */
export function resolveNextTuiRoute(input: string, context: NextTuiRouteContext): NextTuiRoute | null {
  const normalized = normalizeRouteInput(input);
  if (!normalized) return null;
  const compactSlash = normalized.replace(/\s+/g, ' ');

  if (normalized.startsWith('/')) {
    let slashMatch: NextTuiRoute | null = null;
    let slashMatchOrder = Number.POSITIVE_INFINITY;
    const exactCandidates = NEXT_TUI_EXACT_SLASH_ROUTES.get(normalized)
      ?? NEXT_TUI_EXACT_SLASH_ROUTES.get(compactSlash);
    if (exactCandidates) {
      for (const route of exactCandidates) {
        if (!routeIsEnabled(route, context)) continue;
        const order = NEXT_TUI_ROUTE_ORDER.get(route) ?? Number.POSITIVE_INFINITY;
        if (order < slashMatchOrder) {
          slashMatch = route;
          slashMatchOrder = order;
        }
      }
    }
    const separator = normalized.indexOf(' ');
    const command = separator < 0 ? normalized : normalized.slice(0, separator);
    const prefixCandidates = NEXT_TUI_PREFIX_SLASH_ROUTES.get(command);
    if (prefixCandidates) {
      for (const route of prefixCandidates) {
        if (!routeIsEnabled(route, context)) continue;
        for (const prefix of route.slashPrefixes) {
          if (!matchesNextTuiSlashPrefix(normalized, prefix)) continue;
          const order = NEXT_TUI_ROUTE_ORDER.get(route) ?? Number.POSITIVE_INFINITY;
          if (order < slashMatchOrder) {
            slashMatch = route;
            slashMatchOrder = order;
          }
          break;
        }
      }
    }
    for (const route of NEXT_TUI_PHRASE_PATTERN_ROUTES) {
      if ((NEXT_TUI_ROUTE_ORDER.get(route) ?? Number.POSITIVE_INFINITY) >= slashMatchOrder) break;
      if (!routeIsEnabled(route, context) || !route.phrasePatterns) continue;
      for (const pattern of route.phrasePatterns) if (pattern.test(normalized)) return route;
    }
    return slashMatch;
  }

  for (const route of NEXT_TUI_ROUTE_REGISTRY) {
    if (!routeIsEnabled(route, context)) continue;
    for (const candidate of route.slash) {
      if (candidate === normalized || (route.id === 'session.new' && candidate === compactSlash)) return route;
    }
    for (const prefix of route.slashPrefixes) {
      if (matchesNextTuiSlashPrefix(normalized, prefix)) return route;
    }
    for (const phrase of route.phrases) if (phrase === normalized) return route;
    if (route.phrasePatterns) {
      for (const pattern of route.phrasePatterns) if (pattern.test(normalized)) return route;
    }
  }
  return null;
}
