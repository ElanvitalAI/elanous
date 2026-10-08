export type Maturity = 'stable' | 'beta' | 'tool' | 'ops' | 'broken' | 'system';
export type Surface = 'pwa' | 'desktop' | 'ios' | 'android' | 'tui' | 'cli' | 'telegram' | 'discord' | 'acp';
export type Role = 'owner' | 'contributor' | 'general';

type SurfaceMaturity = { pwa: Maturity } & Partial<Record<Exclude<Surface, 'pwa'>, Maturity>>;

/** App Router pages, including the generated 404 and the dynamic missions route. */
export const FEATURE_MATURITY = {
  pwaRoute: {
    '/': { pwa: 'stable' },
    '/404': { pwa: 'stable' },
    '/setup': { pwa: 'stable' },
    '/setup/done': { pwa: 'stable' },
    '/consult': { pwa: 'stable' },
    '/chat': { pwa: 'stable' },
    '/today': { pwa: 'stable' },
    '/term': { pwa: 'stable' },
    '/live': { pwa: 'stable' },
    '/market': { pwa: 'stable' },
    '/sessions': { pwa: 'stable' },
    '/settings': { pwa: 'beta' },
    '/editor': { pwa: 'beta' },
    '/intake': { pwa: 'beta' },
    '/trace': { pwa: 'beta' },
    '/inside': { pwa: 'beta' },
    '/board': { pwa: 'beta' },
    '/autopilot': { pwa: 'beta' },
    '/missions/[id]': { pwa: 'beta' },
    '/tasks': { pwa: 'beta' },
    '/workspace': { pwa: 'beta' },
    '/reflection': { pwa: 'beta' },
    '/vault': { pwa: 'beta' },
    '/observatory': { pwa: 'beta' },
    '/exec': { pwa: 'beta' },
    '/outputs': { pwa: 'beta' },
    '/field': { pwa: 'beta' },
    '/showroom': { pwa: 'beta' },
    '/workflows': { pwa: 'beta' },
    '/approvals': { pwa: 'tool' },
    '/worktrees': { pwa: 'tool' },
    '/design-check': { pwa: 'tool' },
    '/control': { pwa: 'tool' },
    '/scheduler': { pwa: 'ops' },
    '/loops': { pwa: 'beta' },
    '/ops/release': { pwa: 'ops' },
    '/ops/seats': { pwa: 'ops' },
    '/ops/checklist': { pwa: 'ops' },
    '/ceo': { pwa: 'ops' },
    '/decisions': { pwa: 'ops' },
    '/dashboard': { pwa: 'ops' },
    '/pitch': { pwa: 'ops' },           // PITCH-ROOM — 투자자 피치 방(운영자 전용 · 공개 내보내기 제외)
    '/bots': { pwa: 'ops' },
    '/botlab': { pwa: 'ops' },
    '/morning': { pwa: 'broken' },
    '/settings/devices': { pwa: 'broken' },
    '/workflows/chat-ui': { pwa: 'broken' },
    '/share': { pwa: 'system' },
  },
  // Canonical CLI command names only; aliases inherit their command's grade.
  cliRoot: {
    preview: 'beta', pty: 'beta', pr: 'beta', repo: 'beta', role: 'beta', machine: 'beta', 'agent-env': 'beta',
    where: 'stable', shadow: 'beta', llm: 'beta', storage: 'beta', leader: 'beta',
    pod: 'beta', browser: 'beta', questions: 'beta', usage: 'stable', live: 'beta',
    research: 'beta', release: 'beta', know: 'beta', freeze: 'beta', flow: 'beta', seat: 'beta', hq: 'beta', steward: 'beta', coord: 'beta', context: 'beta', 'model-watch': 'beta', doctor: 'stable',
    control: 'beta', resources: 'beta', hooks: 'beta', setup: 'stable', start: 'stable',
    grounding: 'beta', graph: 'beta', loop: 'stable', card: 'stable', 'launch-head': 'beta',
    a2a: 'beta', plugin: 'stable', make: 'beta', skills: 'beta', connect: 'beta', import: 'beta',
    persona: 'beta', team: 'beta', 'team-set': 'beta', market: 'beta', directive: 'stable', connector: 'beta', storyboard: 'beta',
    python: 'beta', 'self-update': 'stable', 'measure-fabric-arc-ab': 'beta', mcp: 'beta',
    relay: 'beta', 'telegram-test': 'beta', telegram: 'beta', 'discord-test': 'beta',
    sync: 'beta', status: 'beta', git: 'beta', gh: 'beta', repro: 'system',
    theme: 'beta', history: 'beta', inspect: 'beta', autopilot: 'beta', memory: 'beta',
    decide: 'beta', 'ax-screen': 'beta', 'decide-recipe': 'beta', signals: 'beta',
    loops: 'beta', buzz: 'beta', harness: 'stable', self: 'beta', factcheck: 'beta',
    provider: 'stable', 'provider:set': 'beta', 'provider:restore': 'beta',
    'provider:rotate': 'beta', 'provider:use': 'beta', 'status-bar': 'beta',
    schedule: 'beta', guardian: 'beta', intake: 'beta', logs: 'stable', retro: 'beta', ad: 'beta', docs: 'beta',
    decisions: 'beta', directives: 'beta', claims: 'beta', lesson: 'beta', fleet: 'beta', ops: 'stable', outputs: 'beta', publish: 'beta',
    env: 'beta', 'agent-mission': 'beta', dev: 'beta', keys: 'beta', finance: 'beta',
    config: 'stable', tasks: 'stable', brief: 'beta', notify: 'beta', away: 'beta', labels: 'beta', msg: 'beta', ask: 'stable',
    onboarding: 'beta', login: 'stable', session: 'beta', chat: 'stable', repl: 'stable',
    agent: 'stable', registry: 'beta', tier: 'stable', local: 'beta', scheduler: 'beta',
    attach: 'beta', wf: 'beta', nexus: 'stable', phone: 'beta', token: 'beta',
    acp: 'beta', voice: 'beta',
    'run-detached': 'system', dogfood: 'system', run: 'system',
  },
  // Canonical names only; aliases inherit their command's grade at lookup.
  // Count: bun -e "import('./src/maturity/feature-maturity.ts').then(m=>console.log(Object.keys(m.FEATURE_MATURITY.tuiSlash).length))" (= SLASH_COMMANDS canonical names).
  tuiSlash: {
    help: 'stable',
    resume: 'stable',
    model: 'stable',
    clear: 'stable',
    status: 'stable',
    now: 'beta', // CTX2 «지금 무엇이 돌고 있나» (#23379)
    wish: 'beta',
    remaining: 'stable',
    setup: 'stable',
    quit: 'stable',
    'run-skill': 'stable',
    ad: 'beta',
    design: 'beta',
    decide: 'beta',
    provider: 'stable',
    reasoning: 'stable',
    local: 'tool',
    session: 'stable',
    fork: 'stable',
    rewind: 'stable',
    mission: 'beta',
    'resume-turn': 'beta',
    context: 'stable',
    paste: 'stable',
    sync: 'tool',
    plugin: 'tool',
    widget: 'tool',
    log: 'tool',
    loops: 'beta',
    persona: 'beta', // G3 b — 대화별 페르소나(GOAL-BENCH B7 #23836)
    memory: 'beta',
    export: 'stable',
    delta: 'tool',
    theme: 'stable',
    debug: 'tool',
    rebind: 'tool',
    'api-allow': 'tool',
    prompt: 'beta',
    history: 'stable',
    research: 'beta',
    harness: 'ops',
    plan: 'beta',
    chat: 'stable',
    dashboard: 'stable',
    telegram: 'ops',
    tablet: 'ops',
    surface: 'ops',
    term: 'tool',
    claude: 'tool',
    codex: 'tool',
    gemini: 'tool',
    acp: 'beta',
    conv: 'beta',
    handoff: 'ops',
    'agent-room': 'ops',
    showroom: 'ops',
    reply: 'ops',
    capture: 'ops',
    inject: 'ops',
    relay: 'ops',
    lane: 'ops',
    control: 'ops',
    default: 'ops',
    qc: 'ops',
    'voice-chat': 'beta',
    'auto-tts': 'beta',
    directive: 'ops',
  },
  telegramCommand: {
    help: 'stable', status: 'stable', new: 'stable', clear: 'stable', reset: 'stable',
    ping: 'stable', provider: 'stable', sessions: 'stable', fork: 'stable', resume: 'stable',
    decisions: 'stable', work: 'stable', cancel: 'stable',
    skills: 'beta', skill: 'beta', digest: 'beta', intake: 'beta', ad: 'beta',
    taste: 'beta', missions: 'beta', attach: 'beta', detach: 'beta', now: 'beta', loops: 'beta', runs: 'beta', release: 'beta', away: 'beta', project: 'beta', wish: 'beta',
    brain: 'tool', cc: 'tool', cdx: 'tool', gem: 'tool', local: 'tool',
    harness: 'ops',
    // Existing commands outside the CXO four-grade menu list are owner-only.
    cc_clear: 'system', coo: 'system', cto: 'system', cmo: 'system', cxo: 'system', mission_del: 'system',
    bots: 'system', bot: 'system', screen: 'system', chart: 'system', routines: 'system', botsay: 'system',
  },
  discordCommand: {
    status: 'stable', sessions: 'stable', new: 'stable', fork: 'stable',
    persona: 'beta', poll: 'beta', attach: 'beta', now: 'beta', loops: 'beta',
    brain: 'tool', cc: 'tool', cdx: 'tool', gem: 'tool',
    relay: 'ops', showroom: 'ops', bots: 'ops', bot: 'ops', screen: 'ops', chart: 'ops',
    routines: 'ops', botsay: 'ops', 'voice-join': 'ops', 'voice-leave': 'ops', 'voice-status': 'ops',
  },
} as const satisfies { pwaRoute: Record<string, SurfaceMaturity>; cliRoot: Record<string, Maturity>; tuiSlash: Record<string, Maturity>; telegramCommand: Record<string, Maturity>; discordCommand: Record<string, Maturity> };

/** Unregistered routes and surfaces are not implicitly mature. Desktop shares the PWA implementation. */
export function maturityOn(route: string, surface: Surface): Maturity | undefined {
  if (!Object.prototype.hasOwnProperty.call(FEATURE_MATURITY.pwaRoute, route)) return undefined;
  const grades: SurfaceMaturity = FEATURE_MATURITY.pwaRoute[route as keyof typeof FEATURE_MATURITY.pwaRoute];
  return grades[surface] ?? (surface === 'desktop' ? grades.pwa : undefined);
}

export function visibleOn(route: string, surface: Surface, role: Role): boolean {
  const maturity = maturityOn(route, surface);
  if (!maturity) return false;
  if (role === 'owner') return true;
  if (maturity === 'system') return false;
  if (route === '/settings') return true;
  return maturity === 'stable' || (role === 'contributor' && (maturity === 'beta' || maturity === 'tool'));
}

