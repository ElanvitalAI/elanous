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
  readonly slash: readonly string[];
  readonly slashPrefixes: readonly string[];
  /** Exact phrases only: ordinary conversational text continues to the model. */
  readonly phrases: readonly string[];
  readonly roles: readonly string[];
  readonly minimumMaturity: NextTuiMaturity;
  readonly requiredFlags: readonly string[];
}

const MATURITY_RANK: Readonly<Record<NextTuiMaturity, number>> = {
  experimental: 0,
  beta: 1,
  stable: 2,
};

/**
 * Single routing and gate table for next-TUI built-ins. Keep phrase matching
 * exact so normal requests such as "도움말 문구를 작성해 줘" stay chat turns.
 */
export const NEXT_TUI_ROUTE_REGISTRY: readonly NextTuiRoute[] = [
  {
    id: 'session.quit',
    action: 'quit',
    slash: ['/quit'],
    slashPrefixes: [],
    phrases: ['엘라누스 종료', '끝내기'],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
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
  },
  {
    id: 'session.new',
    action: 'command',
    slash: ['/new', '/clear', '/session new'],
    slashPrefixes: [],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
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
  },
  {
    id: 'session.resume',
    action: 'command',
    slash: [],
    slashPrefixes: ['/resume'],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
  },
  {
    id: 'loop',
    action: 'command',
    slash: [],
    slashPrefixes: ['/loop'],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
  },
  {
    id: 'provider',
    action: 'command',
    slash: [],
    slashPrefixes: ['/provider'],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
  },
  {
    id: 'harness',
    action: 'command',
    slash: [],
    slashPrefixes: ['/harness'],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
  },
  {
    id: 'sidetab',
    action: 'command',
    slash: ['/side', '/sidetab'],
    slashPrefixes: ['/side', '/sidetab'],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
  },
  {
    id: 'terminal',
    action: 'command',
    slash: ['/term', '/terminal'],
    slashPrefixes: ['/term', '/terminal'],
    phrases: [],
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
  },
];

export const NEXT_TUI_HELP_LINES: readonly string[] = [
  'Commands',
  'Next TUI: /side · /sidetab — 세션/PTY 목록',
  '사이드탭: Ctrl+\\ 토글 · ↑↓ 선택 · 빈 prompt Enter=attach · /side new · /side kill',
  '새 PTY: s shell · e elanous · c codex 구독 · l claude code 구독',
  'PTY 분리: Ctrl+\\ 후 d · /term help 는 읽기 전용 목록 명령',
  '',
  'Keys',
  'Enter 전송 · Esc 취소 · PgUp/PgDn 대화 스크롤 · Ctrl+Q 종료',
  'Ctrl+\\ 사이드탭 토글 · ↑/↓ 목록 이동 · Esc 입력으로 돌아오기',
];

export const NEXT_TUI_INPUT_CONTEXT: NextTuiRouteContext = {
  role: 'human',
  maturity: 'stable',
  flags: new Set(),
};

function normalizeRouteInput(input: string): string {
  return input.trim();
}

function routeIsEnabled(route: NextTuiRoute, context: NextTuiRouteContext): boolean {
  return route.roles.includes(context.role)
    && MATURITY_RANK[context.maturity] >= MATURITY_RANK[route.minimumMaturity]
    && route.requiredFlags.every((flag) => context.flags.has(flag));
}

/** Resolve one exact slash command or fixed phrase through the shared gate table. */
export function resolveNextTuiRoute(input: string, context: NextTuiRouteContext): NextTuiRoute | null {
  const normalized = normalizeRouteInput(input);
  if (!normalized) return null;

  for (const route of NEXT_TUI_ROUTE_REGISTRY) {
    if (!routeIsEnabled(route, context)) continue;
    const compactSlash = normalized.replace(/\s+/g, ' ');
    if (route.slash.some((candidate) => candidate === normalized
      || (route.id === 'session.new' && candidate === compactSlash))
      || route.slashPrefixes.some((candidate) => {
        const prefix = candidate;
        return normalized === prefix || normalized.startsWith(`${prefix} `);
      })
      || route.phrases.some((candidate) => candidate === normalized)) {
      return route;
    }
  }
  return null;
}
