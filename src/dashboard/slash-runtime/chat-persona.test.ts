import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, loadSession } from '../../session/index.js';
import { CardStore } from '../../task-cards/card-store.js';
import {
  getGlobalPersonaRegistry,
  awaitGlobalPersonaLoad,
  reloadGlobalPersonaRegistry,
  _resetGlobalPersonaRegistryForTest,
} from '../../persona/global-registry.js';
import { handleTuiChatPersona, TuiChatPersonaSelection, tuiChatPersonaMessages, tuiChatPersonaSources } from './chat-persona.js';
import { SLASH_COMMANDS } from '../../chat/index.js';
import { buildDashboardSlashRegistry } from './dashboard-handlers.js';
import type { DashboardSlashContext } from './dashboard-handlers.js';

const root = mkdtempSync(join(tmpdir(), 'tui-persona-test-'));
let previousSessionRoot: string | undefined;
beforeAll(() => {
  previousSessionRoot = process.env.ELANOUS_SESSION_ROOT;
  process.env.ELANOUS_SESSION_ROOT = root;
});
afterAll(() => {
  if (previousSessionRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
  else process.env.ELANOUS_SESSION_ROOT = previousSessionRoot;
  rmSync(root, { recursive: true, force: true });
});

describe('TUI conversation persona', () => {
  test('dashboard slash dispatch lists, selects and removes a conversation persona', async () => {
    await awaitGlobalPersonaLoad();
    const persona = getGlobalPersonaRegistry().list()[0];
    expect(persona).toBeDefined();
    const lines: string[] = [];
    const selection = new TuiChatPersonaSelection();
    const ctx = {
      chatPersona: { sessionId: () => 'slash-test-conversation', selection },
      pushChatLine: (line: string) => { lines.push(line); },
      muted: (line: string) => line,
      warning: (line: string) => line,
      setChatScrollOffset: (_offset: number) => {},
    } as unknown as DashboardSlashContext;
    const registry = buildDashboardSlashRegistry();
    expect(await registry.dispatch('persona', [], ctx)).toEqual({ kind: 'continue' });
    expect(lines.join('\n')).toContain('이 대화의 페르소나: 없음');
    await registry.dispatch('persona', [persona.personaId], ctx);
    expect(selection.get('slash-test-conversation')).toBe(persona.personaId);
    await registry.dispatch('persona', ['-'], ctx);
    expect(selection.get('slash-test-conversation')).toBeUndefined();
  });

  test('shows choices, selects one conversation, passes its prompt to turns, removes without touching another', async () => {
    const command = SLASH_COMMANDS.find(command => command.name === 'persona');
    expect(command?.description).toContain('보기·고르기·빼기');
    expect(command?.subcommands).toContain('-');
    await awaitGlobalPersonaLoad();
    const registry = getGlobalPersonaRegistry();
    const persona = registry.list()[0];
    expect(persona).toBeDefined();
    const selection = new TuiChatPersonaSelection();
    const first = 'tui-persona-ephemeral-1';
    const second = 'tui-persona-ephemeral-2';
    expect(await handleTuiChatPersona([], first, selection)).toContain('이 대화의 페르소나: 없음');
    expect(await handleTuiChatPersona([], first, selection)).toContain(persona.personaId);
    expect(await handleTuiChatPersona([persona.personaId], first, selection)).toContain('골랐습니다');
    expect(selection.get(first)).toBe(persona.personaId);
    expect(selection.get(second)).toBeUndefined();
    expect(await handleTuiChatPersona([], first, selection)).toContain(`이 대화의 페르소나: ${persona.displayName} (${persona.personaId})`);
    expect(await handleTuiChatPersona([], first, selection)).toContain('(지금)');
    expect(tuiChatPersonaMessages(first, selection)).toEqual(persona.systemPrompt?.trim()
      ? [{ role: 'system', content: persona.systemPrompt }] : []);
    expect(tuiChatPersonaMessages(second, selection)).toEqual([]);
    await handleTuiChatPersona([persona.personaId], second, selection);
    expect(await handleTuiChatPersona(['not-a-persona'], first, selection)).toContain('없습니다');
    expect(selection.get(first)).toBe(persona.personaId);
    await handleTuiChatPersona(['-'], first, selection);
    expect(selection.get(first)).toBeUndefined();
    expect(await handleTuiChatPersona([], first, selection)).toContain('이 대화의 페르소나: 없음');
    expect(tuiChatPersonaMessages(first, selection)).toEqual([]);
    expect(selection.get(second)).toBe(persona.personaId);
  });

  test('/session new resets only the ephemeral conversation persona', async () => {
    await awaitGlobalPersonaLoad();
    const persona = getGlobalPersonaRegistry().list()[0]!;
    const selection = new TuiChatPersonaSelection();
    let conversationId = 'conversation-before-new';
    const ctx = {
      chatPersona: { sessionId: () => conversationId, selection, newConversation: () => { conversationId = 'conversation-after-new'; } },
      getAttachedSessionId: () => null,
      setAttachedSessionId: () => {},
      setAttachedChatId: () => {},
      compactSlash: { chatHistory: [{ role: 'system', content: 'base' }] },
      sessionSlash: { remoteDaemon: () => null },
      chatLines: [],
      success: (line: string) => line,
      muted: (line: string) => line,
      setChatScrollOffset: () => {},
    } as unknown as DashboardSlashContext;
    selection.set(conversationId, persona.personaId);
    await buildDashboardSlashRegistry().dispatch('session', ['clear'], ctx);
    expect(selection.get(conversationId)).toBeUndefined();
    expect(selection.get('conversation-before-new')).toBe(persona.personaId);
  });

  test('/wish submissions with the same text produce distinct cards in an isolated store', async () => {
    const wishRoot = mkdtempSync(join(tmpdir(), 'tui-persona-wish-'));
    const store = new CardStore(wishRoot);
    try {
      const lines: string[] = [];
      const ctx = {
        wishCardStore: store,
        pushChatLine: (line: string) => { lines.push(line); },
        success: (line: string) => line,
        error: (line: string) => line,
        setChatScrollOffset: () => {},
      } as unknown as DashboardSlashContext;
      const registry = buildDashboardSlashRegistry();
      await registry.dispatch('wish', ['같은', '소원'], ctx);
      await registry.dispatch('wish', ['같은', '소원'], ctx);
      expect(lines).toEqual(['  소원 카드로 남겼습니다 — 같은 소원', '  소원 카드로 남겼습니다 — 같은 소원']);
      const cards = store.listCards();
      expect(cards).toHaveLength(2);
      expect(new Set(cards.map(card => card.goalId)).size).toBe(2);
      for (const card of cards) {
        expect(card.sections.map(section => section.key)).toEqual(['intake:wish:0', 'intake:reply:0']);
        expect(JSON.parse(card.sections[0]!.content)).toMatchObject({ source: 'tui', text: '같은 소원' });
      }
    } finally {
      store.close();
      rmSync(wishRoot, { recursive: true, force: true });
    }
  });

  test('persists attached conversation choice and removal in session metadata', async () => {
    await awaitGlobalPersonaLoad();
    const persona = getGlobalPersonaRegistry().list()[0];
    expect(persona).toBeDefined();
    const session = createSession({ source: 'tui', personaId: 'resident-identity' });
    const selection = new TuiChatPersonaSelection();
    await handleTuiChatPersona([persona.personaId], session.id, selection);
    expect(loadSession(session.id)?.meta.chatPersonaId).toBe(persona.personaId);
    expect(loadSession(session.id)?.meta.personaId).toBe('resident-identity');
    expect(new TuiChatPersonaSelection().get(session.id)).toBe(persona.personaId);
    await handleTuiChatPersona(['-'], session.id, selection);
    expect(loadSession(session.id)?.meta.chatPersonaId).toBeUndefined();
    expect(loadSession(session.id)?.meta.personaId).toBe('resident-identity');
  });

  test('TUI-SPEECH-STYLE-CHARACTER: 동작 출처 보존이 조각 7/9 범위에서 그대로 구현되었는지 — 원문에', async () => {
    const originalDir = mkdtempSync(join(tmpdir(), 'tui-persona-preserve-origin-'));
    const contaminatedDir = mkdtempSync(join(tmpdir(), 'tui-persona-preserve-contam-'));
    try {
      writeFileSync(join(originalDir, 'probe.yaml'), [
        'personaId: persona-preserve-probe',
        'displayName: 적용 시점 출처 이름',
        'systemPrompt: 적용 시점 시스템 프롬프트',
        '',
      ].join('\n'));
      await reloadGlobalPersonaRegistry(originalDir);
      const selection = new TuiChatPersonaSelection();
      const sessionId = 'tui-persona-source-preservation-probe';
      expect(tuiChatPersonaSources(sessionId, selection)).toBeUndefined();
      await handleTuiChatPersona(['persona-preserve-probe'], sessionId, selection);
      const applied = tuiChatPersonaSources(sessionId, selection);
      expect(applied?.personaId).toBe('persona-preserve-probe');
      expect(applied?.displayName).toBe('적용 시점 출처 이름');
      expect(tuiChatPersonaMessages(sessionId, selection))
        .toEqual([{ role: 'system', content: '적용 시점 시스템 프롬프트' }]);
      // 적용 후 registry 교체·오염 — 같은 id, 다른 displayName·systemPrompt
      writeFileSync(join(contaminatedDir, 'probe.yaml'), [
        'personaId: persona-preserve-probe',
        'displayName: 오염된 출처 이름',
        'systemPrompt: 오염된 시스템 프롬프트',
        '',
      ].join('\n'));
      await reloadGlobalPersonaRegistry(contaminatedDir);
      const contaminated = getGlobalPersonaRegistry().get('persona-preserve-probe');
      expect(contaminated?.displayName).toBe('오염된 출처 이름');
      expect(contaminated?.systemPrompt).not.toBe('적용 시점 시스템 프롬프트');
      // 보존 관측: 조회는 적용 시점 스냅샷을 반환한다 — registry 현재값이 아니다
      const preserved = tuiChatPersonaSources(sessionId, selection);
      expect(preserved?.personaId).toBe('persona-preserve-probe');
      expect(preserved?.displayName).toBe('적용 시점 출처 이름');
      const preservedSource = preserved?.sources.find(source => source.kind === 'persona');
      expect(preservedSource?.id).toBe('persona-preserve-probe');
      expect(preservedSource?.length).toBe('적용 시점 시스템 프롬프트'.length);
      expect(preservedSource?.preview).toContain('적용 시점');
      expect(tuiChatPersonaMessages(sessionId, selection))
        .toEqual([{ role: 'system', content: '적용 시점 시스템 프롬프트' }]);
      await handleTuiChatPersona(['-'], sessionId, selection);
      expect(tuiChatPersonaSources(sessionId, selection)).toBeUndefined();
      expect(tuiChatPersonaMessages(sessionId, selection)).toEqual([]);
    } finally {
      _resetGlobalPersonaRegistryForTest();
      await awaitGlobalPersonaLoad();
      rmSync(originalDir, { recursive: true, force: true });
      rmSync(contaminatedDir, { recursive: true, force: true });
    }
  });
});
