import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { debug } from './debug/log.js';
import type { Project } from './project/project-store.js';
import type { SessionMeta } from './session/index.js';
import type { TgIncoming } from './telegram.js';
import { defaultTelegramCommands } from './telegram-commands.js';
import { projectCommand, type TelegramProjectCommandDeps } from './telegram-project-command.js';

const project = (id: string, name: string): Project => ({ id, name, createdAt: '2026-10-01T00:00:00Z' });
const research = project('prj_research', 'Research');
const projects = [project('prj_z', 'Zoo'), research, project('prj_r2', 'Research Lab'), project('prj_a', 'Alpha')];
const ctx: TgIncoming = {
  chatId: 42, threadId: 7, botId: 'bot-a', userId: 42, text: '/project', messageId: 1, updateId: 1,
  isDm: true, isGroup: false, attachments: [],
};
const meta = (projectId?: string): SessionMeta => ({
  id: 'current-session', createdAt: '', updatedAt: '', title: '', provider: '', model: '',
  messageCount: 1, source: 'telegram', ...(projectId ? { projectId } : {}),
});

function fixture(initialProjectId?: string, available = projects) {
  const current = meta(initialProjectId);
  const other = meta('prj_z');
  other.id = 'other-session';
  const updates: string[] = [];
  const lookup: Array<[number, number | undefined, string | undefined]> = [];
  const deps: TelegramProjectCommandDeps = {
    list: () => [...available],
    find: (id) => available.find(p => p.id === id) ?? null,
    findSession: (chatId, threadId, botId) => {
      lookup.push([chatId, threadId, botId]);
      return current;
    },
    update: (id, mutate) => {
      updates.push(id);
      if (id !== current.id) throw new Error('wrong session');
      mutate(current);
      return current;
    },
  };
  const run = (args: string[]) => projectCommand(deps).handler(args, ctx, { userConfig: {} as never, allCommands: [] });
  return { current, other, updates, lookup, run };
}

let logSpy: ReturnType<typeof spyOn<typeof debug, 'log'>>;
beforeEach(() => { logSpy = spyOn(debug, 'log').mockImplementation(() => {}); });
afterEach(() => { logSpy.mockRestore(); });

const events = () => logSpy.mock.calls.filter(call => call[0] === 'telegram.project');

describe('/project', () => {
  it('lists the current project, sorted names (at most 20), and the move hint', async () => {
    const f = fixture(research.id, [...projects, ...Array.from({ length: 21 }, (_, i) => project(`prj_extra_${i}`, `Beta ${String(i).padStart(2, '0')}`))]);
    const reply = await f.run([]);
    expect(reply).toContain('지금 대화의 프로젝트: Research');
    const names = String(reply).split('\n').filter(line => line.startsWith('• ')).map(line => line.slice(2));
    expect(names).toHaveLength(20);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(reply).toContain('옮기려면 /project <이름>');
    expect(f.updates).toEqual([]);
    expect(f.lookup).toEqual([[42, 7, 'bot-a']]);
    expect(events().map(call => call[1])).toEqual(['listed']);
    expect(events()[0]?.[2]).toMatchObject({ projects: expect.arrayContaining([{ id: 'prj_a', name: 'Alpha' }]) });
  });

  it('shows the inbox when no project is assigned', async () => {
    const reply = await fixture().run([]);
    expect(reply).toContain('받은 대화(프로젝트 없음)');
  });

  it('chooses a case-insensitive exact match before a matching prefix and updates only this conversation', async () => {
    const f = fixture();
    expect(await f.run(['rEsEaRcH'])).toBe('이 대화를 Research 프로젝트로 옮겼습니다');
    expect(f.updates).toEqual(['current-session']);
    expect(f.current.projectId).toBe(research.id);
    expect(f.other.projectId).toBe('prj_z');
    expect(events().map(call => call[1])).toEqual(['moved']);
    expect(events()[0]?.[2]).toMatchObject({ projects: [{ id: research.id, name: research.name }] });
  });

  it('moves on a unique name prefix', async () => {
    const f = fixture();
    expect(await f.run(['resEarch', 'l'])).toBe('이 대화를 Research Lab 프로젝트로 옮겼습니다');
    expect(f.current.projectId).toBe('prj_r2');
    expect(f.updates).toEqual(['current-session']);
  });

  it('rejects ambiguous prefixes with candidate names and no update', async () => {
    const f = fixture();
    const reply = await f.run(['res']);
    expect(reply).toContain('Research');
    expect(reply).toContain('Research Lab');
    expect(f.updates).toEqual([]);
    expect(events().map(call => call[1])).toEqual(['rejected']);
    expect(events()[0]?.[2]).toMatchObject({ reason: 'ambiguous', projects: expect.arrayContaining([{ id: research.id, name: research.name }]) });
  });

  it('rejects unknown names with the list hint and no update', async () => {
    const f = fixture();
    expect(await f.run(['missing'])).toBe('그 이름의 프로젝트가 없습니다 — /project 로 목록 보기');
    expect(f.updates).toEqual([]);
    expect(events()[0]?.[2]).toMatchObject({ reason: 'not-found' });
  });

  it('clears projectId from only the current conversation', async () => {
    const f = fixture(research.id);
    expect(await f.run(['-'])).toBe('받은 대화로 옮겼습니다');
    expect(f.current).not.toHaveProperty('projectId');
    expect(f.other.projectId).toBe('prj_z');
    expect(f.updates).toEqual(['current-session']);
    expect(events().map(call => call[1])).toEqual(['cleared']);
  });

  it('requires an existing conversation without touching a project or session store', async () => {
    const f = fixture();
    const deps: TelegramProjectCommandDeps = {
      list: () => { throw new Error('should not list'); },
      find: () => { throw new Error('should not find'); },
      update: () => { throw new Error('should not update'); },
      findSession: () => null,
    };
    expect(await projectCommand(deps).handler(['Research'], ctx, { userConfig: {} as never, allCommands: [] }))
      .toBe('아직 이 채팅에 대화가 없습니다 — 한 마디 보낸 뒤 다시');
    expect(f.updates).toEqual([]);
    expect(events()[0]?.[2]).toMatchObject({ reason: 'no-session' });
  });

  it('registers /project immediately after /sessions in the default Telegram commands', () => {
    const commands = defaultTelegramCommands();
    const index = commands.findIndex(command => command.name === 'sessions');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(commands[index + 1]?.name).toBe('project');
    expect(commands[index + 1]?.description).toBe('이 대화의 프로젝트 보기·옮기기');
  });
});
