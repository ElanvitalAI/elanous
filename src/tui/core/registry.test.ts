import { describe, expect, test } from 'bun:test';
import { parseResumeCommand } from '../slash/resume-command.js';
import {
  buildNextTuiPrefixSlashIndex,
  matchesNextTuiSlashPrefix,
  NEXT_TUI_INPUT_CONTEXT,
  NEXT_TUI_ROUTE_REGISTRY,
  nextTuiSlashCandidates,
  resolveNextTuiRoute,
  type NextTuiRoute,
} from './registry.js';

function resolveByLinearScan(input: string, context: typeof NEXT_TUI_INPUT_CONTEXT) {
  const normalized = input.trim();
  if (!normalized) return null;
  const compactSlash = normalized.replace(/\s+/g, ' ');
  const maturityRank = { experimental: 0, beta: 1, stable: 2 } as const;
  for (const route of NEXT_TUI_ROUTE_REGISTRY) {
    if (!route.roles.includes(context.role)
      || maturityRank[context.maturity] < maturityRank[route.minimumMaturity]
      || route.requiredFlags.some((flag) => !context.flags.has(flag))) continue;
    if (route.slash.some((candidate) => candidate === normalized
      || (route.id === 'session.new' && candidate === compactSlash))
      || route.slashPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `))
      || route.phrases.some((phrase) => phrase === normalized)) return route;
    if (route.phrasePatterns?.some((pattern) => pattern.test(normalized))) return route;
  }
  return null;
}

describe('nextTuiSlashCandidates', () => {
  test('filters built-in aliases by the typed prefix and exposes descriptions', () => {
    const candidates = nextTuiSlashCandidates('he');
    expect(candidates).toContainEqual({ value: '/help', description: '명령과 키 안내' });
    expect(candidates).toContainEqual({ value: '/help next', description: '명령과 키 안내' });
    expect(nextTuiSlashCandidates('mem').map((item) => item.value)).toContain('/memory');
  });

  test('returns no candidates for a prefix without a built-in match', () => {
    expect(nextTuiSlashCandidates('not-a-command')).toEqual([]);
  });
});

test('only the slash quit command closes next TUI; plain exit words stay chat turns', () => {
  for (const command of ['/quit', '/exit']) {
    expect(resolveNextTuiRoute(command, NEXT_TUI_INPUT_CONTEXT)?.action).toBe('quit');
  }
  for (const phrase of ['quit', 'exit', '종료', '그만', '끝내기', '엘라누스 종료']) {
    expect(resolveNextTuiRoute(phrase, NEXT_TUI_INPUT_CONTEXT)).toBeNull();
  }
  expect(resolveNextTuiRoute('exiting now', NEXT_TUI_INPUT_CONTEXT)).toBeNull();
});

test('indexed slash lookup matches the prior registry scan across route forms and disabled contexts', () => {
  const inputs = new Set([
    '/unknown', '/help', '/session   new', ' /session\tnew ', '/model deep',
    '/model deep 플러그인 만들어 줘', '/signals', '/signals 플러그인 만들어 줘',
    '도움말', 'CSV는 플러그인', 'CSV 플러그인 만들어 줘', 'CSV 플러그인 만들어줘', '일반 대화',
    ...NEXT_TUI_ROUTE_REGISTRY.flatMap((route) => [
      ...route.slash,
      ...route.slashPrefixes.flatMap((prefix) => [prefix, `${prefix} argument`, ` ${prefix}   argument `]),
      ...route.phrases,
    ]),
  ]);
  const contexts = [
    NEXT_TUI_INPUT_CONTEXT,
    { role: 'human', maturity: 'beta' as const, flags: new Set<string>() },
    { role: 'agent', maturity: 'stable' as const, flags: new Set<string>() },
  ];

  for (const context of contexts) {
    for (const input of inputs) {
      expect(resolveNextTuiRoute(input, context)?.id ?? null).toBe(resolveByLinearScan(input, context)?.id ?? null);
    }
  }
});

test('indexed slash prefixes preserve the complete multi-word prefix', () => {
  const route: NextTuiRoute = {
    id: 'session.list',
    action: 'command',
    slash: [],
    slashPrefixes: ['/session list'],
    phrases: [],
    roles: ['human'],
    minimumMaturity: 'stable',
    requiredFlags: [],
  };
  const index = buildNextTuiPrefixSlashIndex([route]);
  const candidates = index.get('/session');

  expect(candidates).toContain(route);
  expect(candidates?.some((candidate) => candidate.slashPrefixes.some((prefix) =>
    matchesNextTuiSlashPrefix('/session list argument', prefix)))).toBe(true);
  expect(matchesNextTuiSlashPrefix('/session listing', '/session list')).toBe(false);
});
test('resume aliases reach the existing parser while session new retains its route', () => {
  for (const command of [
    '/resume', '/resume abc123', '/session', '/sessions',
    '/session list', '/sessions list', '/session ls', '/sessions ls',
    '/session load abc123', '/sessions load abc123',
    '/session resume abc123', '/sessions resume abc123',
  ]) {
    expect(resolveNextTuiRoute(command, NEXT_TUI_INPUT_CONTEXT)?.id).toBe('session.resume');
    expect(parseResumeCommand(command)).not.toBeNull();
  }
  expect(resolveNextTuiRoute('/session new', NEXT_TUI_INPUT_CONTEXT)?.id).toBe('session.new');
  for (const command of ['/session fork', '/sessionish', 'session']) {
    expect(resolveNextTuiRoute(command, NEXT_TUI_INPUT_CONTEXT)).toBeNull();
  }
});
