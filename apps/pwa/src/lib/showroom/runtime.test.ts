/** CV-3 Showroom MVP — runtime unit tests (P1).
 *  Mirrors `chat-runtime.test.ts` style. */

import { describe, expect, test } from 'bun:test';
import { DaemonClient } from '../daemon-client';
import {
  addChainEdge,
  broadcastToPanels,
  classifyPromptRole,
  composeForwardText,
  createDefaultPanels,
  DEFAULT_ROUTE_PROMPT,
  dispatchToPanel,
  findEdgesFrom,
  newChainEdgeId,
  newPanelId,
  newShowroomId,
  panelDisplayName,
  pruneEdgesForPanel,
  removeChainEdge,
  roleKeywordsFor,
  SHOWROOM_PROVIDERS,
  wouldCreateCycle,
  type PanelDispatcher,
} from './runtime';
import type { ChainEdge, ShowroomPanel, ShowroomRoleHint } from './types';

function panel(id: string, provider: string, state: ShowroomPanel['state']): ShowroomPanel {
  return { id, kind: 'chat', provider, sessionId: `sess-${id}`, state };
}

describe('Showroom runtime · broadcastToPanels', () => {
  test('invokes dispatchers for live panels only · mute/freeze skipped', async () => {
    const panels: ShowroomPanel[] = [
      panel('p1', 'claude', 'live'),
      panel('p2', 'gemini', 'mute'),
      panel('p3', 'grok', 'live'),
      panel('p4', 'codex', 'freeze'),
    ];
    const calls: string[] = [];
    const dispatchers = new Map<string, PanelDispatcher>([
      ['p1', async (text) => { calls.push(`p1:${text}`); }],
      ['p2', async (text) => { calls.push(`p2:${text}`); }],
      ['p3', async (text) => { calls.push(`p3:${text}`); }],
      ['p4', async (text) => { calls.push(`p4:${text}`); }],
    ]);
    const res = await broadcastToPanels(panels, dispatchers, 'hello');
    expect(res).toHaveLength(2);
    expect(calls.sort()).toEqual(['p1:hello', 'p3:hello']);
  });

  test('panels without registered dispatcher are skipped (handshake in flight)', async () => {
    const panels: ShowroomPanel[] = [
      panel('p1', 'claude', 'live'),
      panel('p2', 'gemini', 'live'), // no dispatcher
    ];
    const calls: string[] = [];
    const dispatchers = new Map<string, PanelDispatcher>([
      ['p1', async (text) => { calls.push(`p1:${text}`); }],
    ]);
    const res = await broadcastToPanels(panels, dispatchers, 'hi');
    expect(res).toHaveLength(1);
    expect(calls).toEqual(['p1:hi']);
  });

  test('one panel rejection does not affect others (allSettled)', async () => {
    const panels: ShowroomPanel[] = [
      panel('p1', 'claude', 'live'),
      panel('p2', 'gemini', 'live'),
    ];
    const calls: string[] = [];
    const dispatchers = new Map<string, PanelDispatcher>([
      ['p1', async () => { throw new Error('boom'); }],
      ['p2', async (text) => { calls.push(`p2:${text}`); }],
    ]);
    const res = await broadcastToPanels(panels, dispatchers, 'hi');
    expect(res).toHaveLength(2);
    const fulfilled = res.filter((r) => r.status === 'fulfilled');
    const rejected = res.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(calls).toEqual(['p2:hi']);
  });

  test('returns empty array when no live panels', async () => {
    const panels: ShowroomPanel[] = [
      panel('p1', 'claude', 'mute'),
      panel('p2', 'gemini', 'freeze'),
    ];
    const dispatchers = new Map<string, PanelDispatcher>([
      ['p1', async () => {}],
      ['p2', async () => {}],
    ]);
    const res = await broadcastToPanels(panels, dispatchers, 'hi');
    expect(res).toEqual([]);
  });
});

describe('Showroom runtime · dispatchToPanel', () => {
  test('targeted invokes single dispatcher', async () => {
    const calls: string[] = [];
    const dispatchers = new Map<string, PanelDispatcher>([
      ['p1', async (text) => { calls.push(`p1:${text}`); }],
      ['p2', async (text) => { calls.push(`p2:${text}`); }],
    ]);
    const res = await dispatchToPanel('p2', dispatchers, 'hi');
    expect(res?.status).toBe('fulfilled');
    expect(calls).toEqual(['p2:hi']);
  });

  test('returns null for unknown panel id', async () => {
    const dispatchers = new Map<string, PanelDispatcher>();
    const res = await dispatchToPanel('p1', dispatchers, 'hi');
    expect(res).toBeNull();
  });
});

describe('Showroom runtime · panelDisplayName (D12)', () => {
  test('single provider returns plain name (no numeric suffix)', () => {
    const panels = [panel('p1', 'claude', 'live')];
    expect(panelDisplayName(panels[0], panels)).toBe('claude');
  });

  test('two same provider get numeric suffix', () => {
    const panels = [
      panel('p1', 'claude', 'live'),
      panel('p2', 'claude', 'live'),
    ];
    expect(panelDisplayName(panels[0], panels)).toBe('claude-1');
    expect(panelDisplayName(panels[1], panels)).toBe('claude-2');
  });

  test('mixed providers — only duplicates get suffix', () => {
    const panels = [
      panel('p1', 'claude', 'live'),
      panel('p2', 'gemini', 'live'),
      panel('p3', 'gemini', 'live'),
    ];
    expect(panelDisplayName(panels[0], panels)).toBe('claude');
    expect(panelDisplayName(panels[1], panels)).toBe('gemini-1');
    expect(panelDisplayName(panels[2], panels)).toBe('gemini-2');
  });

  test('empty provider falls back to "default"', () => {
    const panels = [panel('p1', '', 'live')];
    expect(panelDisplayName(panels[0], panels)).toBe('default');
  });
});

describe('Showroom runtime · id generation', () => {
  test('newPanelId yields unique ids', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i += 1) ids.add(newPanelId());
    expect(ids.size).toBe(200);
  });

  test('newShowroomId yields unique ids', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i += 1) ids.add(newShowroomId());
    expect(ids.size).toBe(100);
  });

  test('newPanelId starts with `p-` · newShowroomId starts with `sr-`', () => {
    expect(newPanelId().startsWith('p-')).toBe(true);
    expect(newShowroomId().startsWith('sr-')).toBe(true);
  });
});

describe('Showroom runtime · createDefaultPanels', () => {
  test('returns 2 live chat panels with default provider', () => {
    const panels = createDefaultPanels();
    expect(panels).toHaveLength(2);
    panels.forEach((p) => {
      expect(p.kind).toBe('chat');
      expect(p.state).toBe('live');
      expect(p.sessionId).toBeNull();
      expect(p.provider).toBe('');
    });
    expect(panels[0]!.id).not.toBe(panels[1]!.id);
  });
});

describe('Showroom runtime · SHOWROOM_PROVIDERS', () => {
  test('keeps the showroom fallback provider pool (default + 4 named)', () => {
    expect(SHOWROOM_PROVIDERS).toEqual(['', 'claude', 'gemini', 'grok', 'codex']);
    expect('prompt' in DaemonClient.prototype).toBe(false);
  });
});

import { parseMentions, planDispatch, stripMentions } from './runtime';

describe('Showroom runtime · parseMentions (P2 D5)', () => {
  test('no mention → empty targets · broadcast 가정', () => {
    const panels: ShowroomPanel[] = [
      panel('p1', 'claude', 'live'),
      panel('p2', 'gemini', 'live'),
    ];
    const res = parseMentions('hello world', panels);
    expect(res.targets).toEqual([]);
    expect(res.broadcastAll).toBe(false);
    expect(res.mentions).toEqual([]);
    expect(res.unknown).toEqual([]);
  });

  test('@claude → 1 target · 매치 panel · mentions array 에 토큰', () => {
    const panels: ShowroomPanel[] = [
      panel('p1', 'claude', 'live'),
      panel('p2', 'gemini', 'live'),
    ];
    const res = parseMentions('@claude review this', panels);
    expect(res.targets).toHaveLength(1);
    expect(res.targets[0]!.id).toBe('p1');
    expect(res.mentions).toEqual(['@claude']);
    expect(res.broadcastAll).toBe(false);
  });

  test('@all → broadcastAll true · targets empty (broadcast path)', () => {
    const panels: ShowroomPanel[] = [
      panel('p1', 'claude', 'live'),
    ];
    const res = parseMentions('@all check this', panels);
    expect(res.broadcastAll).toBe(true);
    expect(res.mentions).toEqual(['@all']);
  });

  test('@claude + @gemini → 2 unique targets', () => {
    const panels: ShowroomPanel[] = [
      panel('p1', 'claude', 'live'),
      panel('p2', 'gemini', 'live'),
      panel('p3', 'grok', 'live'),
    ];
    const res = parseMentions('@claude @gemini compare', panels);
    expect(res.targets).toHaveLength(2);
    expect(res.targets.map((t) => t.id)).toEqual(['p1', 'p2']);
  });

  test('@claude-2 의 D12 numeric suffix 매치', () => {
    const panels: ShowroomPanel[] = [
      panel('p1', 'claude', 'live'),
      panel('p2', 'claude', 'live'),
    ];
    // panelDisplayName(p1) = 'claude-1' · p2 = 'claude-2'
    const res = parseMentions('@claude-2 second', panels);
    expect(res.targets).toHaveLength(1);
    expect(res.targets[0]!.id).toBe('p2');
  });

  test('unknown mention 은 unknown array 에 (silent ignore in dispatch)', () => {
    const panels: ShowroomPanel[] = [panel('p1', 'claude', 'live')];
    const res = parseMentions('@nonexistent hello', panels);
    expect(res.targets).toEqual([]);
    expect(res.unknown).toEqual(['nonexistent']);
  });

  test('동일 mention 중복은 unique', () => {
    const panels: ShowroomPanel[] = [panel('p1', 'claude', 'live')];
    const res = parseMentions('@claude do x · @claude also y', panels);
    expect(res.targets).toHaveLength(1);
    expect(res.targets[0]!.id).toBe('p1');
    expect(res.mentions).toEqual(['@claude', '@claude']);
  });

  test('mention 은 case-insensitive', () => {
    const panels: ShowroomPanel[] = [panel('p1', 'claude', 'live')];
    const res = parseMentions('@CLAUDE @Claude @claude', panels);
    expect(res.targets).toHaveLength(1);
    expect(res.mentions).toHaveLength(3);
  });
});

describe('Showroom runtime · planDispatch (P2 D5)', () => {
  test('no mention → broadcast (live only)', () => {
    const panels: ShowroomPanel[] = [
      panel('p1', 'claude', 'live'),
      panel('p2', 'gemini', 'mute'),
      panel('p3', 'grok', 'live'),
    ];
    const plan = planDispatch('plain text', panels);
    expect(plan.mode).toBe('broadcast');
    expect(plan.targets.map((t) => t.id).sort()).toEqual(['p1', 'p3']);
  });

  test('@target → targeted (state 무관 · mute panel 도 명시 시 받음)', () => {
    const panels: ShowroomPanel[] = [
      panel('p1', 'claude', 'live'),
      panel('p2', 'gemini', 'mute'),
    ];
    const plan = planDispatch('@gemini wake up', panels);
    expect(plan.mode).toBe('targeted');
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]!.id).toBe('p2');
  });

  test('@all → broadcast (live only · explicit)', () => {
    const panels: ShowroomPanel[] = [
      panel('p1', 'claude', 'live'),
      panel('p2', 'gemini', 'mute'),
    ];
    const plan = planDispatch('@all check', panels);
    expect(plan.mode).toBe('broadcast');
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]!.id).toBe('p1');
  });

  test('unknown mention 만 → broadcast fallback', () => {
    const panels: ShowroomPanel[] = [panel('p1', 'claude', 'live')];
    const plan = planDispatch('@nope hello', panels);
    expect(plan.mode).toBe('broadcast');
    expect(plan.targets).toHaveLength(1);
  });
});

import {
  buildMultiLlmHint,
  defaultPriorAnswerLabel,
  defaultTerminalContextLabel,
  applyToolCallEvent,
  extractLastAssistantText,
  formatPriorAnswerPrefix,
  formatTerminalContextPrefix,
  formatToolListEntry,
  newPriorAnswerId,
  newTerminalContextId,
  parseMultiLlmUpdateMeta,
  parseShowroomToolCallEvent,
  wrapMultiLlmMeta,
} from './runtime';
import type { PriorAnswer, TerminalContext, ToolCallState } from './types';

describe('Showroom runtime · formatTerminalContextPrefix (P4 D14)', () => {
  test('empty contexts returns empty string', () => {
    expect(formatTerminalContextPrefix([])).toBe('');
  });

  test('1 context — prepended terminal_context block + trailing blank line', () => {
    const ctx: TerminalContext = {
      id: 'tc1',
      label: 'build error',
      text: 'error: cannot find module foo',
      pinnedAt: 1715000000000,
    };
    const out = formatTerminalContextPrefix([ctx]);
    expect(out).toContain('<terminal_context label="build error">');
    expect(out).toContain('error: cannot find module foo');
    expect(out).toContain('</terminal_context>');
    expect(out.endsWith('\n\n')).toBe(true);
  });

  test('multiple contexts — order preserved · blocks separated by blank line', () => {
    const ctx1: TerminalContext = { id: 'a', label: 'first', text: 'x', pinnedAt: 0 };
    const ctx2: TerminalContext = { id: 'b', label: 'second', text: 'y', pinnedAt: 1 };
    const out = formatTerminalContextPrefix([ctx1, ctx2]);
    expect(out.indexOf('first')).toBeLessThan(out.indexOf('second'));
    expect(out).toMatch(/first[\s\S]*\n\n<terminal_context label="second"/);
  });

  test('label sanitization — < > " replaced with _', () => {
    const ctx: TerminalContext = {
      id: 'tc',
      label: 'oops <script> "tag"',
      text: 'x',
      pinnedAt: 0,
    };
    const out = formatTerminalContextPrefix([ctx]);
    expect(out).toContain('label="oops _script_ _tag_"');
    expect(out).not.toContain('<script>');
  });
});

describe('Showroom runtime · defaultTerminalContextLabel (P4)', () => {
  test('format: terminal · N lines · HH:MM', () => {
    const now = new Date(2026, 4, 8, 17, 30, 0).getTime(); // 2026-05-08 17:30
    const out = defaultTerminalContextLabel('a\nb\nc', now);
    expect(out).toBe('terminal · 3 lines · 17:30');
  });

  test('1 line text', () => {
    const now = new Date(2026, 4, 8, 9, 5, 0).getTime();
    const out = defaultTerminalContextLabel('only one', now);
    expect(out).toBe('terminal · 1 lines · 09:05');
  });
});

describe('Showroom runtime · newTerminalContextId (P4)', () => {
  test('starts with tc- · unique', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i += 1) ids.add(newTerminalContextId());
    expect(ids.size).toBe(20);
    [...ids].forEach((id) => expect(id.startsWith('tc-')).toBe(true));
  });
});

describe('Showroom runtime · buildMultiLlmHint (DM-2)', () => {
  test('returns null when no live chat panels', () => {
    const panels = [
      panel('p1', 'claude', 'mute'),
      panel('p2', 'gemini', 'freeze'),
    ];
    expect(buildMultiLlmHint(panels)).toBeNull();
  });

  test('builds hint targeting only live chat panels', () => {
    const panels = [
      panel('p1', 'claude', 'live'),
      panel('p2', 'gemini', 'mute'),
      panel('p3', 'grok', 'live'),
    ];
    const hint = buildMultiLlmHint(panels);
    expect(hint).not.toBeNull();
    expect(hint!.targets).toHaveLength(2);
    expect(hint!.targets.map((t) => t.id)).toEqual(['p1', 'p3']);
    expect(hint!.targets[0]!.provider).toBe('claude');
  });

  test('historyMode opt forwarded', () => {
    const panels = [panel('p1', 'claude', 'live')];
    const hint = buildMultiLlmHint(panels, { historyMode: 'mixed' });
    expect(hint?.historyMode).toBe('mixed');
  });

  test('default historyMode unset (isolated 의 daemon-side default 사용)', () => {
    const panels = [panel('p1', 'claude', 'live')];
    const hint = buildMultiLlmHint(panels);
    expect(hint?.historyMode).toBeUndefined();
  });
});

describe('Showroom runtime · wrapMultiLlmMeta (DM-2)', () => {
  test('wraps hint in _meta.elanous.multiLlm envelope', () => {
    const hint = { targets: [{ id: 'p1', provider: 'claude' }] };
    const meta = wrapMultiLlmMeta(hint);
    expect(meta).toEqual({ elanous: { multiLlm: hint } });
  });
});

describe('Showroom runtime · parseMultiLlmUpdateMeta (DM-2)', () => {
  test('returns null for legacy single-LLM update (no _meta)', () => {
    expect(parseMultiLlmUpdateMeta({ sessionUpdate: 'agent_message_chunk' }))
      .toBeNull();
  });

  test('returns null for _meta without elanous namespace', () => {
    expect(parseMultiLlmUpdateMeta({ _meta: { source: 'pwa' } }))
      .toBeNull();
  });

  test('parses modelId + provider', () => {
    const meta = parseMultiLlmUpdateMeta({
      _meta: { elanous: { modelId: 'p1', provider: 'claude' } },
    });
    expect(meta).toEqual({ modelId: 'p1', provider: 'claude' });
  });

  test('parses stopReason end_turn', () => {
    const meta = parseMultiLlmUpdateMeta({
      _meta: {
        elanous: { modelId: 'p1', stopReason: 'end_turn' },
      },
    });
    expect(meta?.stopReason).toBe('end_turn');
  });

  test('parses error stopReason with message', () => {
    const meta = parseMultiLlmUpdateMeta({
      _meta: {
        elanous: { modelId: 'p2', stopReason: 'error', error: 'boom' },
      },
    });
    expect(meta?.stopReason).toBe('error');
    expect(meta?.error).toBe('boom');
  });

  test('drops invalid stopReason silently', () => {
    const meta = parseMultiLlmUpdateMeta({
      _meta: { elanous: { modelId: 'p1', stopReason: 'banana' } },
    });
    expect(meta?.modelId).toBe('p1');
    expect(meta?.stopReason).toBeUndefined();
  });

  test('returns null when modelId is missing', () => {
    expect(
      parseMultiLlmUpdateMeta({ _meta: { elanous: { provider: 'claude' } } }),
    ).toBeNull();
  });
});

describe('Showroom runtime · formatPriorAnswerPrefix (DM-3)', () => {
  test('empty array returns empty string', () => {
    expect(formatPriorAnswerPrefix([])).toBe('');
  });

  test('1 prior answer — block with source + provider attrs', () => {
    const pa: PriorAnswer = {
      id: 'pa1',
      label: '@codex · 17:30',
      text: 'I think we should refactor.',
      sourcePanelId: 'p1',
      sourceProvider: 'codex',
      promotedAt: 0,
      turnNumber: 1,
      enabled: true,
    };
    const out = formatPriorAnswerPrefix([pa]);
    expect(out).toContain('<prior_answer source="@codex · 17:30" provider="codex">');
    expect(out).toContain('I think we should refactor.');
    expect(out).toContain('</prior_answer>');
    expect(out.endsWith('\n\n')).toBe(true);
  });

  test('order preserved · multiple blocks separated by blank line', () => {
    const pa1: PriorAnswer = {
      id: 'a', label: 'first', text: 'x', sourcePanelId: 'p1',
      sourceProvider: 'claude', promotedAt: 0, turnNumber: 1, enabled: true,
    };
    const pa2: PriorAnswer = {
      id: 'b', label: 'second', text: 'y', sourcePanelId: 'p2',
      sourceProvider: 'gemini', promotedAt: 1, turnNumber: 2, enabled: true,
    };
    const out = formatPriorAnswerPrefix([pa1, pa2]);
    expect(out.indexOf('first')).toBeLessThan(out.indexOf('second'));
    expect(out).toMatch(/first[\s\S]*\n\n<prior_answer source="second"/);
  });

  test('label + provider sanitization', () => {
    const pa: PriorAnswer = {
      id: 'pa', label: 'oops <bad>', text: 'x', sourcePanelId: 'p',
      sourceProvider: 'has"quote', promotedAt: 0, turnNumber: 1, enabled: true,
    };
    const out = formatPriorAnswerPrefix([pa]);
    expect(out).toContain('source="oops _bad_"');
    expect(out).toContain('provider="has_quote"');
    expect(out).not.toContain('<bad>');
  });

  // §3.4 (BACKLOG-showroom-cv-3-post-dm-stage-4-2026-05-09): multi-select.
  test('disabled chip skipped — only enabled chips render in prefix', () => {
    const on: PriorAnswer = {
      id: 'on', label: 'kept', text: 'kept-text', sourcePanelId: 'p1',
      sourceProvider: 'claude', promotedAt: 0, turnNumber: 1, enabled: true,
    };
    const off: PriorAnswer = {
      id: 'off', label: 'skipped', text: 'skipped-text', sourcePanelId: 'p2',
      sourceProvider: 'gemini', promotedAt: 1, turnNumber: 2, enabled: false,
    };
    const out = formatPriorAnswerPrefix([on, off]);
    expect(out).toContain('kept-text');
    expect(out).not.toContain('skipped-text');
    expect(out).not.toContain('skipped');
  });

  test('all chips disabled → empty prefix', () => {
    const off1: PriorAnswer = {
      id: 'a', label: 'a', text: 'x', sourcePanelId: 'p',
      sourceProvider: 'claude', promotedAt: 0, turnNumber: 1, enabled: false,
    };
    const off2: PriorAnswer = {
      id: 'b', label: 'b', text: 'y', sourcePanelId: 'p',
      sourceProvider: 'gemini', promotedAt: 1, turnNumber: 2, enabled: false,
    };
    expect(formatPriorAnswerPrefix([off1, off2])).toBe('');
  });
});

describe('Showroom runtime · defaultPriorAnswerLabel (DM-3)', () => {
  test('format: @<displayName> · HH:MM', () => {
    const panels = [panel('p1', 'codex', 'live')];
    const now = new Date(2026, 4, 8, 17, 30, 0).getTime();
    expect(defaultPriorAnswerLabel(panels[0]!, panels, now)).toBe('@codex · 17:30');
  });

  test('honors D12 numeric suffix (duplicate provider)', () => {
    const panels = [
      panel('p1', 'claude', 'live'),
      panel('p2', 'claude', 'live'),
    ];
    const now = new Date(2026, 4, 8, 9, 5, 0).getTime();
    expect(defaultPriorAnswerLabel(panels[1]!, panels, now)).toBe('@claude-2 · 09:05');
  });

  // §3.4 — turn number prefix.
  test('turnNumber > 0 → label has T{n} prefix', () => {
    const panels = [panel('p1', 'codex', 'live')];
    const now = new Date(2026, 4, 8, 17, 30, 0).getTime();
    expect(defaultPriorAnswerLabel(panels[0]!, panels, now, 3)).toBe('T3 @codex · 17:30');
  });

  test('turnNumber 0 → no prefix (legacy callers · backwards compat)', () => {
    const panels = [panel('p1', 'codex', 'live')];
    const now = new Date(2026, 4, 8, 17, 30, 0).getTime();
    expect(defaultPriorAnswerLabel(panels[0]!, panels, now, 0)).toBe('@codex · 17:30');
    // Default param when omitted = 0 too.
    expect(defaultPriorAnswerLabel(panels[0]!, panels, now)).toBe('@codex · 17:30');
  });
});

describe('Showroom runtime · newPriorAnswerId (DM-3)', () => {
  test('starts with pa- · unique', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i += 1) ids.add(newPriorAnswerId());
    expect(ids.size).toBe(20);
    [...ids].forEach((id) => expect(id.startsWith('pa-')).toBe(true));
  });
});

import { autoUnmuteForDispatch, matchMentionTypeahead } from './runtime';

describe('Showroom runtime · matchMentionTypeahead (P2.5)', () => {
  const panels = [
    panel('p1', 'claude', 'live'),
    panel('p2', 'gemini', 'live'),
    panel('p3', 'codex', 'mute'),
  ];

  test('returns null when cursor not after @', () => {
    expect(matchMentionTypeahead('hello world', 5, panels)).toBeNull();
  });

  test('returns full panel list for bare `@` cursor', () => {
    const m = matchMentionTypeahead('@', 1, panels);
    expect(m).not.toBeNull();
    expect(m!.partial).toBe('');
    expect(m!.matches.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(m!.allMatches).toBe(true);
  });

  test('returns prefix-matching panels', () => {
    const m = matchMentionTypeahead('hello @cl', 9, panels);
    expect(m).not.toBeNull();
    expect(m!.partial).toBe('cl');
    expect(m!.matches.map((p) => p.id)).toEqual(['p1']);
    expect(m!.allMatches).toBe(false);
  });

  test('case-insensitive partial', () => {
    const m = matchMentionTypeahead('@CO', 3, panels);
    expect(m?.matches.map((p) => p.id)).toEqual(['p3']);
  });

  test('@all 후보 단독', () => {
    const m = matchMentionTypeahead('@al', 3, panels);
    expect(m?.allMatches).toBe(true);
    expect(m?.matches).toEqual([]);
  });

  test('not preceded by whitespace returns null', () => {
    expect(matchMentionTypeahead('user@dom', 8, panels)).toBeNull();
  });

  test('tokenStart + tokenEnd offsets accurate', () => {
    // '0123456789'
    // 'hi @gem'
    //  0123456 → cursor=7
    const m = matchMentionTypeahead('hi @gem', 7, panels);
    expect(m).not.toBeNull();
    expect(m!.tokenStart).toBe(3); // '@'
    expect(m!.tokenEnd).toBe(7);   // cursor
  });

  test('returns null after space following partial', () => {
    expect(matchMentionTypeahead('@gem ', 5, panels)).toBeNull();
  });
});

describe('Showroom runtime · autoUnmuteForDispatch (P2.5)', () => {
  test('mute panel mentioned → flipped to live', () => {
    const panels = [
      panel('p1', 'claude', 'live'),
      panel('p2', 'gemini', 'mute'),
    ];
    const next = autoUnmuteForDispatch(panels, ['p2']);
    expect(next[0]!.state).toBe('live');
    expect(next[1]!.state).toBe('live');
  });

  test('freeze panel mentioned → stays freeze (의도 존중)', () => {
    const panels = [panel('p1', 'codex', 'freeze')];
    const next = autoUnmuteForDispatch(panels, ['p1']);
    expect(next[0]!.state).toBe('freeze');
  });

  test('non-mentioned mute panels untouched', () => {
    const panels = [
      panel('p1', 'claude', 'live'),
      panel('p2', 'gemini', 'mute'),
    ];
    const next = autoUnmuteForDispatch(panels, ['p1']);
    expect(next[1]!.state).toBe('mute');
  });

  test('empty mentions → returns clone', () => {
    const panels = [panel('p1', 'claude', 'live')];
    const next = autoUnmuteForDispatch(panels, []);
    expect(next).toEqual(panels);
    expect(next).not.toBe(panels);
  });

  test('all-live panels → no change', () => {
    const panels = [
      panel('p1', 'claude', 'live'),
      panel('p2', 'gemini', 'live'),
    ];
    const next = autoUnmuteForDispatch(panels, ['p1', 'p2']);
    expect(next.every((p) => p.state === 'live')).toBe(true);
  });
});

describe('Showroom runtime · stripMentions (P2)', () => {
  test('removes @name tokens · normalizes whitespace', () => {
    expect(stripMentions('@claude please review')).toBe('please review');
    expect(stripMentions('@claude @gemini compare')).toBe('compare');
    expect(stripMentions('hello @all there')).toBe('hello there');
  });

  test('no mention → unchanged (trimmed)', () => {
    expect(stripMentions('  hello world  ')).toBe('hello world');
  });

  test('preserves email-style addresses (no mention regex match if not at word start)', () => {
    // Note: parser is intentionally simple — `user@domain` will be
    // partly matched. P2 minimum acceptable. Future tighten in P3+.
    expect(stripMentions('hi user@domain.com')).toBe('hi user.com');
  });
});

// ─── P5 — agent CLI panel kind ──────────────────────────────────────

import {
  agentBrandToProvider,
  newAgentPanel,
  newChatPanel,
  SHOWROOM_AGENT_BRANDS,
} from './runtime';
import type { ShowroomAgentBrand } from './types';

describe('Showroom runtime · P5 agent panel · SHOWROOM_AGENT_BRANDS', () => {
  test('exposes 3 brands · codex/claude/gemini in canonical order', () => {
    expect(SHOWROOM_AGENT_BRANDS).toEqual(['codex', 'claude', 'gemini']);
  });
});

describe('Showroom runtime · P5 · agentBrandToProvider (D2)', () => {
  test('locks brand → provider 1:1 (P5 minimum · 동일 LLM API path)', () => {
    expect(agentBrandToProvider('codex')).toBe('codex');
    expect(agentBrandToProvider('claude')).toBe('claude');
    expect(agentBrandToProvider('gemini')).toBe('gemini');
  });
});

import { agentBrandToBackend } from './runtime';

describe('Showroom runtime · P5.x · agentBrandToBackend (#1959 real CLI spawn)', () => {
  test('codex → codex-app-server (transport-specific)', () => {
    expect(agentBrandToBackend('codex')).toBe('codex-app-server');
  });
  test('claude → claude (plain ACP stdio)', () => {
    expect(agentBrandToBackend('claude')).toBe('claude');
  });
  test('gemini → gemini (plain ACP stdio)', () => {
    expect(agentBrandToBackend('gemini')).toBe('gemini');
  });
  test('mirrors nexus chat backend-mapping canonical AcpBackendIdLike', () => {
    // 3 brands map to exactly 3 distinct backend ids.
    const ids = new Set([
      agentBrandToBackend('codex'),
      agentBrandToBackend('claude'),
      agentBrandToBackend('gemini'),
    ]);
    expect(ids.size).toBe(3);
  });
});

describe('Showroom runtime · P5 · newAgentPanel', () => {
  test('builds agent panel with kind=agent · brand set · provider locked', () => {
    const p = newAgentPanel('codex');
    expect(p.kind).toBe('agent');
    expect(p.agentBrand).toBe('codex');
    expect(p.provider).toBe('codex');
    expect(p.state).toBe('live');
    expect(p.sessionId).toBeNull();
    expect(p.id).toMatch(/^p-/);
  });

  test('all 3 brands → independent ids', () => {
    const a = newAgentPanel('codex');
    const b = newAgentPanel('claude');
    const c = newAgentPanel('gemini');
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    expect(a.agentBrand).toBe('codex');
    expect(b.agentBrand).toBe('claude');
    expect(c.agentBrand).toBe('gemini');
  });
});

describe('Showroom runtime · P5 · newChatPanel', () => {
  test('default chat panel · empty provider · no agentBrand', () => {
    const p = newChatPanel();
    expect(p.kind).toBe('chat');
    expect(p.provider).toBe('');
    expect(p.agentBrand).toBeUndefined();
    expect(p.state).toBe('live');
  });

  test('explicit provider preserved', () => {
    const p = newChatPanel('claude');
    expect(p.kind).toBe('chat');
    expect(p.provider).toBe('claude');
    expect(p.agentBrand).toBeUndefined();
  });
});

describe('Showroom runtime · P5 · panelDisplayName (D3 agent suffix)', () => {
  test('agent panel solo → `${brand}-cli`', () => {
    const p = newAgentPanel('codex');
    expect(panelDisplayName(p, [p])).toBe('codex-cli');
  });

  test('chat codex + agent codex 분리 namespace (no collision)', () => {
    const chat: ShowroomPanel = panel('c1', 'codex', 'live');
    const agent = newAgentPanel('codex');
    const all = [chat, agent];
    expect(panelDisplayName(chat, all)).toBe('codex');
    expect(panelDisplayName(agent, all)).toBe('codex-cli');
  });

  test('two same-brand agents get numeric suffix', () => {
    const a = newAgentPanel('claude');
    const b = newAgentPanel('claude');
    const all = [a, b];
    expect(panelDisplayName(a, all)).toBe('claude-cli-1');
    expect(panelDisplayName(b, all)).toBe('claude-cli-2');
  });

  test('mixed agents + chat — brand suffix only collides with same brand', () => {
    const chatClaude: ShowroomPanel = panel('c1', 'claude', 'live');
    const agentClaudeA = newAgentPanel('claude');
    const agentClaudeB = newAgentPanel('claude');
    const agentCodex = newAgentPanel('codex');
    const all = [chatClaude, agentClaudeA, agentClaudeB, agentCodex];
    expect(panelDisplayName(chatClaude, all)).toBe('claude');
    expect(panelDisplayName(agentClaudeA, all)).toBe('claude-cli-1');
    expect(panelDisplayName(agentClaudeB, all)).toBe('claude-cli-2');
    expect(panelDisplayName(agentCodex, all)).toBe('codex-cli');
  });
});

describe('Showroom runtime · P5 · agent panel mention typeahead (D3)', () => {
  test('matchMentionTypeahead picks up agent panel by brand suffix', () => {
    const a = newAgentPanel('codex');
    const c = newChatPanel('claude');
    const all = [a, c];
    const m = matchMentionTypeahead('@cod', 4, all);
    expect(m).not.toBeNull();
    expect(m!.matches.map((p) => p.id)).toEqual([a.id]);
  });

  test('parseMentions picks up agent CLI brand by `@${brand}-cli`', () => {
    const a = newAgentPanel('gemini');
    const c = newChatPanel('claude');
    const all = [a, c];
    const r = parseMentions('@gemini-cli 비교', all);
    expect(r.targets.map((p) => p.id)).toEqual([a.id]);
  });
});

describe('Showroom runtime · P5 · buildMultiLlmHint excludes agent panels by default', () => {
  test('agent kind 은 multi-LLM hint 에 미포함 (DM 은 chat 전용 P5 minimum)', () => {
    const c = newChatPanel('claude');
    const a = newAgentPanel('codex');
    const hint = buildMultiLlmHint([c, a]);
    expect(hint).not.toBeNull();
    expect(hint!.targets.map((t) => t.provider)).toEqual(['claude']);
  });

  // DM stage 2 (FU · #1976) — opt-in agent inclusion via includeAgent flag.
  test('includeAgent: true 시 agent panel 도 hint targets 에 포함', () => {
    const c = newChatPanel('claude');
    const a = newAgentPanel('codex');
    const hint = buildMultiLlmHint([c, a], { includeAgent: true });
    expect(hint).not.toBeNull();
    expect(hint!.targets).toHaveLength(2);
    expect(hint!.targets.map((t) => t.provider).sort()).toEqual(['claude', 'codex']);
  });

  // DM stage 2 (#1982 follow-up) — agent target carries kind + backend.
  test('agent target with includeAgent → kind=agent + backend mapping', () => {
    const codexAgent = newAgentPanel('codex');
    const claudeAgent = newAgentPanel('claude');
    const geminiAgent = newAgentPanel('gemini');
    const chat = newChatPanel('claude');
    const hint = buildMultiLlmHint([codexAgent, claudeAgent, geminiAgent, chat], { includeAgent: true });
    expect(hint).not.toBeNull();
    expect(hint!.targets).toHaveLength(4);
    const byId = new Map(hint!.targets.map((t) => [t.id, t]));
    expect(byId.get(codexAgent.id)!.kind).toBe('agent');
    expect(byId.get(codexAgent.id)!.backend).toBe('codex-app-server');
    expect(byId.get(claudeAgent.id)!.kind).toBe('agent');
    expect(byId.get(claudeAgent.id)!.backend).toBe('claude');
    expect(byId.get(geminiAgent.id)!.kind).toBe('agent');
    expect(byId.get(geminiAgent.id)!.backend).toBe('gemini');
    expect(byId.get(chat.id)!.kind).toBeUndefined();
    expect(byId.get(chat.id)!.backend).toBeUndefined();
  });

  test('agent only + includeAgent → hint with agent targets', () => {
    const a = newAgentPanel('claude');
    const hint = buildMultiLlmHint([a], { includeAgent: true });
    expect(hint).not.toBeNull();
    expect(hint!.targets).toHaveLength(1);
    expect(hint!.targets[0]!.provider).toBe('claude');
  });

  test('agent only without includeAgent → null (default chat-only)', () => {
    const a = newAgentPanel('codex');
    expect(buildMultiLlmHint([a])).toBeNull();
  });
});

// brand 변수 정합성 sanity check — type-level guarantee 만 확인.
const _typeCheck: ShowroomAgentBrand[] = ['codex', 'claude', 'gemini'];
void _typeCheck;

// ─── DM-4 — daemon multi-LLM mode toggle (full migration) ───────────

import {
  DM_MODE_LOCALSTORAGE_KEY,
  readDmModeFromStorage,
  writeDmModeToStorage,
} from './runtime';

describe('Showroom runtime · DM stage 3 default-ON toggle persistence', () => {
  // Each test runs in isolation w.r.t. localStorage — bun test injects
  // a real localStorage in PWA env; outside PWA the helpers fall back
  // to noop (typeof window === 'undefined' branch).
  const isBrowserEnv =
    typeof globalThis !== 'undefined'
    && typeof (globalThis as { window?: { localStorage?: unknown } }).window !== 'undefined'
    && Boolean((globalThis as { window?: { localStorage?: unknown } }).window?.localStorage);

  test('LocalStorage key is canonical · documented for backwards compat', () => {
    expect(DM_MODE_LOCALSTORAGE_KEY).toBe('elanous.showroom.dmMode');
  });

  test('default = true (no entry · DM stage 3 default-ON · ON in SSR)', () => {
    if (isBrowserEnv) {
      window.localStorage.removeItem(DM_MODE_LOCALSTORAGE_KEY);
    }
    expect(readDmModeFromStorage()).toBe(true);
  });

  test('write true · removes key (default state) · read true', () => {
    if (!isBrowserEnv) return; // noop in SSR
    // Pre-populate with explicit-off so write(true) has something to clear.
    window.localStorage.setItem(DM_MODE_LOCALSTORAGE_KEY, 'false');
    writeDmModeToStorage(true);
    expect(window.localStorage.getItem(DM_MODE_LOCALSTORAGE_KEY)).toBeNull();
    expect(readDmModeFromStorage()).toBe(true);
  });

  test('write false · stores `"false"` · read false (explicit OFF override)', () => {
    if (!isBrowserEnv) return;
    writeDmModeToStorage(false);
    expect(window.localStorage.getItem(DM_MODE_LOCALSTORAGE_KEY)).toBe('false');
    expect(readDmModeFromStorage()).toBe(false);
    window.localStorage.removeItem(DM_MODE_LOCALSTORAGE_KEY);
  });

  test('legacy `"true"` value still reads as true (backwards compat)', () => {
    if (!isBrowserEnv) return;
    window.localStorage.setItem(DM_MODE_LOCALSTORAGE_KEY, 'true');
    expect(readDmModeFromStorage()).toBe(true);
    window.localStorage.removeItem(DM_MODE_LOCALSTORAGE_KEY);
  });

  test('any non-`"false"` value reads as true (only `"false"` opts out)', () => {
    if (!isBrowserEnv) return;
    window.localStorage.setItem(DM_MODE_LOCALSTORAGE_KEY, 'maybe');
    expect(readDmModeFromStorage()).toBe(true);
    window.localStorage.removeItem(DM_MODE_LOCALSTORAGE_KEY);
  });
});

// §6.7 — agent-to-agent direct routing (chain edges)
describe('Showroom runtime · newChainEdgeId (§6.7)', () => {
  test('returns ce- prefix · uniqueness over 20 calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i += 1) ids.add(newChainEdgeId());
    expect(ids.size).toBe(20);
    for (const id of ids) expect(id.startsWith('ce-')).toBe(true);
  });
});

describe('Showroom runtime · addChainEdge (§6.7)', () => {
  test('happy path · ok=true · edge appended · default wrapMode=prior · enabled=true', () => {
    const result = addChainEdge([], 'p1', 'p2');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edge.fromPanelId).toBe('p1');
    expect(result.edge.toPanelId).toBe('p2');
    expect(result.edge.wrapMode).toBe('prior');
    expect(result.edge.enabled).toBe(true);
    expect(result.edge.routePrompt).toBeUndefined();
    expect(result.edges.length).toBe(1);
    expect(result.edges[0]).toBe(result.edge);
  });

  test('opts forward · wrapMode=plain · routePrompt trimmed · enabled=false', () => {
    const result = addChainEdge([], 'p1', 'p2', {
      wrapMode: 'plain',
      routePrompt: '  검토:  ',
      enabled: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edge.wrapMode).toBe('plain');
    expect(result.edge.routePrompt).toBe('검토:');
    expect(result.edge.enabled).toBe(false);
  });

  test('routePrompt empty after trim → undefined', () => {
    const result = addChainEdge([], 'p1', 'p2', { routePrompt: '   ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edge.routePrompt).toBeUndefined();
  });

  test('D3 — hitl:true opts forwards to edge.hitl', () => {
    const result = addChainEdge([], 'p1', 'p2', { hitl: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edge.hitl).toBe(true);
  });

  test('D3 — hitl omitted → edge.hitl undefined (default auto-forward)', () => {
    const result = addChainEdge([], 'p1', 'p2');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edge.hitl).toBeUndefined();
  });

  test('D3 — hitl:false omitted from edge (explicit false ≡ default)', () => {
    const result = addChainEdge([], 'p1', 'p2', { hitl: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edge.hitl).toBeUndefined();
  });

  test('self-route reject · reason=self-route', () => {
    const result = addChainEdge([], 'p1', 'p1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('self-route');
  });

  test('duplicate reject · reason=duplicate', () => {
    const first = addChainEdge([], 'p1', 'p2');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = addChainEdge(first.edges, 'p1', 'p2');
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('duplicate');
  });

  test('cycle reject · reason=cycle (p1→p2 + p2→p1 reject)', () => {
    const r1 = addChainEdge([], 'p1', 'p2');
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = addChainEdge(r1.edges, 'p2', 'p1');
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe('cycle');
  });

  test('cycle reject · 3-hop chain (p1→p2→p3 + p3→p1 reject)', () => {
    const e1 = addChainEdge([], 'p1', 'p2');
    expect(e1.ok).toBe(true); if (!e1.ok) return;
    const e2 = addChainEdge(e1.edges, 'p2', 'p3');
    expect(e2.ok).toBe(true); if (!e2.ok) return;
    const e3 = addChainEdge(e2.edges, 'p3', 'p1');
    expect(e3.ok).toBe(false); if (e3.ok) return;
    expect(e3.reason).toBe('cycle');
  });

  test('non-cycle directed extension OK (p1→p2→p3 + p1→p3 also OK · DAG)', () => {
    const e1 = addChainEdge([], 'p1', 'p2');
    expect(e1.ok).toBe(true); if (!e1.ok) return;
    const e2 = addChainEdge(e1.edges, 'p2', 'p3');
    expect(e2.ok).toBe(true); if (!e2.ok) return;
    const e3 = addChainEdge(e2.edges, 'p1', 'p3');
    expect(e3.ok).toBe(true); if (!e3.ok) return;
    expect(e3.edges.length).toBe(3);
  });

  test('immutable input · existing edges array not mutated', () => {
    const initial: ChainEdge[] = [];
    const result = addChainEdge(initial, 'p1', 'p2');
    expect(result.ok).toBe(true);
    expect(initial.length).toBe(0);
  });
});

describe('Showroom runtime · removeChainEdge (§6.7)', () => {
  test('removes target edge by id · returns new array', () => {
    const r = addChainEdge([], 'p1', 'p2');
    expect(r.ok).toBe(true); if (!r.ok) return;
    const after = removeChainEdge(r.edges, r.edge.id);
    expect(after.length).toBe(0);
    expect(r.edges.length).toBe(1);
  });

  test('unknown id · same content array (no-op)', () => {
    const r = addChainEdge([], 'p1', 'p2');
    expect(r.ok).toBe(true); if (!r.ok) return;
    const after = removeChainEdge(r.edges, 'unknown-id');
    expect(after.length).toBe(1);
    expect(after[0]?.id).toBe(r.edge.id);
  });
});

describe('Showroom runtime · findEdgesFrom (§6.7)', () => {
  test('returns outgoing edges from given panel', () => {
    const e1 = addChainEdge([], 'p1', 'p2');
    expect(e1.ok).toBe(true); if (!e1.ok) return;
    const e2 = addChainEdge(e1.edges, 'p1', 'p3');
    expect(e2.ok).toBe(true); if (!e2.ok) return;
    const e3 = addChainEdge(e2.edges, 'p2', 'p3');
    expect(e3.ok).toBe(true); if (!e3.ok) return;
    const fromP1 = findEdgesFrom(e3.edges, 'p1');
    expect(fromP1.length).toBe(2);
    expect(fromP1.map((e) => e.toPanelId).sort()).toEqual(['p2', 'p3']);
    const fromP2 = findEdgesFrom(e3.edges, 'p2');
    expect(fromP2.length).toBe(1);
    expect(fromP2[0]?.toPanelId).toBe('p3');
    const fromP3 = findEdgesFrom(e3.edges, 'p3');
    expect(fromP3.length).toBe(0);
  });
});

describe('Showroom runtime · pruneEdgesForPanel (§6.7)', () => {
  test('removes edges whose endpoint is given panel', () => {
    const e1 = addChainEdge([], 'p1', 'p2');
    expect(e1.ok).toBe(true); if (!e1.ok) return;
    const e2 = addChainEdge(e1.edges, 'p2', 'p3');
    expect(e2.ok).toBe(true); if (!e2.ok) return;
    const e3 = addChainEdge(e2.edges, 'p1', 'p3');
    expect(e3.ok).toBe(true); if (!e3.ok) return;
    // close p2 — removes p1→p2 and p2→p3 (keeps p1→p3)
    const after = pruneEdgesForPanel(e3.edges, 'p2');
    expect(after.length).toBe(1);
    expect(after[0]?.fromPanelId).toBe('p1');
    expect(after[0]?.toPanelId).toBe('p3');
  });

  test('no-op preserves array contents · returned array does not mutate input', () => {
    const e1 = addChainEdge([], 'p1', 'p2');
    expect(e1.ok).toBe(true); if (!e1.ok) return;
    const after = pruneEdgesForPanel(e1.edges, 'p9');
    expect(after.length).toBe(1);
    expect(after[0]?.id).toBe(e1.edge.id);
  });
});

describe('Showroom runtime · wouldCreateCycle (§6.7)', () => {
  test('self-route counts as cycle', () => {
    expect(wouldCreateCycle([], 'p1', 'p1')).toBe(true);
  });

  test('empty graph + non-self → no cycle', () => {
    expect(wouldCreateCycle([], 'p1', 'p2')).toBe(false);
  });

  test('back-edge in 2-node → cycle', () => {
    const r = addChainEdge([], 'p1', 'p2');
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(wouldCreateCycle(r.edges, 'p2', 'p1')).toBe(true);
  });

  test('forward DAG extension → no cycle', () => {
    const r = addChainEdge([], 'p1', 'p2');
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(wouldCreateCycle(r.edges, 'p2', 'p3')).toBe(false);
    expect(wouldCreateCycle(r.edges, 'p1', 'p3')).toBe(false);
  });
});

describe('Showroom runtime · composeForwardText (§6.7)', () => {
  function edge(wrapMode: 'plain' | 'prior', routePrompt?: string): ChainEdge {
    return {
      id: 'ce-test',
      fromPanelId: 'p1',
      toPanelId: 'p2',
      wrapMode,
      ...(routePrompt ? { routePrompt } : {}),
      enabled: true,
      createdAt: 0,
    };
  }

  test('wrap=plain · returns sourceText 그대로', () => {
    const out = composeForwardText(
      edge('plain'),
      'Hello world.',
      'codex',
      '@codex',
    );
    expect(out).toBe('Hello world.');
  });

  test('wrap=prior · default route prompt', () => {
    const out = composeForwardText(
      edge('prior'),
      'Codex answer body.',
      'codex',
      '@codex',
    );
    expect(out).toContain('<prior_answer source="@codex" provider="codex">');
    expect(out).toContain('Codex answer body.');
    expect(out).toContain('</prior_answer>');
    expect(out).toContain(DEFAULT_ROUTE_PROMPT);
  });

  test('wrap=prior · custom route prompt 사용', () => {
    const out = composeForwardText(
      edge('prior', '비판적으로 검토해주세요.'),
      'Source text',
      'claude',
      '@claude',
    );
    expect(out).toContain('비판적으로 검토해주세요.');
    expect(out).not.toContain(DEFAULT_ROUTE_PROMPT);
  });

  test('wrap=prior · label / provider injection escapes <>"', () => {
    const out = composeForwardText(
      edge('prior'),
      'Body',
      'has"quote',
      '@inj<ect>',
    );
    expect(out).toContain('source="@inj_ect_"');
    expect(out).toContain('provider="has_quote"');
  });
});

// §6.1 — role classifier (auto @target by prompt)
describe('Showroom runtime · classifyPromptRole (§6.1)', () => {
  test('plan keywords (Korean + English)', () => {
    expect(classifyPromptRole('새 기능 계획 짜줘')).toBe('plan');
    expect(classifyPromptRole('Let us plan the migration')).toBe('plan');
    expect(classifyPromptRole('아키텍처 설계 부탁해')).toBe('plan');
    expect(classifyPromptRole('design a state machine')).toBe('plan');
  });

  test('exec keywords', () => {
    expect(classifyPromptRole('이 함수 구현해줘')).toBe('exec');
    expect(classifyPromptRole('implement the parser')).toBe('exec');
    expect(classifyPromptRole('Let me write code for this')).toBe('exec');
    expect(classifyPromptRole('build the dashboard')).toBe('exec');
  });

  test('review keywords', () => {
    expect(classifyPromptRole('이 PR 리뷰 부탁')).toBe('review');
    expect(classifyPromptRole('please review this diff')).toBe('review');
    expect(classifyPromptRole('이 설계 검토해주세요')).toBe('review');
  });

  test('reflect keywords', () => {
    expect(classifyPromptRole('이 sprint 회고 정리해줘')).toBe('reflect');
    expect(classifyPromptRole('Let us run a retrospective')).toBe('reflect');
    expect(classifyPromptRole('postmortem for the outage')).toBe('reflect');
  });

  test('priority — plan beats exec when both keywords present', () => {
    // "계획" + "구현" — plan first per ROLE_PRIORITY.
    expect(classifyPromptRole('구현 계획 짜줘')).toBe('plan');
  });

  test('case-insensitive', () => {
    expect(classifyPromptRole('IMPLEMENT this feature')).toBe('exec');
    expect(classifyPromptRole('Review THIS code')).toBe('review');
  });

  test('no keyword match → null', () => {
    expect(classifyPromptRole('hello world')).toBeNull();
    expect(classifyPromptRole('안녕')).toBeNull();
    expect(classifyPromptRole('')).toBeNull();
  });

  test('roleKeywordsFor exposes per-role keywords (smoke)', () => {
    const roles: ShowroomRoleHint[] = ['plan', 'exec', 'review', 'reflect'];
    for (const r of roles) {
      const kws = roleKeywordsFor(r);
      expect(kws.length).toBeGreaterThan(0);
    }
  });
});

describe('Showroom runtime · planDispatch §6.1 role-classify route', () => {
  function rolePanel(
    id: string,
    provider: string,
    state: ShowroomPanel['state'],
    roleHint?: ShowroomRoleHint,
  ): ShowroomPanel {
    const p: ShowroomPanel = {
      id,
      kind: 'chat',
      provider,
      sessionId: `sess-${id}`,
      state,
    };
    if (roleHint) p.roleHint = roleHint;
    return p;
  }

  // Need planDispatch which is already imported in the existing block.
  test('mention 0 + role classifier hit + 1 matching panel → targeted role-classify', () => {
    const panels: ShowroomPanel[] = [
      rolePanel('p1', 'claude', 'live', 'plan'),
      rolePanel('p2', 'gemini', 'live', 'review'),
      rolePanel('p3', 'codex', 'live', 'exec'),
    ];
    const plan = planDispatch('이 함수 구현해줘', panels);
    expect(plan.mode).toBe('targeted');
    expect(plan.routedBy).toBe('role-classify');
    expect(plan.classifiedRole).toBe('exec');
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]?.id).toBe('p3');
  });

  test('explicit @mention overrides role classifier (mention always wins)', () => {
    const panels: ShowroomPanel[] = [
      rolePanel('p1', 'claude', 'live', 'plan'),
      rolePanel('p2', 'gemini', 'live', 'exec'),
    ];
    // text 가 plan keyword 포함하지만 사용자가 @gemini 명시
    const plan = planDispatch('@gemini 계획 짜줘', panels);
    expect(plan.mode).toBe('targeted');
    expect(plan.routedBy).toBe('mention');
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]?.id).toBe('p2');
  });

  test('@all forces broadcast even with role classifier hit', () => {
    const panels: ShowroomPanel[] = [
      rolePanel('p1', 'claude', 'live', 'plan'),
      rolePanel('p2', 'gemini', 'live', 'exec'),
    ];
    const plan = planDispatch('@all 구현해줘', panels);
    expect(plan.mode).toBe('broadcast');
    expect(plan.routedBy).toBeUndefined();
  });

  test('multiple panels with same role → broadcast (no auto-target)', () => {
    const panels: ShowroomPanel[] = [
      rolePanel('p1', 'claude', 'live', 'exec'),
      rolePanel('p2', 'codex', 'live', 'exec'),
      rolePanel('p3', 'gemini', 'live', 'plan'),
    ];
    const plan = planDispatch('구현해줘', panels);
    expect(plan.mode).toBe('broadcast');
    expect(plan.routedBy).toBeUndefined();
  });

  test('classifier hit but no panel with that role → broadcast', () => {
    const panels: ShowroomPanel[] = [
      rolePanel('p1', 'claude', 'live', 'plan'),
      rolePanel('p2', 'gemini', 'live', 'review'),
    ];
    const plan = planDispatch('구현해줘', panels);
    expect(plan.mode).toBe('broadcast');
    expect(plan.routedBy).toBeUndefined();
  });

  test('no classifier hit + no mention → broadcast', () => {
    const panels: ShowroomPanel[] = [
      rolePanel('p1', 'claude', 'live', 'plan'),
      rolePanel('p2', 'gemini', 'live', 'exec'),
    ];
    const plan = planDispatch('hello there', panels);
    expect(plan.mode).toBe('broadcast');
    expect(plan.routedBy).toBeUndefined();
  });

  test('role-classify ignores panel.state filter (targeted is state-agnostic)', () => {
    // 같은 role 의 1 panel · state=mute 도 매치
    const panels: ShowroomPanel[] = [
      rolePanel('p1', 'claude', 'live', 'plan'),
      rolePanel('p2', 'gemini', 'mute', 'review'),
    ];
    const plan = planDispatch('리뷰 부탁', panels);
    expect(plan.mode).toBe('targeted');
    expect(plan.routedBy).toBe('role-classify');
    expect(plan.targets[0]?.id).toBe('p2');
  });
});

// §6.4 — personaId forwarding through MultiLlmHint
describe('Showroom runtime · buildMultiLlmHint §6.4 personaId forward', () => {
  test('panel with personaId → hint target.personaId present', () => {
    const panels: ShowroomPanel[] = [
      {
        id: 'p1',
        kind: 'chat',
        provider: 'claude',
        sessionId: 'sess-p1',
        state: 'live',
        personaId: 'skeptic-claude',
      },
    ];
    const hint = buildMultiLlmHint(panels);
    expect(hint).not.toBeNull();
    expect(hint!.targets).toHaveLength(1);
    expect(hint!.targets[0]?.personaId).toBe('skeptic-claude');
  });

  test('panel without personaId → hint target.personaId undefined', () => {
    const panels: ShowroomPanel[] = [
      {
        id: 'p1',
        kind: 'chat',
        provider: 'claude',
        sessionId: 'sess-p1',
        state: 'live',
      },
    ];
    const hint = buildMultiLlmHint(panels);
    expect(hint!.targets[0]?.personaId).toBeUndefined();
  });

  test('agent panel with personaId → both kind and personaId forwarded', () => {
    const panels: ShowroomPanel[] = [
      {
        id: 'p1',
        kind: 'agent',
        provider: 'codex',
        agentBrand: 'codex',
        sessionId: 'sess-p1',
        state: 'live',
        personaId: 'codex-strict',
      },
    ];
    const hint = buildMultiLlmHint(panels, { includeAgent: true });
    expect(hint!.targets[0]?.kind).toBe('agent');
    expect(hint!.targets[0]?.personaId).toBe('codex-strict');
  });
});

// §6.3 — URL + clipboard context source helpers
import {
  defaultClipboardContextLabel,
  defaultUrlContextLabel,
  formatClipboardContextPrefix,
  formatUrlContextPrefix,
  newClipboardContextId,
  newUrlContextId,
} from './runtime';
import type { ClipboardContext, UrlContext } from './types';

describe('Showroom runtime · formatUrlContextPrefix (§6.3)', () => {
  test('empty list returns empty string', () => {
    expect(formatUrlContextPrefix([])).toBe('');
  });

  test('single context formats with url + title', () => {
    const ctx: UrlContext = {
      id: 'u1',
      label: 'Example Domain',
      url: 'https://example.com/',
      text: 'Hello world',
      fetchedAt: 0,
    };
    const out = formatUrlContextPrefix([ctx]);
    expect(out).toContain('<url_context url="https://example.com/" title="Example Domain">');
    expect(out).toContain('Hello world');
    expect(out).toContain('</url_context>');
    expect(out.endsWith('\n\n')).toBe(true);
  });

  test('escapes special chars in label and url', () => {
    const ctx: UrlContext = {
      id: 'u1',
      label: 'X<Y>"Z',
      url: 'https://example.com/?q=<test>',
      text: 'body',
      fetchedAt: 0,
    };
    const out = formatUrlContextPrefix([ctx]);
    expect(out).toContain('title="X_Y__Z"');
    expect(out).toContain('url="https://example.com/?q=_test_"');
  });
});

describe('Showroom runtime · defaultUrlContextLabel (§6.3)', () => {
  test('uses fallback when provided', () => {
    expect(defaultUrlContextLabel('https://example.com', 'Example Title')).toBe('Example Title');
  });

  test('extracts hostname when no fallback', () => {
    expect(defaultUrlContextLabel('https://example.com/path?q=1')).toBe('example.com');
  });

  test('returns raw url for non-URL strings', () => {
    expect(defaultUrlContextLabel('not-a-url')).toBe('not-a-url');
  });
});

describe('Showroom runtime · formatClipboardContextPrefix (§6.3)', () => {
  test('empty list returns empty string', () => {
    expect(formatClipboardContextPrefix([])).toBe('');
  });

  test('single context formats with label', () => {
    const ctx: ClipboardContext = {
      id: 'c1',
      label: 'clipboard · 12 chars · 17:30',
      text: 'pasted content',
      pastedAt: 0,
    };
    const out = formatClipboardContextPrefix([ctx]);
    expect(out).toContain('<clipboard_context label="clipboard · 12 chars · 17:30">');
    expect(out).toContain('pasted content');
    expect(out).toContain('</clipboard_context>');
  });

  test('escapes <>" in label', () => {
    const ctx: ClipboardContext = {
      id: 'c1',
      label: 'has<bad>"chars',
      text: 'body',
      pastedAt: 0,
    };
    const out = formatClipboardContextPrefix([ctx]);
    expect(out).toContain('label="has_bad__chars"');
  });
});

describe('Showroom runtime · defaultClipboardContextLabel (§6.3)', () => {
  test('format = clipboard · N chars · HH:MM', () => {
    const now = new Date('2026-05-09T17:30:00').getTime();
    expect(defaultClipboardContextLabel('hello world', now)).toBe('clipboard · 11 chars · 17:30');
  });
});

describe('Showroom runtime · newUrlContextId / newClipboardContextId (§6.3)', () => {
  test('uc- + cc- prefixes · uniqueness', () => {
    const u = new Set<string>();
    const c = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      u.add(newUrlContextId());
      c.add(newClipboardContextId());
    }
    expect(u.size).toBe(20);
    expect(c.size).toBe(20);
    for (const id of u) expect(id.startsWith('uc-')).toBe(true);
    for (const id of c) expect(id.startsWith('cc-')).toBe(true);
  });
});

// DM stage 3 FU (HANDOFF §3.2 · 2026-05-09) — agent CLI tool_call
// lifecycle decode + per-panel state merge.
describe('Showroom runtime · parseShowroomToolCallEvent (DM stage 3 FU)', () => {
  test('returns null for non-tool-call sessionUpdate', () => {
    expect(parseShowroomToolCallEvent({ sessionUpdate: 'agent_message_chunk' }))
      .toBeNull();
    expect(parseShowroomToolCallEvent({ sessionUpdate: 'plan' })).toBeNull();
    expect(parseShowroomToolCallEvent(null)).toBeNull();
    expect(parseShowroomToolCallEvent('not-an-object')).toBeNull();
  });

  test('returns null when toolCallId is missing or empty', () => {
    expect(parseShowroomToolCallEvent({ sessionUpdate: 'tool_call' })).toBeNull();
    expect(parseShowroomToolCallEvent({ sessionUpdate: 'tool_call', toolCallId: '' }))
      .toBeNull();
    expect(parseShowroomToolCallEvent({ sessionUpdate: 'tool_call_update', toolCallId: 42 }))
      .toBeNull();
  });

  test('decodes tool_call (initial pending) with title + rawInput', () => {
    const ev = parseShowroomToolCallEvent({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'read_file',
      rawInput: { path: 'src/foo.ts' },
      status: 'pending',
    });
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe('call');
    expect(ev!.id).toBe('tc-1');
    expect(ev!.name).toBe('read_file');
    expect(ev!.status).toBe('pending');
    expect(ev!.input).toEqual({ path: 'src/foo.ts' });
    expect(ev!.output).toBeUndefined();
  });

  test('defaults tool_call status to pending when missing or unknown', () => {
    expect(parseShowroomToolCallEvent({
      sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'x',
    })?.status).toBe('pending');
    expect(parseShowroomToolCallEvent({
      sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'x', status: 'weird',
    })?.status).toBe('pending');
  });

  test('decodes tool_call_update with completed status + rawOutput', () => {
    const ev = parseShowroomToolCallEvent({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      rawOutput: 'file body…',
    });
    expect(ev!.kind).toBe('update');
    expect(ev!.status).toBe('completed');
    expect(ev!.output).toBe('file body…');
  });

  test('falls back to failed for unknown tool_call_update status', () => {
    const ev = parseShowroomToolCallEvent({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'mystery',
    });
    expect(ev!.status).toBe('failed');
  });

  test('passes through in_progress status from tool_call_update', () => {
    const ev = parseShowroomToolCallEvent({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'in_progress',
    });
    expect(ev!.status).toBe('in_progress');
  });

  test('truncates excessively long string outputs to 240 chars + ellipsis', () => {
    const longText = 'a'.repeat(500);
    const ev = parseShowroomToolCallEvent({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      rawOutput: longText,
    });
    expect(ev!.output).toHaveLength(241); // 240 chars + ellipsis
    expect(ev!.output!.endsWith('…')).toBe(true);
  });

  test('JSON-stringifies object outputs and truncates if needed', () => {
    const ev = parseShowroomToolCallEvent({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      rawOutput: { ok: true, count: 3 },
    });
    expect(ev!.output).toContain('"ok":true');
  });

  test('ignores non-string title (defensive default to empty)', () => {
    const ev = parseShowroomToolCallEvent({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: { broken: true },
    });
    expect(ev!.name).toBe('');
  });
});

describe('Showroom runtime · applyToolCallEvent (DM stage 3 FU)', () => {
  test('inserts a fresh tool_call into an empty map', () => {
    const next = applyToolCallEvent({}, {
      kind: 'call',
      id: 'tc-1',
      name: 'read_file',
      status: 'pending',
      input: { path: 'src/foo.ts' },
    }, 1_000);
    expect(Object.keys(next)).toEqual(['tc-1']);
    expect(next['tc-1']!.startedAt).toBe(1_000);
    expect(next['tc-1']!.updatedAt).toBe(1_000);
    expect(next['tc-1']!.status).toBe('pending');
    expect(next['tc-1']!.input).toEqual({ path: 'src/foo.ts' });
  });

  test('does not mutate the previous map', () => {
    const prev: Record<string, ToolCallState> = {};
    applyToolCallEvent(prev, {
      kind: 'call', id: 'tc-1', name: 'x', status: 'pending',
    }, 1_000);
    expect(prev).toEqual({});
  });

  test('merges tool_call_update into existing entry · preserves startedAt', () => {
    const prev = applyToolCallEvent({}, {
      kind: 'call', id: 'tc-1', name: 'read_file', status: 'pending',
    }, 1_000);
    const next = applyToolCallEvent(prev, {
      kind: 'update', id: 'tc-1', name: '', status: 'completed', output: 'done',
    }, 2_000);
    expect(next['tc-1']!.startedAt).toBe(1_000);
    expect(next['tc-1']!.updatedAt).toBe(2_000);
    expect(next['tc-1']!.status).toBe('completed');
    expect(next['tc-1']!.output).toBe('done');
    expect(next['tc-1']!.name).toBe('read_file'); // preserved (empty name in update is ignored)
  });

  test('out-of-order tool_call_update without prior call seeds an entry', () => {
    const next = applyToolCallEvent({}, {
      kind: 'update', id: 'tc-1', name: 'grep', status: 'completed',
    }, 5_000);
    expect(next['tc-1']!.startedAt).toBe(5_000);
    expect(next['tc-1']!.status).toBe('completed');
    expect(next['tc-1']!.name).toBe('grep');
  });

  test('repeat tool_call (retry) refreshes the entry but keeps original startedAt', () => {
    const prev = applyToolCallEvent({}, {
      kind: 'call', id: 'tc-1', name: 'bash', status: 'pending',
    }, 1_000);
    const next = applyToolCallEvent(prev, {
      kind: 'call', id: 'tc-1', name: 'bash', status: 'pending',
    }, 7_000);
    expect(next['tc-1']!.startedAt).toBe(1_000);
    expect(next['tc-1']!.updatedAt).toBe(7_000);
  });

  test('multiple tools coexist · keyed by id', () => {
    let map: Record<string, ToolCallState> = {};
    map = applyToolCallEvent(map, {
      kind: 'call', id: 'tc-1', name: 'read_file', status: 'pending',
    }, 1_000);
    map = applyToolCallEvent(map, {
      kind: 'call', id: 'tc-2', name: 'grep', status: 'pending',
    }, 1_010);
    map = applyToolCallEvent(map, {
      kind: 'update', id: 'tc-1', name: '', status: 'completed', output: 'ok',
    }, 1_020);
    expect(Object.keys(map).sort()).toEqual(['tc-1', 'tc-2']);
    expect(map['tc-1']!.status).toBe('completed');
    expect(map['tc-2']!.status).toBe('pending');
  });
});

// BACKLOG #5 polish (HANDOFF 내부 문서
// §6.5 · 2026-05-09) — display normalization for the ShowroomPanel
// tool list. Captures dogfood findings:
//   - Codex CLI puts the entire bash command in `update.title`
//   - The same command also surfaces as `input.command` (LLM tool arg)
// Result: 300+ char names duplicated next to themselves.
describe('Showroom runtime · formatToolListEntry (BACKLOG #5 polish)', () => {
  test('short name + non-redundant input → both rendered', () => {
    const out = formatToolListEntry({
      name: 'read_file',
      input: { path: 'src/foo.ts' },
    });
    expect(out.name).toBe('read_file');
    expect(out.meta).toBe('path=src/foo.ts');
  });

  test('truncates long names with ellipsis', () => {
    const longName = 'a'.repeat(120);
    const out = formatToolListEntry({ name: longName });
    expect(out.name.length).toBeLessThanOrEqual(56);
    expect(out.name.endsWith('…')).toBe(true);
  });

  test('truncates long meta with ellipsis', () => {
    const longCmd = 'a'.repeat(200);
    const out = formatToolListEntry({
      name: 'bash',
      input: { command: longCmd },
    });
    expect(out.meta).not.toBeNull();
    expect(out.meta!.length).toBeLessThanOrEqual(96);
    expect(out.meta!.endsWith('…')).toBe(true);
  });

  test('suppresses meta when name and input.command are the same string (codex CLI bash case)', () => {
    const cmd = '/bin/zsh -lc "rg -n routeAgent src/acp/multi-llm-bridge.ts"';
    const out = formatToolListEntry({
      name: cmd,
      input: { command: cmd },
    });
    // name truncated to 56 chars, meta suppressed because redundant.
    expect(out.name.endsWith('…')).toBe(true);
    expect(out.meta).toBeNull();
  });

  test('suppresses meta when name starts with the same value (truncated codex CLI case)', () => {
    const cmd = '/bin/zsh -lc "rg -n routeAgent src/acp/multi-llm-bridge.ts && nl -ba src/acp/multi-llm-bridge.ts | head -260"';
    const out = formatToolListEntry({
      name: cmd, // gets clamped to 56 chars
      input: { command: cmd }, // gets clamped to 96 chars (still longer)
    });
    expect(out.name.endsWith('…')).toBe(true);
    // Meta clamps too, but post-clamp values are redundant via the
    // shared prefix → suppress.
    expect(out.meta).toBeNull();
  });

  test('shows meta when name and value diverge meaningfully', () => {
    const out = formatToolListEntry({
      name: 'bash',
      input: { command: '/bin/zsh -lc "echo hi"' },
    });
    expect(out.name).toBe('bash');
    expect(out.meta).toContain('command=');
    expect(out.meta).toContain('echo hi');
  });

  test('falls back to output preview when no input', () => {
    const out = formatToolListEntry({
      name: 'grep',
      output: '12 matches found',
    });
    expect(out.name).toBe('grep');
    expect(out.meta).toBe('12 matches found');
  });

  test('renders (unnamed) when name is empty', () => {
    const out = formatToolListEntry({ name: '' });
    expect(out.name).toBe('(unnamed)');
    expect(out.meta).toBeNull();
  });

  test('handles null/undefined value in input gracefully', () => {
    const out = formatToolListEntry({
      name: 'grep',
      input: { include: null as unknown as string },
    });
    expect(out.meta).toBe('include=null');
  });

  test('handles object value in input via JSON.stringify', () => {
    const out = formatToolListEntry({
      name: 'patch',
      input: { changes: [{ file: 'a.ts', op: 'add' }] },
    });
    expect(out.meta).toContain('changes=');
    expect(out.meta).toContain('file');
  });
});

describe('extractLastAssistantText (DM stage 4)', () => {
  test('returns undefined for null / empty / undefined input', () => {
    expect(extractLastAssistantText(null)).toBeUndefined();
    expect(extractLastAssistantText(undefined)).toBeUndefined();
    expect(extractLastAssistantText([])).toBeUndefined();
  });
  test('returns last assistant message text (most recent first)', () => {
    const messages = [
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'first reply' },
      { role: 'user', text: 'and?' },
      { role: 'assistant', text: 'second reply' },
    ];
    expect(extractLastAssistantText(messages)).toBe('second reply');
  });
  test('skips empty-text assistant placeholders (mid-stream)', () => {
    const messages = [
      { role: 'assistant', text: 'real reply' },
      { role: 'user', text: 'next' },
      { role: 'assistant', text: '' }, // streaming placeholder
    ];
    expect(extractLastAssistantText(messages)).toBe('real reply');
  });
  test('returns undefined when no assistant turn yet (first broadcast)', () => {
    const messages = [{ role: 'user', text: 'hello' }];
    expect(extractLastAssistantText(messages)).toBeUndefined();
  });
  test('handles missing role / text fields defensively', () => {
    const messages = [
      { role: 'assistant' }, // no text
      { text: 'no role' },
      { role: 'assistant', text: 'good one' },
    ];
    expect(extractLastAssistantText(messages)).toBe('good one');
  });
});

describe('buildMultiLlmHint · DM stage 4 lastAssistant forwarding', () => {
  test('lastAssistantByPanelId map → fills target.lastAssistant', () => {
    const panels: ShowroomPanel[] = [
      { id: 'p1', kind: 'chat', provider: 'claude', sessionId: 's1', state: 'live' },
      { id: 'p2', kind: 'chat', provider: 'gemini', sessionId: 's2', state: 'live' },
    ];
    const hint = buildMultiLlmHint(panels, {
      historyMode: 'mixed',
      lastAssistantByPanelId: {
        p1: 'claude said this',
        p2: 'gemini said that',
      },
    });
    expect(hint?.historyMode).toBe('mixed');
    expect(hint?.targets[0]?.lastAssistant).toBe('claude said this');
    expect(hint?.targets[1]?.lastAssistant).toBe('gemini said that');
  });
  test('panel without entry in map → lastAssistant absent', () => {
    const panels: ShowroomPanel[] = [
      { id: 'p1', kind: 'chat', provider: 'claude', sessionId: 's1', state: 'live' },
      { id: 'p2', kind: 'chat', provider: 'gemini', sessionId: 's2', state: 'live' },
    ];
    const hint = buildMultiLlmHint(panels, {
      lastAssistantByPanelId: { p1: 'only one' },
    });
    expect(hint?.targets[0]?.lastAssistant).toBe('only one');
    expect(hint?.targets[1]?.lastAssistant).toBeUndefined();
  });
  test('empty-string lastAssistant → not attached (filtered)', () => {
    const panels: ShowroomPanel[] = [
      { id: 'p1', kind: 'chat', provider: 'claude', sessionId: 's1', state: 'live' },
    ];
    const hint = buildMultiLlmHint(panels, {
      lastAssistantByPanelId: { p1: '' },
    });
    expect(hint?.targets[0]?.lastAssistant).toBeUndefined();
  });
  test('no lastAssistantByPanelId → wire identical to legacy DM-2 path', () => {
    const panels: ShowroomPanel[] = [
      { id: 'p1', kind: 'chat', provider: 'claude', sessionId: 's1', state: 'live' },
    ];
    const hint = buildMultiLlmHint(panels);
    expect(hint?.targets[0]).not.toHaveProperty('lastAssistant');
  });
});

import { afterEach, beforeEach } from 'bun:test';
import { readHistoryModeFromStorage, writeHistoryModeToStorage } from './runtime';

describe('Showroom runtime · historyMode storage (BACKLOG §3.7 · default flip 2026-05-11)', () => {
  const STORAGE_KEY = 'elanous.showroom.historyMode';
  let stubHandle: { restore: () => void };

  beforeEach(() => {
    const store = new Map<string, string>();
    const stub = {
      getItem(key: string): string | null { return store.has(key) ? store.get(key)! : null; },
      setItem(key: string, value: string): void { store.set(key, value); },
      removeItem(key: string): void { store.delete(key); },
      clear(): void { store.clear(); },
      key(i: number): string | null { return Array.from(store.keys())[i] ?? null; },
      get length(): number { return store.size; },
    };
    const prevWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { localStorage: stub } as unknown;
    stubHandle = {
      restore() {
        if (prevWindow === undefined) delete (globalThis as { window?: unknown }).window;
        else (globalThis as { window?: unknown }).window = prevWindow;
      },
    };
  });

  afterEach(() => {
    stubHandle.restore();
  });

  test('default flip — no stored value reads as mixed (post C1 cost-gate)', () => {
    expect(readHistoryModeFromStorage()).toBe('mixed');
  });

  test('legacy mixed users (stored "mixed") still read as mixed', () => {
    (globalThis as { window: { localStorage: Storage } }).window.localStorage.setItem(STORAGE_KEY, 'mixed');
    expect(readHistoryModeFromStorage()).toBe('mixed');
  });

  test('opt-out — stored "isolated" reads as isolated', () => {
    (globalThis as { window: { localStorage: Storage } }).window.localStorage.setItem(STORAGE_KEY, 'isolated');
    expect(readHistoryModeFromStorage()).toBe('isolated');
  });

  test('writeHistoryModeToStorage("isolated") persists opt-out marker', () => {
    writeHistoryModeToStorage('isolated');
    expect(
      (globalThis as { window: { localStorage: Storage } }).window.localStorage.getItem(STORAGE_KEY),
    ).toBe('isolated');
  });

  test('writeHistoryModeToStorage("mixed") removes key (default state)', () => {
    (globalThis as { window: { localStorage: Storage } }).window.localStorage.setItem(STORAGE_KEY, 'isolated');
    writeHistoryModeToStorage('mixed');
    expect(
      (globalThis as { window: { localStorage: Storage } }).window.localStorage.getItem(STORAGE_KEY),
    ).toBeNull();
  });
});
